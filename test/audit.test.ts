import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { compareRendered, cspProblems } from "../src/agents/web/audit.js";
import { reportHtml } from "../src/report-html.js";
import { scanSite } from "../src/runner/scan.js";
import { createApp } from "../src/server.js";
import type { Run, ScanResult } from "../src/types.js";
import { wcagReport, WCAG22 } from "../src/wcag.js";

process.env.DEFAULT_TOOLS = "none";

let base = "";
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
function site(): Promise<Server> {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const send = (body: string, headers: Record<string, string> = {}) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    switch (u.pathname) {
      case "/":
        return send(
          page("Home", `<a href="/old">Old link</a> <a href="/app">App</a><script>fetch("/api/me")</script>`),
          {
            "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https:",
            "set-cookie": "sid=abc123; Path=/",
          },
        );
      case "/old":
        res.writeHead(301, { location: "/older" });
        return res.end();
      case "/older":
        res.writeHead(302, { location: "/about" });
        return res.end();
      case "/about":
        return send(page("About", `<p>We make pottery.</p><a href="/">Home</a>`));
      case "/app":
        // The server sends an empty shell; JavaScript writes the title, heading and text.
        return send(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body><div id="root"></div><script>
document.title = "Our app";
document.getElementById("root").innerHTML = "<h1>Dashboard</h1><p>" + "Lots of useful words for visitors to read here. ".repeat(20) + "</p><a href='/'>Home</a>";
</script></body></html>`,
        );
      case "/api/me": {
        const origin = req.headers.origin;
        res.writeHead(200, { "content-type": "application/json", ...(origin ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" } : {}) });
        return res.end('{"name":"Asha"}');
      }
      case "/sitemap.xml":
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(`<?xml version="1.0"?><urlset><url><loc>${base}/</loc></url><url><loc>${base}/about</loc></url><url><loc>${base}/forgotten</loc></url></urlset>`);
      case "/forgotten":
        return send(page("Forgotten", "<p>No one links here.</p>"));
      default:
        res.writeHead(404);
        return res.end("nope");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

describe("site audit agents", () => {
  let server: Server;
  let dir: string;
  let result: ScanResult;
  before(async () => {
    server = await site();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(path.join(tmpdir(), "glv-audit-"));
    result = await scanSite({
      url: `${base}/`,
      maxPages: 10,
      agents: ["seo.redirect-chain", "seo.rendered-html", "seo.orphans", "sec.cors", "sec.csp-strength", "web.accessibility", "a11y.keyboard"],
      artifactsDir: dir,
      parallel: 1,
    });
  });
  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
  const rules = () => result.findings.map((f) => f.rule);

  it("finds a redirect chain", () => {
    const f = result.findings.find((x) => x.rule === "seo:redirect-chain");
    assert.ok(f, rules().join(", "));
    assert.equal(f.evidence, `${base}/old → ${base}/older → ${base}/about`);
  });

  it("finds content, title and heading that only JavaScript adds", () => {
    const content = result.findings.find((x) => x.rule === "seo:js-only-content");
    assert.ok(content);
    assert.equal(content.pageUrl, `${base}/app`);
    const tags = result.findings.find((x) => x.rule === "seo:js-only-tags")!;
    assert.match(tags.title, /title, main heading/);
    assert.ok(!result.findings.some((x) => x.rule.startsWith("seo:js-only") && x.pageUrl === `${base}/about`));
  });

  it("finds sitemap pages linked from nowhere", () => {
    const f = result.findings.find((x) => x.rule === "seo:orphan-page");
    assert.ok(f, rules().join(", "));
    assert.equal(f.evidence, `${base}/forgotten`);
  });

  it("finds an API that any website can read with the visitor's login", () => {
    const f = result.findings.find((x) => x.rule === "sec:cors-reflects-origin");
    assert.ok(f);
    assert.equal(f.severity, "high");
    assert.equal(f.pageUrl, `${base}/api/me`);
  });

  it("rates the CSP", () => {
    const f = result.findings.find((x) => x.rule === "sec:csp-weak")!;
    assert.equal(f.severity, "medium");
    assert.match(f.detail, /unsafe-inline/);
    assert.match(f.detail, /https:/);
  });

  it("lists the cookies without their values", () => {
    assert.deepEqual(
      result.cookies?.map((c) => [c.name, c.firstParty, c.httpOnly]),
      [["sid", true, false]],
    );
    assert.ok(!JSON.stringify(result.cookies).includes("abc123"));
  });

  it("builds the WCAG table from what ran", () => {
    const w = wcagReport(result);
    assert.equal(w.results.length, WCAG22.length);
    const byId = Object.fromEntries(w.results.map((r) => [r.id, r]));
    assert.equal(byId["2.1.2"].status, "passes", "the keyboard agent ran and found no trap");
    assert.equal(byId["1.2.4"].status, "manual");
    assert.equal(byId["1.4.12"].status, "not-tested", "the text spacing agent did not run");
  });
});

describe("audit helpers", () => {
  it("compares raw and rendered HTML", () => {
    const c = compareRendered("<html><head><title>A</title></head><body><div id=r></div></body></html>", "<html><head><title>A</title></head><body><h1>Hi</h1><p>one two three</p></body></html>");
    assert.equal(c.raw.words, 0);
    assert.equal(c.rendered.h1, "Hi");
    assert.equal(c.raw.title, "A");
  });

  it("finds weak CSP rules and passes a strict one", () => {
    assert.deepEqual(cspProblems("script-src 'nonce-abc' 'strict-dynamic'; object-src 'none'; base-uri 'self'"), []);
    const p = cspProblems("default-src *; script-src 'self' 'unsafe-eval'");
    assert.ok(p.some((x) => /unsafe-eval/.test(x)));
    assert.ok(p.some((x) => /object-src/.test(x)));
    assert.ok(p.some((x) => /base-uri/.test(x)));
    assert.ok(cspProblems("img-src 'self'").some((x) => /no script-src/.test(x)));
  });

  it("writes a report page that escapes the site's text", () => {
    const run: Run = {
      id: "r1",
      url: "https://x/",
      status: "done",
      createdAt: "2026-11-19T00:00:00Z",
      progress: [],
      result: {
        startUrl: "https://x/",
        startedAt: "",
        finishedAt: "",
        pages: [{ url: "https://x/", status: 200, title: "", loadMs: 1 }],
        findings: [{ id: "1", rule: "axe:color-contrast", title: "<script>alert(1)</script> low contrast", detail: "d", pageUrl: "https://x/", severity: "high", category: "accessibility" }],
        scores: { accessibility: 80 },
        overallScore: 80,
        cookies: [{ name: "sid", domain: "x", path: "/", firstParty: true, secure: false, httpOnly: false, sameSite: "Lax", size: 5 }],
      },
    };
    const html = reportHtml(run, "Shop & Co", "GLV");
    assert.ok(!html.includes("<script>alert(1)"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(html.includes("Shop &amp; Co"));
    assert.ok(html.includes("WCAG 2.2"));
    assert.ok(html.includes("How to fix"));
  });
});

describe("API: client report", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dataDir = await mkdtemp(path.join(tmpdir(), "glv-report-"));
    ({ app, stores } = await createApp({ dataDir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("serves the printable page without scripts and the PDF", async () => {
    stores.runs.save({
      id: "r1",
      url: "https://x/",
      status: "done",
      createdAt: "2026-11-19T00:00:00Z",
      progress: [],
      result: { startUrl: "https://x/", startedAt: "", finishedAt: "", pages: [], findings: [], scores: { functional: 100 }, overallScore: 100 },
    });
    const html = await app.inject({ method: "GET", url: "/api/runs/r1/report.html" });
    assert.equal(html.statusCode, 200);
    assert.match(String(html.headers["content-security-policy"]), /default-src 'none'/);
    const pdf = await app.inject({ method: "GET", url: "/api/runs/r1/report.pdf" });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
  });
});
