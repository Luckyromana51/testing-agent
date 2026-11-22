import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WEB_PRODUCTS } from "../products.js";
import type { Tool, ToolContext, ToolFinding, ToolImage, ToolOutput } from "./types.js";

/**
 * Older browser versions: the client's customers are not all on today's Chrome. GLV's own Selenium
 * Grid (docker compose --profile grid) runs pinned old versions of Chrome, Firefox ESR and Edge; this
 * tool opens the site's pages in each and reports script errors, blank pages and modern CSS the old
 * version cannot draw. The W3C WebDriver protocol is spoken directly (no extra package).
 */

export const MATRIX: { id: string; label: string; browserName: string; browserVersion: string; why: string }[] = [
  { id: "chrome-109", label: "Chrome 109 (last for Windows 7 and 8)", browserName: "chrome", browserVersion: "109.0", why: "the last Chrome for Windows 7 and 8.1, still on many office PCs in India" },
  { id: "chrome-120", label: "Chrome 120 (two years old)", browserName: "chrome", browserVersion: "120.0", why: "a two-year-old Chrome, as on phones and PCs that do not update" },
  { id: "firefox-115", label: "Firefox 115 ESR", browserName: "firefox", browserVersion: "115.0", why: "the long-term Firefox used by companies and the last for Windows 7" },
  { id: "edge-120", label: "Edge 120", browserName: "MicrosoftEdge", browserVersion: "120.0", why: "an older Edge, as on company laptops with slow updates" },
];

/** CSS features that old browsers cannot read, with the first versions that can. */
export const CSS_FEATURES: { name: string; test: RegExp; supports: string; since: string }[] = [
  { name: ":has() selector", test: /:has\(/, supports: "selector(:has(a))", since: "Chrome 105, Firefox 121" },
  { name: "container queries", test: /@container\b/, supports: "container-type: inline-size", since: "Chrome 105, Firefox 110" },
  { name: "CSS nesting", test: /\{[^{}]*&\s*[.:#[a-z]/i, supports: "selector(&)", since: "Chrome 120, Firefox 117" },
  { name: "cascade layers (@layer)", test: /@layer\b/, supports: "display: block", since: "Chrome 99, Firefox 97" },
  { name: "subgrid", test: /grid-template-(columns|rows)\s*:\s*subgrid/, supports: "grid-template-columns: subgrid", since: "Chrome 117, Firefox 71" },
  { name: "dvh/svh viewport units", test: /\d(dvh|svh|lvh)\b/, supports: "height: 100dvh", since: "Chrome 108, Firefox 101" },
  { name: "color-mix()", test: /color-mix\(/, supports: "color: color-mix(in srgb, red, blue)", since: "Chrome 111, Firefox 113" },
  { name: "text-wrap: balance", test: /text-wrap\s*:\s*(balance|pretty)/, supports: "text-wrap: balance", since: "Chrome 114, Firefox 121" },
  { name: "@starting-style / anchor positioning", test: /@starting-style|anchor-name\s*:|position-anchor\s*:/, supports: "anchor-name: --a", since: "Chrome 125" },
];

interface PageCheck {
  title: string;
  textLength: number;
  errors: string[];
  unsupported: string[];
}

class WebDriverSession {
  constructor(
    private grid: string,
    readonly id: string,
    private signal: AbortSignal,
  ) {}

  static async start(grid: string, caps: Record<string, unknown>, signal: AbortSignal): Promise<WebDriverSession> {
    const res = await fetch(`${grid}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: caps } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    });
    const data = (await res.json().catch(() => ({}))) as { value?: { sessionId?: string; message?: string } };
    if (!res.ok || !data.value?.sessionId) throw new Error(data.value?.message?.split("\n")[0] ?? `the grid answered ${res.status}`);
    return new WebDriverSession(grid, data.value.sessionId, signal);
  }

  async cmd<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.grid}/session/${this.id}${p}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(90_000)]),
    });
    const data = (await res.json().catch(() => ({}))) as { value?: T & { message?: string } };
    if (!res.ok) throw new Error((data.value as { message?: string } | undefined)?.message?.split("\n")[0] ?? `WebDriver ${res.status}`);
    return data.value as T;
  }

  quit() {
    return fetch(`${this.grid}/session/${this.id}`, { method: "DELETE" }).catch(() => undefined);
  }
}

const CHECK_SCRIPT = `
  var css = "";
  for (var i = 0; i < document.styleSheets.length; i++) {
    try { var r = document.styleSheets[i].cssRules; for (var j = 0; j < r.length && css.length < 400000; j++) css += r[j].cssText + "\\n"; } catch (e) {}
  }
  var inline = document.querySelectorAll("style");
  for (var k = 0; k < inline.length; k++) css += inline[k].textContent;
  return { title: document.title, textLength: (document.body ? document.body.innerText : "").trim().length, css: css.slice(0, 400000), errors: window.__glvErrors || [] };
`;

/** Pure: modern CSS the page uses that this browser cannot read. */
export function unsupportedCss(css: string, supported: Record<string, boolean>): string[] {
  return CSS_FEATURES.filter((f) => f.test.test(css) && supported[f.name] === false).map((f) => `${f.name} (needs ${f.since})`);
}

export const browserMatrixTool: Tool = {
  id: "browser-matrix",
  name: "Older browser versions",
  maker: "Selenium Grid 4 (Software Freedom Conservancy), on GLV's server",
  description: "Opens the site in older Chrome, Firefox ESR and Edge versions on GLV's own Selenium Grid, and reports script errors, blank pages and modern CSS those versions cannot draw. The cross-browser check only uses today's engines.",
  checks: [
    "Chrome 109 (the last on Windows 7/8), Chrome 120, Firefox 115 ESR, Edge 120",
    "Script errors and blank pages in the old versions",
    "Modern CSS the old version ignores (:has, container queries, nesting, dvh, color-mix…)",
    "A picture of each page in each version",
  ],
  products: WEB_PRODUCTS,
  category: "functional",
  safety: "safe",
  takes: "2 to 6 minutes",
  licence: "Apache-2.0, free",
  homepage: "https://www.selenium.dev/documentation/grid/",
  signedIn: "public",
  options: [{ id: "browsers", label: "Versions", kind: "toggles", choices: MATRIX.map((m) => ({ value: m.id, label: m.label })), default: MATRIX.map((m) => m.id).join(",") }],

  async ready() {
    const grid = process.env.SELENIUM_GRID_URL;
    if (!grid) return "No Selenium Grid on this server: start it with docker compose --profile grid and set SELENIUM_GRID_URL.";
    try {
      const res = await fetch(`${grid.replace(/\/+$/, "")}/status`, { signal: AbortSignal.timeout(5000) });
      const data = (await res.json()) as { value?: { ready?: boolean } };
      return data.value?.ready ? null : "The Selenium Grid is not ready yet.";
    } catch {
      return "The Selenium Grid does not answer.";
    }
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const grid = process.env.SELENIUM_GRID_URL!.replace(/\/+$/, "");
    const picked = new Set((ctx.options.browsers ?? "").split(",").filter(Boolean));
    const browsers = MATRIX.filter((m) => picked.size === 0 || picked.has(m.id));
    const pages = [...new Set([ctx.startUrl, ...ctx.urls])].slice(0, 5);
    const findings: ToolFinding[] = [];
    const images: ToolImage[] = [];
    const rows: string[][] = [];
    const notes: string[] = [];
    for (const b of browsers) {
      ctx.signal.throwIfAborted();
      let s: WebDriverSession;
      try {
        s = await WebDriverSession.start(grid, { browserName: b.browserName, browserVersion: b.browserVersion, ...(b.browserName !== "firefox" ? { "goog:loggingPrefs": { browser: "SEVERE" }, "ms:loggingPrefs": { browser: "SEVERE" } } : {}) }, ctx.signal);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        notes.push(`${b.label}: not on the grid (${(err as Error).message.slice(0, 80)})`);
        continue;
      }
      try {
        const supported = await s.cmd<Record<string, boolean>>("POST", "/execute/sync", {
          script: `var t = arguments[0]; var out = {}; for (var k in t) { try { out[k] = CSS.supports(t[k]); } catch (e) { out[k] = false; } } return out;`,
          args: [Object.fromEntries(CSS_FEATURES.map((f) => [f.name, f.supports]))],
        });
        for (const [i, url] of pages.entries()) {
          ctx.signal.throwIfAborted();
          let check: PageCheck & { css?: string };
          try {
            await s.cmd("POST", "/url", { url });
            check = await s.cmd("POST", "/execute/sync", { script: CHECK_SCRIPT, args: [] });
          } catch (err) {
            if (ctx.signal.aborted) throw err;
            rows.push([b.label, url, "did not load", (err as Error).message.slice(0, 60)]);
            findings.push({ category: "functional", rule: "matrix:page-fails", severity: "high", title: `The page does not load in ${b.label}`, detail: `In ${b.why}, the page failed to open: ${(err as Error).message.slice(0, 200)}.`, pageUrl: url, evidence: b.label, key: `matrix:fails:${b.id}:${url}` });
            continue;
          }
          const logs = b.browserName === "firefox" ? [] : await s.cmd<{ level: string; message: string }[]>("POST", "/se/log", { type: "browser" }).catch(() => []);
          const errors = [...check.errors, ...logs.filter((l) => l.level === "SEVERE" && !/favicon|Failed to load resource/i.test(l.message)).map((l) => l.message)];
          const unsupported = unsupportedCss(check.css ?? "", supported);
          rows.push([b.label, url, check.textLength < 50 ? "blank" : "ok", `${errors.length} errors, ${unsupported.length} CSS gaps`]);
          const shot = await s.cmd<string>("GET", "/screenshot").catch(() => "");
          if (shot && i === 0) {
            const file = `matrix-${b.id}.png`;
            await writeFile(path.join(ctx.outDir, file), Buffer.from(shot, "base64"));
            images.push({ file, label: `${b.label}: ${url}` });
          }
          if (check.textLength < 50) {
            findings.push({ category: "functional", rule: "matrix:blank-page", severity: "high", title: `The page is blank in ${b.label}`, detail: `In ${b.why}, the page shows almost no text. Usually the site's JavaScript uses syntax the old version cannot run; compile it for older browsers (Babel or esbuild with a browserslist target such as "chrome >= 109, firefox >= 115").`, pageUrl: url, evidence: `${b.label}: ${check.textLength} characters of text`, key: `matrix:blank:${b.id}:${url}` });
          }
          const real = errors.filter((e) => /SyntaxError|TypeError|ReferenceError|is not a function|is not defined|Unexpected token|Uncaught/i.test(e));
          if (real.length) {
            findings.push({ category: "functional", rule: "matrix:js-error", severity: "medium", title: `Script errors in ${b.label}`, detail: `In ${b.why}, the page's scripts fail. Newer JavaScript (optional chaining, private fields, top-level await, new array methods) must be compiled or polyfilled for the browsers your customers use.`, pageUrl: url, evidence: real.slice(0, 5).join("\n").slice(0, 800), key: `matrix:js:${b.id}:${url}` });
          }
          if (unsupported.length) {
            findings.push({ category: "functional", rule: "matrix:css-unsupported", severity: "low", title: `${b.label} ignores modern CSS the page uses`, detail: `Layout parts built with these features fall back or break in ${b.why}. Add a fallback (@supports) or a simpler rule before them.`, pageUrl: url, evidence: unsupported.join("\n"), key: `matrix:css:${b.id}:${url}` });
          }
        }
      } finally {
        await s.quit();
      }
    }
    if (!rows.length) throw new Error(`None of the browser versions is on the grid. ${notes.join("; ")}`);
    return {
      findings,
      images,
      summary: [`${pages.length} pages in ${browsers.length - notes.length} older browser versions`, ...notes],
      tested: `${pages.length} pages × ${browsers.length - notes.length} browser versions`,
      table: { title: "Older browsers", columns: ["Browser", "Page", "Result", "Problems"], rows },
    };
  },
};
