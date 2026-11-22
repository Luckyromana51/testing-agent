import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exampleFor, parseSpec, parseSpecText, type ApiOperation, type Json } from "../engines/openapi.js";
import { which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * API mocks and service virtualisation, in the way Prism and WireMock work: from the client's OpenAPI
 * spec GLV builds a fake of the API that answers every endpoint with an example body built from the
 * spec's schemas. The client runs it in their tests so a payment gateway or a third-party API does not
 * have to be live. We write static example responses plus a tiny self-contained Node mock server and,
 * when Prism is installed, a Prism command too. It only reads the spec, so it is safe.
 */

export interface MockRoute {
  method: string;
  path: string;
  status: number;
  body: Json;
}

/** The success example for one operation (lowest 2xx with a JSON schema, else {}). Pure, for tests. */
export function mockForOperation(spec: Json, op: ApiOperation): MockRoute {
  const codes = Object.keys(op.responses).filter((c) => /^2/.test(c)).sort();
  const code = codes[0] ?? "200";
  const resp = op.responses[code];
  const body = resp?.schema ? exampleFor(spec, resp.schema) : {};
  return { method: op.method.toUpperCase(), path: op.path, status: Number(code) || 200, body };
}

/** Converts an OpenAPI path ({id}) into an Express path (:id). Pure, for tests. */
export function expressPath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, ":$1");
}

/** A tiny dependency-free Node mock server for the routes. Pure, for tests. */
export function mockServer(routes: MockRoute[]): string {
  const table = routes.map((r) => ({ method: r.method, path: expressPath(r.path), status: r.status, body: r.body }));
  return `// GLV API mock — run: node mock-server.js  (listens on PORT or 4010)
// It fakes the API from the OpenAPI spec so tests need no live service.
const http = require("http");
const routes = ${JSON.stringify(table, null, 2)};
function match(method, url) {
  const reqParts = url.split("?")[0].split("/").filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const parts = r.path.split("/").filter(Boolean);
    if (parts.length !== reqParts.length) continue;
    if (parts.every((p, i) => p.startsWith(":") || p === reqParts[i])) return r;
  }
  return null;
}
http.createServer((req, res) => {
  const r = match(req.method, req.url);
  res.setHeader("content-type", "application/json");
  if (!r) { res.statusCode = 404; res.end(JSON.stringify({ error: "no mock for " + req.method + " " + req.url })); return; }
  res.statusCode = r.status;
  res.end(JSON.stringify(r.body));
}).listen(process.env.PORT || 4010, () => console.log("GLV mock on " + (process.env.PORT || 4010)));
`;
}

export const apiMockTool: Tool = {
  id: "api-mock",
  name: "API mocks (service virtualisation)",
  maker: "GLV Infotech (built in), in the way of Prism and WireMock",
  description:
    "From the client's OpenAPI spec, builds a fake of the API that answers every endpoint with an example body from the spec's schemas, so their tests can run without the real payment gateway or third-party service. Produces static example responses and a self-contained Node mock server to run.",
  checks: ["An example success body for every endpoint", "A dependency-free Node mock server to run", "A Prism command when Prism is installed", "Only reads the spec; changes nothing"],
  products: ["api"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://github.com/stoplightio/prism",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    if (!ctx.specFile) throw new Error("This project has no OpenAPI spec. Add one as the API target's spec.");
    const raw = await readFile(ctx.specFile, "utf8");
    const spec = parseSpecText(raw) as Json;
    const parsed = parseSpec(spec, ctx.target.specUrl ?? "mock://spec");
    if (!parsed.operations.length) throw new Error("The spec has no operations to mock.");
    const routes = parsed.operations.map((op) => mockForOperation(spec, op));
    ctx.log(`API mock: ${routes.length} endpoints`);
    const dir = path.join(ctx.outDir, "mock");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "mock-server.js"), mockServer(routes));
    await writeFile(path.join(dir, "responses.json"), JSON.stringify(routes, null, 2));
    await writeFile(ctx.specFile.endsWith(".json") ? path.join(dir, "openapi.json") : path.join(dir, "openapi.yaml"), raw);
    const hasPrism = Boolean(await which(process.env.PRISM_PATH || "prism"));
    const findings: ToolFinding[] = [];
    return {
      findings,
      summary: [
        `Mock built for ${routes.length} endpoints. Run: node mock-server.js (port 4010).`,
        hasPrism ? "Prism is installed: prism mock openapi.(json|yaml) also works." : "Install @stoplight/prism-cli for a fuller mock (validation, dynamic examples).",
      ],
      reports: [
        { file: "mock/mock-server.js", label: "Node mock server" },
        { file: "mock/responses.json", label: "Example responses per endpoint" },
      ],
      tested: `${routes.length} endpoints from the OpenAPI spec`,
    };
  },
};
