import { request as playwrightRequest, type APIRequestContext } from "playwright";
import type { ApiCall, ApiContext } from "../agents/api/context.js";
import { API_AGENTS } from "../agents/api/index.js";
import { scoreFindings } from "../runner/score.js";
import { validateTarget } from "../runner/urls.js";
import type { Category, Login, PageResult, ScanResult } from "../types.js";
import { pool, runEngineAgents } from "./agents.js";
import { isJsonType, parseSpec, parseSpecText, type ApiOperation } from "./openapi.js";

/** Most endpoints called in one test, so a huge API cannot run for hours. */
export const MAX_OPERATIONS = 60;
const BODY_LIMIT = 200_000;
const RETRY_STATUSES = [429, 502, 503, 504];
export const API_CATEGORIES: Category[] = ["functional", "security", "performance"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ApiScanOptions {
  /** Address of the OpenAPI or Swagger file. */
  specUrl?: string;
  /** The file's text, when it was uploaded instead. */
  specText?: string;
  /** The API's base address, when it differs from the file's "servers". */
  baseUrl?: string;
  /** The project's saved API login: a bearer token, a key in a header or query parameter, or basic. */
  auth?: Login;
  agents?: string[];
  onProgress?: (message: string) => void;
}

interface AuthParts {
  headers: Record<string, string>;
  query?: [string, string];
  /** How the login is sent, for the report (never the secret). */
  label: string;
}

/** The headers or query parameter that carry the saved API login. */
export function authParts(auth?: Login): AuthParts {
  if (!auth) return { headers: {}, label: "" };
  switch (auth.authType) {
    case "basic":
      return {
        headers: { authorization: `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password ?? ""}`).toString("base64")}` },
        label: `basic login as ${auth.username}`,
      };
    case "header":
      return { headers: { [auth.paramName!.toLowerCase()]: auth.token ?? "" }, label: `a key in the ${auth.paramName} header` };
    case "query":
      return { headers: {}, query: [auth.paramName!, auth.token ?? ""], label: `a key in the ${auth.paramName} query parameter` };
    default:
      return { headers: { authorization: `Bearer ${auth.token ?? ""}` }, label: "a bearer token" };
  }
}

/** Adds the query-parameter key at call time only, so it never ends up in the report's addresses. */
function withQuery(url: string, query?: [string, string]): string {
  if (!query) return url;
  const u = new URL(url);
  u.searchParams.set(query[0], query[1]);
  return u.toString();
}

/** One GET, never throwing: failures come back as status null with the reason. */
async function callOnce(request: APIRequestContext, url: string, headers: Record<string, string> = {}, query?: [string, string]) {
  const started = Date.now();
  try {
    const res = await request.get(withQuery(url, query), { headers, timeout: 20_000, maxRedirects: 3, failOnStatusCode: false });
    const body = await res.body();
    const ms = Date.now() - started;
    const h = res.headers();
    const contentType = h["content-type"] ?? "";
    const text = body.subarray(0, BODY_LIMIT).toString("utf8");
    const out: Omit<ApiCall, "op"> = { status: res.status(), ms, contentType, headers: h, text };
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
    return {
      status: null,
      ms: Date.now() - started,
      contentType: "",
      headers: {},
      text: "",
      error: (err as Error).message.split("\n")[0],
    } satisfies Omit<ApiCall, "op">;
  }
}

/**
 * Calls one operation: retries once after a short wait on rate limits and gateway errors,
 * and once more when it was slow, keeping the faster time (the first call often wakes a cold server).
 */
export async function callOperation(
  request: APIRequestContext,
  op: ApiOperation,
  headers: Record<string, string> = {},
  query?: [string, string],
): Promise<ApiCall> {
  let r = await callOnce(request, op.url, headers, query);
  if (r.status !== null && RETRY_STATUSES.includes(r.status)) {
    await sleep(2000);
    r = await callOnce(request, op.url, headers, query);
  }
  if (r.status !== null && r.status < 400 && r.ms > 1000) {
    const again = await callOnce(request, op.url, headers, query);
    if (again.status === r.status) r.ms = Math.min(r.ms, again.ms);
  }
  return { op, ...r };
}

async function loadSpecText(request: APIRequestContext, opts: ApiScanOptions, auth: AuthParts): Promise<string> {
  if (opts.specText) return opts.specText;
  if (!opts.specUrl) throw new Error("Add the address of the API's OpenAPI (Swagger) file, or upload the file.");
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
  return res.text();
}

/**
 * Tests a REST API from its OpenAPI or Swagger file. Only GET requests are sent: operations that
 * change data are counted but never called. With a saved login, the endpoints are called with it,
 * and the ones that need a login are also called without it to check they refuse strangers.
 */
export async function scanApi(opts: ApiScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.3 (API test)",
    extraHTTPHeaders: { accept: "application/json, */*;q=0.5" },
  });

  try {
    const auth = authParts(opts.auth);
    log("Reading the API file");
    const text = await loadSpecText(request, opts, auth);
    let spec;
    try {
      spec = parseSpecText(text);
    } catch (err) {
      throw new Error(`The API file is not valid JSON or YAML: ${(err as Error).message.split("\n")[0]}`);
    }
    const specUrl = opts.specUrl ?? opts.baseUrl ?? "uploaded-file";
    const resolveFrom = opts.specUrl ?? opts.baseUrl;
    if (!resolveFrom && !/^https?:\/\//.test(String(spec?.servers?.[0]?.url ?? "")) && !spec?.host) {
      throw new Error("The uploaded API file has no full server address. Enter the API's base address.");
    }
    const parsed = parseSpec(spec, resolveFrom ?? "https://invalid.local/", opts.baseUrl);
    // The file decides where requests go, so it gets the same address rules as anything typed in.
    validateTarget(parsed.baseUrl);
    log(`${parsed.title} (${parsed.version}): ${parsed.operations.length} read-only endpoints, base ${parsed.baseUrl}`);

    const callable = parsed.operations.filter((o) => !o.skip);
    const toCall = callable.slice(0, MAX_OPERATIONS);
    if (opts.auth) log(`Calling the endpoints with the saved login (${auth.label})`);
    const calls = await pool(toCall, 3, async (op, i) => {
      log(`Calling ${i + 1}/${toCall.length}: GET ${op.path}`);
      return callOperation(request, op, auth.headers, auth.query);
    });
    let anonymous = calls;
    if (opts.auth) {
      const secured = toCall.filter((o) => o.secured);
      if (secured.length) log(`Calling ${secured.length} endpoints that need a login without it, to check they refuse`);
      anonymous = await pool(secured, 3, (op) => callOperation(request, op));
    }

    const ctx: ApiContext = {
      spec,
      parsed,
      specUrl,
      calls,
      anonymous,
      authenticated: Boolean(opts.auth),
      request,
      call: (op, headers) => callOperation(request, op, { ...auth.headers, ...headers }, auth.query),
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
    ];
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
    if (parsed.writeOperations) {
      notes.push(`${parsed.writeOperations} operations that change data (POST, PUT, PATCH, DELETE) were not called, to keep your data safe.`);
    }

    const { scores, overallScore } = scoreFindings(findings, calls.length, API_CATEGORIES);
    log(`Done: ${calls.length} endpoints, ${findings.length} findings`);
    return {
      startUrl: opts.specUrl ?? parsed.baseUrl,
      startedAt,
      finishedAt: new Date().toISOString(),
      pages,
      findings,
      scores,
      overallScore,
      agentStats: stats,
      notes,
      label: { pages: "Endpoints" },
      scanned: [specUrl, parsed.baseUrl],
    };
  } finally {
    await request.dispose();
  }
}
