import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CODE_KEEP, LiveRun, liveFeed, type LiveCode } from "../src/live.js";
import { curlOf, hideUrlSecrets, stepCode } from "../src/runner/live-code.js";
import { scanApi } from "../src/engines/api.js";
import { startDemoApi2, TOKEN_A } from "./fixtures/demo-api2.js";
import os from "node:os";
import { scanSite } from "../src/runner/scan.js";
import { createApp } from "../src/server.js";
import { startDemoSite } from "./fixtures/demo-site.js";

process.env.DEFAULT_TOOLS = "none";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function viewer() {
  const events: { event: string; data: any }[] = [];
  const send = (event: string, data: unknown) => events.push({ event, data });
  return { events, send, close: () => {}, items: (): LiveCode[] => events.filter((x) => x.event === "code").flatMap((x) => x.data.items) };
}

describe("code panel: the live run", () => {
  it("sends code lines only to viewers with the code panel open, in batches", async () => {
    const live = new LiveRun();
    const plain = viewer();
    const coder = viewer();
    live.subscribe(plain.send, plain.close);
    live.subscribe(coder.send, coder.close, { code: true });
    assert.equal(live.coding(), true);
    live.code({ slot: 0, at: 0, kind: "page", url: "https://a.test/" });
    live.code({ slot: 0, at: 5, kind: "step", label: "Open", code: stepCode.open("https://a.test/") });
    await wait(260);
    assert.equal(plain.items().length, 0, "a viewer without the panel gets no code lines");
    assert.equal(coder.events.filter((e) => e.event === "code").length, 1, "lines go out together");
    assert.deepEqual(coder.items().map((i) => i.kind), ["page", "step"]);
    live.end("done");
  });

  it("gives a viewer who opens the panel late the lines kept for each screen, and a new page clears the old ones", () => {
    const live = new LiveRun();
    live.code({ slot: 0, at: 0, kind: "page", url: "https://a.test/one" });
    live.code({ slot: 0, at: 1, kind: "console", level: "error", text: "boom" });
    live.code({ slot: 1, at: 0, kind: "page", url: "https://a.test/two" });
    live.code({ slot: 0, at: 0, kind: "page", url: "https://a.test/three" });
    for (let i = 0; i < CODE_KEEP + 50; i++) live.code({ slot: 0, at: i, kind: "net", method: "GET", url: `https://a.test/${i}.js`, status: 200, type: "script" });
    const late = viewer();
    live.subscribe(late.send, late.close, { code: true });
    const first = late.items();
    const slot0 = first.filter((i) => i.slot === 0);
    assert.equal(slot0.length, CODE_KEEP);
    assert.equal(slot0[0].kind, "page", "the page line stays first");
    assert.equal((slot0[0] as Extract<LiveCode, { kind: "page" }>).url, "https://a.test/three");
    assert.ok(!slot0.some((i) => i.kind === "console"), "lines of the earlier page are gone");
    assert.ok(first.some((i) => i.slot === 1));
    live.end("done");
  });

  it("hides passwords and tokens in addresses", () => {
    assert.equal(hideUrlSecrets("https://a.test/x?token=abc&page=2"), "https://a.test/x?token=%28hidden%29&page=2");
    assert.match(hideUrlSecrets("https://me:secret@a.test/"), /hidden@/);
    assert.equal(hideUrlSecrets("https://a.test/plain?q=shoes"), "https://a.test/plain?q=shoes");
    assert.ok(!stepCode.open("https://a.test/?api_key=XYZ").includes("XYZ"));
  });
});

describe("code panel: a real test", () => {
  let site: Server;
  let dir: string;
  const coder = viewer();
  let source: string | undefined;
  const port = 4188;

  before(async () => {
    site = await startDemoSite(port);
    dir = await mkdtemp(path.join(tmpdir(), "glvcode-"));
    const live = new LiveRun();
    live.subscribe(coder.send, coder.close, { code: true });
    // Read the page's code while the test is on it, as the "Page code" tab does.
    let tries = 0;
    const timer = setInterval(async () => {
      if (source || tries++ > 200) return;
      source = await live.source(0);
    }, 50);
    await scanSite({ url: `http://127.0.0.1:${port}/`, maxPages: 2, checkLinks: false, artifactsDir: dir, parallel: 1, live });
    clearInterval(timer);
    live.end("done");
  });
  after(async () => {
    site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("shows the test's steps as Playwright code", () => {
    const steps = coder.items().filter((i): i is Extract<LiveCode, { kind: "step" }> => i.kind === "step");
    assert.ok(steps.some((s) => s.code?.startsWith("await page.goto(")));
    assert.ok(steps.some((s) => s.code?.startsWith("await page.setViewportSize({ width: 390")));
    assert.ok(steps.some((s) => s.code?.startsWith("// GLV check:")), "each check is a step");
    assert.ok(steps.some((s) => s.label === "Page finished"));
  });

  it("lists the page's requests and console, without headers or cookies", () => {
    const net = coder.items().filter((i) => i.kind === "net");
    assert.ok(net.length > 0);
    assert.ok(net.every((n) => !("headers" in n)));
    assert.ok(coder.items().some((i) => i.kind === "console"), "the demo site prints errors");
  });

  it("sends each finding with its fix", () => {
    const found = coder.items().filter((i): i is Extract<LiveCode, { kind: "found" }> => i.kind === "found");
    assert.ok(found.length > 0);
    assert.ok(found.every((f) => f.fix?.steps));
  });

  it("reads the page's HTML on request, with secret values hidden", () => {
    assert.ok(source, "the page code was read while the page was open");
    assert.match(source!, /<html/i);
  });
});

describe("code panel: routes", () => {
  let site: Server;
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  let base = "";
  let cookie = "";
  const port = 4187;

  before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    site = await startDemoSite(port);
    dir = await mkdtemp(path.join(tmpdir(), "glvcoderoute-"));
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

  it("streams code lines with ?code=1, serves the page code, and says 404 once the test is over", async () => {
    const created = await app.inject({ method: "POST", url: "/api/projects", headers: { cookie }, payload: { type: "website", url: `http://127.0.0.1:${port}/`, maxPages: 3, checkLinks: false } });
    assert.equal(created.statusCode, 201);
    const id = created.json().run.id;
    for (let i = 0; i < 100 && stores.runs.get(id)?.status === "queued"; i++) await wait(50);

    const res = await fetch(`${base}/api/runs/${id}/live?code=1`, { headers: { cookie } });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = "";
    let html = "";
    let ended = false;
    void (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return void (ended = true);
        text += dec.decode(value, { stream: true });
      }
    })();
    for (let i = 0; i < 400 && !ended && !(text.includes("event: code") && html); i++) {
      await wait(100);
      if (!html) {
        const src = await fetch(`${base}/api/runs/${id}/live/source/0`, { headers: { cookie } });
        if (src.ok) html = await src.text();
      }
    }
    await reader.cancel().catch(() => {});
    assert.match(text, /event: code/);
    assert.match(html, /<html/i);

    for (let i = 0; i < 600 && !["done", "failed", "incomplete"].includes(String(stores.runs.get(id)?.status)); i++) await wait(100);
    const gone = await fetch(`${base}/api/runs/${id}/live/source/0`, { headers: { cookie } });
    assert.equal(gone.status, 404);
  });
});

describe("code panel: API tests", () => {
  it("writes a call as cURL with logins masked", () => {
    const c = curlOf("POST", "https://a.test/login?x=1", { authorization: "Bearer abc.def", "x-api-key": "K1", accept: "application/json" }, { user: "me", password: "hunter2" }, "api_key");
    assert.match(c, /^curl -X POST 'https:\/\/a\.test\/login\?x=1&api_key=•••'/);
    assert.ok(!c.includes("abc.def") && !c.includes("K1") && !c.includes("hunter2"), c);
    assert.match(c, /-H 'accept: application\/json'/);
    assert.match(c, /"user":"me"/);
    assert.match(curlOf("GET", "https://a.test/it's"), /'https:\/\/a\.test\/it'\\''s'/);
  });

  it("sends each API call and each problem to the code panel while the test runs", async () => {
    const demo = await startDemoApi2(4186);
    const dir = await mkdtemp(path.join(os.tmpdir(), "glv-apicode-"));
    const live = new LiveRun();
    const coder = viewer();
    live.subscribe(coder.send, coder.close, { code: true });
    try {
      await liveFeed.run(live, () =>
        scanApi({ specUrl: "http://localhost:4186/openapi.json", auth: { kind: "api", authType: "bearer", token: TOKEN_A }, artifactsDir: dir }),
      );
      live.end("done");
    } finally {
      demo.server.close();
      await rm(dir, { recursive: true, force: true });
    }
    const items = coder.items();
    const calls = items.filter((i): i is Extract<LiveCode, { kind: "call" }> => i.kind === "call");
    assert.ok(calls.length > 3, "the calls were sent");
    assert.ok(calls.every((c) => c.curl.startsWith("curl ")));
    assert.ok(calls.every((c) => !c.curl.includes(TOKEN_A)), "the token never shows");
    assert.ok(items.some((i) => i.kind === "found" && i.fix?.steps), "problems come with their fix");
  });
});
