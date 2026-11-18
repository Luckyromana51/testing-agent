import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { addressParams, getForms, likeness, linkParams, probesTool, sqlError, withParam } from "../src/tools/probes.ts";
import type { ToolContext, ToolOutput } from "../src/tools/types.ts";
import { startVulnSite, type VulnSite } from "./fixtures/vuln-site.ts";

process.env.ALLOW_PRIVATE_TARGETS = "1";

const PAGES = ["", "search?q=kurta", "product?id=1", "item?id=2", "user?name=alice", "go?next=/", "doc?file=intro.txt", "csp-search?q=saree", "news?id=1"];

async function probe(site: VulnSite, dir: string): Promise<ToolOutput> {
  const ctx: ToolContext = {
    product: "website",
    target: { url: site.url },
    startUrl: site.url,
    urls: PAGES.slice(1).map((p) => site.url + p),
    uploadsDir: dir,
    options: { minutes: "5" },
    outDir: dir,
    workDir: dir,
    signal: new AbortController().signal,
    log: () => {},
    permit: { hosts: [site.host], maxUsers: 10, maxMinutes: 10, writes: false },
  };
  return probesTool.run(ctx);
}

describe("GLV attack probes", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glvprobe-"));
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "intro.txt"), "We sell handmade clothes.");
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds and confirms every planted hole, with GET only and no payload that can change data", async () => {
    const site = await startVulnSite("planted", path.join(dir, "docs"));
    try {
      const out = await probe(site, dir);
      const got = out.findings.map((f) => `${f.rule} ${new URL(f.pageUrl).pathname} ${f.severity}`).sort();
      assert.deepEqual(got, [
        "probe:open-redirect /go medium",
        "probe:path-traversal /doc critical",
        "probe:sql-injection /item high",
        "probe:sql-injection /product high",
        "probe:sql-injection /user high",
        // The CSP stops the script, so the hole is reported as unescaped HTML, not as running script.
        "probe:xss /csp-search medium",
        "probe:xss /find high",
        "probe:xss /search high",
      ]);
      const byPath = (p: string, rule: string) => out.findings.find((f) => f.rule === rule && new URL(f.pageUrl).pathname === p)!;
      assert.match(byPath("/search", "probe:xss").title, /runs injected script/);
      assert.match(byPath("/find", "probe:xss").title, /form field "term"/);
      assert.match(byPath("/user", "probe:sql-injection").title, /breaks the database query/);
      assert.match(byPath("/user", "probe:sql-injection").evidence!, /syntax error/);
      // Errors hidden: found by true and false conditions.
      assert.match(byPath("/item", "probe:sql-injection").title, /changes the database query/);
      assert.match(byPath("/go", "probe:open-redirect").evidence!, /Location: https:\/\/glv-redirect-check\.invalid\//);
      assert.ok(out.findings.every((f) => f.key && f.category === "security"));

      assert.ok(site.requests.every((r) => r.method === "GET"), "only GET requests");
      const sent = site.requests.map((r) => decodeURIComponent(r.url.replace(/\+/g, " ")));
      assert.ok(!sent.some((u) => /\bOR\b|;|\b(DROP|DELETE|UPDATE|INSERT|SLEEP|BENCHMARK)\b/i.test(u)), "no payload that can change data or load the database");
      // The POST form on the home page is never sent, and sign-out and delete links are never probed.
      assert.ok(!sent.some((u) => u.startsWith("/subscribe")));
      assert.ok(!sent.some((u) => u.startsWith("/logout") || u.startsWith("/cart/delete")), "no sign-out or delete link");
      assert.ok(site.requests.length < 150, String(site.requests.length));
      assert.match(out.summary?.[0] ?? "", /^9 of 9 parameters probed/);
    } finally {
      await site.close();
    }
  });

  it("finds nothing on the same shop done right, even on a page that changes on every load", async () => {
    const site = await startVulnSite("clean", path.join(dir, "docs"));
    try {
      const out = await probe(site, dir);
      assert.deepEqual(out.findings, []);
      assert.ok(site.requests.every((r) => r.method === "GET"));
    } finally {
      await site.close();
    }
  });

  it("needs the client's permission", async () => {
    await assert.rejects(probesTool.run({ permit: undefined } as unknown as ToolContext), /only with the client's permission/);
  });

  it("reads parameters and GET forms, and compares pages fairly", () => {
    assert.deepEqual(addressParams("https://a.example/s?q=x&page=2").map((t) => [t.param, t.value]), [["q", "x"], ["page", "2"]]);
    const forms = getForms(
      `<form action="/find"><input name="term"><input type="password" name="pw"><input type="hidden" name="cat" value="5"><select name="sort"></select><button>Go</button></form>
       <form method="POST" action="/login"><input name="user"></form>
       <form action="https://other.example/search"><input name="q"></form>
       <form><input name="id"></form>`,
      "https://a.example/shop?x=1",
    );
    assert.deepEqual(forms.map((f) => `${f.url} ${f.param}=${f.value}`), [
      "https://a.example/find term=test",
      "https://a.example/find cat=5",
      "https://a.example/find sort=test",
      "https://a.example/shop id=1",
    ]);
    assert.deepEqual(
      linkParams(`<a href="/go?next=/home&amp;ref=nav">Go</a><a href="https://other.example/x?q=1">x</a><a href="/plain">p</a><a href="#top?x=1">t</a>`, "https://a.example/").map((t) => `${t.url} ${t.param}`),
      ["https://a.example/go?next=/home&ref=nav next", "https://a.example/go?next=/home&ref=nav ref"],
    );
    assert.equal(withParam({ url: "https://a.example/p?id=1&x=2", param: "id", value: "1", from: "address" }, "1 AND 1=1"), "https://a.example/p?id=1+AND+1%3D1&x=2");
    assert.equal(sqlError("You have an error in your SQL syntax; check the manual"), "MySQL");
    assert.equal(sqlError('ERROR:  syntax error at or near "\'"'), "PostgreSQL");
    assert.equal(sqlError("Unclosed quotation mark after the character string ''."), "Microsoft SQL Server");
    assert.equal(sqlError("We could not find that product."), undefined);
    const page = (body: string, status = 200) => ({ status, body, type: "text/html" });
    assert.equal(likeness(page("<p>Kurta costs Rs 899</p>"), page("<p>Kurta costs Rs 899</p>")), 1);
    assert.equal(likeness(page("<p>a</p>"), page("<p>a</p>", 500)), 0);
    // A page that only echoes the probe's value is still the same page (a real page has far more words than this footer).
    const footer = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    assert.ok(likeness(page(`<p>Results for kurta</p><p>3 found</p>${footer}`), page(`<p>Results for kurta&#39; AND &#39;1&#39;=&#39;1</p><p>3 found</p>${footer}`), ["kurta' AND '1'='1"]) > 0.97);
    assert.ok(likeness(page(`<p>Kurta: Rs 899</p>${footer}`), page(`<p>Sorry, we could not find that item.</p>${footer}`)) < 0.97);
  });
});
