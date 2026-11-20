import { request as playwrightRequest, type APIRequestContext } from "playwright";
import type { ApiCall, ApiContext } from "../agents/api/context.js";
import { apiExposureAgent, apiTransportAgent, findLeak } from "../agents/api/index.js";
import { CouldNotTestError } from "../runner/coverage.js";
import { finding } from "../runner/finding.js";
import { scoreFindings } from "../runner/score.js";
import { validateTarget } from "../runner/urls.js";
import type { ApiCallView, Finding, PageResult, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { runEngineAgents } from "./agents.js";
import type { ApiScanOptions } from "./api.js";
import { API_CATEGORIES } from "./api.js";
import { resolveAuth, type AuthParts } from "./api-auth.js";
import type { ApiOperation, Json } from "./openapi.js";
import { tellCall } from "../runner/live-code.js";

/*
 * GraphQL APIs, like graphql-cop and InQL: reads the schema (introspection), runs read-only
 * queries made from it (never mutations), and checks the settings attackers look for:
 * introspection and field suggestions on a live server, no depth or alias limit, batching, queries
 * by GET (CSRF), and errors that show internal details. GraphQL sends queries with POST, but a
 * query only reads.
 */

const INTROSPECTION = `query GlvIntrospection { __schema { queryType { name } mutationType { name } subscriptionType { name } types { kind name fields(includeDeprecated: true) { name isDeprecated args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } defaultValue } type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`;

const MAX_QUERIES = 30;

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface Field {
  name: string;
  isDeprecated?: boolean;
  args: { name: string; type: TypeRef; defaultValue: string | null }[];
  type: TypeRef;
}
interface GqlType {
  kind: string;
  name: string;
  fields: Field[] | null;
}

const named = (t: TypeRef | null | undefined): TypeRef | undefined => (t ? (t.name ? t : named(t.ofType)) : undefined);
const required = (t: TypeRef) => t.kind === "NON_NULL";

/** Scalar fields of a type, then one level of objects with their scalars, for a read-only query. */
export function selection(types: Map<string, GqlType>, typeName: string, depth = 0): string {
  const t = types.get(typeName);
  if (!t?.fields) return "__typename";
  const parts: string[] = [];
  for (const f of t.fields) {
    if (f.args.some((a) => required(a.type) && a.defaultValue === null)) continue;
    const n = named(f.type);
    if (!n) continue;
    if (n.kind === "SCALAR" || n.kind === "ENUM") parts.push(f.name);
    else if ((n.kind === "OBJECT" || n.kind === "INTERFACE") && depth < 1 && n.name) {
      const inner = selection(types, n.name, depth + 1);
      if (inner !== "__typename") parts.push(`${f.name} { ${inner} }`);
    }
    if (parts.length >= 25) break;
  }
  return parts.length ? parts.join(" ") : "__typename";
}

/** A query nested `depth` levels through types that point back at each other (user { friends { user ... } }). */
export function deepQuery(types: Map<string, GqlType>, root: string, depth: number): string | undefined {
  const rootType = types.get(root);
  for (const start of rootType?.fields ?? []) {
    if (start.args.some((a) => required(a.type) && a.defaultValue === null)) continue;
    let path: string[] = [start.name];
    let cur = named(start.type)?.name;
    const seen: string[] = [];
    while (cur && path.length < depth) {
      const t = types.get(cur);
      const next = t?.fields?.find((f) => {
        const n = named(f.type);
        return (n?.kind === "OBJECT" || n?.kind === "INTERFACE") && !f.args.some((a) => required(a.type) && a.defaultValue === null);
      });
      if (!next) break;
      seen.push(cur);
      path.push(next.name);
      cur = named(next.type)?.name ?? undefined;
    }
    if (path.length >= depth) {
      path = path.slice(0, depth);
      return `query GlvDepth { ${path.join(" { ")} { __typename }${" }".repeat(path.length - 1)} }`;
    }
  }
  return undefined;
}

async function post(request: APIRequestContext, url: string, auth: AuthParts | undefined, payload: unknown): Promise<Omit<ApiCall, "op"> & { gql?: Json }> {
  const out = await postQuiet(request, url, auth, payload);
  tellCall({ method: "POST", url, headers: { ...(auth?.headers ?? {}), "content-type": "application/json" }, body: payload }, out);
  return out;
}

async function postQuiet(request: APIRequestContext, url: string, auth: AuthParts | undefined, payload: unknown): Promise<Omit<ApiCall, "op"> & { gql?: Json }> {
  const started = Date.now();
  try {
    const res = await request.post(url, { data: payload as object, headers: { ...(auth?.headers ?? {}), accept: "application/json" }, timeout: 20_000, failOnStatusCode: false });
    const body = await res.body();
    const text = body.subarray(0, 200_000).toString("utf8");
    let json: Json;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status(), ms: Date.now() - started, contentType: res.headers()["content-type"] ?? "", headers: res.headers(), text, bytes: body.length, json, gql: json };
  } catch (err) {
    return { status: null, ms: Date.now() - started, contentType: "", headers: {}, text: "", error: (err as Error).message.split("\n")[0] };
  }
}

const opOf = (url: string, name: string): ApiOperation => ({ method: "POST", path: name, url, title: name, secured: false, responses: {} });
const errorsOf = (j: Json): { message?: string; extensions?: Json }[] => (Array.isArray(j?.errors) ? j.errors : []);

export async function scanGraphql(opts: ApiScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const url = validateTarget(opts.graphqlUrl!);
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.4 (GraphQL test)",
  });
  try {
    const { parts: auth } = await resolveAuth(request, opts.auth, log);
    const findings: Finding[] = [];
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string, category: Finding["category"] = "security") =>
      findings.push(finding({ category, rule, severity, title, detail, pageUrl: url, evidence, agent: "api.graphql" }));
    const calls: ApiCall[] = [];
    const views: ApiCallView[] = [];
    const record = (name: string, query: string, c: Omit<ApiCall, "op">) => {
      const call = { op: opOf(url, name), ...c, sent: { headers: {}, body: JSON.stringify({ query }) } } as ApiCall;
      calls.push(call);
      views.push({
        method: "POST",
        path: name,
        url,
        status: c.status,
        ms: c.ms,
        bytes: c.bytes ?? 0,
        contentType: c.contentType,
        requestHeaders: { "content-type": "application/json", ...Object.fromEntries(Object.keys(auth.headers).map((k) => [k, "[hidden]"])) },
        requestBody: JSON.stringify({ query }).slice(0, 8000),
        responseHeaders: {},
        body: c.text.slice(0, 8000),
        ...(errorsOf(c.json).length ? { problems: errorsOf(c.json).slice(0, 3).map((e) => String(e.message ?? "error").slice(0, 200)) } : {}),
        ...(c.error ? { error: c.error } : {}),
      });
      return call;
    };

    log("Reading the GraphQL schema (introspection)");
    const intro = await post(request, url, auth, { query: INTROSPECTION });
    record("Schema (introspection)", INTROSPECTION, intro);
    if (intro.status === null) throw new CouldNotTestError(`Could not test the GraphQL API: no answer from ${url} (${intro.error}).`);
    const ping = await post(request, url, auth, { query: "query { __typename }" });
    record("query { __typename }", "query { __typename }", ping);
    if (!ping.gql?.data) throw new CouldNotTestError(`Could not test the GraphQL API: ${url} does not answer GraphQL (HTTP ${ping.status}). Check the address (often /graphql) and the login.`);

    const schema = intro.gql?.data?.__schema;
    const types = new Map<string, GqlType>((schema?.types ?? []).map((t: GqlType) => [t.name, t]));
    const queryRoot = schema?.queryType?.name ?? "Query";
    const mutationRoot = schema?.mutationType?.name;
    const queries = types.get(queryRoot)?.fields ?? [];
    const mutations = mutationRoot ? (types.get(mutationRoot)?.fields ?? []) : [];
    if (schema) {
      add(
        "api:gql-introspection",
        "low",
        "Anyone can read the whole GraphQL schema (introspection is on)",
        `The API answers the introspection query with all ${types.size} types, ${queries.length} queries and ${mutations.length} mutations. On a live server this hands attackers a map of every field. Turn introspection off in production (keep it for development), and publish only the docs you want public.`,
        `__schema: ${types.size} types`,
      );
    }

    // Field suggestions leak the schema even with introspection off.
    const typo = await post(request, url, auth, { query: "query { __typenme }" });
    record("Misspelled field", "query { __typenme }", typo);
    if (errorsOf(typo.gql).some((e) => /did you mean/i.test(String(e.message)))) {
      add("api:gql-suggestions", "low", "Error messages suggest field names", 'A misspelled field gets "Did you mean ...?", which lets attackers rebuild the schema even with introspection off. Turn suggestions off in production.', "Did you mean …");
    }
    const leak = [intro, typo].map((c) => findLeak(c.text)).find(Boolean);
    if (leak) add("api:error-leak", "high", "Error messages show internal details", `A GraphQL error answer contains ${leak.what}. Return short errors in production and log the details on the server.`, leak.snippet);
    else if ([intro, typo].some((c) => errorsOf(c.gql).some((e) => e.extensions?.exception?.stacktrace || e.extensions?.stacktrace))) {
      add("api:error-leak", "high", "Error messages show internal details", "GraphQL errors carry a stack trace in extensions.exception.stacktrace. Turn off debug errors in production.", "extensions.exception.stacktrace");
    }

    // Depth: a query 10 levels deep through types that point at each other.
    const deep = deepQuery(types, queryRoot, 10);
    if (deep) {
      const d = await post(request, url, auth, { query: deep });
      record("Deep query (10 levels)", deep, d);
      if (d.gql?.data && !errorsOf(d.gql).length) {
        add("api:gql-no-depth-limit", "medium", "No limit on how deep a query goes", "A query 10 levels deep was answered. Nested queries (user { friends { friends { ... } } }) can make one request load millions of rows and stop the server. Set a depth limit (7 is common) and a cost limit.", "depth 10 answered", "performance");
      }
    }
    // Aliases: 50 copies of one field in a query.
    const aliases = `query GlvAliases { ${Array.from({ length: 50 }, (_, i) => `a${i}: __typename`).join(" ")} }`;
    const al = await post(request, url, auth, { query: aliases });
    record("50 aliases", aliases, al);
    if (al.gql?.data && Object.keys(al.gql.data).length >= 50) {
      add("api:gql-no-alias-limit", "low", "No limit on aliases in one query", "50 copies of one field in one query were answered. Aliases let one request try many passwords or codes, or load the same data many times, past rate limits. Limit aliases (or the query cost).", "50 aliases answered");
    }
    // Batching: 10 queries in one request.
    const batch = await post(request, url, auth, Array.from({ length: 10 }, () => ({ query: "query { __typename }" })));
    record("10 queries in one request", "[10 x query { __typename }]", batch);
    if (Array.isArray(batch.gql) && batch.gql.length >= 10) {
      add("api:gql-batching", "low", "Many queries can be sent in one request (batching)", "A list of 10 queries in one request was answered. Batching gets around rate limits (10,000 login tries in one call). Turn it off, or count each query against the rate limit.", "10 queries in one request answered");
    }
    // Queries by GET can be sent by any website the user visits (CSRF).
    const viaGet = await request.get(`${url}${url.includes("?") ? "&" : "?"}query=${encodeURIComponent("query { __typename }")}`, { headers: auth.headers, timeout: 15_000, failOnStatusCode: false }).catch(() => undefined);
    let getJson: Json;
    try {
      getJson = viaGet ? await viaGet.json() : undefined;
    } catch {
      /* not JSON */
    }
    if (getJson?.data?.__typename) {
      add("api:gql-get-csrf", "low", "GraphQL answers queries sent by GET", "Any web page a signed-in user opens can send GET requests with their cookies. If cookies log users in, only accept POST with Content-Type: application/json.", "GET ?query={__typename} answered");
    }

    // Read-only queries made from the schema (mutations are counted, never sent).
    const callable = queries.filter((f) => !f.name.startsWith("__") && !f.args.some((a) => required(a.type) && a.defaultValue === null)).slice(0, MAX_QUERIES);
    log(`Running ${callable.length} read-only queries from the schema (${mutations.length} mutations are never sent)`);
    const anon: ApiCall[] = [];
    for (const f of callable) {
      const n = named(f.type);
      const sel = n && (n.kind === "OBJECT" || n.kind === "INTERFACE") && n.name ? ` { ${selection(types, n.name)} }` : "";
      const q = `query GlvRead { ${f.name}${sel} }`;
      const c = await post(request, url, auth, { query: q });
      record(`query ${f.name}`, q, c);
      const errs = errorsOf(c.gql);
      if (errs.some((e) => /internal|unexpected|exception|INTERNAL_SERVER_ERROR/i.test(`${e.message} ${e.extensions?.code ?? ""}`)) || (c.status ?? 0) >= 500) {
        add("api:gql-query-error", "high", "A GraphQL query fails with a server error", `query ${f.name} answered with a server error. The server log at the time of the test shows the cause.`, `${f.name}: ${String(errs[0]?.message ?? `HTTP ${c.status}`).slice(0, 120)}`, "functional");
      }
      if (opts.auth && c.gql?.data?.[f.name] != null) {
        const a = await post(request, url, undefined, { query: q });
        anon.push({ op: opOf(url, `query ${f.name}`), ...a });
        if (a.gql?.data?.[f.name] != null && JSON.stringify(a.gql.data[f.name]) === JSON.stringify(c.gql.data[f.name]) && /^(me|viewer|users?|customers?|orders?|invoices?|payments?|accounts?|employees?|contacts?|leads?|profile)$/i.test(f.name)) {
          add("api:auth-bypass", "critical", "Private data can be read without a login", `query ${f.name} gives the same data with no login as with the saved one. Check the resolvers ask for a logged-in user.`, `${f.name}: same data without a login`);
        }
      }
    }

    // The shared checks: secrets and personal data in answers, HTTPS, CORS and headers.
    const ctx = {
      spec: {},
      parsed: { version: "GraphQL", title: "GraphQL API", baseUrl: url, operations: [], writeOperations: mutations.length, writes: [], hasSecuritySchemes: true, warnings: [] },
      specUrl: url,
      calls: calls.filter((c) => c.status !== null && c.status < 300),
      anonymous: opts.auth ? anon : calls,
      authenticated: Boolean(opts.auth),
      authLabel: auth.label,
      request,
      call: async (op: ApiOperation, headers?: Record<string, string>) => ({ op, ...(await post(request, url, { ...auth, headers: { ...auth.headers, ...(headers ?? {}) } }, { query: "query { __typename }" })) }) as ApiCall,
      send: async () => ({ op: opOf(url, "probe"), status: null, ms: 0, contentType: "", headers: {}, text: "" }),
      testServer: false,
      roles: [],
      scenarios: [],
      report: {},
      extraCalls: [],
      log,
    } as unknown as ApiContext;
    const { findings: shared, stats } = await runEngineAgents([apiExposureAgent, apiTransportAgent], ctx, url, log);
    findings.push(...shared.map((f) => ({ ...f, pageUrl: url })));
    stats.unshift({ id: "api.graphql", name: "GraphQL checks", findings: findings.length - shared.length, ms: 0, errors: 0, category: "security", runs: 1 });

    const pages: PageResult[] = [{ url, status: ping.status, title: `GraphQL · ${queries.length} queries, ${mutations.length} mutations`, loadMs: ping.ms }];
    const score = scoreFindings(findings, 1, API_CATEGORIES, stats);
    const result: ScanResult = {
      startUrl: url,
      startedAt,
      finishedAt: new Date().toISOString(),
      pages,
      findings,
      ...score,
      agentStats: stats,
      notes: [
        `GraphQL API at ${url}: ${types.size} types, ${queries.length} queries, ${mutations.length} mutations.`,
        `Ran ${callable.length} read-only queries made from the schema. Mutations change data and were never sent.`,
      ],
      label: { pages: "Endpoints" },
      scanned: [url],
      api: {
        source: "graphql",
        calls: views,
        coverage: {
          documented: queries.length + mutations.length,
          called: callable.length,
          passed: calls.filter((c) => c.status !== null && c.status < 300 && !errorsOf(c.json).length).length,
          skipped: [
            ...queries.filter((f) => !callable.includes(f) && !f.name.startsWith("__")).map((f) => ({ method: "QUERY", path: f.name, why: "Needs arguments the test cannot fill" })),
            ...mutations.map((f) => ({ method: "MUTATION", path: f.name, why: "Changes data: never sent" })),
          ],
        },
        graphql: { queries: queries.length, mutations: mutations.length, types: types.size, introspection: Boolean(schema) },
      },
    };
    return auth.secrets?.length ? redact(result, auth.secrets) : result;
  } finally {
    await request.dispose();
  }
}
