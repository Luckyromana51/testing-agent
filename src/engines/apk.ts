import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { request as playwrightRequest } from "playwright";
import { ALL_ANDROID_AGENTS as ANDROID_AGENTS } from "../agents/mobile/index.js";
import { cycloneDx } from "../agents/mobile/android-extra.js";
import { compareApps } from "../agents/mobile/shared.js";
import type { AndroidComponent, ApkContext, ApkFacts } from "../agents/mobile/context.js";
import { scoreFindings } from "../runner/score.js";
import type { AppSummary, Category, PageResult, ScanResult } from "../types.js";
import { runEngineAgents } from "./agents.js";
import { attrBool, attrNumber, type XmlNode } from "./axml.js";
import { openAndroidPackage, parseAndroidXml } from "./aab.js";
import { listZip, readEntry, sizeText, type ZipEntry } from "./zip.js";

export const APK_CATEGORIES: Category[] = ["security", "functional", "performance"];
const MAX_CODE_BYTES = 250_000_000;

export interface ApkScanOptions {
  apkFile: string;
  fileName?: string;
  agents?: string[];
  onProgress?: (message: string) => void;
  /** Where the app's library list (app-sbom.cdx.json) is saved. */
  artifactsDir?: string;
  /** The project's previous test of this app, to list what changed. */
  previous?: { app: AppSummary; at: string };
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Pulls the facts the agents need out of the parsed manifest. */
export function manifestFacts(manifest: XmlNode): ApkFacts {
  const packageName = str(manifest.attrs.package) ?? "unknown";
  const sdk = manifest.children.find((c) => c.tag === "uses-sdk");
  const app = manifest.children.find((c) => c.tag === "application");
  const targetSdk = attrNumber(sdk?.attrs.targetSdkVersion) ?? attrNumber(sdk?.attrs.minSdkVersion);
  const definedPermissions = new Map<string, number>();
  for (const p of manifest.children.filter((c) => c.tag === "permission")) {
    const name = str(p.attrs.name);
    if (name) definedPermissions.set(name, attrNumber(p.attrs.protectionLevel) ?? 0);
  }
  const components: AndroidComponent[] = [];
  for (const node of app?.children ?? []) {
    const kind = node.tag as AndroidComponent["kind"];
    if (!["activity", "activity-alias", "service", "receiver", "provider"].includes(kind)) continue;
    const filters = node.children.filter((c) => c.tag === "intent-filter");
    const pick = (tag: string, attr: string) =>
      filters.flatMap((f) => f.children.filter((c) => c.tag === tag).map((c) => str(c.attrs[attr]) ?? "")).filter(Boolean);
    const explicit = attrBool(node.attrs.exported);
    // Defaults before Android 12: exported when there is an intent filter; providers exported before API 17.
    const implicit = filters.length > 0 || (kind === "provider" && (targetSdk ?? 0) < 17);
    let name = str(node.attrs.name) ?? "";
    if (name && !name.includes(".")) name = `.${name}`;
    components.push({
      kind,
      name,
      exported: explicit ?? implicit,
      exportedExplicit: explicit !== undefined,
      permission: str(node.attrs.permission) ?? str(app?.attrs.permission),
      readPermission: str(node.attrs.readPermission),
      writePermission: str(node.attrs.writePermission),
      actions: pick("action", "name"),
      categories: pick("category", "name"),
      schemes: pick("data", "scheme"),
      hosts: pick("data", "host"),
      autoVerify: filters.some((f) => attrBool(f.attrs.autoVerify) === true),
    });
  }
  return {
    packageName,
    versionName: str(manifest.attrs.versionName),
    versionCode: attrNumber(manifest.attrs.versionCode),
    minSdk: attrNumber(sdk?.attrs.minSdkVersion),
    targetSdk,
    debuggable: attrBool(app?.attrs.debuggable) === true,
    testOnly: attrBool(app?.attrs.testOnly) === true,
    allowBackup: attrBool(app?.attrs.allowBackup),
    hasBackupRules: Boolean(app?.attrs.fullBackupContent || app?.attrs.dataExtractionRules),
    usesCleartextTraffic: attrBool(app?.attrs.usesCleartextTraffic),
    permissions: manifest.children
      .filter((c) => c.tag === "uses-permission" || c.tag === "uses-permission-sdk-23")
      .map((c) => str(c.attrs.name) ?? "")
      .filter(Boolean),
    definedPermissions,
    components,
    hasIcon: Boolean(app?.attrs.icon),
    hasLabel: Boolean(app?.attrs.label),
  };
}

/** Finds the network security config among the res/ XML files (its name can be shortened by the build). */
function findNetworkConfig(apk: Buffer, entries: ZipEntry[]): ApkFacts["networkConfig"] {
  const xml = entries.filter((e) => e.name.startsWith("res/") && e.name.endsWith(".xml") && e.size < 32_000);
  const likely = xml.filter((e) => /^res\/xml/.test(e.name));
  for (const e of [...likely, ...xml.filter((x) => !likely.includes(x))].slice(0, 3000)) {
    try {
      const node = parseAndroidXml(readEntry(apk, e));
      if (node.tag === "network-security-config") return { node, file: e.name };
    } catch {
      /* not binary XML */
    }
  }
  return undefined;
}

/** Tests an Android app from its APK file, without installing or running it. */
export async function scanApk(opts: ApkScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const notes: string[] = [];
  log("Unpacking the app");
  const pkg = openAndroidPackage(await readFile(opts.apkFile));
  const apk = pkg.buf;
  const entries = pkg.entries;
  notes.push(...pkg.notes);
  const manifestEntry = entries.find((e) => e.name === "AndroidManifest.xml")!;
  const manifest = parseAndroidXml(readEntry(apk, manifestEntry));
  const facts = manifestFacts(manifest);
  facts.packaging = pkg.packaging;
  if (facts.usesCleartextTraffic !== undefined || manifest.children.some((c) => c.tag === "application" && c.attrs.networkSecurityConfig)) {
    facts.networkConfig = findNetworkConfig(apk, entries);
  } else {
    facts.networkConfig = findNetworkConfig(apk, entries.filter((e) => /^res\/xml/.test(e.name)));
  }
  log(`${facts.packageName} ${facts.versionName ?? ""} (target API ${facts.targetSdk ?? "?"}, min API ${facts.minSdk ?? "?"})`);
  notes.push(
    `${facts.packageName} version ${facts.versionName ?? "?"} (${facts.versionCode ?? "?"}), target API ${facts.targetSdk ?? "?"}, min API ${facts.minSdk ?? "?"}, ${sizeText(apk.length)}${
      opts.fileName ? `, from ${opts.fileName}` : ""
    }.`,
  );

  // Code to search: Java/Kotlin (dex), React Native (JS bundle), Flutter (libapp.so), and config files in assets.
  const strings: ApkContext["strings"] = [];
  let total = 0;
  const code = entries.filter(
    (e) =>
      /^classes\d*\.dex$/.test(e.name) ||
      /^assets\/(index\.android\.bundle|.*\.(js|json|properties|xml|txt|env|cfg|conf|ini|plist))$/i.test(e.name) ||
      /^lib\/arm64-v8a\/libapp\.so$/.test(e.name) ||
      e.name === "res/raw/google_services.json",
  );
  for (const e of code) {
    if (total + e.size > MAX_CODE_BYTES) break;
    try {
      const buf = readEntry(apk, e);
      total += buf.length;
      strings.push({ file: e.name, text: buf.toString("latin1") });
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
      platform: "android",
      id: facts.packageName,
      version: facts.versionName,
      build: facts.versionCode !== undefined ? String(facts.versionCode) : undefined,
      packaging: pkg.packaging,
      minOs: facts.minSdk !== undefined ? String(facts.minSdk) : undefined,
      target: facts.targetSdk !== undefined ? String(facts.targetSdk) : undefined,
      size: apk.length,
      framework: "Native",
      permissions: [...facts.permissions].sort(),
      sdks: [],
      libraries: [],
      servers: [],
      languages: [],
      links: [],
    };
    const ctx: ApkContext = { apk, entries, manifest, facts, strings, request, log, note: (m) => notes.push(m), summary };
    const selected = opts.agents ? ANDROID_AGENTS.filter((a) => opts.agents!.includes(a.id)) : ANDROID_AGENTS.filter((a) => !a.defaultOff);
    const { findings, stats } = await runEngineAgents(selected, ctx, "AndroidManifest.xml", log);
    await finishSummary(summary, findings, opts);
    const files = [...new Set(findings.map((f) => f.pageUrl))];
    const pages: PageResult[] = files.map((f) => ({ url: f, status: null, title: f, loadMs: null }));
    const score = scoreFindings(findings, 1, APK_CATEGORIES, stats);
    log(`Done: ${findings.length} findings`);
    return {
      startUrl: `${facts.packageName}${facts.versionName ? ` ${facts.versionName}` : ""}`,
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


/** Compares with the previous upload and saves the library list. Shared with the iOS engine. */
export async function finishSummary(summary: AppSummary, findings: ScanResult["findings"], opts: { artifactsDir?: string; previous?: { app: AppSummary; at: string } }) {
  if (opts.previous?.app && opts.previous.app.platform === summary.platform) {
    const since = new Date(opts.previous.at).toISOString().slice(0, 10);
    const diff = compareApps(opts.previous.app, summary, `on ${since}`);
    summary.changes = { since: opts.previous.at, version: opts.previous.app.version, lines: diff.lines };
    for (const f of diff.findings) f.agent ??= `${summary.platform}.libraries`;
    findings.push(...diff.findings);
  }
  if (opts.artifactsDir && summary.libraries.length) {
    await mkdir(opts.artifactsDir, { recursive: true });
    await writeFile(path.join(opts.artifactsDir, "app-sbom.cdx.json"), cycloneDx(summary, summary.libraries));
  }
}
