import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listDevices } from "../mobile/devices.js";
import type { Severity } from "../types.js";
import { runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Mobile security beyond reading the app file (OWASP MASVS v2 / MASTG):
 * - MobSF: GLV's own Mobile Security Framework server (docker compose --profile mobsf) scans the
 *   APK or IPA and gives its security scorecard.
 * - Runtime checks on a test phone over adb: what the app writes to the phone's log, what it keeps
 *   in its own storage and on shared storage, whether secret screens can be captured, and (with
 *   Frida on a rooted test phone) whether it has root detection and certificate pinning at all.
 * Only on GLV's own test phones and emulators, with the project's own app.
 */

// ---------------------------------------------------------------------------------------------
// MobSF

const MASVS_BY_SECTION: [RegExp, string][] = [
  [/network|ssl|tls|cleartext|domain/i, "MASVS-NETWORK"],
  [/crypt|cipher|hash|random|key/i, "MASVS-CRYPTO"],
  [/storage|shared ?pref|sqlite|backup|log|clipboard|external/i, "MASVS-STORAGE"],
  [/manifest|permission|exported|intent|activity|provider|webview|deeplink|plist|ats/i, "MASVS-PLATFORM"],
  [/binary|pie|stack|canary|debug|root|jailbreak|tamper|obfuscat|frida/i, "MASVS-RESILIENCE"],
  [/auth|biometric|session|token/i, "MASVS-AUTH"],
  [/privacy|tracker|pii/i, "MASVS-PRIVACY"],
];
export const masvsFor = (text: string) => MASVS_BY_SECTION.find(([re]) => re.test(text))?.[1] ?? "MASVS-CODE";

interface MobsfItem {
  title?: string;
  description?: string;
  section?: string;
}

/** Turns MobSF's scorecard (/api/v1/scorecard) into findings. Pure, for tests. */
export function readScorecard(card: { high?: MobsfItem[]; warning?: MobsfItem[]; info?: MobsfItem[]; security_score?: number }, where: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  const add = (items: MobsfItem[] | undefined, severity: Severity) => {
    for (const it of items ?? []) {
      const title = (it.title ?? "").trim();
      if (!title) continue;
      const masvs = masvsFor(`${it.section ?? ""} ${title}`);
      out.push({
        category: "security",
        rule: `mobsf:${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)}`,
        severity,
        title,
        detail: `${(it.description ?? "").replace(/\s+/g, " ").trim().slice(0, 900)} (MobSF, ${it.section ?? "scan"}; OWASP ${masvs}).`,
        pageUrl: where,
        evidence: `${masvs}: ${it.section ?? ""}`,
        key: `mobsf:${title}`,
      });
    }
  };
  add(card.high, "high");
  add(card.warning, "medium");
  return out;
}

async function mobsf<T>(base: string, p: string, body: FormData | URLSearchParams, signal: AbortSignal): Promise<T> {
  const res = await fetch(`${base}${p}`, { method: "POST", headers: { authorization: process.env.MOBSF_API_KEY ?? "", "x-mobsf-api-key": process.env.MOBSF_API_KEY ?? "" }, body, signal: AbortSignal.any([signal, AbortSignal.timeout(900_000)]) });
  const text = await res.text();
  if (!res.ok) throw new Error(`MobSF ${p} answered ${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

export const mobsfTool: Tool = {
  id: "mobsf",
  name: "MobSF security scan",
  maker: "Mobile Security Framework (open source), on GLV's server",
  description: "Sends the app to GLV's own MobSF server for its full static security scan of Android and iOS apps, and adds its security scorecard to the report, each item mapped to OWASP MASVS.",
  checks: ["Hundreds of MobSF checks of code, manifest or Info.plist, binary, network and crypto", "Each finding mapped to OWASP MASVS v2 (STORAGE, CRYPTO, NETWORK, PLATFORM, RESILIENCE…)", "Runs on GLV's server: the app never leaves it"],
  products: ["android", "ios"],
  category: "security",
  safety: "safe",
  takes: "2 to 8 minutes",
  licence: "GPL-3.0, free",
  homepage: "https://github.com/MobSF/Mobile-Security-Framework-MobSF",
  signedIn: "public",

  async ready() {
    if (!process.env.MOBSF_URL || !process.env.MOBSF_API_KEY) return "No MobSF server: start it with docker compose --profile mobsf and set MOBSF_URL and MOBSF_API_KEY.";
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const base = process.env.MOBSF_URL!.replace(/\/+$/, "");
    const file = ctx.target.file;
    if (!file) throw new Error("This project has no uploaded app.");
    const bytes = await readFile(path.join(ctx.uploadsDir, file));
    const form = new FormData();
    form.append("file", new Blob([bytes]), ctx.target.fileName ?? file);
    ctx.log("MobSF: uploading the app");
    const up = await mobsf<{ hash: string; scan_type: string; file_name: string }>(base, "/api/v1/upload", form, ctx.signal);
    ctx.log("MobSF: scanning");
    await mobsf(base, "/api/v1/scan", new URLSearchParams({ hash: up.hash, scan_type: up.scan_type, file_name: up.file_name }), ctx.signal);
    const card = await mobsf<{ high?: MobsfItem[]; warning?: MobsfItem[]; info?: MobsfItem[]; security_score?: number }>(base, "/api/v1/scorecard", new URLSearchParams({ hash: up.hash }), ctx.signal);
    await writeFile(path.join(ctx.outDir, "tool-mobsf.json"), JSON.stringify(card, null, 1));
    const where = `app://${ctx.app?.id ?? ctx.target.fileName ?? "app"}`;
    const findings = readScorecard(card, where);
    return {
      findings,
      summary: [`MobSF security score ${card.security_score ?? "?"} / 100`, `${card.high?.length ?? 0} high, ${card.warning?.length ?? 0} warnings`],
      reports: [{ file: "tool-mobsf.json", label: "MobSF scorecard (JSON)" }],
      tested: `${ctx.target.fileName ?? file} on MobSF`,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Runtime checks on a test phone (adb, Frida)

const adb = (serial: string, args: string[], timeoutMs = 60_000): Promise<string> =>
  new Promise((resolve) => execFile(process.env.ADB_PATH || "adb", ["-s", serial, ...args], { timeout: timeoutMs, maxBuffer: 20_000_000 }, (_e, out) => resolve(String(out ?? ""))));

/** Secrets and personal data in log lines or stored files. */
export const LEAK_SIGNS: [RegExp, string, Severity][] = [
  [/\b(Bearer\s+[A-Za-z0-9._-]{20,})/, "a sign-in token (Bearer)", "high"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JWT session token", "high"],
  [/\b(password|passwd|pwd|pin)\b["'\s:=>]+[^\s"'<,;]{4,}/i, "a password or PIN", "critical"],
  [/\b(api[_-]?key|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token)\b["'\s:=>]+[A-Za-z0-9._-]{12,}/i, "an API key or token", "high"],
  [/\b\d{4}\s?\d{4}\s?\d{4}\b(?=\D)/, "an Aadhaar-like 12-digit number", "high"],
  [/\b[A-Z]{5}\d{4}[A-Z]\b/, "a PAN number", "high"],
  [/\b(?:\d[ -]?){13,16}\b(?=.*(card|cc|visa|master))/i, "a card number", "critical"],
];

/** Pure: what a log or a stored file gives away. */
export function leaksIn(text: string): { what: string; severity: Severity; sample: string }[] {
  const out: { what: string; severity: Severity; sample: string }[] = [];
  for (const [re, what, severity] of LEAK_SIGNS) {
    const m = text.match(re);
    if (m) out.push({ what, severity, sample: m[0].slice(0, 24) + (m[0].length > 24 ? "…" : "") });
  }
  return out;
}

/** Frida script: which protection libraries the running app has loaded. */
const FRIDA_SCRIPT = `Java.perform(function () {
  var found = { pinning: [], root: [] };
  var pin = ["okhttp3.CertificatePinner", "com.datatheorem.android.trustkit.TrustKit", "com.appmattus.certificatetransparency.CTInterceptorBuilder", "io.flutter.plugins.ssl_pinning"];
  var root = ["com.scottyab.rootbeer.RootBeer", "com.google.android.play.core.integrity.IntegrityManager", "com.google.android.gms.safetynet.SafetyNetClient", "com.noshufou.android.su", "io.github.rootbeer"];
  Java.enumerateLoadedClasses({ onMatch: function (n) {
    pin.forEach(function (p) { if (n.indexOf(p) === 0 && found.pinning.indexOf(p) < 0) found.pinning.push(p); });
    root.forEach(function (p) { if (n.indexOf(p) === 0 && found.root.indexOf(p) < 0) found.root.push(p); });
  }, onComplete: function () { send(JSON.stringify(found)); } });
});`;

export const mobileRuntimeTool: Tool = {
  id: "mobile-runtime",
  name: "Mobile runtime security (MASVS)",
  maker: "GLV Infotech (built in), with adb and Frida",
  description: "Installs and runs the Android app on a GLV test phone and checks what it does at runtime (OWASP MASVS): secrets and personal data written to the phone's log, passwords and tokens stored in plain text, files left on shared storage, secret screens that can be captured, and with Frida whether it has root detection and certificate pinning.",
  checks: [
    "MASVS-STORAGE: tokens, passwords, Aadhaar and PAN in logcat and in the app's own files",
    "MASVS-STORAGE: files left on shared storage other apps can read",
    "MASVS-PLATFORM: sign-in and payment screens without screenshot protection (FLAG_SECURE)",
    "MASVS-RESILIENCE and NETWORK: root detection and certificate pinning present (Frida, rooted test phone)",
    "Only on GLV's own test phones, with the project's own app",
  ],
  products: ["android"],
  category: "security",
  safety: "safe",
  takes: "2 to 5 minutes",
  licence: "GLV's own; adb Apache-2.0; Frida wxWindows Library Licence",
  homepage: "https://mas.owasp.org/MASVS/",
  signedIn: "public",
  needsDevice: true,
  manual: true,

  async ready() {
    if (!(await which(process.env.ADB_PATH || "adb"))) return "adb is not installed on this server.";
    const phones = listDevices().filter((d) => d.platform === "android" && d.udid);
    return phones.length ? null : "No Android test phone with an adb serial is set up (Owner panel > Test phones).";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const device = listDevices().find((d) => d.platform === "android" && d.udid)!;
    const serial = device.udid!;
    const pkg = ctx.app?.id;
    const file = ctx.target.file;
    if (!pkg || !file) throw new Error("The app's id or file is missing, so it cannot be installed.");
    if (serial.includes(":")) await new Promise<void>((ok) => execFile(process.env.ADB_PATH || "adb", ["connect", serial], { timeout: 20_000 }, () => ok()));
    const findings: ToolFinding[] = [];
    const where = `app://${pkg}`;
    const add = (rule: string, severity: Severity, title: string, detail: string, masvs: string, evidence: string) =>
      findings.push({ category: "security", rule, severity, title, detail: `${detail} (OWASP ${masvs}.)`, pageUrl: where, evidence, key: `${rule}:${pkg}` });

    ctx.log(`Runtime security: installing ${pkg} on ${device.name}`);
    if (/\.apk$/.test(file)) await adb(serial, ["install", "-r", "-g", path.join(ctx.uploadsDir, file)], 300_000);
    await adb(serial, ["logcat", "-c"]);
    await adb(serial, ["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
    await new Promise((ok) => setTimeout(ok, 12_000));
    // A few safe taps so the app does some work (the same seed every run).
    await adb(serial, ["shell", "monkey", "-p", pkg, "-s", "42", "--pct-syskeys", "0", "--throttle", "400", "40"], 60_000);
    await new Promise((ok) => setTimeout(ok, 3000));

    const pid = (await adb(serial, ["shell", "pidof", pkg])).trim().split(/\s+/)[0];
    const log = await adb(serial, ["logcat", "-d", ...(pid ? ["--pid", pid] : [])]);
    for (const l of leaksIn(log)) add("runtime:log-leak", l.severity, `The app writes ${l.what} to the phone's log`, "Any app with log access, a USB cable or a bug report can read logcat. Remove the log lines (or strip them from release builds with R8/ProGuard rules for Log.*).", "MASVS-STORAGE-2", `logcat: ${l.sample}`);

    const dump = await adb(serial, ["shell", "dumpsys", "package", pkg]);
    const debuggable = /flags=\[[^\]]*DEBUGGABLE/.test(dump);
    if (debuggable) {
      add("runtime:debuggable", "high", "The installed app is debuggable", "A debuggable build lets anyone with the phone read all its data and attach a debugger. Ship release builds only.", "MASVS-RESILIENCE-2", "DEBUGGABLE flag");
      const files = await adb(serial, ["shell", "run-as", pkg, "sh", "-c", "'find shared_prefs databases files -type f -size -2M 2>/dev/null | head -n 40'"]);
      const prefs = await adb(serial, ["shell", "run-as", pkg, "sh", "-c", "'cat shared_prefs/*.xml 2>/dev/null | head -c 400000'"]);
      for (const l of leaksIn(prefs)) add("runtime:plain-storage", l.severity === "critical" ? "critical" : "high", `The app stores ${l.what} in plain text`, "Shared preferences are a plain file; on a rooted or backed-up phone it can be read. Keep secrets in the Android Keystore (EncryptedSharedPreferences or Jetpack Security).", "MASVS-STORAGE-1", `shared_prefs: ${l.sample}\n${files.split("\n").slice(0, 5).join("\n")}`);
    }
    const external = await adb(serial, ["shell", "ls", "-R", `/sdcard/Android/data/${pkg}`, "/sdcard/Download"]);
    const exposed = external.split("\n").filter((l) => /\.(db|sqlite|json|xml|txt|log|csv|pdf)$/i.test(l.trim())).slice(0, 10);
    if (exposed.length) add("runtime:external-storage", "medium", "The app leaves files on shared storage", "Files on shared storage can be read by other apps on older Android versions and by anyone with a USB cable. Keep private data in the app's internal storage.", "MASVS-STORAGE-1", exposed.join("\n"));

    const windows = await adb(serial, ["shell", "dumpsys", "window", "windows"]);
    const focus = windows.split("\n").find((l) => /mCurrentFocus|mFocusedWindow/.test(l)) ?? "";
    const secure = new RegExp(`${pkg}[\\s\\S]{0,800}fl=[^\\n]*SECURE`).test(windows);
    const askSecret = /(login|signin|sign_in|auth|otp|pin|password|payment|checkout|card|wallet)/i.test(focus);
    if (askSecret && !secure) add("runtime:no-flag-secure", "low", "Secret screens can be captured", "The sign-in or payment screen does not set FLAG_SECURE, so screenshots, screen recordings and the recent-apps preview show what is typed. Set it on screens with passwords, OTPs or card details.", "MASVS-PLATFORM-3", focus.trim());

    const notes: string[] = [];
    const frida = process.env.FRIDA_PATH || "frida";
    if (await which(frida)) {
      const script = path.join(ctx.workDir, "glv-frida.js");
      await writeFile(script, FRIDA_SCRIPT);
      const res = await runProcess(frida, ["-D", serial, "-n", pkg, "-l", script, "-q", "-t", "8"], { signal: ctx.signal, timeoutMs: 60_000 });
      const line = res.stdout.match(/\{"pinning":\[[^\]]*\],"root":\[[^\]]*\]\}/)?.[0];
      if (line) {
        const got = JSON.parse(line) as { pinning: string[]; root: string[] };
        if (!got.root.length) add("runtime:no-root-detection", "low", "No root or integrity detection", "The app runs on a rooted phone without checking. Banking, payment and health apps should use the Play Integrity API (and react on the server) so a tampered phone cannot misuse them.", "MASVS-RESILIENCE-1", "No RootBeer, Play Integrity or SafetyNet classes loaded");
        if (!got.pinning.length) add("runtime:no-pinning", "low", "No certificate pinning", "The app trusts any certificate the phone trusts, so traffic can be read with a user-installed certificate. Pin your API's certificate or public key (network security config pin-set or OkHttp CertificatePinner) for apps that handle money or health data.", "MASVS-NETWORK-2", "No CertificatePinner or TrustKit classes loaded");
      } else notes.push("Frida could not attach (the test phone needs frida-server running as root)");
    } else notes.push("Frida is not installed: root detection and pinning were not checked");
    await adb(serial, ["shell", "am", "force-stop", pkg]);
    return { findings, summary: [`Ran ${pkg} on ${device.name}`, ...notes], tested: `${pkg} at runtime on ${device.name}` };
  },
};
