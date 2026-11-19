import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A second demo API, for the API module: a small CRM API with a login token, two companies, a
 * staff role, a test-server mode and a GraphQL endpoint, each with planted bugs:
 *
 * - /customers/{id} has no example id (the test must take a real one from GET /customers)
 * - company B's token reads company A's customer (BOLA); the staff token reads /admin/stats (BFLA)
 * - no rate limit; ?limit=10000 returns 2,000 rows; /actuator/env is open; /v1 still answers
 * - tokens are signed with "secret", never end, and the signature is never checked
 * - a customer's email is not an email; answers carry an undocumented internalNotes field
 * - a deprecated endpoint sends no Deprecation header
 * - writes: empty bodies are saved, isAdmin is saved (mass assignment), PATCH is ignored,
 *   notes cannot be deleted
 * - GraphQL: introspection, suggestions with a stack trace, no depth or alias limit, batching,
 *   GET queries, password hashes in answers, a query that crashes
 */

export interface DemoApi2 {
  server: Server;
  base: string;
  graphql: string;
  /** Writes received (POST, PUT, PATCH, DELETE), GraphQL excluded. */
  writes: () => number;
  /** Records still on the server that the tests made. */
  leftOver: () => string[];
  calls: () => number;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
export function signToken(payload: object, key = "secret"): string {
  const h = b64({ alg: "HS256", typ: "JWT" });
  const p = b64(payload);
  return `${h}.${p}.${createHmac("sha256", key).update(`${h}.${p}`).digest("base64url")}`;
}
export const TOKEN_A = signToken({ sub: "u1", company: "A", role: "admin" });
export const TOKEN_B = signToken({ sub: "u9", company: "B", role: "admin" });
export const TOKEN_STAFF = signToken({ sub: "u2", company: "A", role: "staff" });

export function spec2(base: string, opts: { removeField?: boolean } = {}) {
  const customer: Record<string, unknown> = {
    type: "object",
    required: ["id", "name", "email"],
    properties: {
      id: { type: "integer", readOnly: true },
      name: { type: "string", maxLength: 80 },
      email: { type: "string", format: "email" },
      phone: { type: "string" },
      ...(opts.removeField ? {} : { city: { type: "string" } }),
    },
  };
  const newCustomer = { type: "object", required: ["name", "email"], properties: { name: { type: "string" }, email: { type: "string", format: "email" }, age: { type: "integer" } } };
  const listOf = (ref: string) => ({ type: "object", properties: { data: { type: "array", items: { $ref: ref } } } });
  return {
    openapi: "3.0.3",
    info: { title: "Demo CRM API", version: "2.0.0" },
    servers: [{ url: base }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas: { Customer: customer, NewCustomer: newCustomer },
    },
    security: [{ bearer: [] }],
    paths: {
      "/customers": {
        get: {
          operationId: "listCustomers",
          summary: "List customers",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", maximum: 100 } }],
          responses: { "200": { description: "ok", content: { "application/json": { schema: listOf("#/components/schemas/Customer") } } }, "401": { description: "login" } },
        },
        post: {
          operationId: "createCustomer",
          summary: "Create a customer",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/NewCustomer" } } } },
          responses: { "201": { description: "created", content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } }, "422": { description: "bad input" } },
        },
      },
      "/customers/{id}": {
        get: {
          operationId: "getCustomer",
          summary: "One customer",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Customer" } } } }, "404": { description: "none" } },
        },
        patch: {
          operationId: "updateCustomer",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewCustomer" } } } },
          responses: { "200": { description: "ok" }, "404": { description: "none" } },
        },
        delete: {
          operationId: "deleteCustomer",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { "204": { description: "gone" }, "404": { description: "none" } },
        },
      },
      "/notes": {
        post: {
          operationId: "createNote",
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { text: { type: "string", example: "Call back" } } } } } },
          responses: { "201": { description: "created" }, "400": { description: "bad" } },
        },
      },
      "/admin/stats": { get: { operationId: "adminStats", responses: { "200": { description: "ok" }, "403": { description: "no" } } } },
      "/legacy-report": { get: { operationId: "legacyReport", deprecated: true, responses: { "200": { description: "ok", headers: { "X-Report-Id": { schema: { type: "string" } } } } } } },
    },
  };
}

const INTROSPECTION = {
  __schema: {
    queryType: { name: "Query" },
    mutationType: { name: "Mutation" },
    subscriptionType: null,
    types: [
      {
        kind: "OBJECT",
        name: "Query",
        fields: [
          { name: "users", isDeprecated: false, args: [], type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "User", ofType: null } } },
          { name: "me", isDeprecated: false, args: [], type: { kind: "OBJECT", name: "User", ofType: null } },
          { name: "crash", isDeprecated: false, args: [], type: { kind: "SCALAR", name: "String", ofType: null } },
          { name: "user", isDeprecated: false, args: [{ name: "id", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } }, defaultValue: null }], type: { kind: "OBJECT", name: "User", ofType: null } },
        ],
      },
      {
        kind: "OBJECT",
        name: "User",
        fields: [
          { name: "id", isDeprecated: false, args: [], type: { kind: "SCALAR", name: "ID", ofType: null } },
          { name: "name", isDeprecated: false, args: [], type: { kind: "SCALAR", name: "String", ofType: null } },
          { name: "passwordHash", isDeprecated: false, args: [], type: { kind: "SCALAR", name: "String", ofType: null } },
          { name: "friends", isDeprecated: false, args: [], type: { kind: "LIST", name: null, ofType: { kind: "OBJECT", name: "User", ofType: null } } },
        ],
      },
      { kind: "OBJECT", name: "Mutation", fields: [{ name: "deleteUser", isDeprecated: false, args: [{ name: "id", type: { kind: "NON_NULL", name: null, ofType: { kind: "SCALAR", name: "ID", ofType: null } }, defaultValue: null }], type: { kind: "SCALAR", name: "Boolean", ofType: null } }] },
      { kind: "SCALAR", name: "String", fields: null },
      { kind: "SCALAR", name: "ID", fields: null },
    ],
  },
};

const USERS = [
  { id: "1", name: "Asha", passwordHash: "$2b$10$abcdefghijklmnopqrstuv", friends: [] },
  { id: "2", name: "Ravi", passwordHash: "$2b$10$bcdefghijklmnopqrstuvw", friends: [] },
];

function gql(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(() => ({ data: { __typename: "Query" } }));
  const q = String((body as { query?: string })?.query ?? "");
  if (q.includes("__schema")) return { data: INTROSPECTION };
  if (q.includes("__typenme")) return { errors: [{ message: 'Cannot query field "__typenme" on type "Query". Did you mean "__typename"?', extensions: { code: "GRAPHQL_VALIDATION_FAILED", exception: { stacktrace: ["GraphQLError: Cannot query field", "    at Object.Field (/srv/node_modules/graphql/validation/rules/FieldsOnCorrectTypeRule.js:51:13)"] } } }] };
  if (q.includes("GlvAliases")) return { data: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`a${i}`, "Query"])) };
  if (q.includes("GlvDepth")) return { data: { users: [] } };
  const read = /GlvRead \{ (\w+)/.exec(q)?.[1];
  if (read === "users") return { data: { users: USERS } };
  if (read === "me") return { data: { me: USERS[0] } };
  if (read === "crash") return { data: { crash: null }, errors: [{ message: "Unexpected error value: db is not defined", extensions: { code: "INTERNAL_SERVER_ERROR" } }] };
  if (/__typename/.test(q)) return { data: { __typename: "Query" } };
  return { errors: [{ message: "Unknown query" }] };
}

export function startDemoApi2(port = 4230): Promise<DemoApi2> {
  let writes = 0;
  let calls = 0;
  let nextId = 900;
  // Company A's customers 501 and 502; company B's 601.
  const customers = new Map<number, Record<string, unknown>>([
    [501, { id: 501, company: "A", name: "Asha Traders", email: "asha@example.in", phone: "+919800000001", city: "Pune", internalNotes: "pays late" }],
    [502, { id: 502, company: "A", name: "Ravi Stores", email: "not-an-email", phone: "+919800000002", city: "Delhi", internalNotes: "" }],
    [601, { id: 601, company: "B", name: "B Corp", email: "b@example.in", phone: "+919800000003", city: "Mumbai", internalNotes: "" }],
  ]);
  const notes: number[] = [];
  const base = `http://localhost:${port}/v2`;
  const server = createServer((req, res) => {
    calls++;
    const url = new URL(req.url ?? "/", "http://x");
    const method = req.method ?? "GET";
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* not JSON */
      }
      if (url.pathname === "/openapi.json") return send(200, spec2(base));
      if (url.pathname === "/graphql") {
        if (method === "GET") return send(200, gql({ query: url.searchParams.get("query") }));
        return send(200, gql(body));
      }
      if (url.pathname === "/actuator/env") return send(200, { activeProfiles: ["prod"], propertySources: [{ name: "env", properties: { DB_PASSWORD: { value: "******" } } }] });
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) writes++;
      // Bug: the token's payload is read, its signature never checked.
      const auth = req.headers.authorization ?? "";
      let who: { company?: string; role?: string } | undefined;
      if (auth.startsWith("Bearer ")) {
        try {
          who = JSON.parse(Buffer.from(auth.slice(7).split(".")[1] ?? "", "base64url").toString("utf8"));
        } catch {
          who = undefined;
        }
      }
      // /v1 is the old version, still answering (bug).
      const path = url.pathname.replace(/^\/v[12]/, "");
      if (!url.pathname.startsWith("/v2") && !url.pathname.startsWith("/v1")) return send(404, { error: "not found" });
      if (!who) return send(401, { error: "login required" });
      if (path === "/customers" && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const mine = [...customers.values()].filter((c) => c.company === who!.company).map(({ company: _c, ...rest }) => rest);
        // Bug: no cap on the page size.
        const rows = limit > 100 ? Array.from({ length: 2000 }, (_, i) => ({ id: 10_000 + i, name: `Row ${i}`, email: `r${i}@example.in` })) : mine.slice(0, limit);
        return send(200, { data: rows });
      }
      if (path === "/customers" && method === "POST") {
        // Bug: no check of required fields; bug: every field is saved (mass assignment).
        const id = nextId++;
        const rec = { ...body, id: typeof body.id === "number" ? id : id, company: who.company };
        customers.set(id, rec);
        const { company: _c, ...out } = rec;
        return send(201, out, { location: `${base}/customers/${id}` });
      }
      const m = /^\/customers\/(\d+)$/.exec(path);
      if (m) {
        const id = Number(m[1]);
        const rec = customers.get(id);
        // Bug: the record's company is never compared with the caller's (BOLA).
        if (!rec) return send(404, { error: "no such customer" });
        if (method === "GET") {
          const { company: _c, ...out } = rec;
          return send(200, out);
        }
        if (method === "PATCH") return send(200, { ok: true }); // Bug: ignores the change.
        if (method === "DELETE") {
          customers.delete(id);
          return send(204, undefined);
        }
      }
      if (path === "/notes" && method === "POST") {
        const id = nextId++;
        notes.push(id);
        return send(201, { id, text: body.text });
      }
      // Bug: any role reads the admin numbers (BFLA).
      if (path === "/admin/stats") return send(200, { customers: customers.size, revenue: 120000 });
      if (path === "/legacy-report") return send(200, { rows: 3 });
      return send(404, { error: "not found" });
    });
  });
  return new Promise((resolve) =>
    server.listen(port, () =>
      resolve({
        server,
        base,
        graphql: `http://localhost:${port}/graphql`,
        writes: () => writes,
        calls: () => calls,
        leftOver: () => [...[...customers.keys()].filter((k) => k >= 900).map((k) => `customer ${k}`), ...notes.map((n) => `note ${n}`)],
      }),
    ),
  );
}
