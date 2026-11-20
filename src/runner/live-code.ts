import type { Page, Request } from "playwright";
import { fixFor } from "../fixes.js";
import type { LiveCode, LiveSink } from "../live.js";
import type { Finding } from "../types.js";

/**
 * Feeds the code panel beside one live screen: every request the page makes, everything it prints
 * in the console, each step of the test written as Playwright code, and each finding with its fix.
 * Nothing here slows the test: lines are kept in memory for a moment and sent only to viewers who
 * opened the code panel.
 *
 * Secrets stay out: no headers or cookies are sent, passwords and tokens in addresses are hidden,
 * and the page's HTML is read with password, hidden-field and CSRF values blanked.
 */

type Spread<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Line = Spread<LiveCode, "slot" | "at">;

/** Address parts that often carry a secret: their values are replaced with "(hidden)". */
const SECRET_PARAM = /^(password|passwd|pass|pwd|token|access_token|refresh_token|id_token|auth|key|api_key|apikey|secret|session|sessionid|sid|code|signature|sig|otp)$/i;

export function hideUrlSecrets(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "hidden";
    let hidden = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_PARAM.test(k)) {
        u.searchParams.set(k, "(hidden)");
        hidden = true;
      }
    }
    // An address left as it was keeps its own spelling (no re-encoding).
    return hidden || u.password ? u.toString() : url;
  } catch {
    return url;
  }
}

/** Reads the page's HTML as it is now (after scripts ran), with secret values blanked. At most 2 MB. */
export const SOURCE_JS = `(function () {
  var doc = document.documentElement.cloneNode(true);
  doc.querySelectorAll('input[type=password], input[type=hidden]').forEach(function (el) { if (el.hasAttribute('value')) el.setAttribute('value', '(hidden)'); });
  doc.querySelectorAll('meta[name*=csrf i], meta[name*=xsrf i], meta[name*=token i]').forEach(function (el) { if (el.hasAttribute('content')) el.setAttribute('content', '(hidden)'); });
  var dt = document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>\\n' : '';
  var html = dt + doc.outerHTML;
  return html.length > 2000000 ? html.slice(0, 2000000) + '\\n<!-- GLV: cut at 2 MB -->' : html;
})()`;

/** The code lines a step of the test stands for, so the steps read as a script that can be run again. */
export const stepCode = {
  open: (url: string) => `await page.goto(${JSON.stringify(hideUrlSecrets(url))}, { waitUntil: "load" });`,
  wait: () => `await page.waitForLoadState("networkidle");`,
  picture: (file: string) => `await page.screenshot({ path: ${JSON.stringify(file)}, animations: "disabled" });`,
  resize: (w: number, h: number) => `await page.setViewportSize({ width: ${w}, height: ${h} });`,
  agent: (id: string, name: string) => `// GLV check: ${name} (${id})`,
};

export interface CodeFeed {
  step(label: string, more?: { code?: string; ms?: number; ok?: boolean; detail?: string }): void;
  found(list: Finding[]): void;
  stop(): void;
}

const NONE: CodeFeed = { step() {}, found() {}, stop() {} };

export function feedCode(page: Page, slot: number, live: LiveSink | undefined, url: string): CodeFeed {
  if (!live?.code) return NONE;
  const code = live.code.bind(live);
  const t0 = Date.now();
  const send = (line: Line) => code({ slot, at: Date.now() - t0, ...line } as LiveCode);
  send({ kind: "page", url: hideUrlSecrets(url) });

  const started = new WeakMap<Request, number>();
  const onRequest = (req: Request) => started.set(req, Date.now());
  const net = (req: Request, status: number, failed?: string, bytes?: number) => {
    const from = started.get(req);
    send({
      kind: "net",
      method: req.method(),
      url: hideUrlSecrets(req.url()).slice(0, 2000),
      status,
      type: req.resourceType(),
      ms: from ? Date.now() - from : undefined,
      bytes,
      failed,
    });
  };
  const onFinished = (req: Request) => {
    void (async () => {
      const res = await req.response().catch(() => null);
      const sizes = await req.sizes().catch(() => null);
      net(req, res?.status() ?? 0, undefined, sizes?.responseBodySize);
    })();
  };
  const onFailed = (req: Request) => net(req, 0, req.failure()?.errorText ?? "failed");
  const onConsole = (msg: import("playwright").ConsoleMessage) => {
    const loc = msg.location();
    send({ kind: "console", level: msg.type(), text: msg.text().slice(0, 2000), source: loc.url ? `${hideUrlSecrets(loc.url)}:${loc.lineNumber + 1}` : undefined });
  };
  const onError = (err: Error) => send({ kind: "console", level: "error", text: `Uncaught ${err.message}`.slice(0, 2000), source: err.stack?.split("\n")[1]?.trim() });

  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  live.pageSource?.(slot, async () => String(await page.evaluate(SOURCE_JS)));

  return {
    step: (label, more = {}) => send({ kind: "step", label, ...more }),
    found(list) {
      for (const f of list) {
        const fix = fixFor(f);
        send({
          kind: "found",
          rule: f.rule,
          severity: f.severity,
          title: f.title,
          detail: f.detail.slice(0, 2000),
          evidence: f.evidence?.slice(0, 4000),
          agent: f.agent,
          fix: { steps: fix.steps, code: fix.code, effort: fix.effort },
        });
      }
    },
    stop() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
      page.off("console", onConsole);
      page.off("pageerror", onError);
      live.pageSource?.(slot, undefined);
    },
  };
}
