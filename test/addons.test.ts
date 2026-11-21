import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { chromium } from "playwright";
import { moduleOn, moduleReady, MODULES } from "../src/modules.js";
import { emailLink, parseSteps, runJourneys } from "../src/runner/journeys.js";
import { byoTool, readReport, wrapperConfig } from "../src/tools/byo.js";
import { grafanaLink, influxArgs } from "../src/tools/k6.js";

process.env.DEFAULT_TOOLS = "none";

const listen = (server: Server) => new Promise<string>((ok) => server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

describe("container modules", () => {
  it("counts a module as installed only when its address is set", () => {
    const mail = MODULES.find((m) => m.id === "mail")!;
    const old = process.env.MAILPIT_URL;
    delete process.env.MAILPIT_URL;
    assert.equal(moduleReady(mail), false);
    assert.equal(moduleOn({ mail: true }, "mail"), false);
    process.env.MAILPIT_URL = "http://mailpit:8025";
    assert.equal(moduleOn({ mail: true }, "mail"), true);
    assert.equal(moduleOn({}, "mail"), false, "off by default");
    if (old === undefined) delete process.env.MAILPIT_URL;
    else process.env.MAILPIT_URL = old;
  });

  it("streams k6 to InfluxDB only with the load charts module", () => {
    const ctx = { modules: { "load-charts": true }, workDir: "/tmp/run-abc" };
    delete process.env.K6_INFLUX_URL;
    assert.deepEqual(influxArgs(ctx), []);
    process.env.K6_INFLUX_URL = "http://influxdb:8086/";
    try {
      assert.deepEqual(influxArgs(ctx), ["--out", "influxdb=http://influxdb:8086/k6", "--tag", "testid=run-abc"]);
      assert.deepEqual(influxArgs({ ...ctx, modules: {} }), []);
      process.env.GRAFANA_URL = "http://localhost:3000";
      assert.match(grafanaLink(ctx)!, /\/d\/glv-k6\/k6-load-test\?var-testid=run-abc/);
    } finally {
      delete process.env.K6_INFLUX_URL;
      delete process.env.GRAFANA_URL;
    }
  });
});

describe("journey email steps", () => {
  it("reads the email steps", () => {
    const s = parseSteps("fill Email = {{inbox}}\nemail has Welcome\nopen email link Confirm my account\nopen /home");
    assert.deepEqual(
      s.map((x) => [x.kind, x.target]),
      [
        ["fill", "Email"],
        ["email-has", "Welcome"],
        ["email-link", "Confirm my account"],
        ["open", "/home"],
      ],
    );
  });

  it("finds the link in an email by its words or address", () => {
    const html = `<p>Hi</p><a href="https://shop.test/unsubscribe">Stop emails</a><a class="btn" href="https://shop.test/confirm?t=1&amp;u=2"><span>Confirm</span> my account</a>`;
    assert.equal(emailLink({ html, text: "" }, "confirm my"), "https://shop.test/confirm?t=1&u=2");
    assert.equal(emailLink({ html, text: "" }, "unsubscribe"), "https://shop.test/unsubscribe");
    assert.equal(emailLink({ html: "", text: "Reset your password:\nhttps://shop.test/reset/abc.\n" }, "reset"), "https://shop.test/reset/abc");
    assert.equal(emailLink({ html, text: "" }, "nothing"), undefined);
  });

  describe("with a test mailbox", () => {
    let site: Server;
    let mailpit: Server;
    let siteUrl = "";
    let mailUrl = "";
    let dir = "";
    const inbox: { ID: string; To: string; Subject: string; HTML: string; Text: string }[] = [];
    before(async () => {
      dir = await mkdtemp(path.join(tmpdir(), "glv-mail-"));
      // A fake Mailpit: the two API calls the journey uses.
      mailpit = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        res.setHeader("content-type", "application/json");
        if (u.pathname === "/api/v1/search") {
          const to = /to:"([^"]+)"/.exec(u.searchParams.get("query") ?? "")?.[1];
          return res.end(JSON.stringify({ messages: inbox.filter((m) => m.To === to).reverse().map((m) => ({ ID: m.ID, Subject: m.Subject })) }));
        }
        const m = inbox.find((x) => `/api/v1/message/${x.ID}` === u.pathname);
        if (!m) return res.writeHead(404).end("{}");
        res.end(JSON.stringify(m));
      });
      mailUrl = await listen(mailpit);
      site = createServer((req, res) => {
        const u = new URL(req.url ?? "/", "http://x");
        res.setHeader("content-type", "text/html");
        if (req.method === "POST" && u.pathname === "/signup") {
          let body = "";
          req.on("data", (d) => (body += d));
          req.on("end", () => {
            const email = new URLSearchParams(body).get("email") ?? "";
            inbox.push({ ID: `m${inbox.length}`, To: email, Subject: "Welcome to the shop", Text: "Welcome!", HTML: `<p>Welcome!</p><a href="${siteUrl}/confirm?u=${encodeURIComponent(email)}">Confirm my account</a>` });
            res.end("<h1>Check your email</h1>");
          });
          return;
        }
        if (u.pathname === "/confirm") return res.end(`<h1>Account confirmed</h1><p>${u.searchParams.get("u")}</p>`);
        res.end(`<form method="post" action="/signup"><label>Email <input name="email"></label><button>Sign up</button></form>`);
      });
      siteUrl = await listen(site);
    });
    after(async () => {
      site.close();
      mailpit.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("signs up, waits for the email and opens its link", async () => {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext();
        const journey = { id: "j1", name: "Sign up", allowWrites: true, steps: "open /\nfill Email = {{inbox}}\nclick Sign up\nsee Check your email\nemail has Welcome\nopen email link Confirm my account\nsee Account confirmed" };
        const r = await runJourneys(context, [journey], { startUrl: `${siteUrl}/`, artifactsDir: dir, mailUrl });
        assert.equal(r.results[0].ok, true, JSON.stringify(r.results[0].steps.at(-1)));
        assert.equal(inbox.length, 1);
        assert.match(inbox[0].To, /^glv-[a-z0-9]+-0@inbox\.glv\.test$/);
        assert.match(r.results[0].steps.at(-1)!.url!, /\/confirm\?u=glv-/);

        // Without the mailbox, the step says how to turn it on.
        const off = await runJourneys(context, [{ ...journey, id: "j2" }], { startUrl: `${siteUrl}/`, artifactsDir: dir });
        assert.equal(off.results[0].ok, false);
        assert.match(off.findings[0].detail, /Test mailbox \(Mailpit\)/);
      } finally {
        await browser.close();
      }
    });
  });
});

describe("bring your own tests", () => {
  it("writes a config that keeps theirs and sets our address", () => {
    const c = wrapperConfig({ theirs: "/x/tests/playwright.config.ts", outputFile: "/w/out.json", workers: 2 });
    assert.match(c, /import theirs from "\.\/playwright\.config\.ts"/);
    assert.match(c, /baseURL: process\.env\.BASE_URL/);
    assert.match(c, /webServer: undefined/);
    assert.match(c, /retries: Math\.max\(base\.retries \|\| 0, 1\)/);
  });

  it("reads failed and flaky tests from the report", () => {
    const r = readReport(
      {
        stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 0 },
        suites: [
          {
            title: "cart.spec.ts",
            file: "cart.spec.ts",
            specs: [],
            suites: [
              {
                title: "Cart",
                file: "cart.spec.ts",
                specs: [
                  { title: "adds an item", file: "cart.spec.ts", line: 4, tests: [{ status: "unexpected", results: [{ status: "failed", error: { message: "\u001b[31mExpected: 2\u001b[39m\nReceived: 1" } }] }] },
                  { title: "shows total", file: "cart.spec.ts", line: 9, tests: [{ status: "flaky", results: [{ status: "failed", error: { message: "Timeout" } }, { status: "passed" }] }] },
                  { title: "opens", file: "cart.spec.ts", line: 2, tests: [{ status: "expected", results: [{ status: "passed" }] }] },
                ],
              },
            ],
          },
        ],
      },
      "https://shop.test/",
    );
    assert.deepEqual(
      r.findings.map((f) => [f.rule, f.title, f.evidence]),
      [
        ["byo:test-failed", 'Your test "Cart › adds an item" fails', "cart.spec.ts:4"],
        ["byo:test-flaky", 'Your test "Cart › shows total" is flaky (failed, then passed on the second try)', "cart.spec.ts:9"],
      ],
    );
    assert.equal(r.findings[0].detail.split("\n")[0], "Expected: 2");
    assert.equal(r.summary[0], "3 passed, 1 failed, 1 flaky, 0 skipped");
  });

  describe("a real run", () => {
    let site: Server;
    let url = "";
    let dir = "";
    before(async () => {
      site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>Shop</title><h1>Welcome to the shop</h1>"));
      url = await listen(site);
      dir = await mkdtemp(path.join(tmpdir(), "glv-byo-"));
    });
    after(async () => {
      site.close();
      await rm(dir, { recursive: true, force: true });
    });

    it("runs the client's tests against the project's address", { timeout: 180_000 }, async () => {
      const spec = `import { test, expect } from "@playwright/test";
test("home has the heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading")).toHaveText("Welcome to the shop");
});
test("home has a cart link", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Cart" })).toBeVisible({ timeout: 1000 });
});
test("sometimes slow", async ({ page }, info) => {
  await page.goto("/");
  expect(info.retry, "fails the first time").toBeGreaterThan(0);
});
`;
      const config = `import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", use: { baseURL: "https://live.example.invalid" }, webServer: { command: "exit 1", url: "http://127.0.0.1:1" } });
`;
      const zip = zipSync({ "shop-tests/playwright.config.ts": strToU8(config), "shop-tests/e2e/home.spec.ts": strToU8(spec) });
      const uploads = path.join(dir, "uploads");
      await mkdir(uploads);
      const file = "11111111-2222-3333-4444-555555555555.zip";
      await writeFile(path.join(uploads, file), zip);
      const work = path.join(dir, "work");
      const out = path.join(dir, "out");
      await mkdir(work);
      await mkdir(out);
      const logs: string[] = [];
      const res = await byoTool.run({
        product: "website",
        target: { url: `${url}/` },
        startUrl: `${url}/`,
        urls: [],
        uploadsDir: uploads,
        options: { tests: file, workers: "1" },
        outDir: out,
        workDir: work,
        signal: new AbortController().signal,
        log: (m) => logs.push(m),
        modules: { "byo-tests": true },
      });
      assert.equal(res.summary?.[0], "1 passed, 1 failed, 1 flaky, 0 skipped", JSON.stringify(res.findings));
      assert.deepEqual(res.findings.map((f) => f.rule).sort(), ["byo:test-failed", "byo:test-flaky"]);
      assert.ok(res.findings.find((f) => f.rule === "byo:test-failed")!.title.includes("home has a cart link"));
      assert.match(logs[0], /with playwright\.config\.ts/);
      assert.ok(JSON.parse(await readFile(path.join(out, "tool-byo.json"), "utf8")).stats);
    });
  });
});
