import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { reusableSummary, summaryKey } from "../src/ai/triage.js";
import { LiveHub, LiveRun, type LiveScreen, type LiveSink } from "../src/live.js";
import { parallelPages, scanSite } from "../src/runner/scan.js";
import { createApp } from "../src/server.js";
import type { Finding, Run, ScanResult } from "../src/types.js";
import { startDemoSite } from "./fixtures/demo-site.js";

// The outside tools have their own tests (tools.test.ts); here tests run only the platform's checks.
process.env.DEFAULT_TOOLS = "none";
// The summary route is tested with Claude off: no credits are used by the tests.
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collects what a viewer of a live run receives. */
function viewer() {
  const events: { event: string; data: any }[] = [];
  let closed = false;
  const send = (event: string, data: unknown) => events.push({ event, data });
  return { events, send, close: () => (closed = true), closed: () => closed, of: (e: string) => events.filter((x) => x.event === e).map((x) => x.data) };
}

describe("live view of a running test", () => {
  it("sends nothing heavy until someone watches, then the current state at once", () => {
    const live = new LiveRun();
    live.setScreens(2);
    live.screen({ slot: 0, url: "https://a.com/", doing: "Checking", agents: ["SEO"], state: "busy" });
    live.frame(0, "AAAA", 960, 600);
    const v = viewer();
    const off = live.subscribe(v.send, v.close);
    assert.deepEqual(v.of("screens"), [{ count: 2 }]);
    const early = viewer();
    new LiveRun().subscribe(early.send, early.close);
    assert.deepEqual(early.events, [], "nothing to show before the browser starts");
    assert.equal(v.of("screen")[0].doing, "Checking");
    assert.deepEqual(v.of("frame"), [], "a picture made while nobody watched was never kept");
    off();
  });

  it("tells the browser when the first viewer comes and the last one goes", () => {
    const live = new LiveRun();
    const seen: boolean[] = [];
    live.onWatchers((w) => seen.push(w));
    const a = viewer();
    const b = viewer();
    const offA = live.subscribe(a.send, a.close);
    const offB = live.subscribe(b.send, b.close);
    assert.equal(live.watching(), true);
    offA();
    assert.deepEqual(seen, [true], "one viewer is still watching");
    offB();
    assert.deepEqual(seen, [true, false]);
    assert.equal(live.watching(), false);
  });

  it("sends only the newest picture of a screen, at most every 200 ms", async () => {
    const live = new LiveRun();
    const v = viewer();
    const off = live.subscribe(v.send, v.close);
    live.frame(1, "first", 960, 600);
    live.frame(1, "second", 960, 600);
    live.frame(1, "third", 960, 600);
    live.screen({ slot: 1, doing: "Opening the page", state: "busy" });
    live.screen({ slot: 1, doing: "Checking", agents: ["Speed"], state: "busy" });
    await wait(260);
    assert.deepEqual(
      v.of("frame").map((f) => f.img),
      ["third"],
    );
    const screens = v.of("screen");
    assert.equal(screens.length, 1);
    assert.equal(screens[0].doing, "Checking");
    off();
  });

  it("ends every viewer when the test ends, and tells late viewers it has ended", () => {
    const hub = new LiveHub();
    const live = hub.open("r1");
    const v = viewer();
    live.subscribe(v.send, v.close);
    live.log("Testing page 1");
    hub.close("r1", "done");
    assert.deepEqual(v.of("log"), [{ line: "Testing page 1" }]);
    assert.deepEqual(v.of("end"), [{ status: "done" }]);
    assert.ok(v.closed());
    assert.equal(hub.get("r1"), undefined);
    assert.equal(hub.endedAs("r1"), "done");
    const late = viewer();
    live.subscribe(late.send, late.close);
    assert.deepEqual(late.of("end"), [{ status: "done" }]);
    assert.ok(late.closed());
  });

  it("reads the pages-at-once setting within its limits", () => {
    assert.equal(parallelPages(1), 1);
    assert.equal(parallelPages(0), 1);
    assert.equal(parallelPages(500), 16);
    assert.equal(parallelPages(6.6), 7);
    delete process.env.PARALLEL_PAGES;
    assert.equal(parallelPages(), 4);
    process.env.PARALLEL_PAGES = "8";
    assert.equal(parallelPages(), 8);
    assert.equal(parallelPages(2), 2, "the owner panel's choice comes first");
    delete process.env.PARALLEL_PAGES;
  });
});

describe("several pages at the same time", () => {
  const servers: Server[] = [];
  let dir: string;
  let one: ScanResult;
  let many: ScanResult;
  let few: ScanResult;
  const watched = viewer();
  /** What the browser reported to a live view nobody watched. */
  const unwatched = { screens: 0, frames: 0, states: [] as LiveScreen[] };

  before(async () => {
    const ports = [4195, 4194, 4193];
    for (const p of ports) servers.push(await startDemoSite(p));
    dir = await mkdtemp(path.join(tmpdir(), "glvparallel-"));
    const quiet: LiveSink = {
      watching: () => false,
      onWatchers: () => () => {},
      setScreens: (n) => (unwatched.screens = n),
      screen: (s) => unwatched.states.push(s),
      frame: () => unwatched.frames++,
    };
    // Each test gets its own copy of the demo site, whose pages fail once and then recover.
    one = await scanSite({ url: `http://127.0.0.1:${ports[0]}/`, maxPages: 10, artifactsDir: path.join(dir, "1"), parallel: 1, live: quiet });
    const live = new LiveRun();
    live.subscribe(watched.send, watched.close);
    many = await scanSite({ url: `http://127.0.0.1:${ports[1]}/`, maxPages: 10, artifactsDir: path.join(dir, "4"), parallel: 4, live });
    live.end("done");
    few = await scanSite({ url: `http://127.0.0.1:${ports[2]}/`, maxPages: 3, checkLinks: false, artifactsDir: path.join(dir, "3"), parallel: 4 });
  });
  after(async () => {
    for (const s of servers) s.close();
    await rm(dir, { recursive: true, force: true });
  });

  const pathOf = (u: string) => {
    try {
      return new URL(u).pathname;
    } catch {
      return u;
    }
  };
  const problems = (r: ScanResult) => r.findings.map((f: Finding) => `${f.rule} ${pathOf(f.pageUrl)}`).sort();

  it("finds the same pages and the same problems as one page at a time", () => {
    assert.deepEqual(many.pages.map((p) => pathOf(p.url)).sort(), one.pages.map((p) => pathOf(p.url)).sort());
    assert.deepEqual(problems(many), problems(one));
    assert.equal(many.overallScore, one.overallScore);
  });

  it("lists pages in the order they were found, starting with the first page", () => {
    assert.equal(pathOf(many.pages[0].url), "/");
    assert.equal(new Set(many.pages.map((p) => p.url)).size, many.pages.length, "no page is listed twice");
  });

  it("keeps to the page limit", () => {
    assert.equal(few.pages.length, 3);
  });

  it("shows each screen live to a viewer: pictures, the page, desktop and phone, and the agents checking it", () => {
    assert.deepEqual(watched.of("screens"), [{ count: 4 }]);
    const frames = watched.of("frame");
    assert.ok(frames.length > 0, "pictures were sent");
    assert.ok(frames.every((f) => Buffer.from(f.img, "base64").subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))), "pictures are JPEGs");
    assert.ok(new Set(frames.map((f) => f.slot)).size >= 2, "more than one screen sent pictures");
    const states: LiveScreen[] = watched.of("screen");
    assert.ok(states.some((s) => s.agents && s.agents.length >= 2), "agents check a page together");
    assert.ok(states.some((s) => s.view === "phone"));
    assert.ok(states.some((s) => s.url?.startsWith("http://127.0.0.1:4194/")));
    assert.deepEqual(watched.of("end"), [{ status: "done" }]);
  });

  it("makes no pictures when nobody watches, but still says what each screen does", () => {
    assert.equal(unwatched.screens, 1);
    assert.equal(unwatched.frames, 0);
    assert.ok(unwatched.states.some((s) => s.doing === "Checking"));
    assert.equal(unwatched.states.at(-1)?.state, "done");
  });
});

describe("Claude summary credits", () => {
  const result = (rules: string[], tools: ScanResult["tools"] = []): ScanResult => ({
    startUrl: "https://a.com/",
    startedAt: "",
    finishedAt: "",
    pages: [{ url: "https://a.com/", status: 200, title: "", loadMs: 1 }],
    findings: rules.map((rule, n) => ({
      id: `f${n}`,
      category: "seo",
      severity: rule.startsWith("info") ? "info" : "high",
      title: rule,
      detail: "",
      pageUrl: "https://a.com/",
      rule,
    })),
    scores: { functional: 100, accessibility: 100, seo: 100, security: 100, performance: 100, mobile: 100 },
    overallScore: 90,
    tools,
  });
  const run = (id: string, ai?: Run["ai"]): Run => ({ id, url: "https://a.com/", status: "done", createdAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:05:00Z", progress: [], ai });

  it("gives the same key for the same issues, and a new one when an issue, a tool or a severity changes", () => {
    const base = summaryKey(result(["a", "b"]));
    assert.equal(summaryKey(result(["b", "a"])), base, "order does not matter");
    assert.equal(summaryKey(result(["a", "b", "info-x"])), base, "information-only findings do not change the summary");
    assert.notEqual(summaryKey(result(["a"])), base);
    assert.notEqual(summaryKey(result(["a", "b", "c"])), base);
    assert.notEqual(summaryKey(result(["a", "b"], [{ id: "lighthouse", name: "Lighthouse", status: "failed", findings: 0 } as never])), base);
  });

  it("reuses only the last summary, and only when it was written from the same issues", () => {
    const key = summaryKey(result(["a", "b"]));
    const ai = { summary: "Two problems", topFixes: [], model: "m", key };
    assert.equal(reusableSummary([run("r2"), run("r1", ai)], key)?.run.id, "r1", "a run without a summary is skipped");
    assert.equal(reusableSummary([run("r2", { ...ai, key: "other" }), run("r1", ai)], key), undefined, "the last summary was about other issues");
    assert.equal(reusableSummary([run("r1", { ...ai, key: undefined })], key), undefined, "summaries from before keys existed are written again");
  });
});

describe("live view and summary routes", () => {
  let site: Server;
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  let base = "";
  let cookie = "";
  const port = 4192;
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  /** Reads server-sent events until `stop` says so, or the stream ends. */
  const stream = async (url: string, stop: (events: { event: string; data: any }[]) => boolean) => {
    const res = await fetch(base + url, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const events: { event: string; data: any }[] = [];
    const reader = res.body!.getReader();
    const text = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += text.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
      if (stop(events)) {
        await reader.cancel();
        break;
      }
    }
    return events;
  };

  before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    site = await startDemoSite(port);
    dir = await mkdtemp(path.join(tmpdir(), "glvlive-"));
    ({ app, stores } = await createApp({ dataDir: dir }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const res = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "owner@glv.test", name: "Lucky", password: "a-long-password" } });
    cookie = String(res.headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await app.close();
    site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("streams a running website test's screens and pictures, and says when it has ended", async () => {
    assert.equal((await call("PATCH", "/api/owner/settings", { parallelPages: 3 })).body.parallelPages, 3);
    assert.equal((await call("GET", "/api/meta")).body.maxParallel, 16);
    const created = await call("POST", "/api/projects", { type: "website", url: `http://127.0.0.1:${port}/`, maxPages: 6, checkLinks: false });
    assert.equal(created.status, 201);
    const id = created.body.run.id;
    for (let i = 0; i < 100 && stores.runs.get(id)?.status === "queued"; i++) await wait(50);

    const events = await stream(`/api/runs/${id}/live`, (e) => e.some((x) => x.event === "frame") || e.some((x) => x.event === "end"));
    assert.deepEqual(events.find((e) => e.event === "screens")?.data, { count: 3 });
    assert.ok(events.some((e) => e.event === "log"), "the progress log comes too");
    const frame = events.find((e) => e.event === "frame");
    assert.ok(frame, `a picture arrived: ${events.map((e) => e.event).join(", ")}`);
    assert.ok(frame.data.img.startsWith("/9j/"), "a JPEG");

    for (let i = 0; i < 240 && ["queued", "running"].includes(stores.runs.get(id)!.status); i++) await wait(500);
    assert.equal(stores.runs.get(id)!.status, "done");
    const ended = await stream(`/api/runs/${id}/live`, () => false);
    assert.deepEqual(ended, [{ event: "end", data: { status: "done" } }]);
    assert.equal((await fetch(`${base}/api/runs/${id}/live`)).status, 401, "only signed-in people can watch");
  });

  it("writes a summary on request only when Claude is on, and reuses one for the same issues", async () => {
    const [done] = stores.runs.list(1);
    assert.ok(done.result && !done.ai);
    const off = await call("POST", `/api/runs/${done.id}/summary`);
    assert.equal(off.status, 409);
    assert.match(off.body.error, /ANTHROPIC_API_KEY/);
    assert.equal((await call("POST", "/api/runs/nope/summary")).status, 404);

    // A test of the same project with the same issues already has a summary: it is reused, for no credits.
    const earlier: Run = {
      ...done,
      id: "earlier-run",
      createdAt: "2026-11-01T00:00:00Z",
      finishedAt: "2026-11-01T00:05:00Z",
      ai: { summary: "Same problems as before", topFixes: [], model: "m", key: summaryKey(done.result), tokens: { input: 900, output: 300 } },
    };
    stores.runs.save(earlier);
    const reused = await call("POST", `/api/runs/${done.id}/summary`);
    assert.equal(reused.status, 200);
    assert.equal(reused.body.ai.summary, "Same problems as before");
    assert.deepEqual(reused.body.ai.reusedFrom, { runId: "earlier-run", at: "2026-11-01T00:05:00Z" });
    assert.equal(reused.body.ai.tokens, undefined, "no tokens were used for this one");
  });
});
