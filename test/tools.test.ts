import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { syncIssues } from "../src/issues.js";
import { createApp } from "../src/server.js";
import { TOOLS, cleanChoices, runTools } from "../src/tools/index.js";
import { readLighthouse, lighthouseTool } from "../src/tools/lighthouse.js";
import { nucleiTool, readNuclei } from "../src/tools/nuclei.js";
import { which } from "../src/tools/process.js";
import { readTestssl, testsslTool } from "../src/tools/testssl.js";
import type { Tool, ToolContext } from "../src/tools/types.js";
import { readVnu, vnuTool } from "../src/tools/vnu.js";
import { readZap, zapTool } from "../src/tools/zap.js";
import type { Finding, Project, Run, ScanResult } from "../src/types.js";
import { requests, startDemoTools, type DemoTools } from "./fixtures/demo-tools.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.DEFAULT_TOOLS = "none";

const COOKIE = "sid=demo-session-0123456789";
const SECRET = "demo-session-0123456789";

function ctx(dir: string, startUrl: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    product: "webapp",
    target: { url: startUrl },
    startUrl,
    urls: [startUrl],
    options: {},
    outDir: dir,
    workDir: dir,
    signal: new AbortController().signal,
    log: () => {},
    ...extra,
  };
}

function result(findings: Finding[], pages: string[], scores: ScanResult["scores"] = { security: 100, performance: 100, functional: 100 }): ScanResult {
  return {
    startUrl: pages[0],
    startedAt: "2026-11-17T00:00:00Z",
    finishedAt: "2026-11-17T00:00:01Z",
    pages: pages.map((url) => ({ url, status: 200, title: "x", loadMs: 10 })),
    findings,
    scores,
    overallScore: 100,
    agentStats: [],
  };
}

describe("reading each tool's results", () => {
  it("Lighthouse: slow metrics and the biggest savings, without notes that save nothing", () => {
    const lhr = {
      categories: {
        performance: {
          title: "Performance",
          score: 0.42,
          auditRefs: [
            { id: "largest-contentful-paint", weight: 25, group: "metrics" },
            { id: "render-blocking-insight", weight: 0 },
            { id: "lcp-breakdown-insight", weight: 0 },
          ],
        },
        accessibility: { title: "Accessibility", score: 0.83, auditRefs: [] },
        "best-practices": {
          title: "Best practices",
          score: 0.9,
          auditRefs: [
            { id: "errors-in-console", weight: 1 },
            { id: "image-aspect-ratio", weight: 1 },
          ],
        },
        seo: { title: "SEO", score: 1, auditRefs: [] },
      },
      audits: {
        "largest-contentful-paint": { id: "largest-contentful-paint", title: "Largest Contentful Paint", score: 0.2, scoreDisplayMode: "numeric", displayValue: "6.1 s" },
        "render-blocking-insight": { id: "render-blocking-insight", title: "Render-blocking requests", score: 0, scoreDisplayMode: "metricSavings", details: { overallSavingsMs: 1500, items: [{ url: "https://x/app.js" }] } },
        "lcp-breakdown-insight": { id: "lcp-breakdown-insight", title: "LCP breakdown", score: 0, scoreDisplayMode: "metricSavings" },
        "errors-in-console": { id: "errors-in-console", title: "Errors logged", score: 0, scoreDisplayMode: "binary" },
        "image-aspect-ratio": { id: "image-aspect-ratio", title: "Displays images with incorrect aspect ratio", score: 0, scoreDisplayMode: "binary" },
      },
    };
    const { findings, summary } = readLighthouse(lhr, "https://x/", "phone");
    assert.equal(summary, "Performance 42 · Accessibility 83 · Best practices 90 · SEO 100");
    const lcp = findings.find((f) => f.rule === "lighthouse:perf-lcp")!;
    assert.equal(lcp.severity, "medium");
    assert.deepEqual(lcp.sameAs, ["perf:lcp"], "the platform's own LCP finding is the same problem");
    const blocking = findings.find((f) => f.rule === "lighthouse:perf-render-blocking-insight")!;
    assert.equal(blocking.severity, "medium", "1.5 s of savings");
    assert.equal(blocking.evidence, "https://x/app.js");
    assert.ok(!findings.some((f) => f.rule.includes("lcp-breakdown")), "an explanation with no saving is not a problem");
    assert.ok(!findings.some((f) => f.rule.includes("errors-in-console")), "the platform's JavaScript error check covers it");
    assert.ok(findings.some((f) => f.rule === "lighthouse:bp-image-aspect-ratio"));
  });

  it("W3C HTML checker: one finding per message per page, duplicate ids rated higher", () => {
    const msgs = [
      { type: "error" as const, url: "file:/w/page-1.html", message: "Duplicate ID “top”.", extract: '<p id="top">', lastLine: 3 },
      { type: "error" as const, url: "file:/w/page-1.html", message: "Stray end tag “div”.", lastLine: 5 },
      { type: "error" as const, url: "file:/w/page-1.html", message: "Stray end tag “div”.", lastLine: 9 },
      { type: "info" as const, subType: "warning", url: "file:/w/page-1.html", message: "Consider adding a lang attribute." },
    ];
    const f = readVnu(msgs, (u) => (u.endsWith("page-1.html") ? "https://x/" : undefined));
    assert.equal(f.length, 2, "warnings are left out");
    assert.equal(f.find((x) => /Duplicate/.test(x.title))!.severity, "medium");
    const stray = f.find((x) => /Stray/.test(x.title))!;
    assert.equal(stray.count, 2);
    assert.match(stray.evidence!, /Line 5[\s\S]*Line 9/);
  });

  it("testssl.sh: no line per cipher, no grade as a finding, BREACH kept low, HSTS folded", () => {
    const items = [
      { id: "TLS1", severity: "LOW", finding: "offered (deprecated)" },
      { id: "cipher-tls1_2_xc027", severity: "LOW", finding: "TLSv1.2 xc027 ECDHE-RSA-AES128-SHA256" },
      { id: "cipherlist_OBSOLETED", severity: "LOW", finding: "offered" },
      { id: "overall_grade", severity: "CRITICAL", finding: "T" },
      { id: "BREACH", severity: "MEDIUM", finding: "potentially NOT ok, uses gzip" },
      { id: "HSTS", severity: "LOW", finding: "not offered" },
      { id: "cert_chain_of_trust", severity: "CRITICAL", finding: "failed (self signed)." },
      { id: "TLS1_2", severity: "OK", finding: "offered" },
    ];
    const f = readTestssl(items, "https://x/");
    assert.deepEqual(f.map((x) => x.rule).sort(), ["testssl:BREACH", "testssl:HSTS", "testssl:TLS1", "testssl:cert_chain_of_trust", "testssl:cipherlist_OBSOLETED"]);
    assert.equal(f.find((x) => x.rule === "testssl:BREACH")!.severity, "low");
    assert.equal(f.find((x) => x.rule === "testssl:TLS1")!.title, "The server still allows TLS 1.0");
    assert.deepEqual(f.find((x) => x.rule === "testssl:HSTS")!.sameAs, ["sec:hsts-missing"]);
    assert.equal(f.find((x) => x.rule === "testssl:cert_chain_of_trust")!.severity, "critical");
  });

  it("Nuclei: problems become findings, recognised technology goes in the summary", () => {
    const lines = [
      JSON.stringify({ "template-id": "tech-detect", info: { name: "Wappalyzer", severity: "info", tags: ["tech"] }, "matcher-name": "nginx", "matched-at": "https://x/" }),
      JSON.stringify({ "template-id": "exposed-env", info: { name: "Exposed .env", severity: "high", remediation: "Block it.", classification: { "cve-id": null } }, "matched-at": "https://x/.env" }),
      JSON.stringify({ "template-id": "CVE-2021-1", info: { name: "Old plugin", severity: "critical", classification: { "cve-id": ["cve-2021-1"] } }, "matched-at": "https://x/wp" }),
      "not json",
    ].join("\n");
    const { findings, tech } = readNuclei(lines, "https://x/");
    assert.deepEqual(tech, ["nginx"]);
    assert.equal(findings.length, 2);
    assert.deepEqual(findings.find((f) => f.rule === "nuclei:exposed-env")!.sameAs, ["sec:exposed-env"]);
    assert.match(findings.find((f) => f.rule === "nuclei:CVE-2021-1")!.detail, /CVE-2021-1/);
  });

  it("ZAP: one finding per rule per page, without informational or low-confidence alerts", () => {
    const alerts = [
      { pluginId: "10038", name: "CSP Header Not Set", risk: "Medium", confidence: "High", url: "https://x/" },
      { pluginId: "10038", name: "CSP Header Not Set", risk: "Medium", confidence: "High", url: "https://x/#top" },
      { pluginId: "10027", name: "Suspicious Comments", risk: "Informational", confidence: "Low", url: "https://x/" },
      { pluginId: "10202", name: "Absence of Anti-CSRF Tokens", risk: "Medium", confidence: "Low", url: "https://x/form" },
      { pluginId: "10054", name: "Cookie without SameSite", risk: "Low", confidence: "Medium", url: "https://x/", param: "sid" },
    ];
    const f = readZap(alerts);
    assert.equal(f.length, 2);
    assert.equal(f.find((x) => x.rule === "zap:10038")!.count, 2);
    assert.deepEqual(f.find((x) => x.rule === "zap:10038")!.sameAs, ["sec:csp-missing"]);
    assert.equal(f.find((x) => x.rule === "zap:10054")!.evidence, "sid");
  });
});

describe("choosing tools", () => {
  it("accepts tool ids and options, and refuses unknown tools, wrong products and bad options", () => {
    assert.deepEqual(cleanChoices("website", ["lighthouse", { id: "vnu" }, "lighthouse"]), [{ id: "lighthouse" }, { id: "vnu" }]);
    assert.deepEqual(cleanChoices("website", [{ id: "lighthouse", options: { device: "desktop" } }]), [{ id: "lighthouse", options: { device: "desktop" } }]);
    assert.throws(() => cleanChoices("website", ["sqlmap"]), /Unknown tool/);
    assert.throws(() => cleanChoices("code", ["zap"]), /does not test this kind/);
    assert.throws(() => cleanChoices("website", [{ id: "lighthouse", options: { device: "tv" } }]), /not a choice/);
    assert.throws(() => cleanChoices("website", "lighthouse"), /must be a list/);
  });

  it("offers the right tools for each product type", () => {
    const ids = (p: Parameters<typeof cleanChoices>[0]) => TOOLS.filter((t) => t.products.includes(p)).map((t) => t.id);
    assert.deepEqual(ids("website"), ["lighthouse", "vnu", "zap", "nuclei", "testssl"]);
    assert.deepEqual(ids("api"), ["zap", "nuclei", "testssl"]);
    assert.deepEqual(ids("code"), []);
    assert.ok(TOOLS.every((t) => t.safety === "safe"), "phase 1 has only safe tools");
  });
});

describe("merging tools into one report", () => {
  let dir: string;
  const fake: Tool = {
    id: "fake",
    name: "Fake tool",
    maker: "GLV",
    description: "",
    checks: [],
    products: ["website", "crm"],
    category: "security",
    safety: "safe",
    takes: "",
    licence: "",
    homepage: "",
    signedIn: "uses-login",
    async ready() {
      return null;
    },
    async run(c) {
      await writeFile(path.join(c.outDir, "tool-fake.html"), `<p>Cookie: ${c.cookie}</p>`);
      return {
        findings: [
          { category: "security", rule: "fake:csp", severity: "medium", title: "No CSP", detail: "", pageUrl: "https://x/about", sameAs: ["sec:csp-missing"] },
          { category: "security", rule: "fake:leak", severity: "high", title: "Leaks the session", detail: `Saw ${c.cookie}`, pageUrl: "https://x/" },
          { category: "seo", rule: "fake:seo", severity: "low", title: "Search tip", detail: "", pageUrl: "https://x/" },
        ],
        reports: [{ file: "tool-fake.html", label: "Fake report" }],
        summary: ["2 problems"],
      };
    },
  };
  const broken: Tool = { ...fake, id: "broken", name: "Broken tool", ready: async () => "Broken tool is not installed on this server." };

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-tools-"));
    TOOLS.push(fake, broken);
  });
  after(async () => {
    TOOLS.splice(TOOLS.indexOf(fake), 2);
    await rm(dir, { recursive: true, force: true });
  });

  it("folds repeats into the platform's finding, hides the session, drops categories the test does not score, and rescores", async () => {
    const own: Finding = { id: "a", category: "security", rule: "sec:csp-missing", severity: "medium", title: "Missing CSP", detail: "Add one.", pageUrl: "https://x/", agent: "web.security-headers" };
    const merged = await runTools(result([own], ["https://x/", "https://x/about"], { security: 100, functional: 100 }), {
      product: "crm",
      target: { url: "https://x/" },
      choices: [{ id: "fake" }, { id: "broken" }],
      cookie: COOKIE,
      secrets: [SECRET],
      artifactsDir: dir,
      workDir: dir,
      signal: new AbortController().signal,
      log: () => {},
    });
    assert.equal(merged.findings.filter((f) => f.rule.includes("csp")).length, 1, "the CSP problem is shown once");
    assert.match(merged.findings.find((f) => f.rule === "sec:csp-missing")!.detail, /Also found by Fake tool\./);
    const leak = merged.findings.find((f) => f.rule === "fake:leak")!;
    assert.equal(leak.agent, "tool.fake");
    assert.ok(!leak.detail.includes(SECRET), "the session cookie is hidden in findings");
    assert.ok(!(await readFile(path.join(dir, "tool-fake.html"), "utf8")).includes(SECRET), "and in the tool's own report");
    assert.ok(!merged.findings.some((f) => f.category === "seo"), "a CRM has no search score");
    assert.ok(merged.scores.security! < 100);
    const [fakeStat, brokenStat] = merged.tools!;
    assert.deepEqual([fakeStat.status, fakeStat.findings, fakeStat.merged], ["done", 2, 1]);
    assert.equal(brokenStat.status, "untested");
    assert.deepEqual(merged.incomplete, ["Broken tool: Broken tool is not installed on this server."], "a tool that could not run makes the test incomplete");
  });

  it("closes a tool's issue once the tool runs again without finding it, but not when it could not run", () => {
    const project: Project = { id: "p", key: "T", name: "T", type: "website", target: { url: "https://x/" }, schedule: "off", createdAt: "", issueSeq: 0 };
    const first: Run = { id: "r1", url: "https://x/", status: "done", createdAt: "", progress: [], agents: [], tools: [{ id: "fake" }] };
    const leak: Finding = { id: "l", category: "security", rule: "fake:leak", severity: "high", title: "Leaks", detail: "", pageUrl: "https://x/.env", agent: "tool.fake" };
    const s1 = syncIssues(project, { ...first, result: result([leak], ["https://x/"]) }, []);
    assert.equal(s1.created.length, 1);
    const issues = s1.created;
    const failed = result([], ["https://x/"]);
    failed.agentStats = [{ id: "tool.fake", name: "Fake", findings: 0, ms: 0, errors: 1, untested: "not installed" }];
    const s2 = syncIssues(s1.project, { ...first, id: "r2", result: failed }, issues);
    assert.equal(s2.diff.fixed, 0, "not checked again, so not fixed");
    const s3 = syncIssues(s1.project, { ...first, id: "r3", result: result([], ["https://x/"]) }, issues);
    assert.equal(s3.diff.fixed, 1, "the tool ran and did not find it: fixed");
    const s4 = syncIssues(s1.project, { ...first, id: "r4", tools: [], result: result([], ["https://x/"]) }, issues);
    assert.equal(s4.diff.fixed, 0, "the tool was turned off for this run");
  });
});

describe("the tools on a real site", () => {
  let site: DemoTools;
  let dir: string;
  before(async () => {
    site = await startDemoTools(4250, 4251);
    dir = await mkdtemp(path.join(tmpdir(), "glv-tools-run-"));
  });
  after(async () => {
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("Lighthouse scores the page and its report keeps no session cookie", { timeout: 240_000 }, async () => {
    const r = await runTools(result([], [`${site.base}/`]), {
      product: "website",
      target: { url: `${site.base}/` },
      choices: [{ id: "lighthouse" }],
      cookie: COOKIE,
      secrets: [SECRET],
      artifactsDir: dir,
      workDir: dir,
      signal: new AbortController().signal,
      log: () => {},
    });
    const t = r.tools![0];
    assert.equal(t.status, "done", t.untested);
    assert.match(t.summary![0], /^Performance \d+ · Accessibility \d+ · Best practices \d+ · SEO \d+$/);
    assert.ok(r.findings.some((f) => f.rule.startsWith("lighthouse:perf-")), "the 2.5 s render-blocking script slows the page");
    const html = await readFile(path.join(dir, t.reports![0].file), "utf8");
    assert.ok(html.includes("lighthouse") && !html.includes(SECRET));
  });

  it("the W3C HTML checker finds the planted errors, and the signed-in page's error only with the session", { timeout: 120_000 }, async (t) => {
    if (await vnuTool.ready()) return t.skip("Java is not installed");
    const urls = [`${site.base}/`, `${site.base}/account`];
    const out = await vnuTool.run(ctx(dir, `${site.base}/`, { urls, cookie: COOKIE }));
    assert.ok(out.findings.some((f) => f.title === 'HTML error: Duplicate ID "top".' && f.severity === "medium"));
    assert.ok(out.findings.some((f) => /"div" not allowed as child of element "ul"/.test(f.title)));
    assert.ok(out.findings.some((f) => f.pageUrl.endsWith("/account")), "the signed-in page was checked");
    const anon = await vnuTool.run(ctx(dir, `${site.base}/`, { urls }));
    assert.ok(!anon.findings.some((f) => f.pageUrl.endsWith("/account")), "without the session, the account page has no error");
  });

  it("Nuclei runs only read-only checks: never POST, never an attack", { timeout: 180_000 }, async (t) => {
    if (await nucleiTool.ready()) return t.skip("Nuclei is not installed");
    process.env.NUCLEI_TEMPLATES = path.join(import.meta.dirname, "fixtures", "nuclei");
    requests.length = 0;
    try {
      const out = await nucleiTool.run(ctx(dir, `${site.base}/`));
      assert.ok(out.findings.some((f) => f.rule === "nuclei:glv-test-env-file" && f.severity === "high"));
      assert.match(out.summary!.join(" "), /Express detected/);
      assert.deepEqual([...new Set(requests.map((r) => r.method))], ["GET"], "no POST, PUT, PATCH or DELETE reached the site");
      assert.ok(!requests.some((r) => r.path === "/login" || r.path === "/api/reset"), "the POST checks were left out");
      assert.ok(!out.findings.some((f) => f.rule === "nuclei:glv-test-sqli"), "attack checks (sqli) were left out");
    } finally {
      delete process.env.NUCLEI_TEMPLATES;
    }
  });

  it("testssl.sh reports the self-signed certificate", { timeout: 480_000 }, async (t) => {
    if ((await testsslTool.ready()) || !site.httpsBase) return t.skip("testssl.sh or openssl is not installed");
    const out = await testsslTool.run(ctx(dir, `${site.httpsBase}/`));
    assert.ok(out.findings.some((f) => f.rule === "testssl:cert_chain_of_trust" && f.severity === "critical"));
    assert.ok(!out.findings.some((f) => f.rule.startsWith("testssl:cipher-")), "no finding per cipher");
    const http = await testsslTool.run(ctx(dir, `${site.base}/`));
    assert.equal(http.findings.length, 0, "a plain http address has no TLS to check");
  });

  it("ZAP looks at the pages without attacking them", { timeout: 240_000 }, async (t) => {
    if (await zapTool.ready()) return t.skip("ZAP is not running (set ZAP_URL and ZAP_API_KEY)");
    requests.length = 0;
    const out = await zapTool.run(ctx(dir, `${site.base}/`, { urls: [`${site.base}/`, `${site.base}/about`] }));
    assert.ok(out.findings.some((f) => f.rule === "zap:10038"), "CSP header not set");
    assert.ok(out.findings.some((f) => f.rule === "zap:10037"), "X-Powered-By leak");
    assert.deepEqual([...new Set(requests.map((r) => r.method))], ["GET"]);
  });

  it("finds whether each tool is installed", async () => {
    assert.equal(await lighthouseTool.ready(), null, "Lighthouse is a dependency of the platform");
    if (!process.env.ZAP_URL) assert.match((await zapTool.ready())!, /ZAP_URL/);
    if (!(await which("nuclei")) && !process.env.NUCLEI_PATH) assert.match((await nucleiTool.ready())!, /not installed/);
  });
});

describe("tools through the dashboard API", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-tools-api-"));
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = async (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.json(), headers: res.headers };
  };

  it("lists the tools with whether each is ready, and saves the tester's choice on the project", async () => {
    const meta = await call("GET", "/api/meta");
    const lh = meta.body.tools.find((t: { id: string }) => t.id === "lighthouse");
    assert.equal(lh.ready, true);
    assert.equal(lh.safety, "safe");
    assert.equal(typeof lh.run, "undefined");
    const bad = await call("POST", "/api/projects", { type: "website", url: "http://localhost:4299/", tools: ["sqlmap"] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Unknown tool/);
    const made = await call("POST", "/api/projects", { type: "website", url: "http://localhost:4299/", tools: [{ id: "lighthouse", options: { device: "desktop" } }] });
    assert.equal(made.status, 201);
    assert.deepEqual(made.body.project.tools, [{ id: "lighthouse", options: { device: "desktop" } }]);
    const changed = await call("PATCH", `/api/projects/${made.body.project.id}`, { tools: [] });
    assert.deepEqual(changed.body.tools, []);
    const none = await call("POST", "/api/projects", { type: "website", url: "http://localhost:4299/x" });
    assert.deepEqual(none.body.project.tools, [], "DEFAULT_TOOLS=none: no tools unless chosen");
  });

  it("serves a tool's report in a sandbox, and only tool report files", async () => {
    const runDir = path.join(dir, "artifacts", "run-1");
    await (await import("node:fs/promises")).mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "tool-lighthouse-1.html"), "<p>report</p>");
    const ok = await app.inject({ method: "GET", url: "/api/runs/run-1/artifacts/tool-lighthouse-1.html" });
    assert.equal(ok.statusCode, 200);
    assert.match(String(ok.headers["content-security-policy"]), /^sandbox/);
    const other = await app.inject({ method: "GET", url: "/api/runs/run-1/artifacts/secrets.json" });
    assert.equal(other.statusCode, 400);
  });
});
