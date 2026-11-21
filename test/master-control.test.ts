import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  addressAllowed,
  BUILT_IN_PRESETS,
  cleanControl,
  CONTROL_FIELDS,
  controlAgents,
  describeControl,
  extraOn,
  mergeControl,
  RunGate,
  SECTIONS,
  verdictOf,
} from "../src/control.js";
import { scanSite } from "../src/runner/scan.js";
import { createApp } from "../src/server.js";
import type { Run } from "../src/types.js";
import { startDemoSite } from "./fixtures/demo-site.js";

describe("master control settings", () => {
  it("keeps numbers inside their limits and drops unknown settings", () => {
    const c = cleanControl({ maxPages: 99999, parallel: 0, cpuSlowdown: 1, network: "none", nonsense: 5, pageTimeout: "12", retries: -3 });
    assert.equal(c.maxPages, 1000);
    assert.equal(c.parallel, 1);
    assert.equal(c.cpuSlowdown, undefined, "1× is no slowdown");
    assert.equal(c.network, undefined, "full speed is the normal");
    assert.equal(c.pageTimeout, 12);
    assert.equal(c.retries, 0);
    assert.ok(!("nonsense" in c));
  });

  it("refuses headers that would change who the test is", () => {
    assert.throws(() => cleanControl({ headers: "Authorization: Bearer x" }), /saved login/);
    assert.throws(() => cleanControl({ headers: "Cookie: a=b" }), /saved login/);
    assert.throws(() => cleanControl({ headers: "Bad Name: x" }), /not a header name/);
    assert.deepEqual(cleanControl({ headers: "X-Test-Run: glv\nX-Bypass-WAF: 1" }).headers, { "X-Test-Run": "glv", "X-Bypass-WAF": "1" });
  });

  it("refuses extra pages that are not full addresses", () => {
    assert.throws(() => cleanControl({ extraUrls: "/about" }), /full address/);
    assert.deepEqual(cleanControl({ extraUrls: "https://a.com/x\nhttps://a.com/x" }).extraUrls, ["https://a.com/x"]);
  });

  it("merges the owner's, the project's and the test's settings, the test's last", () => {
    const m = mergeControl({ maxPages: 10, agents: { "web.seo": false }, gate: { minScore: 70 } }, { maxPages: 50, agents: { "web.links": false }, gate: { maxCritical: 0 } });
    assert.equal(m.maxPages, 50);
    assert.deepEqual(m.agents, { "web.seo": false, "web.links": false });
    assert.deepEqual(m.gate, { minScore: 70, maxCritical: 0 });
  });

  it("picks agents by kind and by switch, and leaves out link checks when asked", () => {
    const a11y = controlAgents("website", {}, { categories: ["accessibility"] });
    assert.ok(a11y.length > 0);
    assert.ok(a11y.every((id) => !id.includes("seo")));
    const noLinks = controlAgents("website", {}, { checkLinks: false });
    assert.ok(!noLinks.includes("web.links"));
    const owner = controlAgents("website", { "web.links": false }, {});
    assert.ok(!owner.includes("web.links"), "the owner's choice holds");
    const back = controlAgents("website", { "web.links": false }, { agents: { "web.links": true } });
    assert.ok(back.includes("web.links"), "the test can turn an agent back on");
  });

  it("can only turn extras off, never on when the owner has them off", () => {
    assert.equal(extraOn({ extras: { visual: true } }, "visual", false), false);
    assert.equal(extraOn({ extras: { visual: false } }, "visual", true), false);
    assert.equal(extraOn({}, "visual", true), true);
  });

  it("matches include and exclude lists by text or * pattern", () => {
    const c = { include: ["/shop/"], exclude: ["*?print=*"] };
    assert.ok(addressAllowed("https://a.com/shop/shoe", c));
    assert.ok(!addressAllowed("https://a.com/blog/x", c));
    assert.ok(!addressAllowed("https://a.com/shop/shoe?print=1", c));
  });

  it("says pass or fail by the rules", () => {
    assert.equal(verdictOf(undefined, { score: 10, critical: 9, high: 9, newIssues: 9 }), undefined);
    const v = verdictOf({ minScore: 80, maxCritical: 0, maxNew: 0 }, { score: 72, critical: 1, high: 3, newIssues: 2 })!;
    assert.equal(v.passed, false);
    assert.equal(v.reasons.length, 3);
    assert.equal(verdictOf({ minScore: 50 }, { score: 72, critical: 0, high: 0, newIssues: 0 })!.passed, true);
  });

  it("describes what was changed in words", () => {
    const lines = describeControl({ network: "fast3g", phone: { width: 360, height: 740 }, extras: { ai: false }, gate: { minScore: 80 } });
    assert.ok(lines.includes("Network: Fast 3G"));
    assert.ok(lines.includes("Phone size: 360 × 740"));
    assert.ok(lines.includes("Claude summary: off"));
    assert.ok(lines.includes("Fail below this score: 80"));
  });

  it("has a section for every field and valid built-in presets", () => {
    for (const f of CONTROL_FIELDS) assert.ok(SECTIONS.some((s) => s.id === f.section), f.id);
    for (const p of BUILT_IN_PRESETS) assert.deepEqual(cleanControl(p.control), p.control, p.id);
  });
});

describe("live switches", () => {
  it("pauses, resumes, and does not count paused time against the time limit", async () => {
    const gate = new RunGate({ maxMinutes: 1 });
    gate.pause("Lucky");
    assert.deepEqual(gate.state(), { paused: true, pausedBy: "Lucky", skipped: 0 });
    let through = false;
    const waiting = gate.wait().then(() => (through = true));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(through, false);
    gate.resume();
    await waiting;
    assert.equal(through, true);
    assert.equal(gate.finishing(), undefined);
  });

  it("stops waiting when the test is cancelled while paused", async () => {
    const gate = new RunGate();
    const stop = new AbortController();
    gate.pause();
    const waiting = gate.wait(stop.signal);
    stop.abort(new Error("Cancelled"));
    await assert.rejects(waiting, /Cancelled/);
  });

  it("skips one screen's page, or each open page once", () => {
    const gate = new RunGate();
    gate.skip(2);
    assert.equal(gate.takeSkip(1), false);
    assert.equal(gate.takeSkip(2), true);
    assert.equal(gate.takeSkip(2), false);
    gate.skip();
    assert.equal(gate.takeSkip(0), true);
    assert.equal(gate.takeSkip(0), false, "only the page that was open");
    assert.equal(gate.takeSkip(1), true);
    assert.equal(gate.state().skipped, 3);
  });

  it("finishes when asked, or when the time limit passes", () => {
    const gate = new RunGate();
    gate.pause();
    gate.finish("Finished early by Lucky");
    assert.equal(gate.isPaused(), false, "finishing also resumes");
    assert.equal(gate.finishing(), "Finished early by Lucky");
    const late = new RunGate({ maxMinutes: 1 });
    (late as unknown as { deadline: number }).deadline = Date.now() - 1;
    assert.match(late.finishing() ?? "", /time limit/);
  });
});

describe("master control on a real test of the demo site", () => {
  let server: Server;
  let dir: string;
  const port = 4231;
  const url = `http://127.0.0.1:${port}/`;

  before(async () => {
    server = await startDemoSite(port);
    dir = await mkdtemp(path.join(tmpdir(), "glv-control-"));
  });
  after(async () => {
    server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps to the depth limit, the exclude list and the extra pages, and leaves the phone pass out", async () => {
    const r = await scanSite({
      url,
      maxPages: 10,
      artifactsDir: path.join(dir, "a"),
      control: { maxDepth: 0, extraUrls: [`${url}about`], phoneOn: false, desktop: { width: 1280, height: 800 } },
    });
    const urls = r.pages.map((p) => new URL(p.url).pathname).sort();
    assert.deepEqual(urls, ["/", "/about"]);
    assert.ok(r.pages.every((p) => !p.mobileScreenshot), "no phone pictures");
    assert.ok(r.notes?.some((n) => /depth limit/.test(n)));
    assert.ok(r.notes?.some((n) => /phone pass was off/.test(n)));

    const ex = await scanSite({ url, maxPages: 10, artifactsDir: path.join(dir, "b"), control: { exclude: ["/about", "/contact"], phoneOn: false } });
    const paths = ex.pages.map((p) => new URL(p.url).pathname);
    assert.ok(!paths.includes("/about") && !paths.includes("/contact"), paths.join(","));
  });

  it("waits while paused and finishes early when asked", async () => {
    const gate = new RunGate();
    gate.pause("tester");
    const started = Date.now();
    const scan = scanSite({ url, maxPages: 10, artifactsDir: path.join(dir, "c"), parallel: 1, gate, control: { phoneOn: false } });
    // The first page runs (it finds the links), then the test waits at the next page.
    await new Promise((r) => setTimeout(r, 1500));
    gate.finish("Finished early by tester from master control");
    const r = await scan;
    assert.equal(r.pages.length, 1, "no new page after finishing");
    assert.ok(r.notes?.some((n) => n.startsWith("Finished early by tester")));
    assert.ok(Date.now() - started >= 1500);
  });
});

describe("master control routes", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  /** A project saved straight into the store, so no test starts by itself. */
  const project = (id: string, url: string) => {
    stores.projects.save({ id, key: id.toUpperCase(), name: id, type: "website", target: { url, maxPages: 1 }, schedule: "off", createdAt: new Date().toISOString(), issueSeq: 0, tools: [] });
    return id;
  };
  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as "GET", url, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-control-routes-"));
    ({ app, stores } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every setting and preset, saves presets and project defaults", async () => {
    const meta = await call("GET", "/api/control");
    assert.equal(meta.status, 200);
    assert.ok(meta.body.fields.length > 30);
    assert.ok(meta.body.presets.some((p: { id: string }) => p.id === "deep"));

    const saved = await call("POST", "/api/control/presets", { name: "Client X nightly", control: { maxPages: 40, network: "slow4g" } });
    assert.equal(saved.status, 201);
    assert.equal((await call("POST", "/api/control/presets", { name: "client x nightly" })).status, 409);
    assert.equal((await call("DELETE", "/api/control/presets/deep")).status, 400);
    assert.equal((await call("DELETE", `/api/control/presets/${saved.body.id}`)).status, 204);

    const id = project("p1", "https://example.com");
    const put = await call("PUT", `/api/projects/${id}/control`, { control: { maxPages: 3, colorScheme: "dark" } });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body.control, { maxPages: 3, colorScheme: "dark" });
    assert.equal((await call("PUT", `/api/projects/${id}/control`, { control: { headers: "Cookie: x=y" } })).status, 400);
  });

  it("never lets master control turn on a load or attack tool without the client's permission", async () => {
    const id = project("p2", "https://example.org");
    const r = await call("POST", `/api/projects/${id}/runs/controlled`, { control: { tools: [{ id: "k6" }] } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /permission/);
  });

  it("refuses live switches on a test that is not running", async () => {
    const id = project("p3", "http://127.0.0.1:9/");
    const run = (await call("POST", `/api/projects/${id}/runs/controlled`, { control: { maxPages: 1, extras: { ai: false } }, preset: "smoke" })).body as Run;
    assert.deepEqual(run.control, { maxPages: 1, extras: { ai: false } });
    assert.equal(run.controlBy?.preset, "Quick smoke test");
    await call("POST", `/api/runs/${run.id}/cancel`);
    const r = await call("POST", `/api/runs/${run.id}/control`, { action: "pause" });
    assert.equal(r.status, 409);
    assert.equal((await call("POST", `/api/runs/${run.id}/control`, { action: "explode" })).status, 400);
  });
});
