/*
 * More iOS checks: risky code and binary hardening, trackers and the tracking prompt, the app's
 * framework, its frameworks' versions, size, Universal Links, the servers it names, translations
 * and store readiness. Everything is read from the uploaded file; Universal Links and servers are
 * opened once (GET).
 */
import { arr, bool, dict, parsePlist, str, type PlistDict } from "../../engines/plist.js";
import { readEntry } from "../../engines/zip.js";
import { NotTestedError } from "../../runner/coverage.js";
import type { Finding } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { cls, filesWith, sel, sym } from "./ios.js";
import type { IosContext } from "./ios-context.js";
import { iosSdks, KIND_LABEL } from "./sdks.js";
import { addFinding as add, frameworkChecks, languageChecks, ownServers, serverChecks, sizeChecks } from "./shared.js";

type IosAgent = EngineAgent<IosContext>;
const base = { engine: "mobile" as const, products: ["ios" as const] };
const rel = (ctx: IosContext, name: string) => (name.startsWith(ctx.facts.appDir) ? name.slice(ctx.facts.appDir.length) : name);
const appFiles = (ctx: IosContext) => ctx.entries.filter((e) => e.name.startsWith(ctx.facts.appDir) && !e.name.endsWith("/")).map((e) => ({ name: rel(ctx, e.name), size: e.size }));

function reader(ctx: IosContext, max = 60_000_000) {
  const byName = new Map(ctx.entries.map((e) => [e.name, e]));
  return (name: string) => {
    const e = byName.get(ctx.facts.appDir + name);
    return e && e.size < max ? readEntry(ctx.ipa, e) : undefined;
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Risky code and hardening                                                                        */

export const iosCodeAgent: IosAgent = {
  ...base,
  id: "ios.code",
  name: "Risky code",
  description: "Searches the app's program for keychain items readable while the phone is locked, private certificate-bypass calls, web views that read local files, and missing stack protection.",
  category: "security",
  run(ctx) {
    const out: Finding[] = [];
    if (ctx.facts.encrypted || !ctx.programs.length) throw new NotTestedError(ctx.facts.encrypted ? "the app's code is encrypted (this is the copy the App Store hands out), so it could not be searched. Upload an IPA exported from Xcode (Development or Ad Hoc) for a full test" : "the app's program file is missing or too large to read");
    const exe = ctx.facts.executable;
    const own = ctx.programs.filter((p) => p.file === exe || p.file.includes("/App.framework/"));
    const ownWith = (signals: string[]) => own.filter((p) => signals.some((s) => p.text.includes(s))).map((p) => p.file);
    const always = ownWith([sym("kSecAttrAccessibleAlways"), sym("kSecAttrAccessibleAlwaysThisDeviceOnly")]);
    if (always.length) {
      add(out, "ios:keychain-always", "medium", "Keychain items can be read while the phone is locked", "The code saves keychain items with kSecAttrAccessibleAlways, which Apple deprecated: anyone with the phone (even locked) or a backup can get them. Use kSecAttrAccessibleWhenUnlockedThisDeviceOnly (or AfterFirstUnlockThisDeviceOnly for background work).", always[0], "kSecAttrAccessibleAlways");
    }
    const anyCert = filesWith(ctx, [sel("allowsAnyHTTPSCertificateForHost:"), sel("setAllowsAnyHTTPSCertificate:forHost:")]);
    if (anyCert.length) {
      add(out, "ios:any-certificate", "high", "The code accepts any HTTPS certificate", "allowsAnyHTTPSCertificateForHost: is a private Apple call that turns off certificate checks: anyone on the same Wi-Fi can read the traffic, and App Review rejects private API use. Remove it and fix the server's certificate.", anyCert[0], "allowsAnyHTTPSCertificateForHost:");
    }
    const fileAccess = own.filter((p) => /\0allow(File|Universal)AccessFromFileURLs\0/.test(p.text)).map((p) => p.file);
    if (fileAccess.length) {
      add(out, "ios:webview-file-access", "medium", "A web view lets local files read other files or websites", "The code sets allowFileAccessFromFileURLs / allowUniversalAccessFromFileURLs on a WKWebView, so a page opened from a file can read the app's files or any website. Remove it, and load local pages with loadFileURL(_:allowingReadAccessTo:) limited to their folder.", fileAccess[0], "allowFileAccessFromFileURLs");
    }
    const main = ctx.programs.find((p) => p.file === exe);
    if (main && !ctx.facts.simulator) {
      if (!main.text.includes(sym("__stack_chk_guard")) && !main.text.includes(sym("__stack_chk_fail"))) {
        add(out, "ios:no-stack-canary", "low", "The program is built without stack protection", "The main program does not use the stack canary (___stack_chk_guard), which stops many memory-corruption attacks. Build with -fstack-protector-all (Xcode's default; check Other C Flags are not overriding it).", exe, "___stack_chk_guard missing");
      }
      const objc = main.text.includes(cls("NSObject")) || main.text.includes(sym("objc_msgSend"));
      if (objc && !main.text.includes(sym("objc_release")) && !main.text.includes(sym("swift_release"))) {
        add(out, "ios:no-arc", "low", "The program is built without Automatic Reference Counting", "Without ARC, memory is freed by hand, which leads to crashes and use-after-free holes. Turn on Objective-C Automatic Reference Counting in Build Settings.", exe, "_objc_release missing");
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Trackers and SDKs                                                                               */

export const iosSdksAgent: IosAgent = {
  ...base,
  id: "ios.sdks",
  name: "Trackers and SDKs",
  description: "Lists the SDKs inside the app (ads, install tracking, analytics, payments...) and checks the App Tracking Transparency prompt and privacy manifest cover them.",
  category: "security",
  run(ctx) {
    const out: Finding[] = [];
    const sdks = iosSdks(
      ctx.frameworks.map((f) => f.name),
      ctx.programs.map((p) => p.text),
    );
    ctx.summary.sdks = sdks.map((s) => ({ id: s.id, name: s.name, kind: s.kind, tracker: s.tracker }));
    if (sdks.length) ctx.note(`SDKs: ${sdks.map((s) => `${s.name} (${KIND_LABEL[s.kind]})`).join(", ")}.`);
    const trackers = sdks.filter((s) => s.tracker);
    const where = `${ctx.facts.appDir}Info.plist`;
    if (trackers.length) {
      add(out, "ios:trackers", "info", `The app has ${trackers.length} tracking SDK${trackers.length === 1 ? "" : "s"}`, `${trackers.map((t) => t.name).join(", ")} collect data about users. App Store Connect's App Privacy answers must list what they collect, and India's DPDP Act and Europe's GDPR need consent before they start.`, where, trackers.map((t) => `${t.name} (${KIND_LABEL[t.kind]})`).join("\n"));
    }
    const adLike = sdks.filter((s) => s.kind === "ads" || s.kind === "attribution");
    if (adLike.length && !str(ctx.info.NSUserTrackingUsageDescription)) {
      add(
        out,
        "ios:att-missing",
        "medium",
        "The app has ad or install-tracking SDKs but never asks to track",
        `${adLike.map((s) => s.name).join(", ")} use the advertising ID (IDFA), which iOS only gives after the App Tracking Transparency prompt. Without NSUserTrackingUsageDescription the prompt cannot show: the SDKs get zeros, and App Review rejects apps that track without asking. Add the purpose text and call ATTrackingManager.requestTrackingAuthorization.`,
        where,
        "NSUserTrackingUsageDescription missing",
        "functional",
      );
    }
    if (trackers.length && ctx.privacy && bool(ctx.privacy.NSPrivacyTracking) === false && adLike.length) {
      add(out, "ios:privacy-says-no-tracking", "medium", "The privacy manifest says the app does not track, but it has tracking SDKs", `PrivacyInfo.xcprivacy sets NSPrivacyTracking to NO while ${adLike.map((s) => s.name).join(", ")} track for ads or attribution. The App Store privacy label is then wrong. Set NSPrivacyTracking to YES and list the domains.`, `${ctx.facts.appDir}PrivacyInfo.xcprivacy`, "NSPrivacyTracking = NO");
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Framework, libraries, size                                                                      */

export const iosFrameworkAgent: IosAgent = {
  ...base,
  id: "ios.framework",
  name: "App framework",
  description: "Finds what the app is built with (Flutter, React Native, Cordova, Capacitor, Ionic, .NET MAUI, Unity, Swift or Objective-C) and checks that framework's release mistakes.",
  category: "security",
  run(ctx) {
    const swift = ctx.programs.some((p) => p.text.includes("libswiftCore") || p.text.includes(sym("swift_release"))) || ctx.binary?.slices.some((s) => s.dylibs.some((d) => d.includes("libswift"))) === true;
    const { framework, findings } = frameworkChecks("ios", appFiles(ctx), reader(ctx), (n) => ctx.facts.appDir + n, { swift });
    ctx.summary.framework = framework;
    ctx.note(`Built with ${framework}.`);
    return findings;
  },
};

export const iosLibrariesAgent: IosAgent = {
  ...base,
  id: "ios.libraries",
  name: "Libraries",
  description: "Lists the frameworks inside the app with their versions (from each framework's Info.plist), as a CycloneDX file.",
  category: "security",
  run(ctx) {
    const read = reader(ctx, 2_000_000);
    const libs: { name: string; version: string; purl?: string }[] = [];
    for (const fw of ctx.frameworks) {
      const buf = read(`${fw.dir.slice(ctx.facts.appDir.length)}Info.plist`);
      let version = "unknown";
      if (buf) {
        try {
          const p = parsePlist(buf) as PlistDict;
          version = str(p.CFBundleShortVersionString) ?? str(p.CFBundleVersion) ?? "unknown";
        } catch {
          /* unreadable */
        }
      }
      libs.push({ name: fw.name, version });
    }
    ctx.summary.libraries = libs;
    if (libs.length) ctx.note(`${libs.length} frameworks listed with their versions (download the list: app-sbom.cdx.json).`);
    return [];
  },
};

export const iosSizeAgent: IosAgent = {
  ...base,
  id: "ios.size",
  name: "App size",
  description: "Checks the download size, pictures over 1 MB and files packed twice.",
  category: "performance",
  run(ctx) {
    const { findings, biggest } = sizeChecks("ios", ctx.ipa.length, appFiles(ctx), reader(ctx, 50_000_000), (n) => ctx.facts.appDir + n);
    ctx.summary.biggest = biggest;
    return findings;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Universal Links                                                                                 */

/** What is wrong with a site's apple-app-site-association file for this app, or null when it covers it. */
export function aasaProblem(json: unknown, appId: string, bundleId: string): string | null {
  const details = arrOf((json as { applinks?: { details?: unknown } })?.applinks?.details);
  if (!details) return "it has no applinks section";
  const ids = details.flatMap((d) => {
    const x = d as { appID?: string; appIDs?: string[] };
    return [...(x.appIDs ?? []), ...(x.appID ? [x.appID] : [])];
  });
  if (ids.includes(appId)) return null;
  if (ids.some((i) => i.endsWith(`.${bundleId}`))) return `it lists ${ids.find((i) => i.endsWith(`.${bundleId}`))}, but this app is signed by team ${appId.split(".")[0]}`;
  return `it does not list ${appId}`;
}
const arrOf = (v: unknown) => (Array.isArray(v) ? v : null);

export const iosLinksAgent: IosAgent = {
  ...base,
  id: "ios.links",
  name: "Universal Links",
  description: "Checks each applinks: domain in the app's entitlements serves an apple-app-site-association file that names this app.",
  category: "functional",
  async run(ctx) {
    const out: Finding[] = [];
    const ent = ctx.entitlements ?? dict(ctx.profile?.Entitlements);
    const domains = arr(ent?.["com.apple.developer.associated-domains"])
      .filter((d): d is string => typeof d === "string" && d.startsWith("applinks:"))
      .map((d) => d.slice(9).replace(/\?mode=.*$/, ""))
      .filter((d) => d && d !== "*");
    ctx.summary.links = domains;
    if (!domains.length) return out;
    const appIdent = str(ent?.["application-identifier"]);
    const team = str(ent?.["com.apple.developer.team-identifier"]) ?? appIdent?.split(".")[0] ?? str(arr(ctx.profile?.TeamIdentifier)[0]);
    const appId = `${team ?? "TEAMID"}.${ctx.facts.bundleId}`;
    const bad: string[] = [];
    for (const d of domains.slice(0, 8)) {
      const host = d.replace(/^\*\./, "");
      if (/\.(invalid|test|example|localhost|local)$/.test(host)) {
        bad.push(`${d}: not a real web address`);
        continue;
      }
      try {
        const res = await ctx.request.get(`https://${host}/.well-known/apple-app-site-association`, { timeout: 10_000, maxRedirects: 0, failOnStatusCode: false });
        if (res.status() !== 200) {
          bad.push(`${d}: the file answers ${res.status()}${res.status() >= 300 && res.status() < 400 ? " (a redirect, which iOS does not follow)" : ""}`);
          continue;
        }
        let json: unknown;
        try {
          json = JSON.parse(await res.text());
        } catch {
          bad.push(`${d}: the file is not valid JSON`);
          continue;
        }
        const problem = aasaProblem(json, appId, ctx.facts.bundleId);
        if (problem) bad.push(`${d}: ${problem}`);
      } catch (err) {
        bad.push(`${d}: could not be opened (${(err as Error).message.split("\n")[0].slice(0, 80)})`);
      }
    }
    if (bad.length) {
      add(
        out,
        "ios:universal-links-broken",
        "medium",
        "Universal Links do not open the app",
        `The app claims ${domains.slice(0, 4).join(", ")}, but the check fails, so links in WhatsApp, Mail or Safari open the website instead of the app. Serve https://<domain>/.well-known/apple-app-site-association (JSON, no redirect) with "${appId}" under applinks.`,
        `${ctx.facts.appDir}${ctx.entitlements ? ctx.facts.executable.slice(ctx.facts.appDir.length) : "embedded.mobileprovision"}`,
        bad.join("\n"),
      );
    }
    return out;
  },
};

/* ---------------------------------------------------------------------------------------------- */
/* Servers, languages, store readiness                                                             */

export const iosServersAgent: IosAgent = {
  ...base,
  id: "ios.servers",
  name: "App servers",
  description: "Lists the app's own servers named in its code and config, and checks for test or staging servers, private network addresses and broken HTTPS certificates.",
  category: "functional",
  async run(ctx) {
    const servers = ownServers(
      ctx.facts.bundleId,
      ctx.strings.map((s) => ({ ...s, config: !ctx.programs.some((p) => p.file === s.file) })),
    );
    ctx.summary.servers = servers;
    if (servers.length) ctx.note(`Servers named in the app: ${servers.slice(0, 10).join(", ")}${servers.length > 10 ? "…" : ""}. Test them with an API project.`);
    const debug = Boolean(ctx.profile && bool(dict(ctx.profile.Entitlements)?.["get-task-allow"]));
    return serverChecks("ios", servers, ctx.request, ctx.facts.executable, debug);
  },
};

/** How many texts a .strings file has (text "key" = "value"; lines, or a binary plist). */
export function stringsCount(buf: Buffer): number {
  if (buf.subarray(0, 6).toString("latin1") === "bplist") {
    try {
      const v = parsePlist(buf);
      return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : 0;
    } catch {
      return 0;
    }
  }
  const text = buf[0] === 0xff || buf[0] === 0xfe ? buf.toString("utf16le") : buf.toString("utf8");
  return (text.match(/^\s*"(?:[^"\\]|\\.)*"\s*=\s*"(?:[^"\\]|\\.)*"\s*;/gm) ?? []).length;
}

export const iosLanguagesAgent: IosAgent = {
  ...base,
  id: "ios.languages",
  name: "Languages",
  description: "Lists the languages the app is translated into (.lproj folders) and finds languages with texts missing.",
  category: "functional",
  run(ctx) {
    const counts = new Map<string, number>();
    const read = reader(ctx, 5_000_000);
    const lproj = new Set<string>();
    for (const f of appFiles(ctx)) {
      const m = f.name.match(/^([^/]+)\.lproj\/(.+)$/);
      if (!m) continue;
      lproj.add(m[1]);
      if (m[2] === "Localizable.strings") {
        const buf = read(f.name);
        if (buf) counts.set(m[1], stringsCount(buf));
      }
    }
    const dev = str(ctx.info.CFBundleDevelopmentRegion) ?? "en";
    const baseKey = counts.has(dev) ? dev : counts.has("Base") ? "Base" : counts.has("en") ? "en" : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    const base = baseKey ? (counts.get(baseKey) ?? 0) : 0;
    if (baseKey) counts.delete(baseKey);
    counts.delete("Base");
    const { findings } = languageChecks(counts, base, `${ctx.facts.appDir}${baseKey ?? dev}.lproj/Localizable.strings`);
    ctx.summary.languages = [...lproj].filter((l) => l !== "Base").sort();
    if (ctx.summary.languages.length > 1) ctx.note(`Translated into: ${ctx.summary.languages.join(", ")}.`);
    return findings;
  },
};

export const iosStoreAgent: IosAgent = {
  ...base,
  id: "ios.store",
  name: "Store readiness",
  description: "Checks what App Store Connect refuses at upload: no app icon, no launch screen, no build number, and old device requirements.",
  category: "functional",
  run(ctx) {
    const out: Finding[] = [];
    const { info } = ctx;
    const where = `${ctx.facts.appDir}Info.plist`;
    // A Simulator build never goes to the App Store.
    if (ctx.facts.simulator) return out;
    const icons = dict(info.CFBundleIcons) ?? dict(info["CFBundleIcons~ipad"]);
    const hasIcon = Boolean(str(info.CFBundleIconName) || icons || arr(info.CFBundleIconFiles).length || ctx.entries.some((e) => e.name.startsWith(ctx.facts.appDir) && /AppIcon[^/]*\.png$/.test(e.name)));
    if (!hasIcon) add(out, "ios:no-icon", "high", "The app has no icon", "Info.plist names no app icon (CFBundleIconName or CFBundleIcons), so App Store Connect refuses the upload (ITMS-90022 / 90713). Add an AppIcon set to the asset catalog with the 1024 × 1024 picture.", where, "CFBundleIconName missing", "functional");
    if (!str(info.UILaunchStoryboardName) && !dict(info.UILaunchScreen) && !ctx.facts.simulator) {
      add(out, "ios:no-launch-screen", "high", "The app has no launch screen", "Since April 2020 the App Store requires a launch storyboard (UILaunchStoryboardName) or a UILaunchScreen entry; without one the app also shows black bars on newer iPhones. Add a LaunchScreen.storyboard.", where, "UILaunchStoryboardName missing", "functional");
    }
    if (!str(info.CFBundleVersion)) add(out, "ios:no-build-number", "high", "The app has no build number", "CFBundleVersion is missing, and App Store Connect needs a new build number for every upload.", where, "CFBundleVersion missing", "functional");
    const caps = arr(info.UIRequiredDeviceCapabilities).filter((c): c is string => typeof c === "string");
    if (caps.includes("armv7")) add(out, "ios:armv7-required", "low", "The app still asks for 32-bit (armv7) devices", "UIRequiredDeviceCapabilities lists armv7, which current Xcode cannot build. Replace it with arm64.", where, "armv7", "functional");
    return out;
  },
};

export const IOS_EXTRA_AGENTS: IosAgent[] = [iosCodeAgent, iosSdksAgent, iosFrameworkAgent, iosLibrariesAgent, iosSizeAgent, iosLinksAgent, iosServersAgent, iosLanguagesAgent, iosStoreAgent];
