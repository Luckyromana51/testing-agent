#!/usr/bin/env node
/**
 * GLV Mac helper: runs the tests a Linux server cannot, on a Mac with Xcode, for GLV's testing
 * platform. It connects out to the server (nothing has to reach the Mac), asks for work, runs it
 * and sends back what it saw. The server turns that into findings.
 *
 *   node glv-helper.mjs pair <server address> <token>   save the server and the token from Owner panel > Mac helpers
 *   node glv-helper.mjs check                           show what this Mac can test, and how to fix what it cannot
 *   node glv-helper.mjs devices on|off                  let it install apps on iPhones connected to this Mac (off by default)
 *   node glv-helper.mjs                                 connect and run tests until stopped (Ctrl+C)
 *
 * Needs Node 22 and nothing else from npm. It only runs Apple's own tools (xcrun, xcodebuild,
 * safaridriver, osascript, ditto, open), with fixed arguments and never through a shell.
 */
import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.GLV_HELPER_HOME || path.join(os.homedir(), ".glv-helper");
const CONFIG = path.join(HOME, "config.json");
const CRASH_DIR = process.env.GLV_HELPER_CRASH_DIR || path.join(os.homedir(), "Library", "Logs", "DiagnosticReports");
const RUNNER = process.env.GLV_HELPER_RUNNER || path.join(HERE, "GLVRunner", "GLVRunner.xcodeproj");
/** How long an app must stay open to count as not crashing. */
const STAY_OPEN_MS = Number(process.env.GLV_HELPER_STAY_OPEN_MS || 10_000);
/** Pauses that give pages, apps and VoiceOver time to settle (shorter in the stand-in tests). */
const SETTLE = Number(process.env.GLV_HELPER_SETTLE_MS || 1);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = (ms) => sleep(Math.round(ms * SETTLE));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const short = (s, n = 300) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ---- Running Apple's tools ----------------------------------------------------------------------

/** Runs a program with arguments (no shell). Never throws: the caller reads code, stdout and stderr. */
function run(cmd, args, { timeout = 120_000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      const missing = err && err.code === "ENOENT";
      resolve({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: stdout ?? "",
        stderr: missing ? `${cmd} is not installed` : err?.killed ? `${cmd} took longer than ${Math.round(timeout / 1000)} s` : (stderr ?? ""),
      });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

const failed = (r) => short(r.stderr || r.stdout || `exit code ${r.code}`, 500);

/** AppleScript through osascript, read from stdin. */
async function appleScript(script, timeoutSec = 10) {
  const r = await run("osascript", [], { timeout: (timeoutSec + 2) * 1000, input: `with timeout of ${timeoutSec} seconds\n${script}\nend timeout` });
  if (r.code) throw new Error(failed(r));
  return r.stdout.replace(/\n$/, "");
}

const versionAtLeast = (a, b) => {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return true;
};

// ---- Settings --------------------------------------------------------------------------------------

async function loadConfig() {
  let c = {};
  try {
    c = JSON.parse(await readFile(CONFIG, "utf8"));
  } catch {
    /* not paired yet */
  }
  if (process.env.GLV_SERVER) c.server = process.env.GLV_SERVER;
  if (process.env.GLV_HELPER_TOKEN) c.token = process.env.GLV_HELPER_TOKEN;
  return c;
}

async function saveConfig(c) {
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await writeFile(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });
  await chmod(CONFIG, 0o600);
}

/** https, or http only to this Mac or the local network (a token must not cross the internet in the clear). */
function checkServer(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a web address. Use the dashboard's address, such as https://test.glvinfotechsolutions.com`);
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("Use the server's https:// address (plain http is only allowed on this Mac or the local network).");
  return u.origin;
}

// ---- The server ----------------------------------------------------------------------------------

function serverClient(config) {
  const call = async (method, p, { json, raw, timeout = 30_000 } = {}) => {
    const headers = { authorization: `Bearer ${config.token}`, "user-agent": `glv-helper/${VERSION}` };
    if (json !== undefined) headers["content-type"] = "application/json";
    if (raw !== undefined) headers["content-type"] = "application/octet-stream";
    return fetch(new URL(p, config.server), {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : raw,
      signal: AbortSignal.timeout(timeout),
    });
  };
  return { call };
}

// ---- What this Mac can do ------------------------------------------------------------------------

async function simulators() {
  const r = await run("xcrun", ["simctl", "list", "devices", "available", "--json"], { timeout: 60_000 });
  if (r.code) return [];
  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const out = [];
  for (const [runtime, list] of Object.entries(data.devices ?? {})) {
    const m = runtime.match(/SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/);
    if (!m || !Array.isArray(list)) continue;
    const version = [m[1], m[2], m[3]].filter(Boolean).join(".");
    for (const d of list) {
      if (d.isAvailable === false || !d.udid) continue;
      const kind = `${d.deviceTypeIdentifier ?? ""} ${d.name ?? ""}`;
      const type = /iPad/i.test(kind) ? "ipad" : /iPhone/i.test(kind) ? "iphone" : null;
      if (type) out.push({ name: d.name, udid: d.udid, runtime: `iOS ${version}`, version, type, booted: d.state === "Booted" });
    }
  }
  return out;
}

/** The simulator to use: the type asked for, new enough for the app, newest iOS first, one already running before others. */
function pickSimulator(list, type, minOS) {
  return list
    .filter((s) => s.type === type && (!minOS || versionAtLeast(s.version, minOS)))
    .sort((a, b) => (a.version === b.version ? Number(b.booted) - Number(a.booted) : versionAtLeast(a.version, b.version) ? -1 : 1))[0];
}

async function connectedDevices() {
  const f = path.join(os.tmpdir(), `glv-devices-${process.pid}-${Date.now()}.json`);
  const r = await run("xcrun", ["devicectl", "list", "devices", "--json-output", f], { timeout: 60_000 });
  try {
    if (r.code) return [];
    const j = JSON.parse(await readFile(f, "utf8"));
    return (j.result?.devices ?? [])
      .map((d) => ({
        id: d.identifier,
        udid: d.hardwareProperties?.udid,
        name: d.deviceProperties?.name ?? "iPhone",
        os: d.deviceProperties?.osVersionNumber,
        platform: d.hardwareProperties?.platform,
        state: d.connectionProperties?.tunnelState,
      }))
      .filter((d) => d.id && d.udid && (!d.platform || /iOS/i.test(d.platform)) && d.state !== "unavailable");
  } catch {
    return [];
  } finally {
    await rm(f, { force: true });
  }
}

async function detect(config) {
  const info = { version: VERSION, kinds: [], problems: {} };
  if (process.platform !== "darwin" && !process.env.GLV_HELPER_ANY_OS) {
    for (const k of ["safari", "voiceover", "ios-app"]) info.problems[k] = "The helper runs on macOS only.";
    return { info, sims: [], devices: [] };
  }
  const sw = await run("sw_vers", ["-productVersion"]);
  if (!sw.code) info.macos = sw.stdout.trim();
  const xc = await run("xcodebuild", ["-version"]);
  if (!xc.code) info.xcode = xc.stdout.split("\n")[0].replace(/^Xcode\s*/, "").trim();
  const sv = await run("defaults", ["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"]);
  if (!sv.code) info.safari = sv.stdout.trim();
  const sims = info.xcode ? await simulators() : [];
  const devices = info.xcode && config.useDevices ? await connectedDevices() : [];
  info.simulators = sims.map(({ name, udid, runtime, type }) => ({ name, udid, runtime, type }));
  info.devices = devices.map(({ name, udid, os: v }) => ({ name, udid, ...(v ? { os: v } : {}) }));
  const off = (k) => config.kinds && config.kinds[k] === false;

  if (off("safari")) info.problems.safari = "Switched off in this helper's settings.";
  else if ((await run("safaridriver", ["--version"])).code) info.problems.safari = "safaridriver was not found. It comes with Safari; update macOS and Safari.";
  else info.kinds.push("safari");

  if (off("voiceover")) info.problems.voiceover = "Switched off in this helper's settings.";
  else if ((await run("osascript", ["-e", "return 1"])).code) info.problems.voiceover = "osascript could not run, so VoiceOver cannot be controlled.";
  else info.kinds.push("voiceover");

  if (off("ios-app")) info.problems["ios-app"] = "Switched off in this helper's settings.";
  else if (!info.xcode) info.problems["ios-app"] = "Xcode is not installed or not selected. Install Xcode from the App Store, open it once, then run: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer";
  else if (!sims.length && !devices.length) info.problems["ios-app"] = "No iOS Simulator is installed. In Xcode, open Settings > Components and add an iOS Simulator runtime.";
  else info.kinds.push("ios-app");

  if (!Object.keys(info.problems).length) delete info.problems;
  return { info, sims, devices };
}

// ---- One job --------------------------------------------------------------------------------------

function jobContext(server, job, dir) {
  let cancelled = false;
  const note = (r) => {
    if (r && r.status === 409) cancelled = true;
    return r;
  };
  return {
    dir,
    params: job.params,
    get cancelled() {
      return cancelled;
    },
    check() {
      if (cancelled) throw new Error("The test was cancelled on the server.");
    },
    async progress(message) {
      log(`  ${message}`);
      note(await server.call("POST", `/api/helper/jobs/${job.id}/progress`, { json: { message } }).catch(() => null));
    },
    /** Sends a screenshot or log; returns its name when the server kept it. */
    async upload(name, buf) {
      const r = note(await server.call("POST", `/api/helper/jobs/${job.id}/artifacts/${name}`, { raw: buf, timeout: 180_000 }).catch(() => null));
      return r && r.ok ? name : undefined;
    },
    async download(to) {
      const r = await server.call("GET", `/api/helper/jobs/${job.id}/file`, { timeout: 30 * 60_000 });
      if (!r.ok || !r.body) throw new Error(`Could not download the app from the server (HTTP ${r.status}).`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(to));
      return (await stat(to)).size;
    },
  };
}

const KINDS = { safari: safariJob, voiceover: voiceOverJob, "ios-app": iosAppJob };

async function runJob(server, job, state) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "glv-job-"));
  const ctx = jobContext(server, job, dir);
  const beat = setInterval(() => server.call("POST", "/api/helper/ping").catch(() => {}), 20_000);
  log(`Job ${job.kind}`);
  try {
    const fn = KINDS[job.kind];
    if (!fn) throw new Error(`This helper (version ${VERSION}) does not know "${job.kind}". Update glv-helper.mjs.`);
    const data = await fn(ctx, state);
    await server.call("POST", `/api/helper/jobs/${job.id}/result`, { json: { ok: true, data }, timeout: 120_000 });
    log("  done");
  } catch (err) {
    log(`  failed: ${err.message}`);
    await server.call("POST", `/api/helper/jobs/${job.id}/result`, { json: { ok: false, error: short(err.message, 400) } }).catch(() => {});
  } finally {
    clearInterval(beat);
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- Real Safari (WebDriver) -------------------------------------------------------------------

async function startSafariDriver() {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn("safaridriver", ["-p", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.on("error", (e) => (out += e.message));
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 75; i++) {
    if (child.exitCode !== null || out.includes("ENOENT")) throw new Error(`safaridriver stopped: ${short(out) || "no reason given"}`);
    try {
      const r = await fetch(`${base}/status`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return { base, stop: () => child.kill() };
    } catch {
      /* not listening yet */
    }
    await sleep(200);
  }
  child.kill();
  throw new Error("safaridriver did not start within 15 seconds.");
}

async function wd(base, method, p, body, timeout = 90_000) {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j?.value?.error) throw new Error(short(j?.value?.message || j?.value?.error || `WebDriver answered ${r.status}`));
  return j.value;
}

function explainSafari(device, message) {
  if (/remote automation/i.test(message))
    return device === "mac"
      ? "Safari does not allow automation yet. Run once in Terminal on the Mac: safaridriver --enable (it asks for the Mac's password)."
      : `Safari in the Simulator does not allow automation: in the Simulator open Settings > Safari > Advanced and turn on Remote Automation, then try again (${message}).`;
  if (/session.*(already|in progress)|already.*(session|paired)/i.test(message)) return "Safari is already controlled by another automation session. Close it (or quit Safari) and try again.";
  return `Safari could not start: ${message}`;
}

async function bootSimulator(sim) {
  if (sim.booted) return false;
  await run("xcrun", ["simctl", "boot", sim.udid], { timeout: 120_000 });
  const r = await run("xcrun", ["simctl", "bootstatus", sim.udid, "-b"], { timeout: 300_000 });
  if (r.code) throw new Error(`The ${sim.name} simulator did not start: ${failed(r)}`);
  return true;
}

async function safariJob(ctx, state) {
  const { urls, devices, script, shots } = ctx.params;
  if (!Array.isArray(urls) || !urls.length || urls.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) throw new Error("The server sent no web addresses.");
  if (typeof script !== "string" || script.length > 20_000) throw new Error("The server sent no page script.");
  const wanted = (Array.isArray(devices) ? devices : ["mac"]).filter((d) => ["mac", "iphone", "ipad"].includes(d));
  const views = [];
  const problems = [];
  const driver = await startSafariDriver();
  try {
    for (const device of wanted) {
      ctx.check();
      let name = "Safari on Mac";
      let caps = { browserName: "safari" };
      let booted;
      if (device !== "mac") {
        const sim = pickSimulator(state.sims, device, "13.0");
        if (!sim) {
          problems.push({ device, error: `No ${device === "iphone" ? "iPhone" : "iPad"} simulator is installed (Xcode > Settings > Components).` });
          continue;
        }
        name = `Safari on ${sim.name} (${sim.runtime})`;
        caps = { browserName: "safari", platformName: "iOS", "safari:useSimulator": true, "safari:deviceUDID": sim.udid };
        try {
          await ctx.progress(`Starting the ${sim.name} simulator`);
          booted = (await bootSimulator(sim)) ? sim : undefined;
        } catch (err) {
          problems.push({ device, error: err.message });
          continue;
        }
      }
      let session;
      try {
        session = (await wd(driver.base, "POST", "/session", { capabilities: { alwaysMatch: caps } }, 180_000)).sessionId;
      } catch (err) {
        problems.push({ device, error: explainSafari(device, err.message) });
        if (booted) await run("xcrun", ["simctl", "shutdown", booted.udid]);
        continue;
      }
      try {
        await wd(driver.base, "POST", `/session/${session}/timeouts`, { pageLoad: 45_000, script: 20_000 });
        if (device === "mac") await wd(driver.base, "POST", `/session/${session}/window/rect`, { width: 1366, height: 900 }).catch(() => {});
        for (const [i, url] of urls.entries()) {
          ctx.check();
          await ctx.progress(`${name}: ${url}`);
          try {
            await wd(driver.base, "POST", `/session/${session}/url`, { url }, 60_000);
            await settle(800);
            const v = await wd(driver.base, "POST", `/session/${session}/execute/sync`, { script: `return ${script};`, args: [] });
            const view = { device, name, url, ...(v && typeof v === "object" ? v : {}) };
            if (i < (Number(shots) || 0)) {
              const png = await wd(driver.base, "GET", `/session/${session}/screenshot`).catch(() => null);
              const saved = png && (await ctx.upload(`${device}-${i + 1}.png`, Buffer.from(png, "base64")));
              if (saved) view.screenshot = saved;
            }
            views.push(view);
          } catch (err) {
            views.push({ device, name, url, error: short(err.message) });
          }
        }
      } finally {
        await wd(driver.base, "DELETE", `/session/${session}`).catch(() => {});
        if (booted) await run("xcrun", ["simctl", "shutdown", booted.udid]);
      }
    }
  } finally {
    driver.stop();
  }
  const sv = await run("defaults", ["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"]);
  return { ...(sv.code ? {} : { safari: sv.stdout.trim() }), views, problems };
}

// ---- VoiceOver ---------------------------------------------------------------------------------

/** Asks VoiceOver to start the way Command-F5 does (otherwise it waits about 9 seconds first). */
const VO_START = `ObjC.bindFunction("dlopen", ["void *", ["char *", "int"]]);
$.dlopen("/usr/lib/libScreenReader.dylib", 1);
ObjC.bindFunction("_ScreenReaderStart", ["void", ["int"]]);
$._ScreenReaderStart(0);`;

const SEP = "<<GLV>>";
/** One step: move to the next item, then what VoiceOver said and where its cursor is. */
const VO_STEP = `tell application "VoiceOver"
with transaction
tell vo cursor to move right
end transaction
end tell
delay 0.25
set p to ""
set b to ""
tell application "VoiceOver"
try
set p to content of last phrase
end try
try
set bl to bounds of vo cursor
set AppleScript's text item delimiters to ","
set b to bl as text
end try
end tell
return p & "${SEP}" & b`;

const voRunning = async () => !(await run("pgrep", ["-x", "VoiceOver"])).code;

async function voCommand(command) {
  return appleScript(`tell application "VoiceOver"\nwith transaction\ntell commander to perform command "${command}"\nend transaction\nend tell`);
}

const VO_SETUP =
  "VoiceOver did not accept commands. On the Mac: 1) open VoiceOver Utility > General and tick \"Allow VoiceOver to be controlled with AppleScript\"; 2) in System Settings > Privacy & Security > Automation, allow Terminal (or the app that runs the helper) to control VoiceOver. Then run the test again.";

async function startVoiceOver() {
  if (await voRunning()) return false;
  const r = await run("osascript", ["-l", "JavaScript", "-e", VO_START], { timeout: 20_000 });
  if (r.code) throw new Error(`VoiceOver could not be started: ${failed(r)}`);
  for (let i = 0; i < 60; i++) {
    if (await voRunning()) {
      try {
        await appleScript(`tell application "VoiceOver"\nreturn enabled of caption window\nend tell`, 2);
        return true;
      } catch (err) {
        // Any answer from VoiceOver itself means it is ready; "not running" (-600) or a timeout means not yet.
        if (!/-600|-1712|timed out|not running/i.test(err.message)) return true;
      }
    }
    await sleep(500);
  }
  throw new Error("VoiceOver did not start within 30 seconds.");
}

async function stopVoiceOver() {
  await appleScript(`tell application "VoiceOver" to quit`, 5).catch(() => {});
  for (let i = 0; i < 20 && (await voRunning()); i++) await sleep(250);
  if (await voRunning()) await run("pkill", ["-x", "VoiceOver"]);
}

async function voiceOverJob(ctx) {
  const { urls, steps } = ctx.params;
  if (!Array.isArray(urls) || !urls.length || urls.some((u) => typeof u !== "string" || !/^https?:\/\//.test(u))) throw new Error("The server sent no web addresses.");
  const max = Math.min(400, Math.max(10, Number(steps) || 200));
  await ctx.progress("Starting VoiceOver (the Mac will speak)");
  const started = await startVoiceOver();
  const pages = [];
  try {
    for (const [n, url] of urls.entries()) {
      ctx.check();
      await ctx.progress(`VoiceOver: ${url}`);
      const r = await run("open", ["-a", "Safari", url]);
      if (r.code) {
        pages.push({ url, phrases: [], reachedEnd: false, error: `Safari could not open the page: ${failed(r)}` });
        continue;
      }
      await settle(6000);
      // Find the page in Safari's window: VoiceOver calls it "HTML content".
      let phrase = "";
      try {
        phrase = await appleScript(`tell application "VoiceOver"\nreturn content of last phrase\nend tell`);
      } catch (err) {
        throw new Error(`${VO_SETUP} (macOS said: ${short(err.message, 160)})`);
      }
      let found = /html content|web content|web area/i.test(phrase);
      for (let i = 0; i < 40 && !found; i++) {
        phrase = (await appleScript(VO_STEP)).split(SEP)[0];
        found = /html content|web content|web area/i.test(phrase);
      }
      if (!found) {
        pages.push({ url, phrases: [], reachedEnd: false, error: "VoiceOver could not find the page in Safari's window." });
        continue;
      }
      await voCommand("start interacting with item").catch(() => {});
      await settle(500);
      const phrases = [];
      let last = "";
      let lastPhrase = "";
      let repeats = 0;
      let reachedEnd = false;
      for (let i = 0; i < max; i++) {
        if (i % 25 === 0) ctx.check();
        const [p = "", bounds = ""] = (await appleScript(VO_STEP)).split(SEP);
        const key = `${p}|${bounds}`;
        // At the end of the page VoiceOver stays where it is: the same words in the same place. Without
        // its position, a few identical items in a row ("Add to cart, button") still count as items.
        if (key === last) {
          repeats++;
          if (repeats >= (bounds ? 2 : 4)) {
            reachedEnd = true;
            break;
          }
          continue;
        }
        for (; repeats > 0; repeats--) phrases.push(lastPhrase);
        last = key;
        lastPhrase = p;
        phrases.push(p);
      }
      if (!reachedEnd) for (; repeats > 0; repeats--) phrases.push(lastPhrase);
      const transcript = phrases.map((p, i) => `${String(i + 1).padStart(3)}. ${p}`).join("\n");
      const saved = await ctx.upload(`voiceover-${n + 1}.txt`, Buffer.from(`What VoiceOver said on ${url}\n\n${transcript}\n`));
      pages.push({ url, phrases, reachedEnd, ...(saved ? { transcript: saved } : {}) });
    }
  } finally {
    if (started) await stopVoiceOver();
  }
  const sw = await run("sw_vers", ["-productVersion"]);
  return { pages, ...(sw.code ? {} : { voiceover: sw.stdout.trim() }) };
}

// ---- iOS apps -------------------------------------------------------------------------------------

/** The newest crash report for the app since the test started, read from macOS's JSON (.ips) format. */
export async function readCrash(dir, executable, bundleId, since) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const n of names) {
    if (!n.endsWith(".ips") || !n.startsWith(executable)) continue;
    const s = await stat(path.join(dir, n)).catch(() => null);
    if (s && s.mtimeMs >= since - 2000) candidates.push({ n, t: s.mtimeMs });
  }
  for (const { n } of candidates.sort((a, b) => b.t - a.t)) {
    try {
      const textAll = await readFile(path.join(dir, n), "utf8");
      const nl = textAll.indexOf("\n");
      const head = JSON.parse(textAll.slice(0, nl));
      if (head.bundleID && head.bundleID !== bundleId) continue;
      const body = JSON.parse(textAll.slice(nl + 1));
      const images = body.usedImages ?? [];
      const asi = Object.values(body.asi ?? {}).flat().find((s) => typeof s === "string");
      const threads = body.threads ?? [];
      const frames = (body.lastExceptionBacktrace ?? threads.find((t) => t.triggered)?.frames ?? threads[body.faultingThread ?? 0]?.frames ?? [])
        .slice(0, 10)
        .map((f) => `${images[f.imageIndex]?.name ?? "?"}  ${f.symbol ?? `0x${Number(f.imageOffset ?? 0).toString(16)}`}`);
      const ex = body.exception ?? {};
      return {
        type: [ex.type, ex.signal].filter(Boolean).join(" ") || "crash",
        ...(asi || body.termination?.indicator ? { reason: short(asi ?? body.termination.indicator, 400) } : {}),
        frames,
      };
    } catch {
      /* not a readable report */
    }
  }
  return undefined;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};

async function screenshot(ctx, udid, name) {
  const f = path.join(ctx.dir, name);
  const r = await run("xcrun", ["simctl", "io", udid, "screenshot", "--type=png", f], { timeout: 60_000 });
  if (r.code) return undefined;
  return ctx.upload(name, await readFile(f));
}

async function launch(udid, bundleId, args = []) {
  const r = await run("xcrun", ["simctl", "launch", "--terminate-running-process", udid, bundleId, ...args], { timeout: 120_000 });
  const pid = Number(r.stdout.match(/:\s*(\d+)\s*$/m)?.[1]);
  return { ok: !r.code, pid: Number.isFinite(pid) ? pid : undefined, error: r.code ? failed(r) : undefined };
}

/** Builds and runs GLVRunner (an XCUITest) that runs Apple's accessibility audit on the app. */
async function auditApp(ctx, udid, bundleId) {
  if (!existsSync(RUNNER)) return { error: "GLVRunner.xcodeproj is missing next to glv-helper.mjs." };
  const out = path.join(ctx.dir, "audit");
  await mkdir(out, { recursive: true });
  const args = (signing) => [
    "test",
    "-project",
    RUNNER,
    "-scheme",
    "GLVRunner",
    "-destination",
    `platform=iOS Simulator,id=${udid}`,
    "-derivedDataPath",
    path.join(HOME, "DerivedData"),
    ...(signing ? [] : ["CODE_SIGNING_ALLOWED=NO"]),
    `TEST_RUNNER_GLV_BUNDLE_ID=${bundleId}`,
    `TEST_RUNNER_GLV_OUT=${out}`,
    "TEST_RUNNER_GLV_TABS=5",
  ];
  await ctx.progress("Running Apple's accessibility audit (the first time, Xcode builds GLV's runner)");
  let r = await run("xcodebuild", args(true), { timeout: 20 * 60_000 });
  if (r.code && /signing|development team|provisioning/i.test(r.stdout + r.stderr)) r = await run("xcodebuild", args(false), { timeout: 20 * 60_000 });
  let report;
  try {
    report = JSON.parse(await readFile(path.join(out, "audit.json"), "utf8"));
  } catch {
    // The runner also prints its report, in case the Simulator could not write to this Mac's folder.
    const line = (r.stdout + r.stderr).match(/GLV-AUDIT-JSON:([A-Za-z0-9+/=]+)/)?.[1];
    if (line) {
      try {
        report = JSON.parse(Buffer.from(line, "base64").toString("utf8"));
      } catch {
        /* unreadable */
      }
    }
  }
  if (!report) return { error: `The audit runner did not finish: ${short((r.stdout + r.stderr).split("\n").filter((l) => /error|failed/i.test(l)).slice(-3).join(" ") || failed(r), 400)}` };
  const screens = [];
  for (const [i, s] of (report.screens ?? []).slice(0, 10).entries()) {
    let shot;
    if (s.screenshot && /^[\w-]+\.png$/.test(s.screenshot)) {
      const buf = await readFile(path.join(out, s.screenshot)).catch(() => null);
      if (buf) shot = await ctx.upload(`screen-${i + 1}.png`, buf);
    }
    screens.push({ name: s.name, ...(shot ? { screenshot: shot } : {}), issues: (s.issues ?? []).slice(0, 100) });
  }
  return { screens, crashed: report.crashed === true, ...(report.error ? { error: report.error } : {}) };
}

async function iosAppJob(ctx, state) {
  const p = ctx.params;
  if (typeof p.bundleId !== "string" || !/^[A-Za-z0-9.-]{1,200}$/.test(p.bundleId)) throw new Error("The server sent no bundle ID.");
  if (typeof p.appDir !== "string" || !/^(Payload\/)?[^/]+\.app\/$/.test(p.appDir) || p.appDir.includes("..")) throw new Error("The server sent a bad app folder.");
  const executable = typeof p.executable === "string" && /^[^/]{1,200}$/.test(p.executable) ? p.executable : "";

  await ctx.progress("Downloading the app");
  const file = path.join(ctx.dir, "app.zip");
  await ctx.download(file);
  const unpacked = path.join(ctx.dir, "x");
  const unzip = await run("ditto", ["-x", "-k", file, unpacked], { timeout: 10 * 60_000 });
  if (unzip.code) throw new Error(`Could not unpack the app: ${failed(unzip)}`);
  const app = path.join(unpacked, p.appDir);
  if (!app.startsWith(unpacked + path.sep) || !existsSync(path.join(app, "Info.plist"))) throw new Error("The unpacked file has no app in it.");

  if (!p.simulatorBuild) return deviceRun(ctx, state, app, p);

  const type = p.device === "ipad" ? "ipad" : "iphone";
  const minOS = [p.minOS, p.audit ? "17.0" : null].filter(Boolean).sort((a, b) => (versionAtLeast(a, b) ? -1 : 1))[0];
  const sim = pickSimulator(state.sims, type, minOS);
  if (!sim) throw new Error(`No ${type === "ipad" ? "iPad" : "iPhone"} simulator with iOS ${minOS ?? "13"} or later is installed. In Xcode, open Settings > Components and add a newer iOS Simulator.`);
  const result = { mode: "simulator", device: `${sim.name}, ${sim.runtime}`, installed: false, launched: false, stayedOpen: false, screens: [], shots: [] };
  await ctx.progress(`Starting the ${sim.name} simulator (${sim.runtime})`);
  const booted = await bootSimulator(sim);
  const since = Date.now();
  try {
    await run("xcrun", ["simctl", "ui", sim.udid, "appearance", "light"]);
    await run("xcrun", ["simctl", "uninstall", sim.udid, p.bundleId]);
    ctx.check();
    await ctx.progress("Installing the app");
    const inst = await run("xcrun", ["simctl", "install", sim.udid, app], { timeout: 10 * 60_000 });
    if (inst.code) {
      result.installError = failed(inst);
      return result;
    }
    result.installed = true;
    await ctx.progress("Opening the app");
    const first = await launch(sim.udid, p.bundleId);
    result.launched = first.ok;
    if (!first.ok) result.launchError = first.error;
    if (first.ok) {
      await sleep(STAY_OPEN_MS);
      result.stayedOpen = first.pid ? alive(first.pid) : true;
    }
    if (!result.stayedOpen) {
      const crash = executable ? await readCrash(CRASH_DIR, executable, p.bundleId, since) : undefined;
      if (crash) result.crash = crash;
      const shot = await screenshot(ctx, sim.udid, "after-launch.png");
      if (shot) result.shots.push({ label: "After opening", file: shot });
      return result;
    }
    ctx.check();
    if (p.audit) {
      const audit = await auditApp(ctx, sim.udid, p.bundleId);
      if (audit.error) result.auditError = audit.error;
      if (audit.screens) result.screens = audit.screens;
      if (audit.crashed) {
        result.crashedDuringAudit = true;
        const crash = executable ? await readCrash(CRASH_DIR, executable, p.bundleId, since) : undefined;
        if (crash) result.crash = crash;
      }
    } else {
      const shot = await screenshot(ctx, sim.udid, "screen-1.png");
      if (shot) result.screens.push({ name: "First screen", screenshot: shot, issues: [] });
    }
    ctx.check();
    // The first screen in dark mode and at the largest text size.
    await run("xcrun", ["simctl", "ui", sim.udid, "appearance", "dark"]);
    if ((await launch(sim.udid, p.bundleId)).ok) {
      await settle(4000);
      const shot = await screenshot(ctx, sim.udid, "dark.png");
      if (shot) result.shots.push({ label: "Dark mode", file: shot });
    }
    await run("xcrun", ["simctl", "ui", sim.udid, "appearance", "light"]);
    if ((await launch(sim.udid, p.bundleId, ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])).ok) {
      await settle(4000);
      const shot = await screenshot(ctx, sim.udid, "large-text.png");
      if (shot) result.shots.push({ label: "Largest text size", file: shot });
    }
    return result;
  } finally {
    await run("xcrun", ["simctl", "terminate", sim.udid, p.bundleId]);
    await run("xcrun", ["simctl", "uninstall", sim.udid, p.bundleId]);
    await run("xcrun", ["simctl", "ui", sim.udid, "appearance", "light"]);
    if (booted) await run("xcrun", ["simctl", "shutdown", sim.udid]);
  }
}

/** A Development or Ad Hoc build on an iPhone connected to this Mac (only when allowed with: devices on). */
async function deviceRun(ctx, state, app, p) {
  if (!state.config.useDevices)
    throw new Error("This is a build for real iPhones. Upload a Simulator build (a zip of the .app), or let this helper use the iPhones connected to the Mac: node glv-helper.mjs devices on (it installs the app on them).");
  const allowed = new Set((Array.isArray(p.provisionedDevices) ? p.provisionedDevices : []).map((u) => String(u).toLowerCase()));
  const devices = await connectedDevices();
  const device = devices.find((d) => p.provisionsAllDevices || allowed.has(d.udid.toLowerCase()));
  if (!device)
    throw new Error(
      devices.length
        ? `None of the connected devices (${devices.map((d) => d.name).join(", ")}) is in this build's profile. Connect one of its ${allowed.size} devices, or export the IPA again with this iPhone added.`
        : "No iPhone or iPad is connected to the Mac. Connect one that is in this build's profile, unlock it, and trust the Mac.",
    );
  const result = { mode: "device", device: `${device.name}${device.os ? `, iOS ${device.os}` : ""}`, installed: false, launched: false, stayedOpen: false, screens: [], shots: [] };
  await ctx.progress(`Installing on ${device.name}`);
  const inst = await run("xcrun", ["devicectl", "device", "install", "app", "--device", device.id, app], { timeout: 10 * 60_000 });
  if (inst.code) {
    result.installError = failed(inst);
    return result;
  }
  result.installed = true;
  const l = await run("xcrun", ["devicectl", "device", "process", "launch", "--device", device.id, "--terminate-existing", p.bundleId], { timeout: 120_000 });
  result.launched = !l.code;
  if (l.code) result.launchError = failed(l);
  if (result.launched) {
    await sleep(STAY_OPEN_MS);
    const f = path.join(ctx.dir, "processes.json");
    const pr = await run("xcrun", ["devicectl", "device", "info", "processes", "--device", device.id, "--json-output", f], { timeout: 60_000 });
    if (pr.code) result.stayedOpen = true;
    else {
      const j = JSON.parse(await readFile(f, "utf8").catch(() => "{}"));
      const folder = `/${p.appDir.replace(/^Payload\//, "").replace(/\/$/, "")}/`;
      result.stayedOpen = (j.result?.runningProcesses ?? []).some((x) => decodeURIComponent(String(x.executable ?? "")).includes(folder));
    }
  }
  return result;
}

// ---- Main loop --------------------------------------------------------------------------------------

async function connect(config) {
  if (!config.server || !config.token) throw new Error("Not paired yet. In the dashboard open Owner panel > Mac helpers, add this Mac, and run the pair command it shows.");
  const server = serverClient(config);
  const state = { config, sims: [], devices: [] };
  const hello = async () => {
    const d = await detect(config);
    state.sims = d.sims;
    state.devices = d.devices;
    const r = await server.call("POST", "/api/helper/hello", { json: d.info });
    if (r.status === 401) throw new Error("The server does not know this helper's token any more. Pair the Mac again from Owner panel > Mac helpers.");
    if (!r.ok) throw new Error(`The server answered ${r.status}.`);
    const j = await r.json();
    log(`Connected to ${config.server} as "${j.name}". Can test: ${d.info.kinds.join(", ") || "nothing yet"}`);
    for (const [k, why] of Object.entries(d.info.problems ?? {})) log(`  ${k}: ${why}`);
    return j;
  };
  let hi;
  let lastHello = 0;
  let backoff = 2000;
  for (;;) {
    try {
      if (!hi || Date.now() - lastHello > 10 * 60_000) {
        hi = await hello();
        lastHello = Date.now();
      }
      const r = await server.call("GET", `/api/helper/jobs/next?wait=${hi.wait ?? 25}`, { timeout: 60_000 });
      backoff = 2000;
      if (r.status === 204) continue;
      if (r.status === 401) throw new Error("The server does not know this helper's token any more. Pair the Mac again.");
      if (!r.ok) throw new Error(`The server answered ${r.status}.`);
      const { job } = await r.json();
      // Simulators come and go: look again before each job.
      const d = await detect(config);
      state.sims = d.sims;
      state.devices = d.devices;
      await runJob(server, job, state);
      if (process.env.GLV_HELPER_ONCE) return;
    } catch (err) {
      if (/token/.test(err.message)) throw err;
      log(`Connection problem: ${err.message}. Trying again in ${Math.round(backoff / 1000)} s`);
      await sleep(backoff);
      backoff = Math.min(60_000, backoff * 2);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const config = await loadConfig();
  if (cmd === "pair") {
    const [server, token] = rest;
    if (!server || !token || !/^glvh_[\w-]{20,}$/.test(token)) throw new Error("Usage: node glv-helper.mjs pair <server address> <glvh_ token>");
    const next = { ...config, server: checkServer(server), token };
    const r = await serverClient(next).call("POST", "/api/helper/ping");
    if (!r.ok) throw new Error(r.status === 401 ? "The server does not know this token. Copy it again from Owner panel > Mac helpers." : `The server answered ${r.status}.`);
    await saveConfig(next);
    log(`Paired with ${next.server}. Settings saved in ${CONFIG}. Start it with: node glv-helper.mjs`);
    return;
  }
  if (cmd === "devices") {
    if (!["on", "off"].includes(rest[0])) throw new Error("Usage: node glv-helper.mjs devices on|off");
    await saveConfig({ ...config, useDevices: rest[0] === "on" });
    log(rest[0] === "on" ? "Connected iPhones and iPads will be used for Development and Ad Hoc builds (the app is installed on them)." : "Connected iPhones and iPads will not be used.");
    return;
  }
  if (cmd === "check") {
    const { info } = await detect(config);
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (cmd && cmd !== "start") throw new Error(`Unknown command "${cmd}". Commands: pair, check, devices, start.`);
  if (config.server) config.server = checkServer(config.server);
  await connect(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
