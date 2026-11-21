import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * A stand-in for a Mac, for testing the Mac helper on Linux: small programs with the names of
 * Apple's tools (xcrun, xcodebuild, safaridriver, osascript, ...) that answer the way the real
 * ones do. They write every call to calls.log in the state folder, and read switches from it:
 *   crash-next              the next app launch crashes, with a crash report
 *   vo-phrases.json         what VoiceOver says, item by item
 *   no-remote-automation    Safari in the Simulator refuses automation
 * Screenshots are a 1-pixel PNG, or the file of the same name in FAKE_MAC_SHOTS when it is set
 * (mac.png, iphone.png, screen-1.png, ...), for pictures of the dashboard.
 */

export const SIM_IPHONE = "11111111-2222-3333-4444-555555555555";
export const SIM_IPAD = "AAAAAAAA-2222-3333-4444-555555555555";
export const SIM_OLD = "22222222-2222-3333-4444-555555555555";

const fflate = createRequire(import.meta.url).resolve("fflate");

const SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const http = require("http");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const STATE = process.env.FAKE_MAC_STATE;
fs.appendFileSync(path.join(STATE, "calls.log"), [name, ...args].join(" ") + "\n");
const out = (s) => process.stdout.write(s + "\n");
const fail = (s) => { process.stderr.write(s + "\n"); process.exit(1); };
const flag = (f) => fs.existsSync(path.join(STATE, f));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const shot = (n) => {
  const f = process.env.FAKE_MAC_SHOTS && path.join(process.env.FAKE_MAC_SHOTS, n);
  return f && fs.existsSync(f) ? fs.readFileSync(f) : PNG;
};
const arg = (prefix) => { const a = args.find((x) => x.startsWith(prefix)); return a ? a.slice(prefix.length) : ""; };

function xcrun() {
  if (args[0] === "devicectl") fail("No devices");
  if (args[0] !== "simctl") fail("unknown xcrun tool " + args[0]);
  const sub = args[1];
  if (sub === "list") {
    out(JSON.stringify({ devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-18-1": [
        { name: "iPhone 16", udid: "${SIM_IPHONE}", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
        { name: "iPad Air 11-inch (M2)", udid: "${SIM_IPAD}", state: "Shutdown", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M2" },
      ],
      "com.apple.CoreSimulator.SimRuntime.iOS-16-4": [
        { name: "iPhone 14", udid: "${SIM_OLD}", state: "Booted", isAvailable: true, deviceTypeIdentifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-14" },
      ],
      "com.apple.CoreSimulator.SimRuntime.watchOS-11-1": [
        { name: "Apple Watch Series 10", udid: "33333333-2222-3333-4444-555555555555", state: "Shutdown", isAvailable: true },
      ],
    } }));
  } else if (sub === "install") {
    if (!fs.existsSync(path.join(args[3], "Info.plist"))) fail("An application bundle was not found at the provided path.");
  } else if (sub === "launch") {
    const bundle = args[4];
    if (flag("crash-next")) {
      fs.rmSync(path.join(STATE, "crash-next"));
      // A process that has already ended: the app closed by itself.
      const dead = require("child_process").spawnSync(process.execPath, ["-e", ""]).pid;
      const head = { app_name: "GLVShop", bundleID: bundle, bug_type: "309" };
      const body = {
        exception: { type: "EXC_CRASH", signal: "SIGABRT" },
        asi: { "libsystem_c.dylib": ["abort() called"] },
        usedImages: [{ name: "GLVShop" }, { name: "libsystem_c.dylib" }],
        faultingThread: 0,
        threads: [{ triggered: true, frames: [{ imageIndex: 1, symbol: "abort" }, { imageIndex: 0, symbol: "CheckoutViewModel.load()" }, { imageIndex: 0, imageOffset: 4096 }] }],
      };
      fs.mkdirSync(process.env.GLV_HELPER_CRASH_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.GLV_HELPER_CRASH_DIR, "GLVShop-2026-11-18-101500.ips"), JSON.stringify(head) + "\n" + JSON.stringify(body, null, 2));
      out(bundle + ": " + dead);
    } else out(bundle + ": " + process.ppid);
  } else if (sub === "io") {
    fs.writeFileSync(args[args.length - 1], shot(path.basename(args[args.length - 1])));
  }
  // boot, bootstatus, shutdown, ui, uninstall, terminate: nothing to do.
}

function xcodebuild() {
  if (args[0] === "-version") return out("Xcode 16.1\nBuild version 16B40");
  if (args[0] !== "test") fail("unknown");
  const dir = arg("TEST_RUNNER_GLV_OUT=");
  if (!arg("TEST_RUNNER_GLV_BUNDLE_ID=") || !dir) fail("missing settings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "screen-1.png"), shot("screen-1.png"));
  fs.writeFileSync(path.join(dir, "screen-2.png"), shot("screen-2.png"));
  const report = {
    screens: [
      { name: "First screen", screenshot: "screen-1.png", issues: [
        { type: "sufficientElementDescription", description: "Element has no description", element: "\"cart.fill\"" },
        { type: "sufficientElementDescription", description: "Element has no description" },
        { type: "contrast", description: "Contrast nearly passes", element: "\"Sale\"" },
      ] },
      { name: "Tab: Cart", screenshot: "screen-2.png", issues: [
        { type: "hitRegion", description: "Hit region is too small", element: "\"Remove\"" },
        { type: "auditError", description: "Timed out while auditing" },
      ] },
    ],
    crashed: false,
  };
  // The Simulator could not write to the Mac's folder: the report only comes in the log.
  if (flag("audit-log-only")) out("GLV-AUDIT-JSON:" + Buffer.from(JSON.stringify(report)).toString("base64"));
  else fs.writeFileSync(path.join(dir, "audit.json"), JSON.stringify(report));
  out("** TEST SUCCEEDED **");
}

function safaridriver() {
  if (args[0] === "--version") return out("Included with Safari 18.1 (20619.2.8.11.10)");
  const port = Number(args[args.indexOf("-p") + 1]);
  const sessions = {};
  let n = 0;
  http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const send = (value, code = 200) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify({ value }));
      };
      const j = raw ? JSON.parse(raw) : {};
      fs.appendFileSync(path.join(STATE, "calls.log"), "webdriver " + req.method + " " + req.url + "\n");
      if (req.url === "/status") return send({ ready: true, message: "" });
      if (req.method === "POST" && req.url === "/session") {
        const caps = j.capabilities.alwaysMatch;
        if (caps["safari:useSimulator"] && flag("no-remote-automation"))
          return send({ error: "session not created", message: "Could not create a session: Allow remote automation in Settings > Safari > Advanced" }, 500);
        const id = "s" + ++n;
        sessions[id] = { ios: caps.platformName === "iOS", udid: caps["safari:deviceUDID"], url: "" };
        return send({ sessionId: id, capabilities: {} });
      }
      const m = req.url.match(/^\/session\/(\w+)(\/.*)?$/);
      const s = m && sessions[m[1]];
      if (!s) return send({ error: "invalid session id", message: "No session" }, 404);
      const rest = m[2] || "";
      if (req.method === "DELETE" && !rest) {
        delete sessions[m[1]];
        return send(null);
      }
      if (rest === "/url") {
        s.url = j.url;
        return send(null);
      }
      if (rest === "/execute/sync") {
        if (!/naturalWidth/.test(j.script)) return send({ error: "javascript error", message: "not the page script" }, 500);
        if (s.ios)
          return send({ overflow: 120, counts: { images: 2, buttons: 1, links: 10, fields: 0, headings: 1, videos: 0 }, broken: [], width: 393, height: 659,
            userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1" });
        // On the Mac, a script stopped: most links are missing, and Safari cannot show the AVIF image.
        return send({ overflow: 0, counts: { images: 2, buttons: 1, links: 2, fields: 0, headings: 1, videos: 0 }, broken: [new URL("/hero.avif", s.url).href], width: 1366, height: 900,
          userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15" });
      }
      if (rest === "/screenshot") return send(shot(s.ios ? "iphone.png" : "mac.png").toString("base64"));
      return send(null);
    });
  }).listen(port, "127.0.0.1");
}

function osascript() {
  if (args[0] === "-e") return out("1");
  if (args[0] === "-l") return fs.writeFileSync(path.join(STATE, "vo-running"), "");
  const script = fs.readFileSync(0, "utf8");
  if (/caption window/.test(script)) return out("true");
  if (/to quit/.test(script)) return fs.rmSync(path.join(STATE, "vo-running"), { force: true });
  if (/perform command/.test(script)) return;
  if (/move right/.test(script)) {
    const posFile = path.join(STATE, "vo-pos");
    const pos = Number(fs.existsSync(posFile) ? fs.readFileSync(posFile, "utf8") : "-1") + 1;
    fs.writeFileSync(posFile, String(pos));
    const phrases = JSON.parse(fs.readFileSync(path.join(STATE, "vo-phrases.json"), "utf8"));
    const i = Math.min(pos, phrases.length - 1);
    return out(phrases[i] + "<<GLV>>" + [0, 40 * i, 600, 40 * i + 30].join(","));
  }
  if (/content of last phrase/.test(script)) return out("Safari, GLV Shop, window, HTML content");
  fail("unknown script");
}

function ditto() {
  const { unzipSync } = require(${JSON.stringify(fflate)});
  const [, , zip, dest] = args;
  for (const [n, d] of Object.entries(unzipSync(fs.readFileSync(zip)))) {
    if (n.endsWith("/")) continue;
    const f = path.join(dest, n);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, d);
  }
}

const tools = {
  xcrun, xcodebuild, safaridriver, osascript, ditto,
  sw_vers: () => out("15.1"),
  defaults: () => out("18.1"),
  pgrep: () => process.exit(flag("vo-running") ? 0 : 1),
  pkill: () => fs.rmSync(path.join(STATE, "vo-running"), { force: true }),
  open: () => {},
};
if (!tools[name]) fail(name + ": not faked");
tools[name]();
`;

/** Writes the stand-in tools into dir/bin, and returns the folder to put first on PATH. */
export async function fakeMac(dir: string): Promise<{ bin: string; state: string }> {
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  const body = `#!${process.execPath}\n${SCRIPT}`;
  for (const name of ["xcrun", "xcodebuild", "safaridriver", "osascript", "ditto", "sw_vers", "defaults", "pgrep", "pkill", "open"]) {
    const f = path.join(bin, name);
    await writeFile(f, body);
    await chmod(f, 0o755);
  }
  return { bin, state };
}
