import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { WEB_AGENTS } from "../src/agents/registry.js";
import { compareViews, type BrowserView } from "../src/agents/web/browsers.js";
import { advisoriesFor, versionBefore, versionsFromFiles } from "../src/agents/web/leaks.js";
import { badHreflang, mainScript } from "../src/agents/web/locale.js";
import { keepFirstSightings, sharedFinding } from "../src/agents/web/once.js";
import { manifestProblems } from "../src/agents/web/pwa.js";
import { clickDepths } from "../src/agents/web/seo-site.js";
import { fixFor } from "../src/fixes.js";
import { finding } from "../src/runner/finding.js";
import { scanSite } from "../src/runner/scan.js";
import { sameSite, siteOf } from "../src/runner/urls.js";
import { createApp } from "../src/server.js";
import type { Finding, PageResult, ScanResult } from "../src/types.js";
import { startAgentsSite } from "./fixtures/agents-site.js";

process.env.DEFAULT_TOOLS = "none";

/** The agents added with this set: keyboard, layout, network, other browsers, language... */
const NEW_AGENTS = WEB_AGENTS.map((a) => a.id).filter((id) =>
  /^(a11y|func|ui|perf|l10n)\.|^seo\.(link-graph|thin-content|urls)$|^sec\.(info-leak|js-libraries|sri|auth-forms)$/.test(id),
);

/** Each planted problem, and the page it is planted on. */
const PLANTED: [rule: string, page: string][] = [
  ["a11y:keyboard-trap", "/keyboard"],
  ["a11y:focus-not-visible", "/keyboard"],
  ["a11y:positive-tabindex", "/keyboard"],
  ["a11y:click-only", "/keyboard"],
  ["a11y:focus-obscured", "/obscured"],
  ["a11y:zoom-200", "/zoom"],
  ["a11y:reflow-400", "/zoom"],
  ["a11y:text-spacing", "/spacing"],
  ["a11y:heading-skip", "/reader"],
  ["a11y:no-main", "/reader"],
  ["a11y:vague-link", "/reader"],
  ["a11y:same-name-links", "/reader"],
  ["a11y:ignores-reduced-motion", "/motion"],
  ["a11y:autoplay-sound", "/motion"],
  ["form:email-accepts-anything", "/form"],
  ["form:negative-number", "/form"],
  ["form:boundary-refused", "/form"],
  ["form:phone-accepts-letters", "/form"],
  ["form:pattern-invalid", "/form"],
  ["form:required-not-marked", "/form"],
  ["monkey:js-error", "/monkey"],
  ["layout:sideways-at-size", "/"],
  ["link:missing-anchor", "/anchors"],
  ["search:finds-nothing", "/search"],
  ["ui:text-overlap", "/overlap"],
  ["ui:text-overlap-phone", "/overlap"],
  ["ui:text-cut-off", "/cut"],
  ["ui:sticky-cover", "/bars"],
  ["ui:intrusive-popup", "/popup"],
  ["ui:long-lines", "/read"],
  ["ui:justified-text", "/read"],
  ["ui:stretched-image", "/images"],
  ["perf:oversized-image", "/images"],
  ["perf:lcp-lazy", "/images"],
  ["perf:no-lazy-images", "/images"],
  ["perf:legacy-image-format", "/"],
  ["perf:no-compression", "/network"],
  ["perf:no-cache", "/network"],
  ["perf:redirected-file", "/network"],
  ["perf:duplicate-requests", "/network"],
  ["perf:many-requests", "/many"],
  ["perf:third-party-weight", "/third"],
  ["perf:slow-phone-network", "/"],
  ["seo:deep-page", "/"],
  ["seo:internal-redirect", "/"],
  ["seo:thin-content", "/thin"],
  ["seo:session-in-url", "/"],
  ["seo:url-uppercase", "/"],
  ["seo:url-underscore", "/"],
  ["seo:url-long", "/"],
  ["seo:hreflang-invalid", "/lang"],
  ["sec:html-comment", "/leaks"],
  ["sec:error-details", "/leaks"],
  ["sec:source-map", "/leaks"],
  ["sec:vulnerable-js", "/libs"],
  ["sec:no-sri", "/libs"],
  ["sec:password-in-url", "/login"],
  ["sec:password-other-site", "/login"],
  ["sec:password-manager-blocked", "/login"],
  ["l10n:wrong-lang", "/lang"],
  ["l10n:garbled-text", "/lang"],
  ["l10n:rtl-missing", "/arabic"],
  ["l10n:not-utf8", "/latin1"],
  ["l10n:mixed-currency", "/prices"],
  ["l10n:us-date", "/prices"],
  ["l10n:locale-error", "/"],
  ["l10n:locale-broken-text", "/"],
  ["app:no-favicon", "/"],
  ["app:manifest-incomplete", "/"],
  ["app:offline-broken", "/"],
];

const pathOf = (u: string) => new URL(u).pathname;

describe("website agents on a site with planted problems", () => {
  let site: { server: Server; url: string };
  let cleanSite: { server: Server; url: string };
  let dir: string;
  let planted: ScanResult;
  let alone: ScanResult;
  let clean: ScanResult;

  before(async () => {
    site = await startAgentsSite("planted");
    cleanSite = await startAgentsSite("clean");
    dir = await mkdtemp(path.join(tmpdir(), "glvagents-"));
    planted = await scanSite({ url: site.url, maxPages: 60, product: "webapp", agents: NEW_AGENTS, artifactsDir: path.join(dir, "p"), parallel: 4, checkLinks: false });
    clean = await scanSite({ url: cleanSite.url, maxPages: 60, product: "webapp", agents: NEW_AGENTS, artifactsDir: path.join(dir, "c"), parallel: 4, checkLinks: false });
    // The agents whose findings are shared between pages, one page at a time.
    alone = await scanSite({
      url: site.url,
      maxPages: 60,
      product: "webapp",
      agents: ["perf.images", "perf.network", "sec.info-leak", "sec.js-libraries", "sec.sri", "ui.readability"],
      artifactsDir: path.join(dir, "1"),
      parallel: 1,
      checkLinks: false,
    });
  });
  after(async () => {
    site.server.close();
    cleanSite.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds each planted problem on the page it is planted on", () => {
    const found = new Set(planted.findings.map((f) => `${f.rule} ${pathOf(f.pageUrl)}`));
    const missing = PLANTED.filter(([rule, page]) => !found.has(`${rule} ${page}`)).map(([r, p]) => `${r} on ${p}`);
    assert.deepEqual(missing, [], `not found:\n${missing.join("\n")}`);
    assert.ok(planted.findings.some((f) => f.rule === "ux:dead-end-404" && /\/glv-missing-/.test(f.pageUrl)), "the blank missing-page screen");
    assert.equal(planted.findings.filter((f) => f.rule === "check-error").length, 0, "no agent stopped with an error");
  });

  it("gives no false alarms on a site that does everything right", () => {
    const alarms = clean.findings.map((f) => `${f.rule} on ${pathOf(f.pageUrl)}: ${f.title}`);
    assert.deepEqual(alarms, []);
    assert.ok(clean.pages.length >= 8, "the clean site was crawled");
    for (const s of clean.agentStats ?? []) {
      if (!NEW_AGENTS.includes(s.id) || s.id === "func.browsers") continue;
      assert.ok(!s.untested && !s.skipped && (s.runs ?? 0) > 0 && !s.errors, `${s.id} ran: ${JSON.stringify(s)}`);
    }
  });

  it("names the right severity and gives evidence for what it found", () => {
    const one = (rule: string) => planted.findings.find((f) => f.rule === rule)!;
    assert.equal(one("a11y:keyboard-trap").severity, "high");
    assert.equal(one("sec:password-in-url").severity, "high");
    assert.equal(one("sec:html-comment").severity, "high");
    assert.match(one("sec:vulnerable-js").title, /jQuery 1\.12\.4/);
    assert.match(one("sec:vulnerable-js").evidence!, /CVE-2020-11022/);
    assert.match(one("sec:no-sri").evidence!, /cdnjs\.cloudflare\.com/);
    assert.match(one("sec:source-map").evidence!, /app\.js\.map/);
    assert.match(one("perf:redirected-file").evidence!, /old\.js → .*new\.js/);
    assert.match(one("a11y:ignores-reduced-motion").evidence!, /animation slide/);
    assert.match(one("monkey:js-error").evidence!, /click button/);
    assert.match(one("seo:deep-page").evidence!, /deep\/4: 4 clicks/);
    assert.match(one("seo:internal-redirect").evidence!, /old-page → .*new-page/);
    for (const f of planted.findings) assert.notEqual(fixFor(f).steps, f.detail, `${f.rule} has a written fix`);
  });

  it("reports a file that several pages load once, on the first page that loads it", () => {
    const shared = planted.findings.filter((f) => f.rule === "perf:legacy-image-format" && /shared\.png/.test(f.evidence ?? ""));
    assert.equal(shared.length, 1);
    assert.equal(pathOf(shared[0].pageUrl), "/");
    // The agent's own count matches what the report shows.
    const images = planted.agentStats!.find((s) => s.id === "perf.images")!;
    assert.equal(images.findings, planted.findings.filter((f) => f.agent === "perf.images").length);
  });

  it("puts shared findings on the same pages one page at a time as several at once", () => {
    const rules = new Set(alone.findings.map((f) => f.rule));
    const key = (f: Finding) => `${f.rule} ${pathOf(f.pageUrl)} ${f.evidence ?? ""}`.replace(/:\d{4,5}\//g, "/");
    const many = planted.findings.filter((f) => rules.has(f.rule)).map(key).sort();
    assert.deepEqual(alone.findings.map(key).sort(), many);
  });

  it("saves the screen reader view, the network log and the device pictures with the report", async () => {
    const first = planted.pages[0];
    const files = new Map((first.files ?? []).map((f) => [f.label, f.file]));
    assert.equal(files.get("Screen reader view"), "page-0-screen-reader.txt");
    assert.equal(files.get("Network log (JSON)"), "page-0-network.json");
    assert.ok(files.get("iPad, sideways 1024×768"), "device pictures are on the first page");
    const log = JSON.parse(await readFile(path.join(dir, "p", "page-0-network.json"), "utf8")) as { responses: { url: string; bytes: number }[] };
    assert.ok(log.responses.some((r) => r.url.endsWith("/hero.png") && r.bytes > 1_000_000));
    const reader = await readFile(path.join(dir, "p", "page-0-screen-reader.txt"), "utf8");
    assert.match(reader, /heading "Planted Shop"/);
    for (const f of first.files ?? []) assert.ok(existsSync(path.join(dir, "p", f.file)), f.file);
  });

  it("marks the cross-browser lab as not tested when Firefox and WebKit are missing", () => {
    const lab = planted.agentStats!.find((s) => s.id === "func.browsers")!;
    if (lab.untested) assert.match(lab.untested, /npx playwright install/);
    else assert.ok((lab.runs ?? 0) > 0);
  });
});

describe("website agent helpers", () => {
  it("knows which files belong to the site", () => {
    assert.equal(siteOf("www.shop.example.co.in"), "example.co.in");
    assert.equal(siteOf("cdn.example.com"), "example.com");
    assert.equal(siteOf("127.0.0.1"), "127.0.0.1");
    assert.ok(sameSite("https://static.glv.in/app.js", "www.glv.in"));
    assert.ok(!sameSite("https://cdn.other.com/app.js", "www.glv.in"));
  });

  it("checks library versions against the known problems", () => {
    assert.ok(versionBefore("3.4.1", "3.5.0"));
    assert.ok(!versionBefore("3.5.0", "3.5.0"));
    assert.ok(versionBefore("1.12.4-wp", "1.12.5"));
    assert.equal(advisoriesFor("jquery", "1.12.4").length, 3);
    assert.equal(advisoriesFor("jquery", "3.7.1").length, 0);
    assert.deepEqual(advisoriesFor("bootstrap", "3.4.0").map((a) => a.ids), ["CVE-2019-8331"]);
    assert.equal(advisoriesFor("bootstrap", "4.3.1").length, 0);
    assert.equal(advisoriesFor("bootstrap", "5.3.3").length, 0);
    assert.equal(advisoriesFor("moment", "2.17.0").length, 0, "the date parsing problem starts at 2.18.0");
    assert.equal(advisoriesFor("moment", "2.29.1").length, 1);
    assert.deepEqual(versionsFromFiles(["https://code.jquery.com/jquery-3.4.1.min.js", "https://cdnjs.cloudflare.com/ajax/libs/jqueryui/1.12.1/jquery-ui.min.js", "/wp-includes/js/jquery/jquery.min.js?ver=3.7.1", "/js/app.js"]), [
      ["jquery", "3.4.1"],
      ["jquery-ui", "1.12.1"],
      ["jquery", "3.7.1"],
    ]);
  });

  it("reads languages, scripts and hreflang codes", () => {
    assert.equal(mainScript("नमस्ते दुनिया, यह एक परीक्षण है")?.script, "Devanagari");
    assert.equal(mainScript("Hello world")?.script, "Latin");
    assert.equal(mainScript("Hello नमस्ते"), null, "no script has 60%");
    assert.match(badHreflang("en-UK")!, /GB/);
    assert.match(badHreflang("en_US")!, /not a language code/);
    assert.equal(badHreflang("hi-IN"), null);
    assert.equal(badHreflang("x-default"), null);
    assert.equal(badHreflang("zh-Hant-TW"), null);
  });

  it("knows what a manifest needs for phones to install the site", () => {
    assert.deepEqual(manifestProblems({ name: "A", start_url: "/", display: "standalone", icons: [{ sizes: "192x192" }, { sizes: "512x512" }] }), []);
    assert.equal(manifestProblems({ name: "A" }).length, 4);
  });

  it("counts clicks from the home page through redirects", () => {
    const page = (url: string, redirectedFrom?: string): PageResult => ({ url, redirectedFrom, status: 200, title: "", loadMs: 0 });
    const pages = [page("https://a.in/"), page("https://a.in/b"), page("https://a.in/c", "https://a.in/old-c")];
    const links = new Map([
      ["https://a.in/", ["https://a.in/b"]],
      ["https://a.in/b", ["https://a.in/old-c"]],
    ]);
    const depth = clickDepths(pages, links);
    assert.equal(depth.get("https://a.in/c"), 2);
  });

  it("compares another browser with Chromium by counts, since their error messages differ", () => {
    const view = (v: Partial<BrowserView>): BrowserView => ({ status: 200, errors: [], failed: [], overflow: 0, counts: { images: 10, buttons: 4 }, ...v });
    assert.deepEqual(compareViews("Firefox", "https://a.in/", view({ errors: ["x is undefined"] }), view({ errors: ["undefined is not an object"] })), []);
    const found = compareViews("Firefox", "https://a.in/", view({}), view({ errors: ["x is undefined"], overflow: 40, counts: { images: 2, buttons: 4 } }));
    assert.deepEqual(found.map((f) => f.rule).sort(), ["browser:js-error", "browser:missing-parts", "browser:sideways"]);
    assert.deepEqual(compareViews("WebKit", "https://a.in/", view({}), view({ status: 0, error: "net::ERR" })).map((f) => f.rule), ["browser:page-fails"]);
  });

  it("keeps a shared item on the first page, in page order", () => {
    const make = (page: string, items: string[]) =>
      sharedFinding("perf:test", items.map((i) => ({ key: i, line: i })), (fresh) =>
        finding({ category: "performance", rule: "perf:test", severity: "low", title: `${fresh.length}`, detail: "", pageUrl: page, evidence: fresh.map((f) => f.line).join("\n") }),
      )[0];
    const originals = [make("/1", ["a.js", "b.js"]), make("/2", ["a.js"]), make("/3", ["a.js", "c.js"])];
    for (const f of originals) f.agent = "x";
    const removed = keepFirstSightings(originals);
    assert.deepEqual(
      originals.map((f) => `${f.pageUrl} ${f.evidence}`),
      ["/1 a.js\nb.js", "/3 c.js"],
    );
    assert.equal(removed.get("x"), 1);
  });
});

describe("files agents save with a report", () => {
  it("serves page text and JSON files as plain data, never as pages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glvfiles-"));
    const { app } = await createApp({ dataDir: dir });
    try {
      const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "owner@glv.test", name: "Lucky", password: "a-long-password" } });
      const cookie = String(setup.headers["set-cookie"]).split(";")[0];
      const runDir = path.join(dir, "artifacts", "run1");
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, "page-0-network.json"), '{"responses":[]}');
      await writeFile(path.join(runDir, "page-0-screen-reader.txt"), '- heading "Home"');
      const json = await app.inject({ method: "GET", url: "/api/runs/run1/artifacts/page-0-network.json", headers: { cookie } });
      assert.equal(json.statusCode, 200);
      assert.equal(json.headers["x-content-type-options"], "nosniff");
      assert.equal(json.headers["content-security-policy"], "sandbox");
      const text = await app.inject({ method: "GET", url: "/api/runs/run1/artifacts/page-0-screen-reader.txt", headers: { cookie } });
      assert.match(String(text.headers["content-type"]), /text\/plain/);
      assert.equal((await app.inject({ method: "GET", url: "/api/runs/run1/artifacts/page-0-network.html", headers: { cookie } })).statusCode, 400);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
