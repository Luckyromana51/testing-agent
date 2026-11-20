import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Live view of a running test: what each browser screen shows and what its agents are doing,
 * sent to the dashboard as it happens. Nothing is recorded: when nobody watches, the browser
 * sends no pictures at all, so a test runs at full speed.
 */

/** One browser screen of a running test (one page being tested). */
export interface LiveScreen {
  /** 0-based screen number; the dashboard shows "Screen 1". */
  slot: number;
  url?: string;
  /** "desktop" while the page is checked at 1366 px, "phone" at 390 px. */
  view?: "desktop" | "tablet" | "phone";
  /** What the screen is doing, in a few words: "Opening the page", "Checking", "Waiting for a page". */
  doing?: string;
  /** Names of the agents checking the page right now. */
  agents?: string[];
  state: "busy" | "idle" | "done";
}

/**
 * One line of the code panel beside a screen: what the page loads, what it prints, what the test
 * does to it (as Playwright code) and what the checks found, with their fix. "page" starts a new page
 * on the screen and clears the older lines. `at` is milliseconds since that page started opening.
 */
export type LiveCode = { slot: number; at: number } & (
  | { kind: "page"; url: string }
  | { kind: "step"; label: string; code?: string; ms?: number; ok?: boolean; detail?: string }
  | { kind: "net"; method: string; url: string; status: number; type: string; ms?: number; bytes?: number; failed?: string }
  | { kind: "console"; level: string; text: string; source?: string }
  /** An API call of a test without screens (API, GraphQL), as a cURL command with logins masked. */
  | { kind: "call"; method: string; url: string; curl: string; status: number; ms: number; failed?: string }
  | {
      kind: "found";
      rule: string;
      severity: string;
      title: string;
      detail: string;
      evidence?: string;
      agent?: string;
      fix?: { steps: string; code?: { label: string; snippet: string }[]; effort: string };
    }
);

/** Lines kept per screen for a viewer who opens the code panel in the middle of a page. */
export const CODE_KEEP = 600;

/** What a test engine reports while it runs. Every call is cheap when nobody is watching. */
export interface LiveSink {
  /** True while at least one person watches this test live. */
  watching(): boolean;
  /** Called with true when the first viewer arrives and false when the last one leaves. Returns a function that unsubscribes. */
  onWatchers(cb: (watching: boolean) => void): () => void;
  /** How many screens the test uses (the number of pages tested at the same time). */
  setScreens(count: number): void;
  screen(info: LiveScreen): void;
  /** A JPEG picture of a screen, base64-encoded, as the browser sends it. */
  frame(slot: number, jpegBase64: string, width: number, height: number): void;
  /** A line of the code panel. Kept for a moment (the newest lines per screen) and sent only to viewers with the code panel open. */
  code?(item: LiveCode): void;
  /** How to read the HTML a screen shows right now, or undefined when its page closes. Only asked when a viewer clicks for it. */
  pageSource?(slot: number, read: (() => Promise<string>) | undefined): void;
}

/**
 * The live sink of the test running in this async call chain. Engines without screens (API, code)
 * use it to send their calls and problems to the code panel without passing it down every call.
 * Their lines all go on screen 0.
 */
const current = new AsyncLocalStorage<LiveSink>();
export const liveFeed = {
  run<T>(sink: LiveSink, fn: () => Promise<T>): Promise<T> {
    return current.run(sink, fn);
  },
  get(): LiveSink | undefined {
    return current.getStore();
  },
};

/** Sends one server-sent event to one viewer. A viewer on a slow connection may skip pictures. */
export type LiveSend = (event: string, data: unknown) => void;

/** Pictures go out at most this often per screen; anything newer replaces what has not been sent. */
const FLUSH_MS = 200;

export class LiveRun implements LiveSink {
  private viewers = new Map<LiveSend, () => void>();
  private watchers = new Set<(watching: boolean) => void>();
  private screens = new Map<number, LiveScreen>();
  private frames = new Map<number, { img: string; w: number; h: number }>();
  private dirtyFrames = new Set<number>();
  private dirtyScreens = new Set<number>();
  private count = 0;
  /** Viewers with the code panel open. */
  private coders = new Set<LiveSend>();
  private codeLines = new Map<number, LiveCode[]>();
  private codeOut: LiveCode[] = [];
  private sources = new Map<number, () => Promise<string>>();
  private timer?: NodeJS.Timeout;
  private ended?: string;

  watching(): boolean {
    return this.viewers.size > 0;
  }

  onWatchers(cb: (watching: boolean) => void): () => void {
    this.watchers.add(cb);
    return () => this.watchers.delete(cb);
  }

  setScreens(count: number): void {
    this.count = count;
    this.broadcast("screens", { count });
  }

  screen(info: LiveScreen): void {
    const prev = this.screens.get(info.slot);
    this.screens.set(info.slot, { ...prev, ...info });
    if (this.watching()) this.dirtyScreens.add(info.slot);
  }

  frame(slot: number, img: string, w: number, h: number): void {
    if (!this.watching()) return;
    this.frames.set(slot, { img, w, h });
    this.dirtyFrames.add(slot);
  }

  /** True while at least one viewer has the code panel open. */
  coding(): boolean {
    return this.coders.size > 0;
  }

  code(item: LiveCode): void {
    if (this.ended) return;
    let lines = this.codeLines.get(item.slot);
    if (!lines || item.kind === "page") {
      lines = [];
      this.codeLines.set(item.slot, lines);
    }
    lines.push(item);
    // The page line stays first, so a late viewer still sees which page the lines are about.
    if (lines.length > CODE_KEEP) lines.splice(lines[0].kind === "page" ? 1 : 0, 1);
    if (this.coders.size) this.codeOut.push(item);
  }

  pageSource(slot: number, read: (() => Promise<string>) | undefined): void {
    if (read) this.sources.set(slot, read);
    else this.sources.delete(slot);
  }

  /** The HTML a screen shows right now, or undefined when the screen has no page open. */
  async source(slot: number): Promise<string | undefined> {
    const read = this.sources.get(slot);
    if (!read) return undefined;
    try {
      return await read();
    } catch {
      return undefined; // the page closed while it was read
    }
  }

  /** A line of the test's progress log. */
  log(line: string): void {
    this.broadcast("log", { line });
  }

  /**
   * Adds a viewer: it gets the current screens and pictures at once, then every change.
   * `close` is called when the test ends. Returns a function that removes the viewer.
   */
  subscribe(send: LiveSend, close: () => void, opts: { code?: boolean } = {}): () => void {
    if (this.ended) {
      send("end", { status: this.ended });
      close();
      return () => {};
    }
    const first = this.viewers.size === 0;
    this.viewers.set(send, close);
    // Before the browser starts, the number of screens is not known yet: it comes when it is.
    if (this.count) send("screens", { count: this.count });
    for (const s of this.screens.values()) send("screen", s);
    for (const [slot, f] of this.frames) send("frame", { slot, ...f });
    if (opts.code) {
      this.coders.add(send);
      const items = [...this.codeLines.values()].flat();
      if (items.length) send("code", { items });
    }
    if (first) {
      this.timer = setInterval(() => this.flush(), FLUSH_MS);
      this.timer.unref();
      for (const cb of this.watchers) cb(true);
    }
    return () => this.unsubscribe(send);
  }

  /** The test finished: tell every viewer and let them go. */
  end(status: string): void {
    if (this.ended) return;
    this.flush();
    this.ended = status;
    for (const [send, close] of [...this.viewers]) {
      send("end", { status });
      close();
      this.unsubscribe(send);
    }
    this.frames.clear();
    this.codeLines.clear();
    this.sources.clear();
  }

  private unsubscribe(send: LiveSend): void {
    this.coders.delete(send);
    if (!this.coders.size) this.codeOut = [];
    if (!this.viewers.delete(send) || this.viewers.size) return;
    clearInterval(this.timer);
    this.timer = undefined;
    // Nobody watches: the browser stops sending pictures, and old ones are dropped.
    this.frames.clear();
    this.dirtyFrames.clear();
    for (const cb of this.watchers) cb(false);
  }

  private broadcast(event: string, data: unknown): void {
    for (const send of this.viewers.keys()) send(event, data);
  }

  private flush(): void {
    for (const slot of this.dirtyScreens) this.broadcast("screen", this.screens.get(slot));
    this.dirtyScreens.clear();
    for (const slot of this.dirtyFrames) {
      const f = this.frames.get(slot);
      if (f) for (const send of this.viewers.keys()) send("frame", { slot, ...f });
    }
    this.dirtyFrames.clear();
    if (this.codeOut.length) {
      // Many lines come at once while a page loads: they go out together, at most every 200 ms.
      const items = this.codeOut;
      this.codeOut = [];
      for (const send of this.coders) send("code", { items });
    }
  }
}

/** The live view of every running test, by run id. */
export class LiveHub {
  private runs = new Map<string, LiveRun>();
  /** Finished runs stay for a moment, so a viewer that connects just after the end is told so. */
  private finished = new Map<string, string>();
  private changed = new Set<() => void>();

  open(runId: string): LiveRun {
    const run = new LiveRun();
    this.runs.set(runId, run);
    for (const cb of this.changed) cb();
    return run;
  }

  /** The ids of the tests that are running now. */
  ids(): string[] {
    return [...this.runs.keys()];
  }

  /** Called when a test starts or ends, for the page that shows every running test. Returns a function that unsubscribes. */
  onChange(cb: () => void): () => void {
    this.changed.add(cb);
    return () => this.changed.delete(cb);
  }

  get(runId: string): LiveRun | undefined {
    return this.runs.get(runId);
  }

  endedAs(runId: string): string | undefined {
    return this.finished.get(runId);
  }

  close(runId: string, status: string): void {
    this.runs.get(runId)?.end(status);
    this.runs.delete(runId);
    this.finished.set(runId, status);
    if (this.finished.size > 200) this.finished.delete(this.finished.keys().next().value!);
    for (const cb of this.changed) cb();
  }
}
