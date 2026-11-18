import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { WEB_PRODUCTS } from "../products.js";
import { isUnsafeLink } from "../runner/urls.js";
import type { Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * GLV's own attack probes: the classic break-in attempts a security tester tries by hand, sent to
 * the parameters of the pages the test found. Each finding is confirmed before it is reported
 * (the injected script really runs in a browser, the database error goes away when the quote is
 * escaped, the true and false conditions give different pages twice). Only GET requests, and no
 * payload can change data: no OR 1=1, no stacked queries, nothing that deletes or updates.
 */

/** One parameter to probe: the address without it, its name and its normal value. */
export interface ProbeTarget {
  url: string;
  param: string;
  value: string;
  /** Where it came from: the address itself, or a form on the page. */
  from: "address" | "form";
}

const MAX_TARGETS = 60;
const MAX_BODY = 2_000_000;

/** Finds the GET forms of a page and the fields they send (enough to know the parameter names). */
export function getForms(html: string, pageUrl: string): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = m[1];
    const method = /\bmethod\s*=\s*["']?(\w+)/i.exec(attrs)?.[1]?.toLowerCase() ?? "get";
    if (method !== "get") continue;
    const action = /\baction\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
    let target: URL;
    try {
      target = new URL(action || pageUrl, pageUrl);
    } catch {
      continue;
    }
    if (target.origin !== new URL(pageUrl).origin) continue;
    target.search = "";
    target.hash = "";
    for (const f of m[2].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const a = f[2];
      const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(a)?.[1];
      const type = /\btype\s*=\s*["']?(\w+)/i.exec(a)?.[1]?.toLowerCase() ?? "text";
      if (!name || ["submit", "button", "image", "file", "reset", "password", "checkbox", "radio"].includes(type)) continue;
      const value = /\bvalue\s*=\s*["']([^"']*)["']/i.exec(a)?.[1] ?? "";
      out.push({ url: target.toString(), param: name, value: value || (/id$|^(page|p|n|num|qty|count)$/i.test(name) ? "1" : "test"), from: "form" });
    }
  }
  return out;
}

/** Links on the page with parameters, on the same site: a link that redirects (/go?next=) is never a page of its own in the crawl. */
export function linkParams(html: string, pageUrl: string): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  const origin = new URL(pageUrl).origin;
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]*\?[^"'#]*)["']/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), pageUrl);
      if (u.origin === origin && /^https?:$/.test(u.protocol)) out.push(...addressParams(u.toString()));
    } catch {
      // not an address
    }
  }
  return out;
}

/** The parameters in an address. */
export function addressParams(url: string): ProbeTarget[] {
  const u = new URL(url);
  return [...u.searchParams.entries()].map(([param, value]) => ({ url, param, value, from: "address" as const }));
}

/** The address with one parameter set to a value (the others as they were). */
export function withParam(t: ProbeTarget, value: string): string {
  const u = new URL(t.url);
  u.searchParams.set(t.param, value);
  return u.toString();
}

/** Database error messages, by database. Each is specific enough not to appear on a normal page. */
export const SQL_ERRORS: [string, RegExp][] = [
  ["MySQL", /You have an error in your SQL syntax|Warning: mysqli?_|MySqlException|check the manual that (?:corresponds|fits) to your (?:MySQL|MariaDB) server version/i],
  ["PostgreSQL", /PG::SyntaxError|ERROR:\s+syntax error at or near|unterminated quoted string at or near|org\.postgresql\.util\.PSQLException/i],
  ["SQLite", /SQLITE_ERROR|SQLite3::SQLException|sqlite3\.OperationalError|unrecognized token: "|near "[^"]{0,40}": syntax error/i],
  ["Microsoft SQL Server", /Unclosed quotation mark after the character string|Microsoft OLE DB Provider for SQL Server|\[SQL Server\]|System\.Data\.SqlClient\.SqlException/i],
  ["Oracle", /ORA-0(?:1756|0933|0936)|quoted string not properly terminated/i],
];

export const sqlError = (body: string) => SQL_ERRORS.find(([, re]) => re.test(body))?.[0];

/** The text of a page without the probe's own value in it, so a page that only echoes the value is not seen as different. */
function without(body: string, values: string[]): string {
  let out = body;
  for (const v of values) {
    for (const form of new Set([v, encodeURIComponent(v), v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"), v.replace(/'/g, "&#x27;"), v.replace(/ /g, "+")])) {
      if (form) out = out.split(form).join("");
    }
  }
  return out;
}

const words = (s: string) => new Set(s.replace(/<[^>]+>/g, " ").toLowerCase().match(/[a-z0-9\u0080-￿]+/g) ?? []);

/** How alike two answers are: 1 is the same. Compares status, length and the words on the page. */
export function likeness(a: Answer, b: Answer, strip: string[] = []): number {
  if (a.status !== b.status) return 0;
  const x = without(a.body, strip);
  const y = without(b.body, strip);
  const len = Math.max(x.length, y.length) || 1;
  const sizeLike = 1 - Math.abs(x.length - y.length) / len;
  const wx = words(x);
  const wy = words(y);
  let shared = 0;
  for (const w of wx) if (wy.has(w)) shared++;
  const union = wx.size + wy.size - shared || 1;
  return Math.min(sizeLike, shared / union);
}

export interface Answer {
  status: number;
  body: string;
  type: string;
  location?: string;
}

interface ProbeHttp {
  get(url: string, opts?: { follow?: boolean }): Promise<Answer>;
  /** Requests sent, for the report. */
  sent: number;
}

/** A polite client: at most two requests at a time and about 8 a second, GET only, stopped by the run's signal. */
function politeHttp(ctx: ToolContext, deadline: number): ProbeHttp {
  let last = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  const headers: Record<string, string> = { "user-agent": "GLV-Testing-Agent security probe" };
  if (ctx.cookie) headers.cookie = ctx.cookie;
  const client: ProbeHttp = {
    sent: 0,
    async get(url, opts = {}) {
      if (Date.now() > deadline) throw new Error("time limit");
      if (active >= 2) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        const gap = 125 - (Date.now() - last);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        last = Date.now();
        ctx.signal.throwIfAborted();
        client.sent++;
        const res = await fetch(url, {
          method: "GET",
          headers,
          redirect: opts.follow === false ? "manual" : "follow",
          signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
        });
        const type = res.headers.get("content-type") ?? "";
        let body = "";
        if (opts.follow !== false || res.status < 300 || res.status >= 400) {
          const buf = await res.arrayBuffer();
          body = Buffer.from(buf.slice(0, MAX_BODY)).toString("utf8");
        } else await res.body?.cancel();
        return { status: res.status, body, type, ...(res.headers.get("location") ? { location: res.headers.get("location")! } : {}) };
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
  return client;
}

/** A short, stable marker for this target, so re-tests send the same values. */
const mark = (t: ProbeTarget, salt: string) => createHash("sha1").update(`${t.url}|${t.param}|${salt}`).digest("hex").slice(0, 8);

const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

interface Found {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  target: ProbeTarget;
  evidence: string;
  key: string;
}

/** Reflected cross-site scripting: the value comes back as HTML, and a script in it really runs. */
async function probeXss(t: ProbeTarget, http: ProbeHttp, confirm: (url: string, id: string) => Promise<boolean>): Promise<Found | undefined> {
  const id = mark(t, "xss");
  const canary = `glvq${id}z`;
  const first = await http.get(withParam(t, canary));
  if (!/html/i.test(first.type) || !first.body.includes(canary)) return undefined;
  const tag = `glvx${id}`;
  const probe = `${canary}"'><${tag}>`;
  const second = await http.get(withParam(t, probe));
  if (!second.body.includes(`<${tag}>`)) return undefined;
  const payload = `${canary}"'><img src=glv-${id}.invalid onerror=__glvHit('${id}')>`;
  const ran = await confirm(withParam(t, payload), id);
  const where = `${t.from === "form" ? "form field" : "parameter"} "${t.param}"`;
  return {
    rule: "probe:xss",
    severity: ran ? "high" : "medium",
    title: ran ? `Cross-site scripting: the ${where} runs injected script` : `The ${where} puts HTML back on the page without escaping it`,
    detail: ran
      ? `A link with a script in the ${where} makes the page run that script for whoever opens it: an attacker can steal sessions, change what the page shows or act as the user (OWASP A03 Injection, CWE-79). Escape every value before putting it in HTML (most template engines do this by default), and add a Content Security Policy.`
      : `The value of the ${where} comes back as real HTML tags, unescaped. The browser did not run the test script (a Content Security Policy or the page's structure may have stopped it), but the hole is there. Escape the value before putting it in HTML (CWE-79).`,
    target: t,
    evidence: `${ran ? "Script ran" : "Unescaped tag came back"} for: ${withParam(t, ran ? payload : probe)}`,
    key: `xss:${pathOf(t.url)}:${t.param}`,
  };
}

/** SQL injection: a database error that a quote causes and an escaped quote does not, or true/false conditions that change the page. */
async function probeSql(t: ProbeTarget, http: ProbeHttp): Promise<Found | undefined> {
  const where = `${t.from === "form" ? "form field" : "parameter"} "${t.param}"`;
  const base = await http.get(withParam(t, t.value));
  const baseError = sqlError(base.body);
  for (const q of ["'", '"']) {
    const broken = await http.get(withParam(t, `${t.value}${q}`));
    const db = sqlError(broken.body);
    if (!db || baseError) continue;
    // The same quote, escaped: if the error goes away, the quote reached the query.
    const escaped = await http.get(withParam(t, `${t.value}${q}${q}`));
    if (sqlError(escaped.body)) continue;
    const line = broken.body.match(SQL_ERRORS.find(([n]) => n === db)![1])?.[0] ?? "";
    return {
      rule: "probe:sql-injection",
      severity: "high",
      title: `SQL injection: the ${where} breaks the database query`,
      detail: `A ${q === "'" ? "single" : "double"} quote in the ${where} makes the ${db} database fail with a syntax error, and the same quote escaped does not: the value is pasted into the SQL query. An attacker can read or change the whole database (OWASP A03 Injection, CWE-89). Use parameterised queries (prepared statements) for every value, and do not show database errors to visitors.`,
      target: t,
      evidence: `${withParam(t, `${t.value}${q}`)} shows: ${line.slice(0, 160)}`,
      key: `sqli:${pathOf(t.url)}:${t.param}`,
    };
  }
  // True and false conditions: only AND, so the query can only return less, never more or change anything.
  const again = await http.get(withParam(t, t.value));
  if (likeness(base, again) < 0.98) return undefined; // the page changes by itself: no reliable comparison
  const numeric = /^-?\d+$/.test(t.value);
  const pairs: [string, string][] = numeric
    ? [
        [`${t.value} AND 1=1`, `${t.value} AND 1=2`],
        [`${t.value} AND 3>2`, `${t.value} AND 2>3`],
      ]
    : [
        [`${t.value}' AND '1'='1`, `${t.value}' AND '1'='2`],
        [`${t.value}' AND 'b'>'a`, `${t.value}' AND 'a'>'b`],
      ];
  for (const [yes, no] of pairs) {
    const y = await http.get(withParam(t, yes));
    const n = await http.get(withParam(t, no));
    const yesLike = likeness(base, y, [yes]);
    const noLike = likeness(base, n, [no]);
    if (!(yesLike >= 0.97 && noLike < 0.9)) return undefined;
  }
  return {
    rule: "probe:sql-injection",
    severity: "high",
    title: `SQL injection: the ${where} changes the database query`,
    detail: `Adding a true condition to the ${where} gives the normal page, and a false one gives a different page, twice with different conditions: the value is part of the SQL query. An attacker can read the whole database this way, one question at a time (OWASP A03 Injection, CWE-89). Use parameterised queries (prepared statements) for every value.`,
    target: t,
    evidence: `${withParam(t, pairs[0][0])} looks like the normal page; ${withParam(t, pairs[0][1])} does not`,
    key: `sqli:${pathOf(t.url)}:${t.param}`,
  };
}

const REDIRECT_PARAM = /^(next|url|redirect|redirect_?(uri|url|to)|return|return_?(url|to)|returnurl|goto|dest|destination|continue|target|to|out|link|forward|back|r|u)$/i;
const CHECK_HOST = "glv-redirect-check.invalid";

/** Open redirect: the site sends visitors to any address in the parameter (".invalid" names never resolve, so nothing is sent there). */
async function probeRedirect(t: ProbeTarget, http: ProbeHttp): Promise<Found | undefined> {
  if (!REDIRECT_PARAM.test(t.param) && !/^(https?:\/\/|\/)/i.test(t.value)) return undefined;
  for (const v of [`https://${CHECK_HOST}/`, `//${CHECK_HOST}/`]) {
    const res = await http.get(withParam(t, v), { follow: false });
    if (res.status < 300 || res.status >= 400 || !res.location) continue;
    let host = "";
    try {
      host = new URL(res.location, t.url).hostname;
    } catch {
      continue;
    }
    if (host !== CHECK_HOST) continue;
    const where = `${t.from === "form" ? "form field" : "parameter"} "${t.param}"`;
    return {
      rule: "probe:open-redirect",
      severity: "medium",
      title: `Open redirect: the ${where} sends visitors to any website`,
      detail: `A link to this site can send its visitors on to any other website, so phishing links look like they belong to the client (CWE-601). Only redirect to the site's own paths, or to a list of allowed addresses.`,
      target: t,
      evidence: `${withParam(t, v)} answers ${res.status} with Location: ${res.location}`,
      key: `redirect:${pathOf(t.url)}:${t.param}`,
    };
  }
  return undefined;
}

const FILE_PARAM = /^(file|filename|path|page|template|tpl|doc|document|include|inc|view|load|read|download|lang|style|folder|dir)$/i;

/** Path traversal: a file name parameter that reads files outside the site's folder. */
async function probeTraversal(t: ProbeTarget, http: ProbeHttp): Promise<Found | undefined> {
  if (!FILE_PARAM.test(t.param) && !/\.\w{2,5}$/.test(t.value)) return undefined;
  const base = await http.get(withParam(t, t.value));
  if (/root:[x*]?:0:0:/.test(base.body) || /\[fonts\]/i.test(base.body)) return undefined;
  for (const [v, sign, os] of [
    ["../../../../../../../../etc/passwd", /root:[x*]?:0:0:/, "Linux"],
    ["....//....//....//....//....//....//etc/passwd", /root:[x*]?:0:0:/, "Linux"],
    ["..\\..\\..\\..\\..\\..\\windows\\win.ini", /\[fonts\]/i, "Windows"],
  ] as const) {
    const res = await http.get(withParam(t, v));
    if (!sign.test(res.body)) continue;
    const where = `${t.from === "form" ? "form field" : "parameter"} "${t.param}"`;
    return {
      rule: "probe:path-traversal",
      severity: "critical",
      title: `Path traversal: the ${where} reads the server's own files`,
      detail: `The ${where} opened the ${os} server's ${os === "Linux" ? "/etc/passwd" : "win.ini"} file, outside the website's folder. An attacker can read configuration files, passwords and keys this way (CWE-22). Never use a request value as a file path: map allowed names to files, or check the resolved path stays inside the folder.`,
      target: t,
      evidence: `${withParam(t, v)} returned the file's contents`,
      key: `traversal:${pathOf(t.url)}:${t.param}`,
    };
  }
  return undefined;
}

export const probesTool: Tool = {
  id: "glv-probes",
  name: "GLV attack probes",
  maker: "GLV Infotech (built in)",
  description:
    "GLV's own break-in attempts on every parameter and search form of the pages this test found: script injection, SQL injection, open redirects and file paths. Each finding is confirmed before it is reported. GET requests only, and no probe can change data.",
  checks: [
    "Cross-site scripting, confirmed by running the page in a browser",
    "SQL injection: database errors and true/false conditions, each confirmed twice",
    "Open redirects to other websites",
    "Path traversal to the server's own files",
    "About 8 requests a second at most, GET only",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "permission",
  permission: "attack",
  limits: { minutes: "minutes" },
  takes: "1 to 5 minutes",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "uses-login",
  options: [
    {
      id: "minutes",
      label: "Longest time",
      choices: ["2", "5", "10", "20"].map((v) => ({ value: v, label: `${v} minutes` })),
      default: "5",
    },
  ],

  async ready() {
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit) throw new Error("The attack probes run only with the client's permission for attack tests.");
    const minutes = Math.min(Number(ctx.options.minutes) || 5, permit.maxMinutes);
    const deadline = Date.now() + minutes * 60_000;
    const http = politeHttp(ctx, deadline);
    // Never sign-out, delete or (signed in) action links, the same rule the crawler follows: even a
    // GET to one ends the session or changes data.
    const safe = (u: string) => !isUnsafeLink(u, Boolean(ctx.cookie));
    const pages = [...new Set([ctx.startUrl, ...ctx.urls])].filter((u) => /^https?:/.test(u) && safe(u));

    // What to probe: parameters in the addresses, and the fields of GET forms on the pages.
    const all: ProbeTarget[] = [];
    for (const page of pages) all.push(...addressParams(page));
    for (const page of pages.slice(0, 30)) {
      try {
        const res = await http.get(page);
        if (/html/i.test(res.type)) all.push(...getForms(res.body, page), ...linkParams(res.body, page));
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }
    // One probe per path and parameter: /product?id=1 and /product?id=2 are the same code.
    const byKey = new Map<string, ProbeTarget>();
    for (const t of all) {
      if (!safe(t.url)) continue;
      const k = `${pathOf(t.url)}|${t.param}`;
      if (!byKey.has(k)) byKey.set(k, t);
    }
    const targets = [...byKey.values()].slice(0, MAX_TARGETS);
    ctx.log(`Attack probes: ${targets.length} parameter${targets.length === 1 ? "" : "s"} on ${pages.length} page${pages.length === 1 ? "" : "s"}`);

    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const confirm = async (url: string, id: string) => {
      browser ??= await chromium.launch();
      const context = await browser.newContext();
      const origin = new URL(url).origin;
      try {
        const page = await context.newPage();
        // The browser only reads: anything but GET is stopped, and so is the made-up image address.
        // The signed-in session goes only to the client's own site, never to other sites the page loads.
        await page.route("**/*", (route) => {
          const req = route.request();
          const where = new URL(req.url());
          if (req.method() !== "GET" || where.hostname.endsWith(".invalid") || /\/glv-[0-9a-f]{8}\.invalid$/.test(where.pathname)) return route.abort();
          if (ctx.cookie && new URL(req.url()).origin === origin) return route.continue({ headers: { ...req.headers(), cookie: ctx.cookie } });
          return route.continue();
        });
        let hit = false;
        await page.exposeFunction("__glvHit", (got: string) => {
          if (got === id) hit = true;
        });
        http.sent++;
        await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(500);
        return hit;
      } finally {
        await context.close();
      }
    };

    const found: Found[] = [];
    let probed = 0;
    let cut = false;
    try {
      for (const t of targets) {
        ctx.signal.throwIfAborted();
        if (Date.now() > deadline) {
          cut = true;
          break;
        }
        try {
          for (const probe of [() => probeXss(t, http, confirm), () => probeSql(t, http), () => probeRedirect(t, http), () => probeTraversal(t, http)]) {
            const f = await probe();
            if (f) found.push(f);
          }
          probed++;
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          if ((err as Error).message === "time limit") {
            cut = true;
            break;
          }
          // One page that does not answer does not stop the others.
        }
      }
    } finally {
      await (browser as { close(): Promise<void> } | undefined)?.close();
    }

    const findings: ToolFinding[] = found.map((f) => ({
      category: "security",
      rule: f.rule,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      pageUrl: f.target.url.split("?")[0],
      evidence: f.evidence,
      key: f.key,
    }));
    return {
      findings,
      summary: [
        `${probed} of ${targets.length} parameter${targets.length === 1 ? "" : "s"} probed with ${http.sent} requests`,
        ...(cut ? [`Stopped at the ${minutes}-minute limit: ${targets.length - probed} parameters were not probed`] : []),
        targets.length === 0 ? "No parameters or GET forms on the pages found, so there was nothing to probe" : `${found.length} confirmed problem${found.length === 1 ? "" : "s"}`,
      ],
      tested: `${probed} parameters on ${pages.length} pages, GET only${ctx.cookie ? ", signed in" : ""}`,
    };
  },
};
