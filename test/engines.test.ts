import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { strToU8, zipSync } from "fflate";
import { compareVersions, fixedVersion, readDependencies } from "../src/agents/code/packages.js";
import { inLiteral } from "../src/agents/code/risky.js";
import { elfMinAlign } from "../src/agents/mobile/android.js";
import { scanApi } from "../src/engines/api.js";
import { scanApk } from "../src/engines/apk.js";
import { parseAxml } from "../src/engines/axml.js";
import { readZip, scanCode, validateRepoUrl } from "../src/engines/code.js";
import { parseSpec, validateSchema } from "../src/engines/openapi.js";
import { syncIssues } from "../src/issues.js";
import { createApp } from "../src/server.js";
import type { Project, Run, ScanResult } from "../src/types.js";
import { startDemoApi, type DemoApi } from "./fixtures/demo-api.js";
import { buildDemoApk, elfWithAlign, encodeAxml, FAKE_AWS_KEY } from "./fixtures/demo-apk.js";
import { plantedIpa, simulatorAppZip } from "./fixtures/demo-ipa.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
// The outside tools have their own tests (tools.test.ts); here tests run only the platform's checks.
process.env.DEFAULT_TOOLS = "none";
const rules = (r: ScanResult) => new Set(r.findings.map((f) => f.rule));

describe("OpenAPI reader", () => {
  it("reads OpenAPI 3 servers, example path values, required query values and security", () => {
    const parsed = parseSpec(
      {
        openapi: "3.1.0",
        servers: [{ url: "/api/{version}", variables: { version: { default: "v2" } } }],
        security: [{ key: [] }],
        components: { securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } } },
        paths: {
          "/items/{id}": {
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
            get: { parameters: [{ name: "page", in: "query", required: true, schema: { type: "integer", default: 3 } }], responses: {} },
            delete: {},
          },
          "/public": { get: { security: [{}] } },
          "/needs-header": { get: { parameters: [{ name: "X-Tenant", in: "header", required: true }] } },
        },
      },
      "https://example.com/docs/openapi.json",
    );
    assert.equal(parsed.baseUrl, "https://example.com/api/v2");
    assert.equal(parsed.writeOperations, 1);
    assert.ok(parsed.hasSecuritySchemes);
    const [items, pub, header] = parsed.operations;
    assert.equal(items.url, "https://example.com/api/v2/items/1?page=3");
    assert.equal(items.secured, true);
    assert.equal(pub.secured, false, "an empty security entry makes it public");
    assert.match(header.skip ?? "", /X-Tenant/);
  });

  it("reads Swagger 2 host and basePath", () => {
    const parsed = parseSpec({ swagger: "2.0", host: "api.shop.in", basePath: "/v1", schemes: ["https"], paths: { "/a": { get: {} } } }, "https://x.com/s.json");
    assert.equal(parsed.operations[0].url, "https://api.shop.in/v1/a");
  });

  it("checks answers against a schema", () => {
    const spec = { components: { schemas: { P: { type: "object", required: ["id"], properties: { id: { type: "integer" }, tags: { type: "array", items: { type: "string" } } } } } } };
    assert.deepEqual(validateSchema(spec, { $ref: "#/components/schemas/P" }, { id: 1, tags: ["a"] }), []);
    const problems = validateSchema(spec, { $ref: "#/components/schemas/P" }, { tags: [1] });
    assert.ok(problems.includes("$.id is missing"));
    assert.ok(problems.some((p) => p.startsWith("$.tags[0] is integer")));
  });
});

describe("API engine on the demo API", () => {
  let demo: DemoApi;
  let result: ScanResult;
  before(async () => {
    demo = await startDemoApi(4210);
    result = await scanApi({ specUrl: "http://localhost:4210/openapi.json" });
  });
  after(() => demo.server.close());

  it("never sends a request that changes data", () => {
    assert.equal(demo.writes(), 0);
    assert.ok(result.notes?.some((n) => n.includes("2 operations that change data")));
  });

  it("calls every read-only endpoint and labels them as endpoints", () => {
    assert.equal(result.pages.length, 9);
    assert.equal(result.label?.pages, "Endpoints");
    assert.deepEqual(Object.keys(result.scores).sort(), ["functional", "performance", "security"]);
  });

  it("finds each planted bug", () => {
    const found = rules(result);
    for (const rule of [
      "api:auth-bypass",
      "api:secret-in-response",
      "api:personal-data-public",
      "api:error-leak",
      "api:server-error",
      "api:missing-endpoint",
      "api:not-json",
      "api:invalid-json",
      "api:schema-mismatch",
      "api:slow",
      "api:public-marked-secured",
      "api:cors-reflect",
      "api:no-https",
      "api:version-disclosure",
      "api:spec-duplicate-id",
    ]) {
      assert.ok(found.has(rule), `expected ${rule}`);
    }
  });

  it("does not flag the endpoints that behave", () => {
    const at = (p: string) => result.findings.filter((f) => f.pageUrl.endsWith(p)).map((f) => f.rule);
    assert.deepEqual(at("/v1/health"), [], "a public health check is fine");
    assert.ok(!result.findings.some((f) => f.rule === "api:auth-bypass" && f.pageUrl.endsWith("/users/1")), "401 without login is right");
    assert.ok(!found("api:no-auth-described"), "the file does describe a login");
    function found(rule: string) {
      return rules(result).has(rule);
    }
  });

  it("points the leak at the documented endpoint, so a re-test can verify the fix", () => {
    const leak = result.findings.find((f) => f.rule === "api:error-leak")!;
    assert.ok(result.pages.some((p) => p.url === leak.pageUrl));
    assert.match(leak.evidence ?? "", /SQLSTATE/);
  });

  it("refuses an API file that points at a private address unless allowed", async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "";
    try {
      await assert.rejects(
        scanApi({ specText: JSON.stringify({ openapi: "3.0.0", servers: [{ url: "http://10.0.0.5/api" }], paths: {} }) }),
        /Private and local addresses are blocked/,
      );
    } finally {
      process.env.ALLOW_PRIVATE_TARGETS = "1";
    }
  });
});

describe("source code engine", () => {
  let osv: Server;
  let dir: string;
  let result: ScanResult;
  before(async () => {
    // A stand-in for the OSV vulnerability database.
    osv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/querybatch") {
          const { queries } = JSON.parse(body) as { queries: { package: { name: string }; version: string }[] };
          return res.end(JSON.stringify({ results: queries.map((q) => (q.package.name === "lodash" ? { vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] } : {})) }));
        }
        res.end(
          JSON.stringify({
            id: "GHSA-35jh-r3h4-6jhm",
            summary: "Command Injection in lodash",
            aliases: ["CVE-2021-23337"],
            database_specific: { severity: "HIGH" },
            affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
          }),
        );
      });
    });
    await new Promise<void>((r) => osv.listen(4220, r));
    process.env.OSV_URL = "http://localhost:4220";

    dir = await mkdtemp(path.join(tmpdir(), "glv-code-"));
    const zip = zipSync({
      "shop/config.js": strToU8(`module.exports = { awsKey: "${FAKE_AWS_KEY}", region: "ap-south-1" };\n`),
      "shop/db.php": strToU8(`<?php\n$r = mysqli_query($conn, "SELECT * FROM users WHERE id = " . $_GET['id']);\necho $_GET['q'];\n`),
      "shop/login.php": strToU8(`<?php\n$hash = md5($password);\n`),
      "shop/settings.json": strToU8(`{ "theme": "dark", }`),
      "shop/package.json": strToU8(JSON.stringify({ name: "shop", dependencies: { lodash: "^4.17.15" } })),
      "shop/package-lock.json": strToU8(
        JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "shop" }, "node_modules/lodash": { version: "4.17.15" }, "node_modules/left-pad": { version: "1.3.0" } } }),
      ),
      "shop/.env": strToU8("DB_PASSWORD=hunter2hunter2\n"),
      "shop/test/fixture.js": strToU8(`const password = "notarealpassword123";\n`),
      "shop/node_modules/x/index.js": strToU8(`eval(code)`),
      "shop/utils.js": strToU8("export const add = (a, b) => a + b;\n"),
    });
    await writeFile(path.join(dir, "code.zip"), zip);
    result = await scanCode({ zipFile: path.join(dir, "code.zip"), workDir: dir });
  });
  after(async () => {
    osv.close();
    delete process.env.OSV_URL;
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the planted problems", () => {
    const found = rules(result);
    for (const rule of ["code:secret-aws-key", "code:sql-injection", "code:xss", "code:weak-password-hash", "code:broken-json", "code:vulnerable-package", "code:no-readme"]) {
      assert.ok(found.has(rule), `expected ${rule}`);
    }
  });

  it("reports the vulnerable package with its fix version", () => {
    const pkg = result.findings.find((f) => f.rule === "code:vulnerable-package")!;
    assert.equal(pkg.severity, "high");
    assert.match(pkg.detail, /CVE-2021-23337/);
    assert.match(pkg.detail, /Upgrade to 4\.17\.21/);
    assert.equal(pkg.pageUrl, "package-lock.json", "the zip's top folder is dropped from paths");
  });

  it("skips installed packages, the local .env of a zip, and real secrets in tests are only hints", () => {
    assert.ok(!result.findings.some((f) => f.pageUrl.startsWith("node_modules/")));
    assert.ok(!result.findings.some((f) => f.pageUrl === ".env"));
    assert.ok(!result.findings.some((f) => f.pageUrl === "test/fixture.js"), "the general password pattern is not used on test files");
    assert.ok(result.notes?.some((n) => n.includes("node_modules")));
  });

  it("masks secrets in the evidence", () => {
    const secret = result.findings.find((f) => f.rule === "code:secret-aws-key")!;
    assert.ok(!secret.evidence?.includes(FAKE_AWS_KEY));
    assert.equal(secret.severity, "critical");
  });

  it("is a complete test, so issues not found again count as fixed", () => {
    assert.equal(result.complete, true);
    assert.equal(result.label?.pages, "Files");
  });

  it("reads lockfiles of several package managers", () => {
    const files = [
      { path: "yarn.lock", size: 0, text: '"@babel/core@^7.0.0":\n  version "7.24.0"\n  resolved "x"\n\nlodash@^4.17.0, lodash@^4.17.15:\n  version "4.17.15"\n' },
      { path: "api/composer.lock", size: 0, text: JSON.stringify({ packages: [{ name: "laravel/framework", version: "v10.1.0" }] }) },
      { path: "requirements.txt", size: 0, text: "Django==4.2.1\nrequests>=2\n" },
      { path: "Gemfile.lock", size: 0, text: "GEM\n  specs:\n    rails (7.0.4)\n      actionpack (= 7.0.4)\n" },
    ];
    const { deps } = readDependencies(files);
    const has = (eco: string, name: string, version: string) => deps.some((d) => d.ecosystem === eco && d.name === name && d.version === version);
    assert.ok(has("npm", "@babel/core", "7.24.0"));
    assert.ok(has("npm", "lodash", "4.17.15"));
    assert.ok(has("Packagist", "laravel/framework", "10.1.0"));
    assert.ok(has("PyPI", "Django", "4.2.1"));
    assert.ok(has("RubyGems", "rails", "7.0.4"));
    assert.equal(deps.filter((d) => d.ecosystem === "RubyGems").length, 1, "nested dependency lines are not packages");
  });

  it("compares versions and picks the fix for the version in use", () => {
    assert.ok(compareVersions("1.2.10", "1.2.9") > 0);
    assert.equal(compareVersions("v2", "2.0.0"), 0);
    const vuln = {
      id: "X",
      affected: [{ ranges: [{ type: "SEMVER", events: [{ introduced: "3.0.0" }, { fixed: "3.10.2" }, { introduced: "4.0.0" }, { fixed: "4.17.21" }] }] }],
    };
    assert.equal(fixedVersion(vuln, { ecosystem: "npm", name: "lodash", version: "4.17.15", file: "" }), "4.17.21");
    assert.equal(fixedVersion(vuln, { ecosystem: "npm", name: "lodash", version: "3.5.0", file: "" }), "3.10.2");
  });

  it("only accepts public https repositories without passwords in the address", () => {
    process.env.ALLOW_PRIVATE_TARGETS = "";
    try {
      assert.throws(() => validateRepoUrl("http://github.com/a/b"), /https/);
      assert.throws(() => validateRepoUrl("https://user:pass@github.com/a/b"), /user name/);
      assert.throws(() => validateRepoUrl("https://127.0.0.1/a/b"), /Private/);
      assert.equal(validateRepoUrl("https://github.com/a/b/"), "https://github.com/a/b");
    } finally {
      process.env.ALLOW_PRIVATE_TARGETS = "1";
    }
  });

  it("tells risky code from text that only mentions it", () => {
    const line = 'el.innerHTML = x; log("innerHTML is risky"); const re = /eval\\(/; // eval(here)';
    assert.equal(inLiteral(line, line.indexOf("innerHTML")), false);
    assert.equal(inLiteral(line, line.indexOf("innerHTML is")), true);
    assert.equal(inLiteral(line, line.indexOf("eval\\")), true);
    assert.equal(inLiteral(line, line.lastIndexOf("eval")), true);
  });

  it("ignores zip entries that try to leave the folder", () => {
    const tree = readZip(zipSync({ "../evil.js": strToU8("x"), "ok.js": strToU8("y") }));
    assert.deepEqual(tree.files.map((f) => f.path), ["ok.js"]);
  });
});

describe("Android engine", () => {
  let dir: string;
  let result: ScanResult;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-apk-"));
    await writeFile(path.join(dir, "demo.apk"), buildDemoApk());
    result = await scanApk({ apkFile: path.join(dir, "demo.apk"), fileName: "demo.apk" });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("reads Android binary XML", () => {
    const node = parseAxml(encodeAxml({ tag: "manifest", attrs: [["package", "a.b"], ["versionCode", 3], ["debuggable", true]], children: [{ tag: "x", text: "hi" }] }));
    assert.equal(node.attrs.package, "a.b");
    assert.equal(node.attrs.versionCode, 3);
    assert.equal(node.attrs.debuggable, true);
    assert.equal(node.children[0].text, "hi");
  });

  it("finds the planted problems", () => {
    const found = rules(result);
    for (const rule of [
      "android:debuggable",
      "android:debug-signed",
      "android:cleartext",
      "android:user-certs",
      "android:backup",
      "android:old-target",
      "android:restricted-permissions",
      "android:open-provider",
      "android:secret-aws-key",
      "android:http-backend",
      "android:no-64bit",
      "android:hardcoded-crypto-key",
    ]) {
      assert.ok(found.has(rule), `expected ${rule}`);
    }
    assert.match(result.notes?.[0] ?? "", /in\.glv\.demoshop version 1\.4\.0/);
  });

  it("leaves library components and the launcher screen alone", () => {
    assert.ok(!found("android:open-service"), "the Firebase service belongs to a library");
    assert.ok(!found("android:open-activity"), "the launcher screen is meant to be opened");
    function found(rule: string) {
      return rules(result).has(rule);
    }
  });

  it("reads the memory page alignment of native libraries", () => {
    assert.equal(elfMinAlign(elfWithAlign(0x1000)), 0x1000);
    assert.equal(elfMinAlign(elfWithAlign(0x4000)), 0x4000);
    assert.equal(elfMinAlign(Buffer.from("not an elf")), null);
  });

  it("refuses files that are not APKs", async () => {
    await writeFile(path.join(dir, "bad.apk"), Buffer.from(zipSync({ "hello.txt": strToU8("hi") })));
    await assert.rejects(scanApk({ apkFile: path.join(dir, "bad.apk") }), /not an APK/);
  });
});

describe("regression check for engines without pages", () => {
  const project: Project = { id: "p", key: "APP", name: "App", type: "android", target: {}, schedule: "off", createdAt: "", issueSeq: 0 };
  const run = (id: string, rulesFound: string[], extra: Partial<ScanResult> = {}): Run => ({
    id,
    url: "app",
    status: "done",
    createdAt: "",
    progress: [],
    agents: ["android.manifest"],
    result: {
      startUrl: "",
      startedAt: "",
      finishedAt: "",
      pages: [],
      scores: {},
      overallScore: 50,
      complete: true,
      findings: rulesFound.map((rule) => ({ id: rule, rule, title: rule, detail: "", severity: "high", category: "security", pageUrl: "AndroidManifest.xml", agent: "android.manifest" })),
      ...extra,
    },
  });

  it("marks an issue fixed when a complete test no longer finds it", () => {
    const first = syncIssues(project, run("r1", ["android:debuggable", "android:backup"]), []);
    const second = syncIssues(first.project, run("r2", ["android:backup"]), first.created);
    assert.equal(second.diff.fixed, 1);
    assert.equal(second.changed.find((i) => i.rule === "android:debuggable")?.status, "verified");
  });

  it("keeps API issues open when the endpoint could not be reached", () => {
    const web: Project = { ...project, type: "api" };
    const finding = { id: "x", rule: "api:slow", title: "Slow endpoint", detail: "", severity: "low" as const, category: "performance" as const, pageUrl: "https://a.in/v1/x", agent: "api.availability" };
    const r1: Run = { ...run("r1", []), agents: ["api.availability"] };
    r1.result = { ...r1.result!, complete: undefined, findings: [finding], pages: [{ url: finding.pageUrl, status: 200, title: "", loadMs: 2000 }] };
    const first = syncIssues(web, r1, []);
    const r2: Run = { ...r1, id: "r2" };
    r2.result = { ...r1.result!, findings: [], pages: [{ url: finding.pageUrl, status: null, title: "", loadMs: null, error: "timeout" }] };
    const second = syncIssues(first.project, r2, first.created);
    assert.equal(second.diff.fixed, 0, "no answer is not a fix");
  });
});

describe("API, code and app projects through the server", () => {
  let dataDir: string;
  let demo: DemoApi;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let cookie = "";
  const call = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers: { cookie, ...headers },
      ...(payload === undefined ? {} : Buffer.isBuffer(payload) ? { payload } : { payload: payload as object }),
    });
    const setCookie = res.headers["set-cookie"];
    if (setCookie) cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };
  const waitForRun = async (id: string) => {
    for (let i = 0; i < 120; i++) {
      const r = await call("GET", `/api/runs/${id}`);
      if (r.body.status === "done" || r.body.status === "failed") return r.body as Run;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    throw new Error("run did not finish");
  };

  before(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "glv-engines-"));
    demo = await startDemoApi(4211);
    ({ app } = await createApp({ dataDir }));
    await call("POST", "/api/auth/setup", { name: "Lucky", email: "owner@glv.test", password: "a-long-password" });
  });
  after(async () => {
    demo.server.close();
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("creates an API project from the file's address and files issues", async () => {
    const created = await call("POST", "/api/projects", { type: "api", specUrl: "http://localhost:4211/openapi.json" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.name, "localhost API");
    const run = await waitForRun(created.body.run.id);
    assert.equal(run.status, "done", run.error);
    assert.ok(run.diff && run.diff.new >= 10);
    const issues = await call("GET", `/api/issues?projectId=${created.body.project.id}`);
    assert.ok(issues.body.some((i: { rule: string }) => i.rule === "api:auth-bypass"));
  });

  it("uploads an APK, checks it is a real zip, and tests it", async () => {
    const bad = await call("POST", "/api/uploads", Buffer.from("not a zip"), { "content-type": "application/octet-stream", "x-file-name": "app.apk" });
    assert.equal(bad.status, 400);
    const wrongType = await call("POST", "/api/uploads", Buffer.from("x"), { "content-type": "application/octet-stream", "x-file-name": "run.sh" });
    assert.equal(wrongType.status, 400);

    const up = await call("POST", "/api/uploads", buildDemoApk(), { "content-type": "application/octet-stream", "x-file-name": "demo shop.apk" });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const created = await call("POST", "/api/projects", { type: "android", file: up.body.file, fileName: up.body.fileName });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.name, "demo shop");
    const run = await waitForRun(created.body.run.id);
    assert.equal(run.status, "done", run.error);
    assert.ok(run.result?.findings.some((f) => f.rule === "android:debuggable"));
  });

  it("uploads an iOS app (an IPA or a zipped .app) and tests it", async () => {
    const up = await call("POST", "/api/uploads", plantedIpa(), { "content-type": "application/octet-stream", "x-file-name": "GLV Shop.ipa" });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    const created = await call("POST", "/api/projects", { type: "ios", file: up.body.file, fileName: up.body.fileName });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.name, "GLV Shop");
    const run = await waitForRun(created.body.run.id);
    assert.equal(run.status, "done", run.error);
    assert.ok(run.result?.findings.some((f) => f.rule === "ios:debug-build"));
    const issues = await call("GET", `/api/issues?projectId=${created.body.project.id}`);
    assert.ok(issues.body.some((i: { rule: string }) => i.rule === "ios:no-privacy-manifest"));
    // A zipped Simulator build is taken too; an APK is not an iOS app.
    const zip = await call("POST", "/api/uploads", simulatorAppZip(), { "content-type": "application/octet-stream", "x-file-name": "GLV Shop.zip" });
    assert.equal((await call("POST", "/api/projects", { type: "ios", file: zip.body.file, fileName: zip.body.fileName })).status, 201);
    const apk = await call("POST", "/api/uploads", buildDemoApk(), { "content-type": "application/octet-stream", "x-file-name": "demo.apk" });
    assert.match((await call("POST", "/api/projects", { type: "ios", file: apk.body.file })).body.error, /does not fit/);
  });

  it("checks what each product needs", async () => {
    const noSpec = await call("POST", "/api/projects", { type: "api" });
    assert.equal(noSpec.status, 400);
    assert.match(noSpec.body.error, /OpenAPI/);
    const noApk = await call("POST", "/api/projects", { type: "android" });
    assert.match(noApk.body.error, /APK/);
    const badFile = await call("POST", "/api/projects", { type: "android", file: "../../etc/passwd.apk" });
    assert.equal(badFile.status, 400);
    const badBranch = await call("POST", "/api/projects", { type: "code", repoUrl: "https://github.com/a/b", branch: "--upload-pack=x" });
    assert.match(badBranch.body.error, /branch/);
    const ios = await call("POST", "/api/projects", { type: "ios" });
    assert.match(ios.body.error, /IPA/);
  });
});
