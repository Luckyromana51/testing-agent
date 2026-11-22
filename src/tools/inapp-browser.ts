import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { WEB_PRODUCTS } from "../products.js";
import type { Tool, ToolContext, ToolFinding, ToolImage, ToolOutput } from "./types.js";

/**
 * Browsers big in India and in-app webviews: many visitors open links inside WhatsApp, Instagram or
 * Facebook (an in-app webview), or use Samsung Internet, Opera or UC Browser, which behave differently
 * from Chrome — pop-ups (window.open) often do nothing, downloads can fail, and some sites block or
 * warn in-app browsers. GLV opens the pages with each one's user-agent and reports script errors,
 * blank pages, pages that block the in-app browser, and logins that rely on a pop-up. It only reads.
 */

export const IN_APP_BROWSERS: { id: string; label: string; ua: string; webview: boolean }[] = [
  { id: "whatsapp", label: "WhatsApp in-app (Android)", ua: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;WhatsApp]", webview: true },
  { id: "instagram", label: "Instagram in-app", ua: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 300.0.0.0 Android", webview: true },
  { id: "facebook", label: "Facebook in-app (FB_IAB)", ua: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.0;]", webview: true },
  { id: "samsung", label: "Samsung Internet", ua: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36", webview: false },
  { id: "opera", label: "Opera Mobile", ua: "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 OPR/78.0.0.0", webview: false },
  { id: "uc", label: "UC Browser", ua: "Mozilla/5.0 (Linux; U; Android 13; en-US; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.0.0 UCBrowser/15.5.0.1395 Mobile Safari/537.36", webview: false },
];

/** Whether a page's login relies on a pop-up (fails in in-app webviews). Pure, for tests. */
export function popupLoginRisk(html: string): boolean {
  const hasPopupOpen = /window\.open\s*\(/.test(html);
  const hasSocialLogin = /(sign in|log in|continue) with (google|facebook|apple)|gsi\/client|accounts\.google\.com\/gsi|data-onsuccess/i.test(html);
  return hasPopupOpen || hasSocialLogin;
}

/** Whether the page tells the visitor to open it in a real browser. Pure, for tests. */
export function blocksInApp(text: string): boolean {
  return /open (this|in) (your )?(default |external )?browser|not supported in this browser|please open in chrome|unsupported browser/i.test(text);
}

export const inAppBrowserTool: Tool = {
  id: "inapp-browser",
  name: "In-app and India browsers",
  maker: "GLV Infotech (built in)",
  description:
    "Opens the site as it is seen inside WhatsApp, Instagram and Facebook (in-app webviews) and in Samsung Internet, Opera and UC Browser, which are common in India. Reports script errors, blank pages, pages that block the in-app browser, and logins that need a pop-up (which in-app webviews often cannot open).",
  checks: ["WhatsApp / Instagram / Facebook in-app webviews", "Samsung Internet, Opera, UC Browser", "Pop-up or social logins that fail in in-app browsers", "Pages that block or warn in-app browsers; script errors and blank pages"],
  products: WEB_PRODUCTS,
  category: "functional",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://developer.chrome.com/docs/multidevice/user-agent",
  signedIn: "public",
  options: [{ id: "browsers", label: "Browsers", kind: "toggles", choices: IN_APP_BROWSERS.map((b) => ({ value: b.id, label: b.label })), default: IN_APP_BROWSERS.map((b) => b.id).join(",") }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const picked = new Set((ctx.options.browsers ?? "").split(",").filter(Boolean));
    const browsers = IN_APP_BROWSERS.filter((b) => picked.size === 0 || picked.has(b.id));
    const pages = [...new Set([ctx.startUrl, ...ctx.urls])].slice(0, 4);
    const findings: ToolFinding[] = [];
    const images: ToolImage[] = [];
    const rows: string[][] = [];
    const browser = await chromium.launch();
    try {
      for (const b of browsers) {
        ctx.signal.throwIfAborted();
        const context = await browser.newContext({ userAgent: b.ua, viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
        try {
          for (const [i, url] of pages.entries()) {
            const page = await context.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e) => errors.push(String(e.message)));
            page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
            let text = "";
            let html = "";
            try {
              await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
              await page.waitForTimeout(800);
              text = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string;
              html = await page.content().catch(() => "");
            } catch (e) {
              rows.push([b.label, url, "did not load", (e as Error).message.slice(0, 50)]);
              await page.close();
              continue;
            }
            const blank = text.trim().length < 50;
            const blocked = blocksInApp(text);
            const real = errors.filter((e) => /SyntaxError|TypeError|ReferenceError|is not a function|is not defined|Unexpected token/i.test(e));
            rows.push([b.label, url.replace(ctx.startUrl, "/") || "/", blank ? "blank" : blocked ? "blocked" : "ok", `${real.length} errors`]);
            if (i === 0) {
              const file = `inapp-${b.id}.png`;
              await page.screenshot({ path: path.join(ctx.outDir, file) }).catch(() => undefined);
              images.push({ file, label: `${b.label}: ${url}` });
            }
            if (blank) findings.push({ category: "functional", rule: "inapp:blank", severity: "high", title: `Blank page in ${b.label}`, detail: `The page shows almost no content in ${b.label}. In-app webviews and these browsers run older or restricted engines; test and provide a working fallback, and compile JavaScript for them.`, pageUrl: url, evidence: `${text.trim().length} characters`, key: `inapp:blank:${b.id}:${url}` });
            if (blocked) findings.push({ category: "functional", rule: "inapp:blocks-webview", severity: "medium", title: `${b.label} is told to open elsewhere`, detail: "The page asks the visitor to open it in another browser. Visitors from WhatsApp/Instagram links may not know how, and leave. Support the in-app webview instead of blocking it.", pageUrl: url, evidence: text.slice(0, 200), key: `inapp:blocked:${b.id}:${url}` });
            if (real.length) findings.push({ category: "functional", rule: "inapp:js-error", severity: "low", title: `Script errors in ${b.label}`, detail: `The page's scripts fail in ${b.label}. Compile and polyfill JavaScript for these engines (a browserslist that includes Samsung and older Chrome webviews).`, pageUrl: url, evidence: real.slice(0, 3).join("\n").slice(0, 500), key: `inapp:js:${b.id}:${url}` });
            if (b.webview && i === 0 && popupLoginRisk(html)) findings.push({ category: "functional", rule: "inapp:popup-login", severity: "medium", title: "Login may rely on a pop-up (fails in in-app browsers)", detail: "The page uses window.open or a social login that opens a pop-up. In-app webviews (WhatsApp, Instagram, Facebook) often block pop-ups, so the login silently fails. Use a full-page redirect flow (OAuth redirect, not pop-up) so it works inside these apps.", pageUrl: url, evidence: b.label, key: `inapp:popup:${url}` });
            await page.close();
          }
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
    }
    return {
      findings,
      images,
      summary: [`${pages.length} pages in ${browsers.length} in-app / India browsers`],
      tested: `${pages.length} pages × ${browsers.length} browsers`,
      table: { title: "In-app and India browsers", columns: ["Browser", "Page", "Result", "Problems"], rows },
    };
  },
};
