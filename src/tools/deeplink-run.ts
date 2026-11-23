import { adb, pickAndroid } from "./android-device.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Deep-link and App-Link runner on a real Android phone: it opens every link the app says it handles
 * (its App Links, plus any the tester adds) with an intent, and checks each one actually lands in the
 * app and not in the browser or a chooser. A link that opens a chooser means another app can claim it
 * (hijack), so a login or payment link could be stolen. Started by hand on a connected phone.
 */

/** The package now in the foreground, from `dumpsys activity activities`. Pure, for tests. */
export function focusedPackage(dumpsys: string): string | null {
  const m = dumpsys.match(/(?:mResumedActivity|mFocusedActivity|topResumedActivity|ResumedActivity)[^\n]*\{[^}]*\s([a-zA-Z0-9_.]+)\/[^}\s]+/) || dumpsys.match(/mCurrentFocus=[^\n]*\s([a-zA-Z0-9_.]+)\/[^}\s]+/);
  return m ? m[1] : null;
}

/** Classifies how a link opened. Pure, for tests. */
export function linkResult(landedPkg: string | null, appPkg: string): "app" | "chooser" | "browser" | "nothing" {
  if (!landedPkg) return "nothing";
  if (landedPkg === appPkg) return "app";
  if (/resolver|ResolverActivity|ChooserActivity/.test(landedPkg)) return "chooser";
  if (/chrome|browser|webview|android\.|google\.android/.test(landedPkg)) return "browser";
  return "browser";
}

export const deeplinkRunTool: Tool = {
  id: "deeplink-run",
  name: "Deep-link runner",
  maker: "GLV Infotech (built in)",
  description:
    "On a connected Android phone, opens every link the app handles (its App Links, plus any you add) and checks each lands in the app, not the browser or a chooser. A link that shows a chooser can be claimed by another app, so a login or payment deep link could be hijacked.",
  checks: ["Each App Link opens inside the app", "Links that open a chooser (another app can claim them — hijack risk)", "Links that fall through to the browser (App Links not verified)"],
  products: ["android"],
  category: "security",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://developer.android.com/training/app-links",
  signedIn: "public",
  needsDevice: true,
  manual: true,
  options: [
    { id: "device", label: "Test phone", kind: "text", placeholder: "auto", choices: [], default: "auto" },
    { id: "links", label: "Extra links to test", kind: "text", multiline: true, maxLength: 2000, placeholder: "myapp://pay?order=1\nhttps://app.example.com/reset", hint: "One per line. The app's own App Links are included automatically.", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const pkg = ctx.app?.id;
    if (!pkg) throw new Error("No app package is known. Run the mobile test (which reads the app) first.");
    if (ctx.app?.platform === "ios") throw new Error("iOS Universal Links are checked statically by the iOS link agent; this runner is Android-only.");
    const device = await pickAndroid(ctx.options.device || "auto", ctx.signal);
    const serial = device.udid;
    const extra = (ctx.options.links ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const links = [...new Set([...(ctx.app?.links ?? []), ...extra])].slice(0, 25);
    if (!links.length) throw new Error("The app declares no App Links and none were added. Add some links to test.");
    ctx.log(`Deep links on ${device.name}: ${links.length}`);
    const rows: string[][] = [];
    const findings: ToolFinding[] = [];
    for (const link of links) {
      ctx.signal.throwIfAborted();
      await adb(serial, ["shell", "am", "force-stop", pkg]);
      const out = await adb(serial, ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", link.replace(/[;&|`$]/g, "")]);
      await new Promise((r) => setTimeout(r, 1500));
      const focus = focusedPackage(await adb(serial, ["shell", "dumpsys", "activity", "activities"]));
      const result = /Error|Exception|unable to resolve/i.test(out) ? "nothing" : linkResult(focus, pkg);
      rows.push([link.slice(0, 50), result, focus ?? "—"]);
      if ((result === "chooser" || result === "browser") && /^https?:\/\//i.test(link))
        findings.push({ category: "security", rule: "deeplink:not-verified", severity: result === "chooser" ? "medium" : "low", title: `A link opens in ${result === "chooser" ? "a chooser" : "the browser"}, not the app`, detail: result === "chooser" ? "The link shows an app chooser, which means another app can register for the same link and intercept it — a real risk for login and payment links. Verify your App Links (autoVerify + a matching /.well-known/assetlinks.json) so Android opens them straight in your app." : "The link falls through to the browser instead of the app. If it should open the app, verify the App Link (assetlinks.json) and the intent filter host.", pageUrl: link, evidence: `landed in: ${focus ?? "nothing"}`, key: `deeplink:${link}` });
      else if (result === "nothing")
        findings.push({ category: "functional", rule: "deeplink:dead", severity: "low", title: "A deep link opened nothing", detail: `The app did not handle ${link}. Confirm the scheme/host is registered in an intent filter and that the target screen exists.`, pageUrl: link, evidence: out.split("\n").slice(0, 3).join(" ").slice(0, 200), key: `deeplink:dead:${link}` });
    }
    return {
      findings,
      summary: [`${links.length} links: ${rows.filter((r) => r[1] === "app").length} opened in the app, ${rows.filter((r) => r[1] === "chooser").length} showed a chooser, ${rows.filter((r) => r[1] === "browser").length} went to the browser`],
      tested: `${links.length} links on ${device.name}`,
      table: { title: "Deep links", columns: ["Link", "Opened in", "Package"], rows },
    };
  },
};
