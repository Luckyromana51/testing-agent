import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { ALL_AGENTS } from "./agents/registry.js";
import type { ToolChoice } from "./tools/types.js";
import { CATEGORIES, type Category, type ProductType } from "./types.js";

/**
 * Master control: every setting a tester can change for one test, on top of the owner's settings
 * and the project's defaults. A setting left out keeps the normal behaviour.
 *
 * It never opens a safety gate: checks that change data still need a test copy or the client's
 * written permission, and load and attack tools still need a valid permission with its proof file.
 * Master control can only turn those off, or keep them inside what the permission allows.
 */
export interface RunControl {
  // ---- What to test
  /** Only agents of these kinds run (accessibility, security...). Unset: every kind. */
  categories?: Category[];
  /** Agent on/off for this test, over the owner's choices. */
  agents?: Record<string, boolean>;
  /** Every agent for the product on, also the ones off by default (single switches above still win). */
  allAgents?: boolean;
  /** Outside tools for this test, instead of the project's (checked against the permissions again). */
  tools?: ToolChoice[];
  /** Turns the optional parts of a test off (they run only when the owner has the module on). */
  extras?: Partial<Record<ExtraId, boolean>>;

  // ---- Pages and crawl (web)
  maxPages?: number;
  /** Clicks away from the start page: 0 tests only the start page. */
  maxDepth?: number;
  /** Only pages whose address contains one of these (or matches the * pattern). */
  include?: string[];
  /** Never pages whose address contains one of these (or matches the * pattern). */
  exclude?: string[];
  /** More pages of the same site to test even if no link points there. */
  extraUrls?: string[];
  checkLinks?: boolean;
  parallel?: number;

  // ---- Screens (web)
  desktop?: Size;
  tablet?: Size;
  phone?: Size;
  /** Turn the tablet or the phone pass off. */
  tabletOn?: boolean;
  phoneOn?: boolean;

  // ---- Browser (web)
  userAgent?: string;
  locale?: string;
  timezone?: string;
  colorScheme?: "light" | "dark" | "no-preference";
  reducedMotion?: "reduce" | "no-preference";
  javascript?: boolean;
  /** Sent with every request the browser makes, e.g. a header the client's firewall lets through. */
  headers?: Record<string, string>;
  /** Requests to these addresses are blocked (chat widgets, ads, analytics), * patterns. */
  blockUrls?: string[];

  // ---- Network and speed (web)
  network?: NetworkProfile;
  /** 1 is the server's own speed; 4 is a mid-range phone. */
  cpuSlowdown?: number;

  // ---- Timing and retries
  /** Seconds a page has to load. */
  pageTimeout?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  /** Extra wait after the page loads, before checking (ms). */
  settleMs?: number;
  /** Pause between pages, to be gentle on a small server (ms). */
  delayMs?: number;
  /** Tries again after 429, 502, 503, 504. */
  retries?: number;

  // ---- Stop rules
  /** Stops starting new pages after this many minutes, then finishes and scores what it has. */
  maxMinutes?: number;
  /** Finishes early when the first critical problem is found. */
  stopOnCritical?: boolean;

  // ---- Pass or fail (for CI and sign-off)
  gate?: { minScore?: number; maxCritical?: number; maxHigh?: number; maxNew?: number };

  // ---- API calls
  apiTimeout?: number;
  apiDelayMs?: number;
  /** Times each read is called to time it (1 to 10). */
  apiSamples?: number;
}

export type ExtraId = "inspect" | "visual" | "journeys" | "explorer" | "mail" | "webhooks" | "roles" | "ai" | "scenarios" | "appJourneys";
export type NetworkProfile = "none" | "fast4g" | "slow4g" | "fast3g" | "slow3g" | "2g";
export interface Size {
  width: number;
  height: number;
}

/** Download and upload in kilobits per second and the round trip in ms, the same as Chrome's DevTools. */
export const NETWORKS: Record<Exclude<NetworkProfile, "none">, { label: string; downKbps: number; upKbps: number; latencyMs: number }> = {
  fast4g: { label: "Fast 4G", downKbps: 9000, upKbps: 9000, latencyMs: 60 },
  slow4g: { label: "Slow 4G", downKbps: 1600, upKbps: 750, latencyMs: 150 },
  fast3g: { label: "Fast 3G", downKbps: 1440, upKbps: 675, latencyMs: 563 },
  slow3g: { label: "Slow 3G", downKbps: 400, upKbps: 400, latencyMs: 2000 },
  "2g": { label: "2G", downKbps: 250, upKbps: 50, latencyMs: 2500 },
};

const WEB: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];
const ALL: ProductType[] = [...WEB, "api", "code", "android", "ios"];

/** One setting, for the master control page to draw. */
export interface ControlField {
  id: keyof RunControl | `gate.${"minScore" | "maxCritical" | "maxHigh" | "maxNew"}` | `extras.${ExtraId}`;
  section: SectionId;
  label: string;
  hint?: string;
  kind: "number" | "toggle" | "select" | "text" | "list" | "size" | "headers";
  min?: number;
  max?: number;
  unit?: string;
  choices?: { value: string; label: string }[];
  /** Shown as the normal value. */
  normal?: string;
  products: ProductType[];
}

export type SectionId = "scope" | "crawl" | "screens" | "browser" | "network" | "timing" | "stop" | "gate" | "extras" | "api";

export const SECTIONS: { id: SectionId; name: string; about: string }[] = [
  { id: "scope", name: "What to test", about: "Kinds of checks, each GLV agent and each outside tool" },
  { id: "crawl", name: "Pages and crawl", about: "How many pages, how deep, which addresses, how many at once" },
  { id: "screens", name: "Screens and devices", about: "Desktop, tablet and phone sizes, and which passes run" },
  { id: "browser", name: "Browser", about: "Language, time zone, dark mode, JavaScript, headers and blocked addresses" },
  { id: "network", name: "Network and speed", about: "Slow networks and slow phones" },
  { id: "timing", name: "Timing and retries", about: "Time limits per page, waits and retries" },
  { id: "stop", name: "Stop rules", about: "A time limit for the whole test, and stopping at the first critical problem" },
  { id: "gate", name: "Pass or fail", about: "When the test counts as failed, for CI and client sign-off" },
  { id: "extras", name: "Extras", about: "Inspect screen, visual compare, journeys, other accounts and the Claude summary" },
  { id: "api", name: "API calls", about: "Time limit, pause and timing samples per call" },
];

const choice = (...pairs: [string, string][]) => pairs.map(([value, label]) => ({ value, label }));

export const CONTROL_FIELDS: ControlField[] = [
  // crawl
  { id: "maxPages", section: "crawl", label: "Most pages", kind: "number", min: 1, max: 1000, products: WEB, hint: "The project's own number when left empty." },
  { id: "maxDepth", section: "crawl", label: "Most clicks from the start page", kind: "number", min: 0, max: 20, products: WEB, hint: "0 tests only the start page and the extra pages below.", normal: "No limit" },
  { id: "include", section: "crawl", label: "Only addresses with", kind: "list", products: WEB, hint: "One per line: /shop/ or */product/*. The start page is always tested." },
  { id: "exclude", section: "crawl", label: "Never addresses with", kind: "list", products: WEB, hint: "One per line: /blog/, ?print=, */tag/*" },
  { id: "extraUrls", section: "crawl", label: "Also test these pages", kind: "list", products: WEB, hint: "Full addresses on the same site, one per line, even when no link points there." },
  { id: "checkLinks", section: "crawl", label: "Check every link", kind: "toggle", products: WEB, normal: "On" },
  { id: "parallel", section: "crawl", label: "Pages at the same time", kind: "number", min: 1, max: 16, products: WEB, hint: "Drops to 1 by itself if the site answers 429 (too many requests)." },
  // screens
  { id: "desktop", section: "screens", label: "Desktop size", kind: "size", products: WEB, normal: "1366 × 900" },
  { id: "tabletOn", section: "screens", label: "Tablet pass", kind: "toggle", products: WEB, normal: "On when a tablet check is on" },
  { id: "tablet", section: "screens", label: "Tablet size", kind: "size", products: WEB, normal: "820 × 1180" },
  { id: "phoneOn", section: "screens", label: "Phone pass", kind: "toggle", products: WEB, normal: "On", hint: "Off skips the phone picture and every phone check." },
  { id: "phone", section: "screens", label: "Phone size", kind: "size", products: WEB, normal: "390 × 844" },
  // browser
  {
    id: "locale", section: "browser", label: "Browser language", kind: "select", products: WEB, normal: "English (US)",
    choices: choice(["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-IN", "English (India)"], ["hi-IN", "Hindi"], ["ta-IN", "Tamil"], ["te-IN", "Telugu"], ["mr-IN", "Marathi"], ["bn-IN", "Bengali"], ["gu-IN", "Gujarati"], ["ar-AE", "Arabic"], ["fr-FR", "French"], ["de-DE", "German"], ["es-ES", "Spanish"], ["ja-JP", "Japanese"], ["zh-CN", "Chinese"]),
  },
  {
    id: "timezone", section: "browser", label: "Time zone", kind: "select", products: WEB, normal: "The server's",
    choices: choice(["Asia/Kolkata", "India"], ["Asia/Dubai", "Dubai"], ["Europe/London", "London"], ["Europe/Berlin", "Berlin"], ["America/New_York", "New York"], ["America/Los_Angeles", "Los Angeles"], ["Asia/Singapore", "Singapore"], ["Australia/Sydney", "Sydney"], ["UTC", "UTC"]),
  },
  { id: "colorScheme", section: "browser", label: "Light or dark", kind: "select", products: WEB, normal: "Light", choices: choice(["light", "Light"], ["dark", "Dark"], ["no-preference", "No preference"]) },
  { id: "reducedMotion", section: "browser", label: "Reduce motion", kind: "select", products: WEB, normal: "No preference", choices: choice(["no-preference", "No preference"], ["reduce", "Reduce motion"]) },
  { id: "javascript", section: "browser", label: "JavaScript", kind: "toggle", products: WEB, normal: "On", hint: "Off shows what visitors and search engines see without scripts." },
  { id: "userAgent", section: "browser", label: "Browser name (user agent)", kind: "text", products: WEB, normal: "Chrome on Linux, marked GLVTestingAgent" },
  { id: "headers", section: "browser", label: "Extra headers", kind: "headers", products: WEB, hint: "One per line, Name: value. Sent with every request, also to other sites the page loads from." },
  { id: "blockUrls", section: "browser", label: "Block these addresses", kind: "list", products: WEB, hint: "One per line: *googletagmanager*, *intercom*. Shows the site without them." },
  // network
  {
    id: "network", section: "network", label: "Network", kind: "select", products: WEB, normal: "Full speed",
    choices: [{ value: "none", label: "Full speed" }, ...Object.entries(NETWORKS).map(([value, n]) => ({ value, label: `${n.label} (${n.downKbps >= 1000 ? `${n.downKbps / 1000} Mbps` : `${n.downKbps} kbps`}, ${n.latencyMs} ms)` }))],
  },
  { id: "cpuSlowdown", section: "network", label: "Slow phone (CPU slowdown)", kind: "number", min: 1, max: 20, unit: "×", products: WEB, normal: "1× (none)", hint: "4× is a mid-range phone, 6× a low-end one." },
  // timing
  { id: "pageTimeout", section: "timing", label: "Time a page has to load", kind: "number", min: 5, max: 300, unit: "s", products: WEB, normal: "30 s" },
  {
    id: "waitUntil", section: "timing", label: "Page counts as loaded at", kind: "select", products: WEB, normal: "The load event",
    choices: choice(["load", "The load event"], ["domcontentloaded", "The HTML is read (faster)"], ["networkidle", "No requests for half a second (slower, steadier)"], ["commit", "The first answer (fastest)"]),
  },
  { id: "settleMs", section: "timing", label: "Extra wait before checking", kind: "number", min: 0, max: 30000, unit: "ms", products: WEB, normal: "0", hint: "For pages that draw late (charts, maps)." },
  { id: "delayMs", section: "timing", label: "Pause between pages", kind: "number", min: 0, max: 60000, unit: "ms", products: WEB, normal: "0", hint: "Be gentle on a small or shared server." },
  { id: "retries", section: "timing", label: "Tries again on 429 / 502 / 503 / 504", kind: "number", min: 0, max: 5, products: WEB, normal: "1" },
  // stop
  { id: "maxMinutes", section: "stop", label: "Time limit for the test", kind: "number", min: 1, max: 600, unit: "min", products: WEB, normal: "None", hint: "Stops starting new pages, then finishes the site checks and scores what it tested." },
  { id: "stopOnCritical", section: "stop", label: "Finish at the first critical problem", kind: "toggle", products: WEB, normal: "Off" },
  // gate
  { id: "gate.minScore", section: "gate", label: "Fail below this score", kind: "number", min: 0, max: 100, products: ALL, normal: "No limit" },
  { id: "gate.maxCritical", section: "gate", label: "Most critical problems allowed", kind: "number", min: 0, max: 1000, products: ALL, normal: "No limit" },
  { id: "gate.maxHigh", section: "gate", label: "Most high problems allowed", kind: "number", min: 0, max: 1000, products: ALL, normal: "No limit" },
  { id: "gate.maxNew", section: "gate", label: "Most new issues allowed", kind: "number", min: 0, max: 1000, products: ALL, normal: "No limit", hint: "New since the last test of the project." },
  // extras
  { id: "extras.inspect", section: "extras", label: "Inspect screen (network, console, steps)", kind: "toggle", products: WEB, normal: "As the owner set it" },
  { id: "extras.visual", section: "extras", label: "Visual compare", kind: "toggle", products: WEB, normal: "As the owner set it" },
  { id: "extras.journeys", section: "extras", label: "User journeys", kind: "toggle", products: WEB, normal: "As the owner set it" },
  { id: "extras.explorer", section: "extras", label: "Click through the app's menus", kind: "toggle", products: ["webapp", "saas", "crm"], normal: "As the owner set it" },
  { id: "extras.mail", section: "extras", label: "Test mailbox in journeys", kind: "toggle", products: WEB, normal: "As the owner set it" },
  { id: "extras.webhooks", section: "extras", label: "Webhook inbox in journeys", kind: "toggle", products: WEB, normal: "As the owner set it" },
  { id: "extras.roles", section: "extras", label: "Test as the other accounts too", kind: "toggle", products: [...WEB, "api"], normal: "On when the project has them" },
  { id: "extras.scenarios", section: "extras", label: "API scenarios", kind: "toggle", products: ["api"], normal: "On" },
  { id: "extras.appJourneys", section: "extras", label: "App journeys on the test phone", kind: "toggle", products: ["android", "ios"], normal: "On" },
  { id: "extras.ai", section: "extras", label: "Claude summary", kind: "toggle", products: ALL, normal: "As the owner set it" },
  // api
  { id: "apiTimeout", section: "api", label: "Time a call has to answer", kind: "number", min: 1, max: 300, unit: "s", products: ["api"], normal: "20 s" },
  { id: "apiDelayMs", section: "api", label: "Pause between calls", kind: "number", min: 0, max: 60000, unit: "ms", products: ["api"], normal: "0", hint: "Stay under the API's rate limit." },
  { id: "apiSamples", section: "api", label: "Calls per read, to time it", kind: "number", min: 1, max: 10, products: ["api"], normal: "5" },
];

/** Ready-made settings. The tester can save their own next to these. */
export interface Preset {
  id: string;
  name: string;
  about: string;
  control: RunControl;
  builtIn?: boolean;
  /** Who saved it (custom presets). */
  by?: string;
  at?: string;
}

export const BUILT_IN_PRESETS: Preset[] = [
  { id: "standard", name: "Standard", about: "The project's normal test, nothing changed.", control: {}, builtIn: true },
  { id: "smoke", name: "Quick smoke test", about: "Start page and one click deep, 5 pages, no extras: about a minute.", builtIn: true, control: { maxPages: 5, maxDepth: 1, checkLinks: false, tabletOn: false, extras: { inspect: false, visual: false, journeys: false, ai: false } } },
  { id: "deep", name: "Deep test (everything)", about: "Every agent on, 500 pages, every link, tablet and phone, all extras.", builtIn: true, control: { maxPages: 500, checkLinks: true, tabletOn: true, phoneOn: true, retries: 2, allAgents: true } },
  { id: "slow-phone", name: "Slow phone on 3G", about: "Fast 3G and a 4× slower CPU, to feel what visitors on cheap phones feel.", builtIn: true, control: { network: "fast3g", cpuSlowdown: 4, pageTimeout: 90, parallel: 2 } },
  { id: "a11y", name: "Accessibility only", about: "Only accessibility checks, with reduced motion and the tablet pass.", builtIn: true, control: { categories: ["accessibility"], tabletOn: true } },
  { id: "security", name: "Security only", about: "Only security checks (load and attack tools still need the client's permission).", builtIn: true, control: { categories: ["security"] } },
  { id: "seo", name: "SEO only", about: "Only search engine checks, every link checked.", builtIn: true, control: { categories: ["seo"], checkLinks: true } },
  { id: "gentle", name: "Gentle on the server", about: "One page at a time with a 2 second pause: for small or shared hosting.", builtIn: true, control: { parallel: 1, delayMs: 2000, retries: 3, apiDelayMs: 500 } },
  { id: "india", name: "Visitor in India", about: "Hindi browser, India time zone, Slow 4G.", builtIn: true, control: { locale: "hi-IN", timezone: "Asia/Kolkata", network: "slow4g" } },
  { id: "ci-gate", name: "Release gate", about: "Fails the test below 80, or with any critical or new issue.", builtIn: true, control: { gate: { minScore: 80, maxCritical: 0, maxNew: 0 } } },
];

const EXTRAS: ExtraId[] = ["inspect", "visual", "journeys", "explorer", "mail", "webhooks", "roles", "ai", "scenarios", "appJourneys"];

const num = (v: unknown, min: number, max: number): number | undefined => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ControlError(`"${String(v)}" is not a number.`);
  return Math.max(min, Math.min(max, Math.round(n)));
};
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
const text = (v: unknown, max = 300): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/[\r\n]+/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};
const list = (v: unknown, max = 50): string[] | undefined => {
  const items = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [])
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .map((x) => x.slice(0, 500));
  return items.length ? [...new Set(items)].slice(0, max) : undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (allowed.includes(v as T) ? (v as T) : undefined);
const size = (v: unknown, minW: number, maxW: number): Size | undefined => {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const width = num(o.width, minW, maxW);
  const height = num(o.height, 200, 4000);
  return width && height ? { width, height } : undefined;
};

export class ControlError extends Error {}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Headers the browser sets itself, or that would change who the test is. */
const LOCKED_HEADERS = /^(host|content-length|connection|transfer-encoding|upgrade|cookie|authorization)$/i;

function headers(v: unknown): Record<string, string> | undefined {
  const lines = typeof v === "string" ? v.split(/\r?\n/) : v && typeof v === "object" ? Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`) : [];
  const out: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/[\r\n]/g, "");
    if (!HEADER_NAME.test(name)) throw new ControlError(`"${name}" is not a header name.`);
    if (LOCKED_HEADERS.test(name)) throw new ControlError(`The ${name} header cannot be set here: use the project's saved login instead.`);
    out[name] = value.slice(0, 1000);
    if (Object.keys(out).length >= 20) break;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Checks and tidies what the tester sent: numbers kept within their limits, unknown settings dropped. */
export function cleanControl(input: unknown): RunControl {
  if (!input || typeof input !== "object") return {};
  const i = input as Record<string, unknown>;
  const c: RunControl = {};
  const cats = Array.isArray(i.categories) ? (i.categories.filter((x) => CATEGORIES.includes(x as Category)) as Category[]) : undefined;
  if (cats?.length) c.categories = [...new Set(cats)];
  if (i.agents && typeof i.agents === "object") {
    const ids = new Set(ALL_AGENTS.map((a) => a.id));
    const agents = Object.fromEntries(Object.entries(i.agents as Record<string, unknown>).filter(([k, v]) => ids.has(k) && typeof v === "boolean")) as Record<string, boolean>;
    if (Object.keys(agents).length) c.agents = agents;
  }
  if (Array.isArray(i.tools)) {
    c.tools = i.tools
      .filter((t): t is ToolChoice => Boolean(t) && typeof (t as ToolChoice).id === "string")
      .slice(0, 40)
      .map((t) => ({ id: t.id, ...(t.options && typeof t.options === "object" ? { options: Object.fromEntries(Object.entries(t.options).filter(([, v]) => typeof v === "string")) } : {}) }));
  }
  if (i.extras && typeof i.extras === "object") {
    const e = Object.fromEntries(Object.entries(i.extras as Record<string, unknown>).filter(([k, v]) => EXTRAS.includes(k as ExtraId) && typeof v === "boolean"));
    if (Object.keys(e).length) c.extras = e;
  }
  const set = <K extends keyof RunControl>(k: K, v: RunControl[K] | undefined) => {
    if (v !== undefined) c[k] = v;
  };
  if (i.allAgents === true) c.allAgents = true;
  set("maxPages", num(i.maxPages, 1, 1000));
  set("maxDepth", num(i.maxDepth, 0, 20));
  set("include", list(i.include));
  set("exclude", list(i.exclude));
  const extra = list(i.extraUrls, 100)?.filter((u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol);
    } catch {
      throw new ControlError(`"${u}" is not a full address (https://...).`);
    }
  });
  set("extraUrls", extra?.length ? extra : undefined);
  set("checkLinks", bool(i.checkLinks));
  set("parallel", num(i.parallel, 1, 16));
  set("desktop", size(i.desktop, 800, 3840));
  set("tablet", size(i.tablet, 500, 1400));
  set("phone", size(i.phone, 240, 600));
  set("tabletOn", bool(i.tabletOn));
  set("phoneOn", bool(i.phoneOn));
  set("userAgent", text(i.userAgent, 400));
  set("locale", typeof i.locale === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(i.locale) ? i.locale : undefined);
  set("timezone", typeof i.timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(i.timezone) && i.timezone.length < 60 ? i.timezone : undefined);
  set("colorScheme", oneOf(i.colorScheme, ["light", "dark", "no-preference"] as const));
  set("reducedMotion", oneOf(i.reducedMotion, ["reduce", "no-preference"] as const));
  set("javascript", bool(i.javascript));
  set("headers", headers(i.headers));
  set("blockUrls", list(i.blockUrls));
  const net = oneOf(i.network, ["none", "fast4g", "slow4g", "fast3g", "slow3g", "2g"] as const);
  set("network", net && net !== "none" ? net : undefined);
  const cpu = num(i.cpuSlowdown, 1, 20);
  set("cpuSlowdown", cpu && cpu > 1 ? cpu : undefined);
  set("pageTimeout", num(i.pageTimeout, 5, 300));
  set("waitUntil", oneOf(i.waitUntil, ["load", "domcontentloaded", "networkidle", "commit"] as const));
  set("settleMs", num(i.settleMs, 0, 30000));
  set("delayMs", num(i.delayMs, 0, 60000));
  set("retries", num(i.retries, 0, 5));
  set("maxMinutes", num(i.maxMinutes, 1, 600));
  set("stopOnCritical", bool(i.stopOnCritical));
  if (i.gate && typeof i.gate === "object") {
    const g = i.gate as Record<string, unknown>;
    const gate = { minScore: num(g.minScore, 0, 100), maxCritical: num(g.maxCritical, 0, 1000), maxHigh: num(g.maxHigh, 0, 1000), maxNew: num(g.maxNew, 0, 1000) };
    const kept = Object.fromEntries(Object.entries(gate).filter(([, v]) => v !== undefined));
    if (Object.keys(kept).length) c.gate = kept;
  }
  set("apiTimeout", num(i.apiTimeout, 1, 300));
  set("apiDelayMs", num(i.apiDelayMs, 0, 60000));
  set("apiSamples", num(i.apiSamples, 1, 10));
  return c;
}

/** Later layers win: owner settings, then the project's defaults, then this test's choices. */
export function mergeControl(...layers: (RunControl | undefined)[]): RunControl {
  const out: RunControl = {};
  for (const l of layers) {
    if (!l) continue;
    for (const [k, v] of Object.entries(l) as [keyof RunControl, unknown][]) {
      if (v === undefined) continue;
      if ((k === "agents" || k === "extras" || k === "gate") && typeof v === "object") {
        (out as Record<string, unknown>)[k] = { ...((out[k] as object) ?? {}), ...(v as object) };
      } else (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

/** The agent ids a test runs, after the owner's choices and master control. */
export function controlAgents(product: ProductType, owner: Record<string, boolean>, control: RunControl): string[] {
  return ALL_AGENTS.filter((a) => a.products.includes(product))
    .filter((a) => control.agents?.[a.id] ?? (control.allAgents || (owner[a.id] ?? !a.defaultOff)))
    .filter((a) => !control.categories?.length || control.categories.includes(a.category))
    .filter((a) => control.checkLinks !== false || a.id !== "web.links")
    .map((a) => a.id);
}

/** Whether an optional part runs: the owner's switch first, then master control can only turn it off. */
export const extraOn = (control: RunControl | undefined, id: ExtraId, ownerOn = true): boolean => ownerOn && control?.extras?.[id] !== false;

/** Whether a page address may be tested under the include and exclude lists. */
export function addressAllowed(url: string, control: RunControl | undefined): boolean {
  if (!control) return true;
  const hit = (p: string) => (p.includes("*") ? globMatch(p, url) : url.includes(p));
  if (control.exclude?.some(hit)) return false;
  if (control.include?.length && !control.include.some(hit)) return false;
  return true;
}

export function globMatch(pattern: string, s: string): boolean {
  const re = new RegExp(`^${pattern.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  return re.test(s);
}

/** Lines for the report: what master control changed for this test. */
export function describeControl(c: RunControl | undefined): string[] {
  if (!c) return [];
  const out: string[] = [];
  const label = (id: string) => CONTROL_FIELDS.find((f) => f.id === id)?.label ?? id;
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined) continue;
    if (k === "agents") {
      const on = Object.values(v as Record<string, boolean>).filter(Boolean).length;
      const off = Object.values(v as Record<string, boolean>).filter((x) => !x).length;
      out.push(`Agents changed: ${[on && `${on} turned on`, off && `${off} turned off`].filter(Boolean).join(", ")}`);
    } else if (k === "allAgents") out.push("Every agent on, also the ones off by default");
    else if (k === "categories") out.push(`Only: ${(v as string[]).join(", ")} checks`);
    else if (k === "tools") out.push(`Outside tools: ${(v as ToolChoice[]).map((t) => t.id).join(", ") || "none"}`);
    else if (k === "extras") for (const [e, on] of Object.entries(v as Record<string, boolean>)) out.push(`${label(`extras.${e}`)}: ${on ? "on" : "off"}`);
    else if (k === "gate") for (const [g, n] of Object.entries(v as Record<string, number>)) out.push(`${label(`gate.${g}`)}: ${n}`);
    else if (k === "headers") out.push(`Extra headers: ${Object.keys(v as object).join(", ")}`);
    else if (k === "network") out.push(`Network: ${NETWORKS[v as Exclude<NetworkProfile, "none">]?.label ?? v}`);
    else if (typeof v === "object" && v && "width" in v) out.push(`${label(k)}: ${(v as Size).width} × ${(v as Size).height}`);
    else if (Array.isArray(v)) out.push(`${label(k)}: ${v.join(", ")}`);
    else if (typeof v === "boolean") out.push(`${label(k)}: ${v ? "on" : "off"}`);
    else {
      const f = CONTROL_FIELDS.find((x) => x.id === k);
      const shown = f?.choices?.find((x) => x.value === v)?.label ?? String(v);
      out.push(`${label(k)}: ${shown}${f?.unit ? ` ${f.unit}` : ""}`);
    }
  }
  return out;
}

/** Whether the test passed the pass-or-fail rules, and why not. */
export interface Verdict {
  passed: boolean;
  reasons: string[];
}

export function verdictOf(gate: RunControl["gate"], r: { score: number; critical: number; high: number; newIssues: number }): Verdict | undefined {
  if (!gate || !Object.keys(gate).length) return undefined;
  const reasons: string[] = [];
  if (gate.minScore !== undefined && r.score < gate.minScore) reasons.push(`Score ${r.score} is below ${gate.minScore}`);
  if (gate.maxCritical !== undefined && r.critical > gate.maxCritical) reasons.push(`${r.critical} critical problems (at most ${gate.maxCritical} allowed)`);
  if (gate.maxHigh !== undefined && r.high > gate.maxHigh) reasons.push(`${r.high} high problems (at most ${gate.maxHigh} allowed)`);
  if (gate.maxNew !== undefined && r.newIssues > gate.maxNew) reasons.push(`${r.newIssues} new issues (at most ${gate.maxNew} allowed)`);
  return { passed: !reasons.length, reasons };
}

export function newPreset(name: unknown, about: unknown, control: unknown, by?: string): Preset {
  const n = text(name, 60);
  if (!n) throw new ControlError("Give the preset a name.");
  return { id: randomUUID(), name: n, about: text(about, 200) ?? "", control: cleanControl(control), by, at: new Date().toISOString() };
}

// ---- Live controls: pause, resume, skip and finish now --------------------------------------

export type LiveAction = "pause" | "resume" | "skip" | "finish";

export interface GateState {
  paused: boolean;
  pausedBy?: string;
  /** Set when the test was asked to finish early (by the tester, the time limit or a critical problem). */
  finishing?: string;
  skipped: number;
}

/** What the tester controls while a test runs. Engines wait at their safe points while it is paused. */
export class RunGate {
  private paused = false;
  private pausedBy?: string;
  private finishWhy?: string;
  private waiters: (() => void)[] = [];
  /** Screens (slots) whose page should be skipped at its next step; -1 means every open page. */
  private skips = new Set<number>();
  private skipped = 0;
  private deadline?: number;
  private changed?: (s: GateState) => void;
  /** Time spent paused does not count against the time limit. */
  private pausedAt?: number;

  constructor(opts: { maxMinutes?: number; onChange?: (s: GateState) => void } = {}) {
    if (opts.maxMinutes) this.deadline = Date.now() + opts.maxMinutes * 60_000;
    this.changed = opts.onChange;
  }

  state(): GateState {
    return { paused: this.paused, ...(this.pausedBy ? { pausedBy: this.pausedBy } : {}), ...(this.finishWhy ? { finishing: this.finishWhy } : {}), skipped: this.skipped };
  }

  pause(by?: string): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedBy = by;
    this.pausedAt = Date.now();
    this.changed?.(this.state());
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pausedBy = undefined;
    if (this.deadline && this.pausedAt) this.deadline += Date.now() - this.pausedAt;
    this.pausedAt = undefined;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
    this.changed?.(this.state());
  }

  /** Skips the page on one screen, or every open page. */
  skip(slot?: number): void {
    // A new "skip all" applies to every page open now, also on screens that skipped before.
    if (slot === undefined) this.allTaken.clear();
    this.skips.add(slot ?? -1);
    this.changed?.(this.state());
  }

  /** True once for each skip asked for this screen. */
  takeSkip(slot: number): boolean {
    if (this.skips.delete(slot) || (this.skips.has(-1) && this.takeAll(slot))) {
      this.skipped++;
      this.changed?.(this.state());
      return true;
    }
    return false;
  }

  private allTaken = new Set<number>();
  /** A skip of every open page skips each screen's page once. */
  private takeAll(slot: number): boolean {
    if (this.allTaken.has(slot)) return false;
    this.allTaken.add(slot);
    return true;
  }

  /** A new page on the screen: a skip-all asked before it does not apply to it. */
  pageStarted(slot: number): void {
    if (this.skips.has(-1)) this.allTaken.add(slot);
  }

  /** Every screen moved on: the skip of all open pages is done. */
  clearSkipAll(): void {
    this.skips.delete(-1);
    this.allTaken.clear();
  }

  finish(why: string): void {
    if (this.finishWhy) return;
    this.finishWhy = why;
    if (this.paused) this.resume();
    else this.changed?.(this.state());
  }

  /** Stop starting new work: asked to finish, or past the time limit. */
  finishing(): string | undefined {
    if (!this.finishWhy && this.deadline && !this.paused && Date.now() > this.deadline) this.finish("The time limit in master control was reached");
    return this.finishWhy;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /** Waits here while the test is paused. Rejects when the test is cancelled. */
  async wait(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal!.reason);
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }
}

/** The running test's control and gate, for engines that do not get them passed down (API calls). */
const scope = new AsyncLocalStorage<{ control: RunControl; gate?: RunGate }>();
export const controlScope = {
  run<T>(value: { control: RunControl; gate?: RunGate }, fn: () => Promise<T>): Promise<T> {
    return scope.run(value, fn);
  },
  get(): { control: RunControl; gate?: RunGate } | undefined {
    return scope.getStore();
  },
};

/** Which live controls a product's test answers to. */
export function liveActionsFor(product: ProductType): LiveAction[] {
  if (WEB.includes(product)) return ["pause", "resume", "skip", "finish"];
  if (product === "api") return ["pause", "resume"];
  return [];
}
