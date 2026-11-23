import { adb, pickAndroid } from "./android-device.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Screen-reader labels on a real Android phone (what TalkBack would announce): it dumps the live UI
 * tree (uiautomator) of the app's screens and checks that every control a blind user can focus has a
 * spoken label — a text or content-description. Controls with none are read out as "button" or
 * "unlabeled", so the screen cannot be used with TalkBack. VoiceOver (iOS) is run by the Mac helper.
 */

export interface Node {
  cls: string;
  clickable: boolean;
  focusable: boolean;
  hasLabel: boolean;
  resourceId: string;
}

/** Parses a uiautomator XML dump into nodes. Pure, for tests. */
export function parseUiDump(xml: string): Node[] {
  const out: Node[] = [];
  for (const m of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const get = (a: string) => attrs.match(new RegExp(`${a}="([^"]*)"`))?.[1] ?? "";
    out.push({
      cls: get("class"),
      clickable: get("clickable") === "true",
      focusable: get("focusable") === "true",
      hasLabel: Boolean(get("text").trim()) || Boolean(get("content-desc").trim()),
      resourceId: get("resource-id"),
    });
  }
  return out;
}

/** Actionable controls with no spoken label. Pure, for tests. */
export function unlabelledControls(nodes: Node[]): Node[] {
  const actionable = (n: Node) => n.clickable || /Button|ImageButton|CheckBox|Switch|EditText|ImageView|RadioButton/.test(n.cls);
  return nodes.filter((n) => actionable(n) && !n.hasLabel && !/Layout|ViewGroup|RecyclerView/.test(n.cls));
}

export const talkbackTool: Tool = {
  id: "talkback",
  name: "Screen-reader labels (TalkBack)",
  maker: "GLV Infotech (built in), Android uiautomator",
  description:
    "On a connected Android phone, reads the live screen tree of the app and checks every control a blind user can focus has a spoken label (text or content-description). Controls with none are announced only as 'button' with TalkBack, so the screen cannot be used by blind users. iOS VoiceOver runs on the Mac helper.",
  checks: ["Controls (buttons, inputs, icons) with no spoken label", "Across the screens the app opens", "What TalkBack would actually announce, from the live UI tree"],
  products: ["android"],
  category: "accessibility",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://support.google.com/accessibility/android/answer/6283677",
  signedIn: "public",
  needsDevice: true,
  ownCategory: true,
  manual: true,
  options: [{ id: "device", label: "Test phone", kind: "text", placeholder: "auto", choices: [], default: "auto" }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const pkg = ctx.app?.id;
    if (!pkg) throw new Error("No app package is known. Run the mobile test (which reads the app) first.");
    if (ctx.app?.platform === "ios") throw new Error("iOS VoiceOver is run by the Mac helper, not this tool.");
    const device = await pickAndroid(ctx.options.device || "auto", ctx.signal);
    const serial = device.udid;
    ctx.log(`TalkBack labels on ${device.name}: ${pkg}`);
    const resolve = await adb(serial, ["shell", "cmd", "package", "resolve-activity", "--brief", pkg]);
    const activity = resolve.trim().split(/\s+/).find((l) => l.includes("/"));
    if (activity) await adb(serial, ["shell", "am", "start", "-n", activity]);
    await new Promise((r) => setTimeout(r, 3000));
    // Dump a few screens; between dumps, scroll to bring more controls into the tree.
    const allNodes: Node[] = [];
    for (let i = 0; i < 3; i++) {
      ctx.signal.throwIfAborted();
      await adb(serial, ["shell", "uiautomator", "dump", "/sdcard/glv-ui.xml"]);
      const xml = await adb(serial, ["shell", "cat", "/sdcard/glv-ui.xml"]);
      allNodes.push(...parseUiDump(xml));
      await adb(serial, ["shell", "input", "swipe", "500", "1500", "500", "500"]);
      await new Promise((r) => setTimeout(r, 1200));
    }
    // De-duplicate by resource id + class.
    const seen = new Set<string>();
    const nodes = allNodes.filter((n) => (seen.has(`${n.resourceId}|${n.cls}|${n.hasLabel}`) ? false : seen.add(`${n.resourceId}|${n.cls}|${n.hasLabel}`)));
    const unlabelled = unlabelledControls(nodes);
    const findings: ToolFinding[] = [];
    if (unlabelled.length)
      findings.push({
        category: "accessibility",
        rule: "a11y:app-unlabelled-controls",
        severity: "high",
        title: `${unlabelled.length} control${unlabelled.length === 1 ? "" : "s"} have no label for TalkBack`,
        detail: "These buttons, icons and inputs have no text or content-description, so TalkBack announces them only as 'button' or by nothing at all, and a blind user cannot tell what they do. Add android:contentDescription (or a label/hint for inputs); for decorative images set it to null.",
        pageUrl: pkg,
        evidence: unlabelled.slice(0, 15).map((n) => `${n.cls.split(".").pop()}${n.resourceId ? ` (${n.resourceId.split("/").pop()})` : ""}`).join("\n"),
        key: "a11y:app-unlabelled-controls",
      });
    return {
      findings,
      summary: [`${nodes.length} controls seen, ${unlabelled.length} with no spoken label for TalkBack`],
      tested: `${pkg} on ${device.name}`,
    };
  },
};
