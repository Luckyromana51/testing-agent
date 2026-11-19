import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { diffSpecs } from "../src/agents/api/changes.js";
import { auditSpec } from "../src/agents/api/lint.js";
import { parseExpect, parseScenario } from "../src/agents/api/scenarios.js";
import { weakSecret } from "../src/agents/api/tokens.js";
import { scanApi } from "../src/engines/api.js";
import { fromCurl, fromHar, fromPostman, readSource, templatePath } from "../src/engines/api-source.js";
import { exampleFor, parseSpec, validateSchema } from "../src/engines/openapi.js";
import type { RoleLogin, ScanResult } from "../src/types.js";
import { spec2, startDemoApi2, TOKEN_A, TOKEN_B, TOKEN_STAFF, type DemoApi2 } from "./fixtures/demo-api2.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.API_SAMPLES = "3";
const rules = (r: ScanResult) => new Set(r.findings.map((f) => f.rule));
const roles: RoleLogin[] = [
  { id: "b", name: "Other company", otherCompany: true, login: { kind: "api", authType: "bearer", token: TOKEN_B } },
  { id: "s", name: "Staff", mustNotOpen: "/admin*", login: { kind: "api", authType: "bearer", token: TOKEN_STAFF } },
];

describe("API module: reading the file", () => {
  it("checks formats, lengths, ranges and extra fields", () => {
    const schema = { type: "object", additionalProperties: false, properties: { email: { type: "string", format: "email" }, n: { type: "integer", maximum: 5 }, s: { type: "string", maxLength: 3 } } };
    const p = validateSchema({}, schema, { email: "x", n: 9, s: "long", extra: 1 });
    assert.ok(p.includes("$.email is not a valid email"));
    assert.ok(p.includes("$.n is above the maximum 5"));
    assert.ok(p.includes("$.s is longer than 3 characters"));
    assert.ok(p.some((x) => x.includes("fields the file does not allow: extra")));
    const extra: string[] = [];
    validateSchema({}, { type: "object", properties: { a: { type: "string" } } }, { a: "x", b: 2 }, "$", [], 0, { extra });
    assert.deepEqual(extra, ["$.b"]);
  });

  it("makes example bodies that fit the schema, the same every time", () => {
    const spec = spec2("https://x.test/v2");
    const a = exampleFor(spec, { $ref: "#/components/schemas/NewCustomer" });
    assert.deepEqual(a, exampleFor(spec, { $ref: "#/components/schemas/NewCustomer" }));
    assert.equal(a.email, "glv-test@example.com");
    assert.deepEqual(validateSchema(spec, { $ref: "#/components/schemas/NewCustomer" }, a), []);
  });

  it("reads write operations with their bodies, and marks guessed ids", () => {
    const p = parseSpec(spec2("https://x.test/v2"), "https://x.test/");
    assert.equal(p.writes.length, 4);
    assert.ok(p.writes.find((o) => o.method === "POST" && o.path === "/customers")?.body?.schema);
    assert.deepEqual(p.operations.find((o) => o.path === "/customers/{id}")?.guessed, ["id"]);
  });

  it("imports Postman collections, HAR files and cURL commands", () => {
    const postman = fromPostman({
      info: { name: "Shop", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      variable: [{ key: "base", value: "https://api.shop.test" }],
      item: [{ name: "Folder", item: [{ name: "Get order", request: { method: "GET", url: { raw: "{{base}}/orders/42?expand=items" } } }] }, { name: "New", request: { method: "POST", url: "{{base}}/orders", body: { mode: "raw", raw: '{"sku":"A1"}' } } }],
    });
    assert.equal(postman.servers[0].url, "https://api.shop.test");
    assert.ok(postman.paths["/orders/{id}"].get);
    assert.ok(postman.paths["/orders"].post.requestBody);
    const har = fromHar({ log: { entries: [{ _resourceType: "fetch", request: { method: "GET", url: "https://app.test/api/users/7", headers: [] }, response: { status: 200, content: { mimeType: "application/json", text: '{"id":7,"name":"A"}' } } }] } });
    assert.ok(har.paths["/api/users/{id}"].get.responses["200"].content);
    const curl = fromCurl(`curl 'https://api.test/v1/items?page=2' -H 'X-Tenant: 4'\ncurl -X DELETE https://api.test/v1/items/9`);
    assert.ok(curl.paths["/v1/items"].get.parameters.some((p: { name: string }) => p.name === "x-tenant"));
    assert.ok(curl.paths["/v1/items/{id}"].delete);
    assert.equal(readSource("curl https://a.test/x").kind, "curl");
    assert.deepEqual(templatePath("/users/42/orders/9"), { path: "/users/{userId}/orders/{id}", examples: { userId: "42", id: "9" } });
  });

  it("audits the file with a fixed score", () => {
    const a = auditSpec(spec2("http://api.example.com/v2"));
    const b = auditSpec(spec2("http://api.example.com/v2"));
    assert.equal(a.score, b.score);
    assert.ok(a.hits.has("http-server"));
    assert.ok(a.hits.has("body-open"));
    assert.ok(a.hits.has("no-rate-limit-doc"));
    assert.ok(a.score < 100 && a.score > 0);
  });

  it("lists breaking and safe changes", () => {
    const before = spec2("https://x.test/v2");
    const after = spec2("https://x.test/v2", { removeField: true });
    (after.paths as Record<string, unknown>)["/tags"] = { get: { responses: { "200": { description: "ok" } } } };
    const list = diffSpecs(before, after);
    assert.ok(list.some((c) => c.kind === "breaking" && c.where === "GET /customers/{id}" && c.text === 'Answer field "city" was removed'));
    assert.ok(list.some((c) => c.kind === "safe" && c.where === "GET /tags"));
    assert.deepEqual(diffSpecs(before, before), []);
  });

  it("reads scenario steps and refuses lines it does not know", () => {
    const steps = parseScenario("GET /customers\nexpect status 200\nsave id = $.data[0].id\nGET /customers/{{id}}\nexpect $.name exists\nexpect time < 2 s");
    assert.equal(steps.length, 6);
    assert.deepEqual(parseExpect("status 2xx or 404"), { kind: "status", codes: ["2xx", "404"] });
    assert.throws(() => parseScenario("GET /a\nclick the button"), /Line 2/);
    assert.throws(() => parseScenario("expect status 200"), /at least one request/);
  });

  it("finds a token signed with a well-known key", () => {
    assert.equal(weakSecret(TOKEN_A), "secret");
  });
});

describe("API module on the demo CRM API (live: reads only)", () => {
  let demo: DemoApi2;
  let result: ScanResult;
  let dir: string;
  before(async () => {
    demo = await startDemoApi2(4231);
    dir = await mkdtemp(path.join(os.tmpdir(), "glv-api-"));
    result = await scanApi({
      specUrl: "http://localhost:4231/openapi.json",
      auth: { kind: "api", authType: "bearer", token: TOKEN_A },
      roles,
      scenarios: [
        { id: "s1", name: "Open the first customer", steps: "GET /customers\nexpect status 200\nsave id = $.data[0].id\nGET /customers/{{id}}\nexpect status 200\nexpect $.name exists" },
        { id: "s2", name: "VIP flag", steps: "GET /customers/501\nexpect $.vip == true" },
        { id: "s3", name: "Make a customer", steps: 'POST /customers\nbody {"name":"x"}\nexpect status 201' },
      ],
      baseline: { spec: spec2("http://localhost:4231/v2", { removeField: false }), at: "2026-11-01T00:00:00.000Z" },
      artifactsDir: dir,
    });
  });
  after(async () => {
    demo.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("never changes data on a server that is not a test server", () => {
    assert.equal(demo.writes(), 0);
    assert.equal(result.api?.writes?.ran, false);
    assert.ok(result.api?.coverage.skipped.some((s) => s.method === "POST" && /test server/.test(s.why)));
  });

  it("calls detail endpoints with real ids from the list", () => {
    const c = result.api!.calls.find((x) => x.path === "/customers/{id}")!;
    assert.match(c.url, /\/customers\/501$/);
    assert.match(c.idFrom ?? "", /GET \/customers → \$\.data\[0\]\.id/);
    assert.equal(c.status, 200);
    assert.equal(c.samples, 3);
    assert.equal(c.requestHeaders.authorization, "[hidden]");
  });

  it("finds each planted bug", () => {
    const found = rules(result);
    for (const rule of [
      "api:bola",
      "api:bfla",
      "api:no-rate-limit",
      "api:no-page-limit",
      "api:debug-endpoint",
      "api:old-version-live",
      "api:jwt-weak-key",
      "api:jwt-no-expiry",
      "api:jwt-forged-accepted",
      "api:schema-mismatch",
      "api:undocumented-fields",
      "api:deprecated-no-warning",
      "api:missing-header",
      "api:scenario-failed",
      "api:audit-no-rate-limit-doc",
      "api:audit-body-open",
    ]) {
      assert.ok(found.has(rule), `expected ${rule}`);
    }
  });

  it("shows who can read what", () => {
    const grid = result.api!.access!;
    assert.deepEqual(grid.accounts, ["Main login", "Other company", "Staff", "No login"]);
    const row = grid.rows.find((r) => r.path === "/customers/{id}")!;
    assert.equal(row.cells["Other company"].bad, "Reads another company's record");
    assert.equal(row.cells["No login"].status, 401);
    assert.equal(grid.rows.find((r) => r.path === "/admin/stats")!.cells.Staff.bad, "Forbidden endpoint answers");
  });

  it("runs scenarios step by step, and blocks writes on a live server", () => {
    const [ok, vip, write] = result.api!.scenarios!;
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.match(ok.steps[1].call!.url, /\/customers\/501$/);
    assert.equal(vip.ok, false);
    assert.equal(vip.steps[0].checks![0].actual, "nothing");
    assert.equal(write.ok, false);
    assert.deepEqual(write.blocked, ["POST /customers"]);
    const f = result.findings.find((x) => x.rule === "api:scenario-failed" && x.title.includes("VIP"))!;
    assert.equal(f.evidence, "Line 2: expect $.vip == true");
  });

  it("lists nothing changed against the same file, and keeps a copy of it", async () => {
    assert.deepEqual(result.api!.changes!.list, []);
    const saved = JSON.parse(await readFile(path.join(dir, "api-spec.json"), "utf8"));
    assert.equal(saved.info.title, "Demo CRM API");
  });

  it("reports breaking changes against an older approved file", async () => {
    const r = await scanApi({
      specUrl: "http://localhost:4231/openapi.json",
      auth: { kind: "api", authType: "bearer", token: TOKEN_A },
      agents: ["api.changes"],
      baseline: { spec: { ...spec2("http://localhost:4231/v2"), paths: { ...spec2("http://localhost:4231/v2").paths, "/old": { get: { responses: { "200": { description: "ok" } } } } } }, at: "2026-11-01T00:00:00.000Z" },
    });
    const f = r.findings.find((x) => x.rule === "api:breaking-change")!;
    assert.equal(f.evidence, "GET /old: The endpoint was removed");
  });
});

describe("API module in test-server mode", () => {
  let demo: DemoApi2;
  let result: ScanResult;
  before(async () => {
    demo = await startDemoApi2(4232);
    result = await scanApi({
      specUrl: "http://localhost:4232/openapi.json",
      auth: { kind: "api", authType: "bearer", token: TOKEN_A },
      testServer: true,
      agents: ["api.writes", "api.scenarios"],
      scenarios: [{ id: "w", name: "Create then delete", steps: 'POST /customers\nbody {"name":"GLV {{today}}","email":"a@b.in"}\nexpect status 201\nsave id = $.id', cleanup: "DELETE /customers/{{id}}" }],
    });
  });
  after(() => demo.server.close());

  it("creates, reads, changes and deletes, and finds the write bugs", () => {
    const found = rules(result);
    for (const rule of ["api:mass-assignment", "api:no-input-validation", "api:update-not-saved", "api:test-data-left"]) assert.ok(found.has(rule), `expected ${rule}`);
    assert.ok(!found.has("api:delete-not-deleted"));
    const steps = result.api!.calls.filter((c) => c.step).map((c) => c.step);
    for (const s of ["create", "read back", "change", "delete", "read after delete"]) assert.ok(steps.includes(s), `step ${s}`);
  });

  it("cleans up every customer it made; notes cannot be deleted and are listed", () => {
    assert.deepEqual(demo.leftOver().filter((x) => x.startsWith("customer")), []);
    assert.ok(result.api!.writes!.leftOver.every((x) => x.startsWith("/notes/")));
    assert.equal(result.api!.scenarios![0].ok, true);
  });
});

describe("API module: GraphQL", () => {
  let demo: DemoApi2;
  let result: ScanResult;
  before(async () => {
    demo = await startDemoApi2(4233);
    result = await scanApi({ graphqlUrl: "http://localhost:4233/graphql" });
  });
  after(() => demo.server.close());

  it("finds the GraphQL bugs and never sends a mutation", () => {
    const found = rules(result);
    for (const rule of ["api:gql-introspection", "api:gql-suggestions", "api:gql-no-depth-limit", "api:gql-no-alias-limit", "api:gql-batching", "api:gql-get-csrf", "api:gql-query-error", "api:secret-in-response", "api:error-leak"]) {
      assert.ok(found.has(rule), `expected ${rule}`);
    }
    assert.ok(!result.api!.calls.some((c) => /deleteUser/.test(c.requestBody ?? "")));
    assert.deepEqual(result.api!.graphql, { queries: 4, mutations: 1, types: 5, introspection: true });
  });
});

describe("API module: same API, same result", () => {
  let demo: DemoApi2;
  before(async () => {
    demo = await startDemoApi2(4234);
  });
  after(() => demo.server.close());

  it("gives the same issues twice", async () => {
    const run = () => scanApi({ specUrl: "http://localhost:4234/openapi.json", auth: { kind: "api", authType: "bearer", token: TOKEN_A }, roles });
    const a = await run();
    const b = await run();
    const ids = (r: ScanResult) => r.findings.map((f) => `${f.id} ${f.rule} ${f.evidence}`).sort();
    assert.deepEqual(ids(a), ids(b));
    assert.equal(a.overallScore, b.overallScore);
    assert.deepEqual(a.api!.access, b.api!.access);
  });
});
