import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { scanApi } from "../src/engines/api.js";
import { gitAuthEnv, isolatedGitEnv } from "../src/engines/code.js";
import { runEngine } from "../src/engines/index.js";
import { LoginError } from "../src/runner/login.js";
import { scanSite } from "../src/runner/scan.js";
import { isCrawlable } from "../src/runner/urls.js";
import { createApp } from "../src/server.js";
import { buildLogin } from "../src/targets.js";
import type { Login, ScanResult } from "../src/types.js";
import { redact, secretsOf, Vault } from "../src/vault.js";
import { DEMO_TOKEN, startDemoApi, type DemoApi } from "./fixtures/demo-api.js";
import { DEMO_USER, startDemoApp, type DemoApp } from "./fixtures/demo-app.js";

// The outside tools have their own tests (tools.test.ts); here tests run only the platform's checks.
process.env.DEFAULT_TOOLS = "none";

const run = promisify(execFile);
const WEB_LOGIN: Login = { kind: "web", loginUrl: "http://localhost:4231/login", username: DEMO_USER.email, password: DEMO_USER.password };

describe("login vault", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glvvault-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("encrypts secrets, and the summary never holds them", async () => {
    const db = new DatabaseSync(path.join(dir, "a.db"));
    const vault = new Vault(db, path.join(dir, "a"), {});
    vault.save("p1", WEB_LOGIN);
    const raw = JSON.stringify(db.prepare("SELECT * FROM logins").all());
    assert.ok(!raw.includes(DEMO_USER.password), "the password is not stored in plain text");
    assert.deepEqual(vault.get("p1"), WEB_LOGIN);
    const summary = vault.summary("p1")!;
    assert.equal(summary.hasPassword, true);
    assert.equal(summary.username, DEMO_USER.email);
    assert.ok(!JSON.stringify(summary).includes(DEMO_USER.password));
    // Without SECRET_KEY, the key is made once and kept in the data folder, readable only by the server.
    assert.equal(vault.status().source, "file");
    assert.equal((await readFile(path.join(dir, "a", "vault.key"), "utf8")).length, 44);
  });

  it("keeps a saved secret when it is left empty on edit, and forgets it on delete", () => {
    const vault = new Vault(new DatabaseSync(":memory:"), path.join(dir, "b"), {});
    vault.save("p1", WEB_LOGIN);
    vault.save("p1", { ...WEB_LOGIN, username: "other@glv.test", password: undefined });
    assert.equal(vault.get("p1")!.password, DEMO_USER.password);
    assert.equal(vault.get("p1")!.username, "other@glv.test");
    vault.delete("p1");
    assert.equal(vault.get("p1"), undefined);
  });

  it("cannot be read with another key, or moved to another project", () => {
    const db = new DatabaseSync(":memory:");
    new Vault(db, path.join(dir, "c"), { SECRET_KEY: "first-secret-key-0123456789" }).save("p1", WEB_LOGIN);
    const other = new Vault(db, path.join(dir, "c2"), { SECRET_KEY: "second-secret-key-0123456789" });
    assert.throws(() => other.get("p1"), /different SECRET_KEY/);
    assert.equal(other.summary("p1")!.unreadable, true);
    assert.equal(other.status().unreadable, 1);

    const vault = new Vault(db, path.join(dir, "c3"), { SECRET_KEY: "first-secret-key-0123456789" });
    vault.save("p2", WEB_LOGIN);
    db.prepare("UPDATE logins SET secret = (SELECT secret FROM logins WHERE project_id = 'p2') WHERE project_id = 'p1'").run();
    vault.save("p2", WEB_LOGIN);
    assert.throws(() => vault.get("p1"), /unable to authenticate|Unsupported state/i);
  });

  it("moves logins to SECRET_KEY once it is set", () => {
    const db = new DatabaseSync(":memory:");
    const data = path.join(dir, "d");
    new Vault(db, data, {}).save("p1", WEB_LOGIN);
    const withKey = new Vault(db, data, { SECRET_KEY: "a-new-server-secret-key-123" });
    assert.equal(withKey.status().source, "env");
    assert.equal(withKey.get("p1")!.password, DEMO_USER.password);
    // Now sealed with SECRET_KEY: readable without the old key file.
    const keyOnly = new Vault(db, path.join(dir, "d-elsewhere"), { SECRET_KEY: "a-new-server-secret-key-123" });
    assert.equal(keyOnly.get("p1")!.password, DEMO_USER.password);
    assert.throws(() => new Vault(db, data, { SECRET_KEY: "short" }), /too short/);
  });

  it("checks what each product's login needs", () => {
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    assert.throws(() => buildLogin("website", { loginUrl: "https://a.com/login", username: "x" }), /password/);
    assert.throws(() => buildLogin("crm", { username: "x", password: "y" }), /sign-in page/);
    assert.throws(() => buildLogin("api", { authType: "header", token: "t" }), /header name/);
    assert.throws(() => buildLogin("api", { authType: "bearer", token: "a\r\nX-Evil: 1" }), /not allowed/);
    assert.throws(() => buildLogin("android", { token: "t" }), /does not use a login/);
    assert.equal(buildLogin("code", { token: "ghp_x" }).kind, "git");
    assert.deepEqual(buildLogin("api", { authType: "query", paramName: "api_key", token: "k" }), {
      kind: "api",
      authType: "query",
      paramName: "api_key",
      token: "k",
    });
    // Editing: the saved password is kept when the field is left empty.
    const prev = { kind: "web" as const, loginUrl: "https://a.com/login", username: "x", hasPassword: true, hasToken: false, updatedAt: "" };
    assert.equal(buildLogin("saas", { username: "y" }, prev).username, "y");
  });

  it("hides every secret in a result, including encoded forms", () => {
    const login: Login = { kind: "api", authType: "basic", username: "glv", password: "s3cret-pass" };
    const result = {
      detail: 'echo: {"pw":"s3cret-pass"}',
      evidence: `Authorization: Basic ${Buffer.from("glv:s3cret-pass").toString("base64")}`,
      url: "https://a.com/?p=s3cret-pass",
    };
    const clean = redact(result, secretsOf(login));
    assert.ok(!JSON.stringify(clean).includes("s3cret-pass"));
    assert.ok(!JSON.stringify(clean).includes(Buffer.from("glv:s3cret-pass").toString("base64")));
    assert.match(clean.detail, /\[hidden\]/);
  });
});

describe("signed-in testing of a web app", () => {
  let app: DemoApp;
  let result: ScanResult;
  /** The same site tested 4 pages at a time, on its own copy of the demo app. */
  let parallelApp: DemoApp;
  let parallel: ScanResult;
  let dir: string;
  before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    app = await startDemoApp(4231);
    parallelApp = await startDemoApp(4232);
    dir = await mkdtemp(path.join(tmpdir(), "glvlogin-"));
    const options = { maxPages: 10, product: "crm" as const, agents: ["web.links", "web.forms", "web.content"], artifactsDir: dir };
    [result, parallel] = await Promise.all([
      scanSite({ ...options, url: `${app.base}/`, login: WEB_LOGIN, parallel: 1 }),
      scanSite({ ...options, url: `${parallelApp.base}/`, login: { ...WEB_LOGIN, loginUrl: `${parallelApp.base}/login` }, parallel: 4 }),
    ]);
  });
  after(async () => {
    app.server.close();
    parallelApp.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("signs in and tests the pages behind the login", () => {
    const urls = result.pages.map((p) => new URL(p.url).pathname);
    for (const p of ["/dashboard", "/leads", "/leads/1", "/settings", "/reports"]) assert.ok(urls.includes(p), p);
    assert.ok(!urls.includes("/login"), "the sign-in page is not reported as a tested page");
    assert.ok(result.notes?.some((n) => n.startsWith(`Signed in as ${DEMO_USER.email}`)));
    assert.ok(result.findings.some((f) => f.pageUrl.endsWith("/missing-page") || f.detail.includes("/missing-page")));
  });

  it("signs in again when the site ends the session", () => {
    assert.equal(app.logins(), 2);
    assert.ok(result.notes?.some((n) => n.includes("signed the agent out once")));
  });

  it("gives the same pages and problems when several pages are tested at once, even though the site signs it out", () => {
    // Pages are listed in the order they were found, which can differ when several load at once.
    const pagesOf = (r: ScanResult) => r.pages.map((p) => new URL(p.url).pathname).sort();
    const problemsOf = (r: ScanResult) => r.findings.map((f) => `${f.rule} ${new URL(f.pageUrl).pathname}`).sort();
    assert.deepEqual(pagesOf(parallel), pagesOf(result));
    assert.deepEqual(problemsOf(parallel), problemsOf(result));
    // The pages open while the session ended were tested again one at a time, which opened the
    // page that ends the session once more: one more sign-in than one page at a time.
    assert.ok(parallelApp.logins() >= 2 && parallelApp.logins() <= 3, String(parallelApp.logins()));
    assert.ok(parallel.notes?.some((n) => n.includes("tested again one at a time")));
    for (const p of parallelApp.requested) assert.ok(!p.startsWith("/logout") && !p.endsWith("/cancel") && !p.includes("action="), p);
  });

  it("never opens links that log out or change data", () => {
    for (const p of app.requested) {
      assert.ok(!p.startsWith("/logout") && !p.endsWith("/cancel") && !p.includes("action="), p);
    }
    assert.ok(!isCrawlable(`${app.base}/orders/7/cancel`, app.base, true));
    assert.ok(isCrawlable(`${app.base}/orders/7/cancel`, app.base, false));
  });

  it("says why a sign-in failed, without the password", async () => {
    const wrong = "Wrong-Password-1";
    await assert.rejects(
      scanSite({ url: `${app.base}/`, maxPages: 1, agents: [], artifactsDir: dir, login: { ...WEB_LOGIN, password: wrong } }),
      (err: Error) => err instanceof LoginError && /Invalid email or password/.test(err.message) && !err.message.includes(wrong),
    );
    await assert.rejects(
      scanSite({ url: `${app.base}/`, maxPages: 1, agents: [], artifactsDir: dir, login: { ...WEB_LOGIN, usernameSelector: "#nope" } }),
      /"#nope" was not found/,
    );
  });
});

describe("API testing with a saved token", () => {
  let demo: DemoApi;
  let result: ScanResult;
  before(async () => {
    demo = await startDemoApi(4232);
    result = await runEngine({
      product: "api",
      target: { specUrl: "http://localhost:4232/openapi.json" },
      login: { kind: "api", authType: "bearer", token: DEMO_TOKEN },
      maxPages: 1,
      artifactsDir: "",
      uploadsDir: "",
      workDir: "",
    });
  });
  after(() => demo.server.close());

  it("calls the endpoints with the token and still never writes", () => {
    assert.ok(demo.withToken() >= 9);
    assert.equal(demo.writes(), 0);
    assert.ok(result.notes?.some((n) => n.includes("with the saved login (a bearer token)")));
    assert.ok(result.notes?.some((n) => n.includes("without it, to check they refuse")));
  });

  it("finds endpoints that answer strangers, from the calls made without the token", () => {
    const bypass = result.findings.filter((f) => f.rule === "api:auth-bypass").map((f) => new URL(f.pageUrl).pathname);
    assert.deepEqual(bypass, ["/v1/users"]);
    assert.ok(!result.findings.some((f) => f.rule === "api:undocumented-auth"));
  });

  it("keeps a query-parameter key out of the report", async () => {
    const before = demo.withToken();
    const r = await scanApi({ specUrl: "http://localhost:4232/openapi.json", auth: { kind: "api", authType: "query", paramName: "api_key", token: DEMO_TOKEN } });
    assert.ok(demo.withToken() > before);
    assert.ok(!JSON.stringify(r).includes(DEMO_TOKEN));
  });
});

describe("private Git repositories", () => {
  it("sends the token only to the repository's host, and never the server's own git logins", async () => {
    let seen = "";
    const server = createServer((req, res) => {
      seen = req.headers.authorization ?? "";
      res.writeHead(401, { "www-authenticate": 'Basic realm="git"' }).end();
    });
    await new Promise<void>((r) => server.listen(4233, r));
    try {
      const repo = "http://127.0.0.1:4233/glv/private.git";
      const env = { ...isolatedGitEnv({ ...process.env, GIT_ASKPASS: "/bin/echo", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "x", GIT_CONFIG_VALUE_0: "y" }), ...gitAuthEnv(repo, { kind: "git", token: "ghp_demo" }, {}) };
      assert.equal(env.GIT_ASKPASS, undefined);
      assert.equal(env.GIT_CONFIG_KEY_0, "http.http://127.0.0.1:4233/.extraHeader");
      await run("git", ["-c", "credential.helper=", "ls-remote", repo], { env }).catch(() => {});
      assert.equal(seen, `Basic ${Buffer.from("x-access-token:ghp_demo").toString("base64")}`);
    } finally {
      server.close();
    }
  });
});

describe("logins through the server", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glvsrv-"));
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("saves a project's login, shows only that it is saved, and removes it", async () => {
    const call = async (method: string, url: string, payload?: object) => {
      const res = await app.inject({ method: method as "GET", url, payload });
      return { status: res.statusCode, body: res.body ? res.json() : null, raw: res.body };
    };
    // Nothing listens on this port, so the test run that starts fails fast without leaving this machine.
    const created = await call("POST", "/api/projects", {
      type: "api",
      specUrl: "http://localhost:4299/openapi.json",
      login: { authType: "bearer", token: "ghp_secret_value_1234" },
    });
    assert.equal(created.status, 201);
    assert.ok(!created.raw.includes("ghp_secret_value_1234"));
    const id = created.body.project.id;
    const detail = await call("GET", `/api/projects/${id}`);
    assert.equal(detail.body.project.login.hasToken, true);
    assert.ok(!detail.raw.includes("ghp_secret_value_1234"));
    assert.ok(!(await call("GET", "/api/projects")).raw.includes("ghp_secret_value_1234"));
    assert.equal((await call("GET", "/api/meta")).body.vault.saved, 1);

    // Bad input is refused and the saved login stays.
    assert.equal((await call("PATCH", `/api/projects/${id}`, { login: { authType: "header", paramName: "" } })).status, 400);
    assert.equal((await call("PATCH", `/api/projects/${id}`, { login: null })).status, 200);
    assert.equal((await call("GET", `/api/projects/${id}`)).body.project.login, null);
  });
});
