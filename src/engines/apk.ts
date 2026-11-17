import { readFile } from "node:fs/promises";
import { request as playwrightRequest } from "playwright";
import { ANDROID_AGENTS } from "../agents/mobile/android.js";
import type { AndroidComponent, ApkContext, ApkFacts } from "../agents/mobile/context.js";
import { scoreFindings } from "../runner/score.js";
import type { Category, PageResult, ScanResult } from "../types.js";
import { runEngineAgents } from "./agents.js";
import { attrBool, attrNumber, parseAxml, type XmlNode } from "./axml.js";
import { listZip, readEntry, type ZipEntry } from "./zip.js";

export const APK_CATEGORIES: Category[] = ["security", "functional"];
const MAX_CODE_BYTES = 250_000_000;

export interface ApkScanOptions {
  apkFile: string;
  fileName?: string;
  agents?: string[];
  onProgress?: (message: string) => void;
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
  };
}

/** Finds the network security config among the res/ XML files (its name can be shortened by the build). */
function findNetworkConfig(apk: Buffer, entries: ZipEntry[]): ApkFacts["networkConfig"] {
  const xml = entries.filter((e) => e.name.startsWith("res/") && e.name.endsWith(".xml") && e.size < 32_000);
  const likely = xml.filter((e) => /^res\/xml/.test(e.name));
  for (const e of [...likely, ...xml.filter((x) => !likely.includes(x))].slice(0, 3000)) {
    try {
      const node = parseAxml(readEntry(apk, e));
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
  log("Unpacking the APK");
  const apk = await readFile(opts.apkFile);
  const entries = listZip(apk);
  const manifestEntry = entries.find((e) => e.name === "AndroidManifest.xml");
  if (!manifestEntry) {
    throw new Error(
      entries.some((e) => e.name.endsWith(".apk"))
        ? "This looks like an app bundle or split set. Upload the universal APK (bundletool build-apks --mode=universal)."
        : "This file has no AndroidManifest.xml, so it is not an APK.",
    );
  }
  const manifest = parseAxml(readEntry(apk, manifestEntry));
  const facts = manifestFacts(manifest);
  if (facts.usesCleartextTraffic !== undefined || manifest.children.some((c) => c.tag === "application" && c.attrs.networkSecurityConfig)) {
    facts.networkConfig = findNetworkConfig(apk, entries);
  } else {
    facts.networkConfig = findNetworkConfig(apk, entries.filter((e) => /^res\/xml/.test(e.name)));
  }
  log(`${facts.packageName} ${facts.versionName ?? ""} (target API ${facts.targetSdk ?? "?"}, min API ${facts.minSdk ?? "?"})`);
  notes.push(
    `${facts.packageName} version ${facts.versionName ?? "?"} (${facts.versionCode ?? "?"}), target API ${facts.targetSdk ?? "?"}, min API ${facts.minSdk ?? "?"}, ${(apk.length / 1e6).toFixed(1)} MB${
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
    const ctx: ApkContext = { apk, entries, manifest, facts, strings, request, log, note: (m) => notes.push(m) };
    const selected = opts.agents ? ANDROID_AGENTS.filter((a) => opts.agents!.includes(a.id)) : ANDROID_AGENTS.filter((a) => !a.defaultOff);
    const { findings, stats } = await runEngineAgents(selected, ctx, "AndroidManifest.xml", log);
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
    };
  } finally {
    await request.dispose();
  }
}

