/*
 * The test phone (Appium) tool, against the stand-in phone in fixtures/fake-appium.ts: what it
 * finds, what it never taps, that it puts the phone's settings back, and that it repeats.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

process.env.APP_TEST_PACE = "0.15";
process.env.APP_PROXY_PORT = "0";

const { appiumTool, deviceFindings } = await import("../src/tools/appium.ts");
const { setDevices, cleanDevice, shareApp, sharedApp, appLocation } = await import("../src/mobile/devices.ts");
const { parseJourney, cleanAppJourneys } = await import("../src/mobile/journeys.ts");
const { parseLogcat } = await import("../src/mobile/runner.ts");
const { localAddress } = await import("../src/mobile/proxy.ts");
const { MOBILE_FIXES } = await import("../src/fixes-mobile.ts");
const { startFakeAppium } = await import("./fixtures/fake-appium.ts");
import type { ToolContext, ToolOutput } from "../src/tools/types.ts";
import type { AppSummary } from "../src/types.ts";

const UUID = "0b7c2a9e-1f2d-4c3b-9a8e-123456789abc";

function summary(platform: "android" | "ios", id: string): AppSummary {
  return { platform, id, name: "Demo Shop", version: "1.0", packaging: platform === "android" ? "apk" : "ipa", size: 1000, permissions: [], sdks: [], libraries: [], servers: [], languages: [], links: [], biggest: [] } as unknown as AppSummary;
}

async function runTool(dir: string, platform: "android" | "ios", extra: Partial<ToolContext> = {}, options: Record<string, string> = {}): Promise<ToolOutput> {
  const outDir = await mkdtemp(path.join(dir, "out-"));
  const file = `${UUID}.${platform === "android" ? "apk" : "ipa"}`;
  await writeFile(path.join(dir, file), "app");
  const logs: string[] = [];
  return appiumTool.run({
    product: platform,
    target: { file, fileName: platform === "android" ? "shop.apk" : "shop.ipa" },
    startUrl: "",
    urls: [],
    uploadsDir: dir,
    options: { device: "auto", screens: "20", minutes: "5", passes: "on", monkey: "40", traffic: "on", ...options },
    outDir,
    workDir: outDir,
    signal: new AbortController().signal,
    log: (m) => logs.push(m),
    app: summary(platform, platform === "android" ? "in.glv.demoshop" : "in.glv.demoshop"),
    ...extra,
  } as ToolContext);
}

const ruleSet = (o: ToolOutput) => new Set(o.findings.map((f) => f.rule));

describe("test phone: Android run on the stand-in phone", () => {
  let dir: string;
  let phone: Awaited<ReturnType<typeof startFakeAppium>>;
  let first: ToolOutput;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-device-"));
    phone = await startFakeAppium({ shell: true });
    setDevices([{ id: "dev_fake", name: "Fake Pixel", platform: "android", appiumUrl: phone.url, kind: "emulator", serverAddress: "http://127.0.0.1:4000" }]);
    first = await runTool(dir, "android", {
      login: { kind: "app", username: "test@glv.in", password: "s3cret" },
      appJourneys: [
        { id: "j1", name: "Find shoes", steps: 'tap "Products"\ntap "Shoes"\nsee "Running shoes"' },
        { id: "j2", name: "Broken", steps: 'tap "Products"\nsee "Free delivery"' },
      ],
    });
  });
  after(async () => {
    setDevices([]);
    await phone.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds every planted problem", () => {
    const got = ruleSet(first);
    for (const r of [
      "device:crash",
      "device:unlabeled",
      "device:small-target",
      "device:low-contrast",
      "device:field-label",
      "device:large-text-cut-off",
      "device:dark-mode-low-contrast",
      "device:offline-blank",
      "device:slow-start",
      "device:memory",
      "device:jank",
      "device:plain-http",
      "device:tracking-before-consent",
      "device:journey-failed",
    ]) {
      assert.ok(got.has(r), `${r} missing; got ${[...got].join(", ")}`);
    }
  });

  it("every problem has a fix", () => {
    for (const r of ruleSet(first)) assert.ok(MOBILE_FIXES[r], `no fix for ${r}`);
  });

  it("catches the crash when the phone is turned sideways", () => {
    const crashes = first.findings.filter((f) => f.rule === "device:crash");
    assert.ok(crashes.some((f) => /sideways|landscape|rotat/i.test(`${f.title} ${f.detail}`)), crashes.map((f) => f.title).join(" | "));
    assert.ok(crashes.some((f) => /NullPointerException/.test(`${f.title}\n${f.evidence ?? ""}`)));
  });

  it("never taps Buy, Delete account or Log out", () => {
    for (const t of phone.taps) assert.doesNotMatch(t, /buy now|delete account|log out/i, `tapped ${t}`);
  });

  it("signs in with the saved app login", () => {
    assert.ok(phone.taps.some((t) => /log in|sign in/i.test(t)), phone.taps.join(", "));
  });

  it("runs app journeys, and a journey that passes is not reported", () => {
    const failed = first.findings.filter((f) => f.rule === "device:journey-failed");
    assert.equal(failed.length, 1);
    assert.match(failed[0].title, /Broken/);
  });

  it("puts the phone's settings back", () => {
    const sh = phone.shell.join("\n");
    assert.match(sh, /font_scale 1\.5/);
    assert.match(sh, /font_scale 1(\.0)?(\s|$)/m);
    assert.match(sh, /wm size reset|size reset/);
    assert.match(sh, /svc (wifi|data) enable/);
    assert.match(sh, /http_proxy :0|delete global http_proxy/);
  });

  it("gives the same problems on a second run", async () => {
    // A fresh phone, as after a reinstall: the stand-in remembers the sign-in otherwise.
    const again = await startFakeAppium({ shell: true });
    setDevices([{ id: "dev_fake2", name: "Fake Pixel 2", platform: "android", appiumUrl: again.url, kind: "emulator", serverAddress: "http://127.0.0.1:4000" }]);
    const second = await runTool(dir, "android", {
      login: { kind: "app", username: "test@glv.in", password: "s3cret" },
      appJourneys: [
        { id: "j1", name: "Find shoes", steps: 'tap "Products"\ntap "Shoes"\nsee "Running shoes"' },
        { id: "j2", name: "Broken", steps: 'tap "Products"\nsee "Free delivery"' },
      ],
    });
    await again.close();
    assert.deepEqual([...ruleSet(second)].sort(), [...ruleSet(first)].sort());
    assert.deepEqual(again.taps, phone.taps);
  });
});

describe("test phone: without adb shell, and on iOS", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-device2-"));
  });
  after(async () => {
    setDevices([]);
    await rm(dir, { recursive: true, force: true });
  });

  it("still finds crashes and screen problems when Appium refuses adb shell", async () => {
    const phone = await startFakeAppium({ shell: false });
    try {
      setDevices([{ id: "dev_noshell", name: "Locked Pixel", platform: "android", appiumUrl: phone.url, kind: "phone" }]);
      const out = await runTool(dir, "android", {}, { monkey: "0", traffic: "off" });
      const got = ruleSet(out);
      assert.ok(got.has("device:crash"));
      assert.ok(got.has("device:unlabeled"));
      assert.ok(!got.has("device:slow-start"));
      assert.ok(!got.has("device:plain-http"));
      assert.match([out.summary ?? ""].flat().join("\n"), /needs adb shell/);
    } finally {
      await phone.close();
    }
  });

  it("tests an iPhone app through XCUITest", async () => {
    const phone = await startFakeAppium({ platform: "ios" });
    try {
      setDevices([{ id: "dev_sim", name: "iPhone 16 Simulator", platform: "ios", appiumUrl: phone.url, kind: "simulator" }]);
      const out = await runTool(dir, "ios", {}, { monkey: "0" });
      const got = ruleSet(out);
      assert.ok(got.has("device:crash"), [...got].join(", "));
      assert.ok(got.has("device:unlabeled"));
      assert.ok(got.has("device:small-target"));
    } finally {
      await phone.close();
    }
  });

  it("says why when no phone is set up or answering", async () => {
    setDevices([]);
    const old = process.env.APPIUM_URL;
    delete process.env.APPIUM_URL;
    try {
      assert.match((await appiumTool.ready()) ?? "", /No test phone is set up/);
      setDevices([{ id: "dev_gone", name: "Gone phone", platform: "android", appiumUrl: "http://127.0.0.1:9", kind: "phone" }]);
      assert.match((await appiumTool.ready()) ?? "", /No test phone is answering \(Gone phone\)/);
      await assert.rejects(runTool(dir, "android"), /not ready|No test phone is ready/);
      await assert.rejects(runTool(dir, "ios"), /test phone|iOS/i);
    } finally {
      if (old !== undefined) process.env.APPIUM_URL = old;
    }
  });

  it("refuses an .xapk and a project without an uploaded app", async () => {
    const base = { product: "android", startUrl: "", urls: [], uploadsDir: dir, options: {}, outDir: dir, workDir: dir, signal: new AbortController().signal, log: () => {}, app: summary("android", "a.b") };
    await assert.rejects(appiumTool.run({ ...base, target: {} } as unknown as ToolContext), /no uploaded app/);
    await assert.rejects(appiumTool.run({ ...base, target: { file: `${UUID}.xapk` } } as unknown as ToolContext), /xapk/);
  });
});

describe("test phone: pieces", () => {
  it("reads app journeys and points at the line it does not understand", () => {
    const steps = parseJourney('# note\ntap "Sign in"\ntap id:login_button\ntype "Email" {{username}}\nsee "Hi"\nnot see "Error"\nback\nswipe up\nwait 2\nrotate\nrelaunch');
    assert.deepEqual(
      steps.map((s) => s.kind),
      ["tap", "tap", "type", "see", "not-see", "back", "swipe", "wait", "rotate", "relaunch"],
    );
    assert.throws(() => parseJourney('tap "A"\njump over'), /line 2/i);
    assert.throws(() => cleanAppJourneys([{ name: "", steps: "back" }]), /needs a name/);
    assert.throws(() => cleanAppJourneys([{ name: "Bad", steps: "fly" }]), /Bad:/);
    assert.equal(cleanAppJourneys([{ name: "Ok", steps: "back", off: true }])[0].off, true);
  });

  it("checks the devices the owner types in", () => {
    assert.throws(() => cleanDevice({ name: "", platform: "android", appiumUrl: "http://a:4723" }), /name/);
    assert.throws(() => cleanDevice({ name: "x", platform: "windows", appiumUrl: "http://a:4723" }), /Android or iOS/);
    assert.throws(() => cleanDevice({ name: "x", platform: "android", appiumUrl: "file:///etc" }), /http/);
    const d = cleanDevice({ name: "Pixel", platform: "android", appiumUrl: "http://192.168.1.20:4723/", udid: "abc;rm -rf", serverAddress: "http://192.168.1.10:4000" });
    assert.equal(d.appiumUrl, "http://192.168.1.20:4723");
    assert.equal(d.udid, "abcrm -rf");
    assert.equal(d.kind, "emulator");
  });

  it("hands a remote Appium a download address, and a local one the file", () => {
    const local = appLocation({ id: "a", name: "a", platform: "android", appiumUrl: "http://127.0.0.1:4723", kind: "emulator" }, "/data/uploads/x.apk", "x.apk");
    assert.deepEqual(local, { app: "/data/uploads/x.apk", shared: false });
    const remote = appLocation({ id: "b", name: "b", platform: "ios", appiumUrl: "http://192.168.1.5:4723", kind: "simulator", serverAddress: "http://192.168.1.10:4000" }, "/data/uploads/y.ipa", "My App.ipa");
    assert.equal(remote.shared, true);
    assert.match(remote.app, /^http:\/\/192\.168\.1\.10:4000\/app-files\/[\w-]+\/My_App\.ipa$/);
    const token = remote.app.split("/app-files/")[1].split("/")[0];
    assert.equal(sharedApp(token)?.file, "/data/uploads/y.ipa");
    assert.equal(sharedApp("nope"), undefined);
    assert.throws(() => appLocation({ id: "c", name: "Mac", platform: "ios", appiumUrl: "http://192.168.1.5:4723", kind: "simulator" }, "/x", "x"), /This server's address/);
    assert.match(shareApp("/f", "a b.apk", "http://h:1/"), /^http:\/\/h:1\/app-files\/.+\/a_b\.apk$/);
  });

  it("only lets phones on local networks use the traffic recorder", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:10.0.2.15", "172.18.0.3", "192.168.1.9", "100.70.1.1", "fd00::1"]) assert.ok(localAddress(a), a);
    for (const a of ["8.8.8.8", "::ffff:52.1.2.3", "172.32.0.1", "2001:db8::1", undefined]) assert.ok(!localAddress(a), String(a));
  });

  it("reads crashes from logcat for this app only", () => {
    const lines = [
      "E AndroidRuntime: FATAL EXCEPTION: main",
      "E AndroidRuntime: Process: com.other.app, PID: 1",
      "E AndroidRuntime: java.lang.IllegalStateException: other",
      "E AndroidRuntime: FATAL EXCEPTION: main",
      "E AndroidRuntime: Process: in.glv.demoshop, PID: 2",
      "E AndroidRuntime: java.lang.NullPointerException: cart was null",
      "E AndroidRuntime: \tat in.glv.demoshop.CartActivity.onCreate(CartActivity.kt:12)",
      "E ActivityManager: ANR in in.glv.demoshop (in.glv.demoshop/.Main)",
      "E ActivityManager: Reason: Input dispatching timed out",
    ];
    const c = parseLogcat(lines, "in.glv.demoshop", "tapping Cart");
    assert.equal(c.length, 2);
    assert.equal(c[0].reason, "java.lang.NullPointerException: cart was null");
    assert.match(c[0].stack[0], /CartActivity/);
    assert.equal(c[1].type, "anr");
    assert.equal(c[1].reason, "Input dispatching timed out");
  });

  it("an empty report has no problems", () => {
    const out = deviceFindings({ device: "x", platform: "android", screens: [], crashes: [], passes: [], journeys: [], traffic: [], notes: [], signIn: "none", perf: {} } as unknown as Parameters<typeof deviceFindings>[0]);
    assert.equal(out.length, 0);
  });
});

describe("test phone: server routes", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof import("../src/server.ts").createApp>>["app"];
  const call = async (method: string, url: string, payload?: object | Buffer, headers?: Record<string, string>) => {
    const res = await app.inject({ method: method as "GET", url, payload, headers });
    return { status: res.statusCode, body: res.body && /json/.test(String(res.headers["content-type"])) ? res.json() : res.body };
  };
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    delete process.env.APPIUM_URL;
    dir = await mkdtemp(path.join(tmpdir(), "glv-device-routes-"));
    const { createApp } = await import("../src/server.ts");
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    setDevices([]);
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("adds, changes and removes test phones, and keeps them", async () => {
    assert.deepEqual((await call("GET", "/api/owner/devices")).body.devices, []);
    const bad = await call("POST", "/api/owner/devices", { name: "x", platform: "android", appiumUrl: "ftp://a" });
    assert.equal(bad.status, 400);
    const made = await call("POST", "/api/owner/devices", { name: "Pixel 8", platform: "android", kind: "phone", appiumUrl: "http://127.0.0.1:9" });
    assert.equal(made.status, 201);
    const id = made.body.device.id;
    const checked = await call("GET", "/api/owner/devices?check=1");
    assert.equal(checked.body.devices[0].checked, true);
    assert.ok(checked.body.devices[0].status, "a phone nobody answers for is not ready");
    const changed = await call("PUT", `/api/owner/devices/${id}`, { name: "Pixel 8 Pro", platform: "android", appiumUrl: "http://127.0.0.1:9" });
    assert.equal(changed.body.device.name, "Pixel 8 Pro");
    assert.equal((await call("PUT", "/api/owner/devices/builtin", { name: "x", platform: "android", appiumUrl: "http://a" })).status, 400);
    const { listDevices } = await import("../src/mobile/devices.ts");
    assert.equal(listDevices()[0].name, "Pixel 8 Pro");
    assert.equal((await call("DELETE", `/api/owner/devices/${id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/owner/devices/${id}`)).status, 404);
  });

  it("takes an app bundle upload and keeps app journeys on mobile projects only", async () => {
    const { buildDemoAab } = await import("./fixtures/demo-mobile.ts");
    const up = await call("POST", "/api/uploads", buildDemoAab(), { "content-type": "application/octet-stream", "x-file-name": "shop.aab" });
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.match(up.body.file, /\.aab$/);
    const created = await call("POST", "/api/projects", { type: "android", file: up.body.file, fileName: up.body.fileName });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.project.name, "shop");
    const pid = created.body.project.id;
    const bad = await call("PATCH", `/api/projects/${pid}`, { appJourneys: [{ name: "Oops", steps: "fly away" }] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Oops/);
    const ok = await call("PATCH", `/api/projects/${pid}`, { appJourneys: [{ name: "Cart", steps: 'tap "Cart"\nsee "Total"' }] });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.appJourneys[0].name, "Cart");
    const web = await call("POST", "/api/projects", { type: "website", url: "https://example.com/", name: "Site" });
    const refused = await call("PATCH", `/api/projects/${web.body.project.id}`, { appJourneys: [] });
    assert.equal(refused.status, 400);
  });

  it("serves a shared app to Appium only while its address is valid", async () => {
    const file = path.join(dir, "shared.apk");
    await writeFile(file, "APKDATA");
    const url = shareApp(file, "shop.apk", "http://h");
    const at = url.replace("http://h", "");
    const got = await call("GET", at);
    assert.equal(got.status, 200);
    assert.equal(got.body, "APKDATA");
    assert.equal((await call("GET", "/app-files/not-a-token/shop.apk")).status, 404);
    const { unshareApp } = await import("../src/mobile/devices.ts");
    unshareApp(url);
    assert.equal((await call("GET", at)).status, 404);
  });
});
