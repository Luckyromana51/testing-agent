/*
 * Runs the app on a test phone through Appium (open source, bundled in our Docker image with the
 * Android emulator; Appium on GLV's Mac for iPhone Simulators) and tests it the way a person
 * would: opens it, signs in with the saved login, taps through every screen it can reach (never
 * Pay, Delete, Send or Sign out), and watches for crashes. On each screen it checks labels, tap
 * sizes and text contrast on the real pixels. Then it tries the phone sideways, dark mode, large
 * text, a tablet screen and no internet, measures start time, memory and smoothness, records which
 * servers the app talks to, and runs the project's app journeys.
 */
import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sdkForHost } from "../agents/mobile/sdks.js";
import { appLocation, deviceById, deviceStatus, listDevices, unshareApp, type AppDevice } from "../mobile/devices.js";
import { runJourney, type JourneyRun } from "../mobile/journeys.js";
import { decodePng, type Image } from "../mobile/png.js";
import { TrafficRecorder, type TrafficEvent } from "../mobile/proxy.js";
import { AppRunner, sleep, type AppCrash } from "../mobile/runner.js";
import { checkScreen, describe, findAgain, tapTargets, type ScreenIssue, type UiScreen } from "../mobile/screen.js";
import { WebDriver } from "../mobile/webdriver.js";
import type { AppJourney, Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolImage, ToolOption, ToolOutput } from "./types.js";

/* ---------------------------------------------------------------------------------------------- */
/* What one run finds                                                                              */

export interface ScreenRecord {
  /** The sign-in screen, checked before signing in (it is not visited again afterwards). */
  signIn?: boolean;
  name: string;
  signature: string;
  /** The taps from the first screen that lead here. */
  via: string[];
  file?: string;
  issues: ScreenIssue[];
}

export interface DeviceReport {
  device: string;
  platform: "android" | "ios";
  appId: string;
  screens: ScreenRecord[];
  crashes: AppCrash[];
  /** Buttons that opened another app (a browser, the dialer). */
  leftApp: string[];
  taps: number;
  signIn: "signed-in" | "failed" | "no-login" | "no-sign-in" | "not-tried";
  /** Extra checks: phone sideways, dark mode, large text, tablet, no internet, Back on the first screen. */
  passes: { id: string; label: string; done: boolean; note?: string; issues: ScreenIssue[]; file?: string }[];
  offline?: "ok" | "crash" | "blank";
  perf: { startMs?: number; memoryMb?: number; jankPct?: number; frames?: number };
  traffic: (TrafficEvent & { stage: string })[];
  journeys: JourneyRun[];
  monkey?: { taps: number; crashes: number };
  notes: string[];
}

const RULES: Record<ScreenIssue["rule"], { rule: string; severity: Severity; category: "accessibility" | "functional"; title: (n: number) => string; detail: string }> = {
  unlabeled: {
    rule: "device:unlabeled",
    severity: "high",
    category: "accessibility",
    title: (n) => `${n} button${n === 1 ? " has" : "s have"} no label for screen readers`,
    detail: "TalkBack and VoiceOver say only \"button\" or \"unlabelled\" for these, so blind users cannot tell what they do. Give icon buttons a contentDescription (Android) or accessibilityLabel (iOS), or Semantics(label:) in Flutter.",
  },
  "small-target": {
    rule: "device:small-target",
    severity: "medium",
    category: "accessibility",
    title: (n) => `${n} tap area${n === 1 ? " is" : "s are"} too small`,
    detail: "Google asks for at least 48 × 48 dp and Apple for 44 × 44 points, so people do not miss or hit the wrong thing. Add padding or a minimum size (minWidth/minHeight, .frame(minWidth: 44, minHeight: 44)).",
  },
  "low-contrast": {
    rule: "device:low-contrast",
    severity: "medium",
    category: "accessibility",
    title: (n) => `${n} text${n === 1 ? " is" : "s are"} hard to read (low contrast)`,
    detail: "Measured on the screenshot: the text colour is too close to its background for WCAG 2.2 (4.5:1, or 3:1 for large text). Darken the text or lighten the background.",
  },
  "field-label": {
    rule: "device:field-label",
    severity: "medium",
    category: "accessibility",
    title: (n) => `${n} text field${n === 1 ? " has" : "s have"} no label`,
    detail: "Screen readers cannot say what to type here, and the field is blank once text is typed. Add a hint and a label (android:hint and labelFor, accessibilityLabel, InputDecoration(labelText:)).",
  },
  "duplicate-label": {
    rule: "device:duplicate-label",
    severity: "low",
    category: "accessibility",
    title: (n) => `${n} label${n === 1 ? " is" : "s are"} used for different buttons on one screen`,
    detail: "Screen reader users hear the same name for buttons that do different things. Make each label say what that button does (\"Edit address\", \"Edit phone\").",
  },
  "cut-off": {
    rule: "device:cut-off",
    severity: "medium",
    category: "functional",
    title: (n) => `${n} text${n === 1 ? " runs" : "s run"} off the screen`,
    detail: "Part of the text is outside the screen, so people cannot read it. Let the text wrap (no fixed width, maxLines with ellipsis) or make the row scroll.",
  },
  overlap: {
    rule: "device:overlap",
    severity: "medium",
    category: "functional",
    title: (n) => `${n} place${n === 1 ? " where texts are" : "s where texts are"} drawn over each other`,
    detail: "Two texts sit on top of each other, so neither can be read. Use layouts that grow with their text (ConstraintLayout chains, wrap_content, Stack views) rather than fixed positions.",
  },
};

const PASS_RULE: Record<string, string> = { "large-text": "device:large-text", dark: "device:dark-mode", landscape: "device:landscape", tablet: "device:tablet" };
const PASS_NAME: Record<string, string> = { "large-text": "with the largest text size", dark: "in dark mode", landscape: "with the phone sideways", tablet: "on a tablet screen" };

const list = (items: string[], n = 12) => items.slice(0, n).join("\n") + (items.length > n ? `\n… and ${items.length - n} more` : "");

/** Turns what the run saw into findings. Pure, so the report reads the same on every run of the same app. */
export function deviceFindings(r: DeviceReport): ToolFinding[] {
  const out: ToolFinding[] = [];
  const where = r.appId;
  const crashes = new Map<string, AppCrash[]>();
  for (const c of r.crashes) crashes.set(`${c.type}|${c.reason}`, [...(crashes.get(`${c.type}|${c.reason}`) ?? []), c]);
  for (const group of crashes.values()) {
    const c = group[0];
    const onLaunch = group.some((g) => g.during === "opening the app");
    out.push({
      category: c.type === "anr" ? "performance" : "functional",
      rule: c.type === "anr" ? "device:anr" : "device:crash",
      severity: onLaunch ? "critical" : "high",
      title: c.type === "anr" ? `The app stops answering: ${c.reason.slice(0, 80)}` : c.type === "closed" ? "The app closes by itself" : `The app crashes: ${c.reason.slice(0, 80)}`,
      detail: `${c.type === "anr" ? "Android showed \"App isn't responding\"" : "The app closed"} while ${group.map((g) => g.during).slice(0, 3).join("; ")}. ${c.type === "anr" ? "Move slow work (network, database, big files) off the main thread." : "The stack trace below shows the line to fix; the same crash on users' phones shows in Play Console or Xcode Organizer."}`,
      pageUrl: where,
      evidence: [c.reason, ...c.stack.slice(0, 12)].join("\n"),
    });
  }
  // Screen checks, one finding per kind across all screens (and per extra check).
  const groups = new Map<string, string[]>();
  const put = (key: string, line: string) => groups.set(key, [...(groups.get(key) ?? []), line]);
  for (const s of r.screens) for (const i of s.issues) put(i.rule, `${s.name}: ${i.element}${i.detail ? ` (${i.detail})` : ""}`);
  for (const p of r.passes) for (const i of p.issues) if (i.rule === "cut-off" || i.rule === "overlap" || i.rule === "low-contrast") put(`${p.id}:${i.rule}`, `${i.element}${i.detail ? ` (${i.detail})` : ""}`);
  for (const [key, lines] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [pass, rule] = key.includes(":") ? key.split(":") : [undefined, key];
    const def = RULES[rule as ScreenIssue["rule"]];
    const uniq = [...new Set(lines)].sort();
    if (pass) {
      out.push({
        category: rule === "low-contrast" ? "accessibility" : "functional",
        rule: `${PASS_RULE[pass]}-${rule}`,
        severity: pass === "large-text" ? "medium" : def.severity,
        title: `${def.title(uniq.length)} ${PASS_NAME[pass]}`,
        detail: `${def.detail}${pass === "large-text" ? " About 1 in 4 people make the phone's text bigger: this is what they see." : ""}`,
        pageUrl: where,
        evidence: list(uniq),
      });
    } else out.push({ category: def.category, rule: def.rule, severity: def.severity, title: def.title(uniq.length), detail: def.detail, pageUrl: where, evidence: list(uniq) });
  }
  if (r.offline === "crash") out.push({ category: "functional", rule: "device:offline-crash", severity: "high", title: "The app crashes without internet", detail: "With Wi-Fi and mobile data off the app closed. People open apps in lifts, on trains and with no data left: catch network errors and show a message with a Try again button.", pageUrl: where });
  if (r.offline === "blank") out.push({ category: "functional", rule: "device:offline-blank", severity: "medium", title: "The app shows a blank screen without internet", detail: "With Wi-Fi and mobile data off the first screen has nothing on it. Show what was loaded last time, or a message that says there is no internet and a Try again button.", pageUrl: where });
  const p = r.perf;
  if (p.startMs !== undefined && p.startMs >= 2500) {
    out.push({ category: "performance", rule: "device:slow-start", severity: p.startMs >= 5000 ? "high" : "medium", title: `The app takes ${(p.startMs / 1000).toFixed(1)} s to open`, detail: `Measured from tap to first screen after the app was closed (cold start). Google Play's Android vitals call 5 s or more excessive; aim for under 2 s. Do less in Application.onCreate and the first screen (load data after it shows), and add a Baseline Profile.`, pageUrl: where, evidence: `Cold start: ${p.startMs} ms` });
  }
  if (p.memoryMb !== undefined && p.memoryMb >= 300) out.push({ category: "performance", rule: "device:memory", severity: p.memoryMb >= 500 ? "medium" : "low", title: `The app uses ${Math.round(p.memoryMb)} MB of memory`, detail: "Phones close apps that use this much when the user switches away, and cheaper phones (2–3 GB) slow down. Load pictures at the size they are shown (Glide, Coil, Kingfisher) and free screens you leave.", pageUrl: where, evidence: `${Math.round(p.memoryMb)} MB (PSS) after the test` });
  if (p.jankPct !== undefined && (p.frames ?? 0) >= 30 && p.jankPct >= 10) out.push({ category: "performance", rule: "device:jank", severity: p.jankPct >= 25 ? "medium" : "low", title: `${Math.round(p.jankPct)}% of frames are slow (the app stutters)`, detail: "These frames took too long to draw, so scrolling and animations judder. Move work off the main thread and flatten deep layouts; the Profiler in Android Studio shows which frames.", pageUrl: where, evidence: `${Math.round(p.jankPct)}% of ${p.frames} frames` });
  const plain = r.traffic.filter((t) => !t.secure);
  if (plain.length) {
    const secret = plain.filter((t) => t.sensitive?.length);
    out.push({
      category: "security",
      rule: "device:plain-http",
      severity: secret.length ? "critical" : "high",
      title: secret.length ? "The app sends logins or personal data over plain HTTP" : "The app talks to servers over plain HTTP",
      detail: `${plain.length} call${plain.length === 1 ? "" : "s"} went out unencrypted while the app ran, so anyone on the same Wi-Fi can read ${secret.length ? "the password, token or personal details in them" : "and change them"}. Move these servers to HTTPS.`,
      pageUrl: where,
      evidence: list([...new Set(plain.map((t) => `${t.method} ${t.url}${t.sensitive?.length ? ` (has ${t.sensitive.join(", ")})` : ""}`))].sort(), 10),
    });
  }
  const early = [...new Set(r.traffic.filter((t) => t.stage === "launch").map((t) => t.host))].map((h) => ({ h, sdk: sdkForHost(h) })).filter((x) => x.sdk?.tracker);
  if (early.length) {
    out.push({ category: "security", rule: "device:tracking-before-consent", severity: "medium", title: "The app sends data to trackers as soon as it opens", detail: `Before the user tapped anything, the app contacted ${early.map((e) => e.sdk!.name).join(", ")}. India's DPDP Act and Europe's GDPR need consent before tracking starts: start these SDKs only after the user agrees.`, pageUrl: where, evidence: early.map((e) => `${e.h} (${e.sdk!.name})`).join("\n") });
  }
  if (r.signIn === "failed") out.push({ category: "functional", rule: "device:signin-failed", severity: "medium", title: "Could not sign in to the app with the saved login", detail: "The test typed the saved user name and password on the app's sign-in screen, but the sign-in screen stayed. Check the login on the project, or the app's sign-in. Only screens before sign-in were tested.", pageUrl: where });
  for (const j of r.journeys.filter((x) => !x.ok)) {
    out.push({ category: "functional", rule: "device:journey-failed", severity: "high", title: `App journey "${j.name}" failed at step ${j.failed?.step}`, detail: `Step ${j.failed?.step} (${j.failed?.line}): ${j.failed?.why}. ${j.passed} of ${j.steps} steps passed.`, pageUrl: where, evidence: `${j.failed?.line}: ${j.failed?.why}` });
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* The run                                                                                         */

interface RunOptions {
  maxScreens: number;
  minutes: number;
  passes: boolean;
  monkey: number;
  traffic: boolean;
}

/** A small seeded random number source, so random taps are the same on every run. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export async function exploreApp(
  driver: WebDriver,
  device: AppDevice,
  appId: string,
  opts: RunOptions,
  env: { outDir: string; log: (m: string) => void; signal?: AbortSignal; login?: { username?: string; password?: string }; journeys?: AppJourney[]; recorder?: TrafficRecorder; proxyHost?: string },
): Promise<{ report: DeviceReport; images: ToolImage[] }> {
  const { log, signal } = env;
  const r = new AppRunner(driver, device.platform, appId, log, signal);
  const report: DeviceReport = { device: device.name, platform: device.platform, appId, screens: [], crashes: [], leftApp: [], taps: 0, signIn: "not-tried", passes: [], perf: {}, traffic: [], journeys: [], notes: [] };
  const images: ToolImage[] = [];
  const deadline = Date.now() + opts.minutes * 60_000;
  const timeUp = () => Date.now() > deadline;
  let shots = 0;
  const shot = async (label: string): Promise<{ file?: string; img?: Image; scale: number }> => {
    try {
      const b64 = await driver.screenshot();
      const file = `app-${String(++shots).padStart(2, "0")}.png`;
      const buf = Buffer.from(b64, "base64");
      await writeFile(path.join(env.outDir, file), buf);
      if (images.length < 40) images.push({ file, label });
      let img: Image | undefined;
      try {
        img = decodePng(buf);
      } catch {
        img = undefined;
      }
      return { file, img, scale: img && r.win.width ? img.width / r.win.width : 1 };
    } catch {
      return { scale: 1 };
    }
  };

  await r.init();
  const shell = (cmd: string, args: string[] = [], ms?: number) => r.shell(cmd, args, ms);

  // Traffic: point the phone at the recorder before the app first opens.
  if (env.recorder && env.proxyHost && device.platform === "android") {
    if ((await shell("settings", ["put", "global", "http_proxy", `${env.proxyHost}:${env.recorder.port}`])) === null) env.recorder = undefined;
  } else if (opts.traffic && device.platform === "ios") report.notes.push("Traffic is recorded on Android test phones only (an iOS Simulator uses the Mac's own network settings).");
  else if (opts.traffic && !env.proxyHost) report.notes.push("Traffic was not recorded: set \"This server's address\" for the device in Owner panel > Test phones, so the phone can reach the recorder.");
  if (device.platform === "android") await shell("dumpsys", ["gfxinfo", appId, "reset"]);

  try {
    // Opening the app.
    log(`Opening ${appId} on ${device.name}`);
    await r.relaunch();
    let first = await r.settle();
    if (!(await r.inApp(first))) {
      const c = await r.crashes("opening the app");
      report.crashes.push(...(c.length ? c : [{ type: "closed" as const, reason: "The app closed right after it opened", stack: [], during: "opening the app" }]));
      const s = await shot("Right after opening");
      if (report.crashes[0]) report.crashes[0].screenshot = s.file;
      return { report, images };
    }
    env.recorder?.mark("first screen");

    // Signing in with the saved login, on the first screen or one tap away.
    const hasPassword = (s: UiScreen) => s.elements.some((e) => e.password);
    let signInScreen = hasPassword(first) ? first : undefined;
    if (!signInScreen) {
      const btn = tapTargets(first, r.win).find((e) => /^(sign ?in|log ?in|login|get started)$/i.test(e.spoken.trim()));
      if (btn) {
        await driver.tap(btn.x + btn.width / 2, btn.y + btn.height / 2);
        const next = await r.settle();
        if (hasPassword(next)) signInScreen = next;
        else await r.relaunch();
      }
    }
    if (signInScreen) {
      const { file, img, scale } = await shot(signInScreen.name || "Sign in");
      report.screens.push({ signIn: true, name: signInScreen.name || "Sign in", signature: signInScreen.signature, via: [], file, issues: checkScreen(signInScreen, r.win, r.dp, img, scale) });
    }
    if (!signInScreen) report.signIn = "no-sign-in";
    else if (!env.login?.username || !env.login.password) report.signIn = "no-login";
    else {
      log("Signing in with the saved login");
      const pw = signInScreen.elements.find((e) => e.password)!;
      const user = signInScreen.elements.filter((e) => e.editable && !e.password && e.y < pw.y).sort((a, b) => b.y - a.y)[0];
      const typeInto = async (x: number, y: number, text: string) => {
        await driver.tap(x, y);
        const el = await driver.find(device.platform === "android" ? "//*[@focused='true']" : "//*[@hasKeyboardFocus='true' or @focused='true']");
        if (el) {
          await driver.clear(el);
          await driver.type(el, text);
        }
      };
      if (user) await typeInto(user.x + user.width / 2, user.y + user.height / 2, env.login.username);
      await typeInto(pw.x + pw.width / 2, pw.y + pw.height / 2, env.login.password);
      const now = await r.screen();
      const go = now.elements.filter((e) => e.clickable && !e.editable && e.y > pw.y).find((e) => /(sign ?in|log ?in|login|continue|submit|next)/i.test(e.spoken));
      if (go) await driver.tap(go.x + go.width / 2, go.y + go.height / 2);
      await sleep(1500, signal);
      const after = await r.settle();
      report.signIn = hasPassword(after) ? "failed" : "signed-in";
      log(report.signIn === "signed-in" ? "Signed in" : "Sign-in did not work; testing the screens before sign-in");
    }
    await r.relaunch();
    first = await r.settle();

    // Tapping through the screens.
    const seen = new Set<string>(report.screens.map((x) => x.signature));
    const tried = new Set<string>();
    const record = async (s: UiScreen, via: string[]) => {
      const name = s.name || `Screen ${report.screens.length + 1}`;
      const { file, img, scale } = await shot(name);
      const rec: ScreenRecord = { name, signature: s.signature, via, file, issues: checkScreen(s, r.win, r.dp, img, scale) };
      report.screens.push(rec);
      seen.add(s.signature);
      log(`Screen ${report.screens.length}: ${name}${rec.issues.length ? ` (${rec.issues.length} problems)` : ""}`);
      return rec;
    };
    const goTo = async (via: string[]): Promise<UiScreen | null> => {
      await r.relaunch();
      let s = await r.settle();
      for (const step of via) {
        const el = findAgain(s, step);
        if (!el) return null;
        await driver.tap(el.x + el.width / 2, el.y + el.height / 2);
        s = await r.settle();
      }
      return s;
    };
    const visit = async (s: UiScreen, rec: ScreenRecord, depth: number): Promise<void> => {
      for (const target of tapTargets(s, r.win)) {
        if (timeUp() || report.taps >= opts.maxScreens * 6) return;
        const d = describe(target);
        const key = `${s.signature}|${d}`;
        if (tried.has(key)) continue;
        tried.add(key);
        report.taps++;
        env.recorder?.mark(`after tapping on ${rec.name}`);
        await driver.tap(target.x + target.width / 2, target.y + target.height / 2);
        let next = await r.settle();
        if (!(await r.inApp(next))) {
          const c = await r.crashes(`tapping ${d} on "${rec.name}"`);
          if (c.length) {
            const pic = await shot(`Crash after tapping ${d}`);
            c[0].screenshot = pic.file;
            report.crashes.push(...c);
          } else report.leftApp.push(`${d} on "${rec.name}"`);
          const back = await goTo(rec.via);
          if (!back) return;
          s = back;
          continue;
        }
        if (next.signature === s.signature) continue;
        if (!seen.has(next.signature) && report.screens.length < opts.maxScreens && depth < 6) {
          const child = await record(next, [...rec.via, d]);
          await visit(next, child, depth + 1);
          if (timeUp()) return;
        }
        await driver.back().catch(() => {});
        next = await r.settle();
        if (!(await r.inApp(next)) || next.signature !== s.signature) {
          const back = await goTo(rec.via);
          if (!back || back.signature !== s.signature) return;
          next = back;
        }
        s = next;
      }
    };
    const home = await record(first, []);
    await visit(first, home, 0);
    if (timeUp()) report.notes.push(`Stopped tapping after ${opts.minutes} minutes; raise the time limit to reach more screens.`);
    log(`Tapped ${report.taps} times on ${report.screens.length} screens`);

    // Random safe taps (a monkey test), the same on every run.
    if (opts.monkey > 0 && !timeUp()) {
      log(`Random taps: ${opts.monkey}`);
      const rand = seeded(42);
      let crashes = 0;
      await r.relaunch();
      let s = await r.settle();
      for (let i = 0; i < opts.monkey && !timeUp(); i++) {
        const targets = tapTargets(s, r.win);
        if (!targets.length || rand() < 0.1) await driver.back().catch(() => {});
        else {
          const t = targets[Math.floor(rand() * targets.length)];
          await driver.tap(t.x + t.width / 2, t.y + t.height / 2);
        }
        await sleep(250, signal);
        s = await r.screen();
        if (!(await r.inApp(s))) {
          const c = await r.crashes(`random tap ${i + 1}`);
          crashes += c.length;
          report.crashes.push(...c);
          await r.relaunch();
          s = await r.settle();
        }
      }
      report.monkey = { taps: opts.monkey, crashes };
    }

    // Extra checks on the first screens.
    if (opts.passes && !timeUp()) {
      const few = report.screens.filter((x) => !x.signIn).slice(0, 6);
      /** Runs one extra check: on() switches it on, then each screen is opened (and each() runs on it), then off(). */
      const pass = async (id: string, label: string, on: () => Promise<boolean>, off: () => Promise<unknown>, screens = few, each?: () => Promise<unknown>) => {
        const p: DeviceReport["passes"][number] = { id, label, done: false, issues: [] };
        report.passes.push(p);
        if (timeUp()) return (p.note = "skipped: time limit");
        if (!(await on())) return (p.note = device.platform === "android" ? "needs adb shell in Appium" : "not available on iOS here");
        try {
          for (const sc of screens) {
            if (each) await driver.setOrientation("PORTRAIT").catch(() => {});
            let s = sc.via.length ? await goTo(sc.via) : (await r.relaunch(), await r.settle());
            if (!s) continue;
            if (each) {
              await each();
              s = await r.settle();
            }
            if (!(await r.inApp(s))) {
              const c = await r.crashes(`opening "${sc.name}" ${label.toLowerCase()}`);
              report.crashes.push(...(c.length ? c : [{ type: "closed" as const, reason: `The app closed ${label.toLowerCase()}`, stack: [], during: `opening "${sc.name}" ${label.toLowerCase()}` }]));
              continue;
            }
            const win = id === "landscape" || id === "tablet" ? await driver.windowRect().catch(() => r.win) : r.win;
            const pic = sc === screens[0] ? await shot(`${sc.name}, ${label.toLowerCase()}`) : { scale: 1 as number, img: undefined, file: undefined };
            if (pic.file) p.file = pic.file;
            p.issues.push(...checkScreen(s, win, r.dp, id === "dark" ? pic.img : undefined, pic.scale).filter((i) => (id === "dark" ? i.rule === "low-contrast" : i.rule === "cut-off" || i.rule === "overlap")).map((i) => ({ ...i, element: `${sc.name}: ${i.element}` })));
          }
          p.done = true;
        } finally {
          await off();
        }
      };
      const android = device.platform === "android";
      await pass(
        "landscape",
        "Phone sideways",
        // Turned on each screen (not before opening it), the way a person turns the phone.
        async () => (await driver.setOrientation("PORTRAIT").then(() => true).catch(() => false)),
        () => driver.setOrientation("PORTRAIT").catch(() => {}),
        few,
        () => driver.setOrientation("LANDSCAPE"),
      );
      await pass(
        "dark",
        "Dark mode",
        async () => (android ? (await shell("cmd", ["uimode", "night", "yes"])) !== null : await driver.mobile("setAppearance", { style: "dark" }).then(() => true).catch(() => false)),
        () => (android ? shell("cmd", ["uimode", "night", "no"]) : driver.mobile("setAppearance", { style: "light" }).catch(() => {})),
        few.slice(0, 2),
      );
      if (android) {
        await pass(
          "large-text",
          "Largest text",
          async () => (await shell("settings", ["put", "system", "font_scale", "1.5"])) !== null,
          () => shell("settings", ["put", "system", "font_scale", "1.0"]),
        );
        await pass(
          "tablet",
          "Tablet screen",
          async () => (await shell("wm", ["size", "1600x2560"])) !== null && (await shell("wm", ["density", "320"])) !== null,
          async () => {
            await shell("wm", ["size", "reset"]);
            await shell("wm", ["density", "reset"]);
          },
          few.slice(0, 1),
        );
        // No internet: Wi-Fi and mobile data off, then open the app again.
        const p: DeviceReport["passes"][number] = { id: "offline", label: "No internet", done: false, issues: [] };
        report.passes.push(p);
        if (!timeUp() && (await shell("svc", ["wifi", "disable"])) !== null) {
          try {
            await shell("svc", ["data", "disable"]);
            await r.relaunch();
            await sleep(2500, signal);
            const s = await r.screen();
            if (!(await r.inApp(s))) {
              const c = await r.crashes("opening the app without internet");
              report.crashes.push(...(c.length ? c : [{ type: "closed" as const, reason: "The app closed without internet", stack: [], during: "opening the app without internet" }]));
              report.offline = "crash";
            } else {
              report.offline = s.elements.some((e) => e.text || e.desc) ? "ok" : "blank";
              p.file = (await shot("No internet")).file;
            }
            p.done = true;
          } finally {
            await shell("svc", ["wifi", "enable"]);
            await shell("svc", ["data", "enable"]);
          }
        } else p.note = timeUp() ? "skipped: time limit" : "needs adb shell in Appium";
      }
      // Back on the first screen must leave the app, not crash it.
      await r.relaunch();
      await r.settle();
      await driver.back().catch(() => {});
      await sleep(800, signal);
      const c = await r.crashes("pressing Back on the first screen");
      report.crashes.push(...c);
      report.passes.push({ id: "back", label: "Back on the first screen", done: true, issues: [] });
    }

    // App journeys.
    for (const j of env.journeys ?? []) {
      if (timeUp()) {
        report.notes.push(`App journey "${j.name}" was not run: time limit.`);
        continue;
      }
      log(`App journey: ${j.name}`);
      const res = await runJourney(r, j, env.login, async (label) => (await shot(label)).file);
      report.journeys.push(res);
    }

    // Speed and memory (Android).
    if (device.platform === "android" && r.shellOk) {
      const gfx = await shell("dumpsys", ["gfxinfo", appId]);
      const total = Number(gfx?.match(/Total frames rendered:\s*(\d+)/)?.[1]);
      const janky = gfx?.match(/Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/);
      if (total && janky) report.perf = { ...report.perf, frames: total, jankPct: Number(janky[2]) };
      const mem = await shell("dumpsys", ["meminfo", appId]);
      const kb = Number(mem?.match(/TOTAL PSS:\s*(\d+)/)?.[1] ?? mem?.match(/^\s*TOTAL\s+(\d+)/m)?.[1]);
      if (kb) report.perf.memoryMb = kb / 1024;
      const comp = (await shell("cmd", ["package", "resolve-activity", "--brief", "-c", "android.intent.category.LAUNCHER", appId]))?.trim().split("\n").pop()?.trim();
      if (comp && comp.includes("/")) {
        const times: number[] = [];
        for (let i = 0; i < 2; i++) {
          await shell("am", ["force-stop", appId]);
          await sleep(500, signal);
          const out = await shell("am", ["start", "-W", "-n", comp]);
          const t = Number(out?.match(/TotalTime:\s*(\d+)/)?.[1]);
          if (t) times.push(t);
        }
        if (times.length) report.perf.startMs = Math.min(...times);
      }
    }
  } finally {
    if (env.recorder && device.platform === "android") await shell("settings", ["put", "global", "http_proxy", ":0"]).catch(() => null);
  }
  if (env.recorder) report.traffic = env.recorder.events.map((e) => ({ ...e, stage: env.recorder!.stageAt(e.at) === "launch" ? "launch" : "after" }));
  return { report, images };
}

/* ---------------------------------------------------------------------------------------------- */
/* The tool                                                                                        */

function deviceOptions(): ToolOption {
  const devices = listDevices();
  return {
    id: "device",
    label: "Test phone",
    hint: devices.length ? "Add phones in Owner panel > Test phones." : "No test phone yet: add one in Owner panel > Test phones.",
    choices: [{ value: "auto", label: "The first ready phone for this app" }, ...devices.map((d) => ({ value: d.id, label: `${d.name} (${d.platform === "android" ? "Android" : "iOS"})` }))],
    default: "auto",
  };
}

async function pickDevice(platform: "android" | "ios", choice: string, signal?: AbortSignal): Promise<AppDevice> {
  if (choice && choice !== "auto") {
    const d = deviceById(choice);
    if (!d) throw new Error("The chosen test phone was removed: pick another in the test's tools.");
    if (d.platform !== platform) throw new Error(`${d.name} is an ${d.platform === "android" ? "Android" : "iOS"} phone, but this is an ${platform === "android" ? "Android" : "iOS"} app.`);
    const why = await deviceStatus(d, signal);
    if (why) throw new Error(`${d.name} is not ready: ${why}`);
    return d;
  }
  const mine = listDevices().filter((d) => d.platform === platform);
  if (!mine.length) throw new Error(`No ${platform === "android" ? "Android" : "iOS"} test phone is set up: add one in Owner panel > Test phones${platform === "android" ? ", or start the built-in emulator (docker compose --profile android up -d)" : " (Appium on the Mac with the XCUITest driver)"}.`);
  const reasons: string[] = [];
  for (const d of mine) {
    const why = await deviceStatus(d, signal);
    if (!why) return d;
    reasons.push(`${d.name}: ${why}`);
  }
  throw new Error(`No test phone is ready. ${reasons.join(" ")}`);
}

export function capabilitiesFor(d: AppDevice, app: string): Record<string, unknown> {
  const common = {
    "appium:app": app,
    "appium:newCommandTimeout": 300,
    "appium:autoLaunch": false,
    ...(d.udid ? { "appium:udid": d.udid } : {}),
    ...(d.platformVersion ? { "appium:platformVersion": d.platformVersion } : {}),
  };
  if (d.platform === "android") {
    return { platformName: "Android", "appium:automationName": "UiAutomator2", "appium:deviceName": d.deviceName ?? d.name, "appium:autoGrantPermissions": true, "appium:noSign": true, "appium:enforceAppInstall": true, "appium:uiautomator2ServerInstallTimeout": 120_000, "appium:adbExecTimeout": 60_000, ...common };
  }
  return { platformName: "iOS", "appium:automationName": "XCUITest", "appium:deviceName": d.deviceName ?? "iPhone 16", "appium:autoAcceptAlerts": true, "appium:wdaLaunchTimeout": 240_000, ...common };
}

export const appiumTool: Tool = {
  id: "appium",
  name: "Run on a test phone (Appium)",
  maker: "OpenJS Foundation (Appium), with GLV's own explorer",
  description:
    "Installs the app on a test phone (the Android emulator in our Docker setup, an iPhone Simulator on the Mac, or a real phone), opens it, signs in with the saved login and taps through every screen it can reach, never Pay, Delete, Send or Sign out. It watches for crashes, checks each screen for screen-reader labels, tap sizes and text contrast, tries the phone sideways, dark mode, large text, a tablet and no internet, measures start time, memory and smoothness, records which servers the app talks to, and runs the project's app journeys.",
  checks: [
    "Crashes and \"not responding\", with the stack trace",
    "Every screen it can reach, with a screenshot",
    "Labels for TalkBack and VoiceOver, tap sizes, text contrast on the real pixels",
    "Sideways, dark mode, largest text, tablet screen, no internet",
    "Cold start time, memory, slow frames (Android)",
    "Plain-HTTP calls and trackers that start before consent (Android traffic recorder)",
    "The project's app journeys, step by step",
  ],
  products: ["android", "ios"],
  category: "functional",
  safety: "safe",
  takes: "about 5 to 15 minutes",
  licence: "Apache-2.0",
  homepage: "https://appium.io",
  signedIn: "uses-login",
  needsDevice: true,
  get options(): ToolOption[] {
    return [
      deviceOptions(),
      { id: "screens", label: "Screens to visit", choices: ["10", "20", "40"].map((v) => ({ value: v, label: `Up to ${v}` })), default: "20" },
      { id: "minutes", label: "Time limit", choices: ["5", "10", "20"].map((v) => ({ value: v, label: `${v} minutes` })), default: "10" },
      { id: "passes", label: "Extra checks", hint: "Sideways, dark mode, largest text, tablet, no internet.", choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }], default: "on" },
      { id: "monkey", label: "Random taps (monkey test)", hint: "Safe buttons only, the same taps every run.", choices: [{ value: "0", label: "Off" }, { value: "100", label: "100 taps" }, { value: "500", label: "500 taps" }], default: "0" },
      { id: "traffic", label: "Record the app's traffic", hint: "Android: the phone goes through GLV's recorder; HTTPS stays encrypted.", choices: [{ value: "on", label: "On" }, { value: "off", label: "Off" }], default: "on" },
    ];
  },
  async ready() {
    const devices = listDevices();
    if (!devices.length) return "No test phone is set up: add one in Owner panel > Test phones, or start the built-in Android emulator.";
    for (const d of devices) if (!(await deviceStatus(d))) return null;
    return `No test phone is answering (${devices.map((d) => d.name).join(", ")}).`;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const platform = ctx.product === "ios" ? "ios" : "android";
    const file = ctx.target.file;
    if (!file || !/^[0-9a-f-]{36}\.(apk|aab|apks|xapk|ipa|zip)$/.test(file)) throw new Error("This project has no uploaded app.");
    if (file.endsWith(".xapk")) throw new Error("Appium cannot install an .xapk: upload the APK (or the .apks split set from bundletool).");
    const appId = ctx.app?.id;
    if (!appId) throw new Error("The app's id could not be read from the file, so the phone cannot open it.");
    const device = await pickDevice(platform, ctx.options.device, ctx.signal);
    const where = appLocation(device, path.join(ctx.uploadsDir, file), ctx.target.fileName ?? file);
    let recorder: TrafficRecorder | undefined;
    let proxyHost: string | undefined;
    if (ctx.options.traffic !== "off" && platform === "android") {
      const server = device.serverAddress || process.env.APP_SERVER_ADDRESS;
      if (server) {
        recorder = new TrafficRecorder();
        await recorder.listen(Number(process.env.APP_PROXY_PORT || 8899)).catch(() => recorder!.listen(0));
        // The phone may not know this network's names (the emulator's "testing-agent"): give it the address.
        const name = new URL(server).hostname.replace(/^\[|\]$/g, "");
        proxyHost = await lookup(name).then((r) => r.address, () => name);
      }
    }
    // The built-in emulator: adb may have tried before the emulator finished starting.
    if (device.builtIn && process.env.APPIUM_LOCAL === "1" && device.udid?.includes(":")) {
      await new Promise<void>((resolve) => execFile("adb", ["connect", device.udid!], { timeout: 20_000 }, () => resolve()));
    }
    ctx.log(`Installing the app on ${device.name}`);
    let driver: WebDriver | undefined;
    try {
      driver = await WebDriver.start(device.appiumUrl, capabilitiesFor(device, where.app), { signal: ctx.signal, timeoutMs: 600_000 });
      const { report, images } = await exploreApp(
        driver,
        device,
        appId,
        { maxScreens: Number(ctx.options.screens) || 20, minutes: Number(ctx.options.minutes) || 10, passes: ctx.options.passes !== "off", monkey: Number(ctx.options.monkey) || 0, traffic: ctx.options.traffic !== "off" },
        {
          outDir: ctx.outDir,
          log: ctx.log,
          signal: ctx.signal,
          login: ctx.login?.kind === "app" || ctx.login?.kind === "web" ? { username: ctx.login.username, password: ctx.login.password } : undefined,
          journeys: ctx.appJourneys,
          recorder,
          proxyHost,
        },
      );
      await writeFile(path.join(ctx.outDir, "tool-appium.json"), JSON.stringify(report, null, 1));
      return deviceOutput(report, images);
    } finally {
      await driver?.quit();
      await recorder?.close();
      if (where.shared) unshareApp(where.app);
    }
  },
};

/** The tool's section of the report: summary lines, the screens table, pictures and findings. */
export function deviceOutput(report: DeviceReport, images: ToolImage[]): ToolOutput {
  const p = report.perf;
  const servers = [...new Set(report.traffic.map((t) => t.host))].sort();
  const done = report.passes.filter((x) => x.done).map((x) => x.label);
  const skipped = report.passes.filter((x) => !x.done).map((x) => `${x.label} (${x.note})`);
  const summary = [
    `${report.screens.length} screen${report.screens.length === 1 ? "" : "s"} visited with ${report.taps} taps on ${report.device}`,
    report.crashes.length ? (report.crashes.length === 1 ? "1 crash or freeze" : `${report.crashes.length} crashes or freezes`) : "No crashes",
    ...(p.startMs !== undefined ? [`Opens in ${(p.startMs / 1000).toFixed(1)} s (cold start)`] : []),
    ...(p.memoryMb !== undefined ? [`Memory ${Math.round(p.memoryMb)} MB`] : []),
    ...(p.jankPct !== undefined ? [`${p.jankPct}% slow frames of ${p.frames}`] : []),
    { "signed-in": "Signed in with the saved login", failed: "Could not sign in with the saved login", "no-login": "The app has a sign-in screen: save a login on the project to test behind it", "no-sign-in": "No sign-in screen found", "not-tried": "" }[report.signIn],
    ...(done.length ? [`Extra checks: ${done.join(", ")}`] : []),
    ...(skipped.length ? [`Not done: ${skipped.join(", ")}`] : []),
    ...(servers.length ? [`Talked to ${servers.length} server${servers.length === 1 ? "" : "s"}: ${servers.slice(0, 6).join(", ")}${servers.length > 6 ? "…" : ""}`] : []),
    ...(report.journeys.length ? [`App journeys: ${report.journeys.filter((j) => j.ok).length} of ${report.journeys.length} passed`] : []),
    ...(report.monkey ? [`Random taps: ${report.monkey.taps}, ${report.monkey.crashes} crash${report.monkey.crashes === 1 ? "" : "es"}`] : []),
    ...(report.leftApp.length ? [`Opened another app: ${report.leftApp.slice(0, 3).join("; ")}`] : []),
    ...report.notes,
  ].filter(Boolean);
  return {
    findings: deviceFindings(report),
    images,
    summary,
    tested: `${report.appId} on ${report.device}`,
    reports: [{ file: "tool-appium.json", label: "Test phone run (JSON)" }],
    table: {
      title: "Screens",
      columns: ["Screen", "How to get there", "Problems"],
      rows: report.screens.map((s) => [s.name, s.signIn ? "Sign-in screen" : s.via.length ? s.via.join(" › ") : "First screen", String(s.issues.length)]),
    },
  };
}
