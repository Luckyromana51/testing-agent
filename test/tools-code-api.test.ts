import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { toJunit, toSarif } from "../src/export.js";
import { fixFor } from "../src/fixes.js";
import { createApp } from "../src/server.js";
import { gitleaksTool, readGitleaks, secretName } from "../src/tools/gitleaks.js";
import { cleanChoices, defaultChoices, runTools } from "../src/tools/index.js";
import { newmanTool, readNewman, readOnlyCollection } from "../src/tools/newman.js";
import { opengrepTool, readOpengrep, ruleId, rulesDir } from "../src/tools/opengrep.js";
import { osvTool, readOsv } from "../src/tools/osv.js";
import { packageFinding, upgradeTarget } from "../src/tools/packages.js";
import { readSchemathesis, schemathesisTool } from "../src/tools/schemathesis.js";
import { unpackZip } from "../src/tools/source.js";
import { readTrivy, trivyTool } from "../src/tools/trivy.js";
import type { ToolContext } from "../src/tools/types.js";
import type { Finding, ScanResult } from "../src/types.js";
import { DEMO_TOKEN, startDemoApi, type DemoApi } from "./fixtures/demo-api.js";
import { demoCollection } from "./fixtures/demo-collection.js";
import { demoCodeRepo, demoCodeZip, FAKE_NPM_TOKEN, FAKE_OLD_GITHUB } from "./fixtures/demo-code.js";
import { FAKE_AWS_KEY } from "./fixtures/demo-apk.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.DEFAULT_TOOLS = "none";

function ctx(dir: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    product: "code",
    target: {},
    startUrl: "",
    urls: [],
    options: {},
    uploadsDir: dir,
    outDir: dir,
    workDir: dir,
    signal: new AbortController().signal,
    log: () => {},
    ...extra,
  };
}

function result(findings: Finding[], pages: string[], scores: ScanResult["scores"]): ScanResult {
  return {
    startUrl: pages[0] ?? "project",
    startedAt: "2026-11-17T00:00:00Z",
    finishedAt: "2026-11-17T00:00:01Z",
    pages: pages.map((url) => ({ url, status: null, title: url, loadMs: null })),
    findings,
    scores,
    overallScore: 100,
    agentStats: [],
  };
}

const own = (rule: string, pageUrl: string, evidence: string, title = "x"): Finding => ({
  id: rule,
  category: "security",
  rule,
  severity: "high",
  title,
  detail: "Found.",
  pageUrl,
  evidence,
  agent: "code.packages",
});

describe("reading the code and API tools' results", () => {
  it("packages: the lowest version that fixes every hole, on the same major version when there is one", () => {
    const v = (fixed: string[]) => ({ id: "X", severity: "high" as const, fixed });
    assert.equal(upgradeTarget("3.2.0", [v(["3.2.5", "3.1.13"]), v(["2.2.28", "3.2.13", "4.0.4"])]), "3.2.13");
    assert.equal(upgradeTarget("4.17.15", [v(["4.17.19"]), v(["4.17.21"])]), "4.17.21");
    assert.equal(upgradeTarget("1.0.0", [v([])]), undefined);
    const f = packageFinding("go.mod", "golang.org/x/text", "v0.3.0", [{ id: "GO-2020-0015", cve: "CVE-2020-14040", severity: "high", fixed: ["0.3.3"] }], "OSV database");
    assert.equal(f.key, "pkg:go.mod:golang.org/x/text@0.3.0", "a leading v does not make it another package");
    assert.match(f.detail, /Upgrade to 0\.3\.3 or newer/);
  });

  it("Gitleaks: one finding per kind and file, never the secret, and old commits named as history", () => {
    const leaks = [
      { RuleID: "aws-access-token", Description: "Identified a pattern that may indicate AWS credentials", StartLine: 1, File: "/src/config.js" },
      { RuleID: "aws-access-token", Description: "", StartLine: 9, File: "/src/config.js" },
      { RuleID: "github-pat", Description: "", StartLine: 2, File: "deploy.sh", Commit: "d80e611c0000", Date: "2026-11-17T00:00:00Z" },
      { RuleID: "generic-api-key", Description: "", StartLine: 3, File: "/src/test/fixtures/keys.js" },
    ];
    const out = readGitleaks(leaks, "/src", new Set(["config.js:1:aws-access-token"]));
    assert.equal(out.length, 3);
    const aws = out.find((f) => f.rule === "gitleaks:aws-access-token")!;
    assert.deepEqual([aws.title, aws.severity, aws.count, aws.pageUrl], ["Code contains an AWS access key", "critical", 2, "config.js"]);
    assert.deepEqual(aws.sameAs, ["code:secret-aws-key"]);
    const old = out.find((f) => f.rule === "gitleaks:github-pat")!;
    assert.match(old.title, /^Git history still holds a GitHub personal access token/);
    assert.match(old.detail, /commit d80e611c/);
    assert.equal(old.sameAs, undefined, "a secret only in the history is not the platform's finding");
    assert.equal(out.find((f) => f.rule === "gitleaks:generic-api-key")!.severity, "low", "a test file's key may be a dummy");
    assert.equal(secretName("twilio-api-key"), "a Twilio API key");
  });

  it("OSV-Scanner and Trivy: one finding per package, joined across their ids", () => {
    const osv = readOsv(
      {
        results: [
          {
            source: { path: "/src/requirements.txt", type: "lockfile" },
            packages: [
              {
                package: { name: "django", version: "3.2.0", ecosystem: "PyPI" },
                vulnerabilities: [
                  { id: "PYSEC-2021-109", aliases: ["CVE-2021-35042"], summary: "SQL injection", affected: [{ package: { name: "django" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "3.2.5" }] }] }] },
                  { id: "GHSA-xpfp-f569-q3p2", aliases: ["CVE-2021-35042"] },
                ],
                groups: [{ ids: ["PYSEC-2021-109", "GHSA-xpfp-f569-q3p2"], max_severity: "9.8" }],
              },
            ],
          },
        ],
      },
      "/src",
    );
    assert.equal(osv.findings.length, 1);
    assert.deepEqual([osv.findings[0].pageUrl, osv.findings[0].severity, osv.findings[0].key], ["requirements.txt", "critical", "pkg:requirements.txt:django@3.2.0"]);
    assert.match(osv.findings[0].detail, /1 published vulnerability: CVE-2021-35042 \(SQL injection\)\. Upgrade to 3\.2\.5/);

    const trivy = readTrivy({
      Results: [
        { Target: "requirements.txt", Class: "lang-pkgs", Vulnerabilities: [{ VulnerabilityID: "CVE-2021-35042", PkgName: "Django", InstalledVersion: "3.2.0", FixedVersion: "3.2.5, 3.1.13", Severity: "CRITICAL" }] },
        {
          Target: "k8s/deploy.yaml",
          Class: "config",
          Type: "kubernetes",
          Misconfigurations: [
            { ID: "KSV-0017", Title: "Privileged", Severity: "HIGH", Status: "FAIL", CauseMetadata: { StartLine: 13 } },
            { ID: "KSV-0011", Title: "CPU not limited", Severity: "LOW", Status: "FAIL" },
            { ID: "KSV-0012", Title: "Runs as root user", Severity: "MEDIUM", Status: "PASS" },
          ],
        },
        { Target: "package-lock.json", Class: "license", Licenses: [{ Severity: "CRITICAL", Category: "forbidden", PkgName: "agpl-widget", Name: "AGPL-3.0-only" }, { Severity: "LOW", Category: "notice", PkgName: "lodash", Name: "MIT" }] },
      ],
    });
    const byRule = Object.fromEntries(trivy.findings.map((f) => [f.rule, f]));
    assert.equal(byRule["pkg:vulnerable"].key, "pkg:requirements.txt:django@3.2.0", "the same key as OSV-Scanner's copy");
    assert.equal(byRule["trivy:KSV-0017"].severity, "high", "a privileged container keeps Trivy's level");
    assert.equal(byRule["trivy:KSV-0011"].severity, "info", "hardening notes count one step lower");
    assert.ok(!byRule["trivy:KSV-0012"], "passed checks are not findings");
    assert.match(byRule["trivy:licence"].title, /agpl-widget \(AGPL-3\.0-only\)/);
    assert.equal(trivy.findings.filter((f) => f.rule === "trivy:licence").length, 1, "MIT is fine");
  });

  it("Opengrep: rule ids without the folder, one finding per rule and file, linked to the platform's check", () => {
    assert.equal(ruleId("app.rules.opengrep.glv.js.sql-injection"), "glv.js.sql-injection");
    const out = readOpengrep(
      {
        results: [
          { check_id: "x.glv.js.sql-injection", path: "server.js", start: { line: 7 }, extra: { message: "SQL query built.  Pass values.", severity: "ERROR", metadata: { "glv-same-as": "code:sql-injection", "glv-title": "SQL from request data", cwe: "CWE-89" } } },
          { check_id: "x.glv.js.sql-injection", path: "server.js", start: { line: 20 }, extra: { message: "SQL query built.", severity: "ERROR" } },
          { check_id: "x.glv.js.open-redirect", path: "server.js", start: { line: 30 }, extra: { message: "Redirect. Fix it.", severity: "WARNING" } },
        ],
      },
      "/src",
      (_f, n) => (n === 7 ? '  db.query("SELECT " + req.query.id);' : ""),
    );
    assert.equal(out.length, 2);
    assert.deepEqual([out[0].title, out[0].severity, out[0].count, out[0].evidence], ["SQL from request data", "high", 2, 'line 7: db.query("SELECT " + req.query.id);']);
    assert.deepEqual([out[0].sameAs, out[0].sameScope], [["code:sql-injection"], "file"]);
    assert.match(out[0].detail, /\(and 1 more in this file\)\. SQL query built\. Pass values\. \(CWE-89\)/);
    assert.equal(out[1].severity, "medium");
  });

  it("Schemathesis: one finding per kind and endpoint, with the request that shows it and no repeat for a 5xx", () => {
    const scenario = (label: string, code: string, title: string, uri: string, status: number, mode = "positive") =>
      JSON.stringify({
        ScenarioFinished: {
          status: "failure",
          recorder: {
            label,
            cases: { c1: { value: { meta: { generation: { mode } } } } },
            checks: { c1: [{ name: "x", status: "failure", failure_info: { failure: { type: "T", code, operation: label, title, message: `${title}.`, case_id: "c1" } } }] },
            interactions: { c1: { request: { method: "GET", uri }, response: { status_code: status } } },
          },
        },
      });
    const ndjson = [
      scenario("GET /orders", "ST101", "Server error", "http://api/v1/orders?api_key=SECRET", 500),
      scenario("GET /orders", "ST103", "Undocumented status code", "http://api/v1/orders", 500),
      scenario("GET /users/{id}", "ST101", "Server error", "http://api/v1/users/%20", 500, "negative"),
      JSON.stringify({ ScenarioFinished: { status: "success", recorder: { label: "GET /health", cases: { a: {} }, checks: {}, interactions: {} } } }),
    ].join("\n");
    const { findings, tested } = readSchemathesis(ndjson, "api_key");
    assert.equal(tested.size, 3);
    assert.equal(findings.length, 2, "the 500 is not also an undocumented status");
    const orders = findings.find((f) => f.title.includes("/orders"))!;
    assert.deepEqual([orders.title, orders.severity, orders.sameScope, orders.sameText], ["Server error (HTTP 500): GET /orders", "high", "endpoint", "/orders"]);
    assert.ok(!orders.evidence!.includes("SECRET"), "a key in the query string is hidden");
    assert.equal(findings.find((f) => f.title.includes("/users"))!.severity, "medium", "a crash on input the file does not allow is less urgent");
  });

  it("Newman: only GET requests, no scripts that send their own, and no addresses the platform refuses", () => {
    const prev = process.env.ALLOW_PRIVATE_TARGETS;
    delete process.env.ALLOW_PRIVATE_TARGETS;
    try {
      const col = demoCollection();
      col.item.push({ name: "Cloud metadata", request: { method: "GET", url: "http://169.254.169.254/latest/meta-data/" } } as never);
      const ro = readOnlyCollection(col as never, { baseUrl: "https://api.example.com/v1" });
      assert.equal(ro.kept, 5);
      assert.deepEqual(ro.skipped, ["POST Create a user", "DELETE Delete a user", "GET Cloud metadata (address not allowed)"]);
      assert.equal(ro.scripts, 1);
      assert.ok(!JSON.stringify(ro.collection).includes("sendRequest"));
    } finally {
      if (prev) process.env.ALLOW_PRIVATE_TARGETS = prev;
    }
    const out = readNewman({
      run: {
        executions: [
          { item: { name: "Orders" }, request: { method: "GET", url: { protocol: "https", host: ["api", "example", "com"], path: ["v1", "orders"] } }, response: { code: 500 }, assertions: [{ assertion: "status is 200", error: { message: "expected 500 to be 200" } }, { assertion: "fast" }] },
          { item: { name: "Down" }, request: { method: "GET", url: { protocol: "https", host: ["down"], path: [] } }, requestError: { code: "ECONNREFUSED" } },
        ],
      },
    });
    assert.deepEqual(
      out.map((f) => [f.rule, f.pageUrl]),
      [
        ["newman:test-failed", "https://api.example.com/v1/orders"],
        ["newman:no-answer", "https://down/"],
      ],
    );
  });

  it("gives every tool finding written fix advice, not a copy of the problem", async () => {
    const ids: string[] = [];
    for (const f of readdirSync(rulesDir())) ids.push(...[...readFileSync(path.join(rulesDir(), f), "utf8").matchAll(/^ {2}- id: (\S+)/gm)].map((m) => m[1]));
    assert.equal(ids.length, 40);
    const rules = [
      ...ids.map((id) => `opengrep:${id}`),
      "pkg:vulnerable",
      "gitleaks:aws-access-token",
      "trivy:licence",
      "trivy:DS-0002",
      ...["ST101", "ST103", "ST105", "ST108", "ST109", "ST401"].map((c) => `schemathesis:${c}`),
      "newman:test-failed",
      "newman:no-answer",
    ];
    const detail = "k8s/deploy.yaml line 13: Container runs as root. Fix: Set runAsNonRoot to true.";
    for (const rule of rules) assert.notEqual(fixFor({ rule, detail }).steps, detail, `${rule} has no written fix`);
    assert.equal(fixFor({ rule: "trivy:DS-0002", detail }).steps, "Set runAsNonRoot to true.", "Trivy's own advice, without the problem");
    const upgrade = (d: string) => fixFor({ rule: "pkg:vulnerable", detail: d }).code?.map((c) => c.snippet);
    assert.deepEqual(upgrade("lodash 4.17.15 in web/package-lock.json has 5 published vulnerabilities: x. Upgrade to 4.17.21 or newer."), ["npm install lodash@4.17.21"]);
    assert.deepEqual(upgrade("Django 3.2.0 in requirements.txt has 38 published vulnerabilities: x. Upgrade to 5.2.17 or newer."), ["Django>=5.2.17"]);
    assert.deepEqual(upgrade("golang.org/x/text v0.3.0 in go.mod has 5 published vulnerabilities: x. Upgrade to 0.41.0 or newer."), ["go get golang.org/x/text@v0.41.0 && go mod tidy"]);
    assert.equal(upgrade("left-pad 1.0.0 in package-lock.json has 1 published vulnerability: x. No fixed version is listed yet: upgrade to the latest version, or replace the package."), undefined);
  });
});

describe("choosing the new tools", () => {
  it("Newman needs its uploaded collection; the code tools fit only code, the API tools only APIs", async () => {
    assert.throws(() => cleanChoices("api", [{ id: "newman" }]), /upload the Postman collection first/);
    assert.throws(() => cleanChoices("api", [{ id: "newman", options: { collection: "../../etc/passwd" } }]), /upload the Postman collection again/);
    const file = "0a1b2c3d-1111-2222-3333-444455556666.json";
    assert.deepEqual(cleanChoices("api", [{ id: "newman", options: { collection: file, "collection:name": "Shop <API>.json" } }]), [
      { id: "newman", options: { collection: file, "collection:name": "Shop _API_.json" } },
    ]);
    assert.throws(() => cleanChoices("website", ["gitleaks"]), /does not test this kind of product/);
    assert.throws(() => cleanChoices("code", ["schemathesis"]), /does not test this kind of product/);
    assert.deepEqual(cleanChoices("code", [{ id: "gitleaks", options: { history: "history" } }, "trivy"]), [{ id: "gitleaks", options: { history: "history" } }, { id: "trivy" }]);
    delete process.env.DEFAULT_TOOLS;
    try {
      assert.ok(!(await defaultChoices("api")).some((c) => c.id === "newman"), "never on by default: it needs a file");
    } finally {
      process.env.DEFAULT_TOOLS = "none";
    }
  });
});

describe("one problem found by several tools is one finding", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-fold-"));
  });
  after(async () => rm(dir, { recursive: true, force: true }));

  it("folds packages into the platform's finding or the first tool's, and API failures by endpoint", async () => {
    const { TOOLS } = await import("../src/tools/index.js");
    const pkg = (name: string, version: string) => packageFinding("requirements.txt", name, version, [{ id: "CVE-1", cve: "CVE-1", severity: "high", fixed: [] }], "x");
    const make = (id: string, products: ("code" | "api")[], findings: ReturnType<typeof pkg>[]) => ({
      ...trivyTool,
      id,
      name: id,
      products,
      ready: async () => null,
      run: async () => ({ findings }),
    });
    const a = make("tool-a", ["code"], [pkg("Django", "v3.2.0"), pkg("PyYAML", "5.3")]);
    const b = make("tool-b", ["code"], [pkg("pyyaml", "5.3")]);
    TOOLS.push(a, b);
    try {
      const platform = own("code:vulnerable-package", "requirements.txt", "Django@3.2.0: GHSA-1", "Package with known security holes: Django");
      const merged = await runTools(result([platform], ["requirements.txt"], { security: 100, functional: 100 }), {
        product: "code",
        target: {},
        choices: [{ id: "tool-a" }, { id: "tool-b" }],
        secrets: [],
        artifactsDir: dir,
        uploadsDir: dir,
        workDir: dir,
        sourceDir: dir,
        signal: new AbortController().signal,
        log: () => {},
      });
      assert.deepEqual(
        merged.findings.map((f) => [f.rule, f.title]),
        [
          ["code:vulnerable-package", "Package with known security holes: Django"],
          ["pkg:vulnerable", "Package with known security holes: PyYAML"],
        ],
      );
      assert.match(merged.findings[0].detail, /Also found by tool-a\.$/);
      assert.match(merged.findings[1].detail, /Also found by tool-b\.$/);
      assert.deepEqual(
        merged.tools!.map((t) => [t.findings, t.merged ?? 0]),
        [
          [1, 1],
          [0, 1],
        ],
      );
    } finally {
      TOOLS.splice(TOOLS.indexOf(a), 2);
    }

    const api = make("tool-c", ["api"], [
      { category: "functional", severity: "high", rule: "schemathesis:ST101", title: "Server error: GET /users/{id}", detail: "", pageUrl: "http://api/v1/users/%20", sameAs: ["api:server-error"], sameScope: "endpoint", sameText: "/users/{id}" },
      { category: "functional", severity: "high", rule: "schemathesis:ST101", title: "Server error: GET /orders", detail: "", pageUrl: "http://api/v1/orders", sameAs: ["api:server-error"], sameScope: "endpoint", sameText: "/orders" },
    ] as never);
    TOOLS.push(api);
    try {
      const crash: Finding = { ...own("api:server-error", "http://api/v1/users/1", "HTTP 500"), category: "functional" };
      const merged = await runTools(result([crash], ["http://api/v1/users/1"], { functional: 100, security: 100, performance: 100 }), {
        product: "api",
        target: { url: "http://api/v1" },
        choices: [{ id: "tool-c" }],
        secrets: [],
        artifactsDir: dir,
        uploadsDir: dir,
        workDir: dir,
        signal: new AbortController().signal,
        log: () => {},
      });
      assert.deepEqual(
        merged.findings.map((f) => f.pageUrl),
        ["http://api/v1/users/1", "http://api/v1/orders"],
        "the /users/{id} crash is the platform's own; /orders is new",
      );
    } finally {
      TOOLS.splice(TOOLS.indexOf(api), 1);
    }
  });
});

describe("SARIF and JUnit downloads", () => {
  const r: ScanResult = {
    ...result(
      [
        { ...own("code:sql-injection", "src/db.js", "line 12: db.query(...)", "SQL injection"), agent: "code.risky", severity: "critical" },
        { ...own("trivy:KSV-0011", "k8s/deploy.yaml", "KSV-0011", "CPU not limited"), agent: "tool.trivy", severity: "info" },
        { ...own("api:server-error", "https://api.example.com/v1/orders", "HTTP 500", "Server error <500>"), agent: "api.health", severity: "medium" },
      ],
      ["src/db.js"],
      { security: 60, functional: 90 },
    ),
    agentStats: [
      { id: "code.risky", name: "Risky code", findings: 1, ms: 10, errors: 0 },
      { id: "code.hygiene", name: "Project hygiene", findings: 0, ms: 5, errors: 0 },
      { id: "tool.osv-scanner", name: "OSV-Scanner", findings: 0, ms: 0, errors: 1, untested: "not installed" },
      { id: "tool.trivy", name: "Trivy", findings: 1, ms: 700, errors: 0 },
    ],
  };

  it("SARIF 2.1.0 with file and line for code, the address for web and API, and stable fingerprints", () => {
    const sarif = toSarif(r) as { version: string; runs: { tool: { driver: { rules: { id: string }[] } }; results: Record<string, any>[] }[] };
    assert.equal(sarif.version, "2.1.0");
    const [run] = sarif.runs;
    assert.deepEqual(run.tool.driver.rules.map((x) => x.id), ["code:sql-injection", "trivy:KSV-0011", "api:server-error"]);
    const [sql, note, api] = run.results;
    assert.deepEqual(sql.locations[0].physicalLocation, { artifactLocation: { uri: "src/db.js", uriBaseId: "%SRCROOT%" }, region: { startLine: 12 } });
    assert.deepEqual([sql.level, note.level, api.level], ["error", "note", "warning"]);
    assert.equal(note.properties.foundBy, "trivy");
    assert.deepEqual(api.locations[0].physicalLocation, { artifactLocation: { uri: "https://api.example.com/v1/orders" } });
    assert.equal((toSarif(r) as typeof sarif).runs[0].results[0].partialFingerprints.glvIssue, sql.partialFingerprints.glvIssue);
  });

  it("JUnit: a failed test per issue, a passed test for a clean agent, a skipped test for one that could not run", () => {
    const xml = toJunit(r);
    assert.match(xml, /^<\?xml version="1.0"/);
    assert.match(xml, /<testsuites name="[^"]*" tests="5" failures="2" errors="0" skipped="1">/);
    assert.match(xml, /<testcase classname="code.hygiene" name="Project hygiene: no problems found"/);
    assert.match(xml, /<skipped message="not installed"\/>/);
    assert.match(xml, /Server error &lt;500&gt;/, "text is escaped");
    assert.match(xml, /name="CPU not limited"><system-out>/, "an info note is not a failure");
  });
});

/* ------------------------------------------------------------------------------------------------
 * The real tools. Each test is skipped when its tool is not installed on this machine (the Docker
 * image has them all). In a sandbox without internet, set OSV_SCANNER_OFFLINE=1 and TRIVY_OFFLINE=1
 * with their databases already downloaded.
 * --------------------------------------------------------------------------------------------- */
describe("the code tools on a real project", () => {
  let dir: string;
  let repo: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-code-tools-"));
    repo = await demoCodeRepo(path.join(dir, "repo"));
  });
  after(async () => rm(dir, { recursive: true, force: true }));

  it("unpacks an uploaded zip for the tools without letting it write outside the folder", async () => {
    const { strToU8, zipSync } = await import("fflate");
    await writeFile(path.join(dir, "evil.zip"), zipSync({ "../evil.txt": strToU8("x"), "/abs.txt": strToU8("x"), "shop/ok.js": strToU8("ok") }));
    const root = await unpackZip(path.join(dir, "evil.zip"), path.join(dir, "unz-evil"));
    assert.ok(!existsSync(path.join(dir, "evil.txt")));
    assert.equal(await readFile(path.join(root, "ok.js"), "utf8"), "ok");
    await writeFile(path.join(dir, "code.zip"), demoCodeZip());
    const shop = await unpackZip(path.join(dir, "code.zip"), path.join(dir, "unz"));
    assert.equal(path.basename(shop), "shop", "the zip's one top folder is the project");
    assert.ok(existsSync(path.join(shop, "k8s", "deploy.yaml")));
  });

  it("Gitleaks finds the keys in the files, and the deleted token in the history", { timeout: 120_000 }, async (t) => {
    if (await gitleaksTool.ready()) return t.skip("Gitleaks is not installed");
    const work = path.join(dir, "gl");
    mkdirSync(work);
    const clone = path.join(work, "src");
    cpSync(repo, clone, { recursive: true });
    const files = await gitleaksTool.run(ctx(work, { sourceDir: clone, options: { history: "files" } }));
    assert.deepEqual(files.findings.map((f) => f.pageUrl).sort(), [".npmrc", "config.js"]);
    const all = await gitleaksTool.run(ctx(work, { sourceDir: clone, target: { repoUrl: "https://example.com/shop" }, options: { history: "history" } }));
    const old = all.findings.find((f) => f.pageUrl === "deploy.sh")!;
    assert.match(old.title, /^Git history still holds a GitHub personal access token/);
    const report = await readFile(path.join(work, "tool-gitleaks.json"), "utf8");
    for (const s of [FAKE_AWS_KEY, FAKE_NPM_TOKEN, FAKE_OLD_GITHUB]) assert.ok(!report.includes(s) && !JSON.stringify(all).includes(s), "no secret in the findings or the report");
  });

  it("Opengrep's GLV rules find what each must find, and nothing each must not", { timeout: 300_000 }, async (t) => {
    if (await opengrepTool.ready()) return t.skip("Opengrep is not installed (OPENGREP_PATH can point to Semgrep CE)");
    // Each rules file has examples in test/opengrep: "ruleid:" lines must be found, "ok:" lines must not.
    const suite = path.join(dir, "rule-tests");
    mkdirSync(suite);
    cpSync(rulesDir(), suite, { recursive: true });
    const examples = path.resolve("test/opengrep");
    for (const f of ["javascript.js", "javascript-react.jsx", "python.py", "php.php", "java.java", "go.go", "csharp.cs"]) {
      cpSync(path.join(examples, f), path.join(suite, f.replace("javascript-react", "javascript")));
    }
    const bin = process.env.OPENGREP_PATH || "opengrep";
    const out = execFileSync(bin, ["scan", "--test", ...(/semgrep$/.test(bin) ? ["--metrics=off"] : []), "."], { cwd: suite, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(out, /(\d+)\/\1: ✓ All tests passed/);
    const r = await opengrepTool.run(ctx(path.join(dir), { sourceDir: repo }));
    const found = new Set(r.findings.map((f) => `${f.rule.replace("opengrep:", "")}@${f.pageUrl}`));
    for (const want of ["glv.js.sql-injection@server.js", "glv.js.command-injection@server.js", "glv.js.dom-xss@web/app.js", "glv.py.unsafe-yaml@tools/load.py", "glv.php.unserialize@cart.php", "glv.php.sql-injection@cart.php"]) {
      assert.ok(found.has(want), `expected ${want}`);
    }
    assert.ok(!r.findings.some((f) => f.pageUrl === "utils.js"), "plain code is not flagged");
  });

  it("OSV-Scanner and Trivy find the old packages; Trivy also the unsafe Dockerfile, Kubernetes file and the AGPL package", { timeout: 600_000 }, async (t) => {
    const missing = [await osvTool.ready(), await trivyTool.ready()].filter(Boolean);
    if (missing.length) return t.skip(missing.join(" "));
    const out = path.join(dir, "pk");
    mkdirSync(out);
    const osv = await osvTool.run(ctx(out, { sourceDir: repo }));
    const osvPkgs = osv.findings.map((f) => f.key).sort();
    assert.deepEqual(osvPkgs, ["pkg:go.mod:golang.org/x/text@0.3.0", "pkg:package-lock.json:lodash@4.17.15", "pkg:requirements.txt:django@3.2.0", "pkg:requirements.txt:pyyaml@5.3"]);
    const trivy = await trivyTool.run(ctx(out, { sourceDir: repo, options: { licences: "on" } }));
    assert.deepEqual(trivy.findings.filter((f) => f.key).map((f) => f.key).sort(), osvPkgs, "the same packages, so they fold into one finding each");
    const rules = new Set(trivy.findings.map((f) => f.rule));
    for (const r of ["trivy:DS-0001", "trivy:DS-0002", "trivy:KSV-0017", "trivy:licence"]) assert.ok(rules.has(r), `expected ${r}`);
  });
});

describe("the API tools on a real API", () => {
  let api: DemoApi;
  let dir: string;
  before(async () => {
    api = await startDemoApi(4262);
    dir = await mkdtemp(path.join(tmpdir(), "glv-api-tools-"));
  });
  after(async () => {
    api.server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const login = { kind: "api" as const, authType: "bearer" as const, token: DEMO_TOKEN };
  const apiCtx = (extra: Partial<ToolContext> = {}) =>
    ctx(dir, { product: "api", target: { specUrl: "http://localhost:4262/openapi.json", url: api.base }, startUrl: "http://localhost:4262/", login, ...extra });

  it("Schemathesis finds the planted bugs with GET requests only, and sends the saved login", { timeout: 300_000 }, async (t) => {
    if (await schemathesisTool.ready()) return t.skip("Schemathesis is not installed");
    const before = { writes: api.writes(), tokens: api.withToken() };
    const r = await schemathesisTool.run(apiCtx({ options: { examples: "10", mode: "all" } }));
    assert.equal(api.writes(), before.writes, "no POST, PUT, PATCH or DELETE was sent, even with wrong inputs");
    assert.ok(api.withToken() > before.tokens, "the saved bearer token was used");
    const titles = r.findings.map((f) => f.title);
    for (const want of ["Server error (HTTP 500): GET /orders", "Answer does not match the API file: GET /products", "Answer is not valid JSON: GET /broken", "Content type not in the API file: GET /reports", "Endpoint works without a valid login: GET /users"]) {
      assert.ok(titles.includes(want), `expected "${want}" in ${JSON.stringify(titles)}`);
    }
    assert.ok(!JSON.stringify(r).includes(DEMO_TOKEN), "the token is not in the findings");
    assert.ok(!(await readFile(path.join(dir, "tool-schemathesis.xml"), "utf8")).includes(DEMO_TOKEN), "or in the JUnit report");
  });

  it("Newman runs the GET requests of the team's collection, with the saved login, and never the writes", { timeout: 120_000 }, async (t) => {
    if (await newmanTool.ready()) return t.skip("Newman is not installed");
    const file = "0a1b2c3d-1111-2222-3333-444455556666.json";
    await writeFile(path.join(dir, file), JSON.stringify(demoCollection()));
    const before = { writes: api.writes(), tokens: api.withToken() };
    const r = await newmanTool.run(apiCtx({ options: { collection: file } }));
    assert.equal(api.writes(), before.writes, "the POST and DELETE requests and the script's own POST were not sent");
    assert.ok(api.withToken() > before.tokens, "requests that inherit auth used the saved token");
    assert.deepEqual(r.findings.map((f) => f.title).sort(), ["Postman test failed: Orders load: status is 200", "Postman test failed: Product prices are numbers: price is a number"]);
    assert.match(r.summary!.join(" "), /Left out 2 requests that change data.*Left out 1 script that sends requests of its own/);
  });
});

describe("the new tools through the dashboard API", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-tools-api2-"));
    ({ app, stores } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("takes a Postman collection upload for Newman and saves it with the project", async () => {
    const up = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "content-type": "application/octet-stream", "x-file-name": "Shop API.postman_collection.json" },
      payload: JSON.stringify(demoCollection()),
    });
    assert.equal(up.statusCode, 201);
    const { file, fileName } = up.json();
    const refused = await app.inject({ method: "POST", url: "/api/projects", payload: { type: "api", specUrl: "http://localhost:4298/openapi.json", tools: ["newman"] } });
    assert.equal(refused.statusCode, 400);
    assert.match(refused.json().error, /upload the Postman collection first/);
    const made = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { type: "api", specUrl: "http://localhost:4298/openapi.json", tools: [{ id: "newman", options: { collection: file, "collection:name": fileName } }] },
    });
    assert.equal(made.statusCode, 201);
    assert.deepEqual(made.json().project.tools, [{ id: "newman", options: { collection: file, "collection:name": fileName } }]);
  });

  it("downloads a finished test as SARIF and JUnit XML", async () => {
    stores.runs.save({
      id: "run-export",
      url: "x",
      status: "done",
      createdAt: "2026-11-17T00:00:00Z",
      progress: [],
      result: result([own("code:sql-injection", "src/db.js", "line 3: q")], ["src/db.js"], { security: 50, functional: 100 }),
    });
    const sarif = await app.inject({ method: "GET", url: "/api/runs/run-export/report.sarif" });
    assert.equal(sarif.statusCode, 200);
    assert.match(String(sarif.headers["content-type"]), /application\/sarif\+json/);
    assert.match(String(sarif.headers["content-disposition"]), /attachment; filename="glv-report-run-expo\.sarif"/);
    assert.equal(sarif.json().runs[0].results[0].ruleId, "code:sql-injection");
    const junit = await app.inject({ method: "GET", url: "/api/runs/run-export/report.junit.xml" });
    assert.equal(junit.statusCode, 200);
    assert.match(junit.body, /<failure type="high"/);
    assert.equal((await app.inject({ method: "GET", url: "/api/runs/nope/report.sarif" })).statusCode, 404);
    const xml = await app.inject({ method: "GET", url: "/api/runs/run-export/artifacts/tool-newman.xml" });
    assert.notEqual(xml.statusCode, 400, "tool JUnit files are served");
  });
});
