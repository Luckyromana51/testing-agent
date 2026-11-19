import { request as playwrightRequest, type APIRequestContext } from "playwright";
import type { ApiCall, ApiContext } from "../agents/api/context.js";
import { API_AGENTS } from "../agents/api/index.js";
import { CouldNotTestError, explainLoadError } from "../runner/coverage.js";
import { scoreFindings } from "../runner/score.js";
import { validateTarget } from "../runner/urls.js";
import { redact } from "../vault.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ApiCallView, ApiScenario, Category, Login, PageResult, RoleLogin, ScanResult } from "../types.js";
import { pool, runEngineAgents } from "./agents.js";
import { authParts, resolveAuth, type AuthParts } from "./api-auth.js";
import { callOrder, realIds } from "./api-ids.js";
import { findSpec, readSource } from "./api-source.js";
import { documentedResponse } from "../agents/api/shared.js";
import { fillPath, isJsonType, parseSpec, validateSchema, type ApiOperation, type Json } from "./openapi.js";

/** Most endpoints called in one test, so a huge API cannot run for hours. */
export const MAX_OPERATIONS = 60;
const BODY_LIMIT = 200_000;
const RETRY_STATUSES = [429, 502, 503, 504];
export const API_CATEGORIES: Category[] = ["functional", "security", "performance"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ApiScanOptions {
  /** Address of the OpenAPI or Swagger file. */
  specUrl?: string;
  /** The file's text, when it was uploaded instead: OpenAPI, a Postman collection, a HAR file or cURL commands. */
  specText?: string;
  /** The API's base address, when it differs from the file's "servers" (or to look for the file there). */
  baseUrl?: string;
  /** A GraphQL endpoint, tested instead of a REST API file. */
  graphqlUrl?: string;
  /** The project's saved API login: a bearer token, a key in a header or query parameter, basic, OAuth2 or a sign-in call. */
  auth?: Login;
  /** Other accounts (another user or company, a lower role) for the access grid. */
  roles?: RoleLogin[];
  /** The project is a test server: write endpoints are tested too, and everything made is deleted again. */
  testServer?: boolean;
  /** API tests written in plain words. */
  scenarios?: ApiScenario[];
  /** The approved copy of the API file, to list breaking changes. */
  baseline?: { spec: Json; at: string };
  /** Where this run's copy of the API file is saved (api-spec.json), for the next test and the mock server. */
  artifactsDir?: string;
  agents?: string[];
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export { authParts };

/** Calls timed per endpoint (median and 95% time). API_SAMPLES changes it (1 to 10). */
export function samplesWanted(): number {
  const n = Number(process.env.API_SAMPLES);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 5;
}

/** Adds the query-parameter key at call time only, so it never ends up in the report's addresses. */
function withQuery(url: string, query?: [string, string]): string {
  if (!query) return url;
  const u = new URL(url);
  u.searchParams.set(query[0], query[1]);
  return u.toString();
}

const REFUSALS = [401, 403, 407, 429, 451, 503];

/**
 * When (nearly) every call got no answer, or the very same refusal, the API itself was not tested:
 * a firewall, proxy, rate limit or a dead server is in the way. Says why, or undefined when the
 * calls are worth reporting on.
 */
export function blockedReason(calls: ApiCall[], authenticated: boolean): string | undefined {
  const n = calls.length;
  if (!n) return undefined;
  const most = Math.max(n >= 3 ? 3 : n, Math.ceil(n * 0.8));
  const silent = calls.filter((c) => c.status === null);
  if (silent.length >= most) {
    return `${silent.length} of ${n} endpoints gave no answer. ${explainLoadError(silent[0].error ?? "", silent[0].op.url)}`;
  }
  const same = new Map<string, ApiCall[]>();
  for (const c of calls) {
    if (c.status === null || !REFUSALS.includes(c.status)) continue;
    // Anonymous calls to endpoints documented as needing a login are expected to be refused.
    if ((c.status === 401 || c.status === 403) && c.op.secured && !authenticated) continue;
    const key = `${c.status}|${c.text.slice(0, 500)}`;
    same.set(key, [...(same.get(key) ?? []), c]);
  }
  const top = [...same.values()].sort((a, b) => b.length - a.length)[0];
  if (!top || top.length < most) return undefined;
  const status = top[0].status;
  if (authenticated && (status === 401 || status === 403)) {
    return `${top.length} of ${n} endpoints refused the saved login with the same HTTP ${status}. Check the key or token is right and still valid, then re-test.`;
  }
  return `${top.length} of ${n} endpoints gave the very same HTTP ${status} answer. That usually means a firewall, proxy, rate limit or maintenance page is in front of the API, not a problem in each endpoint. Allow the testing server to reach the API, then re-test.`;
}

type Sent = { method: string; url: string; headers: Record<string, string>; body?: unknown; query?: [string, string] };

/** One request, never throwing: failures come back as status null with the reason. */
async function callOnce(request: APIRequestContext, r: Sent): Promise<Omit<ApiCall, "op">> {
  const started = Date.now();
  try {
    const res = await request.fetch(withQuery(r.url, r.query), {
      method: r.method,
      headers: r.headers,
      ...(r.body !== undefined ? (typeof r.body === "string" ? { data: r.body } : { data: r.body as object }) : {}),
      timeout: 20_000,
      maxRedirects: r.method === "GET" || r.method === "HEAD" ? 3 : 0,
      failOnStatusCode: false,
    });
    const body = await res.body();
    const ms = Date.now() - started;
    const h = res.headers();
    const contentType = h["content-type"] ?? "";
    const text = body.subarray(0, BODY_LIMIT).toString("utf8");
    const out: Omit<ApiCall, "op"> = { status: res.status(), ms, contentType, headers: h, text, bytes: body.length };
    const looksJson = /^\s*[[{]/.test(text);
    if (isJsonType(contentType) || looksJson) {
      try {
        out.json = JSON.parse(text);
      } catch (err) {
        // A cut-off body is our limit, not the API's fault.
        if (isJsonType(contentType) && body.length <= BODY_LIMIT && text.trim()) out.jsonError = (err as Error).message;
      }
    }
    return out;
  } catch (err) {
    return { status: null, ms: Date.now() - started, contentType: "", headers: {}, text: "", error: (err as Error).message.split("\n")[0] };
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};
const p95of = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)];
};

/**
 * Calls one operation: retries once after a short wait on rate limits and gateway errors. A read
 * that answered is timed several more times: the report shows the median and the 95% time, so one
 * slow moment (a cold server, a busy network) does not decide the result.
 */
export async function callOperation(
  request: APIRequestContext,
  op: ApiOperation,
  headers: Record<string, string> = {},
  query?: [string, string],
  more: { url?: string; method?: string; body?: unknown; samples?: number } = {},
): Promise<ApiCall> {
  const method = more.method ?? op.method ?? "GET";
  const url = more.url ?? op.url;
  const sent: Sent = { method, url, headers, body: more.body, query };
  let r = await callOnce(request, sent);
  if (r.status !== null && RETRY_STATUSES.includes(r.status)) {
    await sleep(2000);
    r = await callOnce(request, sent);
  }
  const read = method === "GET" || method === "HEAD";
  const samples = more.samples ?? 2;
  if (read && r.status !== null && r.status < 400 && samples > 1) {
    const times = [r.ms];
    // Two calls are enough when the first was quick: the second only checks it was not luck.
    for (let i = 1; i < samples; i++) {
      const again = await callOnce(request, sent);
      if (again.status === r.status) times.push(again.ms);
      if (more.samples === undefined && r.ms <= 1000) break;
    }
    if (more.samples === undefined) {
      // The old rule for probes: the faster of two.
      r.ms = Math.min(...times);
    } else {
      r.ms = median(times);
      r.p95 = p95of(times);
      r.samples = times.length;
    }
  }
  const sentHeaders = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie)$/i.test(k)));
  const bodyText = more.body === undefined ? undefined : typeof more.body === "string" ? more.body : JSON.stringify(more.body);
  return { op, ...r, ...(url !== op.url ? { url } : {}), sent: { headers: sentHeaders, ...(bodyText !== undefined ? { body: bodyText } : {}) } };
}

async function loadSpecText(request: APIRequestContext, opts: ApiScanOptions, auth: AuthParts, log: (m: string) => void): Promise<{ text: string; foundAt?: string }> {
  if (opts.specText) return { text: opts.specText };
  if (!opts.specUrl) {
    if (!opts.baseUrl) throw new Error("Add the address of the API's OpenAPI (Swagger) file, upload a file, or give the API's base address so the test can look for the file.");
    const found = await findSpec(request, validateTarget(opts.baseUrl), {}, log);
    if (!found) {
      throw new Error(
        "No API file was found at the usual addresses (/openapi.json, /v3/api-docs, /swagger.json and others). Enter the file's address, or upload the file, a Postman collection, a HAR file or cURL commands.",
      );
    }
    return { text: found.text, foundAt: found.url };
  }
  const get = (withAuth: boolean) =>
    request
      .get(withAuth ? withQuery(opts.specUrl!, auth.query) : opts.specUrl!, {
        headers: withAuth ? auth.headers : {},
        timeout: 30_000,
        failOnStatusCode: false,
      })
      .catch((err: Error) => {
        throw new Error(`Could not download the API file: ${err.message.split("\n")[0]}`);
      });
  let res = await get(false);
  // Some APIs keep their file behind the same login as the endpoints.
  if ((res.status() === 401 || res.status() === 403) && opts.auth) res = await get(true);
  if (res.status() >= 400) throw new Error(`The API file at ${opts.specUrl} answered HTTP ${res.status()}.`);
  return { text: await res.text() };
}

const VIEW_BODY = 8000;

/** What the Endpoints tab shows of a call: never the saved login. */
export function callView(c: ApiCall, spec: Json, auth: AuthParts, step?: string): ApiCallView {
  const requestHeaders: Record<string, string> = { accept: "application/json, */*;q=0.5", ...(c.sent?.headers ?? {}) };
  for (const k of Object.keys(auth.headers)) requestHeaders[k] = "[hidden]";
  let problems: string[] | undefined;
  let extra: string[] | undefined;
  if (c.status !== null && c.json !== undefined) {
    const doc = documentedResponse(c.op, c.status);
    if (doc?.schema) {
      const found: string[] = [];
      const p = validateSchema(spec, doc.schema, c.json, "$", [], 0, { extra: found });
      if (p.length) problems = p;
      if (found.length) extra = found;
    }
  }
  if (c.jsonError) problems = [`Broken JSON: ${c.jsonError}`];
  const keep = /^(content-type|content-length|cache-control|etag|last-modified|location|www-authenticate|retry-after|x-ratelimit-[\w-]+|ratelimit[\w-]*|access-control-[\w-]+|strict-transport-security|x-content-type-options|server|x-powered-by|deprecation|sunset|link)$/i;
  return {
    method: c.op.method,
    path: c.op.path,
    url: c.url ?? c.op.url,
    status: c.status,
    ms: c.ms,
    ...(c.p95 !== undefined ? { p95: c.p95, samples: c.samples } : {}),
    bytes: c.bytes ?? c.text.length,
    contentType: c.contentType,
    requestHeaders,
    ...(c.sent?.body !== undefined ? { requestBody: c.sent.body.slice(0, VIEW_BODY) } : {}),
    responseHeaders: Object.fromEntries(Object.entries(c.headers).filter(([k]) => keep.test(k)).sort(([a], [b]) => a.localeCompare(b))),
    body: c.text.slice(0, VIEW_BODY),
    ...(problems ? { problems } : {}),
    ...(extra ? { extra } : {}),
    ...(c.error ? { error: c.error } : {}),
    ...(c.idFrom ? { idFrom: c.idFrom } : {}),
    ...(c.op.guessed?.length && !c.idFrom ? { guessed: c.op.guessed } : {}),
    ...(step ? { step } : {}),
    ...(c.op.deprecated ? { deprecated: true } : {}),
  };
}

/** The token a login sends, for the token checks (bearer, OAuth2 or a sign-in call). */
function tokenOf(parts: AuthParts): string | undefined {
  const a = parts.headers.authorization;
  if (a?.startsWith("Bearer ")) return a.slice(7);
  return parts.secrets?.[0];
}

/**
 * Tests a REST API from its OpenAPI or Swagger file (or a Postman collection, HAR file or cURL
 * commands, or the file found at a common address). On a live API only reads (GET) are sent:
 * operations that change data are counted but never called, unless the project is marked as a
 * test server. With a saved login, the endpoints are called with it, and the ones that need a
 * login are also called without it to check they refuse strangers.
 */
export async function scanApi(opts: ApiScanOptions): Promise<ScanResult> {
  if (opts.graphqlUrl) {
    const { scanGraphql } = await import("./graphql.js");
    return scanGraphql(opts);
  }
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.4 (API test)",
    extraHTTPHeaders: { accept: "application/json, */*;q=0.5" },
  });

  try {
    const resolved = await resolveAuth(request, opts.auth, log);
    let auth = resolved.parts;
    log("Reading the API file");
    const { text, foundAt } = await loadSpecText(request, opts, auth, log);
    let spec: Json;
    let kind: ReturnType<typeof readSource>["kind"];
    try {
      ({ spec, kind } = readSource(text));
    } catch (err) {
      throw new Error(`The API file is not valid JSON or YAML: ${(err as Error).message.split("\n")[0]}`);
    }
    if (kind !== "openapi") log(`Read the ${kind === "postman" ? "Postman collection" : kind === "har" ? "HAR file" : "cURL commands"} as an API file`);
    const specUrl = foundAt ?? opts.specUrl ?? opts.baseUrl ?? "uploaded-file";
    const resolveFrom = foundAt ?? opts.specUrl ?? opts.baseUrl;
    if (!resolveFrom && !/^https?:\/\//.test(String(spec?.servers?.[0]?.url ?? "")) && !spec?.host) {
      throw new Error("The uploaded API file has no full server address. Enter the API's base address.");
    }
    const parsed = parseSpec(spec, resolveFrom ?? "https://invalid.local/", foundAt ? undefined : opts.baseUrl);
    // The file decides where requests go, so it gets the same address rules as anything typed in.
    validateTarget(parsed.baseUrl);
    log(`${parsed.title} (${parsed.version}): ${parsed.operations.length} read-only endpoints, base ${parsed.baseUrl}`);

    // A token that ran out mid-test is fetched again, once.
    let refreshed = false;
    const sendAs = async (input: { method: string; url: string; headers?: Record<string, string>; body?: unknown; as?: false | RoleLogin; samples?: number }, op: ApiOperation): Promise<ApiCall> => {
      let parts: AuthParts = input.as === false ? { headers: {}, label: "" } : input.as ? await roleAuth(input.as) : auth;
      let c = await callOperation(request, op, { ...(input.headers ?? {}), ...parts.headers }, parts.query, { url: input.url, method: input.method, body: input.body, samples: input.samples });
      if (c.status === 401 && input.as === undefined && resolved.refresh && !refreshed) {
        refreshed = true;
        log("The token was refused: getting a new one");
        auth = await resolved.refresh().catch(() => auth);
        parts = auth;
        c = await callOperation(request, op, { ...(input.headers ?? {}), ...parts.headers }, parts.query, { url: input.url, method: input.method, body: input.body, samples: input.samples });
      }
      return c;
    };
    const roleParts = new Map<string, Promise<AuthParts>>();
    const roleAuth = (r: RoleLogin) => {
      if (!roleParts.has(r.id)) roleParts.set(r.id, resolveAuth(request, r.login, log).then((x) => x.parts));
      return roleParts.get(r.id)!;
    };

    const callable = parsed.operations.filter((o) => !o.skip);
    const toCall = callable.slice(0, MAX_OPERATIONS);
    if (opts.auth) log(`Calling the endpoints with the saved login (${auth.label})`);
    const samples = samplesWanted();
    // Lists first, so detail endpoints get real ids from their answers.
    const done = new Map<ApiOperation, ApiCall>();
    let n = 0;
    for (const wave of callOrder(toCall)) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      const so = [...done.values()];
      const got = await pool(wave, 3, async (op) => {
        log(`Calling ${++n}/${toCall.length}: GET ${op.path}`);
        const ids = realIds(op, so);
        const keys = Object.keys(ids);
        const url = keys.length ? fillPath(op, parsed.baseUrl, Object.fromEntries(keys.map((k) => [k, ids[k].value]))) : op.url;
        const c = await sendAs({ method: "GET", url, samples }, op);
        if (keys.length) c.idFrom = keys.map((k) => `${k} from ${ids[k].from}`).join("; ");
        return c;
      });
      wave.forEach((op, i) => done.set(op, got[i]));
    }
    const calls = toCall.map((op) => done.get(op)!);
    const blocked = blockedReason(calls, Boolean(opts.auth));
    if (blocked) throw new CouldNotTestError(`Could not test the API: ${blocked}`);
    let anonymous = calls;
    if (opts.auth) {
      const secured = calls.filter((c) => c.op.secured);
      if (secured.length) log(`Calling ${secured.length} endpoints that need a login without it, to check they refuse`);
      anonymous = await pool(secured, 3, (c) => sendAs({ method: "GET", url: c.url ?? c.op.url, as: false }, c.op));
    }

    const ctx: ApiContext = {
      spec,
      parsed,
      specUrl,
      calls,
      anonymous,
      authenticated: Boolean(opts.auth),
      login: opts.auth,
      token: tokenOf(auth),
      authLabel: auth.label,
      request,
      call: (op, headers) => callOperation(request, op, { ...auth.headers, ...headers }, auth.query),
      send: (input, op) =>
        sendAs(
          { method: (input.method ?? "GET").toUpperCase(), url: input.url, headers: input.headers, body: input.body, as: input.as },
          op ?? { method: (input.method ?? "GET").toUpperCase(), path: new URL(input.url).pathname, url: input.url, title: "", secured: false, responses: {} },
        ),
      testServer: Boolean(opts.testServer),
      roles: (opts.roles ?? []).filter((r) => r.login.kind === "api"),
      baseline: opts.baseline,
      scenarios: (opts.scenarios ?? []).filter((s) => !s.off),
      report: {},
      extraCalls: [],
      log,
    };
    const selected = opts.agents ? API_AGENTS.filter((a) => opts.agents!.includes(a.id)) : API_AGENTS.filter((a) => !a.defaultOff);
    const { findings, stats } = await runEngineAgents(selected, ctx, specUrl, log);

    const pages: PageResult[] = calls.map((c) => ({
      url: c.op.url,
      status: c.status,
      title: `GET ${c.op.path}${c.op.title && c.op.title !== `GET ${c.op.path}` ? ` · ${c.op.title}` : ""}`,
      loadMs: c.status === null ? null : c.ms,
      error: c.error,
    }));
    const notes = [
      `${parsed.title}, ${parsed.version}. Base address ${parsed.baseUrl}.`,
      opts.auth
        ? `Called ${calls.length} of ${parsed.operations.length} read-only (GET) endpoints with the saved login (${auth.label}).`
        : `Called ${calls.length} of ${parsed.operations.length} read-only (GET) endpoints without logging in.`,
      `Each endpoint that answered was timed ${samples} times: the report shows the middle (median) time and the 95% time.`,
    ];
    if (foundAt) notes.push(`No API file was given: it was found at ${foundAt}.`);
    if (kind !== "openapi") notes.push(`The endpoints come from the uploaded ${kind === "postman" ? "Postman collection" : kind === "har" ? "HAR file" : "cURL commands"}.`);
    const withIds = calls.filter((c) => c.idFrom).length;
    if (withIds) notes.push(`${withIds} detail endpoints were called with real ids taken from the list endpoints' answers.`);
    if (opts.auth) {
      if (anonymous.length) notes.push(`Also called the ${anonymous.length} endpoints that need a login without it, to check they refuse strangers.`);
      const refused = calls.filter((c) => c.status === 401);
      if (refused.length && refused.length >= Math.max(1, calls.filter((c) => c.op.secured).length / 2)) {
        notes.push(`The saved login was refused (HTTP 401) by ${refused.length} endpoints. Check the key or token is still valid.`);
        log(`The saved login was refused by ${refused.length} endpoints`);
      }
    }
    if (callable.length > toCall.length) notes.push(`${callable.length - toCall.length} more endpoints were left out: one test calls at most ${MAX_OPERATIONS}.`);
    const skipped = parsed.operations.filter((o) => o.skip);
    if (skipped.length) {
      notes.push(
        `${skipped.length} endpoints were not called: ${skipped
          .slice(0, 3)
          .map((o) => `GET ${o.path} (${o.skip})`)
          .join("; ")}${skipped.length > 3 ? "; and more" : ""}.`,
      );
    }
    if (parsed.writeOperations && !ctx.report.writes?.ran) {
      notes.push(`${parsed.writeOperations} operations that change data (POST, PUT, PATCH, DELETE) were not called, to keep your data safe.`);
    }

    const secrets = auth.secrets ?? [];
    const views = [
      ...calls.map((c) => callView(c, spec, auth)),
      ...ctx.extraCalls.map((x) => callView(x.call, spec, auth, x.step)),
    ];
    const writeCalls = ctx.extraCalls.filter((x) => x.call.op.method !== "GET");
    const coverage = {
      documented: parsed.operations.length + parsed.writeOperations,
      called: calls.length + new Set(writeCalls.map((x) => `${x.call.op.method} ${x.call.op.path}`)).size,
      passed: [...calls, ...writeCalls.map((x) => x.call)].filter((c) => c.status !== null && c.status < 400).length,
      skipped: [
        ...skipped.map((o) => ({ method: o.method, path: o.path, why: o.skip! })),
        ...callable.slice(MAX_OPERATIONS).map((o) => ({ method: o.method, path: o.path, why: `One test calls at most ${MAX_OPERATIONS} endpoints` })),
        ...parsed.writes
          .filter((o) => !writeCalls.some((x) => x.call.op.method === o.method && x.call.op.path === o.path))
          .map((o) => ({ method: o.method, path: o.path, why: ctx.testServer ? "No safe way to call it: it needs a record the test did not make" : "Changes data: only called when the project is marked as a test server" })),
      ],
    };
    const { accessRows, ...reportRest } = ctx.report;
    const api = {
      source: (foundAt ? "found" : kind) as NonNullable<ScanResult["api"]>["source"],
      ...(foundAt ? { foundAt } : {}),
      calls: views,
      coverage,
      ...reportRest,
      ...(accessRows ? { access: { accounts: ["Main login", ...ctx.roles.map((r) => r.name), "No login"], rows: accessRows } } : {}),
    };

    // This run's copy of the file: the next test lists what changed, and the mock server answers from it.
    if (opts.artifactsDir) {
      await mkdir(opts.artifactsDir, { recursive: true });
      await writeFile(path.join(opts.artifactsDir, "api-spec.json"), JSON.stringify(spec));
    }

    const score = scoreFindings(findings, calls.length, API_CATEGORIES, stats);
    log(`Done: ${calls.length} endpoints, ${findings.length} findings`);
    const result: ScanResult = {
      startUrl: opts.specUrl ?? foundAt ?? parsed.baseUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      pages,
      findings,
      ...score,
      agentStats: stats,
      notes,
      label: { pages: "Endpoints" },
      scanned: [specUrl, parsed.baseUrl],
      api,
    };
    return secrets.length ? redact(result, secrets) : result;
  } finally {
    await request.dispose();
  }
}
