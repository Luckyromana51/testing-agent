import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { agentsFor } from "../src/agents/registry.js";
import { codeRiskyAgent } from "../src/agents/code/risky.js";
import { codeSecretsAgent } from "../src/agents/code/secrets.js";
import { dexCryptoKeys } from "../src/agents/mobile/android.js";
import { showsUser } from "../src/agents/web/products.js";
import { scanApi } from "../src/engines/api.js";
import { scanCode } from "../src/engines/code.js";
import { syncIssues } from "../src/issues.js";
import { categoriesFor } from "../src/products.js";
import { shortError } from "../src/queue.js";
import { CouldNotTestError, explainLoadError } from "../src/runner/coverage.js";
import { scanSite } from "../src/runner/scan.js";
import { scoreFindings } from "../src/runner/score.js";
import { createApp } from "../src/server.js";
import type { AgentStat, Finding, Issue, Project, Run, ScanResult } from "../src/types.js";
import { DEMO_USER, startDemoApp, type DemoApp } from "./fixtures/demo-app.js";
import { startDemoStore } from "./fixtures/demo-store.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
// The outside tools have their own tests (tools.test.ts); here tests run only the platform's checks.
process.env.DEFAULT_TOOLS = "none";
const rules = (r: ScanResult) => new Set(r.findings.map((f) => f.rule));
const stat = (id: string, category: AgentStat["category"], extra: Partial<AgentStat> = {}): AgentStat => ({
  id,
  name: id,
  findings: 0,
  ms: 0,
  errors: 0,
  category,
  runs: 1,
  ...extra,
});

describe("checks that could not run are not tested, never passed", () => {
  it("gives no score to a category whose checks all failed, and leaves it out of the overall score", () => {
    const findings: Finding[] = [{ id: "1", rule: "x", title: "x", detail: "", severity: "high", category: "security", pageUrl: "/" }];
    const s = scoreFindings(findings, 1, ["security", "functional"], [
      stat("code.packages", "security", { untested: "Could not reach the OSV vulnerability database" }),
      stat("code.secrets", "security"),
      stat("code.hygiene", "functional", { untested: "Stopped with an error" }),
    ]);
    assert.equal(s.scores.functional, undefined);
    assert.match(s.notTested?.functional ?? "", /Stopped with an error/);
    assert.equal(s.scores.security, 90, "security still has a check that ran");
    assert.equal(s.overallScore, 90, "the untested category is not counted as 100");
    assert.deepEqual(s.incomplete?.length, 2);
  });

  it("fails a site test that could not open the first page, and says why", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-down-"));
    try {
      await assert.rejects(
        scanSite({ url: "http://localhost:4297/", maxPages: 3, agents: ["web.seo", "web.links"], artifactsDir: dir }),
        (err: Error) => err instanceof CouldNotTestError && /Could not test the site: localhost:4297 did not accept the connection/.test(err.message),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.match(explainLoadError("page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://pypi.org/", "https://pypi.org/"), /proxy or firewall on the testing server/);
  });

  it("does not score source code whose package check could not reach the vulnerability database", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-osv-"));
    const before = process.env.OSV_URL;
    process.env.OSV_URL = "http://localhost:4296";
    try {
      const { zipSync, strToU8 } = await import("fflate");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        path.join(dir, "code.zip"),
        zipSync({
          "app/package.json": strToU8(JSON.stringify({ name: "app", dependencies: { lodash: "4.17.15" } })),
          "app/package-lock.json": strToU8(JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/lodash": { version: "4.17.15" } } })),
          "app/README.md": strToU8("# App\n"),
          "app/index.js": strToU8("module.exports = 1;\n"),
        }),
      );
      const result = await scanCode({ zipFile: path.join(dir, "code.zip"), workDir: dir });
      assert.ok(result.incomplete?.some((m) => /OSV/.test(m)), JSON.stringify(result.incomplete));
      const packages = result.agentStats?.find((s) => s.id === "code.packages");
      assert.match(packages?.untested ?? "", /1 of 1 packages were not checked/);
    } finally {
      if (before === undefined) delete process.env.OSV_URL;
      else process.env.OSV_URL = before;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails an API test when every call is refused the same way, instead of scoring it", async () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      servers: [{ url: "http://localhost:4295" }],
      paths: Object.fromEntries(["/a", "/b", "/c", "/d"].map((p) => [p, { get: { responses: { 200: { description: "ok" } } } }])),
    };
    const blocked = createServer((_req, res) => res.writeHead(403, { "content-type": "text/plain" }).end("Blocked by policy"));
    await new Promise<void>((r) => blocked.listen(4295, r));
    try {
      await assert.rejects(scanApi({ specText: JSON.stringify(spec) }), (err: Error) => err instanceof CouldNotTestError && /Could not test the API/.test(err.message));
    } finally {
      blocked.close();
    }
  });
});

describe("online store checks", () => {
  let store: { server: Server; base: string };
  let result: ScanResult;
  let dir: string;
  before(async () => {
    store = await startDemoStore(4240);
    dir = await mkdtemp(path.join(tmpdir(), "glv-store-"));
    result = await scanSite({
      url: `${store.base}/`,
      maxPages: 12,
      product: "ecommerce",
      agents: ["store.policies", "store.product", "store.checkout", "web.content", "web.seo", "web.duplicates", "web.accessibility"],
      artifactsDir: dir,
    });
  });
  after(async () => {
    store.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the missing refund and shipping policies, and only those", () => {
    const missing = result.findings.filter((f) => f.rule === "store:missing-policy").map((f) => f.evidence);
    assert.deepEqual(missing.sort(), ["return and refund policy", "shipping and delivery policy"]);
    assert.equal(result.findings.find((f) => f.evidence === "return and refund policy")?.severity, "high");
  });

  it("checks product pages for a price, a buy button and complete product data", () => {
    const on = (rule: string) => result.findings.filter((f) => f.rule === rule).map((f) => new URL(f.pageUrl).pathname);
    assert.deepEqual(on("store:no-price"), ["/products/lamp"]);
    assert.deepEqual(on("store:no-buy-button"), ["/products/lamp"]);
    assert.deepEqual(on("store:product-data-incomplete"), ["/products/mug"]);
    assert.match(result.findings.find((f) => f.rule === "store:product-data-incomplete")!.evidence ?? "", /availability/);
  });

  it("flags scripts from other websites and the missing CSP on the cart page", () => {
    const scripts = result.findings.find((f) => f.rule === "store:checkout-third-party-scripts");
    assert.ok(scripts, "five outside script hosts on /cart");
    assert.equal(new URL(scripts.pageUrl).pathname, "/cart");
    assert.equal(scripts.severity, "medium");
    assert.ok(rules(result).has("store:checkout-no-csp"));
  });

  it("skips template tags inside code examples, and still finds one shown to shoppers", () => {
    const tags = result.findings.filter((f) => f.rule === "content:template-tag");
    assert.equal(tags.length, 1);
    assert.equal(tags[0].evidence, "{{ cart.count }}");
    assert.ok(!result.findings.some((f) => f.evidence?.includes("customer.name")));
  });

  it("treats pages that share a canonical address as one page", () => {
    assert.ok(result.pages.some((p) => p.url.includes("topic=chat")), "the chat variant was tested");
    assert.ok(!rules(result).has("seo:duplicate-title"), JSON.stringify(result.findings.filter((f) => f.rule === "seo:duplicate-title")));
  });

  it("rates a missing alt text High, so it does not cap the score", () => {
    const alt = result.findings.find((f) => f.rule === "axe:image-alt");
    assert.equal(alt?.severity, "high");
  });
});

describe("signed-in checks for web apps, SaaS and CRMs", () => {
  let app: DemoApp;
  let result: ScanResult;
  let dir: string;
  before(async () => {
    app = await startDemoApp(4236);
    dir = await mkdtemp(path.join(tmpdir(), "glv-private-"));
    result = await scanSite({
      url: `${app.base}/`,
      maxPages: 12,
      product: "webapp",
      agents: ["app.private-pages", "app.private-cache", "app.data-in-url", "web.seo", "web.duplicates", "web.content"],
      artifactsDir: dir,
      login: { kind: "web", loginUrl: `${app.base}/login`, username: DEMO_USER.email, password: DEMO_USER.password },
    });
  });
  after(async () => {
    app.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the private page that opens without signing in", () => {
    const open = result.findings.filter((f) => f.rule === "app:private-page-public");
    assert.deepEqual(open.map((f) => new URL(f.pageUrl).pathname), ["/team"]);
    assert.equal(open[0].severity, "critical");
    assert.match(open[0].evidence ?? "", /the signed-in user's name or email/);
  });

  it("finds signed-in pages that can be cached, and e-mails in addresses (masked)", () => {
    const cached = new Set(result.findings.filter((f) => f.rule === "app:private-page-cacheable").map((f) => new URL(f.pageUrl).pathname));
    assert.deepEqual([...cached], ["/leads"]);
    const data = result.findings.find((f) => f.rule === "app:personal-data-in-url");
    assert.ok(data);
    assert.ok(!data.evidence?.includes("asha%40") && !data.evidence?.includes("asha@"), data.evidence);
  });

  it("gives no search engine advice on signed-in pages, and no SEO score", () => {
    assert.ok(!result.findings.some((f) => f.category === "seo"));
    assert.equal(result.scores.seo, undefined);
    assert.equal(result.notTested?.seo, undefined, "left out on purpose, not shown as untested");
    assert.match(result.agentStats?.find((s) => s.id === "web.seo")?.skipped ?? "", /signed in/);
  });

  it("never gives a CRM search engine checks or an SEO score, and store checks only go to stores", () => {
    const crm = agentsFor("crm").map((a) => a.id);
    assert.ok(!crm.some((id) => ["web.seo", "web.structured-data", "web.duplicates", "web.crawlability", "web.soft-404"].includes(id)), crm.join());
    assert.ok(crm.includes("app.private-pages"));
    assert.ok(!categoriesFor("crm").includes("seo"));
    assert.ok(agentsFor("ecommerce").some((a) => a.id === "store.checkout"));
    assert.ok(!agentsFor("website").some((a) => a.id.startsWith("store.") || a.id.startsWith("app.")));
  });

  it("recognises a user's name or email without matching common words", () => {
    assert.ok(showsUser("Signed in as tester@glv.test", "tester@glv.test"));
    assert.ok(!showsUser("Go to /admin", "admin"));
    assert.ok(showsUser("Hello priyanka, welcome", "Priyanka"));
    assert.ok(!showsUser("priyankaraj", "Priyanka"));
  });

  it("leaves the private-page checks out, with a reason, when there is no saved login", async () => {
    const r = await scanSite({ url: `${app.base}/`, maxPages: 2, product: "webapp", agents: ["app.private-pages", "web.content"], artifactsDir: dir });
    assert.match(r.agentStats?.find((s) => s.id === "app.private-pages")?.skipped ?? "", /Needs a saved login/);
  });
});

describe("code scanner: request input that reaches risky calls", () => {
  const f = (p: string, text: string) => ({ path: p, size: text.length, text });
  const scan = async (files: ReturnType<typeof f>[]) => {
    const ctx = { files, allPaths: files.map((x) => x.path), skippedDirs: [], source: "git", log() {}, note() {} } as never;
    return [...(await codeRiskyAgent.run(ctx)), ...(await codeSecretsAgent.run(ctx))];
  };
  const pick = (found: Finding[], rule: string, file: string) => found.find((x) => x.rule === rule && x.pageUrl === file);

  it("finds NodeGoat's planted holes", async () => {
    const found = await scan([
      f("app/routes/contributions.js", "const preTax = eval(req.body.preTax);\n"),
      f("app/routes/research.js", "this.displayResearch = (req, res) => {\n  const url = req.query.url + req.query.symbol;\n  return needle.get(url, (error, newResponse, body) => {\n"),
      f("app/routes/index.js", 'app.get("/learn", isLoggedIn, (req, res) => {\n  return res.redirect(req.query.url);\n});\n'),
      f("app/data/allocations-dao.js", "return {$where: `this.userId == ${parsedUserId} && this.stocks > '${threshold}'`};\n"),
      f("config/env/all.js", 'module.exports = {\n  cookieSecret: "session_cookie_secret_key_here",\n  db: process.env.MONGODB_URI,\n};\n'),
      f("server.js", 'const MongoClient = require("mongodb").MongoClient;\napp.use(session({\n  secret: "keyboard cat",\n}));\n'),
    ]);
    assert.equal(pick(found, "code:eval", "app/routes/contributions.js")?.severity, "critical");
    assert.equal(pick(found, "code:ssrf", "app/routes/research.js")?.severity, "high");
    assert.equal(pick(found, "code:open-redirect", "app/routes/index.js")?.severity, "medium");
    assert.equal(pick(found, "code:nosql-injection", "app/data/allocations-dao.js")?.severity, "high");
    assert.equal(pick(found, "code:secret-session-secret", "config/env/all.js")?.severity, "high");
    assert.equal(pick(found, "code:secret-session-secret", "server.js")?.severity, "high");
  });

  it("finds nodejs-goof's NoSQL injection and prototype pollution", async () => {
    const found = await scan([
      f(
        "routes/index.js",
        [
          "var mongoose = require('mongoose');",
          "exports.loginHandler = function (req, res, next) {",
          "  User.find({ username: req.body.username, password: req.body.password }, function (err, users) {});",
          "};",
          "exports.chat = { async add(req, res) {",
          "  _.merge(message, req.body.message, { id: lastId++ });",
          "}};",
        ].join("\n"),
      ),
    ]);
    assert.equal(pick(found, "code:nosql-injection", "routes/index.js")?.severity, "high");
    assert.equal(pick(found, "code:prototype-pollution", "routes/index.js")?.severity, "high");
  });

  it("follows input in Python and PHP too", async () => {
    const found = await scan([
      f("api/views.py", 'def proxy():\n    target = request.args.get("url")\n    r = requests.get(target)\n    subprocess.run("ls " + request.args["d"], shell=True)\n'),
      f("web/go.php", "<?php\n$id = $_GET['id'];\n$r = $pdo->query(\"SELECT * FROM t WHERE id = $id\");\nheader(\"Location: \" . $_GET['to']);\n"),
    ]);
    assert.equal(pick(found, "code:ssrf", "api/views.py")?.severity, "high");
    assert.equal(pick(found, "code:command-injection", "api/views.py")?.severity, "critical");
    assert.equal(pick(found, "code:sql-injection", "web/go.php")?.severity, "critical");
    assert.ok(pick(found, "code:open-redirect", "web/go.php"));
  });

  it("leaves the same calls alone when the value is not from the request", async () => {
    const found = await scan([
      f(
        "safe.js",
        [
          "const mongoose = require('mongoose');",
          'const url = "https://api.example.com/rates";',
          "axios.get(url);",
          'app.get("/x", (req, res) => res.redirect("/login?next=" + encodeURIComponent(req.query.next)));',
          "async function show(req, res) {",
          "  const user = await User.findOne({ email: String(req.body.email) });",
          "  res.redirect(user.home);",
          "  Todo.findOne({ _id: req.params.id });",
          "  const item = list.find((x) => x.id === req.body.id);",
          "}",
        ].join("\n"),
      ),
      f("tasks.py", 'subprocess.run(["ls", request.args.get("d")])\n'),
      f("other/sequelize.js", "User.findOne({ where: { email: req.body.email } });\n"),
    ]);
    const bad = found.filter((x) => /ssrf|open-redirect|nosql|command-injection|eval/.test(x.rule));
    assert.deepEqual(bad.map((x) => `${x.rule} ${x.pageUrl}`), []);
  });

  it("finds InsecureBank's hard-coded AES key in Java code and in an APK", async () => {
    const found = await scan([
      f(
        "app/src/main/java/com/android/insecurebankv2/CryptoClass.java",
        'import javax.crypto.spec.SecretKeySpec;\npublic class CryptoClass {\n  String key = "This is the super secret key 123";\n  String KEY_ALIAS = "myAliasName12";\n}\n',
      ),
    ]);
    assert.equal(found.filter((x) => x.rule === "code:hardcoded-crypto-key").length, 1);
    const k = "This is the super secret key 123";
    const dex = `Ljavax/crypto/spec/SecretKeySpec;\x00${String.fromCharCode(k.length)}${k}\x00\x10Invalid password\x00`;
    assert.deepEqual(dexCryptoKeys(dex), [k]);
  });
});

describe("speed issues settle over two runs", () => {
  const project: Project = { id: "p", key: "WEB", name: "Web", type: "website", target: { url: "https://a.in/" }, schedule: "off", createdAt: "", issueSeq: 0 };
  const run = (id: string, slow: boolean): Run => ({
    id,
    url: "https://a.in/",
    status: "done",
    createdAt: "",
    progress: [],
    agents: ["web.speed"],
    result: {
      startUrl: "https://a.in/",
      startedAt: "",
      finishedAt: "",
      pages: [{ url: "https://a.in/", status: 200, title: "", loadMs: 1000 }],
      scores: {},
      overallScore: 90,
      findings: slow
        ? [{ id: "1", rule: "perf:lcp", title: "Main content takes 3.1 s to appear (LCP)", detail: "", severity: "medium", category: "performance", pageUrl: "https://a.in/", agent: "web.speed" }]
        : [],
    },
  });
  const step = (state: { project: Project; issues: Issue[] }, r: Run) => {
    const s = syncIssues(state.project, r, state.issues);
    const byId = new Map(state.issues.map((i) => [i.id, i]));
    for (const i of [...s.created, ...s.changed]) byId.set(i.id, i);
    return { project: s.project, issues: [...byId.values()], diff: s.diff };
  };

  it("verifies only after two fast runs, and reopens only after two slow runs", () => {
    let st = step({ project, issues: [] }, run("r1", true));
    assert.equal(st.issues[0].status, "open");
    st = step(st, run("r2", false));
    assert.equal(st.issues[0].status, "open", "one fast run is not enough");
    st = step(st, run("r3", true));
    assert.equal(st.issues[0].missedRuns, 0, "a slow run starts the count again");
    st = step(st, run("r4", false));
    st = step(st, run("r5", false));
    assert.equal(st.issues[0].status, "verified");
    st = step(st, run("r6", true));
    assert.equal(st.issues[0].status, "verified", "one slow run does not reopen it");
    assert.equal(st.diff.reopened, 0);
    st = step(st, run("r7", true));
    assert.equal(st.issues[0].status, "reopened");
  });
});

describe("cancelling and stopping tests", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let hang: Server;
  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as "GET", url, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const waitFor = async (id: string, ok: (r: Run) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const r = (await call("GET", `/api/runs/${id}`)).body as Run;
      if (ok(r)) return r;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out");
  };

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    // A site that never answers, so its tests stay running until they are cancelled.
    hang = createServer(() => {});
    await new Promise<void>((r) => hang.listen(4294, r));
    dir = await mkdtemp(path.join(tmpdir(), "glv-cancel-"));
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    hang.closeAllConnections();
    hang.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("cancels a running test and a queued one, and deletes a project whose test is waiting", async () => {
    const make = async (n: number) => (await call("POST", "/api/projects", { type: "website", url: `http://localhost:4294/${n}`, name: `Hang ${n}` })).body;
    const a = await make(1);
    const b = await make(2);
    const c = await make(3);
    await waitFor(a.run.id, (r) => r.status === "running");
    assert.equal((await call("GET", `/api/runs/${c.run.id}`)).body.status, "queued", "two tests run at a time");
    const projects = (await call("GET", "/api/projects")).body as { id: string; waiting: boolean }[];
    assert.equal(projects.find((p) => p.id === c.project.id)?.waiting, true);

    const started = Date.now();
    const cancelled = await call("POST", `/api/runs/${a.run.id}/cancel`);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
    assert.match(cancelled.body.error, /Cancelled while it was running/);
    assert.ok(Date.now() - started < 10_000, "stops without waiting for the page timeout");
    assert.equal((await call("POST", `/api/runs/${a.run.id}/cancel`)).status, 409);

    // The queued test of project c starts when a's slot frees up; cancel it, then delete b while running.
    await waitFor(c.run.id, (r) => r.status === "running");
    assert.equal((await call("DELETE", `/api/projects/${b.project.id}`)).status, 204);
    assert.equal((await call("GET", `/api/runs/${b.run.id}`)).status, 404);
    const d = await make(4);
    const e = await make(5);
    assert.equal((await call("GET", `/api/runs/${e.run.id}`)).body.status, "queued");
    assert.equal((await call("DELETE", `/api/projects/${e.project.id}`)).status, 204, "a waiting test no longer blocks deleting");
    assert.equal((await call("POST", `/api/runs/${c.run.id}/cancel`)).body.status, "cancelled");
    assert.equal((await call("POST", `/api/runs/${d.run.id}/cancel`)).body.status, "cancelled");
  });

  it("keeps errors to one readable line", () => {
    const err = new Error("browserContext.newPage: Target page, context or browser has been closed\nBrowser logs:\n<launching> /opt/chromium --headless\n[pid=1] <gracefully close start>");
    assert.equal(shortError(err), "browserContext.newPage: Target page, context or browser has been closed");
  });
});
