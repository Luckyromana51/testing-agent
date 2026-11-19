import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { deref, exampleFor, parseSpec, validateSchema, type ApiOperation, type Json } from "./engines/openapi.js";
import type { ScanQueue } from "./queue.js";
import type { Stores } from "./store.js";
import type { Project, Run } from "./types.js";

/*
 * API project routes: approve the API file as the new version (Changes tab), download the tested
 * endpoints as a Postman collection, and the mock server: our own address per project that answers
 * like the API from its file (examples, or made-up data that fits the schema), checks what it is
 * sent, and keeps the last calls for the project page. Like Prism, WireMock or Postman's mocks.
 */

interface Deps {
  stores: Stores;
  queue: ScanQueue;
  getProject: (id: string) => Project;
  fail: (status: number, message: string) => Error;
}

export interface MockCall {
  at: string;
  method: string;
  path: string;
  status: number;
  /** What was wrong with the request, when it did not fit the file. */
  problems?: string[];
}

const MOCK_LOG = 50;
const MOCK_BODY = 100_000;

export function mockAddress(token: string): string {
  const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");
  return `${base}/mock/${token}`;
}

/** The operation a mock request is for: the method and a path that fits the template. */
export function matchOperation(ops: ApiOperation[], method: string, pathname: string): { op: ApiOperation; params: Record<string, string> } | undefined {
  // Fixed paths win over templates (/users/me before /users/{id}).
  const sorted = [...ops].sort((a, b) => (a.path.match(/\{/g) ?? []).length - (b.path.match(/\{/g) ?? []).length);
  for (const op of sorted) {
    if (op.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp(`^${op.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{([^}]+)\\?\}/g, (_m, n: string) => (names.push(n), "([^/]+)"))}/?$`);
    const m = re.exec(pathname);
    if (m) return { op, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return undefined;
}

/** The answer the mock gives: the first success response, with its example or made-up data. */
export function mockAnswer(spec: Json, op: ApiOperation): { status: number; body: Json; contentType: string } {
  const code = Object.keys(op.responses).sort().find((c) => /^2/.test(c)) ?? "200";
  const r = op.responses[code];
  const status = Number(code) || 200;
  if (status === 204 || !r?.schema) return { status, body: status === 204 ? undefined : {}, contentType: "application/json" };
  // An example given on the response content wins.
  return { status, body: exampleFor(spec, r.schema), contentType: r.contentType ?? "application/json" };
}

/** What is wrong with a mock request: missing required query parameters and a body that does not fit. */
export function checkMockRequest(spec: Json, op: ApiOperation, query: URLSearchParams, body: unknown): string[] {
  const out: string[] = [];
  for (const p of op.params ?? []) if (p.in === "query" && p.required && !query.has(p.name)) out.push(`The query parameter "${p.name}" is required`);
  if (op.body?.required && (body === undefined || body === "")) out.push("A request body is required");
  if (op.body?.schema && body !== undefined && body !== "") {
    const schema = deref(spec, op.body.schema);
    out.push(...validateSchema(spec, schema, body, "body"));
  }
  return out;
}

export function postmanCollection(run: Run, name: string): Json {
  const calls = run.result?.api?.calls ?? [];
  const base = (() => {
    try {
      return new URL(run.result?.scanned?.[1] ?? calls[0]?.url ?? "").toString().replace(/\/+$/, "");
    } catch {
      return "";
    }
  })();
  const seen = new Set<string>();
  const items: Json[] = [];
  for (const c of calls) {
    const key = `${c.method} ${c.path}`;
    if (seen.has(key) || c.step === "no login") continue;
    seen.add(key);
    const raw = base && c.url.startsWith(base) ? `{{baseUrl}}${c.url.slice(base.length)}` : c.url;
    const headers = Object.entries(c.requestHeaders)
      .filter(([k, v]) => v !== "[hidden]" && !/^(accept|authorization)$/i.test(k))
      .map(([key, value]) => ({ key, value }));
    items.push({
      name: key,
      request: {
        method: c.method,
        header: headers,
        url: raw,
        ...(c.requestBody ? { body: { mode: "raw", raw: c.requestBody, options: { raw: { language: "json" } } } } : {}),
      },
      event: [
        {
          listen: "test",
          script: { type: "text/javascript", exec: [`pm.test("answers ${c.status ?? "something"}", function () { pm.response.to.have.status(${c.status ?? 200}); });`] },
        },
      ],
    });
  }
  return {
    info: { name: `${name} (GLV test ${run.finishedAt?.slice(0, 10) ?? ""})`.trim(), schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}", type: "string" }] },
    variable: [
      { key: "baseUrl", value: base },
      { key: "token", value: "" },
    ],
    item: items,
  };
}

export function registerApiRoutes(app: FastifyInstance, { stores, queue, getProject, fail }: Deps): void {
  const mockLogs = new Map<string, MockCall[]>();
  const specCache = new Map<string, { at: number; spec: Json; ops: ApiOperation[] }>();

  /** The file the mock answers from: the approved copy, else the newest test's copy. */
  const mockSpec = async (p: Project): Promise<{ spec: Json; ops: ApiOperation[] } | undefined> => {
    const cached = specCache.get(p.id);
    if (cached && Date.now() - cached.at < 30_000) return cached;
    const files = [queue.apiBaselineFile(p.id), ...(p.lastRunId ? [path.join(queue.artifactsDir(p.lastRunId), "api-spec.json")] : [])];
    for (const f of files) {
      try {
        const spec = JSON.parse(await readFile(f, "utf8"));
        const parsed = parseSpec(spec, "https://mock.invalid/", "https://mock.invalid");
        const entry = { at: Date.now(), spec, ops: [...parsed.operations, ...parsed.writes] };
        specCache.set(p.id, entry);
        return entry;
      } catch {
        /* next */
      }
    }
    return undefined;
  };

  app.post<{ Params: { id: string } }>("/api/runs/:id/api-baseline", async (req) => {
    const run = stores.runs.get(req.params.id);
    if (!run?.projectId || !run.result?.api) throw fail(404, "This test has no API file to approve.");
    try {
      await queue.approveApiFile(run.projectId, run.id);
    } catch {
      throw fail(409, "This test's copy of the API file is gone. Run a new test and approve that one.");
    }
    specCache.delete(run.projectId);
    if (run.result.api.changes) run.result.api.changes = { ...run.result.api.changes, approvedAt: new Date().toISOString() } as typeof run.result.api.changes;
    stores.runs.save(run);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id/postman", async (req, reply) => {
    const run = stores.runs.get(req.params.id);
    if (!run?.result?.api) throw fail(404, "This test has no API calls.");
    const p = run.projectId ? stores.projects.get(run.projectId) : undefined;
    const name = p?.name ?? "API";
    reply.header("Content-Disposition", `attachment; filename="${name.replace(/[^\w.-]+/g, "-")}.postman_collection.json"`);
    reply.type("application/json");
    return JSON.stringify(postmanCollection(run, name), null, 2);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/mock", async (req) => {
    const p = getProject(req.params.id);
    if (!p.mockToken) return { address: null, calls: [], ready: false };
    const spec = await mockSpec(p);
    return { address: mockAddress(p.mockToken), calls: mockLogs.get(p.id) ?? [], ready: Boolean(spec), endpoints: spec?.ops.length ?? 0 };
  });

  // The mock itself: open to the client's front end (no login), only with the project's secret address.
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: MOCK_BODY }, (_req, b, done) => done(null, b));
    scope.route<{ Params: { token: string; "*": string } }>({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
      url: "/mock/:token/*",
      handler: async (req, reply) => {
        const p = stores.projects.list().find((x) => x.type === "api" && x.mockToken && x.mockToken === req.params.token);
        // Front ends on any address may call the mock (it holds no real data and takes no cookies).
        reply.header("Access-Control-Allow-Origin", "*").header("Access-Control-Allow-Headers", "*").header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        reply.header("X-GLV-Mock", "1");
        if (!p) return reply.code(404).send({ error: "No such mock." });
        if (req.method === "OPTIONS") return reply.code(204).send();
        const spec = await mockSpec(p);
        if (!spec) return reply.code(503).send({ error: "Run a test of this API first: the mock answers from its API file." });
        const pathname = `/${req.params["*"] ?? ""}`.split("?")[0];
        const query = new URL(req.url, "http://x").searchParams;
        const log = (status: number, problems?: string[]) => {
          const list = mockLogs.get(p.id) ?? [];
          list.unshift({ at: new Date().toISOString(), method: req.method, path: pathname, status, ...(problems?.length ? { problems } : {}) });
          mockLogs.set(p.id, list.slice(0, MOCK_LOG));
        };
        const method = req.method === "HEAD" ? "GET" : req.method;
        const hit = matchOperation(spec.ops, method, pathname);
        if (!hit) {
          log(404);
          return reply.code(404).send({ error: `The API file has no ${method} ${pathname}.` });
        }
        let body: unknown = req.body;
        if (typeof body === "string" && body.trim() && /json/i.test(String(req.headers["content-type"] ?? ""))) {
          try {
            body = JSON.parse(body);
          } catch {
            log(400, ["The body is not valid JSON"]);
            return reply.code(400).send({ error: "The body is not valid JSON." });
          }
        }
        const problems = checkMockRequest(spec.spec, hit.op, query, body === "" ? undefined : body);
        if (problems.length) {
          log(400, problems);
          return reply.code(400).send({ error: "The request does not fit the API file.", problems });
        }
        const answer = mockAnswer(spec.spec, hit.op);
        // An id in the address shows in the answer, so detail screens look right.
        if (answer.body && typeof answer.body === "object" && !Array.isArray(answer.body)) {
          for (const [k, v] of Object.entries(hit.params)) if (k in answer.body || /^(id|.*Id)$/.test(k)) (answer.body as Record<string, unknown>)[k in answer.body ? k : "id"] = /^\d+$/.test(v) ? Number(v) : v;
        }
        log(answer.status);
        reply.code(answer.status).type(answer.contentType);
        return answer.body === undefined ? reply.send() : reply.send(JSON.stringify(answer.body));
      },
    });
  });
}
