import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { loadOwnChecks, moduleOn } from "../src/modules.js";
import { WEB_AGENTS } from "../src/agents/registry.js";
import { cssCoverage, hideSecrets, jsCoverage, toHar, type InspectData } from "../src/runner/inspect.js";
import { cleanJourney, parseSteps } from "../src/runner/journeys.js";
import { scanSite } from "../src/runner/scan.js";
import { baselineKey } from "../src/runner/visual.js";
import { createApp } from "../src/server.js";
import type { Journey } from "../src/types.js";

process.env.DEFAULT_TOOLS = "none";

/** A small shop: a home page with a console error and unused code, a shop page and a cart. */
let colour = "#2563eb";
const orders: string[] = [];
function site(): Promise<{ server: Server; base: string }> {
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>.used{color:#222}.never-used-1{color:red}.never-used-2{margin:4px}.never-used-3{padding:9px}</style>
<script src="/app.js"></script></head><body style="margin:0;font-family:sans-serif">
<header><nav aria-label="Main"><a href="/">Home</a> <a href="/shop">Shop</a></nav></header>
<main><h1 class="used">${title}</h1>${body}</main><footer>Footer</footer></body></html>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST") {
      orders.push(url.pathname);
      res.writeHead(303, { location: "/thanks" });
      return res.end();
    }
    if (url.pathname === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript", "set-cookie": "sid=secret-session; Path=/" });
      return res.end(
        `function neverCalled(){ var a = 1; for (var i = 0; i < 100; i++) { a += i; } return a; }
function alsoNever(){ return "unused code ".repeat(20); }
console.log("app ready");
console.error("Price service is down");`,
      );
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.pathname === "/") {
      return res.end(
        page(
          "Home",
          `<div style="height:300px;background:${colour}"></div><h2>Welcome</h2><button>Sign up</button> <input aria-label="Search" placeholder="Search">`,
        ),
      );
    }
    if (url.pathname === "/shop") {
      return res.end(
        page(
          "Shop",
          `<p>Blue mug, ₹499</p><button onclick="document.getElementById('c').hidden=false;history.pushState({},'','/cart')">Add to cart</button>
<div id="c" hidden><h2>Your cart</h2><form method="post" action="/order"><label>Email <input name="email"></label><button>Place order</button></form></div>`,
        ),
      );
    }
    if (url.pathname === "/thanks") return res.end(page("Thank you", "<p>Order placed</p>"));
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe("journey steps", () => {
  it("reads plain-word steps and refuses lines it does not understand", () => {
    const steps = parseSteps(`# a note
open /shop
click Add to cart
fill Email = {{username}}
select Country = India
see Your cart
not see Error
url has /cart
wait 1
screenshot`);
    assert.deepEqual(
      steps.map((s) => s.kind),
      ["open", "click", "fill", "select", "see", "not-see", "url-has", "wait", "screenshot"],
    );
    assert.equal(steps[2].target, "Email");
    assert.equal(steps[2].value, "{{username}}");
    assert.throws(() => parseSteps("open /\nmake coffee"), /Line 2/);
    assert.throws(() => parseSteps("# only a note"), /no steps/);
    assert.throws(() => cleanJourney({ name: "Bad", steps: "fly away" }, 0), /Bad: Line 1/);
    assert.equal(cleanJourney({ name: " ", steps: "open /" }, 2).name, "Journey 3");
  });
});

describe("inspect helpers", () => {
  it("hides cookies and login headers", () => {
    const h = hideSecrets({ cookie: "a=1", authorization: "Bearer x", "set-cookie": "s=1", accept: "text/html" });
    assert.deepEqual(h, { cookie: "(hidden)", authorization: "(hidden)", "set-cookie": "(hidden)", accept: "text/html" });
  });

  it("counts unused JavaScript and CSS", () => {
    const js = jsCoverage([
      {
        url: "https://x/a.js",
        source: "x".repeat(100),
        functions: [
          { ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
          { ranges: [{ startOffset: 20, endOffset: 60, count: 0 }] },
        ],
      },
    ]);
    assert.deepEqual(js, [{ url: "https://x/a.js", type: "js", totalBytes: 100, unusedBytes: 40 }]);
    const css = cssCoverage([{ url: "https://x/a.css", text: "y".repeat(50), ranges: [{ start: 0, end: 10 }] }]);
    assert.equal(css[0].unusedBytes, 40);
  });

  it("writes a HAR 1.2 file", () => {
    const d: InspectData = {
      url: "https://x/",
      startedAt: "2026-11-19T00:00:00.000Z",
      steps: [],
      console: [],
      tabOrder: [],
      outline: [],
      viewport: { width: 1, height: 1 },
      network: [{ url: "https://x/?q=1", method: "GET", status: 200, type: "document", start: 5, end: 25, bytes: 9, requestHeaders: {}, responseHeaders: { "content-type": "text/html" } }],
    };
    const har = toHar(d) as { log: { version: string; entries: { time: number; request: { queryString: unknown[] }; startedDateTime: string }[] } };
    assert.equal(har.log.version, "1.2");
    assert.equal(har.log.entries[0].time, 20);
    assert.deepEqual(har.log.entries[0].request.queryString, [{ name: "q", value: "1" }]);
    assert.equal(har.log.entries[0].startedDateTime, "2026-11-19T00:00:00.005Z");
  });

  it("modules have defaults the owner can change", () => {
    assert.equal(moduleOn(undefined, "inspect"), true);
    assert.equal(moduleOn({ inspect: false }, "inspect"), false);
    assert.equal(moduleOn(undefined, "own-checks"), false);
  });
});

describe("inspect screen, visual compare and journeys in a real test", () => {
  let s: { server: Server; base: string };
  let dir: string;
  before(async () => {
    s = await site();
    dir = await mkdtemp(path.join(tmpdir(), "glv-inspect-"));
  });
  after(async () => {
    s.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const journeys: Journey[] = [
    { id: "cart", name: "Add to cart", steps: "open /shop\nclick Add to cart\nsee Your cart\nurl has /cart" },
    { id: "order", name: "Place an order", steps: "open /shop\nclick Add to cart\nfill Email = test@example.com\nclick Place order\nsee Order placed" },
    { id: "broken", name: "Find the sale", steps: "open /\nsee Big sale" },
    { id: "off", name: "Not run", steps: "open /", off: true },
  ];

  it("records each page, follows journeys read-only, and compares pictures", async () => {
    const baselines = path.join(dir, "baselines");
    const scan = (n: number) =>
      scanSite({
        url: `${s.base}/`,
        maxPages: 2,
        agents: ["web.js-errors"],
        artifactsDir: path.join(dir, `run${n}`),
        inspect: true,
        baselineDir: baselines,
        journeys,
        parallel: 1,
      });

    const first = await scan(1);
    const home = first.pages.find((p) => p.url === `${s.base}/`)!;
    assert.ok(home.inspect, "the home page has an inspect recording");
    const data = JSON.parse(await readFile(path.join(dir, "run1", home.inspect.file), "utf8")) as InspectData;
    // Network: the page and its script, with timing; the cookie the script set is hidden.
    const script = data.network.find((r) => r.url.endsWith("/app.js"))!;
    assert.equal(script.status, 200);
    assert.ok(script.end >= script.start);
    assert.equal(script.responseHeaders["set-cookie"], "(hidden)");
    assert.ok(data.network.some((r) => r.type === "document" && r.status === 200));
    // Console: the log and the error, in order.
    assert.deepEqual(
      data.console.map((c) => [c.type, c.text]),
      [
        ["log", "app ready"],
        ["error", "Price service is down"],
      ],
    );
    // Steps: opening the page, the agent, the pictures.
    assert.match(data.steps[0].label, /^Open /);
    assert.ok(data.steps.some((st) => st.label === "Desktop picture"));
    // Tab order: links, then the button and the field, in page order.
    assert.deepEqual(
      data.tabOrder.map((b) => b.label),
      ['a "Home"', 'a "Shop"', 'button "Sign up"', 'input "Search"'],
    );
    assert.ok(data.outline.some((o) => o.kind === "heading" && o.level === 1));
    assert.ok(data.outline.some((o) => o.kind === "landmark" && o.label === 'navigation "Main"'));
    assert.ok(data.outline.some((o) => o.kind === "landmark" && o.label === "main"));
    // Unused code: most of app.js and the never-used CSS rules.
    const cov = data.coverage ?? [];
    assert.ok(cov.find((c) => c.type === "js" && c.url.endsWith("/app.js"))!.unusedBytes > 50);
    assert.ok(cov.some((c) => c.type === "css" && c.unusedBytes > 0));
    // The HTML and the HAR are saved next to it.
    assert.match(await readFile(path.join(dir, "run1", home.inspect.dom!), "utf8"), /Sign up/);
    const har = JSON.parse(await readFile(path.join(dir, "run1", home.inspect.har), "utf8"));
    assert.ok(har.log.entries.length >= 2);

    // Journeys: one passes, the order is stopped before it changes anything, one fails.
    const j = Object.fromEntries((first.journeys ?? []).map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(j).sort(), ["broken", "cart", "order"]);
    assert.equal(j.cart.ok, true);
    assert.equal(j.cart.steps.length, 4);
    assert.ok(j.cart.steps.every((st) => st.shot));
    assert.equal(j.order.ok, false);
    assert.ok(j.order.steps.some((st) => st.blocked?.some((b) => b.startsWith("POST "))));
    assert.deepEqual(orders, [], "no order was placed");
    assert.equal(j.broken.ok, false);
    assert.match(j.broken.steps[1].error ?? "", /"Big sale" is not on the page/);
    const jf = first.findings.filter((f) => f.rule === "journey:failed");
    assert.equal(jf.length, 2);
    assert.ok(jf.some((f) => /may send forms|allow it to send forms/.test(f.detail)));

    // Visual: the first test saves the approved pictures.
    assert.equal(home.visual?.desktop?.status, "new");
    assert.equal(home.visual?.phone?.status, "new");
    assert.equal(first.findings.filter((f) => f.rule === "visual:changed").length, 0);

    // The same site again: same pictures.
    const second = await scan(2);
    const home2 = second.pages.find((p) => p.url === `${s.base}/`)!;
    assert.equal(home2.visual?.desktop?.status, "same");
    assert.equal(second.findings.filter((f) => f.rule === "visual:changed").length, 0);

    // The banner changes colour: the home page looks different, the shop does not.
    colour = "#dc2626";
    const third = await scan(3);
    const home3 = third.pages.find((p) => p.url === `${s.base}/`)!;
    assert.equal(home3.visual?.desktop?.status, "changed");
    assert.ok((home3.visual?.desktop?.changed ?? 0) > 5);
    assert.ok(home3.visual?.desktop?.diff);
    assert.ok(home3.visual?.desktop?.baseline);
    const shop3 = third.pages.find((p) => p.url === `${s.base}/shop`)!;
    assert.equal(shop3.visual?.desktop?.status, "same");
    const vf = third.findings.filter((f) => f.rule === "visual:changed");
    assert.equal(vf.length, 2, "desktop and phone of the home page");
    assert.ok(vf.every((f) => f.pageUrl === `${s.base}/`));
    assert.equal(baselineKey(`${s.base}/#x`, "desktop"), baselineKey(`${s.base}/`, "desktop"));
  });
});

describe("own checks folder", () => {
  it("loads a check from a file, prefixes its id and skips broken files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-own-"));
    try {
      await writeFile(
        path.join(dir, "a-whatsapp.mjs"),
        `export default { id: "whatsapp", name: "WhatsApp button", run: async ({ url }) => [{ rule: "no-wa", severity: "low", category: "functional", title: "No WhatsApp button", detail: "", pageUrl: url }] };`,
      );
      await writeFile(path.join(dir, "b-broken.mjs"), `export default { name: "No run" };`);
      const log: string[] = [];
      const loaded = await loadOwnChecks(dir, (m) => log.push(m));
      assert.deepEqual(loaded, ["own:whatsapp"]);
      assert.ok(log.some((l) => /skipped b-broken\.mjs/.test(l)));
      const agent = WEB_AGENTS.find((a) => a.id === "own:whatsapp")!;
      assert.ok(agent && "run" in agent);
      const found = await (agent as { run: (c: unknown) => Promise<{ rule: string; id: string }[]> }).run({ url: "https://x/" });
      assert.equal(found[0].rule, "own:no-wa");
      assert.ok(found[0].id);
    } finally {
      const i = WEB_AGENTS.findIndex((a) => a.id === "own:whatsapp");
      if (i >= 0) WEB_AGENTS.splice(i, 1);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("API: modules, journeys, approve", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dataDir = await mkdtemp(path.join(tmpdir(), "glv-inspect-api-"));
    ({ app, stores } = await createApp({ dataDir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("lists modules and saves the owner's switches", async () => {
    const meta = (await app.inject({ method: "GET", url: "/api/meta" })).json();
    assert.deepEqual(
      meta.modules.map((m: { id: string; on: boolean }) => [m.id, m.on]),
      [
        ["inspect", true],
        ["visual", true],
        ["journeys", true],
        ["own-checks", false],
      ],
    );
    const r = await app.inject({ method: "PATCH", url: "/api/owner/settings", payload: { modules: { visual: false, nope: true } } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().modules, { visual: false });
  });

  it("saves journeys on a website project and refuses bad steps", async () => {
    const now = new Date().toISOString();
    stores.projects.save({ id: "p1", key: "SHOP", name: "Shop", type: "website", target: { url: "https://example.com/" }, schedule: "off", createdAt: now, issueSeq: 0 });
    const ok = await app.inject({ method: "PATCH", url: "/api/projects/p1", payload: { journeys: [{ name: "Cart", steps: "open /\nclick Shop" }] } });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.json().journeys[0].name, "Cart");
    assert.ok(ok.json().journeys[0].id);
    const bad = await app.inject({ method: "PATCH", url: "/api/projects/p1", payload: { journeys: [{ name: "Cart", steps: "dance" }] } });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /Line 1/);
  });

  it("approves a run's picture as the new one", async () => {
    const runDir = path.join(dataDir, "artifacts", "r1");
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "page-0.jpg"), "new-picture");
    const now = new Date().toISOString();
    stores.runs.save({
      id: "r1",
      url: "https://example.com/",
      projectId: "p1",
      status: "done",
      createdAt: now,
      progress: [],
      result: {
        startUrl: "https://example.com/",
        startedAt: now,
        finishedAt: now,
        pages: [{ url: "https://example.com/", status: 200, title: "", loadMs: 1, screenshot: "page-0.jpg", visual: { desktop: { status: "changed", changed: 9 } } }],
        findings: [],
        scores: {},
        overallScore: 100,
      },
    });
    const r = await app.inject({ method: "POST", url: "/api/runs/r1/pages/0/approve", payload: { view: "desktop" } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().visual.desktop.status, "approved");
    const saved = await readFile(path.join(dataDir, "baselines", "p1", `${baselineKey("https://example.com/", "desktop")}.jpg`), "utf8");
    assert.equal(saved, "new-picture");
    assert.equal((await app.inject({ method: "POST", url: "/api/runs/r1/pages/0/approve", payload: { view: "tv" } })).statusCode, 400);
  });
});
