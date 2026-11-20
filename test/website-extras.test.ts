import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { applyEdits, fixPrompt, fixWithPullRequest, openPullRequest, pickFiles, repoParts } from "../src/fix/pr.js";
import { p75, readBeacon, rumFindings, rumScript, RumStore, summarise } from "../src/rum.js";
import { scanSite } from "../src/runner/scan.js";
import { keywordFit, parseKeywords, parseSearchConsole, readPage } from "../src/seo/audit.js";
import type { ScanResult } from "../src/types.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.DEFAULT_TOOLS = "none";

const HOME = `<!doctype html><html><head><title>GLV Testing Agent</title><meta name="description" content="An AI agent for website testing.">
<style>
  nav.main a { margin: 0 8px; }
  .burger { display: none; }
  @media (max-width: 991px) { nav.main { display: none; } }
  @media (max-width: 767px) { .burger { display: block; } }
</style></head><body>
<header><nav class="main"><a href="/">Home</a><a href="/pricing">Pricing</a><a href="/about">About</a></nav><button class="burger">Menu</button></header>
<h1>Website testing by an AI agent</h1><p>Website testing for every page. Our testing agent checks it all.</p>
<p><a href="http://localhost:PORT/partner" rel="nofollow">A partner</a></p>
</body></html>`;

describe("website extras: pure parts", () => {
  it("reads real-visitor beacons safely and makes p75 numbers", () => {
    assert.deepEqual(readBeacon({ p: "/orders/12345?x=1", d: "phone", lcp: 2100, cls: 0.02, extra: "x" }), { path: "/orders/:id", device: "phone", lcp: 2100, cls: 0.02, inp: undefined, ttfb: undefined, fcp: undefined });
    assert.equal(readBeacon({ p: "https://evil.test/", lcp: 1 }), undefined);
    assert.equal(readBeacon({ p: "/", lcp: -5, cls: "x" }), undefined);
    assert.equal(p75([1, 2, 3, 4]), 3);
    const s = summarise([...Array(30)].map((_, i) => ({ path: "/", device: i % 2 ? "phone" : "desktop", lcp: 3000 + i * 100, inp: 100, cls: 0.3 }) as const), "2026-11-01T00:00:00Z");
    assert.equal(s.visits, 30);
    assert.equal(s.byDevice.length, 2);
    const f = rumFindings(s, "https://shop.test");
    assert.ok(f.some((x) => x.rule === "rum:lcp" && x.severity === "high"));
    assert.ok(f.some((x) => x.rule === "rum:cls"));
    assert.ok(!f.some((x) => x.rule === "rum:inp"));
    assert.equal(rumFindings({ ...s, visits: 5, pages: [] }, "https://shop.test").length, 0, "too few visits: no finding");
  });

  it("keeps visits per project and forgets them on request", () => {
    const store = new RumStore(new DatabaseSync(":memory:"));
    store.add("p1", { path: "/", device: "desktop", lcp: 1000 });
    store.add("p1", { path: "/a", device: "phone", lcp: 5000 });
    store.add("p2", { path: "/", device: "desktop", lcp: 9 });
    assert.equal(store.summary("p1")?.visits, 2);
    assert.equal(store.summary("p1", 28, Date.now() + 40 * 86_400_000), undefined, "older than 28 days");
    store.deleteForProject("p1");
    assert.equal(store.summary("p1"), undefined);
    assert.equal(store.summary("p2")?.visits, 1);
  });

  it("scores keywords and reads Search Console exports", () => {
    const page = readPage(HOME);
    const fit = keywordFit(page, "https://x.test/", "website testing");
    assert.ok(fit.inTitle === false && fit.inH1 && fit.inDescription && fit.count >= 2);
    assert.deepEqual(parseKeywords("/ | website testing, ai agent\nbad line\n/pricing|price", "https://x.test"), [
      { url: "https://x.test/", keywords: ["website testing", "ai agent"] },
      { url: "https://x.test/pricing", keywords: ["price"] },
    ]);
    const gsc = parseSearchConsole('﻿Top queries,Clicks,Impressions,CTR,Position\n"website testing, india",5,900,0.6%,11.2\ntesting agent,4,400,1%,3.1')!;
    assert.equal(gsc.kind, "queries");
    assert.equal(gsc.rows[0].key, "website testing, india");
    assert.equal(gsc.rows[0].position, 11.2);
    assert.equal(parseSearchConsole("a,b\n1,2"), undefined);
  });
});

describe("website extras against a demo site", () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  let result: ScanResult;
  before(async () => {
    server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      const port = (server.address() as AddressInfo).port;
      const send = (s: string, status = 200) => {
        res.writeHead(status, { "content-type": "text/html" });
        res.end(s);
      };
      if (p === "/") return send(HOME.replace("PORT", String(port)));
      if (p === "/pricing") return send("<!doctype html><title>Plans</title><h1>Plans</h1><p>Prices.</p>");
      if (p === "/about") return send("<!doctype html><title>About</title><h1>About us</h1>");
      // Pages on "another site" (localhost instead of 127.0.0.1) that link here, or used to.
      if (p === "/partner") return send(`<!doctype html><title>Partner</title><a href="http://127.0.0.1:${port}/pricing" rel="nofollow">GLV testing</a>`);
      if (p === "/old-partner") return send("<!doctype html><title>Old partner</title><p>No links now.</p>");
      send("not found", 404);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    dir = await mkdtemp(path.join(tmpdir(), "glv-web-"));
    await mkdir(path.join(dir, "uploads"));
    await writeFile(path.join(dir, "uploads", "gsc.csv"), "Top queries,Clicks,Impressions,CTR,Position\nwebsite testing,5,900,0.6%,11.2\ntesting agent,4,400,1%,3.1\n");
    result = await scanSite({
      url: base,
      maxPages: 3,
      product: "website",
      artifactsDir: dir,
      uploadsDir: path.join(dir, "uploads"),
      agents: ["web.tablet", "seo.audit"],
      seo: { keywords: "/ | website testing\n/pricing | testing tool price", backlinks: `http://localhost:${port}/partner\nhttp://localhost:${port}/old-partner`, gscFile: "gsc.csv" },
      rum: summarise([...Array(25)].map(() => ({ path: "/", device: "phone" as const, lcp: 4500 })), "2026-11-01T00:00:00Z"),
    });
  });
  after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("checks the tablet size and keeps a tablet picture", async () => {
    const rules = new Set(result.findings.map((f) => f.rule));
    assert.ok(rules.has("tablet-menu-missing"), [...rules].join(", "));
    assert.ok(result.pages[0].tabletScreenshot);
    await readFile(path.join(dir, result.pages[0].tabletScreenshot!));
  });

  it("audits keywords, the listed backlinks and the Search Console export, and says its limits", () => {
    const seo = result.seo!;
    const rules = new Set(result.findings.map((f) => f.rule));
    assert.ok(rules.has("seo:keyword-weak"), "the pricing page is weak for its keyword");
    assert.ok(rules.has("seo:backlink-lost"));
    assert.ok(rules.has("seo:backlinks-all-nofollow"));
    assert.ok(rules.has("seo:striking-distance"));
    assert.ok(rules.has("seo:low-ctr"));
    assert.ok(rules.has("rum:lcp"), "real-visitor numbers are in the report");
    assert.equal(seo.backlinks.find((b) => b.from.endsWith("/partner"))?.linked, true);
    assert.equal(seo.outbound.nofollow, 1);
    assert.ok(seo.limits.some((l) => /cannot|can't|not/i.test(l)));
    assert.equal(result.rum?.visits, 25);
  });

  it("the speed snippet measures a real visit and sends it", async () => {
    let got = "";
    const s = http.createServer((req, res) => {
      if (req.method === "POST") {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => {
          got = b;
          res.writeHead(204);
          res.end();
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>x</title><h1>Hello visitor</h1><p>${"text ".repeat(200)}</p><script>${rumScript("/rum/abc")}</script>`);
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const b = await chromium.launch();
    try {
      const page = await b.newPage();
      await page.goto(`http://127.0.0.1:${(s.address() as AddressInfo).port}/shop?id=1`);
      await page.waitForTimeout(500);
      await page.goto("about:blank");
      for (let i = 0; i < 20 && !got; i++) await new Promise((r) => setTimeout(r, 100));
    } finally {
      await b.close();
      s.close();
    }
    const beacon = readBeacon(JSON.parse(got));
    assert.equal(beacon?.path, "/shop");
    assert.equal(beacon?.device, "desktop");
    assert.ok(typeof beacon?.ttfb === "number");
  });
});

describe("AI fix pull requests", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-fix-"));
  });
  after(async () => rm(dir, { recursive: true, force: true }));

  it("picks the files that match the issue and applies exact edits only", async () => {
    const repo = path.join(dir, "repo");
    await mkdir(path.join(repo, "src"), { recursive: true });
    await mkdir(path.join(repo, "node_modules", "x"), { recursive: true });
    await writeFile(path.join(repo, "src", "header.html"), '<img src="logo.png">\n<nav>menu</nav>\n');
    await writeFile(path.join(repo, "src", "other.css"), "body{}\n");
    await writeFile(path.join(repo, "node_modules", "x", "logo.png.html"), "x");
    const finding = { rule: "a11y:image-alt", title: "Images without alt text", detail: "Add alt text.", severity: "medium" as const, pageUrl: "https://x.test/", evidence: '<img src="logo.png">' };
    const picked = await pickFiles(repo, ["src/header.html", "src/other.css"], finding);
    assert.equal(picked[0], "src/header.html");
    assert.match(fixPrompt(finding, [{ path: "src/header.html", text: "<img>" }], ["src/header.html"]), /Images without alt text/);
    assert.deepEqual(await applyEdits(repo, [{ file: "src/header.html", find: '<img src="logo.png">', replace: '<img src="logo.png" alt="GLV logo">' }]), ["src/header.html"]);
    assert.match(await readFile(path.join(repo, "src", "header.html"), "utf8"), /alt="GLV logo"/);
    await assert.rejects(applyEdits(repo, [{ file: "../outside.txt", find: "a", replace: "b" }]));
    await assert.rejects(applyEdits(repo, [{ file: ".git/config", find: "a", replace: "b" }]));
    await assert.rejects(applyEdits(repo, [{ file: "src/other.css", find: "not there", replace: "b" }]));
  });

  it("opens the pull request through the GitHub API, and reads GitLab addresses", async () => {
    assert.deepEqual(repoParts("https://github.com/acme/site.git"), { host: "github.com", kind: "github", path: "acme/site" });
    assert.equal(repoParts("https://gitlab.acme.test/web/shop").kind, "gitlab");
    assert.throws(() => repoParts("https://bitbucket.org/a/b"), /GitHub and GitLab/);
    let asked: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const api = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        asked = { url: req.url, auth: req.headers.authorization, body: JSON.parse(b) };
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ html_url: "https://github.com/acme/site/pull/7" }));
      });
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
    process.env.GITHUB_API_URL = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    try {
      const url = await openPullRequest("https://github.com/acme/site", "tok-123456", { head: "glv-fix/x", base: "main", title: "Fix: alt", body: "b" });
      assert.equal(url, "https://github.com/acme/site/pull/7");
      assert.equal(asked.url, "/repos/acme/site/pulls");
      assert.equal(asked.auth, "Bearer tok-123456");
      assert.equal(asked.body?.head, "glv-fix/x");
    } finally {
      delete process.env.GITHUB_API_URL;
      api.close();
    }
  });

  it("never shows the token in an error", async () => {
    const r = await fixWithPullRequest({
      finding: { rule: "x", title: "T", detail: "d", severity: "low", pageUrl: "https://x.test" },
      issueKey: "GLV-1",
      repoUrl: "https://github.com/glv-does-not-exist-000/nope",
      token: { token: "ghp_secret_token_value_123" },
      workDir: dir,
      by: "test",
      write: async () => ({ summary: "s", edits: [] }),
    });
    assert.equal(r.status, "failed");
    assert.ok(r.error);
    assert.ok(!r.error!.includes("ghp_secret_token_value_123"));
    assert.match(r.branch, /^glv-fix\/glv-1-/);
  });
});
