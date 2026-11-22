import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { cloakingSigns, scriptSigns } from "../src/agents/web/hacked.ts";
import { llmsTxtProblems, robotsBlocks, securityTxtProblems } from "../src/agents/web/geo.ts";
import { mailDnsFindings, readDmarc, readSpf } from "../src/agents/web/email-dns.ts";
import type { DnsLookup } from "../src/agents/web/domain.ts";
import { isPrivateHost, registrableDomain } from "../src/agents/web/domain.ts";
import { timerSeconds } from "../src/agents/web/dark-patterns.ts";
import { missingDpdpItems, missingGigw, offersIndianLanguage } from "../src/agents/web/india.ts";
import { officeProblems, pdfProblems } from "../src/agents/web/documents.ts";
import { subdomainProblems } from "../src/tools/surface.ts";
import { readClam, readYara } from "../src/tools/malware.ts";
import { judge, PROBES } from "../src/tools/ai-redteam/probes.ts";
import { fillBody, readGarak, replyText } from "../src/tools/ai-redteam/index.ts";
import { leaksIn } from "../src/tools/mobile-security.ts";
import { readGoIos, readStfDevices } from "../src/mobile/farm.ts";
import { bestCandidate, similarity, wordsOf } from "../src/runner/heal.ts";
import { phraseToSteps, rulesDraft } from "../src/runner/plain.ts";
import { parseSteps } from "../src/runner/journeys.ts";
import { compareShapes, readHar, shapeOf, toMocks } from "../src/tools/replay.ts";
import { mutantsFor, spread } from "../src/tools/mutation.ts";
import { mutationTool } from "../src/tools/mutation.ts";
import { readInteractshLine, newOobToken, oobHits, recordOobHit } from "../src/oob.ts";
import { serverFindings } from "../src/connections/ssh.ts";
import { is17802Clause } from "../src/wcag.ts";
import { fixFor } from "../src/fixes.ts";
import { HANDBOOK } from "../src/handbook.ts";
import { TOOLS, defaultChoices } from "../src/tools/index.ts";

describe("wave 1: hacked sites", () => {
  it("spots obfuscated scripts, and leaves normal code alone", () => {
    assert.ok(scriptSigns("eval(atob('ZG9jdW1lbnQ='))").length > 0);
    assert.deepEqual(scriptSigns("const x = JSON.parse(data); window.location.href = '/home';"), []);
  });
  it("spots cloaking: spam words only Google sees", () => {
    const people = "<title>Acme</title><p>We build websites in Pune.</p>";
    const google = "<title>Acme</title><p>We build websites in Pune. Best online casino slot gacor viagra.</p>";
    assert.ok(cloakingSigns(people, google).length > 0);
    assert.deepEqual(cloakingSigns(people, people), []);
  });
  it("reads YARA and ClamAV output", () => {
    const y = readYara("glv_php_webshell [title=\"PHP web shell\",severity=\"critical\"] /tmp/x/shell.php\n");
    assert.equal(y[0]?.rule, "glv_php_webshell");
    assert.equal(y[0]?.severity, "critical");
    assert.deepEqual(readClam("/tmp/a.js: Js.Trojan.Agent-123 FOUND\n/tmp/b.js: OK\n"), [{ file: "/tmp/a.js", signature: "Js.Trojan.Agent-123" }]);
  });
  it("finds a web shell in the server check's output", () => {
    const out = "##os\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n##webshells\n/var/www/html/wp-content/uploads/x.php\n##end\n";
    assert.ok(serverFindings(out, "ssh://server").findings.some((f) => f.rule === "server:webshell"));
  });
});

describe("wave 1: security.txt and GEO", () => {
  it("reads security.txt problems", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    const rules = (t: string) => securityTxtProblems(t, "https:", "text/plain", now).map((p) => p[0]);
    assert.ok(rules("Policy: https://x").includes("sec:security-txt-no-contact"));
    assert.ok(rules("Contact: mailto:a@b.com\nExpires: 2025-01-01T00:00:00Z").includes("sec:security-txt-expired"));
    assert.ok(!rules("Contact: mailto:a@b.com\nExpires: 2027-06-01T00:00:00Z\nPolicy: https://x/p").some((r) => /no-contact|expired|no-expires/.test(r)));
  });
  it("tells which AI bots robots.txt blocks", () => {
    const robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /";
    assert.equal(robotsBlocks(robots, "GPTBot"), true);
    assert.equal(robotsBlocks(robots, "PerplexityBot"), false);
  });
  it("checks llms.txt's shape", () => {
    assert.deepEqual(llmsTxtProblems("# Acme\n\n> We build sites.\n\n## Pages\n- [Home](https://acme.in/)"), []);
    assert.ok(llmsTxtProblems("just some text").length > 0);
  });
});

describe("wave 1: DNS and email", () => {
  it("reads SPF and DMARC", () => {
    assert.equal(readSpf(["v=spf1 include:_spf.google.com +all"]).all, "+all");
    assert.equal(readDmarc(["v=DMARC1; p=none; rua=mailto:d@x.in"]).policy, "none");
  });
  it("raises the mail findings for a domain with no protection", async () => {
    const none = async () => [];
    const lookup: DnsLookup = { txt: none, mx: async () => [{ exchange: "mx.acme.in", priority: 10 }], caa: none, cname: none, a: none, ns: none, ds: async () => 0 };
    const { findings } = await mailDnsFindings("acme.in", lookup, async () => null);
    const rules = findings.map((f) => f.rule);
    for (const r of ["dns:no-spf", "dns:no-dmarc", "dns:no-dnssec", "dns:no-caa"]) assert.ok(rules.includes(r), r);
    for (const f of findings) assert.notEqual(fixFor({ rule: f.rule, detail: f.detail }).steps, f.detail, `${f.rule} has a written fix`);
  });
  it("knows registrable domains and private hosts", () => {
    assert.equal(registrableDomain("www.shop.acme.co.in"), "acme.co.in");
    assert.equal(isPrivateHost("localhost"), true);
    assert.equal(isPrivateHost("192.168.1.4"), true);
    assert.equal(isPrivateHost("acme.in"), false);
  });
});

describe("wave 1: attack surface", () => {
  it("spots a subdomain takeover and a dangling record", () => {
    const gh = subdomainProblems({ name: "docs.acme.in", cname: ["acme.github.io"], addresses: [], status: 404, body: "There isn't a GitHub Pages site here." });
    assert.equal(gh[0]?.rule, "surface:subdomain-takeover");
    const fine = subdomainProblems({ name: "www.acme.in", cname: [], addresses: ["93.184.216.34"], status: 200, title: "Acme", body: "<h1>Acme</h1>" });
    assert.ok(!fine.some((p) => p.rule === "surface:subdomain-takeover"));
  });
});

describe("wave 1: AI red team", () => {
  const probe = (id: string) => PROBES.find((p) => p.id === id)!;
  it("judges canary probes, and does not count refusals", () => {
    assert.equal(judge(probe("inj-ignore"), "ZEBRA-42", "ZEBRA-42").hit, true);
    assert.equal(judge(probe("inj-ignore"), "I'm sorry, I can't do that.", "ZEBRA-42").hit, false);
  });
  it("every probe maps to OWASP and has a written fix", () => {
    for (const p of PROBES) {
      assert.ok(p.owasp.length > 0, p.id);
      assert.notEqual(fixFor({ rule: `ai:${p.id}`, detail: "x" }).steps, "x", p.id);
    }
  });
  it("fills the request body and reads replies", () => {
    assert.deepEqual(JSON.parse(fillBody('{"message":"{{prompt}}","session":"{{session}}"}', 'say "hi"', "s1")), { message: 'say "hi"', session: "s1" });
    assert.equal(replyText({ choices: [{ message: { content: "hello" } }] }), "hello");
    assert.equal(replyText({ data: { answer: "ok" } }, "data.answer"), "ok");
  });
  it("reads garak's report", () => {
    const rows = readGarak(`{"entry_type":"eval","probe":"promptinject.HijackHateHumans","detector":"promptinject.AttackRogueString","passed":3,"total":10}\n`);
    assert.equal(rows[0]?.probe, "promptinject.HijackHateHumans");
    assert.equal(rows[0]?.total, 10);
  });
});

describe("wave 1: out-of-band callbacks", () => {
  it("records hits only for tokens it made", () => {
    const t = newOobToken();
    assert.equal(recordOobHit(t, "ssrf-url", "203.0.113.9", "GET /oob"), true);
    assert.equal(oobHits(t).length, 1);
    assert.equal(recordOobHit("nope", "x", "1.1.1.1", "GET"), false);
  });
  it("reads an Interactsh line", () => {
    const hit = readInteractshLine('{"protocol":"dns","unique-id":"abc123","full-id":"abc123.oob.example.com","remote-address":"203.0.113.9","raw-request":"x"}', "oob.example.com");
    assert.equal(hit?.protocol, "dns");
  });
});

describe("wave 1: documents", () => {
  it("flags an untagged PDF with no language or title", () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF");
    const rules = pdfProblems(pdf).map((p) => p.rule);
    assert.ok(rules.includes("doc:pdf-untagged"));
    assert.ok(rules.includes("doc:pdf-no-language"));
  });
  it("flags a Word file with no title or headings", () => {
    const docx = zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(`<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>${"Plain paragraph text. ".repeat(300)}</w:t></w:r></w:p></w:body></w:document>`),
      "docProps/core.xml": strToU8("<cp:coreProperties></cp:coreProperties>"),
    });
    const rules = officeProblems(docx, "docx").map((p) => p.rule);
    assert.ok(rules.includes("doc:office-no-title"));
    assert.ok(rules.includes("doc:docx-no-headings"));
  });
});

describe("wave 1: India and dark patterns", () => {
  it("lists missing DPDP notice items", () => {
    const missing = missingDpdpItems("We collect your name for orders. Contact us.").map((i) => i.id);
    assert.ok(missing.includes("board"));
    assert.ok(missing.includes("withdraw"));
    const full = "Purpose: we use your data to process orders. You may withdraw consent at any time. Your rights: access, correction and erasure. Grievance officer: grievance@acme.in. You may complain to the Data Protection Board of India. You may nominate a person. We keep data for 3 years (retention). Children: we need verifiable consent of a parent. In case of a personal data breach we will inform you.";
    assert.deepEqual(missingDpdpItems(full).map((i) => i.id), []);
  });
  it("sees an Indian-language version", () => {
    assert.equal(offersIndianLanguage('<a href="/hi/" hreflang="hi">हिन्दी</a>'), true);
    assert.equal(offersIndianLanguage("<a href='/about'>About</a>"), false);
  });
  it("lists missing GIGW footer items", () => {
    assert.ok(missingGigw("<footer><a href='/privacy'>Privacy policy</a></footer>", "https://x.gov.in/").some((i) => i.id === "accessibility"));
  });
  it("reads countdown timers", () => {
    assert.equal(timerSeconds("09:59"), 599);
    assert.equal(timerSeconds("1h 02m 03s"), 3723);
    assert.equal(timerSeconds("Sale"), null);
  });
  it("maps WCAG to IS 17802", () => {
    assert.equal(is17802Clause("1.1.1"), "9.1.1.1");
    assert.equal(is17802Clause("2.5.8"), null);
  });
});

describe("wave 1: phones", () => {
  it("reads STF and go-ios device lists", () => {
    const stf = readStfDevices({ devices: [{ serial: "A1", present: true, ready: true, owner: null, manufacturer: "Xiaomi", model: "M2101", version: "13", battery: { level: 80 } }, { serial: "B2", present: true, ready: true, owner: { name: "Ravi" } }, { serial: "C3", present: false }] });
    assert.equal(stf.length, 2);
    assert.equal(stf[0].available, true);
    assert.equal(stf[1].usedBy, "Ravi");
    const ios = readGoIos('{"deviceList":[{"Udid":"0000-1","ProductName":"iPhone OS","ProductVersion":"18.1","DeviceName":"Test iPhone"}]}');
    assert.equal(ios[0].name, "Test iPhone");
    assert.equal(ios[0].version, "18.1");
  });
  it("spots secrets in phone logs", () => {
    assert.ok(leaksIn("D/OkHttp: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk").length > 0);
    assert.deepEqual(leaksIn("I/ActivityManager: Start proc 1234"), []);
  });
});

describe("wave 1: journeys (plain English, self-healing)", () => {
  it("turns plain English into valid steps", () => {
    const d = rulesDraft("Log in, add a red shirt to the cart, then check the total is shown");
    assert.match(d.steps, /fill Email = \{\{username\}\}/);
    assert.match(d.steps, /click Red shirt/i);
    assert.doesNotThrow(() => parseSteps(d.steps));
    assert.deepEqual(phraseToSteps("go to /pricing"), ["open /pricing"]);
    assert.equal(phraseToSteps("dance a jig"), null);
  });
  it("heals only near-certain matches", () => {
    assert.deepEqual(wordsOf("#add-to-cart-btn"), ["add", "to", "cart"]);
    assert.ok(similarity(["add", "to", "cart"], ["add", "to", "basket"]) < 0.7);
    const pick = bestCandidate("Add to cart", [
      { i: 0, names: ["Remove"] },
      { i: 1, names: ["Add to Cart now", "addToCartButton"] },
    ]);
    assert.equal(pick?.i, 1);
    assert.equal(bestCandidate("Checkout", [{ i: 0, names: ["Sign up"] }]), null);
    // Two equally good matches are a guess.
    assert.equal(bestCandidate("Save", [{ i: 0, names: ["Save"] }, { i: 1, names: ["Save"] }]), null);
  });
});

describe("wave 1: record and replay", () => {
  const har = JSON.stringify({
    log: {
      entries: [
        { request: { method: "GET", url: "https://api.acme.in/users/1", headers: [{ name: "Accept", value: "application/json" }, { name: "Cookie", value: "secret" }] }, response: { status: 200, content: { mimeType: "application/json", text: '{"id":1,"name":"A","tags":["x"]}' } }, time: 120 },
        { request: { method: "POST", url: "https://api.acme.in/users" }, response: { status: 201 } },
        { request: { method: "GET", url: "https://cdn.other.com/a.js" }, response: { status: 200 } },
        { request: { method: "GET", url: "https://api.acme.in/logo.png" }, response: { status: 200, content: { mimeType: "image/png" } } },
      ],
    },
  });
  it("keeps only GETs to the API's own host, without cookies", () => {
    const { calls, skipped } = readHar(har, "api.acme.in");
    assert.equal(calls.length, 1);
    assert.deepEqual(skipped, { writes: 1, other: 1, files: 1 });
    assert.equal(calls[0].headers.cookie, undefined);
  });
  it("spots removed and retyped fields", () => {
    const d = compareShapes(shapeOf({ id: 1, name: "A", tags: ["x"], x: null }), shapeOf({ id: "1", tags: ["x"], x: 3 }));
    assert.deepEqual(d.removed, ["$.name"]);
    assert.deepEqual(d.changed, ["$.id: number → string"]);
  });
  it("makes WireMock mocks", () => {
    const m = toMocks(readHar(har, "api.acme.in").calls).mappings[0] as { request: { urlPath: string } };
    assert.equal(m.request.urlPath, "/users/1");
  });
});

describe("wave 1: mutation testing", () => {
  it("makes one mutant a line, never inside strings", () => {
    const ms = mutantsFor("a.js", 'if (a > b) {\n  log("a > b");\n}\nconst ok = x === 1;\n', "js");
    assert.deepEqual(ms.map((m) => m.line), [1, 4]);
    assert.equal(ms[0].after, "if (a >= b) {");
    assert.equal(spread([1, 2, 3, 4, 5, 6], 3).length, 3);
  });
  it("finds the surviving change in a small project with a weak test", { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-mut-"));
    const src = path.join(dir, "src");
    await mkdir(src);
    await mkdir(path.join(dir, "test"));
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "m", type: "module", scripts: { test: "node --test" } }));
    await mkdir(path.join(dir, "node_modules"));
    await writeFile(path.join(src, "price.js"), "export function total(a, b) {\n  return a + b;\n}\nexport function isAdult(age) {\n  return age >= 18;\n}\n");
    // Tests total properly, but isAdult only with an obvious age, so >= → > survives.
    await writeFile(path.join(dir, "test", "price.test.js"), 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { total, isAdult } from "../src/price.js";\ntest("total", () => assert.equal(total(2, 3), 5));\ntest("adult", () => assert.equal(isAdult(30), true));\n');
    const work = await mkdtemp(path.join(tmpdir(), "glv-mut-w-"));
    const out = await mutationTool.run({ product: "code", target: { url: "code" } as never, startUrl: "", urls: [], sourceDir: dir, uploadsDir: work, options: { mutants: "20", minutes: "15" }, outDir: work, workDir: work, signal: new AbortController().signal, log: () => undefined });
    const survived = out.findings.filter((f) => f.rule === "mutation:survived");
    assert.ok(survived.some((f) => /price\.js line 5/.test(f.title)), JSON.stringify(out.summary));
    assert.ok(!survived.some((f) => /line 2/.test(f.title)), "total's + → - is caught");
  });
});

describe("wave 1: wiring", () => {
  it("registers the new tools, with mutation testing off by default", async () => {
    const ids = TOOLS.map((t) => t.id);
    for (const id of ["malware", "surface", "ports", "verapdf", "browser-matrix", "ai-redteam", "mobsf", "mobile-runtime", "replay", "mutation"]) assert.ok(ids.includes(id), id);
    assert.ok(!(await defaultChoices("code")).some((c) => c.id === "mutation"));
  });
  it("attack tools keep the permission gate", () => {
    for (const id of ["ai-redteam", "ports"]) {
      const t = TOOLS.find((x) => x.id === id)!;
      assert.equal(t.safety, "permission", id);
      assert.equal(t.permission, "attack", id);
    }
  });
  it("the handbook has the new testing types", () => {
    const names = HANDBOOK.map((h) => h.name);
    for (const n of ["Chatbot red-teaming", "Hacked site and malware testing", "Subdomain takeover testing", "Dark patterns (CCPA 2023)", "DPDP Rules 2025 (India)", "Record-and-replay API testing"]) assert.ok(names.includes(n), n);
    assert.deepEqual(HANDBOOK.find((h) => h.name === "Mutation testing")?.tools, ["mutation"]);
  });
  it("every pattern rule has a written fix", () => {
    for (const rule of ["gigw:no-accessibility", "dpdp:notice-no-board", "yara:glv_php_webshell", "garak:dan.Dan_11_0", "mobsf:android debuggable", "dark:fake-timer", "replay:breaking-change", "mutation:survived", "journey:healed"])
      assert.notEqual(fixFor({ rule, detail: "x" }).steps, "x", rule);
  });
});
