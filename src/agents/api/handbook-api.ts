import type { Json } from "../../engines/openapi.js";
import { countCases } from "../../runner/cases.js";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { ApiCall } from "./context.js";
import { findLeak, type ApiAgent } from "./shared.js";

/**
 * API checks for the testing types of the testing handbook: negative testing with boundary values
 * and wrong kinds of input on every parameter, HTTP behaviour (HEAD, OPTIONS, conditional requests,
 * repeated and simultaneous calls give the same answer), and API versions. Only safe methods are
 * sent (GET, HEAD, OPTIONS): nothing is created, changed or deleted.
 */

const base = { engine: "api" as const, products: ["api" as const] };
const list = (items: string[], max = 8) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const ok = (c: ApiCall) => c.status !== null && c.status >= 200 && c.status < 300;
const where = (c: ApiCall) => c.url ?? c.op.url;

/** One negative or boundary test case for one parameter. */
interface NegCase {
  param: string;
  what: string;
  value: string | null;
  /** A missing required value, a wrong type or an out-of-range value: the API must refuse it (4xx). */
  mustRefuse: boolean;
}

const schemaType = (s: Json | undefined): string => (Array.isArray(s?.type) ? s.type.find((t: string) => t !== "null") : s?.type) ?? (s?.enum ? "string" : "string");

/** The cases for one parameter, from its schema: boundary values, one value of each wrong kind, and odd text. */
export function casesFor(name: string, required: boolean, schema: Json | undefined): NegCase[] {
  const out: NegCase[] = [];
  const t = schemaType(schema);
  if (required) out.push({ param: name, what: "left out", value: null, mustRefuse: true });
  if (t === "integer" || t === "number") {
    out.push({ param: name, what: "a word instead of a number", value: "abc", mustRefuse: true });
    if (t === "integer") out.push({ param: name, what: "a fraction for a whole number", value: "1.5", mustRefuse: true });
    out.push({ param: name, what: "a number too big for 64 bits", value: "99999999999999999999999", mustRefuse: false });
    if (typeof schema?.minimum === "number") out.push({ param: name, what: `one below its minimum ${schema.minimum}`, value: String(schema.minimum - (t === "integer" ? 1 : 0.5)), mustRefuse: true });
    else out.push({ param: name, what: "-1", value: "-1", mustRefuse: false });
    if (typeof schema?.maximum === "number") out.push({ param: name, what: `one above its maximum ${schema.maximum}`, value: String(schema.maximum + (t === "integer" ? 1 : 0.5)), mustRefuse: true });
  } else if (t === "boolean") {
    out.push({ param: name, what: "a word that is not true or false", value: "maybe", mustRefuse: true });
  } else if (Array.isArray(schema?.enum) && schema.enum.length) {
    out.push({ param: name, what: "a value not in its list", value: "glv-not-an-option", mustRefuse: true });
  } else {
    if (typeof schema?.maxLength === "number" && schema.maxLength < 2000) out.push({ param: name, what: `${schema.maxLength + 1} characters (max ${schema.maxLength})`, value: "a".repeat(schema.maxLength + 1), mustRefuse: true });
    if (schema?.format === "date" || schema?.format === "date-time") out.push({ param: name, what: "an impossible date", value: "2026-02-30", mustRefuse: true });
    if (schema?.format === "email") out.push({ param: name, what: "text that is not an email", value: "not-an-email", mustRefuse: true });
    if (schema?.format === "uuid") out.push({ param: name, what: "text that is not a UUID", value: "not-a-uuid", mustRefuse: true });
  }
  // Every parameter: very long text, quotes and brackets, and other scripts, which must never crash it.
  out.push({ param: name, what: "5,000 characters", value: "x".repeat(5000), mustRefuse: false });
  out.push({ param: name, what: "quotes and brackets", value: `'"<>;)--%`, mustRefuse: false });
  out.push({ param: name, what: "emoji and other scripts", value: "😀漢字हिन्दी", mustRefuse: false });
  return out;
}

const urlWith = (raw: string, p: { name: string; in: string }, value: string | null, path: string): string | null => {
  if (p.in === "query") {
    const u = new URL(raw);
    if (value === null) u.searchParams.delete(p.name);
    else u.searchParams.set(p.name, value);
    return u.toString();
  }
  if (p.in === "path") {
    if (value === null) return null; // a path without the part is another address
    // Rebuild the address from the template, keeping the real values of the other parts.
    const real = new URL(raw);
    const tParts = path.split("/");
    const rParts = real.pathname.split("/");
    const offset = rParts.length - tParts.length;
    if (offset < 0) return null;
    const i = tParts.indexOf(`{${p.name}}`);
    if (i < 0) return null;
    rParts[i + offset] = encodeURIComponent(value);
    real.pathname = rParts.join("/");
    return real.toString();
  }
  return null;
};

export const apiNegativeAgent: ApiAgent = {
  ...base,
  id: "api.negative",
  name: "Negative and boundary tests",
  description:
    "For every parameter of up to 10 endpoints, sends 4 to 9 wrong or edge values: the parameter left out, a word where a number goes, a fraction, one past the minimum and maximum, a value not in the list, an impossible date, 5,000 characters, quotes and brackets, emoji. Wrong values must be refused with a 4xx error, never crash the server (5xx) or show internals. Also an invalid token, an unknown parameter and an Accept header the API does not offer. GET only.",
  category: "functional",
  async run({ calls, send, authenticated, log }) {
    const targets = calls.filter((c) => ok(c) && c.op.method === "GET" && (c.op.params ?? []).some((p) => p.in === "query" || p.in === "path")).slice(0, 10);
    const crash: string[] = [];
    const accepted: string[] = [];
    const leaks: string[] = [];
    let leakSnippet = "";
    const errorTypes = new Map<string, string>();
    let tried = 0;
    let failed = 0;
    let budget = 150;
    for (const c of targets) {
      const params = (c.op.params ?? []).filter((p) => p.in === "query" || p.in === "path").slice(0, 6);
      for (const p of params) {
        for (const k of casesFor(p.name, p.required, p.schema)) {
          if (budget-- <= 0) break;
          const url = urlWith(where(c), p, k.value, c.op.path);
          if (!url) continue;
          const r = await send({ url, method: "GET" }, c.op);
          if (r.status === null) continue;
          tried++;
          const line = `GET ${c.op.path} with ${p.name} ${k.what}: HTTP ${r.status}`;
          const l = findLeak(r.text);
          if (l) {
            failed++;
            leaks.push(line);
            leakSnippet ||= l.snippet;
            continue;
          }
          if (r.status >= 500) {
            failed++;
            crash.push(line);
            continue;
          }
          if (r.status >= 400) errorTypes.set(`${r.status} ${r.contentType.split(";")[0] || "(no type)"}`, line);
          if (k.mustRefuse && r.status < 300) {
            failed++;
            accepted.push(`${line} (expected 400 or 422)`);
          }
        }
      }
    }
    log(`Negative and boundary tests: ${tried} cases on ${targets.length} endpoints`);

    const extra: string[] = [];
    const sample = calls.find((c) => ok(c) && c.op.method === "GET");
    if (sample) {
      // An invalid token must be refused (401), not crash the server, and never let the caller in.
      if (sample.op.secured && authenticated) {
        tried++;
        const r = await send({ url: where(sample), method: "GET", headers: { Authorization: "Bearer glv.invalid.token" }, as: false }, sample.op);
        if (r.status !== null && r.status >= 500) {
          failed++;
          crash.push(`GET ${sample.op.path} with an invalid token: HTTP ${r.status}`);
        } else if (r.status !== null && r.status < 300) {
          failed++;
          extra.push(`GET ${sample.op.path} with the made-up token "glv.invalid.token": HTTP ${r.status}`);
        }
      }
      // A parameter the API does not know: ignored or refused, never a crash.
      tried++;
      const u = new URL(where(sample));
      u.searchParams.set("glv_unknown", "1");
      const unk = await send({ url: u.toString(), method: "GET" }, sample.op);
      if (unk.status !== null && unk.status >= 500) {
        failed++;
        crash.push(`GET ${sample.op.path} with an unknown parameter: HTTP ${unk.status}`);
      }
      // An Accept header it does not offer: 406, or its normal JSON, never a crash.
      tried++;
      const acc = await send({ url: where(sample), method: "GET", headers: { Accept: "application/x-glv-unknown" } }, sample.op);
      if (acc.status !== null && acc.status >= 500) {
        failed++;
        crash.push(`GET ${sample.op.path} with Accept: application/x-glv-unknown: HTTP ${acc.status}`);
      }
    }
    countCases(tried, failed);

    const out: Finding[] = [];
    const at = targets[0] ? where(targets[0]) : sample ? where(sample) : "";
    if (crash.length) out.push(finding({ category: "functional", rule: "api:negative-crash", severity: "high", title: "Wrong or edge values crash the API (HTTP 5xx)", detail: "A value of the wrong kind, or at the edge of what is allowed, made the server fail instead of answering with a 400 error. Every such crash is an unhandled exception: validate parameters first (a schema validator such as Zod, Joi, Pydantic or Laravel's validate) and return 400 with a message saying which parameter is wrong.", pageUrl: at, evidence: list(crash), count: crash.length }));
    if (leaks.length) out.push(finding({ category: "security", rule: "api:negative-leak", severity: "high", title: "Wrong values make the API show database errors or code", detail: `Unexpected input made the answer show internal details (${leakSnippet.slice(0, 80)}...). This also hints that the value reaches a database query unchecked: check for SQL injection, use parameterised queries, and turn off debug output.`, pageUrl: at, evidence: list(leaks), count: leaks.length }));
    if (accepted.length) out.push(finding({ category: "functional", rule: "api:invalid-input-accepted", severity: "medium", title: "The API accepts values its own documentation forbids", detail: "A required parameter left out, a word for a number, or a value outside the documented minimum, maximum or list was answered with success. Callers never learn they sent a mistake, and wrong data can reach the database. Check every parameter against the API file and answer 400 or 422.", pageUrl: at, evidence: list(accepted), count: accepted.length }));
    if (extra.length) out.push(finding({ category: "security", rule: "api:invalid-token-accepted", severity: "critical", title: "The API accepts a made-up login token", detail: "A call with a token that was never issued got data back. Anyone can call the API by sending any token: check the token's signature and expiry on every request (and refuse unknown tokens with 401).", pageUrl: sample ? where(sample) : at, evidence: list(extra) }));
    const kinds = new Set([...errorTypes.keys()].map((k) => k.split(" ").slice(1).join(" ")));
    if (kinds.size > 1 && [...kinds].some((k) => /json/.test(k)) && [...kinds].some((k) => /html|plain|no type/.test(k))) {
      out.push(finding({ category: "functional", rule: "api:inconsistent-errors", severity: "low", title: "Errors come back in different formats", detail: "Some errors are JSON and others are web pages or plain text, so client apps cannot read the error message reliably and show \"Something went wrong\". Return every error as JSON in one format (RFC 9457 problem details: type, title, status, detail).", pageUrl: at, evidence: list([...errorTypes].map(([k, v]) => `${k}: ${v}`)) }));
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

export const apiHttpAgent: ApiAgent = {
  ...base,
  id: "api.http",
  name: "HTTP behaviour and repeat calls",
  description:
    "Checks the API behaves the way HTTP clients, proxies and caches expect: HEAD answers like GET without a body, OPTIONS lists the allowed methods, a repeated GET returns the same answer (idempotent), five calls at the same moment all succeed with the same answer (concurrency), an ETag or Last-Modified is honoured with 304 Not Modified, and signed-in answers are not cached by shared caches.",
  category: "functional",
  async run({ calls, send, authenticated }) {
    const sample = calls.filter((c) => ok(c) && c.op.method === "GET").slice(0, 4);
    if (!sample.length) return [];
    const problems: Record<string, string[]> = {};
    const add = (rule: string, line: string) => (problems[rule] ??= []).push(line);
    let tried = 0;
    let failed = 0;
    const fail = (rule: string, line: string) => {
      failed++;
      add(rule, line);
    };
    const stable = (t: string) => t.replace(/"(timestamp|time|now|date|requestId|request_id|traceId|generated_at|serverTime)"\s*:\s*("[^"]*"|\d+)/gi, "");
    for (const c of sample) {
      const url = where(c);
      const name = `GET ${c.op.path}`;
      // HEAD: same status, no body.
      tried++;
      const head = await send({ url, method: "HEAD" }, c.op);
      if (head.status !== null && head.status >= 500) fail("api:head-broken", `HEAD ${c.op.path}: HTTP ${head.status} (GET gives ${c.status})`);
      else if (head.status !== null && head.status !== c.status && head.status !== 405) fail("api:head-broken", `HEAD ${c.op.path}: HTTP ${head.status} (GET gives ${c.status})`);
      else if (head.status !== null && head.status < 300 && head.text.length > 0) fail("api:head-broken", `HEAD ${c.op.path}: sent a ${head.text.length}-byte body`);
      // Repeated GET: same answer.
      tried++;
      const again = await send({ url, method: "GET" }, c.op);
      if (again.status !== c.status) fail("api:not-idempotent", `${name}: HTTP ${c.status}, then HTTP ${again.status}`);
      else if (c.text.length < 200_000 && stable(again.text) !== stable(c.text) && Math.abs(again.text.length - c.text.length) > Math.max(50, c.text.length * 0.2)) fail("api:not-idempotent", `${name}: ${c.text.length} bytes, then ${again.text.length} bytes`);
      // Five at once.
      tried++;
      const many = await Promise.all(Array.from({ length: 5 }, () => send({ url, method: "GET" }, c.op)));
      const bad = many.filter((m) => m.status === null || m.status >= 500 || m.status !== c.status);
      if (bad.length) fail("api:concurrency", `${name}: ${bad.length} of 5 simultaneous calls answered ${[...new Set(bad.map((b) => (b.status === null ? "nothing" : `HTTP ${b.status}`)))].join(", ")}`);
      // Conditional request.
      const etag = c.headers["etag"];
      const modified = c.headers["last-modified"];
      if (etag || modified) {
        tried++;
        const cond = await send({ url, method: "GET", headers: etag ? { "If-None-Match": etag } : { "If-Modified-Since": modified! } }, c.op);
        if (cond.status !== null && cond.status >= 500) fail("api:conditional-broken", `${name} with ${etag ? "If-None-Match" : "If-Modified-Since"}: HTTP ${cond.status}`);
        else if (cond.status === 200) fail("api:no-304", `${name}: ${etag ? "ETag" : "Last-Modified"} sent, but the same request answers 200 with the whole body`);
      }
      // Signed-in answers kept out of shared caches.
      if (authenticated && c.op.secured) {
        tried++;
        const cc = (c.headers["cache-control"] ?? "").toLowerCase();
        if (/public|s-maxage/.test(cc) && !/private|no-store/.test(cc)) fail("api:private-cached", `${name}: Cache-Control: ${cc}`);
      }
    }
    // OPTIONS on the first endpoint: lists what is allowed, never a crash.
    tried++;
    const opt = await send({ url: where(sample[0]), method: "OPTIONS" }, sample[0].op);
    if (opt.status !== null && opt.status >= 500) fail("api:options-broken", `OPTIONS ${sample[0].op.path}: HTTP ${opt.status}`);
    countCases(tried, failed);
    const RULES: Record<string, { severity: Finding["severity"]; title: string; detail: string; category?: Finding["category"] }> = {
      "api:head-broken": { severity: "low", title: "HEAD requests do not behave like GET", detail: "HEAD must answer with the same status and headers as GET and no body. Monitoring tools, CDNs and link checkers use HEAD, so a wrong answer makes them report the API as down. Most frameworks do this for you when the GET route is registered normally." },
      "api:not-idempotent": { severity: "medium", title: "The same request gives a different answer straight away", detail: "Two identical GET calls a moment apart came back with a different status or a very different body. GET must not change anything (it is retried by browsers, proxies and mobile apps), and a reading endpoint whose answer flips points to caching or replication problems." },
      "api:concurrency": { severity: "high", title: "Calls made at the same moment fail", detail: "Of five identical calls sent together, some failed or answered differently. Under real traffic this shows up as random errors: look for shared state, a too-small database connection pool, or a worker limit." },
      "api:conditional-broken": { severity: "medium", title: "Conditional requests crash the API", detail: "A request with If-None-Match or If-Modified-Since (sent by browsers and HTTP clients when they have a copy) made the server fail." },
      "api:no-304": { severity: "low", title: "The API sends an ETag but never answers 304", detail: "Clients that send the ETag back still get the whole body, so the ETag only costs work. Answer 304 Not Modified when it matches (most frameworks have middleware for this), or stop sending it." },
      "api:private-cached": { severity: "high", title: "Signed-in answers may be kept by shared caches", detail: "An answer that needs a login is marked public, so a CDN or company proxy may keep it and hand one user's data to another. Send Cache-Control: private, no-store on answers that depend on the login.", category: "security" },
      "api:options-broken": { severity: "low", title: "OPTIONS requests crash the API", detail: "Browsers send OPTIONS before cross-site calls (CORS preflight). A server error here breaks every web app that calls the API from another domain." },
    };
    return Object.entries(problems).map(([rule, lines]) =>
      finding({ category: RULES[rule].category ?? "functional", rule, severity: RULES[rule].severity, title: RULES[rule].title, detail: RULES[rule].detail, pageUrl: where(sample[0]), evidence: list(lines), count: lines.length }),
    );
  },
};

/* ---------------------------------------------------------------------------------------------- */

const VERSION_IN_PATH = /\/v(\d+)(?=\/|$)/i;

export const apiVersionsAgent: ApiAgent = {
  ...base,
  id: "api.versions",
  name: "API versions",
  description:
    "Finds the API's version (/v2/ in the address) and asks the same endpoints on the older versions: an old version that still answers should say it is going away (Deprecation and Sunset headers). Endpoints the API file marks deprecated should say so in their answers too.",
  category: "functional",
  async run({ calls, send, parsed }) {
    const out: Finding[] = [];
    let tried = 0;
    let failed = 0;
    const quiet: string[] = [];
    const sample = calls.filter((c) => ok(c) && c.op.method === "GET" && VERSION_IN_PATH.test(new URL(where(c)).pathname)).slice(0, 3);
    for (const c of sample) {
      const u = new URL(where(c));
      const v = Number(VERSION_IN_PATH.exec(u.pathname)![1]);
      for (let old = v - 1; old >= Math.max(0, v - 2); old--) {
        const o = new URL(u);
        o.pathname = u.pathname.replace(VERSION_IN_PATH, `/v${old}`);
        tried++;
        const r = await send({ url: o.toString(), method: "GET" }, c.op);
        if (r.status !== null && r.status >= 200 && r.status < 300) {
          if (!r.headers["deprecation"] && !r.headers["sunset"]) {
            failed++;
            quiet.push(`GET ${o.pathname}: answers, with no Deprecation or Sunset header`);
          }
        }
      }
    }
    const deprecated = calls.filter((c) => c.op.deprecated && ok(c));
    const silent = deprecated.filter((c) => !c.headers["deprecation"] && !c.headers["sunset"]);
    tried += deprecated.length;
    failed += silent.length;
    countCases(tried, failed);
    if (quiet.length) out.push(finding({ category: "functional", rule: "api:old-version-silent", severity: "low", title: "Older API versions still answer without saying they are retired", detail: "The previous version of these endpoints still works, so old apps keep using it, but nothing tells them it will stop. Send Deprecation and Sunset headers (RFC 9745 and RFC 8594) with a date, and a Link to the migration guide; old versions also tend to miss security fixes.", pageUrl: parsed.baseUrl, evidence: list(quiet) }));
    if (silent.length) out.push(finding({ category: "functional", rule: "api:deprecated-silent", severity: "low", title: "Deprecated endpoints do not say so in their answers", detail: "The API file marks these endpoints deprecated, but their answers carry no Deprecation or Sunset header, so client developers who never reread the file are not warned before they are removed.", pageUrl: parsed.baseUrl, evidence: list(silent.map((c) => `GET ${c.op.path}`)) }));
    return out;
  },
};

/** The API agents added for the testing handbook. */
export const HANDBOOK_API_AGENTS = [apiNegativeAgent, apiHttpAgent, apiVersionsAgent];
