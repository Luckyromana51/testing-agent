import { attrBool, findAll } from "../../engines/axml.js";
import { readEntry } from "../../engines/zip.js";
import { finding } from "../../runner/finding.js";
import type { Category, Finding, Severity } from "../../types.js";
import { SECRET_PATTERNS } from "../code/secrets.js";
import type { EngineAgent } from "../types.js";
import type { AndroidComponent, ApkContext } from "./context.js";

type ApkAgent = EngineAgent<ApkContext>;
const base = { engine: "mobile" as const, products: ["android" as const] };
const MANIFEST = "AndroidManifest.xml";

const add = (
  out: Finding[],
  rule: string,
  severity: Severity,
  title: string,
  detail: string,
  pageUrl = MANIFEST,
  evidence?: string,
  category: Category = "security",
) => out.push(finding({ category, rule, severity, title, detail, pageUrl, evidence }));

/** The first Android version that blocks plain HTTP by default (Android 9). */
const CLEARTEXT_OFF_FROM = 28;
/** Google Play's target API rule: API 35 for new apps and updates since 31 August 2025. */
export const PLAY_MIN_TARGET = 35;

/** Whether plain HTTP is allowed for the whole app, and the domains it is allowed for. */
export function cleartextPolicy(facts: ApkContext["facts"]): { app: boolean; domains: string[]; source: string } {
  const target = facts.targetSdk ?? 0;
  const nsc = facts.networkConfig?.node;
  if (nsc) {
    const baseCfg = nsc.children.find((c) => c.tag === "base-config");
    const app = attrBool(baseCfg?.attrs.cleartextTrafficPermitted) ?? target < CLEARTEXT_OFF_FROM;
    const domains: string[] = [];
    for (const d of findAll(nsc, "domain-config")) {
      if (attrBool(d.attrs.cleartextTrafficPermitted) !== true) continue;
      for (const dom of d.children.filter((c) => c.tag === "domain")) if (dom.text) domains.push(dom.text.trim());
    }
    return { app, domains, source: facts.networkConfig!.file };
  }
  return { app: facts.usesCleartextTraffic ?? target < CLEARTEXT_OFF_FROM, domains: [], source: MANIFEST };
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|10\.0\.2\.2|10\.0\.3\.2)$/;

/* ---------------------------------------------------------------------------------------------- */

export const androidManifestAgent: ApkAgent = {
  ...base,
  id: "android.manifest",
  name: "App settings",
  description: "Reads AndroidManifest.xml: debug builds, backups, plain HTTP and the target Android version.",
  category: "security",
  run({ facts }) {
    const out: Finding[] = [];
    if (facts.debuggable) {
      add(
        out,
        "android:debuggable",
        "critical",
        "The app is a debug build",
        "android:debuggable is on, so anyone with a USB cable can attach a debugger, read the app's files and change how it runs. Build a release version (Build > Generate Signed Bundle) before publishing.",
        MANIFEST,
        'android:debuggable="true"',
      );
    }
    if (facts.testOnly) {
      add(out, "android:test-only", "high", "The app is marked test-only", "android:testOnly is on: Google Play rejects it and phones only install it with adb. Build a release version.", MANIFEST, 'android:testOnly="true"', "functional");
    }
    const target = facts.targetSdk;
    if (facts.allowBackup !== false && !facts.hasBackupRules && target !== undefined && target < 31) {
      add(
        out,
        "android:backup",
        "medium",
        "App data can be copied off the phone with a USB backup",
        "android:allowBackup is on (the default) and the app targets an Android version before 12, so adb backup copies its files, including login tokens. Set android:allowBackup=\"false\", or list what to leave out with android:fullBackupContent.",
        MANIFEST,
        facts.allowBackup === undefined ? "allowBackup not set (defaults to true)" : 'android:allowBackup="true"',
      );
    }
    const cleartext = cleartextPolicy(facts);
    if (cleartext.app) {
      add(
        out,
        "android:cleartext",
        "high",
        "The app allows unencrypted HTTP connections",
        `${
          cleartext.source === MANIFEST
            ? facts.usesCleartextTraffic
              ? 'android:usesCleartextTraffic="true" is set'
              : `the app targets Android API ${target ?? "unknown"}, where plain HTTP is allowed by default`
            : `the network security config (${cleartext.source}) allows plain HTTP for every server`
        }, so logins and data can be read on public Wi-Fi. Use https:// for every server and turn cleartext off.`,
        cleartext.source,
      );
    } else {
      const outside = cleartext.domains.filter((d) => !LOCAL_HOST.test(d));
      if (outside.length) {
        add(
          out,
          "android:cleartext-domains",
          "medium",
          "Some servers are allowed over unencrypted HTTP",
          `The network security config allows plain HTTP to ${outside.slice(0, 5).join(", ")}. Move those servers to HTTPS and remove the exception.`,
          cleartext.source,
          outside.slice(0, 5).join(", "),
        );
      }
    }
    const nsc = facts.networkConfig;
    if (nsc) {
      const anchors = findAll(nsc.node, "base-config").flatMap((b) => findAll(b, "certificates"));
      if (anchors.some((c) => c.attrs.src === "user")) {
        add(
          out,
          "android:user-certs",
          "medium",
          "The app trusts certificates the phone's user installs",
          "The base config trusts user-added certificate authorities, so anyone who can install a certificate on the phone (or trick the user into it) can read the app's HTTPS traffic. Trust only system certificates outside debug-overrides.",
          nsc.file,
          '<certificates src="user" />',
        );
      }
    }
    if (target !== undefined && target < PLAY_MIN_TARGET) {
      add(
        out,
        "android:old-target",
        "high",
        "Targets an Android version Google Play no longer accepts",
        `The app targets API ${target}. Google Play has required new apps and updates to target API ${PLAY_MIN_TARGET} (Android 15) or newer since 31 August 2025, and raises the bar every August. Raise targetSdkVersion and test the behaviour changes.`,
        MANIFEST,
        `targetSdkVersion ${target}`,
        "functional",
      );
    }
    if (facts.minSdk !== undefined && facts.minSdk < 23) {
      add(
        out,
        "android:old-min-sdk",
        "low",
        "Installs on very old Android versions",
        `minSdkVersion is ${facts.minSdk}: phones that old get no security updates and lack runtime permissions. Consider API 24 or newer.`,
        MANIFEST,
        `minSdkVersion ${facts.minSdk}`,
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

/** Play-restricted: only allowed for default SMS, phone or assistant apps, or with an approved exception. */
const RESTRICTED = ["READ_SMS", "RECEIVE_SMS", "SEND_SMS", "RECEIVE_MMS", "RECEIVE_WAP_PUSH", "READ_CALL_LOG", "WRITE_CALL_LOG", "PROCESS_OUTGOING_CALLS"];
/** Need a declaration form in Play Console. */
const DECLARE = [
  "MANAGE_EXTERNAL_STORAGE",
  "QUERY_ALL_PACKAGES",
  "REQUEST_INSTALL_PACKAGES",
  "ACCESS_BACKGROUND_LOCATION",
  "USE_FULL_SCREEN_INTENT",
  "USE_EXACT_ALARM",
  "READ_MEDIA_IMAGES",
  "READ_MEDIA_VIDEO",
];
const SENSITIVE = [
  "CAMERA",
  "RECORD_AUDIO",
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "READ_CONTACTS",
  "WRITE_CONTACTS",
  "READ_PHONE_STATE",
  "READ_PHONE_NUMBERS",
  "CALL_PHONE",
  "READ_CALENDAR",
  "WRITE_CALENDAR",
  "BODY_SENSORS",
  "READ_EXTERNAL_STORAGE",
  "WRITE_EXTERNAL_STORAGE",
  "GET_ACCOUNTS",
  "SYSTEM_ALERT_WINDOW",
];
const short = (p: string) => p.replace(/^android\.permission\./, "");

export const androidPermissionsAgent: ApkAgent = {
  ...base,
  id: "android.permissions",
  name: "Permissions",
  description: "Lists the permissions the app asks for and flags ones Google Play restricts or asks you to justify.",
  category: "security",
  run({ facts, note }) {
    const out: Finding[] = [];
    const own = facts.permissions.filter((p) => p.startsWith("android.permission.")).map(short);
    const restricted = own.filter((p) => RESTRICTED.includes(p));
    const declare = own.filter((p) => DECLARE.includes(p));
    const sensitive = own.filter((p) => SENSITIVE.includes(p));
    if (restricted.length) {
      add(
        out,
        "android:restricted-permissions",
        "high",
        "Uses SMS or call log permissions that Google Play restricts",
        `The app asks for ${restricted.join(", ")}. Play only allows these for the default SMS or phone app, or with an approved exception; otherwise the app is rejected. For OTP login use the SMS Retriever or SMS User Consent API, which need no permission.`,
        MANIFEST,
        restricted.join(", "),
        "functional",
      );
    }
    if (declare.length) {
      add(
        out,
        "android:declared-permissions",
        "medium",
        "Uses permissions that need a Google Play declaration",
        `${declare.join(", ")} must be justified in Play Console (App content > Sensitive permissions), or the update is rejected. Remove any you do not need: photo pickers need no media permission.`,
        MANIFEST,
        declare.join(", "),
        "functional",
      );
    }
    if (sensitive.length) {
      add(
        out,
        "android:sensitive-permissions",
        "info",
        "Sensitive permissions to double-check",
        `The app can ask for ${sensitive.join(", ")}. Check each one is needed and explained in the privacy policy and Play's Data safety form.`,
        MANIFEST,
        sensitive.join(", "),
      );
    }
    note(`Asks for ${facts.permissions.length} permissions.`);
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const BENIGN_ACTIVITY = (c: AndroidComponent) =>
  c.categories.includes("android.intent.category.LAUNCHER") ||
  c.categories.includes("android.intent.category.BROWSABLE") ||
  c.categories.includes("android.intent.category.HOME") ||
  c.actions.includes("android.intent.action.VIEW") ||
  c.actions.includes("android.intent.action.SEND") ||
  c.actions.includes("android.intent.action.SEND_MULTIPLE");

export const androidComponentsAgent: ApkAgent = {
  ...base,
  id: "android.components",
  name: "Exposed components",
  description: "Finds screens, services, receivers and content providers that any other app on the phone can open.",
  category: "security",
  run({ facts }) {
    const out: Finding[] = [];
    // Only the app's own classes: libraries are the library maker's to fix.
    const mine = (c: AndroidComponent) => c.name.startsWith(".") || c.name.startsWith(`${facts.packageName}.`);
    const unprotected = (perm?: string) => {
      if (!perm) return true;
      const level = facts.definedPermissions.get(perm);
      // A permission the app defines at "normal" or "dangerous" level can be requested by any app.
      return level !== undefined && (level & 0xf) < 2;
    };
    const open = facts.components.filter((c) => c.exported && mine(c));
    const providers = open.filter((c) => c.kind === "provider" && unprotected(c.permission) && unprotected(c.readPermission ?? c.writePermission));
    const services = open.filter((c) => (c.kind === "service" || c.kind === "receiver") && unprotected(c.permission));
    const activities = open.filter((c) => (c.kind === "activity" || c.kind === "activity-alias") && unprotected(c.permission) && !BENIGN_ACTIVITY(c));
    const names = (list: AndroidComponent[]) => list.map((c) => c.name.replace(facts.packageName, "")).slice(0, 6).join(", ");
    if (providers.length) {
      add(
        out,
        "android:open-provider",
        "high",
        "Other apps can read the app's data (open content provider)",
        `${names(providers)} ${providers.length === 1 ? "is" : "are"} exported without a permission, so any app on the phone can query ${providers.length === 1 ? "it" : "them"}. Set android:exported="false", or protect ${providers.length === 1 ? "it" : "them"} with a signature-level permission.`,
        MANIFEST,
        names(providers),
      );
    }
    if (services.length) {
      add(
        out,
        "android:open-service",
        "medium",
        "Other apps can start the app's services or send it broadcasts",
        `${names(services)} ${services.length === 1 ? "is" : "are"} exported without a permission. A malicious app could trigger ${services.length === 1 ? "it" : "them"} with fake data. Set android:exported="false" unless other apps must call ${services.length === 1 ? "it" : "them"}, and add android:permission if so.`,
        MANIFEST,
        names(services),
      );
    }
    if (activities.length) {
      add(
        out,
        "android:open-activity",
        "low",
        "Inner screens can be opened directly by other apps",
        `${names(activities)} can be launched by any app, skipping the screens before ${activities.length === 1 ? "it" : "them"} (such as the login). Set android:exported="false" on screens that are not entry points.`,
        MANIFEST,
        names(activities),
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const IP = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Text constants in Java/Kotlin code (dex) that look like an AES or DES key: exactly 16, 24 or 32
 * characters (the key sizes), naming a key or secret, with a digit or symbol, in an app that builds
 * keys with SecretKeySpec. InsecureBank's "This is the super secret key 123" is the classic case.
 */
export function dexCryptoKeys(dex: string): string[] {
  if (!dex.includes("javax/crypto/spec/SecretKeySpec")) return [];
  const keys: string[] = [];
  // A dex string is its length (one byte under 128), the characters, then a zero byte.
  for (const m of dex.matchAll(/([\x10\x18\x20])([\x20-\x7e]{16,32})\x00/g)) {
    const text = m[2];
    if (m[1].charCodeAt(0) !== text.length) continue;
    if (!/key|secret|pass|crypt|aes/i.test(text) || !/[\d\W]/.test(text.replace(/ /g, ""))) continue;
    if (/[/;<>]|^[\w$]+(\.[\w$]+)+$|\s{2}|%[sd]/.test(text)) continue; // class names, formats
    keys.push(text);
    if (keys.length >= 5) break;
  }
  return keys;
}
const COMMON_WORDS = new Set(["com", "org", "net", "in", "co", "io", "app", "apps", "android", "mobile", "www", "api", "test"]);

export const androidSecretsAgent: ApkAgent = {
  ...base,
  id: "android.secrets",
  name: "Hard-coded secrets and servers",
  description: "Searches the app's code for API keys, private keys and database passwords, and for servers called over plain HTTP.",
  category: "security",
  run({ strings, facts, note }) {
    const out: Finding[] = [];
    const patterns = SECRET_PATTERNS.filter((p) => p.id !== "generic" && !p.fileHas);
    for (const p of patterns) {
      for (const s of strings) {
        const m = p.re.exec(s.text);
        if (!m) continue;
        const value = m[p.group ?? 0] ?? m[0];
        const google = p.id === "google-api-key";
        add(
          out,
          `android:secret-${p.id}`,
          google ? "info" : p.severity,
          `The app contains ${p.what}`,
          google
            ? "Google keys in apps are visible to anyone who unpacks the APK. That is normal for Firebase and Maps, but restrict the key to your package name and signing certificate (SHA-1) in Google Cloud console."
            : `Anyone can unpack the APK and read it. ${p.fix} Apps should get secrets from your server after the user logs in, never carry them.`,
          s.file,
          p.id === "private-key" ? "-----BEGIN ... PRIVATE KEY-----" : `${value.slice(0, 4)}***${value.slice(-2)}`,
        );
        break;
      }
    }

    for (const s of strings) {
      if (!/\.dex$/.test(s.file)) continue;
      const keys = dexCryptoKeys(s.text);
      if (!keys.length) continue;
      add(
        out,
        "android:hardcoded-crypto-key",
        "high",
        "The app has its encryption key written in the code",
        `The app encrypts with SecretKeySpec and carries ${keys.length === 1 ? "a key" : `${keys.length} likely keys`} as plain text. Anyone can unpack the APK, read the key and decrypt what the app saved or sent with it. Create the key in the Android Keystore (KeyGenerator with AndroidKeyStore), or get it from your server after login.`,
        s.file,
        keys.map((k) => `"${k.slice(0, 4)}…${k.slice(-3)}" (${k.length} characters)`).join("\n"),
      );
      break;
    }

    // Plain-HTTP servers the app itself talks to: IP addresses, or hosts named after the app.
    const tokens = facts.packageName
      .split(".")
      .filter((t) => t.length >= 4 && !COMMON_WORDS.has(t))
      .map((t) => t.toLowerCase());
    const hosts = new Set<string>();
    for (const s of strings) {
      for (const m of s.text.matchAll(/http:\/\/([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\//gi)) {
        const host = m[1].toLowerCase();
        if (LOCAL_HOST.test(host) || /^(0|255)\./.test(host)) continue;
        if (IP.test(host) || tokens.some((t) => host.includes(t))) hosts.add(host);
      }
    }
    if (hosts.size) {
      const allowed = cleartextPolicy(facts);
      const list = [...hosts].slice(0, 6);
      add(
        out,
        "android:http-backend",
        allowed.app || list.some((h) => allowed.domains.includes(h)) ? "medium" : "low",
        "The app calls its own servers over plain HTTP",
        allowed.app
          ? `The app has http:// addresses for ${list.join(", ")} and allows unencrypted traffic, so this data travels in the clear. Move the servers to HTTPS.`
          : `The app has http:// addresses for ${list.join(", ")}, but Android blocks plain HTTP for it, so these calls fail. Move the servers to HTTPS.`,
        strings[0]?.file ?? "classes.dex",
        list.join(", "),
      );
    }
    note(`Searched ${strings.length} code files (${(strings.reduce((n, s) => n + s.text.length, 0) / 1e6).toFixed(1)} MB) for keys and server addresses.`);
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

export const androidBackendAgent: ApkAgent = {
  ...base,
  id: "android.firebase",
  name: "Firebase database",
  description: "Finds the app's Firebase Realtime Database and checks it does not let anyone read it.",
  category: "security",
  async run({ strings, request }) {
    const out: Finding[] = [];
    const urls = new Set<string>();
    for (const s of strings) {
      for (const m of s.text.matchAll(/https:\/\/[a-z0-9-]+\.(?:firebaseio\.com|[a-z0-9-]+\.firebasedatabase\.app)/gi)) urls.add(m[0].toLowerCase());
    }
    for (const url of [...urls].slice(0, 3)) {
      try {
        const res = await request.get(`${url}/.json?shallow=true`, { timeout: 15_000, failOnStatusCode: false });
        const body = (await res.text()).trim();
        if (res.status() === 200) {
          const hasData = body !== "null" && body !== "{}";
          add(
            out,
            "android:firebase-open",
            hasData ? "critical" : "medium",
            "The Firebase database can be read by anyone",
            hasData
              ? `${url} answered a request with no login with data. Anyone who unpacks the app finds this address. Change the database rules so reads need auth (".read": "auth != null") and check the data is not already copied.`
              : `${url} allows reads with no login (it is empty right now). Change the rules so reads need auth.`,
            url,
            `GET /.json -> 200${hasData ? ", data returned" : ", empty"}`,
          );
        }
      } catch {
        /* unreachable from here: nothing to report */
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const DEBUG_CERT = Buffer.from("Android Debug");

/** The v2/v3 signing block sits just before the zip's central directory. */
function signingBlock(apk: Buffer): Buffer | null {
  const magic = Buffer.from("APK Sig Block 42");
  const at = apk.lastIndexOf(magic);
  if (at < 8) return null;
  const size = Number(apk.readBigUInt64LE(at - 8));
  const start = at + 16 - size - 8;
  if (start < 0 || size > apk.length) return null;
  return apk.subarray(start, at + 16);
}

export const androidSigningAgent: ApkAgent = {
  ...base,
  id: "android.signing",
  name: "Signing",
  description: "Checks the APK is signed with a release key and a modern signature scheme.",
  category: "security",
  run({ apk, entries, facts }) {
    const out: Finding[] = [];
    const v1 = entries.filter((e) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(e.name));
    const block = signingBlock(apk);
    if (!v1.length && !block) {
      add(out, "android:unsigned", "high", "The APK is not signed", "Phones refuse to install unsigned apps. Sign it with your release key (apksigner).", "META-INF", undefined, "functional");
      return out;
    }
    const v1Debug = v1.some((e) => readEntry(apk, e).includes(DEBUG_CERT));
    if (v1Debug || block?.includes(DEBUG_CERT)) {
      add(
        out,
        "android:debug-signed",
        "critical",
        "Signed with the Android debug key",
        "The debug key is the same on every developer's computer, so anyone can sign a fake update that phones accept. Google Play rejects debug-signed apps. Sign with your own release key and keep it safe (or use Play App Signing).",
        v1[0]?.name ?? "APK signing block",
        "CN=Android Debug",
      );
    }
    if (!block && (facts.minSdk ?? 0) < 26) {
      add(
        out,
        "android:v1-only",
        "medium",
        "Signed only with the old v1 scheme",
        "Without a v2 or v3 signature, Android 5 to 8 phones are open to the Janus attack (CVE-2017-13156), where code is added to the app without breaking its signature. Sign with apksigner, which adds v2 and v3.",
        v1[0]?.name ?? "META-INF",
        "v1 (JAR) signature only",
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

/** Smallest LOAD segment alignment in a 64-bit ELF library, or null when it cannot be read. */
export function elfMinAlign(head: Buffer): number | null {
  if (head.length < 64 || head.readUInt32BE(0) !== 0x7f454c46 || head[4] !== 2) return null;
  const phoff = Number(head.readBigUInt64LE(0x20));
  const phentsize = head.readUInt16LE(0x36);
  const phnum = head.readUInt16LE(0x38);
  let min: number | null = null;
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (p + 56 > head.length) return min;
    if (head.readUInt32LE(p) !== 1) continue; // PT_LOAD
    const align = Number(head.readBigUInt64LE(p + 0x30));
    min = min === null ? align : Math.min(min, align);
  }
  return min;
}

export const androidNativeAgent: ApkAgent = {
  ...base,
  id: "android.native",
  name: "Native libraries",
  description: "Checks native code has 64-bit versions and supports 16 KB memory pages, as Google Play requires.",
  category: "functional",
  run({ apk, entries, facts, note }) {
    const out: Finding[] = [];
    const libs = entries.filter((e) => /^lib\/[^/]+\/[^/]+\.so$/.test(e.name));
    if (!libs.length) return out;
    const abis = [...new Set(libs.map((e) => e.name.split("/")[1]))];
    note(`Native code for ${abis.join(", ")} (${libs.length} libraries).`);
    if ((abis.includes("armeabi-v7a") || abis.includes("armeabi")) && !abis.includes("arm64-v8a")) {
      add(
        out,
        "android:no-64bit",
        "high",
        "No 64-bit native code",
        "The app has 32-bit ARM libraries but no arm64-v8a versions. Google Play requires 64-bit code, and new 64-bit-only phones cannot run the app. Add arm64-v8a to abiFilters.",
        "lib/",
        abis.join(", "),
        "functional",
      );
    }
    const unaligned: string[] = [];
    for (const e of libs.filter((l) => /^lib\/(arm64-v8a|x86_64)\//.test(l.name))) {
      try {
        const align = elfMinAlign(readEntry(apk, e, 4096));
        if (align !== null && align < 16_384) unaligned.push(e.name.split("/").pop()!);
      } catch {
        /* unreadable library: skipped */
      }
    }
    if (unaligned.length) {
      const required = (facts.targetSdk ?? 0) >= 35;
      add(
        out,
        "android:16kb-pages",
        required ? "high" : "medium",
        "Native libraries do not support 16 KB memory pages",
        `${[...new Set(unaligned)].slice(0, 5).join(", ")} ${unaligned.length === 1 ? "is" : "are"} built for 4 KB pages only. Since 1 November 2025 Google Play requires 16 KB support for apps targeting Android 15 or newer, and these libraries crash on 16 KB phones. Update the library (or the NDK to r28+, AGP 8.5.1+) and rebuild.`,
        `lib/arm64-v8a/${unaligned[0]}`,
        `${unaligned.length} libraries`,
        "functional",
      );
    }
    return out;
  },
};

export const ANDROID_AGENTS: ApkAgent[] = [
  androidManifestAgent,
  androidPermissionsAgent,
  androidComponentsAgent,
  androidSigningAgent,
  androidSecretsAgent,
  androidBackendAgent,
  androidNativeAgent,
];
