import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { compactFindings } from "../src/ai/triage.js";
import { isCrawlable, normaliseUrl, scanSite } from "../src/runner/scan.js";
import { scoreFindings } from "../src/runner/score.js";
import type { ScanResult } from "../src/types.js";
import { startDemoSite } from "./fixtures/demo-site.js";

describe("url helpers", () => {
  it("normalises hashes and trailing slashes", () => {
    assert.equal(normaliseUrl("https://a.com/x/#top"), "https://a.com/x");
    assert.equal(normaliseUrl("https://a.com/"), "https://a.com/");
  });
  it("only crawls same-origin pages", () => {
    assert.ok(isCrawlable("https://a.com/about", "https://a.com"));
    assert.ok(!isCrawlable("https://b.com/about", "https://a.com"));
    assert.ok(!isCrawlable("https://a.com/file.pdf", "https://a.com"));
    assert.ok(!isCrawlable("mailto:hi@a.com", "https://a.com"));
  });
});

describe("scoring", () => {
  it("gives 100 with no findings and drops with severe ones", () => {
    assert.equal(scoreFindings([], 1).overallScore, 100);
    const { scores } = scoreFindings(
      [
        {
          id: "1",
          category: "security",
          severity: "critical",
          title: "",
          detail: "",
          pageUrl: "",
          rule: "x",
        },
      ],
      1,
    );
    assert.equal(scores.security, 75);
  });
  it("caps the overall score below 70 when anything is critical", () => {
    const { overallScore } = scoreFindings(
      [{ id: "1", category: "seo", severity: "critical", title: "", detail: "", pageUrl: "", rule: "x" }],
      1,
    );
    assert.ok(overallScore <= 69);
  });
});

describe("scanSite against the demo site", () => {
  let server: Server;
  let dir: string;
  let result: ScanResult;
  const port = 4199;

  before(async () => {
    server = await startDemoSite(port);
    dir = await mkdtemp(path.join(tmpdir(), "glvtest-"));
    result = await scanSite({ url: `http://127.0.0.1:${port}/`, maxPages: 10, artifactsDir: dir });
  });
  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const rules = () => new Set(result.findings.map((f) => f.rule));

  it("crawls the linked pages", () => {
    const urls = result.pages.map((p) => p.url).sort();
    assert.ok(urls.includes(`http://127.0.0.1:${port}/about`));
    assert.ok(urls.includes(`http://127.0.0.1:${port}/contact`));
  });
  it("finds the 404 page and the JavaScript error", () => {
    assert.ok(rules().has("page-error-status"), "404 page");
    assert.ok(rules().has("js-exception"), "uncaught error");
  });
  it("finds SEO problems", () => {
    for (const r of ["seo:description-missing", "seo:img-alt", "seo:h1-multiple", "seo:lang-missing"]) {
      assert.ok(rules().has(r), r);
    }
  });
  it("finds accessibility problems", () => {
    assert.ok([...rules()].some((r) => r.startsWith("axe:")));
    assert.ok(rules().has("axe:color-contrast"));
  });
  it("finds security problems", () => {
    for (const r of ["sec:no-https", "sec:csp-missing", "sec:version-disclosure", "sec:clickjacking"]) {
      assert.ok(rules().has(r), r);
    }
  });
  it("finds the mobile overflow", () => {
    assert.ok(rules().has("mobile-overflow"));
  });
  it("takes screenshots", () => {
    assert.ok(result.pages.every((p) => p.error || p.screenshot));
  });
  it("follows a redirect to another host and keeps crawling there", async () => {
    const redirected = await scanSite({
      url: `http://localhost:${port}/`,
      maxPages: 5,
      checkLinks: false,
      accessibility: false,
      artifactsDir: dir,
    });
    assert.equal(redirected.pages[0].url, `http://127.0.0.1:${port}/`);
    assert.equal(redirected.pages[0].redirectedFrom, `http://localhost:${port}/`);
    assert.ok(redirected.pages.length >= 3, `crawled ${redirected.pages.length} pages`);
  });
  it("builds a compact prompt for Claude", () => {
    const text = compactFindings(result.findings);
    assert.match(text, /\[critical\]/);
    assert.ok(text.split("\n").length <= 60);
  });
});
