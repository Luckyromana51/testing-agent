import { randomBytes } from "node:crypto";
import { isJsonType, validateSchema, type ApiOperation, type Json } from "../../engines/openapi.js";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { EngineAgent } from "../types.js";
import type { ApiCall, ApiContext } from "./context.js";
import { apiAccessAgent } from "./access.js";
import { apiChangesAgent } from "./changes.js";
import { apiAuditAgent } from "./lint.js";
import { apiOwaspAgent } from "./owasp.js";
import { apiScenariosAgent } from "./scenarios.js";
import { apiTokensAgent } from "./tokens.js";
import { apiWritesAgent } from "./writes.js";

import { documentedResponse, type ApiAgent } from "./shared.js";
export { documentedResponse, type ApiAgent };

const ok = (c: ApiCall) => c.status !== null && c.status >= 200 && c.status < 300;
const label = (c: ApiCall) => `GET ${c.op.path}`;


const base = { engine: "api" as const, products: ["api" as const] };

/* ---------------------------------------------------------------------------------------------- */

export const apiAvailabilityAgent: ApiAgent = {
  ...base,
  id: "api.availability",
  name: "Endpoint health",
  description: "Calls every read-only endpoint and reports ones that fail, are missing or are slow.",
  category: "functional",
  run({ calls, parsed }) {
    const out: Finding[] = [];
    if (calls.length && calls.every((c) => c.status === null)) {
      return [
        finding({
          category: "functional",
          rule: "api:down",
          severity: "critical",
          title: "The API does not answer",
          detail: `None of the ${calls.length} endpoints answered. Check the server is running and the base address (${parsed.baseUrl}) is right.`,
          pageUrl: parsed.baseUrl,
          evidence: calls[0].error,
        }),
      ];
    }
    const undocumented: ApiCall[] = [];
    for (const c of calls) {
      const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string, category: Finding["category"] = "functional") =>
        out.push(finding({ category, rule, severity, title, detail, pageUrl: c.op.url, evidence }));
      if (c.status === null) {
        add("api:no-answer", "high", "Endpoint does not answer", `${label(c)} gave no answer within 20 seconds, or the connection failed.`, c.error);
        continue;
      }
      if (c.status >= 500) {
        add(
          "api:server-error",
          "high",
          "Endpoint fails with a server error",
          `${label(c)} answered HTTP ${c.status} even after a retry. The server log at the time of the test shows the cause.`,
          `HTTP ${c.status}`,
        );
      } else if (c.status === 404 && !c.op.path.includes("{") && !c.op.responses["404"]) {
        add(
          "api:missing-endpoint",
          "medium",
          "Documented endpoint is missing",
          `The API file lists ${label(c)}, but the server answers 404 Not Found. Either the route was removed or renamed, or the file is out of date.`,
          "HTTP 404",
        );
      } else if ((c.status === 401 || c.status === 403) && !c.op.secured) {
        undocumented.push(c);
      } else if (c.status === 429) {
        add("api:rate-limited", "info", "Rate limited during the test", `${label(c)} still answered 429 Too Many Requests after a pause.`, "HTTP 429");
      }
      if (c.status < 400 && c.ms > 1000) {
        add(
          "api:slow",
          c.ms > 3000 ? "medium" : "low",
          "Slow endpoint",
          `${label(c)} took ${(c.ms / 1000).toFixed(1)} s (the faster of two calls). Aim for under 1 second: add a database index, cache the result, or page long lists.`,
          `${c.ms} ms`,
          "performance",
        );
      }
    }
    // One missing security note in the API file is one problem, however many endpoints it covers.
    if (undocumented.length) {
      const c = undocumented[0];
      const many = undocumented.length > 1;
      out.push(
        finding({
          category: "functional",
          rule: "api:undocumented-auth",
          severity: "low",
          title: many ? `${undocumented.length} endpoints need a login the API file does not mention` : "Endpoint needs a login the API file does not mention",
          detail: many
            ? `${undocumented.length} endpoints answered ${c.status}, but the API file marks them as public. Add a security requirement to the file (once at the top covers every endpoint) so client developers know.`
            : `${label(c)} answered ${c.status}, but the API file marks it as public. Add the security requirement to the file so client developers know.`,
          pageUrl: many ? parsed.baseUrl : c.op.url,
          evidence: undocumented
            .slice(0, 10)
            .map((u) => `${label(u)}: HTTP ${u.status}`)
            .join("\n"),
        }),
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

export const apiContractAgent: ApiAgent = {
  ...base,
  id: "api.contract",
  name: "Response format",
  description: "Checks each answer matches the API file: status codes, JSON and the documented fields.",
  category: "functional",
  run({ calls, spec }) {
    const out: Finding[] = [];
    for (const c of calls) {
      if (!ok(c)) continue;
      const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string) =>
        out.push(finding({ category: "functional", rule, severity, title, detail, pageUrl: c.op.url, evidence }));
      const doc = documentedResponse(c.op, c.status!);
      const documented = Object.keys(c.op.responses);
      if (!doc && documented.length) {
        add(
          "api:undocumented-status",
          "low",
          "Endpoint answers with a status the API file does not list",
          `${label(c)} answered ${c.status}, but the file only lists ${documented.join(", ")}.`,
          `HTTP ${c.status}`,
        );
      }
      if (c.jsonError) {
        add("api:invalid-json", "high", "Endpoint returns broken JSON", `${label(c)} says it sends JSON, but the body does not parse. Apps reading it will crash.`, c.jsonError);
        continue;
      }
      const wantsJson = isJsonType(doc?.contentType);
      if (wantsJson && c.json === undefined && c.text.trim()) {
        const html = /text\/html/i.test(c.contentType) || /^\s*<(!doctype|html)/i.test(c.text);
        add(
          "api:not-json",
          "medium",
          "Endpoint does not return JSON",
          html
            ? `${label(c)} sent a web page instead of JSON. Often a website catch-all route answers before the API does, so the endpoint does not really exist.`
            : `${label(c)} should send JSON, but sent ${c.contentType || "no content type"}.`,
          `Content-Type: ${c.contentType || "none"}`,
        );
        continue;
      }
      if (c.json !== undefined && !isJsonType(c.contentType)) {
        add(
          "api:json-content-type",
          "low",
          "JSON is sent with the wrong content type",
          `${label(c)} sends JSON with Content-Type "${c.contentType || "none"}". Some clients will not parse it. Send application/json.`,
          `Content-Type: ${c.contentType || "none"}`,
        );
      }
      if (doc?.schema && c.json !== undefined) {
        const extra: string[] = [];
        const problems = validateSchema(spec, doc.schema, c.json, "$", [], 0, { extra });
        if (problems.length) {
          add(
            "api:schema-mismatch",
            "medium",
            "Response does not match the API file",
            `${label(c)} sends data in a different shape from the one documented (types, formats like email or date-time, lengths, ranges, patterns and required fields are all checked). Apps built from the file will break on these fields.`,
            problems.slice(0, 3).join("; "),
          );
        }
        const fields = [...new Set(extra.map((e) => e.replace(/\[\d+\]/g, "[]")))].sort();
        if (fields.length) {
          add(
            "api:undocumented-fields",
            "low",
            "Answer has fields the API file does not list",
            `${label(c)} sends ${fields.length} field${fields.length === 1 ? "" : "s"} the file does not mention. Either the file is out of date, or the endpoint sends more than clients need (often whole database rows: OWASP API3). Send only the documented fields.`,
            fields.slice(0, 6).join(", "),
          );
        }
      }
      for (const h of doc?.headers ?? []) {
        if (c.headers[h] === undefined) add("api:missing-header", "low", "A header the API file promises is not sent", `${label(c)} should send the ${h} header (it is in the file), but it did not.`, `missing: ${h}`);
      }
      if (c.op.deprecated && !c.headers.deprecation && !c.headers.sunset) {
        add(
          "api:deprecated-no-warning",
          "low",
          "A deprecated endpoint gives clients no warning",
          `The file marks ${label(c)} as deprecated, and it still answers, but without a Deprecation or Sunset header. Apps that still use it get no notice before it goes. Send Deprecation: true and Sunset: <date>.`,
          "no Deprecation or Sunset header",
        );
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const REFUSAL = /unauthori[sz]ed|unauthenticated|not authenticated|forbidden|access denied|invalid (api[ -]?key|token)|missing (api[ -]?key|token|credentials)|login required|please log ?in|token (is )?required/i;
const PUBLIC_BY_NATURE = /\/(health|healthz|status|ping|version|ready|readyz|live|livez)$/i;

/** True when the body holds data: a non-empty list or an object with fields. */
function hasData(c: ApiCall): boolean {
  if (c.json === undefined) return c.text.trim().length > 0;
  if (Array.isArray(c.json)) return c.json.length > 0;
  if (c.json && typeof c.json === "object") {
    const values = Object.values(c.json);
    return values.some((v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== "" && v !== false));
  }
  return c.json !== null && c.json !== "";
}

export const apiAuthAgent: ApiAgent = {
  ...base,
  id: "api.auth",
  name: "Login protection",
  description: "Calls endpoints that need a login without one, to find data anyone can read.",
  category: "security",
  run({ anonymous, parsed, specUrl }) {
    const out: Finding[] = [];
    for (const c of anonymous) {
      if (!c.op.secured || !ok(c)) continue;
      const add = (rule: string, severity: Finding["severity"], title: string, detail: string, category: Finding["category"] = "security") =>
        out.push(finding({ category, rule, severity, title, detail, pageUrl: c.op.url, evidence: `HTTP ${c.status} without credentials` }));
      if (REFUSAL.test(c.text.slice(0, 2000))) {
        add(
          "api:refusal-200",
          "medium",
          "Login error sent with a success status",
          `${label(c)} refuses the request in its message but answers ${c.status} OK. Answer 401 so apps and monitoring can tell it failed.`,
          "functional",
        );
      } else if (PUBLIC_BY_NATURE.test(c.op.path)) {
        add(
          "api:public-marked-secured",
          "low",
          "Public endpoint marked as needing login",
          `${label(c)} answers without a login, which is normal for a health check, but the API file says it needs one. Mark it public in the file (security: []).`,
          "functional",
        );
      } else {
        const data = hasData(c);
        add(
          "api:auth-bypass",
          data ? "critical" : "high",
          "Endpoint that needs a login answers without one",
          data
            ? `${label(c)} is marked as needing a login, but it sent data to a request with no credentials. Anyone on the internet can read it. Check the auth middleware covers this route.`
            : `${label(c)} is marked as needing a login, but it answered ${c.status} to a request with no credentials (with no data this time). Check the auth middleware covers this route.`,
        );
      }
    }
    if (!parsed.hasSecuritySchemes) {
      out.push(
        finding({
          category: "security",
          rule: "api:no-auth-described",
          severity: parsed.writeOperations ? "medium" : "info",
          title: "The API file describes no login",
          detail: parsed.writeOperations
            ? `The file has ${parsed.writeOperations} operations that change data but no security section. Either the file is incomplete, or anyone can change data: check which, and document the login (securitySchemes).`
            : "The file has no security section. That is fine for a fully public API; otherwise document how clients log in (securitySchemes).",
          pageUrl: specUrl,
        }),
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const SECRET_KEY =
  /^(password|passwd|pwd|password_?hash|hashed_?password|secret|client_?secret|api_?key|apikey|access_?token|refresh_?token|private_?key|aws_?secret_?access_?key|card_?number|cvv|otp)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Walks JSON and reports secret-looking fields and the e-mail addresses it holds. */
function inspect(value: Json, path = "$", acc = { secrets: [] as string[], emails: new Set<string>(), nodes: 0 }) {
  if (acc.nodes++ > 2000 || value === null || typeof value !== "object") return acc;
  if (Array.isArray(value)) {
    value.slice(0, 50).forEach((v, i) => inspect(v, `${path}[${i}]`, acc));
    return acc;
  }
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k) && typeof v === "string" && v.length >= 4 && !/^[*•x.\-]+$/i.test(v)) acc.secrets.push(`${path}.${k}`);
    if (typeof v === "string" && EMAIL.test(v)) acc.emails.add(v.toLowerCase());
    if (v && typeof v === "object") inspect(v, `${path}.${k}`, acc);
  }
  return acc;
}

export const apiExposureAgent: ApiAgent = {
  ...base,
  id: "api.exposure",
  name: "Data exposure",
  description: "Looks inside answers for passwords, tokens and lists of personal e-mail addresses.",
  category: "security",
  run({ calls, anonymous }) {
    const out: Finding[] = [];
    for (const c of calls) {
      if (!ok(c) || c.json === undefined) continue;
      const found = inspect(c.json);
      if (found.secrets.length) {
        out.push(
          finding({
            category: "security",
            rule: "api:secret-in-response",
            severity: "high",
            title: "Answer contains passwords or secret keys",
            detail: `${label(c)} sends fields that look like passwords, password hashes or keys. Remove them from the answer: they should never leave the server.`,
            pageUrl: c.op.url,
            evidence: [...new Set(found.secrets.map((s) => s.replace(/\[\d+\]/g, "[]")))].slice(0, 5).join(", "),
          }),
        );
      }
    }
    // Personal data only counts as exposed when it came back to a request with no login.
    for (const c of anonymous) {
      if (!ok(c) || c.json === undefined) continue;
      const found = inspect(c.json);
      if (found.emails.size >= 3) {
        out.push(
          finding({
            category: "security",
            rule: "api:personal-data-public",
            severity: c.op.secured ? "high" : "medium",
            title: "Personal data can be read without a login",
            detail: `${label(c)} sent ${found.emails.size} different e-mail addresses to a request with no credentials. If these are customers or staff, put the endpoint behind a login (and check your data protection duties under the DPDP Act and GDPR).`,
            pageUrl: c.op.url,
            evidence: `${found.emails.size} e-mail addresses, such as ${[...found.emails][0].replace(/^(.).*@/, "$1***@")}`,
          }),
        );
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const LEAKS: { re: RegExp; what: string }[] = [
  { re: /SQLSTATE\[|You have an error in your SQL syntax|\bORA-\d{5}\b|PG::\w+Error|psycopg2\.|SQLITE_ERROR|Unclosed quotation mark|invalid input syntax for (type )?\w+|mysqli?_\w+\(\)/i, what: "a database error" },
  { re: /Werkzeug Debugger|Whoops! There was an error|Illuminate\\|Symfony\\Component\\|ActiveRecord::\w+|django\.(core|db)\./, what: "a framework debug page" },
  { re: /Traceback \(most recent call last\)/, what: "a Python traceback" },
  { re: /(Fatal error|Parse error|Warning|Notice|Uncaught \w+):? .{0,200} in \/[\w./-]+(?: on line |:)\d+/, what: "a PHP error with a file path" },
  { re: /Stack trace:\s*#0/, what: "a PHP stack trace" },
  { re: /System\.\w+Exception|\bat [\w.]+\(.*\) in [\w:\\/.]+:line \d+/, what: "a .NET exception" },
  { re: /\bat [\w.$]+\([\w$]+\.java:\d+\)/, what: "a Java stack trace" },
  { re: /\bat [\w.<>$\s]+\(?(?:file:\/\/)?[\w./\\:@-]+\.(?:js|ts|mjs|cjs):\d+:\d+\)?/, what: "a Node.js stack trace" },
];

export function findLeak(text: string): { what: string; snippet: string } | null {
  const sample = text.slice(0, 50_000);
  for (const { re, what } of LEAKS) {
    const m = re.exec(sample);
    if (m) {
      return { what, snippet: sample.slice(m.index, m.index + 160).split("\n").slice(0, 2).join(" ").replace(/\s+/g, " ").trim() };
    }
  }
  return null;
}

export const apiErrorsAgent: ApiAgent = {
  ...base,
  id: "api.errors",
  name: "Error handling",
  description: "Asks for a missing address and wrong-type ids, and checks errors do not show code, paths or SQL.",
  category: "security",
  async run({ calls, parsed, call }) {
    const out: Finding[] = [];
    const leak = (c: ApiCall, how: string, pageUrl = c.op.url) => {
      const l = findLeak(c.text);
      if (!l) return false;
      out.push(
        finding({
          category: "security",
          rule: "api:error-leak",
          severity: "high",
          title: "Error messages show internal details",
          detail: `${how} the answer contains ${l.what}. Attackers use file paths, versions and queries to plan an attack. Return a short error message and log the details on the server instead (turn off debug mode in production).`,
          pageUrl,
          evidence: l.snippet,
        }),
      );
      return true;
    };
    for (const c of calls) leak(c, `When calling ${label(c)},`);

    // An address that does not exist: should be a plain 404.
    const missing: ApiOperation = {
      method: "GET",
      path: "/glv-missing-route",
      url: `${parsed.baseUrl}/glv-missing-${randomBytes(4).toString("hex")}`,
      title: "Missing address",
      secured: false,
      responses: {},
    };
    const m = await call(missing);
    if (m.status !== null) {
      if (!leak(m, `For an address that does not exist (${m.op.url}),`, parsed.baseUrl) && m.status >= 500) {
        out.push(
          finding({
            category: "functional",
            rule: "api:bad-input-crash",
            severity: "medium",
            title: "Server crashes on unexpected input",
            detail: `An address that does not exist got HTTP ${m.status} instead of 404. The error handling does not cover unknown routes.`,
            pageUrl: parsed.baseUrl,
            evidence: `GET ${m.op.url} -> HTTP ${m.status}`,
          }),
        );
      }
    }

    // Ids of the wrong type (a word where a number goes): should be 400 or 404, never a crash.
    const withIds = calls.filter((c) => c.status !== null && c.status < 500 && c.op.path.includes("{")).slice(0, 5);
    for (const c of withIds) {
      const url = c.op.path.replace(/\{[^}]+\}/g, "glv-test");
      const probe = await call({ ...c.op, url: `${parsed.baseUrl}${url}` });
      if (probe.status === null) continue;
      if (leak(probe, `When ${label(c)} was given an id that is not valid ("glv-test"),`, c.op.url)) continue;
      if (probe.status >= 500) {
        out.push(
          finding({
            category: "functional",
            rule: "api:bad-input-crash",
            severity: "medium",
            title: "Server crashes on unexpected input",
            detail: `${label(c)} answers HTTP ${probe.status} when the id is not valid. Check the input first and answer 400 Bad Request or 404 Not Found.`,
            pageUrl: c.op.url,
            evidence: `GET ${probe.op.url} -> HTTP ${probe.status}`,
          }),
        );
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

export const apiTransportAgent: ApiAgent = {
  ...base,
  id: "api.transport",
  name: "HTTPS, CORS and headers",
  description: "Checks the API uses HTTPS, does not let any website read it with the user's login, and hides server versions.",
  category: "security",
  async run({ calls, parsed, call }) {
    const out: Finding[] = [];
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string) =>
      out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: parsed.baseUrl, evidence }));
    if (parsed.baseUrl.startsWith("http://")) {
      add(
        "api:no-https",
        "critical",
        "The API is not on HTTPS",
        "Every request, including logins and tokens, travels unencrypted. Serve the API over HTTPS only.",
        parsed.baseUrl,
      );
    }
    const sample = calls.find((c) => c.status !== null && c.status < 500);
    if (!sample) return out;
    const h = sample.headers;
    if (parsed.baseUrl.startsWith("https://") && !h["strict-transport-security"]) {
      add("api:hsts-missing", "low", "Missing Strict-Transport-Security header", "Tell clients to always use HTTPS: Strict-Transport-Security: max-age=31536000; includeSubDomains");
    }
    if (!/nosniff/i.test(h["x-content-type-options"] ?? "")) {
      add("api:nosniff-missing", "low", "Missing X-Content-Type-Options header", "Send X-Content-Type-Options: nosniff so browsers never treat an answer as a script or page.");
    }
    const server = h["server"] ?? "";
    const powered = h["x-powered-by"] ?? "";
    if (/\d+\.\d+/.test(server) || powered) {
      add(
        "api:version-disclosure",
        "low",
        "The server tells everyone its software and version",
        "Attackers look up known holes for that version. Hide the Server version and remove X-Powered-By.",
        [server && `Server: ${server}`, powered && `X-Powered-By: ${powered}`].filter(Boolean).join("; "),
      );
    }

    // CORS: does the API let any website read answers with the visitor's cookies?
    const evil = "https://glv-cors-check.example";
    const probe = await call(sample.op, { origin: evil });
    const allowOrigin = probe.headers["access-control-allow-origin"];
    const allowCreds = probe.headers["access-control-allow-credentials"] === "true";
    if (allowCreds && (allowOrigin === evil || allowOrigin === "null")) {
      add(
        "api:cors-reflect",
        "high",
        "Any website can read this API with the visitor's login (CORS)",
        "The API copies back whatever Origin it is sent and allows credentials, so a page on any site can call it as the logged-in user and read the answer. Allow only your own front-end addresses.",
        `Origin: ${evil} -> Access-Control-Allow-Origin: ${allowOrigin}, Allow-Credentials: true`,
      );
    } else if (allowCreds && allowOrigin === "*") {
      add(
        "api:cors-invalid",
        "low",
        "CORS setting is invalid",
        'Browsers refuse "Access-Control-Allow-Origin: *" together with credentials, so logged-in calls from your front end fail. List your front-end addresses instead.',
        "Access-Control-Allow-Origin: *, Allow-Credentials: true",
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

export const apiSpecAgent: ApiAgent = {
  ...base,
  id: "api.spec",
  name: "API file quality",
  description: "Checks the OpenAPI file itself: servers, operation ids and documented responses.",
  category: "functional",
  run({ spec, parsed, specUrl }) {
    const out: Finding[] = [];
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string) =>
      out.push(finding({ category: "functional", rule, severity, title, detail, pageUrl: specUrl, evidence }));
    for (const w of parsed.warnings) add("api:spec-no-servers", "low", "The API file lists no server address", w);
    const ids = new Map<string, number>();
    const noResponses: string[] = [];
    for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        const op = item?.[method];
        if (!op) continue;
        if (op.operationId) ids.set(op.operationId, (ids.get(op.operationId) ?? 0) + 1);
        if (!op.responses || !Object.keys(op.responses).length) noResponses.push(`${method.toUpperCase()} ${path}`);
      }
    }
    const dupes = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
    if (dupes.length) {
      add(
        "api:spec-duplicate-id",
        "low",
        "Two operations share one operationId",
        "Code generators make one function per operationId, so clients built from this file will not compile. Give each operation its own id.",
        dupes.slice(0, 5).join(", "),
      );
    }
    if (noResponses.length) {
      add(
        "api:spec-no-responses",
        "low",
        "Operations without documented answers",
        `${noResponses.length} operations do not say what they return, so clients have to guess.`,
        noResponses.slice(0, 5).join(", "),
      );
    }
    if (!parsed.operations.length) {
      add("api:spec-no-get", "info", "Nothing to call", "The file has no read-only (GET) endpoints, so only the file itself was checked.");
    }
    return out;
  },
};

/** Every agent of the API engine, in the order they run. Writes come last: everything else only reads. */
export const API_AGENTS: ApiAgent[] = [
  apiAvailabilityAgent,
  apiContractAgent,
  apiAuthAgent,
  apiExposureAgent,
  apiErrorsAgent,
  apiTransportAgent,
  apiSpecAgent,
  apiAuditAgent,
  apiOwaspAgent,
  apiTokensAgent,
  apiChangesAgent,
  apiAccessAgent,
  apiScenariosAgent,
  apiWritesAgent,
];
