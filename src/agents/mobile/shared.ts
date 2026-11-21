/*
 * Checks that work the same on Android and iOS apps: which framework the app is built with (and
 * that framework's own release mistakes), app size, the servers named in the code, and what changed
 * since the last upload. Every check reads the uploaded file; the server checks only open each
 * server's home page (GET), like a visitor.
 */
import { createHash } from "node:crypto";
import type { APIRequestContext } from "playwright";
import { finding } from "../../runner/finding.js";
import type { AppSummary, Category, Finding, Severity } from "../../types.js";
import { sizeText } from "../../engines/zip.js";

export interface AppFile {
  /** Path inside the app: for Android the APK path, for iOS the path inside the .app folder. */
  name: string;
  size: number;
}

export const addFinding = (out: Finding[], rule: string, severity: Severity, title: string, detail: string, pageUrl: string, evidence?: string, category: Category = "security") =>
  out.push(finding({ category, rule, severity, title, detail, pageUrl, evidence }));

const list = (items: string[], n = 8) => items.slice(0, n).join("\n") + (items.length > n ? `\n… and ${items.length - n} more` : "");

/* ---------------------------------------------------------------------------------------------- */
/* Framework                                                                                       */

export interface FrameworkResult {
  framework: string;
  findings: Finding[];
}

/** Hermes bytecode starts with these 8 bytes. */
const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);

/**
 * Finds the framework the app is built with and checks for its release mistakes: Flutter and React
 * Native debug builds, shipped source maps, Cordova and Capacitor settings that open the web view.
 * `read` returns a file's bytes (small files only); `where` turns a path into the report's file name.
 */
export function frameworkChecks(
  platform: "android" | "ios",
  files: AppFile[],
  read: (name: string) => Buffer | undefined,
  where: (name: string) => string,
  hint: { swift?: boolean; kotlin?: boolean },
): FrameworkResult {
  const out: Finding[] = [];
  const names = new Set(files.map((f) => f.name));
  const has = (re: RegExp) => files.some((f) => re.test(f.name));
  const store = platform === "android" ? "Google Play" : "the App Store";
  let framework = platform === "android" ? (hint.kotlin ? "Native (Kotlin)" : "Native (Java)") : hint.swift ? "Native (Swift)" : "Native (Objective-C)";

  // Flutter
  const flutter = platform === "android" ? has(/^lib\/[^/]+\/libflutter\.so$/) || has(/^assets\/flutter_assets\//) : has(/^Frameworks\/Flutter\.framework\//);
  if (flutter) {
    framework = "Flutter";
    const kernel = platform === "android" ? "assets/flutter_assets/kernel_blob.bin" : "Frameworks/App.framework/flutter_assets/kernel_blob.bin";
    const aot = platform === "android" ? has(/^lib\/[^/]+\/libapp\.so$/) : names.has("Frameworks/App.framework/App");
    if (names.has(kernel) || !aot) {
      addFinding(
        out,
        "app:flutter-debug",
        "high",
        "This is a Flutter debug build",
        `The app carries Flutter's debug code (${names.has(kernel) ? "kernel_blob.bin" : "no compiled libapp code"}), so it runs slowly, shows the debug banner and lets anyone attach Flutter's debugger. Build it with flutter build ${platform === "android" ? "appbundle --release" : "ipa --release"} before sending it to ${store}.`,
        where(names.has(kernel) ? kernel : platform === "android" ? "lib/" : "Frameworks/App.framework/"),
        names.has(kernel) ? kernel : "no libapp",
        "functional",
      );
    }
  }

  // React Native
  const bundleName = platform === "android" ? "assets/index.android.bundle" : "main.jsbundle";
  const rnLibs = platform === "android" ? has(/^lib\/[^/]+\/(libreactnativejni|libreactnative|libjsi)\.so$/) : has(/^Frameworks\/(React|React-Core|ReactNativeDependencies|React-RCTAppDelegate)\.framework\//);
  if (names.has(bundleName) || rnLibs) {
    framework = "React Native";
    const buf = names.has(bundleName) ? read(bundleName) : undefined;
    if (buf) {
      const hermes = buf.subarray(0, 8).equals(HERMES_MAGIC);
      if (hermes) framework = "React Native (Hermes)";
      if (!hermes && /__DEV__\s*=\s*true/.test(buf.subarray(0, 4096).toString("latin1"))) {
        addFinding(
          out,
          "app:rn-dev-bundle",
          "high",
          "The React Native code is a development bundle",
          "The JavaScript bundle was built with __DEV__ on: it is slow, prints warnings and keeps developer tools in. Build the release variant (./gradlew bundleRelease, or the Release scheme in Xcode).",
          where(bundleName),
          "__DEV__=true",
          "functional",
        );
      }
    } else if (rnLibs) {
      addFinding(
        out,
        "app:rn-no-bundle",
        "high",
        "The React Native app has no JavaScript bundle",
        "React Native is in the app but its JavaScript bundle is not, so it loads the code from a developer's computer (Metro) and shows a red error screen on every other phone. Build the release variant, which packs the bundle in.",
        where(platform === "android" ? "assets/" : bundleName),
        `${bundleName} missing`,
        "functional",
      );
    }
  }

  // Web views: Cordova, Capacitor, Ionic
  const webRoot = platform === "android" ? "assets/" : "";
  const cordova = names.has(`${webRoot}www/cordova.js`);
  const capConfigName = platform === "android" ? "assets/capacitor.config.json" : "capacitor.config.json";
  const capacitor = names.has(capConfigName);
  if (cordova || capacitor) {
    framework = capacitor ? "Capacitor" : "Cordova";
    const webFiles = files.filter((f) => f.name.startsWith(`${webRoot}${capacitor ? "public/" : "www/"}`));
    if (webFiles.some((f) => /ionic/i.test(f.name))) framework = `Ionic (${framework})`;
    if (cordova) {
      const cfgName = platform === "android" ? "res/xml/config.xml" : "config.xml";
      const cfg = read(cfgName);
      // Android's copy is binary XML; its strings are still readable in the file.
      const text = cfg ? cfg.toString(platform === "android" && cfg[0] === 3 ? "utf16le" : "utf8") + cfg.toString("latin1") : "";
      if (/<access[^>]+origin\s*=\s*"\*"/.test(text) || /<allow-navigation[^>]+href\s*=\s*"\*"/.test(text) || /origin\W+\*/.test(text.replace(/\0/g, ""))) {
        addFinding(
          out,
          "app:cordova-open",
          "medium",
          "The web view may load and talk to any website",
          'config.xml allows every address (<access origin="*"> or <allow-navigation href="*">), so a link or an injected script can load an outside page inside the app, with the app\'s plugins. List only your own servers.',
          where(cfgName),
          'origin="*"',
        );
      }
    }
    if (capacitor) {
      let cfg: Record<string, unknown> = {};
      try {
        cfg = JSON.parse(read(capConfigName)?.toString("utf8") ?? "{}");
      } catch {
        /* unreadable config */
      }
      const server = (cfg.server ?? {}) as Record<string, unknown>;
      const plat = (cfg[platform] ?? {}) as Record<string, unknown>;
      if (typeof server.url === "string" && server.url) {
        addFinding(
          out,
          "app:capacitor-server-url",
          "high",
          "The app loads its screens from a web address instead of its own files",
          `capacitor.config.json sets server.url to ${server.url}. That is meant for live reload while developing: the app shows whatever that server sends, and stops working when it is off. Remove server.url and build again.`,
          where(capConfigName),
          String(server.url),
          "functional",
        );
      }
      if (server.cleartext === true) addFinding(out, "app:capacitor-cleartext", "medium", "The app's web view allows plain HTTP", "capacitor.config.json sets server.cleartext to true, so the web view can load pages and data over unencrypted HTTP. Remove it and use https:// everywhere.", where(capConfigName), "server.cleartext: true");
      if (plat.allowMixedContent === true) addFinding(out, "app:capacitor-mixed", "medium", "The web view mixes HTTPS and plain HTTP content", `capacitor.config.json sets ${platform}.allowMixedContent: scripts and pictures over plain HTTP can be swapped on public Wi-Fi. Turn it off.`, where(capConfigName), "allowMixedContent: true");
      if (plat.webContentsDebuggingEnabled === true) addFinding(out, "app:webview-debug", "medium", "Anyone can open the app's web view in developer tools", `capacitor.config.json turns on ${platform}.webContentsDebuggingEnabled, so a connected computer can read and change everything in the app's web view, logins included. Turn it off for release builds.`, where(capConfigName), "webContentsDebuggingEnabled: true");
    }
  }

  // .NET MAUI / Xamarin and Unity
  if (has(/(^|\/)assemblies\/[^/]+\.(dll|blob)$/) || has(/^lib\/[^/]+\/(libmonodroid|libmonosgen-2\.0|libxamarin-app)\.so$/) || has(/^Frameworks\/(Xamarin|Mono)[^/]*\.framework\//) || has(/^[^/]+\.dll$/)) {
    framework = has(/Microsoft\.Maui/i) ? ".NET MAUI" : "Xamarin / .NET";
    const pdb = files.filter((f) => f.name.endsWith(".pdb")).map((f) => f.name);
    if (pdb.length) addFinding(out, "app:dotnet-pdb", "low", "The app ships .NET debug files", `${pdb.length} .pdb file${pdb.length === 1 ? "" : "s"} are inside the app: they make the code easy to read back. Build in Release configuration, which leaves them out.`, where(pdb[0]), list(pdb, 4), "functional");
  }
  if (has(/^lib\/[^/]+\/libunity\.so$/) || has(/^Frameworks\/UnityFramework\.framework\//)) {
    framework = "Unity";
    const mono = files.filter((f) => /Managed\/Assembly-CSharp\.dll$/.test(f.name)).map((f) => f.name);
    if (mono.length) addFinding(out, "app:unity-mono", "low", "The game's code can be read back easily", "The Unity build uses Mono (Assembly-CSharp.dll inside the app), which anyone can open in a .NET decompiler to read the code or cheat. Switch the scripting backend to IL2CPP in Player Settings.", where(mono[0]), mono[0]);
  }

  // Source maps make the JavaScript readable (React Native, Cordova, Capacitor).
  const maps = files.filter((f) => /\.(js|jsbundle|bundle)\.map$/.test(f.name)).map((f) => f.name);
  if (maps.length) {
    addFinding(
      out,
      "app:source-maps",
      "medium",
      "The app ships JavaScript source maps",
      `${maps.length} source map${maps.length === 1 ? "" : "s"} are inside the app, so anyone can read the original code with its comments and file names. Leave .map files out of release builds (upload them to your crash tool instead).`,
      where(maps[0]),
      list(maps, 4),
    );
  }
  return { framework, findings: out };
}

/* ---------------------------------------------------------------------------------------------- */
/* Size                                                                                            */

const PICTURE = /\.(png|jpe?g|gif|bmp|webp)$/i;

/** App size, big pictures and duplicate files. `hash` returns a file's bytes for the duplicate check. */
export function sizeChecks(platform: "android" | "ios", total: number, files: AppFile[], hash: (name: string) => Buffer | undefined, where: (name: string) => string): { findings: Finding[]; biggest: { file: string; size: number }[] } {
  const out: Finding[] = [];
  const biggest = files
    .slice()
    .sort((a, b) => b.size - a.size)
    .slice(0, 8)
    .map((f) => ({ file: f.name, size: f.size }));
  const limit = platform === "android" ? 150e6 : 200e6;
  if (total > limit) {
    addFinding(
      out,
      "app:large",
      "medium",
      `The app is very large (${sizeText(total)})`,
      platform === "android"
        ? "Google Play refuses a download over 200 MB for the base app, and every extra 6 MB loses about 1% of installs. Move big media to Play Asset Delivery or download it after install."
        : "Over 200 MB, iPhones ask before downloading on mobile data, and many people stop there. Move big media to On-Demand Resources or download it after install.",
      where(biggest[0]?.file ?? ""),
      biggest.slice(0, 5).map((b) => `${b.file} (${sizeText(b.size)})`).join("\n"),
      "performance",
    );
  }
  const pictures = files.filter((f) => PICTURE.test(f.name) && f.size > 1_000_000).sort((a, b) => b.size - a.size);
  if (pictures.length) {
    addFinding(
      out,
      "app:big-pictures",
      "low",
      `${pictures.length} picture${pictures.length === 1 ? " is" : "s are"} over 1 MB`,
      "Large pictures make the app slow to download and use memory when shown. Save them as WebP (or HEIC on iOS) at the size they are shown, or use vector drawables / SF Symbols for icons.",
      where(pictures[0].name),
      pictures.slice(0, 6).map((p) => `${p.name} (${sizeText(p.size)})`).join("\n"),
      "performance",
    );
  }
  // The same file twice: compare sizes first, then the bytes of files over 100 KB.
  const bySize = new Map<number, AppFile[]>();
  for (const f of files) if (f.size > 100_000 && !/\.(so|dex|arsc)$/.test(f.name)) bySize.set(f.size, [...(bySize.get(f.size) ?? []), f]);
  const dupes: string[][] = [];
  let wasted = 0;
  for (const group of bySize.values()) {
    if (group.length < 2) continue;
    const byHash = new Map<string, string[]>();
    for (const f of group.slice(0, 6)) {
      const buf = hash(f.name);
      if (!buf) continue;
      const h = createHash("sha1").update(buf).digest("hex");
      byHash.set(h, [...(byHash.get(h) ?? []), f.name]);
    }
    for (const same of byHash.values())
      if (same.length > 1) {
        dupes.push(same);
        wasted += group[0].size * (same.length - 1);
      }
  }
  if (dupes.length && wasted > 500_000) {
    addFinding(
      out,
      "app:duplicate-files",
      "low",
      `The same files are packed more than once (${sizeText(wasted)} wasted)`,
      "These files are byte-for-byte the same. Keep one copy and point to it, which makes the app smaller to download.",
      where(dupes[0][0]),
      dupes.slice(0, 4).map((d) => d.join(" = ")).join("\n"),
      "performance",
    );
  }
  return { findings: out, biggest };
}

/* ---------------------------------------------------------------------------------------------- */
/* Servers                                                                                         */

/** Servers that belong to platforms and libraries, not to the app's owner. */
const NOT_OWN =
  /(^|\.)(google|googleapis|gstatic|googleusercontent|googlesyndication|doubleclick|android|apple|icloud|facebook|fb|instagram|whatsapp|twitter|x|w3|w3c|xml|xmlsoap|schemas|example|github|githubusercontent|mozilla|apache|jquery|cloudflare|jsdelivr|unpkg|cocoapods|swift|kotlinlang|jetbrains|gradle|maven|npmjs|reactnative|reactjs|flutter|dart|firebase|firebaseio|crashlytics|app-measurement|microsoft|bing|amazon|amazonaws|youtube|wikipedia|openssl|publicsuffix|unicode|opensource|creativecommons|json-schema|sentry|onesignal|branch|appsflyer|adjust|mixpanel|amplitude|segment|clevertap|razorpay|paytm|stripe|mapbox|openstreetmap|ietf|iana|purl|ns|adobe|gnu|w3schools|stackoverflow|digicert|letsencrypt|globalsign|sectigo|verisign|entrust|godaddy|ocsp|crl|jcenter|bintray|square|squareup|okhttp|realm|mongodb|parse|zendesk|intercom|freshchat|giphy|tenor|gravatar|cdnjs|bootstrapcdn|fontawesome|fonts|typekit|localhost)\.[a-z.]+$/i;
const TEST_HOST = /(^|[.-])(dev|devel|develop|development|stage|staging|stg|test|testing|qa|uat|sandbox|preprod|pre-prod|beta|local)([.-]|\d|$)/i;
const IP = /^\d{1,3}(\.\d{1,3}){3}$/;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.)/;

/**
 * The app's own servers named in its code and config: hosts that carry a word of the app's id
 * (glvshop in in.glv.glvshop), IP addresses, and hosts in the app's config files, leaving out
 * platform and library servers.
 */
export function ownServers(appId: string, texts: { file: string; text: string; config: boolean }[]): string[] {
  const COMMON = new Set(["com", "org", "net", "in", "co", "io", "app", "apps", "android", "ios", "mobile", "www", "api", "test", "demo", "company", "group", "india", "global", "online", "debug", "release"]);
  const tokens = appId
    .toLowerCase()
    .split(/[.\-_]/)
    .filter((t) => t.length >= 4 && !COMMON.has(t));
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of t.text.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi)) {
      const host = m[1].toLowerCase().replace(/\.$/, "");
      if (host === "localhost" || /^(0|255)\./.test(host) || /\.(png|jpg|js|json|html|xml)$/.test(host)) continue;
      if (IP.test(host) || tokens.some((k) => host.includes(k)) || (t.config && !NOT_OWN.test(host))) found.add(host);
    }
  }
  return [...found].sort().slice(0, 40);
}

/**
 * Release-build checks on the app's servers: test or staging servers left in, servers on private
 * network addresses, and servers whose HTTPS certificate is broken (each opened once, GET only).
 */
export async function serverChecks(platform: "android" | "ios", servers: string[], request: APIRequestContext, where: string, debugBuild: boolean, signal?: AbortSignal): Promise<Finding[]> {
  const out: Finding[] = [];
  const test = servers.filter((h) => TEST_HOST.test(h));
  if (test.length && !debugBuild) {
    addFinding(
      out,
      "app:test-servers",
      "medium",
      "The app still points at test or staging servers",
      `The release build names ${test.slice(0, 4).join(", ")}. If the app really calls them, real users' data goes to a test server (or the app fails when it is switched off). Use build variants or schemes so release builds only know the live servers.`,
      where,
      list(test, 6),
      "functional",
    );
  }
  const privateIps = servers.filter((h) => IP.test(h) && PRIVATE_IP.test(h) && !h.startsWith("127."));
  if (privateIps.length && !debugBuild) {
    addFinding(out, "app:private-ip", "medium", "The app calls servers on a private network address", `${privateIps.join(", ")} only exist on an office or home network, so these calls fail for every user. They are usually a developer's computer left in by mistake.`, where, privateIps.join(", "), "functional");
  }
  const toCheck = servers.filter((h) => !IP.test(h) && !/\.(invalid|test|example|localhost|local|internal|lan)$/.test(h)).slice(0, 8);
  const broken: string[] = [];
  await Promise.all(
    toCheck.map(async (host) => {
      if (signal?.aborted) return;
      try {
        await request.get(`https://${host}/`, { timeout: 8000, maxRedirects: 3, failOnStatusCode: false });
      } catch (err) {
        const msg = (err as Error).message;
        if (/certificate|CERT_|SSL|self[- ]signed|unable to verify/i.test(msg)) broken.push(`${host}: ${msg.split("\n")[0].replace(/^.*?(certificate|CERT_|SSL)/i, "$1").slice(0, 120)}`);
      }
    }),
  );
  if (broken.length) {
    addFinding(
      out,
      "app:server-cert",
      "high",
      "A server the app calls has a broken HTTPS certificate",
      `${platform === "android" ? "Android" : "iOS"} refuses connections to a server whose certificate is expired, self-signed or for another name, so these calls fail (or the app was told to ignore the error, which lets anyone read the traffic). Renew or fix the certificate.`,
      where,
      broken.sort().join("\n"),
    );
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/* Languages                                                                                       */

const LANG_NAMES: Record<string, string> = { en: "English", hi: "Hindi", bn: "Bengali", ta: "Tamil", te: "Telugu", mr: "Marathi", gu: "Gujarati", kn: "Kannada", ml: "Malayalam", pa: "Punjabi", ur: "Urdu", or: "Odia", as: "Assamese", ar: "Arabic", fr: "French", de: "German", es: "Spanish", pt: "Portuguese", it: "Italian", ru: "Russian", ja: "Japanese", ko: "Korean", zh: "Chinese", id: "Indonesian", tr: "Turkish", nl: "Dutch", pl: "Polish", th: "Thai", vi: "Vietnamese", fa: "Persian", he: "Hebrew", iw: "Hebrew" };
export const languageName = (code: string) => {
  const [l, r] = code.split(/[-_]/);
  const name = LANG_NAMES[l.toLowerCase()] ?? l;
  return r ? `${name} (${r.replace(/^r/, "").toUpperCase()})` : name;
};

/**
 * Languages with only part of the texts translated. counts maps a language to how many texts it
 * has; base is the default language's count. Languages with under half the texts are taken to be
 * a library's own translations (AndroidX brings dozens), not the app's, and are left out.
 */
export function languageChecks(counts: Map<string, number>, base: number, where: string): { languages: string[]; findings: Finding[] } {
  const out: Finding[] = [];
  const languages: string[] = [];
  const partial: string[] = [];
  for (const [lang, n] of [...counts].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!base || n < base * 0.5) continue;
    languages.push(lang);
    if (n < base * 0.95 && base - n >= 3) partial.push(`${languageName(lang)}: ${n} of ${base} texts`);
  }
  if (partial.length) {
    addFinding(
      out,
      "app:partial-translation",
      "low",
      `Some texts are not translated (${partial.length} language${partial.length === 1 ? "" : "s"})`,
      "People who use the app in these languages see some screens in the default language instead. Translate the missing texts, or remove the language until it is complete.",
      where,
      list(partial, 8),
      "functional",
    );
  }
  return { languages, findings: out };
}

/* ---------------------------------------------------------------------------------------------- */
/* What changed since the last upload                                                              */

const shortPerm = (p: string) => p.replace(/^android\.permission\./, "").replace(/^com\.google\.android\.gms\.permission\./, "");

/** Compares the app with the project's previous test of it: permissions, SDKs, size, versions, servers. */
export function compareApps(prev: AppSummary, cur: AppSummary, since: string): { lines: string[]; findings: Finding[] } {
  const out: Finding[] = [];
  const lines: string[] = [];
  if (prev.id !== cur.id) return { lines: [`This is a different app (${cur.id}) from the one tested before (${prev.id}), so it is not compared.`], findings: [] };
  const where = cur.platform === "android" ? "AndroidManifest.xml" : "Info.plist";
  if (prev.version !== cur.version || prev.build !== cur.build) lines.push(`Version ${prev.version ?? "?"}${prev.build ? ` (${prev.build})` : ""} → ${cur.version ?? "?"}${cur.build ? ` (${cur.build})` : ""}`);
  if (prev.version && cur.version && prev.version === cur.version && prev.build === cur.build) lines.push("Same version and build number as last time: stores refuse an upload that does not raise the build number.");
  const added = cur.permissions.filter((p) => !prev.permissions.includes(p));
  const removed = prev.permissions.filter((p) => !cur.permissions.includes(p));
  if (added.length) {
    lines.push(`New permissions: ${added.map(shortPerm).join(", ")}`);
    addFinding(
      out,
      "app:new-permissions",
      "low",
      `The app asks for ${added.length} new permission${added.length === 1 ? "" : "s"} since the last test`,
      `Compared with version ${prev.version ?? "?"} tested ${since}. Check each one is meant (an SDK update often adds some), and update the store's data safety / privacy answers to match.`,
      where,
      added.map(shortPerm).join("\n"),
    );
  }
  if (removed.length) lines.push(`Permissions removed: ${removed.map(shortPerm).join(", ")}`);
  const newSdks = cur.sdks.filter((s) => !prev.sdks.some((p) => p.id === s.id));
  const goneSdks = prev.sdks.filter((s) => !cur.sdks.some((p) => p.id === s.id));
  if (newSdks.length) lines.push(`New SDKs: ${newSdks.map((s) => s.name).join(", ")}`);
  if (goneSdks.length) lines.push(`SDKs removed: ${goneSdks.map((s) => s.name).join(", ")}`);
  const newTrackers = newSdks.filter((s) => s.tracker);
  if (newTrackers.length) {
    addFinding(
      out,
      "app:new-trackers",
      "low",
      `${newTrackers.length} new tracking SDK${newTrackers.length === 1 ? "" : "s"} since the last test`,
      `${newTrackers.map((s) => s.name).join(", ")} ${newTrackers.length === 1 ? "is" : "are"} new in this version. ${cur.platform === "android" ? "Update Play Console's Data safety form" : "Update App Store Connect's App Privacy answers"} before publishing, or the store can pull the app.`,
      where,
      newTrackers.map((s) => s.name).join("\n"),
    );
  }
  if (prev.size && Math.abs(cur.size - prev.size) / prev.size >= 0.1) lines.push(`Size ${sizeText(prev.size)} → ${sizeText(cur.size)} (${cur.size > prev.size ? "+" : ""}${Math.round(((cur.size - prev.size) / prev.size) * 100)}%)`);
  if (prev.target !== cur.target && cur.target) lines.push(`Target API ${prev.target ?? "?"} → ${cur.target}`);
  if (prev.minOs !== cur.minOs && cur.minOs) lines.push(`Lowest ${cur.platform === "android" ? "Android API" : "iOS"} ${prev.minOs ?? "?"} → ${cur.minOs}`);
  if (prev.framework !== cur.framework) lines.push(`Framework ${prev.framework} → ${cur.framework}`);
  const newServers = cur.servers.filter((s) => !prev.servers.includes(s));
  if (newServers.length) lines.push(`New servers in the code: ${newServers.slice(0, 6).join(", ")}${newServers.length > 6 ? "…" : ""}`);
  const newLibs = cur.libraries.filter((l) => !prev.libraries.some((p) => p.name === l.name));
  const changedLibs = cur.libraries.filter((l) => prev.libraries.some((p) => p.name === l.name && p.version !== l.version));
  if (newLibs.length) lines.push(`New libraries: ${newLibs.length}`);
  if (changedLibs.length) lines.push(`Libraries updated: ${changedLibs.length}`);
  if (!lines.length) lines.push("Nothing changed in permissions, SDKs, size or servers.");
  return { lines, findings: out };
}
