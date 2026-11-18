import { arr, bool, dict, str, type PlistDict } from "../../engines/plist.js";
import { sizeText } from "../../engines/zip.js";
import { finding } from "../../runner/finding.js";
import { NotTestedError } from "../../runner/coverage.js";
import type { Category, Finding, Severity } from "../../types.js";
import { SECRET_PATTERNS } from "../code/secrets.js";
import type { EngineAgent } from "../types.js";
import { openFirebaseFindings } from "./firebase.js";
import type { IosContext } from "./ios-context.js";

type IosAgent = EngineAgent<IosContext>;
const base = { engine: "mobile" as const, products: ["ios" as const] };

const add = (out: Finding[], rule: string, severity: Severity, title: string, detail: string, pageUrl: string, evidence?: string, category: Category = "security") =>
  out.push(finding({ category, rule, severity, title, detail, pageUrl, evidence }));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const infoPlist = (ctx: IosContext) => `${ctx.facts.appDir}Info.plist`;
const short = (ctx: IosContext, file: string) => file.slice(ctx.facts.appDir.length) || file;

/* ---------------------------------------------------------------------------------------------- */
/* Searching the program files                                                                    */

/**
 * Names in a program's symbol and selector tables sit between zero bytes, so searching with the
 * zeros around them finds the exact name, not a longer one that contains it ("_stat" in "_status").
 */
const exact = (name: string) => `\0${name}\0`;
/** An Objective-C class the code uses (Swift code that uses UIKit or Foundation classes too). */
export const cls = (name: string) => exact(`_OBJC_CLASS_$_${name}`);
/** A method name (selector) the code calls. */
export const sel = (name: string) => exact(name);
/** A C function or constant the code imports. */
export const sym = (name: string) => exact(`_${name}`);

/** The program files that contain any of the signals. */
export function filesWith(ctx: IosContext, signals: string[]): string[] {
  return ctx.programs.filter((p) => signals.some((s) => p.text.includes(s))).map((p) => p.file);
}

/** The code cannot be searched: the App Store's encrypted copy, or the program file is missing. */
function codeHidden(ctx: IosContext): string | null {
  if (ctx.facts.encrypted) {
    return "the app's code is encrypted (this is the copy the App Store hands out), so it could not be searched. Upload an IPA exported from Xcode (Development or Ad Hoc) for a full test";
  }
  if (!ctx.programs.some((p) => p.file === ctx.facts.executable)) return "the app's program file is missing or too large to read, so its code could not be searched";
  return null;
}

/* ---------------------------------------------------------------------------------------------- */

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i;

/** Hosts App Transport Security lets the app reach over plain HTTP: everything, or a list. */
export function atsPolicy(info: PlistDict): { all: boolean; ignoredAll: string[]; webContent: boolean; insecure: string[]; oldTls: string[] } {
  const ats = dict(info.NSAppTransportSecurity) ?? {};
  // From iOS 10, any of these makes iOS ignore NSAllowsArbitraryLoads.
  const ignoredAll = ["NSAllowsArbitraryLoadsInWebContent", "NSAllowsArbitraryLoadsForMedia", "NSAllowsLocalNetworking"].filter((k) => k in ats);
  const insecure: string[] = [];
  const oldTls: string[] = [];
  const domains = dict(ats.NSExceptionDomains) ?? {};
  for (const [domain, raw] of Object.entries(domains)) {
    const cfg = dict(raw) ?? {};
    const label = `${domain}${bool(cfg.NSIncludesSubdomains) ? " (and its subdomains)" : ""}`;
    if (!LOCAL.test(domain) && (bool(cfg.NSExceptionAllowsInsecureHTTPLoads) || bool(cfg.NSTemporaryExceptionAllowsInsecureHTTPLoads))) insecure.push(label);
    const tls = str(cfg.NSExceptionMinimumTLSVersion) ?? str(cfg.NSTemporaryExceptionMinimumTLSVersion);
    if (tls && /^TLSv1\.[01]$/.test(tls)) oldTls.push(`${label}: ${tls}`);
  }
  return { all: bool(ats.NSAllowsArbitraryLoads) === true && !ignoredAll.length, ignoredAll, webContent: bool(ats.NSAllowsArbitraryLoadsInWebContent) === true, insecure, oldTls };
}

export const iosSettingsAgent: IosAgent = {
  ...base,
  id: "ios.settings",
  name: "App settings",
  description: "Reads Info.plist: App Transport Security (plain HTTP and old TLS), the Documents folder shared with Finder, custom link schemes and the export compliance answer.",
  category: "security",
  run(ctx) {
    const { info, facts } = ctx;
    const out: Finding[] = [];
    const at = infoPlist(ctx);
    const ats = atsPolicy(info);
    if (ats.all) {
      add(
        out,
        "ios:ats-off",
        "medium",
        "App Transport Security is switched off for the whole app",
        "NSAllowsArbitraryLoads lets the app talk to any server over plain HTTP or weak TLS, so data can be read or changed on the way (public Wi-Fi, a hostile network). Apple asks for a reason at App Review. Remove it and add exceptions only for the servers that need them.",
        at,
        "NSAppTransportSecurity > NSAllowsArbitraryLoads = YES",
      );
    } else if (bool(dict(info.NSAppTransportSecurity)?.NSAllowsArbitraryLoads) && ats.ignoredAll.length) {
      ctx.note(`NSAllowsArbitraryLoads is set but iOS ignores it, because ${ats.ignoredAll.join(" and ")} ${ats.ignoredAll.length === 1 ? "is" : "are"} set too.`);
    }
    if (ats.webContent) {
      add(
        out,
        "ios:ats-web-content",
        "low",
        "Web pages inside the app may load over plain HTTP",
        "NSAllowsArbitraryLoadsInWebContent lets the app's web views open any http:// page. Anything typed into those pages travels in the clear. Keep it only if the app must show other people's websites.",
        at,
        "NSAppTransportSecurity > NSAllowsArbitraryLoadsInWebContent = YES",
      );
    }
    if (ats.insecure.length) {
      add(
        out,
        "ios:ats-http-domains",
        "low",
        `${plural(ats.insecure.length, "server is", "servers are")} allowed over plain HTTP`,
        "These App Transport Security exceptions let the app reach the servers over http://, so what it sends and receives can be read or changed on the way. Move them to HTTPS and remove the exceptions.",
        at,
        ats.insecure.slice(0, 10).join("\n"),
      );
    }
    if (ats.oldTls.length) {
      add(
        out,
        "ios:ats-old-tls",
        "medium",
        `${plural(ats.oldTls.length, "server is", "servers are")} allowed TLS 1.0 or 1.1`,
        "TLS 1.0 and 1.1 have known weaknesses and are switched off by every current browser. Update the servers to TLS 1.2 or 1.3 and remove NSExceptionMinimumTLSVersion.",
        at,
        ats.oldTls.slice(0, 10).join("\n"),
      );
    }
    if (bool(info.UIFileSharingEnabled)) {
      add(
        out,
        "ios:file-sharing",
        "low",
        "The app's Documents folder is visible in Finder and the Files app",
        `UIFileSharingEnabled${bool(info.LSSupportsOpeningDocumentsInPlace) ? " with LSSupportsOpeningDocumentsInPlace" : ""} lets anyone with the unlocked phone copy everything the app keeps in Documents: databases, downloads, and any tokens saved there. Keep private data in Library/Application Support (and tokens in the Keychain), or turn file sharing off.`,
        at,
        "UIFileSharingEnabled = YES",
      );
    }
    const schemes = arr(info.CFBundleURLTypes)
      .flatMap((t) => arr(dict(t)?.CFBundleURLSchemes))
      .map((s) => str(s) ?? "")
      .filter((s) => s && s !== facts.bundleId && !/^(fb\d+|com\.googleusercontent\.apps\.|msauth\.|db-)/i.test(s));
    if (schemes.length) {
      add(
        out,
        "ios:url-schemes",
        "info",
        `The app opens from ${plural(schemes.length, "custom link scheme")}`,
        "Any app or web page can open the app with these links, with any parameters it likes. Check every parameter the app reads from them, never let a link sign in, pay or delete without the user confirming, and use Universal Links (https) for anything sensitive: another app can claim the same scheme.",
        at,
        schemes.slice(0, 10).map((s) => `${s}://`).join("\n"),
      );
    }
    if (!facts.simulator && !("ITSAppUsesNonExemptEncryption" in info)) {
      add(
        out,
        "ios:export-compliance",
        "info",
        "App Store Connect will ask about encryption at every upload",
        "Info.plist does not answer the export compliance question, so each build waits in App Store Connect until someone answers it. If the app only uses HTTPS and Apple's own encryption, add ITSAppUsesNonExemptEncryption = NO.",
        at,
        undefined,
        "functional",
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

interface Purpose {
  what: string;
  /** Info.plist keys, any of which answers it. */
  keys: string[];
  signals: string[];
  /** Missing it ends the app when it asks (most); for Face ID iOS falls back instead. */
  crashes: boolean;
}

/** The APIs that make iOS ask the user, and the purpose texts iOS needs for them. */
export const PURPOSES: Purpose[] = [
  { what: "the camera or microphone", keys: ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"], signals: [cls("AVCaptureDeviceInput"), sel("requestAccessForMediaType:completionHandler:")], crashes: true },
  { what: "the microphone", keys: ["NSMicrophoneUsageDescription"], signals: [cls("AVAudioRecorder"), sel("requestRecordPermission:"), sel("requestRecordPermissionWithCompletionHandler:")], crashes: true },
  { what: "location", keys: ["NSLocationWhenInUseUsageDescription"], signals: [sel("requestWhenInUseAuthorization")], crashes: true },
  { what: "location all the time", keys: ["NSLocationAlwaysAndWhenInUseUsageDescription"], signals: [sel("requestAlwaysAuthorization")], crashes: true },
  { what: "contacts", keys: ["NSContactsUsageDescription"], signals: [sel("requestAccessForEntityType:completionHandler:")], crashes: true },
  {
    what: "calendars or reminders",
    keys: ["NSCalendarsUsageDescription", "NSCalendarsFullAccessUsageDescription", "NSCalendarsWriteOnlyAccessUsageDescription", "NSRemindersUsageDescription", "NSRemindersFullAccessUsageDescription"],
    signals: [sel("requestAccessToEntityType:completion:"), sel("requestFullAccessToEventsWithCompletion:"), sel("requestWriteOnlyAccessToEventsWithCompletion:"), sel("requestFullAccessToRemindersWithCompletion:")],
    crashes: true,
  },
  { what: "the photo library", keys: ["NSPhotoLibraryUsageDescription", "NSPhotoLibraryAddUsageDescription"], signals: [cls("PHPhotoLibrary")], crashes: true },
  { what: "speech recognition", keys: ["NSSpeechRecognitionUsageDescription"], signals: [cls("SFSpeechRecognizer")], crashes: true },
  { what: "Bluetooth", keys: ["NSBluetoothAlwaysUsageDescription", "NSBluetoothPeripheralUsageDescription"], signals: [cls("CBCentralManager"), cls("CBPeripheralManager")], crashes: true },
  { what: "motion and fitness data", keys: ["NSMotionUsageDescription"], signals: [cls("CMMotionActivityManager"), cls("CMPedometer")], crashes: true },
  { what: "tracking across other companies' apps", keys: ["NSUserTrackingUsageDescription"], signals: [cls("ATTrackingManager")], crashes: true },
  { what: "Health data", keys: ["NSHealthShareUsageDescription", "NSHealthUpdateUsageDescription"], signals: [cls("HKHealthStore")], crashes: true },
  { what: "HomeKit", keys: ["NSHomeKitUsageDescription"], signals: [cls("HMHomeManager")], crashes: true },
  { what: "NFC tags", keys: ["NFCReaderUsageDescription"], signals: [cls("NFCNDEFReaderSession"), cls("NFCTagReaderSession")], crashes: true },
  { what: "the music library", keys: ["NSAppleMusicUsageDescription"], signals: [cls("MPMediaLibrary"), cls("MPMediaQuery")], crashes: true },
  { what: "Face ID", keys: ["NSFaceIDUsageDescription"], signals: [sel("evaluatePolicy:localizedReason:reply:")], crashes: false },
];

/** A purpose text that does not say why: too short, generic, or a placeholder. */
export function vaguePurpose(text: string): boolean {
  const t = text.trim();
  if (t.length < 20 || /\b(lorem|todo|tbd|placeholder)\b/i.test(t)) return true;
  // "needs access to your camera" says what, not why: take those words out before looking for a reason.
  const why = t.replace(/\b(access|permission)\s+to\b/gi, "").replace(/\bwould like to\b/gi, "").replace(/\b(needs?|requires?)\s+to\s+(use|access)\b/gi, "");
  return !/\b(to|so|for|when|because|while|lets?|helps?|scan|share|save|upload|show|find|record|take|send|add|pick|choose|attach)\b/i.test(why);
}

export const iosPermissionsAgent: IosAgent = {
  ...base,
  id: "ios.permissions",
  name: "Permissions and purpose texts",
  description: "Finds the iOS permissions the code asks for (camera, location, contacts, photos, tracking and more) and checks each has a purpose text in Info.plist that says why.",
  category: "functional",
  run(ctx) {
    const out: Finding[] = [];
    const at = infoPlist(ctx);
    // Purpose texts that do not say why: App Review rejects them (guideline 5.1.1).
    const vague = Object.entries(ctx.info)
      .filter(([k, v]) => /UsageDescription$/.test(k) && typeof v === "string" && vaguePurpose(v))
      .map(([k, v]) => `${k}: "${v as string}"`);
    if (vague.length) {
      add(
        out,
        "ios:vague-purpose",
        "low",
        `${plural(vague.length, "purpose text does", "purpose texts do")} not say why the app needs it`,
        'iOS shows these texts when it asks the user. App Review rejects texts that do not explain the reason (guideline 5.1.1), and users say no more often. Say what the app does with it, like "Your camera is used to scan the bar code on your order."',
        at,
        vague.slice(0, 10).join("\n"),
        "functional",
      );
    }
    const hidden = codeHidden(ctx);
    if (hidden) throw new NotTestedError(`Purpose texts were checked, but ${hidden}.`, out);
    const done = new Set<string>();
    for (const p of PURPOSES) {
      const files = filesWith(ctx, p.signals);
      if (!files.length || p.keys.some((k) => typeof ctx.info[k] === "string" && (ctx.info[k] as string).trim())) continue;
      if (done.has(p.keys[0])) continue;
      done.add(p.keys[0]);
      add(
        out,
        "ios:missing-purpose",
        p.crashes ? "high" : "medium",
        `The app asks for ${p.what} but has no purpose text for it`,
        p.crashes
          ? `The code calls the iOS API that asks for ${p.what}, but Info.plist has no ${p.keys[0]}. iOS closes the app the moment it asks, and App Store Connect rejects the upload (ITMS-90683). Add the key with a sentence that says why the app needs it. If the call comes from an SDK the app does not use for this, the SDK's settings can usually leave it out.`
          : `The code uses ${p.what}, but Info.plist has no ${p.keys[0]}, so iOS will not show Face ID for the app and App Review rejects it. Add the key with the reason.`,
        at,
        `Called in ${files.map((f) => short(ctx, f)).slice(0, 4).join(", ")}; missing ${p.keys[0]}`,
        "functional",
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

/** Apple's "required reason" APIs (privacy manifest categories) and how the code shows each. */
export const REASON_APIS: { category: string; what: string; signals: string[] }[] = [
  { category: "NSPrivacyAccessedAPICategoryUserDefaults", what: "UserDefaults", signals: [cls("NSUserDefaults")] },
  {
    category: "NSPrivacyAccessedAPICategoryFileTimestamp",
    what: "file dates",
    signals: [sym("NSFileCreationDate"), sym("NSFileModificationDate"), sym("NSURLContentModificationDateKey"), sym("NSURLCreationDateKey"), sym("getattrlist"), sym("getattrlistbulk"), sym("fgetattrlist"), sym("getattrlistat"), sym("stat"), sym("fstat"), sym("fstatat"), sym("lstat")],
  },
  { category: "NSPrivacyAccessedAPICategorySystemBootTime", what: "time since the phone started", signals: [sel("systemUptime"), sym("mach_absolute_time")] },
  {
    category: "NSPrivacyAccessedAPICategoryDiskSpace",
    what: "free disk space",
    signals: [
      sym("NSURLVolumeAvailableCapacityKey"),
      sym("NSURLVolumeAvailableCapacityForImportantUsageKey"),
      sym("NSURLVolumeAvailableCapacityForOpportunisticUsageKey"),
      sym("NSURLVolumeTotalCapacityKey"),
      sym("NSFileSystemFreeSize"),
      sym("NSFileSystemSize"),
      sym("statfs"),
      sym("statvfs"),
      sym("fstatfs"),
      sym("fstatvfs"),
    ],
  },
  { category: "NSPrivacyAccessedAPICategoryActiveKeyboards", what: "the active keyboards", signals: [sel("activeInputModes")] },
];

/** SDKs Apple lists as needing their own privacy manifest and signature. */
export const LISTED_SDKS = new Set([
  "Abseil", "AFNetworking", "Alamofire", "AppAuth", "BoringSSL", "openssl_grpc", "Capacitor", "Charts", "connectivity_plus", "Cordova",
  "device_info_plus", "DKImagePickerController", "DKPhotoGallery", "FBAEMKit", "FBLPromises", "FBSDKCoreKit", "FBSDKCoreKit_Basics",
  "FBSDKLoginKit", "FBSDKShareKit", "file_picker", "FirebaseABTesting", "FirebaseAuth", "FirebaseCore", "FirebaseCoreDiagnostics",
  "FirebaseCoreExtension", "FirebaseCoreInternal", "FirebaseCrashlytics", "FirebaseDynamicLinks", "FirebaseFirestore",
  "FirebaseInstallations", "FirebaseMessaging", "FirebaseRemoteConfig", "Flutter", "flutter_inappwebview", "flutter_local_notifications",
  "fluttertoast", "FMDB", "geolocator_apple", "GoogleDataTransport", "GoogleSignIn", "GoogleToolboxForMac", "GoogleUtilities", "grpcpp",
  "GTMAppAuth", "GTMSessionFetcher", "hermes", "image_picker_ios", "IQKeyboardManager", "IQKeyboardManagerSwift", "Kingfisher", "leveldb",
  "Lottie", "MBProgressHUD", "nanopb", "OneSignal", "OneSignalCore", "OneSignalExtension", "OneSignalOutcomes", "OpenSSL", "OrderedSet",
  "package_info", "package_info_plus", "path_provider", "path_provider_ios", "Promises", "Protobuf", "Reachability", "RealmSwift", "RxCocoa",
  "RxRelay", "RxSwift", "SDWebImage", "share_plus", "shared_preferences_ios", "SnapKit", "sqflite", "Starscream", "SVProgressHUD",
  "SwiftyGif", "SwiftyJSON", "Toast", "UnityFramework", "url_launcher", "url_launcher_ios", "video_player_avfoundation", "wakelock",
  "webview_flutter_wkwebview",
]);

/** Categories the privacy manifest declares with at least one reason. */
export function declaredReasons(privacy: PlistDict | undefined): Set<string> {
  const out = new Set<string>();
  for (const item of arr(privacy?.NSPrivacyAccessedAPITypes)) {
    const d = dict(item);
    const type = str(d?.NSPrivacyAccessedAPIType);
    if (type && arr(d?.NSPrivacyAccessedAPITypeReasons).some((r) => typeof r === "string" && r)) out.add(type);
  }
  return out;
}

export const iosPrivacyManifestAgent: IosAgent = {
  ...base,
  id: "ios.privacy-manifest",
  name: "Privacy manifest",
  description: "Checks PrivacyInfo.xcprivacy against the 'required reason' APIs the code uses, and that SDKs on Apple's list bring their own manifest (App Store Connect rejects uploads otherwise).",
  category: "functional",
  run(ctx) {
    const out: Finding[] = [];
    const manifest = `${ctx.facts.appDir}PrivacyInfo.xcprivacy`;
    const bare = ctx.frameworks.filter((f) => LISTED_SDKS.has(f.name) && !f.hasPrivacyManifest).map((f) => f.name);
    if (bare.length) {
      add(
        out,
        "ios:sdk-privacy-manifest",
        "medium",
        `${plural(bare.length, "SDK", "SDKs")} from Apple's list ${bare.length === 1 ? "comes" : "come"} without ${bare.length === 1 ? "its" : "their"} own privacy manifest`,
        "Apple requires these widely used SDKs to carry their own privacy manifest and signature, and App Store Connect rejects uploads that add or update them without one. Update each to a current version (most added a manifest in 2024).",
        `${ctx.facts.appDir}Frameworks/`,
        bare.slice(0, 12).join(", "),
        "functional",
      );
    }
    if (ctx.privacy && bool(ctx.privacy.NSPrivacyTracking) && !arr(ctx.privacy.NSPrivacyTrackingDomains).length) {
      add(
        out,
        "ios:tracking-domains",
        "low",
        "The privacy manifest says the app tracks, but lists no tracking domains",
        "With NSPrivacyTracking on, iOS blocks the domains in NSPrivacyTrackingDomains until the user allows tracking. With none listed, nothing is held back, and the App Store privacy label may not match what the app does. List the servers the app or its SDKs track with.",
        manifest,
        "NSPrivacyTracking = YES, NSPrivacyTrackingDomains empty",
        "security",
      );
    }
    const hidden = codeHidden(ctx);
    if (hidden) throw new NotTestedError(`SDK manifests were checked, but ${hidden}.`, out);
    const main = ctx.programs.filter((p) => p.file === ctx.facts.executable);
    const used = REASON_APIS.filter((r) => main.some((p) => r.signals.some((s) => p.text.includes(s))));
    const declared = declaredReasons(ctx.privacy);
    const missing = used.filter((r) => !declared.has(r.category));
    if (missing.length) {
      const evidence = missing.map((r) => `${r.category} (${r.what})`).join("\n");
      if (!ctx.privacy) {
        add(
          out,
          "ios:no-privacy-manifest",
          "high",
          "The app has no privacy manifest, but its code uses APIs that need one",
          "Since 1 May 2024 App Store Connect rejects uploads whose code uses Apple's 'required reason' APIs without saying why in PrivacyInfo.xcprivacy (ITMS-91053). In Xcode: File > New > File > App Privacy, then add each category below with the reason that fits.",
          manifest,
          evidence,
          "functional",
        );
      } else {
        add(
          out,
          "ios:privacy-manifest-reasons",
          "high",
          `The privacy manifest leaves out ${plural(missing.length, "API category", "API categories")} the code uses`,
          "App Store Connect rejects uploads whose code uses these 'required reason' APIs when PrivacyInfo.xcprivacy does not give a reason for each (ITMS-91053). Add each category below under NSPrivacyAccessedAPITypes with the reason that fits.",
          manifest,
          evidence,
          "functional",
        );
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

export const iosBinaryAgent: IosAgent = {
  ...base,
  id: "ios.binary",
  name: "App binary",
  description: "Reads the app's program file: 64-bit code, address randomisation (PIE), signing, and the old UIWebView that the App Store refuses.",
  category: "security",
  run(ctx) {
    const out: Finding[] = [];
    const exe = ctx.facts.executable;
    const slices = ctx.binary?.slices ?? [];
    if (!slices.length) throw new NotTestedError("the app's program file could not be read as an iOS program");
    const device = slices.filter((s) => s.platform !== "ios-simulator" && !/^(x86_64|i386)$/.test(s.arch));
    if (!ctx.facts.simulator && !device.some((s) => s.arch.startsWith("arm64"))) {
      add(out, "ios:no-arm64", "high", "The app has no 64-bit code", "Every iOS version since iOS 11 runs only 64-bit apps, so this app does not open on any current iPhone or iPad. Build it again with a current Xcode (Standard Architectures).", exe, slices.map((s) => s.arch).join(", "), "functional");
    }
    const noPie = device.filter((s) => !s.pie).map((s) => s.arch);
    if (noPie.length) {
      add(out, "ios:no-pie", "medium", "The app is not built as position-independent code", "Without PIE, iOS cannot place the app at a random address, which makes memory attacks easier. Current Xcode builds PIE by default: remove -no_pie or old linker settings and build again.", exe, noPie.join(", "));
    }
    const signed = slices.some((s) => s.signed) || ctx.entries.some((e) => e.name === `${ctx.facts.appDir}_CodeSignature/CodeResources`);
    if (!signed && !ctx.facts.simulator) {
      add(out, "ios:unsigned", "medium", "The app is not signed", "No iPhone or iPad installs an unsigned app. Export it from Xcode's Organizer (Distribute App), which signs it, rather than zipping the build folder.", exe, undefined, "functional");
    }
    const hidden = codeHidden(ctx);
    const webview = filesWith(ctx, [cls("UIWebView")]);
    if (webview.length) {
      add(
        out,
        "ios:uiwebview",
        "high",
        "The app still uses UIWebView",
        "Apple stopped accepting new apps and updates that use UIWebView (ITMS-90809), and it has known security holes. Move to WKWebView, and update the SDKs listed in the evidence, which often bring it in.",
        webview[0],
        webview.map((f) => short(ctx, f)).slice(0, 6).join("\n"),
        "functional",
      );
    }
    if (hidden) throw new NotTestedError(`The program's headers were checked, but ${hidden}.`, out);
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */

const IP = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const COMMON_WORDS = new Set(["com", "app", "apps", "mobile", "ios", "iphone", "test", "demo", "company", "group", "india", "global", "online"]);

export const iosSecretsAgent: IosAgent = {
  ...base,
  id: "ios.secrets",
  name: "Hard-coded secrets and servers",
  description: "Searches the app's code and config files for API keys, private keys and database passwords, and for its own servers called over plain HTTP.",
  category: "security",
  run(ctx) {
    const { strings, facts } = ctx;
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
          `ios:secret-${p.id}`,
          google ? "info" : p.severity,
          `The app contains ${p.what}`,
          google
            ? "Google keys in apps can be read by anyone who unpacks the IPA. That is normal for Firebase and Maps, but restrict the key to your bundle ID in Google Cloud console (Application restrictions > iOS apps)."
            : `Anyone can unpack the IPA and read it, so treat it as leaked: revoke it and make a new one now. Keep the new one on your server; apps should get what they need from your server after the user signs in, never carry keys.`,
          s.file,
          p.id === "private-key" ? "-----BEGIN ... PRIVATE KEY-----" : `${value.slice(0, 4)}***${value.slice(-2)}`,
        );
        break;
      }
    }
    // The app's own servers over plain HTTP: IP addresses, or hosts named after the app.
    const tokens = facts.bundleId
      .split(".")
      .filter((t) => t.length >= 4 && !COMMON_WORDS.has(t.toLowerCase()))
      .map((t) => t.toLowerCase());
    const hosts = new Set<string>();
    for (const s of strings) {
      for (const m of s.text.matchAll(/http:\/\/([a-z0-9.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?\//gi)) {
        const host = m[1].toLowerCase();
        if (LOCAL.test(host) || /^(0|255)\./.test(host)) continue;
        if (IP.test(host) || tokens.some((t) => host.includes(t))) hosts.add(host);
      }
    }
    if (hosts.size) {
      const ats = atsPolicy(ctx.info);
      const list = [...hosts].slice(0, 6);
      const allowed = ats.all || list.some((h) => ats.insecure.some((d) => d === h || d.startsWith(`${h} `) || (d.includes("subdomains") && h.endsWith(`.${d.split(" ")[0]}`))));
      add(
        out,
        "ios:http-backend",
        allowed ? "medium" : "low",
        "The app calls its own servers over plain HTTP",
        allowed
          ? `The app has http:// addresses for ${list.join(", ")} and App Transport Security lets them through, so this data travels in the clear. Move the servers to HTTPS.`
          : `The app has http:// addresses for ${list.join(", ")}, but App Transport Security blocks plain HTTP, so these calls fail. Move the servers to HTTPS.`,
        strings[0]?.file ?? facts.executable,
        list.join(", "),
      );
    }
    ctx.note(`Searched ${strings.length} code and config files (${sizeText(strings.reduce((n, s) => n + s.text.length, 0))}) for keys and server addresses.`);
    const hidden = codeHidden(ctx);
    if (hidden) throw new NotTestedError(`Config files were searched, but ${hidden}.`, out);
    return out;
  },
};

export const iosFirebaseAgent: IosAgent = {
  ...base,
  id: "ios.firebase",
  name: "Firebase database",
  description: "Finds the app's Firebase Realtime Database and checks it does not let anyone read it.",
  category: "security",
  run({ strings, request }) {
    return openFirebaseFindings(strings, request, "ios:firebase-open", "unpacks the IPA");
  },
};

/* ---------------------------------------------------------------------------------------------- */

const DAY = 86_400_000;

export const iosSigningAgent: IosAgent = {
  ...base,
  id: "ios.signing",
  name: "Signing and provisioning",
  description: "Reads the embedded provisioning profile: debug builds, expiry, enterprise and Ad Hoc distribution, and the push notification server.",
  category: "security",
  run(ctx) {
    const out: Finding[] = [];
    const { profile } = ctx;
    const at = `${ctx.facts.appDir}embedded.mobileprovision`;
    if (!profile) {
      ctx.note("No provisioning profile inside the app (App Store downloads and Simulator builds have none), so signing was not checked.");
      return out;
    }
    const ent = dict(profile.Entitlements) ?? {};
    const debug = bool(ent["get-task-allow"]) === true;
    ctx.note(`Provisioning profile "${str(profile.Name) ?? "?"}" of ${str(profile.TeamName) ?? "an unknown team"}.`);
    if (debug) {
      add(
        out,
        "ios:debug-build",
        "high",
        "This is a debug build",
        "Its profile allows debugging (get-task-allow), so a debugger can attach to the app and read its memory, and it is built without release optimisations. Give clients and testers an Ad Hoc or TestFlight build: Product > Archive, then Distribute App > Ad Hoc or App Store Connect.",
        at,
        "Entitlements > get-task-allow = YES",
      );
    }
    const expires = profile.ExpirationDate instanceof Date ? profile.ExpirationDate : undefined;
    if (expires) {
      const left = expires.getTime() - Date.now();
      const day = expires.toISOString().slice(0, 10);
      if (left < 0) {
        add(out, "ios:profile-expired", "high", `The provisioning profile expired on ${day}`, "Devices refuse to open an app whose profile has expired. Renew the profile in the Apple Developer account (or let Xcode do it), then export and send the app again.", at, `ExpirationDate ${day}`, "functional");
      } else if (left < 30 * DAY) {
        add(out, "ios:profile-expiring", "medium", `The provisioning profile expires in ${Math.ceil(left / DAY)} days`, `On ${day} the app stops opening on every device it was given to. Renew the profile and send a new build before then.`, at, `ExpirationDate ${day}`, "functional");
      }
    }
    if (bool(profile.ProvisionsAllDevices)) {
      add(
        out,
        "ios:enterprise-build",
        "info",
        "This is an Enterprise (in-house) build",
        "Apple allows Enterprise distribution only for a company's own employees. Giving it to clients or the public breaks the Developer Enterprise agreement and can get the certificate revoked, which stops every copy from opening. Use TestFlight, Ad Hoc or the App Store instead.",
        at,
        "ProvisionsAllDevices = YES",
        "functional",
      );
    }
    const devices = arr(profile.ProvisionedDevices).length;
    if (devices) ctx.note(`The app runs only on the ${plural(devices, "device")} registered in its profile (Development or Ad Hoc).`);
    if (!debug && str(ent["aps-environment"]) === "development") {
      add(out, "ios:push-sandbox", "medium", "Push notifications go to Apple's test server", "The release build's aps-environment is development, so notifications from the live push server never arrive. Turn on Push Notifications for the App ID and use a distribution profile, which sets production.", at, "Entitlements > aps-environment = development", "functional");
    }
    return out;
  },
};

export const IOS_AGENTS: IosAgent[] = [iosSettingsAgent, iosPermissionsAgent, iosPrivacyManifestAgent, iosBinaryAgent, iosSecretsAgent, iosFirebaseAgent, iosSigningAgent];
