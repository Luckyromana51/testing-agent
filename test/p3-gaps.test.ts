import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyModelFile, readModelScan, iacKind, iacProblems, detectFuzzing, extensionRisks, electronRisks, tauriRisks } from "../src/tools/p3-code.ts";
import { printProblems, webrtcProblems, legalPages, pageFingerprint } from "../src/tools/p3-web.ts";
import { reconcile, parseRules, checkRows, readCsv, asyncApiProblems, traceProblems } from "../src/tools/p3-api.ts";
import { k8sFindings, logSeoFindings, drFindings, dbCodeFindings } from "../src/tools/p3-ops.ts";
import { costProblems, messageProblems, weakCrypto, pqcTlsProblem, controlMap, parseCdx, storeListingProblems, iapProblems } from "../src/tools/p3-misc.ts";
import { co2Grams, carbonProblem, imageVideoSeoProblems, extraA11y, phiInUrl } from "../src/agents/web/p3-agents.ts";
import { fixFor } from "../src/fixes.ts";
import { P3_FIXES, p3PatternFix } from "../src/fixes-p3.ts";

describe("wave 3: model file security", () => {
  it("flags pickle formats and clears safetensors", () => {
    assert.equal(classifyModelFile("weights.pt")?.risky, true);
    assert.equal(classifyModelFile("model.safetensors")?.risky, false);
    assert.equal(classifyModelFile("README.md"), null);
  });
  it("reads ModelScan JSON", () => {
    const r = readModelScan(JSON.stringify({ issues: [{ source: "a.pkl", severity: "HIGH", description: "os.system" }] }));
    assert.equal(r[0].severity, "high");
  });
});

describe("wave 3: IaC", () => {
  it("classifies files and flags issues", () => {
    assert.equal(iacKind("main.tf", ""), "terraform");
    assert.equal(iacKind("Dockerfile", "FROM node"), "dockerfile");
    const d = iacProblems({ path: "Dockerfile", kind: "dockerfile", text: "FROM node:latest\nRUN echo hi" });
    assert.ok(d.some((x) => x.rule === "iac:docker-root"));
    assert.ok(d.some((x) => x.rule === "iac:docker-latest"));
    const tf = iacProblems({ path: "main.tf", kind: "terraform", text: 'ingress { cidr_blocks = ["0.0.0.0/0"] from_port = 22 }' });
    assert.ok(tf.some((x) => x.rule === "iac:open-ingress"));
  });
});

describe("wave 3: code fuzzing / extension / desktop", () => {
  it("detects fuzzing frameworks", () => {
    assert.equal(detectFuzzing(JSON.stringify({ devDependencies: { "fast-check": "3.0" } }), null, null).has, true);
    assert.equal(detectFuzzing(JSON.stringify({ dependencies: {} }), null, null).has, false);
  });
  it("flags broad extension perms and unsafe desktop settings", () => {
    const e = extensionRisks({ manifest_version: 3, name: "x", permissions: ["<all_urls>", "cookies"] });
    assert.ok(e.some((x) => x.rule === "ext:broad-host"));
    assert.ok(electronRisks("webPreferences: { nodeIntegration: true }").some((x) => x.rule === "desktop:node-integration"));
    assert.ok(tauriRisks({ tauri: { allowlist: { all: true } } }).some((x) => x.rule === "desktop:tauri-allowlist-all"));
  });
});

describe("wave 3: web", () => {
  it("prints overflow and missing print css", () => {
    const p = printProblems({ hasPrintCss: false, printWidthPx: 794, contentWidthPx: 1200, pageCount: 1 });
    assert.ok(p.some((x) => x.rule === "print:overflow"));
    assert.ok(p.some((x) => x.rule === "print:no-print-css"));
  });
  it("judges media and finds legal pages", () => {
    assert.ok(webrtcProblems({ startMs: 6000, stalls: 1, webrtc: false, errors: 0 }).length >= 2);
    assert.deepEqual(legalPages(["https://x/privacy", "https://x/home"]), ["https://x/privacy"]);
    assert.equal(pageFingerprint("<p>Hello world</p>").words, 2);
  });
});

describe("wave 3: API / data", () => {
  it("reconciles within tolerance", () => {
    assert.equal(reconcile(100, 100.3, 0.5).match, true);
    assert.equal(reconcile(100, 120, 0.5).match, false);
  });
  it("parses rules and checks rows", () => {
    const rules = parseRules("email: not-null, unique\nage: min=0, max=120");
    const rows = [{ email: "a@b.com", age: "5" }, { email: "", age: "200" }, { email: "a@b.com", age: "5" }];
    const probs = checkRows(rows, rules);
    assert.ok(probs.some((p) => p.rule === "dq:null"));
    assert.ok(probs.some((p) => p.rule === "dq:duplicate"));
    assert.ok(probs.some((p) => p.rule === "dq:range"));
  });
  it("reads CSV, validates AsyncAPI, judges tracing", () => {
    assert.equal(readCsv("a,b\n1,2").length, 1);
    assert.ok(asyncApiProblems({}).some((p) => p.rule === "queue:not-asyncapi"));
    assert.ok(traceProblems("00-x", {}).some((p) => p.rule === "trace:no-propagation"));
    assert.equal(traceProblems("00-x", { traceparent: "00-y" }).length, 0);
  });
});

describe("wave 3: ops", () => {
  it("judges k8s, logs, backups and db code", () => {
    assert.ok(k8sFindings("##pods\ndefault web priv=true hostNet=false\n##end", "ssh://h").some((f) => f.rule === "k8s:privileged-pod"));
    assert.ok(logSeoFindings({ total: 1000, googlebot: 0, errors: 100 }, "ssh://h").some((f) => f.rule === "logseo:no-googlebot"));
    assert.ok(logSeoFindings({ total: 1000, googlebot: 5, errors: 100 }, "ssh://h").some((f) => f.rule === "logseo:high-404"));
    assert.ok(drFindings({ now: ["1000000000"], backups: [], cron: ["0"] }, "ssh://h").some((f) => f.rule === "dr:no-backups"));
    assert.ok(dbCodeFindings({ mysql: ["routine a b", "trigger c d"], pgtap: [] }, "ssh://h").some((f) => f.rule === "dbcode:untested"));
  });
});

describe("wave 3: misc", () => {
  it("AI cost, messaging, crypto", () => {
    assert.ok(costProblems({ latencyMs: [100], tokens: [5000], timeouts: 1 }).some((p) => p.rule === "aicost:timeout"));
    assert.ok(messageProblems("x".repeat(200), "sms").some((p) => p.rule === "msg:too-long"));
    assert.ok(messageProblems("Buy now!", "sms").some((p) => p.rule === "msg:no-optout"));
    assert.deepEqual(weakCrypto("const h = md5(x); DES"), ["MD5", "DES/3DES"]);
    assert.equal(pqcTlsProblem("Negotiated group: X25519"), true);
    assert.equal(pqcTlsProblem("Negotiated group: X25519MLKEM768"), false);
  });
  it("soc2 map, cdx, store, iap", () => {
    assert.ok(controlMap().length >= 5);
    assert.equal(parseCdx('{"url":"https://a.com/x"}\n{"url":"https://b.com/y"}').count, 2);
    assert.ok(storeListingProblems({ platform: "android", permissions: ["android.permission.CAMERA"], sdks: [], size: 10 }).some((p) => p.rule === "store:data-safety"));
    assert.ok(iapProblems({ platform: "android", libraries: [{ name: "com.android.billingclient:billing" }], servers: [] }).some((p) => p.rule === "iap:no-receipt-validation"));
    assert.equal(iapProblems({ platform: "android", libraries: [{ name: "okhttp" }], servers: [] }).length, 0);
  });
});

describe("wave 3: web agents", () => {
  it("carbon, image/video seo, extra a11y, phi", () => {
    assert.ok(co2Grams(3_000_000_000) > 1);
    assert.equal(carbonProblem(3_000_000).heavy, false);
    assert.ok(imageVideoSeoProblems({ hasVideo: true, hasVideoSchema: false, ogImage: null, ogImageWide: false, imagesNoDimensions: 5 }).some((p) => p.rule === "videoseo:no-schema"));
    assert.ok(extraA11y({ positiveTabindex: 2, duplicateIds: 1, marquee: 0, tinyFont: 0, justified: 0 }).some((p) => p.rule === "a11y2:positive-tabindex"));
    assert.deepEqual(phiInUrl("https://x/view?patient=5&ok=1"), ["patient"]);
    assert.deepEqual(phiInUrl("https://x/view?ok=1"), []);
  });
});

describe("wave 3: every rule has a written fix", () => {
  it("each P3 rule resolves through fixFor", () => {
    for (const rule of Object.keys(P3_FIXES)) {
      const fix = fixFor({ rule, detail: "" });
      assert.ok(fix && fix.steps, `no fix for ${rule}`);
    }
  });
  it("pattern fixes cover prefixes", () => {
    assert.ok(p3PatternFix("iac:something-new"));
    assert.ok(p3PatternFix("k8s:something-new"));
    assert.ok(p3PatternFix("ext:something-new"));
    assert.ok(p3PatternFix("desktop:something-new"));
    assert.equal(p3PatternFix("unrelated:x"), undefined);
  });
});
