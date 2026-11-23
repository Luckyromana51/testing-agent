import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLicence, cycloneDx, readNpmLock, readComposerLock } from "../src/tools/sbom.ts";
import { parseFields, pairwise } from "../src/tools/pairwise.ts";
import { operations, breakingChanges, lintProblems } from "../src/tools/openapi-diff.ts";
import { expressPath, mockServer } from "../src/tools/api-mock.ts";
import { gatewayOf, TEST_VALUES } from "../src/tools/payments.ts";
import { readLcov, readCobertura, countTests } from "../src/tools/unit-tests.ts";
import { emailProblems, spamScore } from "../src/tools/email-render.ts";
import { playwrightSpec, appiumSpec } from "../src/tools/export-code.ts";
import { WCAG_CRITERIA, vpatDocument } from "../src/tools/vpat.ts";
import { regionProxies, spreadProblem, parseCurlTiming } from "../src/tools/region-speed.ts";
import { parseFields as _pf } from "../src/tools/pairwise.ts";
import { extractNap, parseHreflang, hreflangProblems, socialProblems } from "../src/agents/web/seo-more.ts";
import { textWords, linkCount, renderGap } from "../src/agents/web/js-render.ts";
import { colourOnlyLink, readingGrade, aaaProblems } from "../src/agents/web/a11y-more.ts";
import { layoutBreaks } from "../src/agents/web/visual-layout.ts";
import { profileProblems } from "../src/agents/web/frontend-profile.ts";
import { endpointOf, callStats } from "../src/agents/web/slow-calls.ts";
import { isPaymentPage, scriptInventory } from "../src/agents/web/compliance.ts";
import { otaProblems } from "../src/agents/mobile/ota.ts";
import { parseAmStart, parseJank, parseMeminfo } from "../src/tools/app-perf.ts";
import { focusedPackage, linkResult } from "../src/tools/deeplink-run.ts";
import { parseMaestroOutput } from "../src/tools/maestro.ts";
import { parseUiDump, unlabelledControls } from "../src/tools/talkback.ts";
import { popupLoginRisk, blocksInApp } from "../src/tools/inapp-browser.ts";
import { fixFor } from "../src/fixes.ts";
import { P2_FIXES, p2PatternFix } from "../src/fixes-p2.ts";

describe("wave 2: SBOM and licences", () => {
  it("classifies copyleft", () => {
    assert.equal(classifyLicence("GPL-3.0")?.strong, true);
    assert.equal(classifyLicence("AGPL-3.0-only")?.strong, true);
    assert.equal(classifyLicence("LGPL-2.1")?.strong, false);
    assert.equal(classifyLicence("MIT"), null);
  });
  it("reads npm and composer lockfiles and writes CycloneDX", () => {
    const deps = readNpmLock(JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version: "1.3.0", license: "MIT" } } }));
    assert.deepEqual(deps, [{ name: "left-pad", version: "1.3.0", licence: "MIT", ecosystem: "npm" }]);
    const php = readComposerLock(JSON.stringify({ packages: [{ name: "monolog/monolog", version: "2.0", license: ["MIT"] }] }));
    assert.equal(php[0].name, "monolog/monolog");
    const bom = JSON.parse(cycloneDx(deps));
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.equal(bom.components[0].purl, "pkg:npm/left-pad@1.3.0");
  });
});

describe("wave 2: pairwise", () => {
  it("parses fields and covers every pair with far fewer cases", () => {
    const fields = parseFields("country: India, US, UK\npayment: card, upi, cod\nplan: free, pro, team");
    assert.equal(fields.length, 3);
    const cases = pairwise(fields);
    const full = 27;
    assert.ok(cases.length < full && cases.length >= 9, `got ${cases.length}`);
    // every pair appears
    for (let a = 0; a < 3; a++)
      for (let b = a + 1; b < 3; b++)
        for (const va of fields[a].values)
          for (const vb of fields[b].values) assert.ok(cases.some((c) => c[a] === va && c[b] === vb), `${va}+${vb}`);
  });
});

describe("wave 2: OpenAPI diff and lint", () => {
  const oldSpec = { paths: { "/users": { get: { responses: { "200": {} } }, post: { requestBody: { content: { "application/json": { schema: { required: ["name"] } } } }, responses: { "201": {} } } } } };
  const newSpec = { paths: { "/users": { post: { requestBody: { content: { "application/json": { schema: { required: ["name", "email"] } } } }, parameters: [{ name: "key", in: "query", required: true }], responses: { "201": {} } } } } };
  it("flattens operations", () => {
    assert.equal(operations(oldSpec).length, 2);
  });
  it("finds breaking changes", () => {
    const b = breakingChanges(oldSpec, newSpec).map((c) => c.rule);
    assert.ok(b.includes("apidiff:endpoint-removed"), "GET /users removed");
    assert.ok(b.includes("apidiff:new-required-field"), "email now required");
    assert.ok(b.includes("apidiff:new-required-param"), "key param required");
  });
  it("lints for missing pieces", () => {
    const l = lintProblems(newSpec).map((c) => c.rule);
    assert.ok(l.includes("apilint:no-operation-id"));
    assert.ok(l.includes("apilint:no-security"));
  });
});

describe("wave 2: API mock", () => {
  it("turns an OpenAPI path into an Express path and builds a server", () => {
    assert.equal(expressPath("/users/{id}/posts/{postId}"), "/users/:id/posts/:postId");
    const js = mockServer([{ method: "GET", path: "/users/{id}", status: 200, body: { id: 1 } }]);
    assert.match(js, /http\.createServer/);
    assert.match(js, /:id/);
  });
});

describe("wave 2: payments", () => {
  it("recognises test vs live keys", () => {
    assert.deepEqual(gatewayOf("sk_test_abc"), { gateway: "stripe", test: true });
    assert.deepEqual(gatewayOf("sk_live_abc"), { gateway: "stripe", test: false });
    assert.deepEqual(gatewayOf("rzp_test_x"), { gateway: "razorpay", test: true });
    assert.ok(TEST_VALUES.stripe.success.includes("4242"));
  });
});

describe("wave 2: client tests and coverage", () => {
  it("reads lcov and cobertura", () => {
    const cov = readLcov("SF:a.js\nDA:1,1\nDA:2,0\nend_of_record\n");
    assert.equal(cov.pct, 50);
    assert.equal(readCobertura('<coverage line-rate="0.8"></coverage>').pct, 80);
  });
  it("counts tests from runner output", () => {
    assert.deepEqual(countTests("Tests: 2 failed, 8 passed"), { failed: 2, passed: 8 });
    assert.deepEqual(countTests("5 passed in 1.2s"), { failed: 0, passed: 5 });
  });
});

describe("wave 2: email templates", () => {
  it("flags Outlook/consent problems and scores spam", () => {
    const rules = emailProblems("<div style='width:800px'><img src=x></div>").map((p) => p.rule);
    assert.ok(rules.includes("email:no-tables"));
    assert.ok(rules.includes("email:too-wide"));
    assert.ok(rules.includes("email:img-no-alt"));
    assert.ok(rules.includes("email:no-unsubscribe"));
    assert.ok(spamScore("FREE!!! WINNER", "<p>cash now</p>").score >= 3);
  });
});

describe("wave 2: export as code", () => {
  it("writes a Playwright spec and an Appium script", () => {
    const spec = playwrightSpec("https://x.com", ["https://x.com/", "https://x.com/about"]);
    assert.match(spec, /@playwright\/test/);
    assert.match(spec, /\/about/);
    const app = appiumSpec("com.x", "android", [{ id: "1", name: "login", steps: "tap login\ntype user" }]);
    assert.match(app, /describe\("com\.x"/);
  });
});

describe("wave 2: VPAT", () => {
  it("lists every WCAG criterion and renders a document", () => {
    assert.ok(WCAG_CRITERIA.length > 40);
    const doc = vpatDocument("App", "https://x.com", "2026-11-22", { "1.1.1": { status: "Supports", remarks: "ok" } });
    assert.match(doc, /VPAT 2\.5/);
    assert.match(doc, /1\.1\.1 Non-text Content \(Level A\) \| Supports/);
  });
});

describe("wave 2: region speed", () => {
  it("reads region proxies and curl timing and finds a spread", () => {
    assert.deepEqual(regionProxies({ REGION_MUMBAI_PROXY: "http://a:1", X: "y" }), [{ region: "mumbai", proxy: "http://a:1" }]);
    const r = parseCurlTiming("0.100 0.500 200", "mumbai");
    assert.deepEqual(r, { region: "mumbai", ttfbMs: 100, totalMs: 500, status: 200 });
    const spread = spreadProblem([{ region: "a", ttfbMs: 1, totalMs: 100, status: 200 }, { region: "b", ttfbMs: 1, totalMs: 400, status: 200 }]);
    assert.equal(spread?.ratio, 4);
  });
});

describe("wave 2: SEO (local, hreflang, social, JS render)", () => {
  it("extracts NAP, hreflang problems and social tags", () => {
    assert.ok(extractNap("<p>Call +91 98000 00000, 411001</p>").phones.length >= 1);
    const tags = parseHreflang('<link rel="alternate" hreflang="en-in" href="/in"><link rel="alternate" hreflang="e1" href="/zz">');
    assert.equal(tags.length, 2);
    const probs = hreflangProblems(tags);
    assert.ok(probs.some((p) => /Invalid/.test(p)));
    assert.ok(probs.some((p) => /x-default/.test(p)));
    assert.ok(socialProblems("<head></head>").some((p) => p.rule === "seo:no-og-title"));
  });
  it("detects content/links only in JS", () => {
    assert.ok(textWords("<p>one two three</p>") === 3);
    assert.equal(linkCount('<a href="/a">x</a><a href="#">y</a>'), 1);
    const gap = renderGap(10, 400, 1, 20);
    assert.ok(gap.contentOnlyInJs && gap.linksOnlyInJs);
  });
});

describe("wave 2: accessibility (colour, AAA, layout)", () => {
  it("colour-only links and reading level", () => {
    assert.equal(colourOnlyLink({ underline: false, bold: false, bordered: false, differentBg: false, inParagraph: true }), true);
    assert.equal(colourOnlyLink({ underline: true, bold: false, bordered: false, differentBg: false, inParagraph: true }), false);
    assert.ok(readingGrade("The cat sat on the mat. It was a good day.") < 6);
    assert.ok(aaaProblems({ grade: 16, metaRefresh: true, helpLinkPages: 1, totalPages: 4 }).length >= 2);
  });
  it("phone layout breaks", () => {
    const b = layoutBreaks(390, 520, [{ tag: "div", left: 400, right: 900, width: 500 }]);
    assert.ok(b.sideScroll > 0);
    assert.equal(b.offCanvas.length, 1);
  });
});

describe("wave 2: performance", () => {
  it("frontend profile and backend calls", () => {
    assert.ok(profileProblems({ longTasks: 5, longestTaskMs: 600, jsBytes: 4_000_000, scriptCount: 10, domNodes: 6000, cls: 0.3 }).length >= 4);
    assert.equal(endpointOf("https://api.x.com/users/42/posts"), "api.x.com/users/:id/posts");
    const stats = callStats([{ method: "GET", url: "https://a/x/1", status: 200, ms: 2000, bytes: 0, pageUrl: "p", type: "xhr", contentType: "", count: 1 } as any]);
    assert.equal(stats[0].maxMs, 2000);
  });
});

describe("wave 2: compliance", () => {
  it("payment page detection and script inventory", () => {
    assert.ok(isPaymentPage("https://x.com/checkout", ""));
    assert.ok(isPaymentPage("https://x.com/p", '<script src="https://js.stripe.com/v3"></script>'));
    const scripts = scriptInventory("https://x.com", '<script src="https://cdn.other.com/a.js"></script><script>var x=1</script>');
    assert.equal(scripts.filter((s) => s.thirdParty && !s.hasIntegrity).length, 1);
    assert.equal(scripts.filter((s) => s.src === "(inline)").length, 1);
  });
});

describe("wave 2: mobile", () => {
  it("OTA signing problems", () => {
    assert.ok(otaProblems({ codePush: true, codePushSigned: false, expoUpdates: false, expoSigned: false, httpEndpoint: false }).some((p) => p.rule === "mobile:codepush-unsigned"));
    assert.equal(otaProblems({ codePush: true, codePushSigned: true, expoUpdates: false, expoSigned: false, httpEndpoint: false }).length, 0);
  });
  it("adb output parsers", () => {
    assert.equal(parseAmStart("Status: ok\nTotalTime: 850\nWaitTime: 900").totalMs, 850);
    assert.equal(parseJank("Total frames rendered: 100\nJanky frames: 25 (25.00%)")?.pct, 25);
    assert.equal(parseMeminfo("TOTAL 123456 "), 123456);
    assert.equal(focusedPackage("mResumedActivity: ActivityRecord{x com.app/.Main t1}"), "com.app");
    assert.equal(linkResult("com.app", "com.app"), "app");
    assert.equal(linkResult("com.android.resolver.ResolverActivity", "com.app"), "chooser");
  });
  it("maestro and talkback parsers", () => {
    const flows = parseMaestroOutput("Flow: login\n✅ tapOn\nFlow: pay\n❌ assertVisible Checkout");
    assert.equal(flows.find((f) => f.flow === "pay")?.passed, false);
    const nodes = parseUiDump('<node class="android.widget.Button" clickable="true" text="" content-desc="" resource-id="a"/><node class="android.widget.Button" clickable="true" text="Buy" resource-id="b"/>');
    assert.equal(unlabelledControls(nodes).length, 1);
  });
  it("in-app browser risks", () => {
    assert.ok(popupLoginRisk('<a onclick="window.open(\'/oauth\')">Login with Google</a>'));
    assert.ok(blocksInApp("Please open this in your browser to continue"));
  });
});

describe("wave 2: fixes", () => {
  it("every P2 rule has a written fix", () => {
    for (const rule of Object.keys(P2_FIXES)) assert.notEqual(fixFor({ rule, detail: "UNWRITTEN" }).steps, "UNWRITTEN", rule);
  });
  it("pattern fixes cover cloud/netscan/sast families", () => {
    assert.ok(p2PatternFix("cloud:s3-public"));
    assert.ok(p2PatternFix("netscan:CVE-2024-1"));
    assert.ok(p2PatternFix("sast:php-sqli"));
    assert.notEqual(fixFor({ rule: "cloud:anything", detail: "UNWRITTEN" }).steps, "UNWRITTEN");
  });
});
