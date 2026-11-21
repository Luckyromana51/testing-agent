import { request as playwrightRequest, type BrowserContext, type Page, type Request, type WebSocket } from "playwright";
import type { CapturedCall, SiteAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { siteOf } from "../runner/urls.js";
import type { AppCall, AppSocket, Finding, ProductType } from "../types.js";
import { INTROSPECTION, safeRead } from "./reads.js";

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
export function captureCalls(context: BrowserContext, origin: string): { calls: CapturedCall[]; sockets: AppSocket[]; stop: () => void } {
  const calls: CapturedCall[] = [];
  const sockets: AppSocket[] = [];
  // Live connections (WebSocket): the address only, once each.
  const onSocket = (page: Page) => (ws: WebSocket) => {
    const url = ws.url();
    if (sockets.length < 20 && !sockets.some((x) => x.url === url)) sockets.push({ url, pageUrl: page.url() });
  };
  const watched = new Map<Page, (ws: WebSocket) => void>();
  const watch = (page: Page) => {
    if (watched.has(page)) return;
    const h = onSocket(page);
    watched.set(page, h);
    page.on("websocket", h);
  };
  for (const p of context.pages()) watch(p);
  context.on("page", watch);
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
    // A POST that only reads (GraphQL, Odoo): each different question is its own call.
    const post = req.method() === "POST" ? req.postData() : null;
    const reqType = req.headers()["content-type"] ?? "";
    const read = post ? safeRead("POST", req.url(), post, reqType) : undefined;
    const key = `${req.method()} ${u.origin}${u.pathname}${u.search}${read ? ` ${post}` : ""}`;
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
      ...(read && post && post.length <= 20_000 ? { read, request: { body: post, contentType: reqType || "application/json" } } : {}),
      count: 1,
    };
    byKey.set(key, call);
    calls.push(call);
  };
  const handler = (req: Request) => void onDone(req).catch(() => {});
  context.on("requestfinished", handler);
  return {
    calls,
    sockets,
    stop: () => {
      context.off("requestfinished", handler);
      context.off("page", watch);
      for (const [p, h] of watched) p.off("websocket", h);
    },
  };
}

/**
 * Puts the calls in a fixed order (by address, then method). They are noted as they finish, and
 * with several screens at once that order changes run to run; the checks that take the first 15 or
 * 40 calls must take the same ones every time.
 */
export function sortCalls(calls: CapturedCall[]): CapturedCall[] {
  return calls.sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method) || (a.request?.body ?? "").localeCompare(b.request?.body ?? ""));
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
  ...(c.read ? { what: c.read } : {}),
  ...(c.anon !== undefined ? { anon: c.anon } : {}),
});

/** Login values in a live connection's address: kept out of the report. */
const SOCKET_SECRET = /([?&](?:token|access_token|auth|auth_token|jwt|session|session_id|sid|key|api_key|apikey|password|ticket)=)[^&#]+/gi;
export const hideSocketSecrets = (url: string) => url.replace(SOCKET_SECRET, "$1[hidden]").slice(0, 500);

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

    // Live connections: login values in the address end up in server and proxy logs.
    const pageIsHttps = calls.some((c) => c.pageUrl.startsWith("https:")) || (site.sockets ?? []).some((x) => x.pageUrl.startsWith("https:"));
    for (const ws of site.sockets ?? []) {
      const hidden = hideSocketSecrets(ws.url);
      if (hidden !== ws.url.slice(0, 500)) {
        out.push(
          finding({
            category: "security",
            rule: "app:socket-token-in-address",
            severity: "medium",
            title: "A live connection puts the login token in its address",
            detail: `The screen opens a live connection (WebSocket) to ${hidden}. Addresses are written to server, proxy and load-balancer logs, so anyone who reads them can use the token. Send the token in the first message after connecting, or rely on the session cookie, and keep tokens short-lived.`,
            pageUrl: ws.pageUrl || ws.url,
            evidence: hidden,
            agent: "app.calls",
          }),
        );
      }
      if (ws.url.startsWith("ws:") && (ws.pageUrl.startsWith("https:") || pageIsHttps)) {
        out.push(
          finding({
            category: "security",
            rule: "app:socket-not-encrypted",
            severity: "high",
            title: "A live connection is not encrypted",
            detail: `The app is on https, but its live connection uses plain ws:// (${hidden}). Everything in it (messages, and the cookies sent when it opens) can be read on the network. Use wss://.`,
            pageUrl: ws.pageUrl || ws.url,
            evidence: hidden,
            agent: "app.calls",
          }),
        );
      }
    }

    // The same calls with no login: a stranger's view. POST calls that only read (GraphQL queries,
    // Odoo reads) are sent again with the same question.
    const replay = calls.filter((c) => (c.method === "GET" || c.request) && c.status >= 200 && c.status < 300 && c.body && !PUBLIC_CALL.test(new URL(c.url).pathname)).slice(0, 40);
    const graphql = [...new Set(calls.filter((c) => c.read?.startsWith("GraphQL")).map((c) => c.url))].slice(0, 2);
    if (replay.length || graphql.length) {
      log(`Calling ${replay.length} app calls again without the login`);
      const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
      const stranger = await playwrightRequest.newContext({
        ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.5",
      });
      try {
        // A GraphQL server that tells anyone its whole schema hands attackers a map of every query.
        for (const g of graphql) {
          const r = await stranger.post(g, { data: INTROSPECTION, headers: { "content-type": "application/json" }, timeout: 15_000, maxRedirects: 0 }).catch(() => null);
          const text = r && r.status() < 300 ? await r.text().catch(() => "") : "";
          const types = (parse(text) as { data?: { __schema?: { types?: { name: string }[] } } } | undefined)?.data?.__schema?.types;
          if (!types?.length) continue;
          const own = types.map((t) => t.name).filter((n) => !n.startsWith("__") && !["String", "Int", "Float", "Boolean", "ID"].includes(n));
          out.push(
            finding({
              category: "security",
              rule: "app:graphql-schema-public",
              severity: "medium",
              title: "Anyone can read the app's GraphQL schema, with no login",
              detail: `${pathOf(g)} answers the schema question (introspection) for a visitor with no login: ${types.length} types, every query and field the app has. It is a map for attackers looking for fields that are not protected. Turn introspection off in production (or allow it only for signed-in developers).`,
              pageUrl: g,
              evidence: `No login: ${types.length} types, like ${own.slice(0, 8).join(", ")}`,
              agent: "app.calls",
            }),
          );
        }
        for (const c of replay) {
          site.signal?.throwIfAborted();
          const r = await (c.request
            ? stranger.post(c.url, { data: c.request.body, headers: { "content-type": c.request.contentType }, timeout: 15_000, maxRedirects: 0 })
            : stranger.get(c.url, { timeout: 15_000, maxRedirects: 0 })
          ).catch(() => null);
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
              detail: `${c.method} ${pathOf(c.url)}${c.read ? ` (${c.read})` : ""} gave a visitor with no login the same answer as the signed-in user${user ? ", including the user's own email" : emails ? `, including ${emails} email address${emails === 1 ? "" : "es"}` : ""}. The screen is protected, but the data behind it is not. Put the login check (auth middleware) on the API routes too, not only on the pages.`,
              pageUrl: c.pageUrl || c.url,
              evidence: `${c.read ? `${c.read}\n` : ""}No login: HTTP ${status}, same data${c.auth ? " (the app sends a login header; the call worked without it)" : ""}`,
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
