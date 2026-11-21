import { readFile } from "node:fs/promises";
import { request as playwrightRequest } from "playwright";
import { ALL_IOS_AGENTS as IOS_AGENTS } from "../agents/mobile/index.js";
import { finishSummary } from "./apk.js";
import type { IosContext, IosFacts, IosFramework } from "../agents/mobile/ios-context.js";
import { scoreFindings } from "../runner/score.js";
import type { AppSummary, Category, PageResult, ScanResult } from "../types.js";
import { runEngineAgents } from "./agents.js";
import { isMachO, parseMachO, type MachOInfo } from "./macho.js";
import { parsePlist, parsePlistDict, isDict, str, type PlistDict } from "./plist.js";
import { listZip, readEntry, sizeText, type ZipEntry } from "./zip.js";

export const IPA_CATEGORIES: Category[] = ["security", "functional", "performance"];
const MAX_CODE_BYTES = 250_000_000;
const HEADER_BYTES = 256 * 1024;

export interface IpaScanOptions {
  ipaFile: string;
  /** The name the file was uploaded with, for the report. */
  fileName?: string;
  agents?: string[];
  onProgress?: (message: string) => void;
  /** Where the app's library list (app-sbom.cdx.json) is saved. */
  artifactsDir?: string;
  /** The project's previous test of this app, to list what changed. */
  previous?: { app: AppSummary; at: string };
}

/** The app folder in an IPA (Payload/Shop.app/) or in a zipped .app (Shop.app/). */
export function findAppDir(entries: ZipEntry[]): { dir: string; packaging: IosFacts["packaging"] } | null {
  const apps = entries
    .map((e) => e.name.match(/^(Payload\/)?([^/]+\.app)\/Info\.plist$/))
    .filter((m): m is RegExpMatchArray => !!m && !m[0].startsWith("__MACOSX"));
  if (!apps.length) return null;
  apps.sort((a, b) => Number(!a[1]) - Number(!b[1]) || a[0].length - b[0].length);
  const m = apps[0];
  return { dir: `${m[1] ?? ""}${m[2]}/`, packaging: m[1] ? "ipa" : "app" };
}

/** The XML plist inside a provisioning profile (a signed CMS message that carries it as plain text). */
export function profilePlist(buf: Buffer): PlistDict | undefined {
  const start = buf.indexOf("<?xml");
  const end = buf.indexOf("</plist>", start);
  if (start < 0 || end < 0) return undefined;
  try {
    return parsePlistDict(buf.subarray(start, end + "</plist>".length));
  } catch {
    return undefined;
  }
}

/** The app's embedded frameworks, and whether each brings its own privacy manifest. */
export function findFrameworks(entries: ZipEntry[], appDir: string): IosFramework[] {
  const names = new Map<string, IosFramework>();
  const prefix = `${appDir}Frameworks/`;
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const m = e.name.slice(prefix.length).match(/^([^/]+)\.framework\//);
    if (!m) continue;
    const dir = `${prefix}${m[1]}.framework/`;
    if (!names.has(m[1])) names.set(m[1], { name: m[1], dir, hasPrivacyManifest: false });
  }
  const files = new Set(entries.map((e) => e.name));
  for (const fw of names.values()) {
    fw.binary = files.has(fw.dir + fw.name) ? fw.dir + fw.name : undefined;
    // In the framework, in a resource bundle inside it, or (CocoaPods) in a <Name>_Privacy.bundle in the app.
    fw.hasPrivacyManifest = entries.some(
      (e) =>
        (e.name.startsWith(fw.dir) && e.name.endsWith("/PrivacyInfo.xcprivacy")) ||
        e.name === `${appDir}${fw.name}_Privacy.bundle/PrivacyInfo.xcprivacy` ||
        e.name === `${appDir}${fw.name}.bundle/PrivacyInfo.xcprivacy`,
    );
  }
  return [...names.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Config and code files whose text can hold keys and server addresses. */
const SEARCHABLE = /\.(json|plist|js|jsbundle|txt|env|cfg|conf|ini|xcconfig|properties|strings|html)$/i;

/**
 * Opens an IPA (or a zipped .app): the app folder, Info.plist, the main program's headers and the
 * provisioning profile. The Mac helper's iOS tool uses it too, to know what it is installing.
 */
export function readIpa(ipa: Buffer) {
  const entries = listZip(ipa);
  const found = findAppDir(entries);
  if (!found) {
    throw new Error(
      entries.some((e) => /\.xcarchive\//.test(e.name))
        ? "This is an Xcode archive. Export an IPA from it (Organizer > Distribute App > Development or Ad Hoc), or zip the .app from Products/Applications."
        : "This file has no Payload/<name>.app/Info.plist, so it is not an iOS app. Upload an .ipa, or a zip of the .app.",
    );
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  const read = (name: string, limit?: number) => {
    const e = byName.get(name);
    return e ? readEntry(ipa, e, limit) : undefined;
  };
  const info = parsePlistDict(read(`${found.dir}Info.plist`)!);
  const exe = str(info.CFBundleExecutable) ?? found.dir.replace(/^.*\/?([^/]+)\.app\/$/, "$1");
  const executable = `${found.dir}${exe}`;

  // The main program: its headers always; its text only when it is not encrypted and not huge.
  let binary: MachOInfo | undefined;
  let binaryBuf: Buffer | undefined;
  const exeEntry = byName.get(executable);
  if (exeEntry) {
    binaryBuf = exeEntry.size <= MAX_CODE_BYTES ? readEntry(ipa, exeEntry) : readEntry(ipa, exeEntry, HEADER_BYTES);
    try {
      binary = isMachO(binaryBuf) ? parseMachO(binaryBuf) : undefined;
    } catch {
      binary = undefined;
    }
  }
  const slices = binary?.slices ?? [];
  const facts: IosFacts = {
    bundleId: str(info.CFBundleIdentifier) ?? "unknown.bundle.id",
    name: str(info.CFBundleDisplayName) ?? str(info.CFBundleName) ?? exe,
    version: str(info.CFBundleShortVersionString),
    build: str(info.CFBundleVersion),
    minOS: str(info.MinimumOSVersion) ?? slices.find((s) => s.minOS)?.minOS,
    appDir: found.dir,
    executable,
    packaging: found.packaging,
    simulator: slices.length > 0 && slices.every((s) => s.platform === "ios-simulator" || (!s.platform && /^(x86_64|i386)$/.test(s.arch))),
    encrypted: slices.some((s) => s.encrypted),
  };

  const profileBuf = read(`${found.dir}embedded.mobileprovision`);
  const profile = profileBuf ? profilePlist(profileBuf) : undefined;
  return { entries, found, byName, read, info, exe, executable, exeEntry, binary, binaryBuf, slices, facts, profile };
}

export async function scanIpa(opts: IpaScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const notes: string[] = [];
  log("Unpacking the iOS app");
  const ipa = await readFile(opts.ipaFile);
  const { entries, found, byName, read, info, executable, exeEntry, binary, binaryBuf, slices, facts, profile } = readIpa(ipa);
  let privacy: PlistDict | undefined;
  const privacyBuf = read(`${found.dir}PrivacyInfo.xcprivacy`);
  if (privacyBuf) {
    try {
      const v = parsePlist(privacyBuf);
      privacy = isDict(v) ? v : undefined;
    } catch {
      notes.push("The app's PrivacyInfo.xcprivacy could not be read (it is damaged).");
    }
  }
  const frameworks = findFrameworks(entries, found.dir);

  log(`${facts.bundleId} ${facts.version ?? ""} (${facts.build ?? "?"}), minimum iOS ${facts.minOS ?? "?"}`);
  notes.push(
    `${facts.name}: ${facts.bundleId} version ${facts.version ?? "?"} (${facts.build ?? "?"}), minimum iOS ${facts.minOS ?? "?"}, ${slices.map((s) => s.arch).join(" + ") || "unknown processor"}, ${sizeText(ipa.length)}${
      opts.fileName ? `, from ${opts.fileName}` : ""
    }.`,
  );
  if (facts.simulator) notes.push("This is a Simulator build: it cannot be installed on iPhones or sent to the App Store, but a Mac can run it in the iOS Simulator.");
  if (frameworks.length) notes.push(`${frameworks.length} embedded framework${frameworks.length === 1 ? "" : "s"}: ${frameworks.map((f) => f.name).join(", ")}.`);
  const extensions = new Set(entries.map((e) => e.name.match(new RegExp(`^${found.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}PlugIns/([^/]+)\\.appex/`))?.[1]).filter(Boolean));
  if (extensions.size) notes.push(`${extensions.size} app extension${extensions.size === 1 ? "" : "s"} (widgets, share or notification extensions): ${[...extensions].join(", ")}. Their own settings are not tested yet.`);

  // Program text for symbol searches, and code and config text for key searches.
  let total = 0;
  const programs: IosContext["programs"] = [];
  const strings: IosContext["strings"] = [];
  const add = (list: { file: string; text: string }[], file: string, buf: Buffer) => {
    if (total + buf.length > MAX_CODE_BYTES) return false;
    total += buf.length;
    list.push({ file, text: buf.toString("latin1") });
    return true;
  };
  if (binaryBuf && binary && !facts.encrypted && exeEntry && exeEntry.size <= MAX_CODE_BYTES) {
    add(programs, executable, binaryBuf);
    strings.push(programs[programs.length - 1]);
  }
  for (const fw of frameworks) {
    if (!fw.binary) continue;
    const e = byName.get(fw.binary)!;
    if (e.size > MAX_CODE_BYTES - total) continue;
    const buf = readEntry(ipa, e);
    try {
      if (!isMachO(buf) || parseMachO(buf).slices.some((s) => s.encrypted)) continue;
    } catch {
      continue;
    }
    if (!add(programs, fw.binary, buf)) break;
    // Flutter keeps the app's own Dart code in App.framework, so its text is searched for keys too.
    if (fw.name === "App") strings.push(programs[programs.length - 1]);
  }
  for (const e of entries) {
    if (!e.name.startsWith(found.dir) || !SEARCHABLE.test(e.name)) continue;
    const rel = e.name.slice(found.dir.length);
    // The app's own files, Flutter assets and the React Native bundle; not other frameworks' resources.
    if (rel.startsWith("Frameworks/") && !rel.startsWith("Frameworks/App.framework/flutter_assets/")) continue;
    if (rel.startsWith("_CodeSignature/") || /\.lproj\/.*\.strings$/.test(rel)) continue;
    try {
      if (!add(strings, e.name, readEntry(ipa, e))) break;
    } catch {
      /* unreadable entry: skipped */
    }
  }

  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.3 (app test)",
  });
  try {
    const summary: AppSummary = {
      platform: "ios",
      id: facts.bundleId,
      name: facts.name,
      version: facts.version,
      build: facts.build,
      packaging: facts.packaging,
      minOs: facts.minOS,
      size: ipa.length,
      framework: "Native",
      permissions: Object.keys(info).filter((k) => /^NS\w+UsageDescription$/.test(k)).sort(),
      sdks: [],
      libraries: [],
      servers: [],
      languages: [],
      links: [],
    };
    const entitlements = binaryBuf && exeEntry && exeEntry.size <= MAX_CODE_BYTES ? signedEntitlements(binaryBuf) : undefined;
    const ctx: IosContext = { ipa, entries, facts, info, profile, privacy, binary, programs, frameworks, strings, request, log, note: (m) => notes.push(m), summary, entitlements };
    const selected = opts.agents ? IOS_AGENTS.filter((a) => opts.agents!.includes(a.id)) : IOS_AGENTS.filter((a) => !a.defaultOff);
    const { findings, stats } = await runEngineAgents(selected, ctx, `${found.dir}Info.plist`, log);
    await finishSummary(summary, findings, opts);
    const files = [...new Set(findings.map((f) => f.pageUrl))];
    const pages: PageResult[] = files.map((f) => ({ url: f, status: null, title: f, loadMs: null }));
    const score = scoreFindings(findings, 1, IPA_CATEGORIES, stats);
    log(`Done: ${findings.length} findings`);
    return {
      startUrl: `${facts.bundleId}${facts.version ? ` ${facts.version}` : ""}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      pages,
      findings,
      ...score,
      agentStats: stats,
      notes,
      label: { pages: "Files" },
      complete: true,
      app: summary,
    };
  } finally {
    await request.dispose();
  }
}

/** The entitlements plist signed into a program (its code signature carries it as XML). */
export function signedEntitlements(buf: Buffer): PlistDict | undefined {
  let at = 0;
  for (let n = 0; n < 8; n++) {
    const start = buf.indexOf("<?xml", at);
    if (start < 0) return undefined;
    const end = buf.indexOf("</plist>", start);
    if (end < 0) return undefined;
    const xml = buf.subarray(start, end + 8);
    at = end + 8;
    if (!xml.includes("application-identifier") && !xml.includes("com.apple.developer.")) continue;
    try {
      return parsePlistDict(xml);
    } catch {
      /* not a plist */
    }
  }
  return undefined;
}
