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
  view?: "desktop" | "phone";
  /** What the screen is doing, in a few words: "Opening the page", "Checking", "Waiting for a page". */
  doing?: string;
  /** Names of the agents checking the page right now. */
  agents?: string[];
  state: "busy" | "idle" | "done";
}

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
}

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

  /** A line of the test's progress log. */
  log(line: string): void {
    this.broadcast("log", { line });
  }

  /**
   * Adds a viewer: it gets the current screens and pictures at once, then every change.
   * `close` is called when the test ends. Returns a function that removes the viewer.
   */
  subscribe(send: LiveSend, close: () => void): () => void {
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
  }

  private unsubscribe(send: LiveSend): void {
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
