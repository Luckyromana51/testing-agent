import { chromium, devices as pwDevices } from "playwright";
import type { Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 4 — device/browser classes that were deferred for want of a Windows box or an emulator,
 * now built to run on a free self-hosted target or on bundled Playwright device profiles. All
 * in-house, read-only.
 *
 *  - windows-browser: drives real Edge/IE-mode on a self-hosted Windows evaluation VM through the
 *    W3C WebDriver HTTP protocol (plain fetch, no extra dependency). Operator stands up a free
 *    Windows eval VM + msedgedriver. Checks the page renders and the brand fonts are available.
 *  - device-matrix: runs the start page through Wear/TV/Auto/kiosk/POS/IoT viewport+UA profiles in
 *    bundled Chromium — layout fits, tap/focus targets big enough, keyboard/remote focus visible.
 *  - game-test: loads an HTML5/canvas/WebGL game and measures frame rate, WebGL health and JS errors.
 */

// ---------------------------------------------------------------------------
// Windows-only browsers & fonts (W3C WebDriver over HTTP)
// ---------------------------------------------------------------------------

/** Judges which brand fonts are missing on the Windows box. Pure, for tests. */
export function fontProblems(available: Record<string, boolean>): { rule: string; severity: Severity; title: string; detail: string }[] {
  const missing = Object.entries(available).filter(([, ok]) => !ok).map(([f]) => f);
  if (!missing.length) return [];
  return [{ rule: "winfont:missing", severity: "low", title: `Font not available on Windows: ${missing.join(", ")}`, detail: `These fonts the site asks for are not installed on Windows, so Windows users see a fallback that can shift the layout. Self-host the font as a @font-face web font (woff2) instead of relying on it being installed.` }];
}

interface WdResult {
  title: string;
  bodyWidth: number;
  viewportWidth: number;
  fonts: Record<string, boolean>;
  consoleErrors: number;
}

/** Minimal W3C WebDriver client over fetch — no selenium dependency. */
async function wd(base: string, signal: AbortSignal) {
  const b = base.replace(/\/$/, "");
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${b}${path}`, { method, signal, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = (await res.json().catch(() => ({}))) as { value?: unknown };
    if (!res.ok) throw new Error(`WebDriver ${path} failed (${res.status})`);
    return json.value as Record<string, unknown>;
  };
  const session = (await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "MicrosoftEdge" } } })) as { sessionId?: string };
  const id = session.sessionId ?? (session as Record<string, unknown>).sessionId;
  return {
    id: id as string,
    go: (url: string) => call("POST", `/session/${id}/url`, { url }),
    exec: async (script: string) => (await call("POST", `/session/${id}/execute/sync`, { script, args: [] })) as unknown,
    quit: () => call("DELETE", `/session/${id}`).catch(() => undefined),
  };
}

export const windowsBrowserTool: Tool = {
  id: "windows-browser",
  name: "Windows browsers & fonts",
  maker: "GLV Infotech (built in), W3C WebDriver on a self-hosted Windows VM",
  description:
    "Opens the site in real Edge on a self-hosted Windows evaluation VM (free from Microsoft) and checks it renders and that the fonts the site asks for are actually installed on Windows. Talks the W3C WebDriver HTTP protocol directly, so nothing paid is needed — the operator runs a free Windows eval VM with msedgedriver and points this at it.",
  checks: ["Loads the page in Edge on Windows", "Checks the layout is not broken", "Checks requested fonts are installed on Windows"],
  products: ["website", "ecommerce", "webapp", "saas", "crm"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "about a minute",
  licence: "GLV's own",
  homepage: "https://developer.microsoft.com/microsoft-edge/tools/webdriver/",
  signedIn: "public",
  options: [
    { id: "webdriver", label: "WebDriver URL on the Windows VM", kind: "text", required: true, pattern: "^https?://.+", placeholder: "http://win-vm.glv.internal:9515", hint: "msedgedriver/geckodriver running on a free Windows eval VM.", choices: [], default: "" },
    { id: "fonts", label: "Fonts the site needs (comma-separated)", kind: "text", placeholder: "Inter, Segoe UI, Calibri", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const base = (ctx.options.webdriver ?? "").trim();
    if (!base) throw new Error("Set the WebDriver URL on the Windows VM.");
    const url = ctx.startUrl || ctx.urls[0];
    const fonts = (ctx.options.fonts ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    let session: Awaited<ReturnType<typeof wd>> | undefined;
    let data: WdResult;
    try {
      session = await wd(base, ctx.signal);
      await session.go(url);
      // Font availability by WIDTH MEASUREMENT (document.fonts.check returns true even for absent fonts
      // in several engines): a font is present only if its text width differs from every generic fallback.
      const script = `return (function(){var fonts=${JSON.stringify(fonts)};var avail={};var c=document.createElement('canvas').getContext('2d');var s='mmmmmwwwwwiiiii0123 AaBbGg';var bases=['monospace','serif','sans-serif'];var baseW={};for(var b=0;b<bases.length;b++){c.font='72px '+bases[b];baseW[bases[b]]=c.measureText(s).width;}for(var i=0;i<fonts.length;i++){try{var present=false;for(var b2=0;b2<bases.length;b2++){c.font='72px \\''+fonts[i]+'\\','+bases[b2];if(Math.abs(c.measureText(s).width-baseW[bases[b2]])>0.5){present=true;break;}}avail[fonts[i]]=present;}catch(e){avail[fonts[i]]=true;}}return {title:document.title,bodyWidth:document.documentElement.scrollWidth,viewportWidth:window.innerWidth,fonts:avail};})();`;
      data = ((await session.exec(script)) as WdResult) ?? { title: "", bodyWidth: 0, viewportWidth: 0, fonts: {}, consoleErrors: 0 };
    } catch (e) {
      throw new Error(`Could not drive Edge on the Windows VM: ${(e as Error).message}. Check the WebDriver URL and that msedgedriver is running.`);
    } finally {
      await session?.quit();
    }
    const findings: ToolFinding[] = [];
    if (data.bodyWidth > data.viewportWidth * 1.05)
      findings.push({ category: "functional", rule: "winbrowser:overflow", severity: "medium", title: "Layout overflows horizontally on Windows Edge", detail: `On Edge/Windows the page content is ${Math.round(data.bodyWidth)}px wide in a ${Math.round(data.viewportWidth)}px window, so there is a horizontal scrollbar. Check Windows-specific scrollbar width and font fallback.`, pageUrl: url, key: "winbrowser:overflow" });
    for (const p of fontProblems(data.fonts)) findings.push({ category: "functional", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, key: `${p.rule}` });
    ctx.log(`Windows browser: title "${data.title}", ${findings.length} issue(s)`);
    return { findings, summary: [`Edge/Windows: "${data.title}"`, `${fonts.length} font(s) checked`], tested: url };
  },
};

// ---------------------------------------------------------------------------
// Wear / TV / Auto / kiosk / POS / IoT device profiles
// ---------------------------------------------------------------------------

export interface DeviceProfile {
  key: string;
  label: string;
  width: number;
  height: number;
  ua: string;
  remote: boolean; // navigated by a remote/D-pad (TV, Auto) rather than touch
}

/** The built-in device profiles. Pure, for tests. */
export function deviceProfiles(): DeviceProfile[] {
  return [
    { key: "wear", label: "Wear OS watch", width: 320, height: 320, ua: "Mozilla/5.0 (Linux; Android 11; Wear OS) AppleWebKit/537.36 Chrome/120 Mobile", remote: false },
    { key: "androidtv", label: "Android TV", width: 1920, height: 1080, ua: "Mozilla/5.0 (Linux; Android 12; BRAVIA) AppleWebKit/537.36 Chrome/120 TV Safari/537.36", remote: true },
    { key: "auto", label: "Android Auto", width: 800, height: 480, ua: "Mozilla/5.0 (Linux; Android 12; Automotive) AppleWebKit/537.36 Chrome/120", remote: true },
    { key: "kiosk", label: "Kiosk / POS screen", width: 1280, height: 1024, ua: "Mozilla/5.0 (X11; Linux) AppleWebKit/537.36 Chrome/120 Kiosk", remote: false },
    { key: "iot", label: "IoT dashboard panel", width: 480, height: 320, ua: "Mozilla/5.0 (Linux; IoT) AppleWebKit/537.36 Chrome/120", remote: false },
  ];
}

export interface DeviceMetrics {
  scrollWidth: number;
  viewportWidth: number;
  smallTargets: number;
  focusVisible: boolean;
}

/** Judges a device profile's measurements. Pure, for tests. */
export function profileProblems(p: DeviceProfile, m: DeviceMetrics): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (m.scrollWidth > m.viewportWidth * 1.05)
    out.push({ rule: "screen:overflow", severity: "medium", title: `Content overflows on ${p.label}`, detail: `On a ${p.label} (${p.width}×${p.height}) the content is ${Math.round(m.scrollWidth)}px wide in a ${p.width}px screen, so it scrolls sideways. Use a responsive layout that fits this width.` });
  if (m.smallTargets > 0)
    out.push({ rule: "screen:tiny-target", severity: "low", title: `${m.smallTargets} tap target(s) too small on ${p.label}`, detail: `On a ${p.label}, ${m.smallTargets} button/link is under 44px, hard to hit on this screen. Make primary controls at least 44×44px (48×48 on TV/Auto).` });
  if (p.remote && !m.focusVisible)
    out.push({ rule: "screen:no-focus", severity: "medium", title: `No visible focus ring on ${p.label}`, detail: `${p.label} is driven by a remote/D-pad, but focused elements show no visible focus style, so the user cannot tell what is selected. Add a clear :focus-visible outline.` });
  return out;
}

export const deviceMatrixTool: Tool = {
  id: "device-matrix",
  name: "Wear / TV / Auto / kiosk / IoT",
  maker: "GLV Infotech (built in), on bundled Chromium device profiles",
  description:
    "Runs the site through watch, Android TV, Android Auto, kiosk/POS and IoT-panel screen profiles in bundled Chromium — no paid device farm. Checks the layout fits each screen, controls are big enough, and (on TV/Auto, which use a remote) that focus is visible. For native Wear/TV apps, stand up the free Android SDK emulators and use the Appium tool; this covers the web/webview side on our own servers.",
  checks: ["Fits watch/TV/Auto/kiosk/IoT screen sizes", "Tap/focus targets large enough", "Visible focus for remote/D-pad navigation (TV, Auto)"],
  products: ["website", "ecommerce", "webapp", "saas", "crm"],
  category: "mobile",
  safety: "safe",
  manual: true,
  takes: "a few minutes",
  licence: "GLV's own",
  homepage: "https://playwright.dev/docs/emulation",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const url = ctx.startUrl || ctx.urls[0];
    if (!url) throw new Error("No page to test.");
    const browser = await chromium.launch();
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    try {
      for (const p of deviceProfiles()) {
        const context = await browser.newContext({ viewport: { width: p.width, height: p.height }, userAgent: p.ua, ...(ctx.cookie ? { extraHTTPHeaders: { cookie: ctx.cookie } } : {}) });
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
          const m = (await page.evaluate(() => {
            const vw = window.innerWidth;
            const controls = Array.from(document.querySelectorAll("a,button,input,select,[role=button]"));
            let small = 0;
            for (const el of controls.slice(0, 400)) {
              const r = (el as HTMLElement).getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44)) small++;
            }
            const first = controls[0] as HTMLElement | undefined;
            let focusVisible = true;
            if (first) {
              first.focus();
              const cs = getComputedStyle(first);
              focusVisible = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
            }
            return { scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, smallTargets: small, focusVisible };
          })) as DeviceMetrics;
          const probs = profileProblems(p, m);
          rows.push([p.label, probs.length ? `${probs.length} issue(s)` : "ok"]);
          for (const pr of probs) findings.push({ category: "mobile", rule: pr.rule, severity: pr.severity, title: pr.title, detail: pr.detail, pageUrl: url, key: `${pr.rule}:${p.key}` });
        } catch {
          rows.push([p.label, "could not load"]);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
    ctx.log(`Device matrix: ${rows.length} profile(s), ${findings.length} issue(s)`);
    return { findings, summary: [`${rows.length} device profiles checked`], table: { title: "Device profiles", columns: ["Device", "Result"], rows }, tested: `${rows.length} device profiles` };
  },
};

// ---------------------------------------------------------------------------
// Games (HTML5 / canvas / WebGL)
// ---------------------------------------------------------------------------

/** Judges a measured frame rate. Pure, for tests. */
export function fpsProblem(fps: number): { rule: string; severity: Severity; title: string; detail: string } | null {
  if (fps <= 0) return null;
  if (fps < 24) return { rule: "game:low-fps", severity: "medium", title: `Low frame rate (~${Math.round(fps)} fps)`, detail: `The page rendered at about ${Math.round(fps)} frames per second while the game was on screen, below 24 fps, so it looks choppy. Profile the render loop, cut per-frame allocations and draw calls, and use requestAnimationFrame.` };
  return null;
}

export interface GameMetrics {
  hasCanvas: boolean;
  fps: number;
  webglLost: boolean;
  jsErrors: number;
}

/** Judges a game's runtime metrics. Pure, for tests. */
export function gameProblems(m: GameMetrics): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (!m.hasCanvas) out.push({ rule: "game:no-canvas", severity: "low", title: "No game canvas found", detail: "No <canvas> was detected on the page, so this does not look like a canvas/WebGL game. If the game loads later, point the tool at the page after it starts." });
  const fp = fpsProblem(m.fps);
  if (fp) out.push(fp);
  if (m.webglLost) out.push({ rule: "game:webgl-lost", severity: "high", title: "WebGL context was lost", detail: "The WebGL context was reported lost, which blanks or freezes the game. Handle the webglcontextlost/restored events and recreate GPU resources, and reduce memory pressure." });
  if (m.jsErrors > 0) out.push({ rule: "game:js-errors", severity: "medium", title: `${m.jsErrors} JavaScript error(s) during play`, detail: `${m.jsErrors} error(s) were thrown while the game ran, which can break input or rendering. Open the console and fix the first error.` });
  return out;
}

export const gameTestTool: Tool = {
  id: "game-test",
  name: "HTML5 game check",
  maker: "GLV Infotech (built in), on bundled Chromium",
  description:
    "Loads an HTML5 / canvas / WebGL game in bundled Chromium and measures how it actually runs: frame rate over a few seconds, whether the WebGL context stays healthy, and whether it throws errors while a few keypresses are sent. For browser-based games — a free, in-house smoke test, not a full game-QA suite.",
  checks: ["Measures canvas frame rate", "Checks WebGL context health", "Catches JavaScript errors during play"],
  products: ["website", "webapp"],
  category: "performance",
  safety: "safe",
  manual: true,
  takes: "about a minute",
  licence: "GLV's own",
  homepage: "https://developer.mozilla.org/docs/Games",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const url = ctx.startUrl || ctx.urls[0];
    if (!url) throw new Error("No game page to test.");
    const browser = await chromium.launch();
    let m: GameMetrics = { hasCanvas: false, fps: 0, webglLost: false, jsErrors: 0 };
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      let jsErrors = 0;
      page.on("pageerror", () => jsErrors++);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.keyboard.press("ArrowRight").catch(() => {});
      await page.keyboard.press("Space").catch(() => {});
      const measured = (await page.evaluate(async () => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement | null;
        const hasCanvas = !!canvas;
        // Do NOT call getContext() on the game's own canvas — grabbing a "webgl" context would make the
        // game's later getContext("2d") return null and break the game. Listen for a loss event instead.
        let webglLost = false;
        if (canvas) canvas.addEventListener("webglcontextlost", () => (webglLost = true), { once: true });
        let frames = 0;
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const tick = () => {
            frames++;
            if (performance.now() - start >= 2000) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const fps = (frames / (performance.now() - start)) * 1000;
        return { hasCanvas, fps, webglLost };
      })) as { hasCanvas: boolean; fps: number; webglLost: boolean };
      m = { ...measured, jsErrors };
      await context.close();
    } finally {
      await browser.close();
    }
    const findings: ToolFinding[] = gameProblems(m).map((p) => ({ category: p.rule === "game:low-fps" ? "performance" : "functional", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, key: p.rule }));
    ctx.log(`Game: canvas=${m.hasCanvas}, ~${Math.round(m.fps)}fps, ${findings.length} issue(s)`);
    return { findings, summary: [m.hasCanvas ? `Canvas game, ~${Math.round(m.fps)} fps` : "No canvas found", `${m.jsErrors} JS error(s)`], tested: url };
  },
};
