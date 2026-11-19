import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page, Request } from "playwright";

/**
 * The inspect screen's recording of one page: what a developer would open the browser's developer
 * tools for. It is saved next to the screenshots as page-N-inspect.json, with the page's HTML
 * (page-N-dom.txt) and a HAR file (page-N-network.har) that opens in Chrome or any HAR viewer.
 *
 * Secrets never go in: cookies, Authorization and other login headers are replaced with "(hidden)".
 */
export interface InspectStep {
  /** Milliseconds since the page started opening. */
  at: number;
  label: string;
  ms?: number;
  /** Findings the step raised, or what went wrong. */
  detail?: string;
  ok?: boolean;
}

export interface InspectRequest {
  url: string;
  method: string;
  /** 0 when no answer came. */
  status: number;
  type: string;
  /** Milliseconds since the page started opening. */
  start: number;
  end: number;
  bytes: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Where the time went, in milliseconds (-1: not known). */
  timing?: { dns: number; connect: number; ssl: number; wait: number; receive: number };
  failed?: string;
  mimeType?: string;
  httpVersion?: string;
}

export interface InspectConsole {
  at: number;
  type: string;
  text: string;
  source?: string;
}

/** A box drawn over the desktop screenshot, in its pixels. */
export interface InspectBox {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

export interface InspectCoverage {
  url: string;
  type: "js" | "css";
  totalBytes: number;
  unusedBytes: number;
}

export interface InspectData {
  url: string;
  startedAt: string;
  steps: InspectStep[];
  network: InspectRequest[];
  console: InspectConsole[];
  /** Keyboard order: the first box is reached by the first Tab press. */
  tabOrder: (InspectBox & { n: number })[];
  /** Headings (h1-h6) and landmarks (header, nav, main...) as drawn. */
  outline: (InspectBox & { kind: "heading" | "landmark"; level?: number })[];
  coverage?: InspectCoverage[];
  /** Size of the desktop screenshot the boxes belong to. */
  viewport: { width: number; height: number };
}

const SECRET_HEADERS = /^(cookie|set-cookie|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;

export function hideSecrets(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_HEADERS.test(k) ? "(hidden)" : String(v).slice(0, 2000);
  return out;
}

const MAX_REQUESTS = 1500;
const MAX_CONSOLE = 400;

export class Inspector {
  private t0 = Date.now();
  readonly data: InspectData;
  private pending = new Map<Request, InspectRequest>();
  private jobs: Promise<unknown>[] = [];
  private coverageOn = false;

  constructor(
    private page: Page,
    url: string,
    viewport: { width: number; height: number },
  ) {
    this.data = { url, startedAt: new Date().toISOString(), steps: [], network: [], console: [], tabOrder: [], outline: [], viewport };
    page.on("request", (req) => {
      if (this.data.network.length + this.pending.size >= MAX_REQUESTS) return;
      const entry: InspectRequest = {
        url: req.url().slice(0, 2000),
        method: req.method(),
        status: 0,
        type: req.resourceType(),
        start: this.now(),
        end: this.now(),
        bytes: 0,
        requestHeaders: hideSecrets(req.headers()),
        responseHeaders: {},
      };
      this.pending.set(req, entry);
      // All headers, cookies included (then hidden), as the browser really sent them.
      this.jobs.push(
        req
          .allHeaders()
          .then((h) => (entry.requestHeaders = hideSecrets(h)))
          .catch(() => {}),
      );
    });
    page.on("requestfinished", (req) => this.jobs.push(this.finish(req)));
    page.on("requestfailed", (req) => this.jobs.push(this.finish(req, req.failure()?.errorText ?? "failed")));
    page.on("console", (msg) => {
      if (this.data.console.length >= MAX_CONSOLE) return;
      this.data.console.push({ at: this.now(), type: msg.type(), text: msg.text().slice(0, 1000), source: msg.location().url || undefined });
    });
    page.on("pageerror", (err) => {
      if (this.data.console.length >= MAX_CONSOLE) return;
      this.data.console.push({ at: this.now(), type: "exception", text: (err.stack ?? err.message).slice(0, 2000) });
    });
  }

  now(): number {
    return Date.now() - this.t0;
  }

  step(label: string, extra: Partial<InspectStep> = {}): void {
    if (this.data.steps.length < 300) this.data.steps.push({ at: this.now(), label, ...extra });
  }

  /** Times a step: its start is when it began, ms how long it took. */
  async timed<T>(label: string, task: () => Promise<T>, describe?: (r: T) => string | undefined): Promise<T> {
    const at = this.now();
    try {
      const r = await task();
      this.step(label, { at, ms: this.now() - at, ok: true, detail: describe?.(r) });
      return r;
    } catch (err) {
      this.step(label, { at, ms: this.now() - at, ok: false, detail: (err as Error).message.split("\n")[0] });
      throw err;
    }
  }

  private async finish(req: Request, failed?: string): Promise<void> {
    const entry = this.pending.get(req);
    if (!entry) return;
    this.pending.delete(req);
    entry.end = this.now();
    if (failed) entry.failed = failed;
    const res = await req.response().catch(() => null);
    if (res) {
      entry.status = res.status();
      entry.responseHeaders = hideSecrets(await res.allHeaders().catch(() => res.headers()));
      entry.mimeType = res.headers()["content-type"]?.split(";")[0];
      const sizes = await req.sizes().catch(() => null);
      entry.bytes = sizes?.responseBodySize ?? Number(res.headers()["content-length"] ?? 0);
    }
    const t = req.timing();
    if (t && t.startTime > 0) {
      const span = (a: number, b: number) => (a >= 0 && b >= a ? Math.round(b - a) : -1);
      entry.timing = {
        dns: span(t.domainLookupStart, t.domainLookupEnd),
        connect: span(t.connectStart, t.connectEnd),
        ssl: span(t.secureConnectionStart, t.connectEnd),
        wait: span(t.requestStart, t.responseStart),
        receive: span(t.responseStart, t.responseEnd),
      };
      // The browser's own clock is more exact than the event's arrival.
      const start = t.startTime - this.t0;
      if (start >= 0 && start <= entry.end) entry.start = Math.round(start);
      if (t.responseEnd > 0) entry.end = Math.max(entry.start, Math.round(start + t.responseEnd));
    }
    if (this.data.network.length < MAX_REQUESTS) this.data.network.push(entry);
  }

  /** Unused JavaScript and CSS needs Chromium; other browsers simply have no coverage tab. */
  async startCoverage(): Promise<void> {
    try {
      await this.page.coverage.startJSCoverage({ resetOnNavigation: false });
      await this.page.coverage.startCSSCoverage({ resetOnNavigation: false });
      this.coverageOn = true;
    } catch {
      this.coverageOn = false;
    }
  }

  async stopCoverage(): Promise<void> {
    if (!this.coverageOn) return;
    this.coverageOn = false;
    try {
      const [js, css] = await Promise.all([this.page.coverage.stopJSCoverage(), this.page.coverage.stopCSSCoverage()]);
      this.data.coverage = [...jsCoverage(js), ...cssCoverage(css)].sort((a, b) => b.unusedBytes - a.unusedBytes).slice(0, 100);
    } catch {
      // The page closed or navigated away: no coverage, nothing else lost.
    }
  }

  /** Reads the tab order, headings and landmarks as drawn at the top of the page. */
  async readLayout(): Promise<void> {
    try {
      const r = (await this.page.evaluate(LAYOUT_JS)) as Pick<InspectData, "tabOrder" | "outline">;
      this.data.tabOrder = r.tabOrder;
      this.data.outline = r.outline;
    } catch {
      // A page that blocks scripts still has the rest of its recording.
    }
  }

  /** Writes the recording, the page's HTML and the HAR. Returns the inspect file's name. */
  async save(dir: string, index: number): Promise<{ file: string; dom?: string; har: string }> {
    await Promise.race([Promise.allSettled(this.jobs), new Promise((r) => setTimeout(r, 2000))]);
    // Requests still open when the page closed: shown as not finished.
    for (const entry of this.pending.values()) {
      entry.failed ??= "not finished when the test moved on";
      entry.end = this.now();
      this.data.network.push(entry);
    }
    this.pending.clear();
    this.data.network.sort((a, b) => a.start - b.start || a.url.localeCompare(b.url));
    const inspect = `page-${index}-inspect.json`;
    const har = `page-${index}-network.har`;
    let dom: string | undefined = `page-${index}-dom.txt`;
    try {
      const html = await this.page.content();
      await writeFile(path.join(dir, dom), html.slice(0, 3_000_000));
    } catch {
      dom = undefined;
    }
    await writeFile(path.join(dir, inspect), JSON.stringify(this.data));
    await writeFile(path.join(dir, har), JSON.stringify(toHar(this.data), null, 1));
    return { file: inspect, dom, har };
  }
}

interface JsEntry {
  url: string;
  source?: string;
  functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[];
}
interface CssEntry {
  url: string;
  text?: string;
  ranges: { start: number; end: number }[];
}

/** V8 lists a function's whole range before the blocks inside it, so painting in order is exact. */
export function jsCoverage(entries: JsEntry[]): InspectCoverage[] {
  const byUrl = new Map<string, InspectCoverage>();
  for (const e of entries) {
    if (!e.url || !e.source || !/^https?:/.test(e.url)) continue;
    const len = Math.min(e.source.length, 8_000_000);
    const used = new Uint8Array(len);
    for (const f of e.functions) {
      for (const r of f.ranges) used.fill(r.count > 0 ? 1 : 0, Math.max(0, r.startOffset), Math.min(len, r.endOffset));
    }
    let unused = 0;
    for (let i = 0; i < len; i++) if (!used[i]) unused++;
    const prev = byUrl.get(e.url);
    if (prev) {
      // The same file run twice (two script tags): count it once, with the smaller unused share.
      prev.unusedBytes = Math.min(prev.unusedBytes, unused);
    } else byUrl.set(e.url, { url: e.url, type: "js", totalBytes: len, unusedBytes: unused });
  }
  return [...byUrl.values()];
}

export function cssCoverage(entries: CssEntry[]): InspectCoverage[] {
  const out: InspectCoverage[] = [];
  for (const e of entries) {
    if (!e.url || !e.text || !/^https?:/.test(e.url)) continue;
    const usedBytes = e.ranges.reduce((n, r) => n + Math.max(0, r.end - r.start), 0);
    out.push({ url: e.url, type: "css", totalBytes: e.text.length, unusedBytes: Math.max(0, e.text.length - usedBytes) });
  }
  return out;
}

/** HAR 1.2, without bodies, so Chrome, Firefox and HAR viewers can open the page's network log. */
export function toHar(d: InspectData): unknown {
  const t0 = new Date(d.startedAt).getTime();
  const list = (h: Record<string, string>) => Object.entries(h).map(([name, value]) => ({ name, value }));
  return {
    log: {
      version: "1.2",
      creator: { name: "GLV Testing Agent", version: "0.2" },
      pages: [{ startedDateTime: d.startedAt, id: "page_1", title: d.url, pageTimings: {} }],
      entries: d.network.map((r) => {
        const t = r.timing;
        const time = Math.max(0, r.end - r.start);
        let query: { name: string; value: string }[] = [];
        try {
          query = [...new URL(r.url).searchParams].map(([name, value]) => ({ name, value }));
        } catch {
          query = [];
        }
        return {
          pageref: "page_1",
          startedDateTime: new Date(t0 + r.start).toISOString(),
          time,
          request: { method: r.method, url: r.url, httpVersion: "HTTP/1.1", headers: list(r.requestHeaders), queryString: query, cookies: [], headersSize: -1, bodySize: -1 },
          response: {
            status: r.status,
            statusText: r.failed ?? "",
            httpVersion: "HTTP/1.1",
            headers: list(r.responseHeaders),
            cookies: [],
            content: { size: r.bytes, mimeType: r.mimeType ?? "" },
            redirectURL: r.responseHeaders.location ?? "",
            headersSize: -1,
            bodySize: r.bytes,
          },
          cache: {},
          timings: {
            blocked: -1,
            dns: t?.dns ?? -1,
            connect: t?.connect ?? -1,
            ssl: t?.ssl ?? -1,
            send: 0,
            wait: t && t.wait >= 0 ? t.wait : time,
            receive: t && t.receive >= 0 ? t.receive : 0,
          },
          _resourceType: r.type,
          ...(r.failed ? { _error: r.failed } : {}),
        };
      }),
    },
  };
}

/** Runs in the page: what the keyboard reaches, in order, and the page's outline, as boxes. */
const LAYOUT_JS = `(function () {
  var sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable=true], audio[controls], video[controls]';
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    var s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return null;
    return r;
  }
  function name(el) {
    var t = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim();
    return el.tagName.toLowerCase() + (t ? ' "' + t.slice(0, 40) + '"' : "");
  }
  function box(r) {
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }
  var items = [];
  document.querySelectorAll(sel).forEach(function (el, i) {
    if (el.disabled || el.closest("[inert]")) return;
    var ti = el.tabIndex;
    if (ti < 0) return;
    var r = visible(el);
    if (!r) return;
    items.push({ el: el, ti: ti, i: i, r: r });
  });
  // Positive tabindex first (lowest first), then the rest in page order: the browser's own order.
  items.sort(function (a, b) {
    var pa = a.ti > 0 ? a.ti : Infinity, pb = b.ti > 0 ? b.ti : Infinity;
    return pa === pb ? a.i - b.i : pa - pb;
  });
  var tabOrder = items.slice(0, 300).map(function (it, n) {
    var b = box(it.r); b.n = n + 1; b.label = name(it.el); return b;
  });
  var outline = [];
  document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]").forEach(function (el) {
    var r = visible(el); if (!r || outline.length >= 200) return;
    var b = box(r); b.kind = "heading";
    b.level = Number(el.getAttribute("aria-level") || el.tagName.slice(1)) || 2;
    b.label = "H" + b.level + " " + (el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 60);
    outline.push(b);
  });
  var marks = { HEADER: "banner", NAV: "navigation", MAIN: "main", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", SECTION: "region" };
  document.querySelectorAll("header, nav, main, footer, aside, [role=banner], [role=navigation], [role=main], [role=contentinfo], [role=complementary], [role=search], [role=region]").forEach(function (el) {
    var r = visible(el); if (!r || outline.length >= 300) return;
    var role = el.getAttribute("role") || marks[el.tagName];
    if (!role) return;
    // header and footer inside an article are not page landmarks.
    if ((el.tagName === "HEADER" || el.tagName === "FOOTER") && el.closest("article, aside, main, nav, section")) return;
    var b = box(r); b.kind = "landmark";
    var label = el.getAttribute("aria-label");
    b.label = role + (label ? ' "' + label.slice(0, 40) + '"' : "");
    outline.push(b);
  });
  return { tabOrder: tabOrder, outline: outline };
})()`;
