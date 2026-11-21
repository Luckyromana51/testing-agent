/*
 * More Android checks: risky code, trackers and SDKs, the app's framework, its libraries (with a
 * CycloneDX list for OSV-Scanner), size, App Links, the servers it names, translations and store
 * readiness. Everything is read from the uploaded file; App Links and servers are opened once (GET).
 */
import { createHash } from "node:crypto";
import { findAll } from "../../engines/axml.js";
import { parseAndroidXml } from "../../engines/aab.js";
import { readEntry } from "../../engines/zip.js";
import { NotTestedError } from "../../runner/coverage.js";
import type { Finding } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { signingBlock } from "./android.js";
import type { ApkContext } from "./context.js";
import { androidSdks, KIND_LABEL } from "./sdks.js";
import { addFinding as add, frameworkChecks, languageChecks, ownServers, serverChecks, sizeChecks } from "./shared.js";

type ApkAgent = EngineAgent<ApkContext>;
const base = { engine: "mobile" as const, products: ["android" as const] };
const MANIFEST = "AndroidManifest.xml";
const dexTexts = (ctx: ApkContext) => ctx.strings.filter((s) => /\.dex$/.test(s.file));
const firstDexWith = (ctx: ApkContext, needles: string[]) => dexTexts(ctx).find((s) => needles.some((n) => s.text.includes(n)))?.file;

/* ---------------------------------------------------------------------------------------------- */
/* Risky code                                                                                      */

interface CodeRule {
  rule: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  detail: string;
  /** Any of these names in the code. */
  any: string[];
  /** And all of these. */
  all?: string[];
  when?: (ctx: ApkContext) => boolean;
}

const CODE_RULES: CodeRule[] = [
  {
    rule: "android:trust-all-certs",
    severity: "high",
    title: "The code may accept any HTTPS certificate",
    detail:
      "The app has a trust manager named like the ones copied from the internet to make certificate errors go away (TrustAllCerts, EasyX509TrustManager...). With it, anyone on the same Wi-Fi can read and change the app's traffic. Remove it and fix the server's certificate; for a test server use a network security config with <debug-overrides>.",
    any: ["TrustAllCerts", "trustAllCerts", "TrustAllManager", "NullTrustManager", "FakeX509TrustManager", "EasyX509TrustManager", "TrustAllSSLSocketFactory", "InsecureTrustManager"],
  },
  {
    rule: "android:allow-all-hostnames",
    severity: "high",
    title: "The code turns off the server-name check for HTTPS",
    detail:
      "ALLOW_ALL_HOSTNAME_VERIFIER / AllowAllHostnameVerifier / NoopHostnameVerifier accept a certificate made for any other website, so a fake server can stand in for yours. Use the default hostname verifier.",
    any: ["ALLOW_ALL_HOSTNAME_VERIFIER", "Lorg/apache/http/conn/ssl/AllowAllHostnameVerifier;", "Lorg/apache/http/conn/ssl/NoopHostnameVerifier;"],
  },
  {
    rule: "android:webview-ssl-proceed",
    severity: "medium",
    title: "A web view may ignore certificate errors",
    detail:
      "The code handles onReceivedSslError and calls SslErrorHandler.proceed(), which loads the page even when its certificate is fake. Google Play rejects apps that do this without asking the user. Call handler.cancel() instead (check it is your code, not an SDK's).",
    any: ["Landroid/webkit/SslErrorHandler;"],
    all: ["onReceivedSslError", "\0proceed\0"],
  },
  {
    rule: "android:webview-file-access",
    severity: "medium",
    title: "A web view lets local files read other files or websites",
    detail:
      "setAllowUniversalAccessFromFileURLs / setAllowFileAccessFromFileURLs let a page opened from a file read the app's private files or any website. Turn them off and load local pages through WebViewAssetLoader.",
    any: ["setAllowUniversalAccessFromFileURLs", "setAllowFileAccessFromFileURLs"],
  },
  {
    rule: "android:webview-js-bridge",
    severity: "high",
    title: "Web pages can run the app's code on old Android versions",
    detail:
      "The app uses addJavascriptInterface and still installs on Android 4.1 or older, where any page in the web view can call every Java method through it (CVE-2012-6636). Raise minSdk to 17 or newer.",
    any: ["addJavascriptInterface"],
    when: (ctx) => (ctx.facts.minSdk ?? 0) < 17,
  },
  {
    rule: "android:weak-cipher",
    severity: "medium",
    title: "The code uses weak or broken encryption",
    detail:
      "DES, 3DES, RC4, Blowfish and AES in ECB mode can be broken or leak patterns in the data. Use AES/GCM/NoPadding with a key from the Android Keystore (or Jetpack Security).",
    any: ["AES/ECB/", "\0AES/ECB\0", "DES/CBC/", "DES/ECB/", "\0DES\0", "DESede", "\0RC4\0", "Blowfish"],
  },
  {
    rule: "android:external-storage",
    severity: "low",
    title: "The app saves files in shared storage",
    detail:
      "getExternalStorageDirectory and getExternalStoragePublicDirectory are folders other apps (and anyone with a USB cable) can read. Keep private files in getFilesDir(), and use MediaStore only for files the user means to share.",
    any: ["getExternalStorageDirectory", "getExternalStoragePublicDirectory"],
  },
  {
    rule: "android:dynamic-code",
    severity: "low",
    title: "The app loads extra code while it runs",
    detail:
      "DexClassLoader loads code that was not reviewed with the app. Google Play does not allow apps to download code that changes how they work, and code from a writable folder can be swapped by an attacker. Ship the code in the app, or use Play Feature Delivery.",
    any: ["Ldalvik/system/DexClassLoader;", "Ldalvik/system/InMemoryDexClassLoader;"],
  },
];

export const androidCodeAgent: ApkAgent = {
  ...base,
  id: "android.code",
  name: "Risky code",
  description: "Searches the app's code for trust-all certificates, web view holes, weak encryption, shared storage, code loaded at run time, open FileProvider paths and code left unshrunk.",
  category: "security",
  run(ctx) {
    const out: Finding[] = [];
    const dex = dexTexts(ctx);
    if (!dex.length) throw new NotTestedError("the app has no classes.dex code to read");
    for (const r of CODE_RULES) {
      if (r.when && !r.when(ctx)) continue;
      const file = dex.find((d) => r.any.some((n) => d.text.includes(n)) && (r.all ?? []).every((n) => dex.some((x) => x.text.includes(n))))?.file;
      if (!file) continue;
      const hit = r.any.filter((n) => dex.some((d) => d.text.includes(n))).map((n) => n.replace(/\0/g, ""));
      add(out, r.rule, r.severity, r.title, `${r.detail} Found by name in the code: confirm it in the source.`, file, hit.slice(0, 4).join(", "));
    }

    // FileProvider paths that share the whole phone or the app's whole folder.
    for (const e of ctx.entries.filter((x) => /^res\/xml[^/]*\/[^/]+\.xml$/.test(x.name) && x.size < 16_000)) {
      let node;
      try {
        node = parseAndroidXml(readEntry(ctx.apk, e));
      } catch {
        continue;
      }
      if (node.tag !== "paths") continue;
      const root = findAll(node, "root-path");
      const wide = node.children.filter((c) => ["files-path", "external-path", "cache-path"].includes(c.tag) && (c.attrs.path === "." || c.attrs.path === "/" || c.attrs.path === ""));
      if (root.length || wide.length) {
        add(
          out,
          "android:fileprovider-wide",
          root.length ? "medium" : "low",
          root.length ? "The app's FileProvider can share any file on the phone" : "The app's FileProvider shares a whole folder",
          `${e.name} has ${root.length ? "<root-path>, which covers the whole file system" : `${wide.map((w) => `<${w.tag} path="${String(w.attrs.path)}">`).join(", ")}`}. Any app the user shares a file with can ask for other files in it. List only the folder you share (for example <cache-path name="shared" path="shared/"/>).`,
          e.name,
          root.length ? "<root-path>" : wide.map((w) => w.tag).join(", "),
        );
      }
    }

    // Code left readable: the app's own classes keep their long names (no R8 / ProGuard).
    const pkgPath = `L${ctx.facts.packageName.replace(/\./g, "/")}/`;
    const own = new Set<string>();
    for (const d of dex) for (const m of d.text.matchAll(new RegExp(`${pkgPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}([\\w/$]+);`, "g"))) own.add(m[1].split("/").pop()!.split("$")[0]);
    const named = [...own].filter((n) => n.length > 2);
    if (own.size >= 20 && named.length / own.size > 0.9 && !ctx.facts.debuggable) {
      add(
        out,
        "android:not-shrunk",
        "low",
        "The app's code is not shrunk or obfuscated",
        `${own.size} of the app's classes keep their full names (${named.slice(0, 3).join(", ")}…), so the code is easy to read back and the app is bigger than it needs to be. Turn on R8 for release builds: isMinifyEnabled = true and isShrinkResources = true in build.gradle.`,
        dex[0].file,
        `${named.length} of ${own.size} classes with full names`,
        "performance",
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Trackers and SDKs                                                                               */

const AD_ID = "com.google.android.gms.permission.AD_ID";

export const androidSdksAgent: ApkAgent = {
  ...base,
  id: "android.sdks",
  name: "Trackers and SDKs",
  description: "Lists the SDKs inside the app (ads, install tracking, analytics, payments...) and checks the advertising ID permission and the store's data safety answers match them.",
  category: "security",
  run(ctx) {
    const out: Finding[] = [];
    const sdks = androidSdks(dexTexts(ctx).map((d) => d.text));
    ctx.summary.sdks = sdks.map((s) => ({ id: s.id, name: s.name, kind: s.kind, tracker: s.tracker }));
    const trackers = sdks.filter((s) => s.tracker);
    if (sdks.length) ctx.note(`SDKs: ${sdks.map((s) => `${s.name} (${KIND_LABEL[s.kind]})`).join(", ")}.`);
    const hasAdId = ctx.facts.permissions.includes(AD_ID);
    const ads = sdks.filter((s) => s.kind === "ads" || s.kind === "attribution");
    if (trackers.length) {
      add(
        out,
        "android:trackers",
        "info",
        `The app has ${trackers.length} tracking SDK${trackers.length === 1 ? "" : "s"}`,
        `${trackers.map((t) => t.name).join(", ")} collect data about users. Google Play's Data safety form must list what they collect and share, and India's DPDP Act and Europe's GDPR need the user's consent before they start. Check they wait for consent.`,
        MANIFEST,
        trackers.map((t) => `${t.name} (${KIND_LABEL[t.kind]})`).join("\n"),
        "security",
      );
    }
    if (ads.length && !hasAdId && (ctx.facts.targetSdk ?? 0) >= 33) {
      add(
        out,
        "android:ad-id-missing",
        "medium",
        "Ad SDKs cannot read the advertising ID",
        `The app has ${ads.map((a) => a.name).join(", ")} and targets Android 13+, but does not declare ${AD_ID}. Android then hands the SDK a blank ID: ads earn less and install tracking breaks. Add the permission (and say so in Play Console's Advertising ID form).`,
        MANIFEST,
        `${AD_ID} not declared`,
        "functional",
      );
    }
    if (hasAdId && !ads.length && !sdks.some((s) => s.id === "firebase-analytics")) {
      add(out, "android:ad-id-unused", "low", "The app asks for the advertising ID but has no ad SDK", `${AD_ID} is declared, so Play Console treats the app as using the advertising ID and its Data safety answers must say so. Remove the permission if no SDK needs it (tools:node="remove").`, MANIFEST, AD_ID);
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Framework                                                                                       */

export const androidFrameworkAgent: ApkAgent = {
  ...base,
  id: "android.framework",
  name: "App framework",
  description: "Finds what the app is built with (Flutter, React Native, Cordova, Capacitor, Ionic, .NET MAUI, Unity or native) and checks that framework's release mistakes: debug builds, dev bundles, source maps, open web views.",
  category: "security",
  run(ctx) {
    const files = ctx.entries.map((e) => ({ name: e.name, size: e.size }));
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    const read = (n: string) => {
      const e = byName.get(n);
      return e && e.size < 60_000_000 ? readEntry(ctx.apk, e) : undefined;
    };
    const { framework, findings } = frameworkChecks("android", files, read, (n) => n, { kotlin: dexTexts(ctx).some((d) => d.text.includes("Lkotlin/")) });
    ctx.summary.framework = framework;
    ctx.note(`Built with ${framework}.`);
    return findings;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Libraries                                                                                       */

/** Libraries named in META-INF: androidx.core_core.version, maven pom.properties, and OkHttp's version text. */
export function androidLibraries(ctx: Pick<ApkContext, "apk" | "entries" | "strings">): { name: string; version: string; purl?: string }[] {
  const out = new Map<string, { name: string; version: string; purl?: string }>();
  const put = (group: string, artifact: string, version: string) => {
    if (!/^[\w.+-]{1,40}$/.test(version)) return;
    const name = `${group}:${artifact}`;
    out.set(name, { name, version, purl: `pkg:maven/${group}/${artifact}@${version}` });
  };
  for (const e of ctx.entries) {
    let m = e.name.match(/^META-INF\/([a-z0-9.]+)_([\w.-]+)\.version$/i);
    if (m && e.size < 200) {
      const v = readEntry(ctx.apk, e).toString("utf8").trim();
      if (m[1] === "kotlinx") put("org.jetbrains.kotlinx", `kotlinx-${m[2].replace(/_/g, "-")}`, v);
      else put(m[1], m[2], v);
      continue;
    }
    m = e.name.match(/^META-INF\/maven\/([^/]+)\/([^/]+)\/pom\.properties$/);
    if (m && e.size < 2000) {
      const v = readEntry(ctx.apk, e).toString("utf8").match(/^version=(.+)$/m)?.[1]?.trim();
      if (v) put(m[1], m[2], v);
    }
  }
  for (const s of ctx.strings.filter((x) => /\.dex$/.test(x.file))) {
    const ok = s.text.match(/\bokhttp\/(\d+\.\d+\.\d+)\b/);
    if (ok) put("com.squareup.okhttp3", "okhttp", ok[1]);
    const retro = s.text.match(/\bretrofit\/(\d+\.\d+\.\d+)\b/i);
    if (retro) put("com.squareup.retrofit2", "retrofit", retro[1]);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** A CycloneDX 1.5 list of the app's libraries, for OSV-Scanner and for the client's own records. */
export function cycloneDx(app: { id: string; version?: string }, libs: { name: string; version: string; purl?: string }[]): string {
  return JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: { component: { type: "application", name: app.id, version: app.version ?? "unknown" }, tools: [{ vendor: "GLV", name: "GLV testing agent" }] },
      components: libs.map((l) => ({ type: "library", name: l.name, version: l.version, ...(l.purl ? { purl: l.purl } : {}) })),
    },
    null,
    1,
  );
}

export const androidLibrariesAgent: ApkAgent = {
  ...base,
  id: "android.libraries",
  name: "Libraries",
  description: "Lists the libraries inside the app with their versions (AndroidX, Kotlin, OkHttp...) as a CycloneDX file that OSV-Scanner checks for known holes.",
  category: "security",
  run(ctx) {
    const libs = androidLibraries(ctx);
    ctx.summary.libraries = libs;
    ctx.note(libs.length ? `${libs.length} libraries with versions found (download the list: app-sbom.cdx.json).` : "No library versions found in the app (R8 can remove them).");
    return [];
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Size                                                                                            */

export const androidSizeAgent: ApkAgent = {
  ...base,
  id: "android.size",
  name: "App size",
  description: "Checks the download size, pictures over 1 MB and files packed twice.",
  category: "performance",
  run(ctx) {
    const byName = new Map(ctx.entries.map((e) => [e.name, e]));
    const { findings, biggest } = sizeChecks(
      "android",
      ctx.apk.length,
      ctx.entries.map((e) => ({ name: e.name, size: e.size })),
      (n) => {
        const e = byName.get(n);
        return e && e.size < 50_000_000 ? readEntry(ctx.apk, e) : undefined;
      },
      (n) => n,
    );
    ctx.summary.biggest = biggest;
    return findings;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* App Links                                                                                       */

/** Reads one DER length and returns where the value starts and its length. */
function der(buf: Buffer, p: number): { tag: number; start: number; len: number; end: number } {
  const tag = buf[p];
  let len = buf[p + 1];
  let start = p + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + 2 + i];
    start += n;
  }
  return { tag, start, len, end: start + len };
}

/** The first certificate in a v1 signature file (PKCS#7 SignedData), as DER bytes. */
export function pkcs7Certificate(buf: Buffer): Buffer | null {
  try {
    const ci = der(buf, 0); // ContentInfo
    const oid = der(buf, ci.start);
    const wrap = der(buf, oid.end); // [0]
    const sd = der(buf, wrap.start); // SignedData
    let p = sd.start;
    for (let i = 0; i < 3; i++) p = der(buf, p).end; // version, digestAlgorithms, contentInfo
    const certs = der(buf, p);
    if (certs.tag !== 0xa0) return null;
    const cert = der(buf, certs.start);
    return buf.subarray(certs.start, cert.end);
  } catch {
    return null;
  }
}

/** The first certificate in the v2/v3 signing block, as DER bytes. */
export function signingBlockCertificate(block: Buffer): Buffer | null {
  try {
    let p = 8;
    while (p + 12 <= block.length - 24) {
      const len = Number(block.readBigUInt64LE(p));
      const id = block.readUInt32LE(p + 8);
      const value = block.subarray(p + 12, p + 8 + len);
      if (id === 0x7109871a || id === 0xf05368c0) {
        let q = 4; // signers sequence length
        q += 4; // first signer length
        q += 4; // signed data length
        q += 4 + value.readUInt32LE(q); // digests
        q += 4; // certificates sequence length
        const certLen = value.readUInt32LE(q);
        return value.subarray(q + 4, q + 4 + certLen);
      }
      p += 8 + len;
    }
  } catch {
    /* damaged block */
  }
  return null;
}

/** SHA-256 of the signing certificate as AA:BB:..., the way assetlinks.json lists it. */
export function signingFingerprint(ctx: Pick<ApkContext, "apk" | "entries">): string | null {
  const block = signingBlock(ctx.apk);
  let cert = block ? signingBlockCertificate(block) : null;
  if (!cert) {
    const v1 = ctx.entries.find((e) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(e.name));
    cert = v1 ? pkcs7Certificate(readEntry(ctx.apk, v1)) : null;
  }
  if (!cert) return null;
  return createHash("sha256")
    .update(cert)
    .digest("hex")
    .toUpperCase()
    .replace(/(..)(?!$)/g, "$1:");
}

/** What is wrong with a site's assetlinks.json for this app, or null when it verifies. */
export function assetLinksProblem(json: unknown, pkg: string, fingerprint: string | null): string | null {
  if (!Array.isArray(json)) return "the file is not a JSON list";
  const mine = json.filter((s) => {
    const t = (s as { target?: { namespace?: string; package_name?: string } }).target;
    return t?.namespace === "android_app" && t.package_name === pkg;
  }) as { relation?: string[]; target: { sha256_cert_fingerprints?: string[] } }[];
  if (!mine.length) return `it does not list ${pkg}`;
  if (!mine.some((s) => s.relation?.includes("delegate_permission/common.handle_all_urls"))) return "it does not give the app delegate_permission/common.handle_all_urls";
  if (fingerprint && !mine.some((s) => s.target.sha256_cert_fingerprints?.some((f) => f.toUpperCase() === fingerprint))) return "its certificate fingerprint is not the one this app is signed with (with Play App Signing, add the fingerprint from Play Console > App integrity too)";
  return null;
}

const FAKE_TLD = /\.(invalid|test|example|localhost|local)$/;

export const androidLinksAgent: ApkAgent = {
  ...base,
  id: "android.links",
  name: "App Links and deep links",
  description: "Checks each verified link host serves a correct /.well-known/assetlinks.json for this app and its signing certificate, and lists the app's custom link schemes.",
  category: "functional",
  async run(ctx) {
    const out: Finding[] = [];
    const verified = new Set<string>();
    const all = new Set<string>();
    const schemes = new Set<string>();
    for (const c of ctx.facts.components.filter((x) => x.exported && (x.kind === "activity" || x.kind === "activity-alias"))) {
      for (const s of c.schemes) if (!/^https?$/.test(s)) schemes.add(s);
      if (!c.schemes.some((s) => /^https?$/.test(s))) continue;
      for (const h of c.hosts) {
        all.add(h);
        if (c.autoVerify) verified.add(h);
      }
    }
    ctx.summary.links = [...all].sort();
    if (schemes.size) ctx.note(`Custom link schemes: ${[...schemes].map((s) => `${s}://`).join(", ")} (any app can claim these; use App Links for anything with a login or payment).`);
    const unverified = [...all].filter((h) => !verified.has(h) && !h.startsWith("*"));
    if (unverified.length) {
      add(out, "android:links-not-verified", "low", "Web links open a choice dialog instead of the app", `The app opens ${unverified.slice(0, 4).join(", ")} links without android:autoVerify="true", so Android 12+ opens them in the browser (or asks which app to use). Add autoVerify to the intent filter and publish assetlinks.json on the site.`, MANIFEST, unverified.slice(0, 6).join(", "));
    }
    if (!verified.size) return out;
    const fp = signingFingerprint(ctx);
    const bad: string[] = [];
    for (const host of [...verified].sort().slice(0, 8)) {
      const h = host.replace(/^\*\./, "");
      if (FAKE_TLD.test(h)) {
        bad.push(`${host}: not a real web address`);
        continue;
      }
      try {
        const res = await ctx.request.get(`https://${h}/.well-known/assetlinks.json`, { timeout: 10_000, maxRedirects: 0, failOnStatusCode: false });
        if (res.status() !== 200) {
          bad.push(`${host}: /.well-known/assetlinks.json answers ${res.status()}${res.status() >= 300 && res.status() < 400 ? " (a redirect, which Android does not follow)" : ""}`);
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(await res.text());
        } catch {
          bad.push(`${host}: assetlinks.json is not valid JSON`);
          continue;
        }
        const problem = assetLinksProblem(json, ctx.facts.packageName, fp);
        if (problem) bad.push(`${host}: ${problem}`);
      } catch (err) {
        bad.push(`${host}: could not be opened (${(err as Error).message.split("\n")[0].slice(0, 80)})`);
      }
    }
    if (bad.length) {
      add(
        out,
        "android:app-links-broken",
        "medium",
        "App Links are not verified, so links open in the browser",
        `The app asks Android to verify ${[...verified].slice(0, 4).join(", ")}, but the check fails, so tapping a link in WhatsApp, email or search opens the website instead of the app. Publish https://<host>/.well-known/assetlinks.json with the package name and SHA-256 fingerprint (Play Console > Deep links shows the right file).`,
        MANIFEST,
        `${bad.join("\n")}${fp ? `\nThis app's signing fingerprint: ${fp}` : ""}`,
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Servers                                                                                         */

export const androidServersAgent: ApkAgent = {
  ...base,
  id: "android.servers",
  name: "App servers",
  description: "Lists the app's own servers named in its code and config, and checks for test or staging servers, private network addresses and broken HTTPS certificates.",
  category: "functional",
  async run(ctx) {
    const servers = ownServers(
      ctx.facts.packageName,
      ctx.strings.map((s) => ({ ...s, config: !/\.dex$/.test(s.file) })),
    );
    ctx.summary.servers = servers;
    if (servers.length) ctx.note(`Servers named in the app: ${servers.slice(0, 10).join(", ")}${servers.length > 10 ? "…" : ""}. Test them with an API project.`);
    return serverChecks("android", servers, ctx.request, ctx.strings[0]?.file ?? "classes.dex", ctx.facts.debuggable);
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Languages                                                                                       */

/** Counts the texts (string resources) for each language in resources.arsc. "" is the default language. */
export function arscStringCounts(buf: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  if (buf.length < 12 || buf.readUInt16LE(0) !== 0x0002) return counts;
  let off = buf.readUInt16LE(2);
  while (off + 8 <= buf.length) {
    const type = buf.readUInt16LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8) break;
    if (type === 0x0200) {
      // Package: its type-name pool, then the type chunks.
      const header = buf.readUInt16LE(off + 2);
      const typeStringsAt = off + buf.readUInt32LE(off + 268);
      const typeNames = poolStrings(buf, typeStringsAt);
      let p = off + header;
      const end = off + size;
      while (p + 8 <= end) {
        const t = buf.readUInt16LE(p);
        const tsize = buf.readUInt32LE(p + 4);
        if (tsize < 8) break;
        if (t === 0x0201 && typeNames[buf[p + 8] - 1] === "string") {
          const hsize = buf.readUInt16LE(p + 2);
          const flags = buf[p + 9];
          const count = buf.readUInt32LE(p + 12);
          const cfg = p + 20;
          const lang = buf.toString("latin1", cfg + 8, cfg + 10).replace(/\0/g, "");
          const region = buf.toString("latin1", cfg + 10, cfg + 12).replace(/\0/g, "");
          const key = lang && !(buf[cfg + 8] & 0x80) ? (region && !(buf[cfg + 10] & 0x80) ? `${lang}-${region}` : lang) : lang ? "?" : "";
          let n = 0;
          if (flags & 0x01) n = count; // sparse: only present entries are listed
          else if (flags & 0x02) for (let i = 0; i < count; i++) n += buf.readUInt16LE(p + hsize + i * 2) !== 0xffff ? 1 : 0; // 16-bit offsets
          else for (let i = 0; i < count; i++) if (buf.readUInt32LE(p + hsize + i * 4) !== 0xffffffff) n++;
          if (key !== "?") counts.set(key, (counts.get(key) ?? 0) + n);
        }
        p += tsize;
      }
    }
    off += size;
  }
  return counts;
}

function poolStrings(buf: Buffer, off: number): string[] {
  const out: string[] = [];
  try {
    const header = buf.readUInt16LE(off + 2);
    const count = buf.readUInt32LE(off + 8);
    const utf8 = (buf.readUInt32LE(off + 16) & 0x100) !== 0;
    const start = buf.readUInt32LE(off + 20);
    for (let i = 0; i < count; i++) {
      let p = off + start + buf.readUInt32LE(off + header + i * 4);
      if (utf8) {
        p += buf[p] & 0x80 ? 2 : 1;
        let len = buf[p];
        if (len & 0x80) len = ((len & 0x7f) << 8) | buf[++p];
        out.push(buf.toString("utf8", p + 1, p + 1 + len));
      } else {
        const len = buf.readUInt16LE(p);
        out.push(buf.toString("utf16le", p + 2, p + 2 + len * 2));
      }
    }
  } catch {
    /* damaged pool */
  }
  return out;
}

export const androidLanguagesAgent: ApkAgent = {
  ...base,
  id: "android.languages",
  name: "Languages",
  description: "Lists the languages the app is translated into (from resources.arsc) and finds languages with texts missing.",
  category: "functional",
  run(ctx) {
    const arsc = ctx.entries.find((e) => e.name === "resources.arsc");
    if (!arsc) {
      if (ctx.facts.packaging === "aab") ctx.note("Languages are read from resources.arsc, which an app bundle does not have; upload the universal APK to check translations.");
      return [];
    }
    const counts = arscStringCounts(readEntry(ctx.apk, arsc));
    const base = counts.get("") ?? 0;
    counts.delete("");
    const { languages, findings } = languageChecks(counts, base, "resources.arsc");
    ctx.summary.languages = languages;
    if (languages.length) ctx.note(`Translated into: ${languages.join(", ")} (plus the default language).`);
    return findings;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Store readiness                                                                                 */

export const androidStoreAgent: ApkAgent = {
  ...base,
  id: "android.store",
  name: "Store readiness",
  description: "Checks what Google Play and phones refuse: no app icon or name, and screens with intent filters but no android:exported on Android 12+.",
  category: "functional",
  run(ctx) {
    const out: Finding[] = [];
    if (ctx.facts.hasIcon === false) add(out, "android:no-icon", "medium", "The app has no icon", "The <application> element has no android:icon, so phones show the default robot. Add an adaptive icon (Image Asset in Android Studio).", MANIFEST, "android:icon missing", "functional");
    if (ctx.facts.hasLabel === false) add(out, "android:no-label", "low", "The app has no name in the manifest", "The <application> element has no android:label, so phones show the package name under the icon.", MANIFEST, "android:label missing", "functional");
    if ((ctx.facts.targetSdk ?? 0) >= 31) {
      const missing = ctx.facts.components.filter((c) => c.kind !== "provider" && !c.exportedExplicit && (c.actions.length || c.categories.length)).map((c) => c.name);
      if (missing.length) {
        add(
          out,
          "android:exported-missing",
          "high",
          "The app will not install on Android 12 or newer",
          `It targets Android 12+ (API ${ctx.facts.targetSdk}), where every screen, service or receiver with an intent filter must say android:exported="true" or "false". Without it the install fails (INSTALL_PARSE_FAILED_MANIFEST_MALFORMED) and Google Play rejects the upload.`,
          MANIFEST,
          missing.slice(0, 6).join("\n"),
        );
      }
    }
    return out;
  },
};

export const ANDROID_EXTRA_AGENTS: ApkAgent[] = [
  androidCodeAgent,
  androidSdksAgent,
  androidFrameworkAgent,
  androidLibrariesAgent,
  androidSizeAgent,
  androidLinksAgent,
  androidServersAgent,
  androidLanguagesAgent,
  androidStoreAgent,
];
