import path from "node:path";
import { firefox, webkit, type Browser, type BrowserContext, type BrowserType } from "playwright";
import { NotTestedError } from "../../runner/coverage.js";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, PageResult } from "../../types.js";
import type { SiteAgent } from "../types.js";
import { readOnly } from "./guard.js";

/**
 * The cross-browser lab: the same pages in Firefox and in WebKit (the engine of Safari on Mac and
 * of every browser on iPhone), next to a clean Chromium, all at the same window size. Anything only
 * one browser shows (script errors, failed files, missing parts of the page, sideways scrolling)
 * is a problem visitors on that browser have.
 */

const list = (items: string[], max = 6) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const VIEW = { width: 1366, height: 900 };

/** What one browser saw on one page. */
export interface BrowserView {
  status: number;
  error?: string;
  errors: string[];
  failed: string[];
  overflow: number;
  /** Visible elements of each kind: images, buttons, links, form fields, headings, videos. */
  counts: Record<string, number>;
}

/** Counts what is visible on the page, and how far it scrolls sideways (also run in real Safari by the Mac helper). */
export const VIEW_JS = `(function () {
  var kinds = { images: "img, picture, svg[role=img]", buttons: "button, [role=button], input[type=submit]", links: "a[href]", fields: "input:not([type=hidden]), select, textarea", headings: "h1, h2, h3", videos: "video, iframe" };
  var counts = {};
  for (var k in kinds) {
    var els = document.querySelectorAll(kinds[k]), n = 0;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2 && getComputedStyle(els[i]).visibility !== "hidden") n++;
    }
    counts[k] = n;
  }
  return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, counts: counts };
})()`;

const LABELS: Record<string, string> = { images: "images", buttons: "buttons", links: "links", fields: "form fields", headings: "headings", videos: "videos and frames" };

/** Compares a browser's view of a page with Chromium's. Messages differ between browsers, so errors are compared by count. */
export function compareViews(name: string, url: string, base: BrowserView, other: BrowserView): Finding[] {
  const out: Finding[] = [];
  if (other.error || (other.status >= 400 && base.status < 400)) {
    out.push(
      finding({
        category: "functional",
        rule: "browser:page-fails",
        severity: "high",
        title: `The page does not open in ${name}`,
        detail: `Chromium opens it (HTTP ${base.status}), but ${name} ${other.error ? `stops with: ${other.error}` : `gets HTTP ${other.status}`}. Check for browser detection on the server, and test the page in ${name}.`,
        pageUrl: url,
      }),
    );
    return out;
  }
  if (other.errors.length > base.errors.length) {
    out.push(
      finding({
        category: "functional",
        rule: "browser:js-error",
        severity: "high",
        title: `${other.errors.length - base.errors.length} script error${other.errors.length - base.errors.length === 1 ? "" : "s"} only in ${name}`,
        detail: `The page stops with script errors in ${name} that Chromium does not have (${base.errors.length} there), so menus, forms or buttons may not work for its visitors. The usual causes are JavaScript features or browser APIs ${name} does not have yet: check each one on caniuse.com, or let Babel and core-js add them.`,
        pageUrl: url,
        evidence: list([...new Set(other.errors)]),
      }),
    );
  }
  const failed = other.failed.filter((f) => !base.failed.includes(f));
  if (failed.length) {
    out.push(
      finding({
        category: "functional",
        rule: "browser:file-fails",
        severity: "medium",
        title: `${failed.length} file${failed.length === 1 ? " fails" : "s fail"} to load only in ${name}`,
        detail: `${name} cannot load these files while Chromium can: often an image or font format, or a security setting, that ${name} handles differently.`,
        pageUrl: url,
        evidence: list(failed),
      }),
    );
  }
  if (other.overflow > 5 && base.overflow <= 5) {
    out.push(
      finding({
        category: "functional",
        rule: "browser:sideways",
        severity: "medium",
        title: `The page scrolls sideways only in ${name}`,
        detail: `At the same window size (${VIEW.width} px) the page is ${other.overflow} px too wide in ${name} and fits in Chromium. Look for CSS that ${name} reads differently, such as gap in flexbox on older Safari, or fixed widths.`,
        pageUrl: url,
      }),
    );
  }
  const missing: string[] = [];
  for (const k of Object.keys(base.counts)) {
    const a = base.counts[k];
    const b = other.counts[k] ?? 0;
    if (a - b >= 3 && b < a * 0.8) missing.push(`${LABELS[k] ?? k}: ${b} in ${name}, ${a} in Chromium`);
  }
  if (missing.length) {
    out.push(
      finding({
        category: "functional",
        rule: "browser:missing-parts",
        severity: "medium",
        title: `Parts of the page are missing in ${name}`,
        detail: `${name} shows fewer elements than Chromium at the same size. A script that failed, or CSS that ${name} does not support, usually hides them. Compare the saved screenshots.`,
        pageUrl: url,
        evidence: list(missing),
      }),
    );
  }
  return out;
}

async function look(context: BrowserContext, url: string, shot?: string): Promise<BrowserView> {
  const page = await context.newPage();
  const guard = await readOnly(page, { loggedIn: true });
  const errors: string[] = [];
  const failed: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message.split("\n")[0].slice(0, 200)));
  page.on("requestfailed", (r) => failed.push(r.url()));
  // Requests the guard stopped (anything but GET, log-out links) fail in every browser alike.
  const real = () => {
    const stopped = new Set(guard.blocked.map((b) => b.slice(b.indexOf(" ") + 1)));
    return [...new Set(failed.filter((u) => !stopped.has(u)))].map((u) => u.slice(0, 160));
  };
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForTimeout(800);
    const v = (await page.evaluate(VIEW_JS)) as Pick<BrowserView, "overflow" | "counts">;
    if (shot) await page.screenshot({ path: shot, type: "jpeg", quality: 55 }).catch(() => {});
    return { status: res?.status() ?? 0, errors, failed: real(), ...v };
  } catch (err) {
    return { status: 0, error: (err as Error).message.split("\n")[0], errors, failed: real(), overflow: 0, counts: {} };
  } finally {
    await guard.off();
    await page.close().catch(() => {});
  }
}

const proxy = () => {
  const server = process.env.HTTPS_PROXY || process.env.https_proxy;
  return server ? { proxy: { server, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {};
};

/** Builds the lab for a set of browsers (tests pass their own). */
export function browserLab(engines: { name: string; slug: string; type: BrowserType }[]): SiteAgent {
  return {
    id: "func.browsers",
    name: "Cross-browser lab",
    description:
      "Opens up to 5 pages in Firefox and in WebKit (the engine of Safari and of every iPhone browser) next to Chromium, and reports script errors, failed files, missing parts and sideways scrolling that only one browser has. Saves a screenshot of the first pages in each browser.",
    category: "functional",
    engine: "web",
    products: WEB_PRODUCTS,
    stage: "site",
    runsLast: "signed-in",
    async run({ browser, pages, site, artifactsDir }) {
      const sample = pages.filter((p) => !p.error && (p.status ?? 0) < 400).slice(0, 5);
      if (!sample.length) return [];
      // Signed in, the other browsers get a copy of the session, so they see the same pages.
      const state = site.loggedIn ? await browser.storageState() : undefined;
      const own = browser.browser();
      if (!own) throw new NotTestedError("The test browser runs without a browser process to open a clean Chromium window from.");
      // A clean Chromium window (no cache from the crawl), so every browser starts the same way.
      const base = await own.newContext({ viewport: VIEW, storageState: state });
      const baseline = new Map<string, BrowserView>();
      const missing: string[] = [];
      const found = new Map<string, Finding[]>();
      // Start the other browsers first: when none is installed there is nothing to compare with.
      const launched = await Promise.all(
        engines.map((e) =>
          e.type.launch(proxy()).then(
            (b) => ({ e, b }),
            () => {
              missing.push(e.name);
              return null;
            },
          ),
        ),
      );
      const ready = launched.filter((l): l is { e: (typeof engines)[number]; b: Browser } => Boolean(l));
      try {
        if (ready.length) {
          for (const [n, p] of sample.entries()) {
            const file = n < 2 ? `browser-chromium-${n}.jpg` : undefined;
            const view = await look(base, p.url, file ? path.join(artifactsDir, file) : undefined);
            if (file && !view.error) addFile(p, "Chromium screenshot", file);
            baseline.set(p.url, view);
          }
        }
        // Firefox and WebKit check the pages at the same time.
        await Promise.all(
          ready.map(async ({ e, b: other }) => {
            const mine: Finding[] = [];
            found.set(e.slug, mine);
            try {
              const context = await other.newContext({ viewport: VIEW, storageState: state });
              for (const [n, p] of sample.entries()) {
                const file = n < 2 ? `browser-${e.slug}-${n}.jpg` : undefined;
                const view = await look(context, p.url, file ? path.join(artifactsDir, file) : undefined);
                if (file && !view.error) addFile(p, `${e.name} screenshot`, file);
                mine.push(...compareViews(e.name, p.url, baseline.get(p.url)!, view));
              }
            } finally {
              await other.close().catch(() => {});
            }
          }),
        );
      } finally {
        await base.close().catch(() => {});
        await Promise.all(ready.map(({ b }) => b.close().catch(() => {})));
      }
      // Browsers in the order they are listed, whichever finished first.
      const out = engines.flatMap((e) => found.get(e.slug) ?? []);
      if (missing.length) {
        const absent = engines.filter((e) => missing.includes(e.name));
        throw new NotTestedError(
          `${absent.map((e) => e.name).join(" and ")} ${absent.length === 1 ? "is" : "are"} not installed on this server. The Docker image includes them; outside Docker, run: npx playwright install ${absent
            .map((e) => e.type.name())
            .join(" ")}`,
          out,
        );
      }
      return out;
    },
  };
}

function addFile(p: PageResult, label: string, file: string): void {
  p.files = [...(p.files ?? []).filter((f) => f.file !== file), { label, file }];
}

export const browserLabAgent = browserLab([
  { name: "Firefox", slug: "firefox", type: firefox },
  { name: "Safari's engine (WebKit)", slug: "webkit", type: webkit },
]);
