import { createServer, type Server } from "node:http";

/**
 * A small REST API with known, deliberate bugs, and the OpenAPI file that describes it.
 * Used by the tests to prove the API engine finds each kind of problem, and never sends writes.
 */
export interface DemoApi {
  server: Server;
  base: string;
  /** Requests that tried to change data (must stay 0: the engine only reads). */
  writes: () => number;
  /** Requests that carried the demo token, in the Authorization header or the api_key parameter. */
  withToken: () => number;
}

export const DEMO_TOKEN = "demo-token-123";

function spec(base: string) {
  return {
    openapi: "3.0.3",
    info: { title: "Demo Shop API", version: "1.0.0" },
    servers: [{ url: base }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      schemas: {
        Product: {
          type: "object",
          required: ["id", "name", "price"],
          properties: { id: { type: "integer" }, name: { type: "string" }, price: { type: "number" } },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/health": { get: { operationId: "health", security: [], responses: { "200": { description: "ok" } } } },
      "/status": { get: { operationId: "status", responses: { "200": { description: "ok" } } } },
      "/users": {
        get: {
          operationId: "listUsers",
          summary: "List users",
          responses: { "200": { description: "users", content: { "application/json": { schema: { type: "array" } } } } },
        },
        post: { operationId: "createUser", responses: { "201": { description: "created" } } },
      },
      "/users/{id}": {
        get: {
          operationId: "getUser",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer", example: 1 } }],
          responses: { "200": { description: "user" }, "401": { description: "login needed" } },
        },
        delete: { operationId: "deleteUser", responses: { "204": { description: "deleted" } } },
      },
      "/products": {
        get: {
          operationId: "listProducts",
          security: [],
          responses: {
            "200": {
              description: "products",
              content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Product" } } } },
            },
          },
        },
      },
      "/orders": { get: { operationId: "listOrders", security: [], responses: { "200": { description: "orders" } } } },
      "/reports": {
        get: {
          operationId: "listOrders",
          security: [],
          responses: { "200": { description: "reports", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
      "/legacy": { get: { operationId: "legacy", security: [], responses: { "200": { description: "old" } } } },
      "/broken": {
        get: {
          operationId: "broken",
          security: [],
          responses: { "200": { description: "broken", content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  };
}

export function startDemoApi(port = 4200): Promise<DemoApi> {
  let writes = 0;
  let tokens = 0;
  const base = `http://localhost:${port}/v1`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/v1/, "");
    // Bug: any website may call this API with the visitor's cookies (CORS reflects the origin).
    const headers: Record<string, string> = { "x-powered-by": "Express" };
    if (req.headers.origin) {
      headers["access-control-allow-origin"] = req.headers.origin;
      headers["access-control-allow-credentials"] = "true";
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { ...headers, "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (req.headers.authorization === `Bearer ${DEMO_TOKEN}` || url.searchParams.get("api_key") === DEMO_TOKEN) tokens++;
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")) {
      writes++;
      return json(405, { error: "no writes in the demo" });
    }
    if (url.pathname === "/openapi.json") return json(200, spec(base));
    const authed = /^Bearer \w+/.test(req.headers.authorization ?? "");

    if (path === "/health") return json(200, { status: "ok" });
    // Marked as needing login, but a health check: should be public in the file.
    if (path === "/status") return json(200, { status: "ok" });
    // Bug: needs a login per the file, but answers anyone, with password hashes and e-mail addresses.
    if (path === "/users") {
      return json(200, [
        { id: 1, name: "Asha", email: "asha@example.in", passwordHash: "$2b$10$abcdefghijklmnopqrstuv" },
        { id: 2, name: "Ravi", email: "ravi@example.in", passwordHash: "$2b$10$bcdefghijklmnopqrstuvw" },
        { id: 3, name: "Meera", email: "meera@example.in", passwordHash: "$2b$10$cdefghijklmnopqrstuvwx" },
      ]);
    }
    const user = path.match(/^\/users\/([^/]+)$/);
    if (user) {
      // Bug: a wrong-type id reaches the database and the error leaks.
      if (!/^\d+$/.test(user[1])) {
        res.writeHead(500, { ...headers, "content-type": "text/plain" });
        return res.end(`SQLSTATE[22P02]: invalid input syntax for type integer: "${user[1]}"\n    at Query.run (/srv/app/db.js:41:13)`);
      }
      return authed ? json(200, { id: 1 }) : json(401, { error: "Login required" });
    }
    if (path === "/products") {
      // Bug: slow, and price is a string where the file says number.
      setTimeout(() => json(200, [{ id: 1, name: "Mug", price: "199.00" }]), 1200);
      return;
    }
    // Bug: crashes.
    if (path === "/orders") return json(500, { error: "Internal Server Error" });
    // Bug: a website catch-all answers instead of the API.
    if (path === "/reports") {
      res.writeHead(200, { ...headers, "content-type": "text/html" });
      return res.end("<!doctype html><html><body><div id=app></div></body></html>");
    }
    // Bug: says JSON, sends something that does not parse.
    if (path === "/broken") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      return res.end("{ items: [1, 2, ");
    }
    // /legacy and anything else: gone.
    return json(404, { error: "Not found" });
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, base, writes: () => writes, withToken: () => tokens })));
}

if (process.argv[1]?.endsWith("demo-api.ts")) {
  startDemoApi().then(({ base }) => console.log(`Demo API: ${base} (spec at http://localhost:4200/openapi.json)`));
}
