/*
 * Reads what Appium says is on the screen (UiAutomator2's or XCUITest's element tree) into one
 * shape, and checks it the way Google's Accessibility Scanner and Xcode's audit do: labels for
 * buttons and fields, tap sizes, text contrast on the real pixels, text cut off at the edge, and
 * texts drawn over each other.
 */
import { createHash } from "node:crypto";
import { parseXml, type XmlNode } from "../engines/xml.js";
import { boxContrast, type Image } from "./png.js";

export interface UiElement {
  /** Android class (android.widget.Button) or iOS type (XCUIElementTypeButton), shortened: Button. */
  kind: string;
  id: string;
  text: string;
  /** content-desc on Android, label on iOS. */
  desc: string;
  hint: string;
  clickable: boolean;
  editable: boolean;
  password: boolean;
  enabled: boolean;
  scrollable: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Text or label of the element or anything inside it (what a screen reader says). */
  spoken: string;
  depth: number;
}

export interface UiScreen {
  platform: "android" | "ios";
  /** The app the screen belongs to (Android package), when the tree says. */
  pkg?: string;
  elements: UiElement[];
  /** Same buttons and fields = same screen, whatever the changing texts say. */
  signature: string;
  /** A short name for the report: the top-most title-like text. */
  name: string;
}

const IOS_TAP = /^(Button|Cell|Link|Switch|Tab|SegmentedControl|Slider|Stepper|Key|MenuItem|PageIndicator|Toggle|Image)$/;
const IOS_EDIT = /^(TextField|SecureTextField|SearchField|TextView)$/;
const ANDROID_EDIT = /(EditText|AutoCompleteTextView|TextInputEditText)$/;

const bool = (v?: string) => v === "true";

function androidEl(n: XmlNode, depth: number): UiElement | null {
  const m = (n.attrs.bounds ?? "").match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
  if (!m) return null;
  const [x1, y1, x2, y2] = m.slice(1).map(Number);
  const cls = n.attrs.class ?? n.name;
  return {
    kind: cls.split(".").pop() ?? cls,
    id: (n.attrs["resource-id"] ?? "").replace(/^.*:id\//, ""),
    text: n.attrs.text ?? "",
    desc: n.attrs["content-desc"] ?? "",
    hint: n.attrs.hint ?? "",
    clickable: bool(n.attrs.clickable) || bool(n.attrs["long-clickable"]) || bool(n.attrs.checkable),
    editable: ANDROID_EDIT.test(cls),
    password: bool(n.attrs.password),
    enabled: n.attrs.enabled !== "false",
    scrollable: bool(n.attrs.scrollable),
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1,
    spoken: "",
    depth,
  };
}

function iosEl(n: XmlNode, depth: number): UiElement | null {
  if (!n.name.startsWith("XCUIElementType")) return null;
  if (n.attrs.visible === "false") return null;
  const kind = n.name.replace(/^XCUIElementType/, "");
  const label = n.attrs.label ?? "";
  return {
    kind,
    id: n.attrs.name && n.attrs.name !== label ? n.attrs.name : "",
    text: kind === "StaticText" || IOS_EDIT.test(kind) ? (n.attrs.value ?? label) : "",
    desc: label,
    hint: n.attrs.placeholderValue ?? "",
    clickable: IOS_TAP.test(kind) && (kind !== "Image" || n.attrs.accessible === "true"),
    editable: IOS_EDIT.test(kind),
    password: kind === "SecureTextField",
    enabled: n.attrs.enabled !== "false",
    scrollable: kind === "ScrollView" || kind === "Table" || kind === "CollectionView",
    x: Number(n.attrs.x ?? 0),
    y: Number(n.attrs.y ?? 0),
    width: Number(n.attrs.width ?? 0),
    height: Number(n.attrs.height ?? 0),
    spoken: "",
    depth,
  };
}

/** Reads Appium's page source. */
export function parseScreen(xml: string, platform: "android" | "ios"): UiScreen {
  const root = parseXml(xml);
  const elements: UiElement[] = [];
  let pkg: string | undefined;
  const walk = (n: XmlNode, depth: number): string[] => {
    const el = platform === "android" ? androidEl(n, depth) : iosEl(n, depth);
    if (platform === "android" && n.attrs.package && !pkg) pkg = n.attrs.package;
    const inner: string[] = [];
    const at = elements.length;
    if (el) elements.push(el);
    for (const c of n.children) inner.push(...walk(c, depth + 1));
    const own = el ? [el.desc, el.text].filter(Boolean) : [];
    if (el) elements[at].spoken = [...own, ...(own.length ? [] : inner)].join(" ").trim();
    return own.length ? own : inner;
  };
  walk(root, 0);
  const visible = elements.filter((e) => e.width > 0 && e.height > 0);
  const sigParts = visible
    .filter((e) => e.clickable || e.editable)
    .map((e) => `${e.kind}|${e.id}|${e.editable ? "" : (e.desc || e.text).slice(0, 40)}`)
    .sort();
  const signature = createHash("sha1").update(sigParts.join("\n") || visible.map((e) => e.kind).join(",")).digest("hex").slice(0, 12);
  const titles = visible.filter((e) => (e.text || (platform === "ios" && e.kind === "NavigationBar" && e.desc)) && !e.clickable && !e.editable).sort((a, b) => a.y - b.y || a.x - b.x);
  const name = (titles[0]?.text || titles[0]?.desc || visible.find((e) => e.clickable && e.spoken)?.spoken || "").replace(/\s+/g, " ").slice(0, 50);
  return { platform, pkg, elements: visible, signature, name };
}

/** Buttons the explorer may tap: enabled, on screen, and not ones that spend money, delete or sign out. */
export const RISKY = /\b(delete|remove|erase|clear (all|data|history)|deactivate|close account|pay|payment|buy|purchase|order now|place order|checkout|check out|subscribe|donate|transfer|send money|send|submit|confirm|book now|call|dial|uninstall|log ?out|sign ?out|reset)\b/i;

export function tapTargets(s: UiScreen, win: { width: number; height: number }): UiElement[] {
  const seen = new Set<string>();
  return s.elements
    .filter((e) => e.clickable && e.enabled && !e.editable && e.width >= 4 && e.height >= 4)
    .filter((e) => e.x + e.width / 2 > 0 && e.x + e.width / 2 < win.width && e.y + e.height / 2 > 0 && e.y + e.height / 2 < win.height)
    .filter((e) => !RISKY.test(`${e.spoken} ${e.id.replace(/_/g, " ")}`))
    .filter((e) => {
      const key = `${e.kind}|${e.id}|${e.spoken}|${Math.round(e.x / 8)}|${Math.round(e.y / 8)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Top to bottom, left to right, so every run taps in the same order.
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

/** How to find the element again after the app restarts. */
export function describe(e: UiElement): string {
  if (e.id) return `id:${e.id}${e.spoken ? ` "${e.spoken.slice(0, 30)}"` : ""}`;
  if (e.spoken) return `"${e.spoken.slice(0, 40)}"`;
  return `${e.kind} at ${Math.round(e.x + e.width / 2)},${Math.round(e.y + e.height / 2)}`;
}

/** Finds the element a description points at, on the screen as it is now. */
export function findAgain(s: UiScreen, d: string): UiElement | undefined {
  const id = d.match(/^id:(\S+)/)?.[1];
  const text = d.match(/"(.*)"/)?.[1];
  const at = d.match(/ at (\d+),(\d+)$/);
  const els = s.elements.filter((e) => e.clickable || e.editable);
  if (id) return els.find((e) => e.id === id && (!text || e.spoken.startsWith(text))) ?? els.find((e) => e.id === id);
  if (text) return els.find((e) => e.spoken.slice(0, 40) === text) ?? els.find((e) => e.spoken.toLowerCase().includes(text.toLowerCase()));
  if (at) {
    const [x, y] = [Number(at[1]), Number(at[2])];
    return els.find((e) => x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height);
  }
  return undefined;
}

/* ---------------------------------------------------------------------------------------------- */
/* Checks                                                                                          */

export interface ScreenIssue {
  rule: "unlabeled" | "small-target" | "low-contrast" | "field-label" | "duplicate-label" | "cut-off" | "overlap";
  element: string;
  detail?: string;
}

const label = (e: UiElement) => (e.spoken ? `"${e.spoken.slice(0, 40)}"` : e.id ? `id ${e.id}` : `${e.kind} at ${Math.round(e.x)},${Math.round(e.y)}`);

/**
 * Accessibility and layout checks on one screen. `dp` turns screen units into Android dp or iOS
 * points; `shot` is the screenshot and `scale` its pixels per screen unit.
 */
export function checkScreen(s: UiScreen, win: { width: number; height: number }, dp: number, shot?: Image, scale = 1): ScreenIssue[] {
  const out: ScreenIssue[] = [];
  const min = s.platform === "android" ? 48 : 44;
  const taps = s.elements.filter((e) => e.clickable && e.enabled && e.width > 0);
  for (const e of taps) {
    if (!e.spoken && !e.editable) out.push({ rule: "unlabeled", element: `${e.kind}${e.id ? ` (id ${e.id})` : ""} at ${Math.round(e.x)},${Math.round(e.y)}` });
    const w = e.width / dp;
    const h = e.height / dp;
    // A side under 48 dp (44 pt) is hard to hit, except for wide rows (list items) of nearly full height.
    if ((w < min || h < min) && !(w >= 3 * min && h >= min * 0.75)) out.push({ rule: "small-target", element: label(e), detail: `${Math.round(w)} × ${Math.round(h)} ${s.platform === "android" ? "dp" : "pt"}` });
  }
  for (const e of s.elements.filter((x) => x.editable)) {
    if (!e.hint && !e.desc && !e.text && !e.id) out.push({ rule: "field-label", element: `${e.kind} at ${Math.round(e.x)},${Math.round(e.y)}` });
    else if (!e.hint && !e.desc && !e.text) out.push({ rule: "field-label", element: `id ${e.id}` });
  }
  const byLabel = new Map<string, UiElement[]>();
  for (const e of taps.filter((x) => x.spoken)) byLabel.set(e.spoken.toLowerCase(), [...(byLabel.get(e.spoken.toLowerCase()) ?? []), e]);
  for (const [l, els] of byLabel) {
    const spots = new Set(els.map((e) => `${Math.round(e.x / 20)},${Math.round(e.y / 20)}`));
    // Nested clickables share their label with the parent: only separate places count.
    const separate = els.filter((e, i) => !els.some((o, j) => j !== i && o.x <= e.x && o.y <= e.y && o.x + o.width >= e.x + e.width && o.y + o.height >= e.y + e.height));
    if (spots.size > 1 && separate.length > 1) out.push({ rule: "duplicate-label", element: `"${l.slice(0, 40)}" × ${separate.length}` });
  }
  const texts = s.elements.filter((e) => e.text && e.width > 0 && e.height > 0 && !e.editable);
  for (const e of texts) {
    if (e.x + e.width > win.width + 2 || e.x < -2) out.push({ rule: "cut-off", element: `"${e.text.slice(0, 40)}"`, detail: `${Math.round(e.x)} to ${Math.round(e.x + e.width)} on a ${Math.round(win.width)} wide screen` });
  }
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i];
      const b = texts[j];
      if (a.depth !== b.depth) continue;
      const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ix > 0 && iy > 0 && ix * iy > 0.3 * Math.min(a.width * a.height, b.width * b.height)) out.push({ rule: "overlap", element: `"${a.text.slice(0, 25)}" and "${b.text.slice(0, 25)}"` });
    }
  if (shot) {
    for (const e of texts.slice(0, 60)) {
      const c = boxContrast(shot, { x: e.x * scale, y: e.y * scale, width: e.width * scale, height: e.height * scale });
      if (!c) continue;
      const large = e.height / dp >= 32;
      const need = large ? 3 : 4.5;
      if (c.ratio < need) out.push({ rule: "low-contrast", element: `"${e.text.slice(0, 40)}"`, detail: `${c.ratio}:1 (${c.fg} on ${c.bg}), needs ${need}:1` });
    }
  }
  return out;
}
