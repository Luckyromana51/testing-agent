import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { VIEW_JS } from "../agents/web/browsers.js";
import { readOnly } from "../agents/web/guard.js";
import { readIpa } from "../engines/ipa.js";
import { arr, bool, str } from "../engines/plist.js";
import { helperHub, type JobOutcome } from "../helpers.js";
import { WEB_PRODUCTS } from "../products.js";
import type { Tool, ToolFinding, ToolImage, ToolOutput } from "./types.js";

/**
 * Tests that need a Mac, run by GLV's Mac helper (helper/mac/glv-helper.mjs): real Safari on Mac,
 * iPhone and iPad, VoiceOver, and iOS apps in the Simulator with Apple's accessibility audit. The
 * Mac only collects what it sees; the rules that turn that into findings are here, on the server.
 */

const list = (items: string[], max = 8) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const text = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const strings = (v: unknown, max = 40, len = 300) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").slice(0, max).map((s) => text(s, len)) : []);
const objects = (v: unknown, max: number) => (Array.isArray(v) ? (v.filter((o) => o && typeof o === "object").slice(0, max) as Record<string, unknown>[]) : []);

/** The helper's files by the name it gave them, mapped to what the report serves. */
function artifactsOf(out: JobOutcome): Map<string, string> {
  return new Map(out.artifacts.map((a) => [a.name, a.file]));
}

// ---- Real Safari ------------------------------------------------------------------------------

/** What Safari (and Chromium, for comparison) shows of a page: the cross-browser lab's view, plus images that did not load and the window size. */
export const SAFARI_VIEW_JS = `(function () {
  var v = ${VIEW_JS};
  var broken = [];
  var imgs = document.images;
  for (var i = 0; i < imgs.length && broken.length < 30; i++) {
    var im = imgs[i];
    if (im.complete && im.naturalWidth === 0 && (im.currentSrc || im.src) && im.getAttribute("loading") !== "lazy") broken.push((im.currentSrc || im.src).slice(0, 200));
  }
  return { overflow: v.overflow, counts: v.counts, broken: broken, width: window.innerWidth, height: window.innerHeight, userAgent: navigator.userAgent };
})()`;

export type SafariDevice = "mac" | "iphone" | "ipad";

export interface SafariView {
  device: SafariDevice;
  /** "Safari on Mac", "Safari on iPhone 16 (iOS 18.2)". */
  name: string;
  url: string;
  error?: string;
  overflow: number;
  counts: Record<string, number>;
  broken: string[];
  width: number;
  height: number;
  userAgent?: string;
  /** The helper's name for its screenshot of this page. */
  screenshot?: string;
}

export interface BaseView {
  error?: string;
  overflow: number;
  counts: Record<string, number>;
  broken: string[];
}

const DEVICES: SafariDevice[] = ["mac", "iphone", "ipad"];

/** Reads the helper's Safari results, keeping only what fits. */
export function parseSafari(data: unknown): { safari?: string; views: SafariView[]; problems: { device: SafariDevice; error: string }[] } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const views = objects(d.views, 60)
    .filter((v) => DEVICES.includes(v.device as SafariDevice) && typeof v.url === "string" && /^https?:\/\//.test(v.url))
    .map((v): SafariView => {
      const counts: Record<string, number> = {};
      if (v.counts && typeof v.counts === "object") for (const [k, n] of Object.entries(v.counts).slice(0, 10)) counts[text(k, 20)] = num(n);
      return {
        device: v.device as SafariDevice,
        name: text(v.name, 80) || `Safari on ${v.device === "mac" ? "Mac" : v.device === "iphone" ? "iPhone" : "iPad"}`,
        url: text(v.url, 2000),
        ...(v.error ? { error: text(v.error, 300) } : {}),
        overflow: num(v.overflow),
        counts,
        broken: strings(v.broken, 30, 300),
        width: Math.min(4000, Math.max(200, num(v.width) || 1366)),
        height: Math.min(4000, Math.max(200, num(v.height) || 900)),
        ...(v.userAgent ? { userAgent: text(v.userAgent, 400) } : {}),
        ...(typeof v.screenshot === "string" ? { screenshot: text(v.screenshot, 80) } : {}),
      };
    });
  const problems = objects(d.problems, 6)
    .filter((p) => DEVICES.includes(p.device as SafariDevice))
    .map((p) => ({ device: p.device as SafariDevice, error: text(p.error, 400) }));
  return { ...(typeof d.safari === "string" ? { safari: text(d.safari, 40) } : {}), views, problems };
}

const LABELS: Record<string, string> = { images: "images", buttons: "buttons", links: "links", fields: "form fields", headings: "headings", videos: "videos and frames" };

/**
 * Compares what Safari showed with Chromium at the same window size and user agent. Safari does
 * not hand script errors to WebDriver, so a script that failed shows up as missing parts.
 */
export function compareSafari(view: SafariView, base: BaseView): ToolFinding[] {
  const out: ToolFinding[] = [];
  const mac = view.device === "mac";
  const category = mac ? "functional" : "mobile";
  // On a Mac, real Safari confirms what the cross-browser lab saw in WebKit on the same page.
  const same = (rule: string) => (mac ? { sameAs: [rule], sameScope: "page" as const, sameText: "Safari's engine (WebKit)" } : {});
  const where = `${view.width} px wide`;
  if (view.error) {
    if (!base.error)
      out.push({
        category,
        rule: "safari:page-fails",
        severity: "high",
        title: `The page does not open in ${view.name}`,
        detail: `Chromium opens it, but ${view.name} stops with: ${view.error}. Check for browser detection on the server, redirects that only happen for Safari, and certificates Safari does not trust.`,
        pageUrl: view.url,
        ...same("browser:page-fails"),
      });
    return out;
  }
  if (base.error) return out;
  if (view.overflow > 5 && base.overflow <= 5) {
    out.push({
      category,
      rule: "safari:sideways",
      severity: "medium",
      title: `The page scrolls sideways in ${view.name}`,
      detail: `At ${where} the page is ${view.overflow} px too wide in ${view.name}, and fits in Chromium at the same size. Look for CSS Safari reads differently (100vw with a scroll bar, flex items without min-width: 0, fixed widths), and compare the screenshot.`,
      pageUrl: view.url,
      ...same("browser:sideways"),
    });
  }
  const missing: string[] = [];
  for (const k of Object.keys(base.counts)) {
    const a = base.counts[k];
    const b = view.counts[k] ?? 0;
    if (a - b >= 3 && b < a * 0.8) missing.push(`${LABELS[k] ?? k}: ${b} in Safari, ${a} in Chromium`);
  }
  if (missing.length) {
    out.push({
      category,
      rule: "safari:missing-parts",
      severity: "medium",
      title: `Parts of the page are missing in ${view.name}`,
      detail: `${view.name} shows fewer elements than Chromium at ${where}. A script that stopped in Safari (a JavaScript feature or browser API it does not have) or CSS it does not support usually hides them. Open the page in Safari with the Web Inspector to see the error, and compare the screenshot.`,
      pageUrl: view.url,
      evidence: list(missing),
      ...same("browser:missing-parts"),
    });
  }
  const broken = view.broken.filter((u) => !base.broken.includes(u));
  if (broken.length) {
    out.push({
      category,
      rule: "safari:images-fail",
      severity: "medium",
      title: `${broken.length} image${broken.length === 1 ? "" : "s"} ${broken.length === 1 ? "does" : "do"} not show in ${view.name}`,
      detail: `Chromium shows ${broken.length === 1 ? "it" : "them"}, Safari does not. Common causes: an image format this Safari cannot decode (AVIF before Safari 16, JPEG XL), a server that sends the wrong content type, or a security setting Safari applies more strictly.`,
      pageUrl: view.url,
      evidence: list(broken),
      ...same("browser:file-fails"),
    });
  }
  return out;
}

const proxy = () => {
  const server = process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { proxy: { server, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {};
};

/** What Chromium shows of the same pages, at each Safari window's size and with its user agent. */
async function chromiumViews(views: SafariView[], signal: AbortSignal): Promise<Map<SafariView, BaseView>> {
  const out = new Map<SafariView, BaseView>();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch(proxy());
    for (const v of views) {
      signal.throwIfAborted();
      if (v.error && v.error.startsWith("Safari could not start")) continue;
      const context = await browser.newContext({
        viewport: { width: v.width, height: v.height },
        ...(v.device === "mac" ? {} : { isMobile: true, hasTouch: true }),
        ...(v.userAgent ? { userAgent: v.userAgent } : {}),
      });
      const page = await context.newPage();
      const guard = await readOnly(page);
      try {
        await page.goto(v.url, { waitUntil: "load", timeout: 45_000 });
        await page.waitForTimeout(800);
        out.set(v, (await page.evaluate(SAFARI_VIEW_JS)) as BaseView);
      } catch (err) {
        out.set(v, { error: (err as Error).message.split("\n")[0], overflow: 0, counts: {}, broken: [] });
      } finally {
        await guard.off();
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  return out;
}

const DEVICE_CHOICES: Record<string, SafariDevice[]> = { all: ["mac", "iphone", "ipad"], "mac-iphone": ["mac", "iphone"], mac: ["mac"], iphone: ["iphone"] };

export const safariTool: Tool = {
  id: "mac-safari",
  name: "Real Safari (Mac helper)",
  maker: "Apple, through GLV's Mac helper",
  description:
    "Opens the pages in real Safari on a Mac, and in Safari on iPhone and iPad in the iOS Simulator, next to Chromium at the same size. Reports pages that do not open, scroll sideways, lose parts or cannot show images only in Safari, with a screenshot from every device.",
  checks: [
    "Real Safari on Mac, and on iPhone and iPad (iOS Simulator)",
    "Pages that fail, scroll sideways or lose parts only in Safari",
    "Images Safari cannot show",
    "A screenshot from each device",
  ],
  products: WEB_PRODUCTS,
  category: "functional",
  safety: "safe",
  takes: "about 1 minute a page",
  licence: "Safari's WebDriver is part of macOS; the helper is GLV's own",
  homepage: "https://webkit.org/blog/9395/webdriver-is-coming-to-safari-in-ios-13/",
  signedIn: "public",
  needsMac: true,
  options: [
    {
      id: "devices",
      label: "Devices",
      choices: [
        { value: "mac-iphone", label: "Mac and iPhone" },
        { value: "all", label: "Mac, iPhone and iPad" },
        { value: "mac", label: "Mac only" },
        { value: "iphone", label: "iPhone only" },
      ],
      default: "mac-iphone",
    },
    {
      id: "pages",
      label: "Pages",
      choices: ["1", "3", "5", "10"].map((v) => ({ value: v, label: v === "1" ? "The first page" : `The first ${v} pages` })),
      default: "3",
    },
  ],
  ready: async () => helperHub.status("safari"),
  async run(ctx) {
    const urls = [ctx.startUrl, ...ctx.urls.filter((u) => u !== ctx.startUrl)].filter((u) => /^https?:\/\//.test(u)).slice(0, Number(ctx.options.pages) || 3);
    const devices = DEVICE_CHOICES[ctx.options.devices] ?? DEVICE_CHOICES["mac-iphone"];
    const outcome = await helperHub.run(
      "safari",
      { urls, devices, script: SAFARI_VIEW_JS, shots: Math.min(urls.length, 3) },
      { label: "Real Safari", outDir: ctx.outDir, signal: ctx.signal, log: ctx.log, runMs: (4 + urls.length * devices.length * 1.5) * 60_000 },
    );
    const { safari, views, problems } = parseSafari(outcome.data);
    if (!views.length) throw new Error(problems[0]?.error ?? "The Mac helper sent no pages back from Safari.");
    const bases = await chromiumViews(views, ctx.signal);
    const files = artifactsOf(outcome);
    const findings: ToolFinding[] = [];
    const images: ToolImage[] = [];
    for (const v of views) {
      const base = bases.get(v);
      if (base) findings.push(...compareSafari(v, base));
      const file = v.screenshot && files.get(v.screenshot);
      if (file) images.push({ file, label: `${v.name}: ${new URL(v.url).pathname}` });
    }
    const names = [...new Set(views.map((v) => v.name))];
    return {
      findings,
      images,
      tested: `${urls.length} page${urls.length === 1 ? "" : "s"} in ${names.join(", ")}`,
      summary: [
        ...(safari ? [`Safari ${safari}`] : []),
        ...problems.map((p) => `Not tested on ${p.device === "mac" ? "Mac" : p.device === "iphone" ? "iPhone" : "iPad"}: ${p.error}`),
      ],
    };
  },
};

// ---- VoiceOver --------------------------------------------------------------------------------

export interface VoiceOverPage {
  url: string;
  /** What VoiceOver said at each step, in order. */
  phrases: string[];
  /** It moved past the last item of the page. */
  reachedEnd: boolean;
  error?: string;
  transcript?: string;
}

export function parseVoiceOver(data: unknown): { pages: VoiceOverPage[]; voiceover?: string } {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const pages = objects(d.pages, 5)
    .filter((p) => typeof p.url === "string" && /^https?:\/\//.test(p.url))
    .map((p) => ({
      url: text(p.url, 2000),
      phrases: strings(p.phrases, 600, 400),
      reachedEnd: p.reachedEnd === true,
      ...(p.error ? { error: text(p.error, 400) } : {}),
      ...(typeof p.transcript === "string" ? { transcript: text(p.transcript, 80) } : {}),
    }));
  return { pages, ...(typeof d.voiceover === "string" ? { voiceover: text(d.voiceover, 40) } : {}) };
}

/** VoiceOver's phrase without the parts that change with its settings (hints, "visited", positions). */
const norm = (p: string) =>
  p
    .replace(/\s+/g, " ")
    .replace(/,? ?(you are currently on|to click this|to interact|press control-option)[^.]*\.?/gi, "")
    .trim()
    .replace(/[.,;]+$/, "")
    .toLowerCase();

const IMAGE_FILE = /\b[\w-]+\.(png|jpe?g|gif|webp|avif|svg|bmp|heic)\b/i;
const VAGUE_LINK = /^(click here|here|read more|more|learn more|details|more info|view more|see more|continue|link)$/i;

/**
 * What a blind visitor hears that they cannot use. Only plain patterns count: an item VoiceOver
 * can only call by its role ("button", "image"), a file name or a web address read instead of a
 * name, the same vague link many times, and no headings on a page it read to the end.
 */
export function voiceOverFindings(page: VoiceOverPage): ToolFinding[] {
  const out: ToolFinding[] = [];
  const said = page.phrases.map(norm).filter(Boolean);
  const add = (rule: string, severity: ToolFinding["severity"], title: string, detail: string, items: string[], sameAs?: string) =>
    out.push({
      category: "accessibility",
      rule,
      severity,
      title,
      detail,
      pageUrl: page.url,
      evidence: list([...new Set(items)]),
      ...(sameAs ? { sameAs: [sameAs], sameScope: "page" as const } : {}),
    });
  const role = (p: string, names: string[]) => names.some((n) => p === n || p === `unlabeled ${n}` || p === `unlabelled ${n}` || p === `${n}, unlabeled` || p === `visited, ${n}`);

  const images = said.filter((p) => role(p, ["image"]));
  if (images.length)
    add("voiceover:unnamed-image", "high", `VoiceOver says only "image" for ${images.length} image${images.length === 1 ? "" : "s"}`, "A blind visitor hears that there is an image but not what it shows. Give each image that carries meaning an alt text, and decorative ones alt=\"\" so VoiceOver skips them.", images, "axe:image-alt");
  const files = said.filter((p) => IMAGE_FILE.test(p) && !/https?:\/\//.test(p));
  if (files.length)
    add("voiceover:file-names", "medium", "VoiceOver reads image file names aloud", "With no alt text, VoiceOver falls back to the file name (\"hero-banner-final-2.jpg\"), which says nothing useful. Add alt text that says what the image shows.", files, "axe:image-alt");
  const buttons = said.filter((p) => role(p, ["button"]));
  if (buttons.length)
    add("voiceover:unnamed-button", "high", `VoiceOver says only "button" for ${buttons.length} button${buttons.length === 1 ? "" : "s"}`, "A blind visitor cannot tell what these buttons do. Icon buttons need a name: visible text, aria-label, or a title on the SVG.", buttons, "axe:button-name");
  const links = said.filter((p) => role(p, ["link"]) || /^(visited, )?link,? (https?:\/\/|www\.)/.test(p) || /^(https?:\/\/|www\.)\S+,? link$/.test(p));
  if (links.length)
    add("voiceover:unnamed-link", "high", `VoiceOver cannot name ${links.length} link${links.length === 1 ? "" : "s"}`, "These links have no text, so VoiceOver says \"link\" or reads the web address out character by character. Give each link text, or an aria-label that says where it goes.", links, "axe:link-name");
  const fields = said.filter((p) => role(p, ["edit text", "text field", "search text field", "secure edit text", "popup button", "combo box", "text entry area"]));
  if (fields.length)
    add("voiceover:unnamed-field", "high", `VoiceOver cannot name ${fields.length} form field${fields.length === 1 ? "" : "s"}`, "A blind visitor reaches the field but does not know what to type. Connect a <label for> to each field (a placeholder is not a label).", fields, "axe:label");
  // The same vague link text several times: "Read more, link" ×6 says nothing in a list of links.
  const vague = new Map<string, number>();
  for (const p of said) {
    const m = p.match(/^(?:visited, )?(?:link,? )?(.+?),? link$/) ?? p.match(/^(?:visited, )?link,? (.+)$/);
    if (m && VAGUE_LINK.test(m[1].trim())) vague.set(m[1].trim(), (vague.get(m[1].trim()) ?? 0) + 1);
  }
  const repeated = [...vague].filter(([, n]) => n >= 3);
  if (repeated.length)
    add("voiceover:vague-links", "low", "Several links all sound the same to VoiceOver", "VoiceOver users often list all links on a page; a list of \"Read more\" says nothing. Put the subject in the link text, or add it for screen readers with a visually hidden span.", repeated.map(([t, n]) => `"${t}" ${n} times`));
  // Only when VoiceOver read the whole page: headings may come after the limit.
  if (page.reachedEnd && said.length >= 25 && !said.some((p) => /heading level \d|heading, level \d|level \d heading/.test(p)))
    add("voiceover:no-headings", "medium", "VoiceOver finds no headings on the page", "VoiceOver users jump between headings to find their way around. Mark section titles up as h1 to h3 instead of styled text.", [`${said.length} items read, none was a heading`], "axe:page-has-heading-one");
  return out;
}

export const voiceOverTool: Tool = {
  id: "mac-voiceover",
  name: "VoiceOver (Mac helper)",
  maker: "Apple, through GLV's Mac helper",
  description:
    "Opens the pages in Safari with VoiceOver, the screen reader built into every Mac, moves through each one item by item the way a blind visitor does, and writes down what VoiceOver says. Reports images, buttons, links and fields it cannot name, file names read aloud, links that all sound the same, and pages with no headings. The Mac speaks and its screen is in use while this runs.",
  checks: ["What VoiceOver really says, item by item (saved as a transcript)", "Images, buttons, links and fields with no name", "File names and web addresses read aloud", "Links that all sound the same, pages with no headings"],
  products: WEB_PRODUCTS,
  category: "accessibility",
  safety: "safe",
  takes: "about 2 minutes a page",
  licence: "VoiceOver is part of macOS; the helper is GLV's own",
  homepage: "https://support.apple.com/guide/voiceover/welcome/mac",
  signedIn: "public",
  needsMac: true,
  options: [
    { id: "pages", label: "Pages", choices: ["1", "2", "3"].map((v) => ({ value: v, label: v === "1" ? "The first page" : `The first ${v} pages` })), default: "1" },
    { id: "steps", label: "Items per page", hint: "How far VoiceOver reads into each page.", choices: ["100", "200", "400"].map((v) => ({ value: v, label: `Up to ${v}` })), default: "200" },
  ],
  ready: async () => helperHub.status("voiceover"),
  async run(ctx) {
    const urls = [ctx.startUrl, ...ctx.urls.filter((u) => u !== ctx.startUrl)].filter((u) => /^https?:\/\//.test(u)).slice(0, Number(ctx.options.pages) || 1);
    const steps = Math.min(400, Number(ctx.options.steps) || 200);
    const outcome = await helperHub.run("voiceover", { urls, steps }, { label: "VoiceOver", outDir: ctx.outDir, signal: ctx.signal, log: ctx.log, runMs: (3 + urls.length * (steps / 60)) * 60_000 });
    const { pages, voiceover } = parseVoiceOver(outcome.data);
    if (!pages.length) throw new Error("The Mac helper sent nothing back from VoiceOver.");
    const files = artifactsOf(outcome);
    const findings: ToolFinding[] = [];
    const reports: ToolOutput["reports"] = [];
    const summary: string[] = [];
    for (const [i, p] of pages.entries()) {
      const where = new URL(p.url).pathname;
      if (p.error && !p.phrases.length) {
        summary.push(`${where}: ${p.error}`);
        continue;
      }
      findings.push(...voiceOverFindings(p));
      summary.push(`${where}: ${p.phrases.length} items read${p.reachedEnd ? " to the end of the page" : `, stopped at the limit of ${steps}`}`);
      const file = p.transcript && files.get(p.transcript);
      if (file) reports.push({ file, label: pages.length > 1 ? `What VoiceOver said (page ${i + 1})` : "What VoiceOver said" });
    }
    if (!pages.some((p) => p.phrases.length)) throw new Error(pages[0].error ?? "VoiceOver read nothing on the page.");
    return { findings, reports, summary: [...(voiceover ? [`VoiceOver on macOS ${voiceover}`] : []), ...summary], tested: `${pages.length} page${pages.length === 1 ? "" : "s"} with VoiceOver` };
  },
};

// ---- iOS app in the Simulator ------------------------------------------------------------------

export interface AuditIssue {
  type: string;
  description: string;
  element?: string;
}

export interface IosScreen {
  name: string;
  screenshot?: string;
  issues: AuditIssue[];
}

export interface IosRun {
  mode: "simulator" | "device";
  device: string;
  installed: boolean;
  installError?: string;
  launched: boolean;
  launchError?: string;
  /** Still running 10 seconds after it opened. */
  stayedOpen: boolean;
  crash?: { type: string; reason?: string; frames: string[] };
  /** The app crashed while the audit moved between its screens. */
  crashedDuringAudit?: boolean;
  screens: IosScreen[];
  auditError?: string;
  shots: { label: string; file: string }[];
}

export function parseIosRun(data: unknown): IosRun {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const crash = d.crash && typeof d.crash === "object" ? (d.crash as Record<string, unknown>) : undefined;
  return {
    mode: d.mode === "device" ? "device" : "simulator",
    device: text(d.device, 80) || "iOS Simulator",
    installed: d.installed === true,
    ...(d.installError ? { installError: text(d.installError, 500) } : {}),
    launched: d.launched === true,
    ...(d.launchError ? { launchError: text(d.launchError, 500) } : {}),
    stayedOpen: d.stayedOpen === true,
    ...(crash ? { crash: { type: text(crash.type, 80) || "crash", ...(crash.reason ? { reason: text(crash.reason, 400) } : {}), frames: strings(crash.frames, 12, 200) } } : {}),
    ...(d.crashedDuringAudit === true ? { crashedDuringAudit: true } : {}),
    screens: objects(d.screens, 12).map((s) => ({
      name: text(s.name, 60) || "Screen",
      ...(typeof s.screenshot === "string" ? { screenshot: text(s.screenshot, 80) } : {}),
      issues: objects(s.issues, 100).map((i) => ({ type: text(i.type, 40) || "other", description: text(i.description, 300), ...(i.element ? { element: text(i.element, 120) } : {}) })),
    })),
    ...(d.auditError ? { auditError: text(d.auditError, 400) } : {}),
    shots: objects(d.shots, 10)
      .filter((s) => typeof s.file === "string")
      .map((s) => ({ label: text(s.label, 60), file: text(s.file, 80) })),
  };
}

/** Apple's audit types, how much each one stops people, and what to do. */
const AUDIT: Record<string, { severity: ToolFinding["severity"]; title: (n: number) => string; detail: string }> = {
  sufficientElementDescription: {
    severity: "high",
    title: (n) => `${n} element${n === 1 ? " has" : "s have"} no description VoiceOver can read`,
    detail: "Apple's accessibility audit found controls and images without a useful accessibility label, so VoiceOver users hear only \"button\" or nothing. Set accessibilityLabel (UIKit) or .accessibilityLabel() (SwiftUI) to what the element does; hide decorative images from accessibility.",
  },
  hitRegion: {
    severity: "medium",
    title: (n) => `${n} control${n === 1 ? " is" : "s are"} too small to tap reliably`,
    detail: "Apple's audit found tap targets smaller than its minimum (44 by 44 points). Make the tappable area bigger with padding or contentShape, even if the icon stays small.",
  },
  contrast: {
    severity: "medium",
    title: (n) => `${n} text${n === 1 ? "" : "s"} or control${n === 1 ? " has" : "s have"} too little contrast`,
    detail: "Apple's audit found text or controls whose colours are too close to their background to read, for many people in sunlight too. Use darker text or a stronger background, and check dark mode separately.",
  },
  dynamicType: {
    severity: "medium",
    title: (n) => `${n} text${n === 1 ? " does" : "s do"} not grow with the phone's text size`,
    detail: "Apple's audit found text in fixed sizes that ignore the text size people set in Settings. Use text styles (.body, .headline) or UIFontMetrics so text scales.",
  },
  textClipped: {
    severity: "medium",
    title: (n) => `${n} text${n === 1 ? " is" : "s are"} cut off at larger text sizes`,
    detail: "Apple's audit found labels that are clipped when the text size is larger. Let labels wrap (numberOfLines = 0 or no lineLimit) and avoid fixed heights; see the large-text screenshot.",
  },
  trait: {
    severity: "low",
    title: (n) => `${n} element${n === 1 ? " has" : "s have"} the wrong accessibility traits`,
    detail: "Apple's audit found elements whose traits do not match what they are (a button that is not marked as a button, a header that is not a header), so VoiceOver describes them wrongly. Set accessibilityTraits or use .accessibilityAddTraits().",
  },
  elementDetection: {
    severity: "low",
    title: (n) => `${n} part${n === 1 ? "" : "s"} of the screen cannot be reached with VoiceOver`,
    detail: "Apple's audit found content drawn inside one element that should be separate elements (text in an image, several controls in one view). Expose them as accessibility elements.",
  },
};

export function iosRunFindings(run: IosRun, where: string, appName: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  const on = run.mode === "simulator" ? `in the iOS Simulator (${run.device})` : `on ${run.device}`;
  if (!run.installed) {
    out.push({ category: "functional", rule: "ios-run:install-fails", severity: "critical", title: `The app does not install ${on}`, detail: `Installing ${appName} failed, so nobody can open this build. ${run.mode === "device" ? "Check that the iPhone is in the provisioning profile and that the profile has not expired." : "Check that it is a Simulator build for this Mac's processor."}`, pageUrl: where, ...(run.installError ? { evidence: run.installError } : {}) });
    return out;
  }
  const crashed = !run.launched || !run.stayedOpen;
  if (crashed) {
    const c = run.crash;
    out.push({
      category: "functional",
      rule: "ios-run:crash-on-launch",
      severity: "critical",
      title: run.launched ? "The app closes within seconds of opening" : "The app does not open",
      detail: `${appName} ${run.launched ? "opened and then closed by itself within 10 seconds" : "could not be started"} ${on}. Every user meets this first.${c ? " The crash report's reason and the code it stopped in are below." : ""} Run it from Xcode on the same iOS version to see the error, and look for missing Info.plist keys, files missing from the bundle or code that assumes a network answer.`,
      pageUrl: where,
      ...(c || run.launchError ? { evidence: [c ? `${c.type}${c.reason ? `: ${c.reason}` : ""}` : "", ...(c?.frames ?? []), run.launchError ?? ""].filter(Boolean).join("\n") } : {}),
    });
  } else if (run.crashedDuringAudit) {
    const c = run.crash;
    out.push({
      category: "functional",
      rule: "ios-run:crash",
      severity: "high",
      title: "The app crashed while moving between its tabs",
      detail: `${appName} closed by itself while the test opened its tabs one by one ${on}. Open the same tabs in Xcode to reproduce it.`,
      pageUrl: where,
      ...(c ? { evidence: [`${c.type}${c.reason ? `: ${c.reason}` : ""}`, ...c.frames].join("\n") } : {}),
    });
  }
  const byType = new Map<string, string[]>();
  // "auditError" is the runner saying the audit itself could not run on a screen: not the app's problem.
  for (const s of run.screens)
    for (const i of s.issues) if (i.type !== "auditError") byType.set(i.type, [...(byType.get(i.type) ?? []), `${s.name}: ${i.description}${i.element ? ` (${i.element})` : ""}`]);
  for (const [type, items] of byType) {
    const a = AUDIT[type] ?? { severity: "low" as const, title: (n: number) => `Apple's accessibility audit found ${n} other issue${n === 1 ? "" : "s"}`, detail: "Apple's accessibility audit reported these. Open the app in Xcode's Accessibility Inspector (Audit) for the details." };
    out.push({ category: "accessibility", rule: `ios-a11y:${type.replace(/[^\w-]/g, "")}`, severity: a.severity, title: a.title(items.length), detail: a.detail, pageUrl: where, evidence: list(items, 12) });
  }
  return out;
}

export const iosSimulatorTool: Tool = {
  id: "mac-ios-sim",
  name: "Run in the iOS Simulator (Mac helper)",
  maker: "Apple, through GLV's Mac helper",
  description:
    "Installs the app in the iOS Simulator on the Mac (or, for a Development or Ad Hoc IPA, on an iPhone connected to it), opens it and watches for crashes. In the Simulator it also runs Apple's accessibility audit (the one in Xcode) on the first screen and on each tab, and saves screenshots in light mode, dark mode and the largest text size. The app runs on the Mac, so only test apps from clients you trust.",
  checks: ["Installs and opens without crashing (with the crash report)", "Apple's accessibility audit on each tab: labels, contrast, tap sizes, text size, clipped text", "Screenshots in light, dark and large text"],
  products: ["ios"],
  category: "accessibility",
  ownCategory: true,
  safety: "safe",
  takes: "about 3 to 5 minutes (the first run builds GLV's audit runner)",
  licence: "Xcode's simctl and XCTest; the helper is GLV's own",
  homepage: "https://developer.apple.com/videos/play/wwdc2023/10035/",
  signedIn: "public",
  needsMac: true,
  options: [
    { id: "device", label: "Simulator", choices: [{ value: "iphone", label: "iPhone" }, { value: "ipad", label: "iPad" }], default: "iphone" },
    { id: "audit", label: "Accessibility audit", choices: [{ value: "on", label: "On" }, { value: "off", label: "Off (only open the app and take screenshots)" }], default: "on" },
  ],
  ready: async () => helperHub.status("ios-app"),
  async run(ctx) {
    const file = ctx.target.file;
    if (!file || !/^[0-9a-f-]{36}\.(ipa|zip)$/.test(file)) throw new Error("This project has no uploaded app.");
    const full = path.join(ctx.uploadsDir, file);
    const { facts, profile, exe } = readIpa(await readFile(full));
    if (facts.encrypted) throw new Error("This is the App Store's encrypted copy, which only installs from the App Store. Upload a Simulator build (a zip of the .app) or a Development or Ad Hoc IPA exported from Xcode.");
    const devicesInProfile = profile ? arr(profile.ProvisionedDevices).filter((d): d is string => typeof d === "string") : [];
    const allDevices = profile ? bool(profile.ProvisionsAllDevices) === true : false;
    if (!facts.simulator && !devicesInProfile.length && !allDevices)
      throw new Error("This build is for the App Store (no devices in its profile), so it only installs through TestFlight. Upload a Simulator build (a zip of the .app) or a Development or Ad Hoc IPA.");
    const outcome = await helperHub.run(
      "ios-app",
      {
        bundleId: facts.bundleId,
        appName: facts.name,
        executable: exe,
        appDir: facts.appDir,
        packaging: facts.packaging,
        simulatorBuild: facts.simulator,
        minOS: facts.minOS ?? null,
        device: ctx.options.device === "ipad" ? "ipad" : "iphone",
        audit: ctx.options.audit !== "off",
        provisionedDevices: devicesInProfile.slice(0, 200),
        provisionsAllDevices: allDevices,
        team: profile ? (str(profile.TeamName) ?? null) : null,
      },
      { label: "iOS Simulator", file: { path: full, name: ctx.target.fileName ?? file, size: (await stat(full)).size }, outDir: ctx.outDir, signal: ctx.signal, log: ctx.log, runMs: 30 * 60_000 },
    );
    const run = parseIosRun(outcome.data);
    const files = artifactsOf(outcome);
    const where = `${facts.appDir}${exe}`;
    const findings = iosRunFindings(run, where, facts.name);
    const images: ToolImage[] = [];
    for (const s of run.screens) {
      const f = s.screenshot && files.get(s.screenshot);
      if (f) images.push({ file: f, label: s.name });
    }
    for (const s of run.shots) {
      const f = files.get(s.file);
      if (f) images.push({ file: f, label: s.label });
    }
    const issues = run.screens.reduce((n, s) => n + s.issues.filter((i) => i.type !== "auditError").length, 0);
    const notAudited = run.screens.filter((s) => s.issues.some((i) => i.type === "auditError"));
    return {
      findings,
      images,
      tested: `${facts.name} ${run.mode === "simulator" ? `in the iOS Simulator (${run.device})` : `on ${run.device}`}`,
      summary: [
        run.installed ? (run.launched && run.stayedOpen ? "Installed and opened without crashing" : "Installed, but it did not stay open") : "Did not install",
        ...(run.screens.length ? [`Apple's accessibility audit on ${run.screens.length} screen${run.screens.length === 1 ? "" : "s"}: ${issues} issue${issues === 1 ? "" : "s"}`] : []),
        ...(run.auditError ? [`The audit could not finish: ${run.auditError}`] : []),
        ...notAudited.map((s) => `The audit could not run on "${s.name}": ${s.issues.find((i) => i.type === "auditError")!.description}`),
        ...(run.mode === "device" ? ["On a real iPhone the audit is not run: Apple's audit needs the Simulator (or a signed test runner)."] : []),
      ],
    };
  },
};
