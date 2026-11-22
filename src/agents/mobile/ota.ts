import { finding } from "../../runner/finding.js";
import type { Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import type { ApkContext } from "./context.js";
import type { IosContext } from "./ios-context.js";

/**
 * Over-the-air (OTA) update safety for React Native and Expo apps: CodePush and EAS Update let an app
 * download new JavaScript after install, skipping the store review. That is useful, but if the update
 * is not signed (CodePush code signing, Expo's expo-updates code signing) anyone who can serve the
 * update URL can push code to every user. This reads the app's own files and flags OTA that is set up
 * without signing, and OTA that points at an http:// endpoint.
 */

export interface OtaFacts {
  codePush: boolean;
  codePushSigned: boolean;
  expoUpdates: boolean;
  expoSigned: boolean;
  httpEndpoint: boolean;
}

/** OTA problems from what the app's files show. Pure, for tests. */
export function otaProblems(f: OtaFacts): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (f.codePush && !f.codePushSigned)
    out.push({
      rule: "mobile:codepush-unsigned",
      severity: "high",
      title: "CodePush updates are not code-signed",
      detail: "The app uses CodePush (App Center) to download JavaScript updates but no public key for code signing was found. Whoever controls the update server (or a man in the middle) can push code to every user, bypassing store review. Turn on CodePush code signing and ship the public key in the app.",
    });
  if (f.expoUpdates && !f.expoSigned)
    out.push({
      rule: "mobile:expo-updates-unsigned",
      severity: "high",
      title: "Expo OTA updates are not code-signed",
      detail: "The app uses expo-updates (EAS Update) but no code-signing certificate was found. Without signing, anyone able to answer the update URL can push JavaScript to users. Set up expo-updates code signing (expo-updates configure-code-signing) and pin the channel.",
    });
  if (f.httpEndpoint)
    out.push({
      rule: "mobile:ota-http",
      severity: "high",
      title: "An OTA update endpoint uses http://",
      detail: "An over-the-air update URL is plain http://, so the update can be read and replaced on any shared network. Serve updates only over https:// and add code signing.",
    });
  return out;
}

function readOta(allText: string, fileNames: string[]): OtaFacts {
  const names = fileNames.join("\n");
  const codePush = /codepush|code-push|CodePushConfig|react-native-code-push/i.test(allText) || /codepush/i.test(names);
  const expoUpdates = /expo-updates|EXUpdates|expo\.modules\.updates|EXPO_UPDATE_URL|eas\.json|expo-updates/i.test(allText) || /expo-updates|EXUpdates/i.test(names);
  return {
    codePush,
    codePushSigned: codePush && /CodePushPublicKey|publicKey|codepush.*publickey|contentHash.*signature/i.test(allText),
    expoUpdates,
    expoSigned: expoUpdates && /codeSigningCertificate|code-signing|expo-signature|EXUpdatesCodeSigning/i.test(allText),
    httpEndpoint: /["'`]http:\/\/[^"'`]*(codepush|appcenter|update|expo|u\.expo\.dev|ota)[^"'`]*/i.test(allText),
  };
}

const describe = { name: "OTA update safety", description: "For React Native (CodePush) and Expo (EAS Update) apps: flags over-the-air JavaScript updates set up without code signing, or pointing at an http endpoint, which would let someone push code to every user without store review.", category: "security" as const };

export const androidOtaAgent: EngineAgent<ApkContext> = {
  id: "android.ota",
  engine: "mobile",
  products: ["android"],
  ...describe,
  run(ctx: ApkContext): Finding[] {
    const text = ctx.strings.map((s) => s.text).join("\n");
    const facts = readOta(text, ctx.entries.map((e) => e.name));
    if (!facts.codePush && !facts.expoUpdates) return [];
    ctx.note(`OTA: ${facts.codePush ? "CodePush" : ""}${facts.expoUpdates ? " Expo" : ""}`.trim());
    return otaProblems(facts).map((p) => finding({ category: "security", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: ctx.facts.packageName || "app" }));
  },
};

export const iosOtaAgent: EngineAgent<IosContext> = {
  id: "ios.ota",
  engine: "mobile",
  products: ["ios"],
  ...describe,
  run(ctx: IosContext): Finding[] {
    const text = [...ctx.strings, ...ctx.programs].map((s) => s.text).join("\n");
    const facts = readOta(text, ctx.entries.map((e) => e.name));
    if (!facts.codePush && !facts.expoUpdates) return [];
    ctx.note(`OTA: ${facts.codePush ? "CodePush" : ""}${facts.expoUpdates ? " Expo" : ""}`.trim());
    return otaProblems(facts).map((p) => finding({ category: "security", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: ctx.facts.bundleId || "app" }));
  },
};
