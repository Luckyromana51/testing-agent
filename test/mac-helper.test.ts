import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";
import { fixFor } from "../src/fixes.js";
import { cleanInfo, HelperHub, HelperStore, type Helper, type HelperInfo, type JobView } from "../src/helpers.js";
import { createApp } from "../src/server.js";
import { runTools } from "../src/tools/index.js";
import { compareSafari, iosRunFindings, parseIosRun, parseSafari, parseVoiceOver, voiceOverFindings, type SafariView } from "../src/tools/mac.js";
import type { Finding, ScanResult } from "../src/types.js";
import { fakeMac, SIM_IPHONE } from "./fixtures/fake-mac.ts";
import { simulatorAppZip } from "./fixtures/demo-ipa.ts";

process.env.DEFAULT_TOOLS = "none";

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "helper", "mac", "glv-helper.mjs");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ALL: HelperInfo = { version: "1.0.0", kinds: ["safari", "voiceover", "ios-app"] };
const quiet = () => {};

function result(findings: Finding[], pages: string[], scores: ScanResult["scores"]): ScanResult {
  return {
    startUrl: pages[0] ?? "",
    startedAt: "2026-11-18T00:00:00Z",
    finishedAt: "2026-11-18T00:00:01Z",
    pages: pages.map((url) => ({ url, status: 200, title: "x", loadMs: 10 })),
    findings,
    scores,
    overallScore: 100,
    agentStats: [],
  };
}

describe("what the Mac saw, turned into findings", () => {
  const view = (v: Partial<SafariView>): SafariView => ({ device: "mac", name: "Safari on Mac", url: "https://shop.example/", overflow: 0, counts: { links: 10, images: 4 }, broken: [], width: 1366, height: 900, ...v });
  const base = { overflow: 0, counts: { links: 10, images: 4 }, broken: [] };

  it("keeps only the Safari results that make sense", () => {
    const r = parseSafari({
      safari: "18.1",
      views: [
        { device: "mac", url: "https://a.example/", overflow: 3, counts: { links: 4 }, broken: ["https://a.example/x.avif", 7], width: 99999 },
        { device: "watch", url: "https://a.example/" },
        { device: "iphone", url: "javascript:alert(1)" },
      ],
      problems: [{ device: "ipad", error: "No iPad simulator" }, { device: "tv", error: "x" }],
    });
    assert.equal(r.safari, "18.1");
    assert.equal(r.views.length, 1);
    assert.deepEqual(r.views[0].broken, ["https://a.example/x.avif"]);
    assert.equal(r.views[0].width, 4000, "sizes are kept to what a screen can be");
    assert.equal(r.views[0].name, "Safari on Mac");
    assert.deepEqual(r.problems, [{ device: "ipad", error: "No iPad simulator" }]);
  });

  it("reports what only Safari gets wrong, and links Mac Safari to the cross-browser lab's WebKit finding", () => {
    assert.deepEqual(compareSafari(view({}), base), [], "the same as Chromium: nothing to report");
    const mac = compareSafari(view({ overflow: 80, counts: { links: 2, images: 4 }, broken: ["https://shop.example/hero.avif"] }), base);
    assert.deepEqual(mac.map((f) => f.rule), ["safari:sideways", "safari:missing-parts", "safari:images-fail"]);
    assert.ok(mac.every((f) => f.category === "functional" && f.sameScope === "page" && f.sameText === "Safari's engine (WebKit)"));
    assert.deepEqual(mac[1].sameAs, ["browser:missing-parts"]);
    assert.match(mac[1].evidence!, /links: 2 in Safari, 10 in Chromium/);
    const phone = compareSafari(view({ device: "iphone", name: "Safari on iPhone 16 (iOS 18.1)", overflow: 120, width: 393 }), base);
    assert.equal(phone[0].category, "mobile");
    assert.equal(phone[0].sameAs, undefined, "the lab has no iPhone Safari, so nothing to fold into");
    assert.match(phone[0].detail, /At 393 px wide the page is 120 px too wide/);
    assert.deepEqual(compareSafari(view({ error: "Load failed" }), { ...base, error: "net::ERR_NAME_NOT_RESOLVED" }), [], "it fails in Chromium too: not Safari's problem");
    assert.equal(compareSafari(view({ error: "Load failed" }), base)[0].rule, "safari:page-fails");
    assert.deepEqual(compareSafari(view({ counts: { links: 8, images: 4 } }), base), [], "two fewer links is noise, not missing parts");
  });

  it("hears what a blind visitor hears in VoiceOver", () => {
    const page = (phrases: string[], reachedEnd = true) => voiceOverFindings({ url: "https://shop.example/", phrases, reachedEnd });
    const rules = page([
      "GLV Shop, heading level 1",
      "image",
      "hero-banner-final.jpg, image",
      "button",
      "Read more, link",
      "Read more, link",
      "Read more, link",
      "link, https://shop.example/p/123",
      "edit text",
      "Search, search text field",
      "Add to cart, button",
    ]).map((f) => f.rule);
    assert.deepEqual(rules, ["voiceover:unnamed-image", "voiceover:file-names", "voiceover:unnamed-button", "voiceover:unnamed-link", "voiceover:unnamed-field", "voiceover:vague-links"]);
    const named = Array.from({ length: 30 }, (_, i) => `Product ${i}, link`);
    assert.deepEqual(page(named).map((f) => f.rule), ["voiceover:no-headings"]);
    assert.deepEqual(page(named, false), [], "headings may come after the limit, so no finding without the end of the page");
    assert.deepEqual(page(["Visited, Home, link", "Shop, heading level 2", "Read more, link", "Read more, link", "Close, button"]), []);
    const same = page(["image"])[0];
    assert.deepEqual([same.sameAs, same.sameScope, same.severity], [["axe:image-alt"], "page", "high"]);
  });

  it("reads the VoiceOver results without anything odd from the Mac", () => {
    const r = parseVoiceOver({ voiceover: "15.1", pages: [{ url: "https://a.example/", phrases: ["ok", 3, "a\u0007b"], reachedEnd: "yes", transcript: "voiceover-1.txt" }, { url: "file:///etc/passwd" }] });
    assert.equal(r.pages.length, 1);
    assert.deepEqual(r.pages[0].phrases, ["ok", "ab"]);
    assert.equal(r.pages[0].reachedEnd, false, "only true is true");
  });

  it("turns an iOS run into findings: install, crash on launch, crash during the audit, audit issues by type", () => {
    const where = "GLV Shop.app/GLVShop";
    const notInstalled = iosRunFindings(parseIosRun({ installed: false, installError: "Bad CPU type" }), where, "GLV Shop");
    assert.deepEqual(notInstalled.map((f) => [f.rule, f.severity, f.evidence]), [["ios-run:install-fails", "critical", "Bad CPU type"]]);
    const crash = iosRunFindings(
      parseIosRun({ installed: true, launched: true, stayedOpen: false, device: "iPhone 16, iOS 18.1", crash: { type: "EXC_BAD_ACCESS SIGSEGV", reason: "nil", frames: ["GLVShop  start"] } }),
      where,
      "GLV Shop",
    );
    assert.equal(crash.length, 1);
    assert.equal(crash[0].title, "The app closes within seconds of opening");
    assert.equal(crash[0].evidence, "EXC_BAD_ACCESS SIGSEGV: nil\nGLVShop  start");
    assert.match(crash[0].detail, /in the iOS Simulator \(iPhone 16, iOS 18\.1\)/);
    const audit = iosRunFindings(
      parseIosRun({
        installed: true,
        launched: true,
        stayedOpen: true,
        crashedDuringAudit: true,
        screens: [
          { name: "First screen", issues: [{ type: "contrast", description: "Low contrast" }, { type: "auditError", description: "Timed out" }] },
          { name: "Tab: Cart", issues: [{ type: "contrast", description: "Low contrast", element: '"Total"' }, { type: "newKind2027", description: "?" }] },
        ],
      }),
      where,
      "GLV Shop",
    );
    assert.deepEqual(audit.map((f) => [f.rule, f.severity]), [["ios-run:crash", "high"], ["ios-a11y:contrast", "medium"], ["ios-a11y:newKind2027", "low"]]);
    assert.equal(audit[1].evidence, 'First screen: Low contrast\nTab: Cart: Low contrast ("Total")');
    assert.equal(audit[1].title, "2 texts or controls have too little contrast");
  });

  it("has a written fix for every rule the Mac tools raise", () => {
    const rules = [
      ...["unnamed-image", "file-names", "unnamed-button", "unnamed-link", "unnamed-field", "vague-links", "no-headings"].map((r) => `voiceover:${r}`),
      ...["page-fails", "sideways", "missing-parts", "images-fail"].map((r) => `safari:${r}`),
      ...["install-fails", "crash-on-launch", "crash"].map((r) => `ios-run:${r}`),
      ...["sufficientElementDescription", "hitRegion", "contrast", "dynamicType", "textClipped", "trait", "elementDetection"].map((r) => `ios-a11y:${r}`),
    ];
    for (const rule of rules) assert.notEqual(fixFor({ rule, detail: "UNWRITTEN" }).steps, "UNWRITTEN", rule);
    assert.equal(fixFor({ rule: "voiceover:unnamed-button", detail: "" }), fixFor({ rule: "axe:button-name", detail: "" }), "the same fix as axe's finding it folds into");
    assert.deepEqual(fixFor({ rule: "ios-a11y:dynamicType", detail: "" }).code!.map((c) => c.label), ["SwiftUI", "UIKit"]);
  });

  it("checks what a Mac says about itself", () => {
    const info = cleanInfo({
      version: "1.0.0",
      macos: "15.1\u0000",
      kinds: ["safari", "rm -rf", "safari"],
      problems: { voiceover: "Allow AppleScript", other: "x" },
      simulators: [{ name: "iPhone 16", udid: SIM_IPHONE, runtime: "iOS 18.1", type: "iphone" }, { name: "x", udid: "../../etc", type: "iphone" }, { udid: SIM_IPHONE, type: "watch" }],
      devices: [{ name: "Test iPhone", udid: "00008110-000A1B2C3D4E801E", os: "18.1" }, { name: "x", udid: "a/b" }],
    });
    assert.deepEqual(info.kinds, ["safari"]);
    assert.equal(info.macos, "15.1");
    assert.deepEqual(info.problems, { voiceover: "Allow AppleScript" });
    assert.equal(info.simulators!.length, 1);
    assert.equal(info.devices!.length, 1);
    assert.equal(cleanInfo(null).version, "?");
  });
});

describe("the job queue between the server and its Macs", () => {
  let hub: HelperHub;
  let store: HelperStore;
  let mac: Helper;
  let out: string;
  const opts = (extra: Partial<Parameters<HelperHub["run"]>[2]> = {}) => ({ label: "Real Safari", outDir: out, signal: new AbortController().signal, log: quiet, ...extra });

  before(async () => {
    out = await mkdtemp(path.join(tmpdir(), "glv-hub-"));
    store = new HelperStore(new DatabaseSync(":memory:"));
    hub = new HelperHub();
    hub.attach(store);
  });
  after(async () => {
    hub.close();
    await rm(out, { recursive: true, force: true });
  });

  it("says why a test cannot run yet, with the step that fixes it", () => {
    assert.match(hub.status("safari")!, /No Mac helper is paired/);
    const { helper, token } = store.create("Lucky's MacBook", "Lucky");
    mac = helper;
    assert.match(token, /^glvh_[\w-]{32}$/);
    assert.equal(store.byToken(token)?.id, helper.id);
    assert.equal(store.byToken(`${token}x`), undefined);
    assert.equal(store.byToken("not-a-token"), undefined);
    assert.match(hub.status("safari")!, /"Lucky's MacBook" is not connected yet/);
    hub.hello(mac, { version: "1.0.0", kinds: ["safari"], problems: { "ios-app": "No iOS Simulator is installed." } });
    assert.equal(hub.status("safari"), null);
    assert.match(hub.status("ios-app")!, /cannot run this yet: No iOS Simulator is installed/);
    assert.match(hub.status("voiceover")!, /does not offer this test/);
    hub.hello(mac, ALL);
  });

  it("hands a job to a waiting Mac, takes its files and its result", async () => {
    const waiting = hub.next(mac, 5000);
    const job = hub.run("safari", { urls: ["https://a.example/"] }, opts());
    const view = (await waiting) as JobView;
    assert.equal(view.kind, "safari");
    assert.deepEqual(view.params, { urls: ["https://a.example/"] });
    assert.equal(hub.busy(mac)?.label, "Real Safari");
    assert.equal(hub.progress(mac, view.id, "Opening the page"), "ok");
    assert.equal(await hub.artifact(mac, view.id, "mac-1.png", PNG), "tool-safari-mac-1.png");
    await assert.rejects(hub.artifact(mac, view.id, "../../etc/passwd.png", PNG), /Bad file name/);
    await assert.rejects(hub.artifact(mac, view.id, "fake.png", Buffer.from("<html>")), /not a real \.png/);
    await assert.rejects(hub.artifact(mac, view.id, "log.json", Buffer.from("{nope")), /not a real \.json/);
    await assert.rejects(hub.artifact(mac, view.id, "empty.txt", Buffer.alloc(0)), /empty or too big/);
    const other = store.create("Other Mac", "Lucky").helper;
    assert.equal(hub.progress(other, view.id, "x"), "unknown", "another Mac cannot send for this job");
    assert.equal(hub.result(mac, view.id, { ok: true, data: { views: [] } }), "ok");
    const outcome = await job;
    assert.deepEqual(outcome, { data: { views: [] }, artifacts: [{ name: "mac-1.png", file: "tool-safari-mac-1.png" }] });
    assert.ok((await readFile(path.join(out, "tool-safari-mac-1.png"))).equals(PNG));
    assert.equal(hub.progress(mac, view.id, "late"), "over");
    assert.equal(hub.busy(mac), undefined);
    hub.remove(other.id);
  });

  it("gives one job at a time to each Mac, in order, and only the kinds it can do", async () => {
    const a = hub.run("voiceover", { n: 1 }, opts({ label: "A" }));
    const b = hub.run("voiceover", { n: 2 }, opts({ label: "B" }));
    assert.equal(hub.queued(), 2);
    const first = (await hub.next(mac, 0))!;
    assert.deepEqual(first.params, { n: 1 });
    assert.equal(await hub.next(mac, 0), null, "busy with A");
    hub.result(mac, first.id, { ok: false, error: "VoiceOver did not accept commands" });
    await assert.rejects(a, /The Mac helper could not run it: VoiceOver did not accept commands/);
    const second = (await hub.next(mac, 0))!;
    assert.deepEqual(second.params, { n: 2 });
    // The Mac had hung up when the job reached it: back in the queue, for the next ask.
    hub.requeue(second.id);
    assert.equal(hub.queued(), 1);
    const again = (await hub.next(mac, 0))!;
    assert.equal(again.id, second.id);
    hub.result(mac, again.id, { ok: true, data: 1 });
    assert.equal((await b).data, 1);
  });

  it("gives up on a job no Mac picked up, or one a Mac did not finish, and on a Mac that restarted", async () => {
    await assert.rejects(hub.run("safari", {}, opts({ queueMs: 30 })), /No Mac helper was free to start it within 0 minutes/);
    const slow = hub.run("safari", {}, opts({ runMs: 50 }));
    const job = (await hub.next(mac, 0))!;
    await assert.rejects(slow, /did not finish within 0 minutes/);
    assert.equal(hub.result(mac, job.id, { ok: true }), "over", "a late result is turned away");
    const lost = hub.run("safari", {}, opts());
    await hub.next(mac, 0);
    hub.hello(mac, ALL);
    await assert.rejects(lost, /restarted during the test/);
  });

  it("stops the Mac's work when the test is cancelled", async () => {
    const stop = new AbortController();
    const job = hub.run("ios-app", {}, opts({ signal: stop.signal }));
    const view = (await hub.next(mac, 0))!;
    stop.abort(new Error("Cancelled by Lucky"));
    await assert.rejects(job, /Cancelled by Lucky/);
    assert.equal(hub.progress(mac, view.id, "still going"), "over", "the helper learns it is over at its next message");
    await assert.rejects(hub.artifact(mac, view.id, "screen-1.png", PNG), /The test is over/);
  });

  it("lets a waiting Mac go when it hangs up, is removed, or the server stops", async () => {
    const gone = new AbortController();
    const waiting = hub.next(mac, 10_000, gone.signal);
    gone.abort();
    assert.equal(await waiting, null);
    const running = hub.run("safari", {}, opts());
    await hub.next(mac, 0);
    const second = store.create("Spare Mac", "Lucky").helper;
    hub.hello(second, ALL);
    const spare = hub.next(second, 10_000);
    hub.remove(mac.id);
    await assert.rejects(running, /removed from this server/);
    assert.equal(store.get(mac.id), undefined);
    hub.close();
    assert.equal(await spare, null);
  });
});

describe("helper sign-in and the owner's Mac helpers page", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-helper-api-"));
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("pairs a Mac, signs it in by its token only, and unpairs it", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/api/owner/helpers", payload: { name: " " } })).statusCode, 400);
    const made = await app.inject({ method: "POST", url: "/api/owner/helpers", payload: { name: "Lucky's MacBook" } });
    assert.equal(made.statusCode, 201);
    const { helper, token } = made.json();
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/ping" })).statusCode, 401, "no token");
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/ping", headers: { authorization: `Bearer ${token.slice(0, -2)}xx` } })).statusCode, 401);
    const hello = await app.inject({ method: "POST", url: "/api/helper/hello", headers: auth, payload: { ...ALL, macos: "15.1", xcode: "16.1" } });
    assert.deepEqual(hello.json(), { name: "Lucky's MacBook", wait: 25 });
    const list = (await app.inject({ method: "GET", url: "/api/owner/helpers" })).json();
    assert.equal(list.helpers.length, 1);
    assert.equal(list.helpers[0].online, true);
    assert.equal(list.helpers[0].info.xcode, "16.1");
    assert.ok(!JSON.stringify(list).includes(token), "the token is never shown again");
    const t0 = Date.now();
    const idle = await app.inject({ method: "GET", url: "/api/helper/jobs/next?wait=0", headers: auth });
    assert.equal(idle.statusCode, 204);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal((await app.inject({ method: "POST", url: `/api/helper/jobs/${randomUUID()}/result`, headers: auth, payload: { ok: true } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/helper/jobs/${randomUUID()}/file`, headers: auth })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/hello", headers: { ...auth, origin: "https://evil.example" }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: `/api/owner/helpers/${helper.id}` })).statusCode, 204);
    assert.equal((await app.inject({ method: "POST", url: "/api/helper/ping", headers: auth })).statusCode, 401, "an unpaired Mac is shut out");
  });

  it("serves the Mac helper and its Xcode project as one zip, without build folders", async () => {
    const extra = path.join(path.dirname(HELPER), "GLVRunner", "DerivedData");
    const made = !existsSync(extra);
    await mkdir(path.join(extra, "Build"), { recursive: true });
    await writeFile(path.join(extra, "Build", "junk.txt"), "x");
    try {
      const res = await app.inject({ method: "GET", url: "/api/owner/helpers/download" });
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers["content-type"], "application/zip");
      assert.match(String(res.headers["content-disposition"]), /glv-helper\.zip/);
      const files = Object.keys(unzipSync(new Uint8Array(res.rawPayload)));
      for (const f of [
        "glv-helper/glv-helper.mjs",
        "glv-helper/README.md",
        "glv-helper/GLVRunner/GLVRunner.xcodeproj/project.pbxproj",
        "glv-helper/GLVRunner/GLVRunner.xcodeproj/xcshareddata/xcschemes/GLVRunner.xcscheme",
        "glv-helper/GLVRunner/GLVRunnerUITests/AuditTests.swift",
        "glv-helper/GLVRunner/GLVRunnerHost/GLVRunnerHostApp.swift",
      ])
        assert.ok(files.includes(f), f);
      assert.ok(!files.some((f) => f.includes("DerivedData")), "build folders stay out");
    } finally {
      if (made) await rm(extra, { recursive: true, force: true });
    }
  });
});

describe("a stand-in Mac running the helper end to end", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let server: string;
  let site: Server;
  let siteUrl: string;
  let mac: { bin: string; state: string };
  let child: ChildProcess | undefined;
  let output = "";
  let token: string;
  const uploads = () => path.join(dir, "uploads");

  const env = (extra: Record<string, string> = {}) => {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${mac.bin}:${process.env.PATH}`,
      FAKE_MAC_STATE: mac.state,
      GLV_HELPER_ANY_OS: "1",
      GLV_HELPER_HOME: path.join(dir, "home"),
      GLV_HELPER_CRASH_DIR: path.join(dir, "crashes"),
      GLV_HELPER_STAY_OPEN_MS: "300",
      GLV_HELPER_SETTLE_MS: "0.01",
      ...extra,
    };
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "GLV_SERVER", "GLV_HELPER_TOKEN"]) if (!(k in extra)) delete e[k];
    return e;
  };
  const helper = (args: string[]) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, [HELPER, ...args], { env: env() });
      let out = "";
      c.stdout.on("data", (d) => (out += d));
      c.stderr.on("data", (d) => (out += d));
      c.on("close", (code) => resolve({ code, out }));
    });
  const calls = async () => readFile(path.join(mac.state, "calls.log"), "utf8").catch(() => "");
  const tools = (product: "website" | "ios", choice: { id: string; options?: Record<string, string> }, engine: ScanResult, target: Record<string, string>) =>
    runTools(engine, {
      product,
      target,
      choices: [choice],
      secrets: [],
      artifactsDir: path.join(dir, "artifacts"),
      uploadsDir: uploads(),
      workDir: dir,
      signal: new AbortController().signal,
      log: quiet,
    });

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-mac-"));
    mac = await fakeMac(dir);
    ({ app } = await createApp({ dataDir: dir }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    server = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // The client's site, for Chromium to compare with what "Safari" said.
    site = createServer((req, res) => {
      if (req.url?.endsWith(".png") || req.url?.endsWith(".avif")) {
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(PNG);
      }
      res.writeHead(200, { "content-type": "text/html" });
      const links = Array.from({ length: 10 }, (_, i) => `<a href="/p/${i}">Product ${i}</a>`).join(" ");
      res.end(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>GLV Shop</title></head><body><h1>GLV Shop</h1><img src="/logo.png" width="40" height="40" alt="GLV"><img src="/hero.avif" width="200" height="80" alt="Sale"><p>${links}</p><button>Buy</button></body></html>`,
      );
    }).listen(0, "127.0.0.1");
    await new Promise((r) => site.once("listening", r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  });
  after(async () => {
    child?.kill();
    delete process.env.AUTH_DISABLED;
    await app.close();
    site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("without a paired Mac, the Mac tests are not tested (never a free score)", async () => {
    const r = await tools("ios", { id: "mac-ios-sim" }, result([], [], { functional: 100, security: 100 }), { file: `${randomUUID()}.zip` });
    assert.equal(r.tools![0].status, "untested");
    assert.match(r.tools![0].untested!, /No Mac helper is paired with this server/);
    assert.match(r.notTested?.accessibility ?? "", /No Mac helper is paired/, "an iOS app's accessibility is not tested, not 100");
    assert.equal(r.scores.accessibility, undefined);
  });

  it("pairs the Mac and connects, saying what it can test", { timeout: 30_000 }, async () => {
    token = (await app.inject({ method: "POST", url: "/api/owner/helpers", payload: { name: "Stand-in Mac" } })).json().token;
    assert.match((await helper(["pair", "http://203.0.113.5:4000", token])).out, /https:\/\/ address/, "a token never crosses the internet in plain http");
    assert.match((await helper(["pair", server, "glvh_wrong-token-0000000000000000"])).out, /does not know this token/);
    const paired = await helper(["pair", server, token]);
    assert.equal(paired.code, 0, paired.out);
    const config = path.join(dir, "home", "config.json");
    assert.equal(JSON.parse(await readFile(config, "utf8")).token, token);
    assert.equal((await stat(config)).mode & 0o777, 0o600, "only the Mac's user can read the token");
    const check = await helper(["check"]);
    const info = JSON.parse(check.out);
    assert.deepEqual(info.kinds, ["safari", "voiceover", "ios-app"]);
    assert.deepEqual([info.macos, info.xcode, info.safari], ["15.1", "16.1", "18.1"]);
    assert.equal(info.simulators.length, 3, "iPhones and iPads, not the watch");

    child = spawn(process.execPath, [HELPER], { env: env() });
    child.stdout!.on("data", (d) => (output += d));
    child.stderr!.on("data", (d) => (output += d));
    for (let i = 0; i < 100; i++) {
      const h = (await app.inject({ method: "GET", url: "/api/owner/helpers" })).json().helpers[0];
      if (h?.online && h.info?.kinds.length === 3) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(`The helper did not connect:\n${output}`);
  });

  it("Safari: real Safari on Mac and iPhone next to Chromium, with screenshots, folded into the lab's WebKit finding", { timeout: 120_000 }, async () => {
    const lab: Finding = { id: "w", category: "functional", rule: "browser:missing-parts", severity: "medium", title: "Parts of the page are missing in Safari's engine (WebKit)", detail: "Fewer links.", pageUrl: siteUrl, agent: "web.browsers" };
    const r = await tools("website", { id: "mac-safari", options: { devices: "mac-iphone", pages: "1" } }, result([lab], [siteUrl], { functional: 100, mobile: 100, accessibility: 100 }), { url: siteUrl });
    const t = r.tools![0];
    assert.equal(t.status, "done", `${t.untested}\n${output}`);
    const rules = r.findings.filter((f) => f.agent === "tool.mac-safari").map((f) => `${f.rule} ${f.category}`);
    assert.deepEqual(rules.sort(), ["safari:images-fail functional", "safari:sideways mobile"]);
    assert.equal(t.merged, 1, "Mac Safari's missing parts are the lab's WebKit finding, shown once");
    assert.match(r.findings.find((f) => f.id === "w")!.detail, /Also found by Real Safari \(Mac helper\)\./);
    assert.match(r.findings.find((f) => f.rule === "safari:images-fail")!.evidence!, /hero\.avif/);
    assert.equal(t.tested, "1 page in Safari on Mac, Safari on iPhone 16 (iOS 18.1)");
    assert.deepEqual(t.summary, ["Safari 18.1"]);
    assert.deepEqual(t.images!.map((i) => i.label), ["Safari on Mac: /", "Safari on iPhone 16 (iOS 18.1): /"]);
    for (const im of t.images!) assert.ok((await readFile(path.join(dir, "artifacts", im.file))).equals(PNG));
    const log = await calls();
    assert.match(log, new RegExp(`xcrun simctl boot ${SIM_IPHONE}`), "the newest iPhone simulator, not the one already running iOS 16");
    assert.match(log, new RegExp(`xcrun simctl shutdown ${SIM_IPHONE}`), "and it is shut down again");
    assert.match(log, /webdriver POST \/session\/s1\/window\/rect/);
    assert.match(log, /webdriver DELETE \/session\/s2\n/);
  });

  it("Safari: explains how to allow automation when the Simulator refuses it", { timeout: 60_000 }, async () => {
    await writeFile(path.join(mac.state, "no-remote-automation"), "");
    try {
      const r = await tools("website", { id: "mac-safari", options: { devices: "mac-iphone", pages: "1" } }, result([], [siteUrl], { functional: 100, mobile: 100 }), { url: siteUrl });
      const t = r.tools![0];
      assert.equal(t.status, "done");
      assert.match(t.summary!.join("\n"), /Not tested on iPhone: Safari in the Simulator does not allow automation: in the Simulator open Settings > Safari > Advanced and turn on Remote Automation/);
    } finally {
      await rm(path.join(mac.state, "no-remote-automation"));
    }
  });

  it("VoiceOver: reads the page item by item to the end, and reports what it cannot name", { timeout: 60_000 }, async () => {
    const phrases = [
      "GLV Shop, heading level 1",
      "image",
      "hero-banner-final.jpg, image",
      "button",
      "Read more, link",
      "Read more, link",
      "Read more, link",
      "edit text",
      "Add to cart, button",
      "Add to cart, button",
      "© 2026 GLV Shop",
    ];
    await writeFile(path.join(mac.state, "vo-phrases.json"), JSON.stringify(phrases));
    const r = await tools("website", { id: "mac-voiceover" }, result([], ["https://shop.example/"], { accessibility: 100 }), { url: "https://shop.example/" });
    const t = r.tools![0];
    assert.equal(t.status, "done", `${t.untested}\n${output}`);
    assert.deepEqual(
      r.findings.map((f) => f.rule),
      ["voiceover:unnamed-image", "voiceover:file-names", "voiceover:unnamed-button", "voiceover:unnamed-field", "voiceover:vague-links"],
    );
    assert.deepEqual(t.summary, ["VoiceOver on macOS 15.1", "/: 11 items read to the end of the page"], "two buttons with the same name in a row are both kept");
    const transcript = await readFile(path.join(dir, "artifacts", t.reports![0].file), "utf8");
    assert.match(transcript, /What VoiceOver said on https:\/\/shop\.example\/\n\n {2}1\. GLV Shop, heading level 1\n {2}2\. image\n/);
    assert.match(transcript, /10\. Add to cart, button\n 11\. © 2026 GLV Shop\n$/);
    assert.match(await calls(), /open -a Safari https:\/\/shop\.example\//);
    assert.ok(!existsSync(path.join(mac.state, "vo-running")), "VoiceOver is turned off again, since the helper turned it on");
  });

  it("iOS: installs the app in the Simulator, runs Apple's audit on each tab, and cleans up", { timeout: 60_000 }, async () => {
    await mkdir(uploads(), { recursive: true });
    const file = `${randomUUID()}.zip`;
    await writeFile(path.join(uploads(), file), simulatorAppZip());
    await writeFile(path.join(mac.state, "calls.log"), "");
    const r = await tools("ios", { id: "mac-ios-sim" }, result([], [], { functional: 100, security: 100 }), { file, fileName: "GLV Shop.zip" });
    const t = r.tools![0];
    assert.equal(t.status, "done", `${t.untested}\n${output}`);
    assert.deepEqual(
      r.findings.map((f) => [f.rule, f.severity]),
      [["ios-a11y:sufficientElementDescription", "high"], ["ios-a11y:contrast", "medium"], ["ios-a11y:hitRegion", "medium"]],
    );
    assert.ok(r.scores.accessibility! < 100, "Apple's audit gives the iOS app an accessibility score");
    assert.equal(t.tested, "GLVShop in the iOS Simulator (iPhone 16, iOS 18.1)");
    assert.deepEqual(t.summary, [
      "Installed and opened without crashing",
      "Apple's accessibility audit on 2 screens: 4 issues",
      'The audit could not run on "Tab: Cart": Timed out while auditing',
    ]);
    assert.deepEqual(t.images!.map((i) => i.label), ["First screen", "Tab: Cart", "Dark mode", "Largest text size"]);
    const log = await calls();
    assert.match(log, /xcrun simctl install 11111111-2222-3333-4444-555555555555 \S+\/x\/GLV Shop\.app/);
    assert.match(log, /xcodebuild test -project \S+GLVRunner\.xcodeproj -scheme GLVRunner -destination platform=iOS Simulator,id=11111111/);
    assert.match(log, /TEST_RUNNER_GLV_BUNDLE_ID=in\.glvshop\.app/);
    assert.match(log, /simctl launch --terminate-running-process \S+ in\.glvshop\.app -UIPreferredContentSizeCategoryName UICTContentSizeCategoryAccessibilityXXXL/);
    const end = log.trim().split("\n").slice(-4).join("\n");
    assert.match(end, /simctl terminate[^\n]+\n[^\n]+simctl uninstall[^\n]+in\.glvshop\.app\n[^\n]+appearance light\n[^\n]+simctl shutdown 1111/, "the app is removed and the simulator put back as it was");
  });

  it("iOS: a crash on launch comes with the crash report's reason and code", { timeout: 60_000 }, async () => {
    const file = `${randomUUID()}.zip`;
    await writeFile(path.join(uploads(), file), simulatorAppZip());
    await writeFile(path.join(mac.state, "crash-next"), "");
    const r = await tools("ios", { id: "mac-ios-sim", options: { audit: "off" } }, result([], [], { functional: 100, security: 100 }), { file });
    const t = r.tools![0];
    assert.equal(t.status, "done", `${t.untested}\n${output}`);
    const crash = r.findings.find((f) => f.rule === "ios-run:crash-on-launch")!;
    assert.equal(crash.severity, "critical");
    assert.equal(crash.evidence, "EXC_CRASH SIGABRT: abort() called\nlibsystem_c.dylib  abort\nGLVShop  CheckoutViewModel.load()\nGLVShop  0x1000");
    assert.deepEqual(t.summary, ["Installed, but it did not stay open"]);
    assert.deepEqual(t.images!.map((i) => i.label), ["After opening"]);
    assert.ok(r.overallScore <= 69, "a crash on launch caps the grade");
  });

  it("iOS: never installs a build on a phone unless the Mac allowed it (devices on)", { timeout: 60_000 }, async () => {
    const { cleanIpa } = await import("./fixtures/demo-ipa.ts");
    const file = `${randomUUID()}.ipa`;
    await writeFile(path.join(uploads(), file), cleanIpa());
    await writeFile(path.join(mac.state, "calls.log"), "");
    const r = await tools("ios", { id: "mac-ios-sim" }, result([], [], { functional: 100, security: 100 }), { file });
    assert.equal(r.tools![0].status, "untested");
    assert.match(r.tools![0].untested!, /This is a build for real iPhones\. Upload a Simulator build .* node glv-helper\.mjs devices on/);
    assert.ok(!/devicectl device install/.test(await calls()), "nothing was installed on a phone");
  });

  it("refuses App Store copies, which only install from the App Store", async () => {
    const { appStoreIpa } = await import("./fixtures/demo-ipa.ts");
    const file = `${randomUUID()}.ipa`;
    await writeFile(path.join(uploads(), file), appStoreIpa());
    const r = await tools("ios", { id: "mac-ios-sim" }, result([], [], { functional: 100, security: 100 }), { file });
    assert.equal(r.tools![0].status, "untested");
    assert.match(r.tools![0].untested!, /App Store's encrypted copy|only installs through TestFlight/);
  });
});

describe("reading macOS crash reports", () => {
  it("takes the newest report for the app since the test started, from the exception backtrace", async () => {
    const { readCrash } = (await import(HELPER)) as { readCrash: (dir: string, exe: string, bundle: string, since: number) => Promise<{ type: string; reason?: string; frames: string[] } | undefined> };
    const dir = await mkdtemp(path.join(tmpdir(), "glv-crash-"));
    try {
      const write = async (name: string, head: object, body: object | string, ageMs = 0) => {
        const f = path.join(dir, name);
        await writeFile(f, `${JSON.stringify(head)}\n${typeof body === "string" ? body : JSON.stringify(body)}`);
        const t = new Date(Date.now() - ageMs);
        await utimes(f, t, t);
      };
      const since = Date.now() - 60_000;
      await write("GLVShop-old.ips", { bundleID: "in.glvshop.app" }, { exception: { type: "OLD" } }, 3_600_000);
      await write("GLVShop-other.ips", { bundleID: "com.other.app" }, { exception: { type: "OTHER" } });
      await write("GLVShop-broken.ips", { bundleID: "in.glvshop.app" }, "{not json", 1000);
      await write("OtherApp-1.ips", { bundleID: "in.glvshop.app" }, { exception: { type: "WRONG-NAME" } });
      await write(
        "GLVShop-2026.ips",
        { bundleID: "in.glvshop.app" },
        {
          exception: { type: "EXC_BAD_ACCESS", signal: "SIGSEGV" },
          termination: { indicator: "Namespace SIGNAL, Code 11 Segmentation fault: 11" },
          usedImages: [{ name: "GLVShop" }, { name: "UIKitCore" }],
          lastExceptionBacktrace: [{ imageIndex: 1, symbol: "-[UIViewController loadView]" }, { imageIndex: 0, imageOffset: 255 }],
          threads: [{ triggered: true, frames: [{ imageIndex: 0, symbol: "not this one" }] }],
        },
        5000,
      );
      assert.deepEqual(await readCrash(dir, "GLVShop", "in.glvshop.app", since), {
        type: "EXC_BAD_ACCESS SIGSEGV",
        reason: "Namespace SIGNAL, Code 11 Segmentation fault: 11",
        frames: ["UIKitCore  -[UIViewController loadView]", "GLVShop  0xff"],
      });
      assert.equal(await readCrash(dir, "GLVShop", "in.glvshop.app", Date.now() + 60_000), undefined, "nothing since the test started");
      assert.equal(await readCrash(path.join(dir, "missing"), "GLVShop", "in.glvshop.app", since), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
