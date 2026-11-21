import { request as playwrightRequest, type APIRequestContext } from "playwright";
import { CouldNotTestError } from "../runner/coverage.js";
import { validateTarget } from "../runner/urls.js";
import type { ApiCallView, ContractReport, Finding, Login, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { resolveAuth } from "./api-auth.js";
import { protocolResult, protoFinding } from "./protocol.js";

/*
 * Contract tests, Pact style, in-house: reads a Pact file (versions 2, 3 and 4) that a consumer
 * (a website, an app) wrote, sends each of its requests to the provider API and checks the answer
 * keeps the contract: the status, the headers named and the body, with Pact's matching rules
 * (type, regex, number kinds, min and max for lists, include, equality). Extra fields in the answer
 * are fine, as Pact says. Requests that change data are sent only to a test server.
 */

export interface PactInteraction {
  description: string;
  state?: string;
  method: string;
  path: string;
  query?: string;
  headers: Record<string, string>;
  body?: unknown;
  response: { status: number; headers: Record<string, string>; body?: unknown };
  /** Matching rules for the answer, by path: "body:$.items[*].id", "header:content-type". */
  rules: Record<string, Matcher[]>;
}

export interface Pact {
  consumer: string;
  provider: string;
  spec: string;
  interactions: PactInteraction[];
}

export interface Matcher {
  match: string;
  regex?: string;
  min?: number;
  max?: number;
  value?: string;
}

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_INTERACTIONS = 100;

const lowerKeys = (h: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries((h ?? {}) as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));

function queryString(q: unknown): string | undefined {
  if (!q) return undefined;
  if (typeof q === "string") return q.replace(/^\?/, "") || undefined;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) for (const x of Array.isArray(v) ? v : [v]) sp.append(k, String(x));
  return sp.toString() || undefined;
}

/** Pact 4 bodies are {content, contentType, encoded}; older ones are the body itself. */
function bodyOf(b: unknown): unknown {
  if (b && typeof b === "object" && !Array.isArray(b) && "content" in b && ("contentType" in b || "encoded" in b)) {
    const x = b as { content: unknown; encoded?: unknown };
    if (x.encoded && typeof x.content === "string") return x.encoded === "JSON" ? safeJson(x.content) : x.content;
    return x.content;
  }
  return b;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Matching rules of every version, as "body:$.a.b" / "header:name" / "status" → matchers. */
function readRules(raw: unknown): Record<string, Matcher[]> {
  const out: Record<string, Matcher[]> = {};
  if (!raw || typeof raw !== "object") return out;
  const asList = (v: unknown): Matcher[] => {
    const x = v as { matchers?: Matcher[]; match?: string; regex?: string; min?: number; max?: number };
    if (Array.isArray(x?.matchers)) return x.matchers.map((m) => ({ ...m, match: m.match ?? (m.regex ? "regex" : "type") }));
    return [{ ...(x as Matcher), match: x?.match ?? (x?.regex ? "regex" : x?.min !== undefined || x?.max !== undefined ? "type" : "equality") }];
  };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.startsWith("$.body")) out[`body:$${k.slice(6)}`] = asList(v); // version 2
    else if (k.startsWith("$.headers.")) out[`header:${k.slice(10).toLowerCase()}`] = asList(v);
    else if (k === "body" || k === "header" || k === "status") {
      for (const [p, m] of Object.entries((v ?? {}) as Record<string, unknown>)) {
        if (k === "body") out[`body:${p.startsWith("$") ? p : `$.${p}`}`] = asList(m);
        else if (k === "header") out[`header:${p.toLowerCase()}`] = asList(m);
        else out.status = asList(m);
      }
    }
  }
  return out;
}

export function parsePact(text: string): Pact {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("The contract file is not JSON. Upload the Pact file your consumer tests write (pacts/<consumer>-<provider>.json).");
  }
  const list = (raw.interactions ?? raw.messages) as unknown[] | undefined;
  if (!Array.isArray(list)) throw new Error("The contract file has no interactions. Is it a Pact file?");
  const meta = (raw.metadata ?? {}) as Record<string, Record<string, string>>;
  const spec = String(meta.pactSpecification?.version ?? meta["pact-specification"]?.version ?? meta.pactSpecificationVersion ?? "2").split(".")[0];
  const interactions: PactInteraction[] = [];
  for (const i of list as Record<string, any>[]) {
    if (i.type && !/http/i.test(String(i.type))) continue; // message pacts have no HTTP request
    if (!i.request || !i.response) continue;
    const states = Array.isArray(i.providerStates) ? i.providerStates.map((s: { name: string }) => s.name).join("; ") : i.providerState;
    interactions.push({
      description: String(i.description ?? `${i.request.method} ${i.request.path}`),
      ...(states ? { state: String(states) } : {}),
      method: String(i.request.method ?? "GET").toUpperCase(),
      path: String(i.request.path ?? "/"),
      query: queryString(i.request.query),
      headers: lowerKeys(i.request.headers),
      body: bodyOf(i.request.body),
      response: { status: Number(i.response.status ?? 200), headers: lowerKeys(i.response.headers), body: bodyOf(i.response.body) },
      rules: { ...readRules(i.responseMatchingRules), ...readRules(i.response.matchingRules) },
    });
  }
  const name = (x: unknown) => String((x as { name?: string })?.name ?? "unknown");
  return { consumer: name(raw.consumer), provider: name(raw.provider), spec, interactions };
}

type Seg = string | number;

function parsePath(p: string): Seg[] {
  const out: Seg[] = [];
  for (const m of p.replace(/^\$/, "").matchAll(/\.([^.[\]]+)|\[(\d+|\*)\]|\['([^']+)'\]/g)) out.push(m[2] !== undefined ? (m[2] === "*" ? "*" : Number(m[2])) : (m[1] ?? m[3]));
  return out;
}

const fits = (rule: Seg[], at: Seg[]) => rule.length === at.length && rule.every((s, i) => s === "*" || s === at[i]);

const kindOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const show = (at: Seg[]) => "$" + at.map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`)).join("");

/** Compares an answer body with the contract. Problems are short, one per difference. */
export function matchBody(expected: unknown, actual: unknown, rules: Record<string, Matcher[]>, problems: string[] = []): string[] {
  const bodyRules = Object.entries(rules)
    .filter(([k]) => k.startsWith("body:"))
    .map(([k, m]) => ({ at: parsePath(k.slice(5)), m }));
  const ruleAt = (at: Seg[]) => {
    const hits = bodyRules.filter((r) => fits(r.at, at));
    hits.sort((a, b) => a.at.filter((s) => s !== "*").length - b.at.filter((s) => s !== "*").length);
    return hits.pop()?.m;
  };
  const walk = (e: unknown, a: unknown, at: Seg[], byType: boolean) => {
    if (problems.length >= 20) return;
    const where = show(at);
    const own = ruleAt(at);
    let cascade = byType;
    if (own) {
      for (const m of own) {
        const ok = check(m, e, a);
        if (ok !== true) return void problems.push(`${where}: ${ok}`);
        if (m.match === "type" || m.match === "min" || m.match === "max") cascade = true;
        if (m.match !== "type" && m.match !== "min" && m.match !== "max") return; // regex, number kinds: the value itself is checked
      }
    }
    if (a === undefined) return void problems.push(`${where}: missing from the answer`);
    if (kindOf(e) !== kindOf(a)) return void problems.push(`${where}: expected ${kindOf(e)}, got ${kindOf(a)}`);
    if (Array.isArray(e) && Array.isArray(a)) {
      const asTemplate = own?.some((m) => m.match === "type" || m.min !== undefined || m.max !== undefined);
      if (asTemplate && e.length) a.forEach((x, i) => walk(e[0], x, [...at, i], true));
      else {
        if (!cascade && a.length !== e.length) return void problems.push(`${where}: expected ${e.length} items, got ${a.length}`);
        e.forEach((x, i) => walk(x, a[i], [...at, i], cascade));
      }
      return;
    }
    if (e && typeof e === "object") {
      for (const [k, v] of Object.entries(e as Record<string, unknown>)) walk(v, (a as Record<string, unknown>)[k], [...at, k], cascade);
      return;
    }
    if (!cascade && e !== a) problems.push(`${where}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  };
  walk(expected, actual, [], false);
  return problems;
}

function check(m: Matcher, e: unknown, a: unknown): true | string {
  switch (m.match) {
    case "regex":
      if (a === undefined || a === null || typeof a === "object") return `expected text matching /${m.regex}/, got ${JSON.stringify(a)}`;
      try {
        return new RegExp(`^(?:${m.regex ?? ".*"})$`).test(String(a)) ? true : `${JSON.stringify(a)} does not match /${m.regex}/`;
      } catch {
        return true; // a pattern JavaScript cannot read: not the provider's fault
      }
    case "integer":
      return Number.isInteger(a) ? true : `expected a whole number, got ${JSON.stringify(a)}`;
    case "decimal":
      return typeof a === "number" ? true : `expected a decimal number, got ${JSON.stringify(a)}`;
    case "number":
      return typeof a === "number" ? true : `expected a number, got ${JSON.stringify(a)}`;
    case "boolean":
      return typeof a === "boolean" ? true : `expected true or false, got ${JSON.stringify(a)}`;
    case "null":
      return a === null ? true : `expected null, got ${JSON.stringify(a)}`;
    case "equality":
      return JSON.stringify(e) === JSON.stringify(a) ? true : `expected exactly ${JSON.stringify(e)}, got ${JSON.stringify(a)}`;
    case "include":
      return typeof a === "string" && a.includes(String(m.value ?? e)) ? true : `expected text that includes ${JSON.stringify(m.value ?? e)}`;
    case "type":
    case "min":
    case "max":
      if (a === undefined) return "missing from the answer";
      if (kindOf(e) !== kindOf(a)) return `expected ${kindOf(e)}, got ${kindOf(a)}`;
      if (Array.isArray(a) && m.min !== undefined && a.length < m.min) return `expected at least ${m.min} items, got ${a.length}`;
      if (Array.isArray(a) && m.max !== undefined && a.length > m.max) return `expected at most ${m.max} items, got ${a.length}`;
      return true;
    default:
      return kindOf(e) === kindOf(a) ? true : `expected ${kindOf(e)}, got ${kindOf(a)}`; // date, time, uuid...: the kind at least
  }
}

/** The headers the contract names must be there, with the same value (or the rule's). */
export function matchHeaders(expected: Record<string, string>, actual: Record<string, string>, rules: Record<string, Matcher[]>): string[] {
  const problems: string[] = [];
  const norm = (s: string) => s.replace(/\s*([,;])\s*/g, "$1").trim().toLowerCase();
  for (const [k, v] of Object.entries(expected)) {
    const got = actual[k];
    if (got === undefined) {
      problems.push(`header ${k}: missing`);
      continue;
    }
    const rule = rules[`header:${k}`];
    if (rule) {
      for (const m of rule) {
        const ok = check(m, v, got);
        if (ok !== true) problems.push(`header ${k}: ${ok}`);
      }
    } else if (norm(got) !== norm(v) && !(k === "content-type" && norm(got).startsWith(norm(v).split(";")[0]) && !norm(v).includes(";"))) {
      problems.push(`header ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
    }
  }
  return problems;
}

export interface PactScanOptions {
  pactText: string;
  /** The provider's address; the Pact paths are joined to it. */
  baseUrl: string;
  auth?: Login;
  testServer?: boolean;
  onProgress?: (m: string) => void;
  signal?: AbortSignal;
}

export async function verifyPact(opts: PactScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const pact = parsePact(opts.pactText);
  if (!pact.interactions.length) throw new CouldNotTestError("Could not run the contract test: the Pact file has no HTTP interactions.");
  const base = validateTarget(opts.baseUrl);
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.5 (contract test)",
  });
  try {
    const { parts: auth } = await resolveAuth(request, opts.auth, log);
    const findings: Finding[] = [];
    const mk = protoFinding("api.contract", base);
    const views: ApiCallView[] = [];
    const report: ContractReport = { consumer: pact.consumer, provider: pact.provider, spec: pact.spec, interactions: [] };
    log(`Contract ${pact.consumer} → ${pact.provider}: ${pact.interactions.length} interactions`);
    const list = pact.interactions.slice(0, MAX_INTERACTIONS);
    for (const i of list) {
      opts.signal?.throwIfAborted();
      const row: ContractReport["interactions"][number] = { description: i.description, ...(i.state ? { state: i.state } : {}), method: i.method, path: i.path, ok: false, problems: [] };
      report.interactions.push(row);
      if (!SAFE.has(i.method) && !opts.testServer) {
        row.skipped = "Changes data: sent only when the project is marked as a test server";
        continue;
      }
      log(`${i.method} ${i.path}`);
      const r = await send(request, base, i, auth.headers);
      row.status = r.status;
      if (r.error) row.problems.push(r.error);
      else {
        if (r.status !== i.response.status) {
          const rule = i.rules.status;
          const ok = rule?.some((m) => m.match === "statusCode" || m.match === "status") ? (r.status ?? 0) < 400 === i.response.status < 400 : false;
          if (!ok) row.problems.push(`status: expected ${i.response.status}, got ${r.status}`);
        }
        row.problems.push(...matchHeaders(i.response.headers, r.headers, i.rules));
        if (i.response.body !== undefined) {
          const actual = /json/i.test(r.headers["content-type"] ?? "") || /^[[{]/.test(r.text.trim()) ? safeJson(r.text) : r.text;
          row.problems.push(...matchBody(i.response.body, actual, i.rules));
        }
      }
      row.ok = !row.problems.length;
      views.push({
        method: i.method,
        path: i.path,
        url: r.url,
        status: r.status,
        ms: r.ms,
        bytes: r.text.length,
        contentType: r.headers["content-type"] ?? "",
        requestHeaders: { ...i.headers, ...Object.fromEntries(Object.keys(auth.headers).filter((k) => !(k.toLowerCase() in i.headers)).map((k) => [k, "[hidden]"])) },
        ...(i.body !== undefined ? { requestBody: (typeof i.body === "string" ? i.body : JSON.stringify(i.body)).slice(0, 8000) } : {}),
        responseHeaders: Object.fromEntries(Object.entries(r.headers).filter(([k]) => k in i.response.headers || k === "content-type")),
        body: r.text.slice(0, 8000),
        ...(row.problems.length ? { problems: row.problems } : {}),
        ...(r.error ? { error: r.error } : {}),
        step: i.description,
      });
    }
    const sent = report.interactions.filter((x) => !x.skipped);
    if (sent.length && sent.every((x) => x.status === null || x.status === undefined)) throw new CouldNotTestError(`Could not run the contract test: no answer from ${base} (${sent[0].problems[0] ?? "no reply"}).`);
    const broken = sent.filter((x) => !x.ok);
    for (const x of broken.slice(0, 20)) {
      const stateNote = x.state ? ` The contract expects the provider state "${x.state}"; if the test data is not set up that way, set it up and run again.` : "";
      findings.push(mk("contract:broken", x.status !== null && x.status !== undefined && x.status >= 500 ? "high" : "medium", `The API breaks the ${pact.consumer} contract: ${x.description}`, `${x.method} ${x.path} does not answer the way ${pact.consumer} expects, so that part of ${pact.consumer} can fail.${stateNote}`, x.problems.slice(0, 6).join("\n"), "functional"));
    }
    const skipped = report.interactions.filter((x) => x.skipped);
    const result = protocolResult({
      kind: "pact",
      agent: "api.contract",
      agentName: "Contract tests",
      url: base,
      service: `${pact.consumer} → ${pact.provider}`,
      operations: pact.interactions.length,
      notCalled: [
        ...skipped.map((x) => ({ method: x.method, path: x.path, why: x.skipped! })),
        ...pact.interactions.slice(MAX_INTERACTIONS).map((x) => ({ method: x.method, path: x.path, why: `One test sends at most ${MAX_INTERACTIONS} interactions` })),
      ],
      views,
      findings,
      notes: [
        `Contract test (Pact ${pact.spec}): ${pact.consumer} expects ${pact.interactions.length} things from ${pact.provider}. ${sent.length - broken.length} of ${sent.length} sent kept the contract.`,
        ...(skipped.length ? [`${skipped.length} interactions change data and were not sent, because the project is not marked as a test server.`] : []),
        ...(pact.interactions.some((x) => x.state) ? ["Some interactions expect a provider state (test data set up a certain way). This test does not set states up; make sure the test data matches, or mark failures as expected."] : []),
      ],
      startedAt,
    });
    result.api!.contract = report;
    return auth.secrets?.length ? redact(result, auth.secrets) : result;
  } finally {
    await request.dispose();
  }
}

async function send(request: APIRequestContext, base: string, i: PactInteraction, authHeaders: Record<string, string>) {
  const url = new URL(base.replace(/\/$/, "") + (i.path.startsWith("/") ? i.path : `/${i.path}`));
  if (i.query) url.search = i.query;
  const started = Date.now();
  const headers = { ...Object.fromEntries(Object.entries(authHeaders).filter(([k]) => !(k.toLowerCase() in i.headers))), ...i.headers };
  try {
    const res = await request.fetch(url.href, {
      method: i.method,
      headers,
      ...(i.body !== undefined ? { data: typeof i.body === "string" ? i.body : JSON.stringify(i.body) } : {}),
      timeout: 20_000,
      failOnStatusCode: false,
      maxRedirects: 0,
    });
    return { url: url.href, status: res.status() as number | null, ms: Date.now() - started, headers: lowerKeys(res.headers()), text: (await res.text().catch(() => "")).slice(0, 200_000), error: undefined as string | undefined };
  } catch (err) {
    return { url: url.href, status: null, ms: Date.now() - started, headers: {} as Record<string, string>, text: "", error: (err as Error).message.split("\n")[0] };
  }
}
