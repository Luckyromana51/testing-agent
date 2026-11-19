import { request as playwrightRequest, type BrowserContext, type Request } from "playwright";
import type { CapturedCall, SiteAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { siteOf } from "../runner/urls.js";
import type { AppCall, Finding, ProductType } from "../types.js";

/**
 * The app's own calls: the fetch and XHR requests its screens make to its server (the "API behind
 * the app"). Top security tools read these, because broken access often hides in them: a call that
 * answers without a login, or sends the browser password hashes and other people's data.
 */

export const APPS: ProductType[] = ["webapp", "saas", "crm"];
const MAX_CALLS = 1000;
const MAX_BODY = 300_000;
const REPLAY_HEADERS = /^(authorization|x-[\w-]*(token|auth|key|session|tenant|company|org)[\w-]*)$/i;

/** Starts noting the app calls made in this browser. Returns the list it fills and a stop function. */
export function captureCalls(context: BrowserContext, origin: string): { calls: CapturedCall[]; stop: () => void } {
  const calls: CapturedCall[] = [];
  const byKey = new Map<string, CapturedCall>();
  const site = siteOf(new URL(origin).hostname);
  const onDone = async (req: Request) => {
    const type = req.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    let u: URL;
    try {
      u = new URL(req.url());
    } catch {
      return;
    }
    if (siteOf(u.hostname) !== site) return;
    const key = `${req.method()} ${u.origin}${u.pathname}${u.search}`;
    const had = byKey.get(key);
    if (had) {
      had.count++;
      // Several screens load at once, so which one asked first changes run to run: keep the same one.
      const from = (() => {
        try {
          return req.frame().page().url();
        } catch {
          return "";
        }
      })();
      if (from && (!had.pageUrl || from < had.pageUrl)) had.pageUrl = from;
      return;
    }
    if (calls.length >= MAX_CALLS) return;
    const res = await req.response().catch(() => null);
    const headers = res ? await res.allHeaders().catch(() => ({}) as Record<string, string>) : {};
    const contentType = (headers["content-type"] ?? "").toLowerCase();
    let body: string | undefined;
    if (res && /json|text|xml|javascript/.test(contentType)) {
      const buf = await res.body().catch(() => undefined);
      if (buf && buf.length <= MAX_BODY) body = buf.toString("utf8");
    }
    const reqHeaders = await req.allHeaders().catch(() => ({}) as Record<string, string>);
    const auth = Object.fromEntries(Object.entries(reqHeaders).filter(([k]) => REPLAY_HEADERS.test(k)));
    const t = req.timing();
    const frameUrl = (() => {
      try {
        return req.frame().page().url();
      } catch {
        return "";
      }
    })();
    const call: CapturedCall = {
      method: req.method(),
      url: req.url(),
      status: res?.status() ?? 0,
      ms: Math.max(0, Math.round(t.responseEnd)),
      bytes: Number(headers["content-length"]) || (body ? Buffer.byteLength(body) : 0),
      pageUrl: frameUrl,
      type,
      contentType,
      ...(body !== undefined ? { body } : {}),
      ...(Object.keys(auth).length ? { auth } : {}),
      count: 1,
    };
    byKey.set(key, call);
    calls.push(call);
  };
  const handler = (req: Request) => void onDone(req).catch(() => {});
  context.on("requestfinished", handler);
  return { calls, stop: () => context.off("requestfinished", handler) };
}

/**
 * Puts the calls in a fixed order (by address, then method). They are noted as they finish, and
 * with several screens at once that order changes run to run; the checks that take the first 15 or
 * 40 calls must take the same ones every time.
 */
export function sortCalls(calls: CapturedCall[]): CapturedCall[] {
  return calls.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method));
}

/** What the report shows of a call: no answers, no headers. */
export const reportCall = (c: CapturedCall): AppCall => ({
  method: c.method,
  url: c.url.slice(0, 500),
  status: c.status,
  ms: c.ms,
  bytes: c.bytes,
  pageUrl: c.pageUrl,
  type: c.type,
  ...(c.auth?.authorization ? { bearer: true } : {}),
  ...(c.anon !== undefined ? { anon: c.anon } : {}),
});

/** Field names that must never reach a browser. */
const SECRET_KEYS = /^(password|passwd|pwd|pass|password_?hash|hashed_?password|pass_?hash|salt|secret|client_?secret|api_?secret|private_?key|totp_?secret|otp_?secret|mfa_?secret|two_?factor_?secret|recovery_?codes?|reset_?token|password_?reset_?token|remember_?token|ssn|aadhaar|aadhar|pan_?number|card_?number|cc_?number|cvv|cvc|bank_?account(_?number)?|iban)$/i;
const TOKEN_KEYS = /^(api_?key|access_?token|refresh_?token|auth_?token|session_?token|bearer)$/i;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g;
/** Calls whose answers are public by nature (settings for the screen, translations...). */
const PUBLIC_CALL = /\/(config|settings\/public|i18n|locales?|translations?|lang|health|status|version|csrf|csrf-token|sanctum\/csrf-cookie|manifest|countries|currencies|timezones|static)\b/i;

interface Seen {
  secret: Set<string>;
  token: Set<string>;
}

/** Walks a JSON answer for secret field names with a real value. */
function scanJson(value: unknown, seen: Seen, depth = 0): void {
  if (depth > 8 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value.slice(0, 200)) scanJson(v, seen, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const has = (typeof v === "string" && v.length >= 4 && !/^\**$/.test(v) && !/^(null|none|hidden|\[hidden\])$/i.test(v)) || (typeof v === "number" && String(v).length >= 8);
    if (has && SECRET_KEYS.test(k)) seen.secret.add(k);
    else if (has && TOKEN_KEYS.test(k)) seen.token.add(k);
    scanJson(v, seen, depth + 1);
  }
}

const parse = (body?: string): unknown => {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
};

const pathOf = (u: string) => {
  const x = new URL(u);
  return x.pathname + x.search;
};

/** Two answers carry the same data: equal, or nearly the same text. */
export function sameData(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = new Set(a.match(/[\w@.-]{4,}/g) ?? []);
  const tb = new Set(b.match(/[\w@.-]{4,}/g) ?? []);
  if (ta.size < 5 || tb.size < 5) return false;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both++;
  return both / Math.max(ta.size, tb.size) >= 0.8;
}

export const appCallsAgent: SiteAgent = {
  id: "app.calls",
  name: "The app's own API calls",
  description:
    "Notes every call the signed-in screens make to the app's server (fetch and XHR): errors, slow calls, password hashes and other secrets sent to the browser, answers with too much data, and calls that still answer when made again with no login.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  async run({ site, log }) {
    const calls = site.calls ?? [];
    if (!calls.length) return [];
    const out: Finding[] = [];
    const errors = calls.filter((c) => c.status >= 500 || c.status === 0);
    for (const c of errors.slice(0, 15)) {
      out.push(
        finding({
          category: "functional",
          rule: c.status === 0 ? "app:call-failed" : "app:call-server-error",
          severity: "high",
          title: c.status === 0 ? "An app call gets no answer" : `An app call fails with a server error (HTTP ${c.status})`,
          detail: `The screen ${c.pageUrl || "(unknown)"} calls ${c.method} ${pathOf(c.url)} and ${c.status === 0 ? "gets no answer" : `the server answers ${c.status}`}. Part of the screen is likely empty or broken for users. Check the server log for this address.`,
          pageUrl: c.pageUrl || c.url,
          evidence: `${c.method} ${pathOf(c.url)} → ${c.status || "no answer"}`,
          agent: "app.calls",
        }),
      );
    }
    const missing = calls.filter((c) => c.status === 404 || c.status === 400 || c.status === 422 || c.status === 405);
    for (const c of missing.slice(0, 10)) {
      out.push(
        finding({
          category: "functional",
          rule: "app:call-client-error",
          severity: "medium",
          title: `An app call is refused (HTTP ${c.status})`,
          detail: `${c.method} ${pathOf(c.url)}, made by ${c.pageUrl || "a screen"}, answers ${c.status}. The screen asks for something the server does not have or does not accept: a removed route, a wrong id, or a missing field.`,
          pageUrl: c.pageUrl || c.url,
          evidence: `${c.method} ${pathOf(c.url)} → ${c.status}`,
          agent: "app.calls",
        }),
      );
    }
    const slow = calls.filter((c) => c.ms >= 3000 && c.status > 0).sort((a, b) => b.ms - a.ms);
    if (slow.length) {
      out.push(
        finding({
          category: "performance",
          rule: "app:call-slow",
          severity: slow[0].ms >= 8000 ? "high" : "medium",
          title: `${slow.length} app call${slow.length === 1 ? " takes" : "s take"} 3 seconds or more`,
          detail: "Users wait for these on every visit to the screen. Usual causes: a database query without an index, loading every record instead of a page of them, or calling another service on each request.",
          pageUrl: slow[0].pageUrl || slow[0].url,
          evidence: slow.slice(0, 8).map((c) => `${(c.ms / 1000).toFixed(1)} s  ${c.method} ${pathOf(c.url)}`).join("\n"),
          agent: "app.calls",
        }),
      );
    }
    for (const c of calls) {
      const json = parse(c.body);
      if (json === undefined) continue;
      const seen: Seen = { secret: new Set(), token: new Set() };
      scanJson(json, seen);
      if (seen.secret.size) {
        out.push(
          finding({
            category: "security",
            rule: "app:call-sends-secrets",
            severity: [...seen.secret].some((k) => /pass|hash|salt|secret|key|token|recovery/i.test(k)) ? "critical" : "high",
            title: "An app call sends secret fields to the browser",
            detail: `${c.method} ${pathOf(c.url)} answers with ${[...seen.secret].join(", ")}. Anything in an answer can be read by the user (and by any script on the page), even when the screen does not show it. Leave these fields out on the server (hidden fields in the model, or a resource/serializer with only the fields the screen needs).`,
            pageUrl: c.pageUrl || c.url,
            evidence: `${c.method} ${pathOf(c.url)}: fields ${[...seen.secret].join(", ")}`,
            agent: "app.calls",
          }),
        );
      }
      const emails = new Set((c.body ?? "").match(EMAIL) ?? []);
      const rows = Array.isArray(json) ? json.length : Array.isArray((json as { data?: unknown[] })?.data) ? (json as { data: unknown[] }).data.length : 0;
      if (c.bytes > 1_000_000 || rows > 500 || emails.size > 200) {
        out.push(
          finding({
            category: "performance",
            rule: "app:call-too-much-data",
            severity: emails.size > 200 ? "high" : "medium",
            title: "An app call sends far more data than a screen shows",
            detail: `${c.method} ${pathOf(c.url)} answers with ${[c.bytes > 1_000_000 ? `${(c.bytes / 1_000_000).toFixed(1)} MB` : "", rows > 500 ? `${rows} records` : "", emails.size > 200 ? `${emails.size} email addresses` : ""].filter(Boolean).join(", ")}. It slows the screen and hands every record to anyone signed in. Send one page of records at a time (paging) and only the fields the screen needs.`,
            pageUrl: c.pageUrl || c.url,
            evidence: `${c.method} ${pathOf(c.url)}`,
            agent: "app.calls",
          }),
        );
      }
    }

    // The same calls with no login: a stranger's view.
    const replay = calls.filter((c) => c.method === "GET" && c.status >= 200 && c.status < 300 && c.body && !PUBLIC_CALL.test(new URL(c.url).pathname)).slice(0, 40);
    if (replay.length) {
      log(`Calling ${replay.length} app calls again without the login`);
      const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
      const stranger = await playwrightRequest.newContext({
        ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.5",
      });
      try {
        for (const c of replay) {
          site.signal?.throwIfAborted();
          const r = await stranger.get(c.url, { timeout: 15_000, maxRedirects: 0 }).catch(() => null);
          if (!r) continue;
          const status = r.status();
          const body = status >= 200 && status < 300 ? await r.text().catch(() => "") : "";
          const same = sameData(c.body, body);
          c.anon = same ? "same" : status;
          if (!same) continue;
          const user = site.loginUser && body.toLowerCase().includes(site.loginUser.toLowerCase());
          const emails = new Set(body.match(EMAIL) ?? []).size;
          out.push(
            finding({
              category: "security",
              rule: "app:call-public",
              severity: user || emails > 0 ? "critical" : "high",
              title: user || emails > 0 ? "An app call gives private data to anyone, with no login" : "An app call answers the same with no login",
              detail: `${c.method} ${pathOf(c.url)} gave a visitor with no login the same answer as the signed-in user${user ? ", including the user's own email" : emails ? `, including ${emails} email address${emails === 1 ? "" : "es"}` : ""}. The screen is protected, but the data behind it is not. Put the login check (auth middleware) on the API routes too, not only on the pages.`,
              pageUrl: c.pageUrl || c.url,
              evidence: `No login: HTTP ${status}, same data${c.auth ? " (the app sends a login header; the call worked without it)" : ""}`,
              agent: "app.calls",
            }),
          );
        }
      } finally {
        await stranger.dispose();
      }
    }
    return out;
  },
};
