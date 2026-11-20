import type { BrowserContext, Page } from "playwright";
import { readOnly } from "../agents/web/guard.js";
import { isUnsafeLink, normaliseUrl } from "../runner/urls.js";
import type { AppScreen } from "../types.js";
import { GENERAL_NAV, type SystemProfile } from "./systems.js";

/**
 * The app explorer: a full system test needs every screen of the signed-in app, and many app
 * screens have no ordinary link (menus drawn by script, buttons that switch screens, dropdowns,
 * tabs). It clicks the app's menu items one by one like a person would, notes every new screen and
 * every tab inside a screen, and goes back. Nothing is saved: requests other than GET are stopped,
 * menu items that look like actions (delete, send, log out...) are never clicked, and links the
 * system is known to use for actions are never opened.
 */

/** Words of menu items the explorer never clicks: they change data or end the session. */
export const DANGER_WORDS =
  /\b(log ?out|sign ?out|log ?off|delete|remove|trash|archive|deactivate|disable|enable|cancel|reject|approve|send|submit|save|pay|refund|reset|clear|empty|purge|import|sync|duplicate|clone|convert|merge|close account|uninstall|install|publish|unpublish|restore|block|ban|suspend|terminate|impersonate|switch (user|account|company)|run now|execute|backup|upgrade|update all)\b/i;

export interface ExploreOptions {
  system?: SystemProfile;
  /** Extra addresses never to open (from the system profile). */
  unsafe?: RegExp;
  log?: (m: string) => void;
  signal?: AbortSignal;
  /** Most menu items clicked in all. */
  maxClicks?: number;
  /** Time budget, in milliseconds. */
  maxMs?: number;
  /** Screens found on the start page that are explored again for their own tabs and sub-menus. */
  deeper?: number;
}

interface Item {
  key: string;
  label: string;
  href?: string;
  tab: boolean;
}

const sameScreen = (a: string, b: string) => normaliseUrl(a) === normaliseUrl(b);

/** The menu items now visible on the page, each marked so it can be clicked again. */
async function menuItems(page: Page, selectors: string[]): Promise<Item[]> {
  return (await page.evaluate(
    `(function (selectors) {
      var out = [], seen = new Set(), n = deepAll("[data-glv-x]").length;
      // Lightning (Salesforce), Zoho's Lyte and other web-component apps draw their menus inside
      // shadow roots, which querySelectorAll does not enter: walk every open shadow root too.
      function deepAll(sel) {
        var found = [], roots = [document];
        for (var r = 0; r < roots.length && r < 400; r++) {
          try { found.push.apply(found, roots[r].querySelectorAll(sel)); } catch (e) { return found; }
          var all = roots[r].querySelectorAll("*");
          for (var k = 0; k < all.length; k++) if (all[k].shadowRoot) roots.push(all[k].shadowRoot);
        }
        return found;
      }
      for (var s = 0; s < selectors.length; s++) {
        var els;
        try { els = deepAll(selectors[s]); } catch (e) { continue; }
        for (var i = 0; i < els.length && out.length < 250; i++) {
          var el = els[i];
          if (seen.has(el)) continue;
          seen.add(el);
          var r = el.getBoundingClientRect();
          var st = getComputedStyle(el);
          if (r.width < 2 || r.height < 2 || st.visibility === "hidden" || st.display === "none") continue;
          if (el.closest("form") && el.getAttribute("role") !== "tab" && el.tagName !== "A") continue;
          if ((el.getAttribute("type") || "").toLowerCase() === "submit") continue;
          if (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true") continue;
          var label = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 60);
          if (!label) continue;
          var key = el.getAttribute("data-glv-x");
          if (!key) { key = "x" + (n++); el.setAttribute("data-glv-x", key); }
          var href = el.tagName === "A" ? el.getAttribute("href") : null;
          var abs = href && !/^(#$|javascript:|mailto:|tel:)/i.test(href) ? el.href : undefined;
          out.push({ key: key, label: label, href: abs, tab: el.getAttribute("role") === "tab" || /tab/.test(el.getAttribute("data-toggle") || el.getAttribute("data-bs-toggle") || "") });
        }
      }
      return out;
    })(${JSON.stringify(selectors)})`,
  )) as Item[];
}

async function settle(page: Page, ms = 700): Promise<void> {
  await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
  await page.waitForTimeout(ms);
}

/** Clicks through the signed-in app from `startUrl` and returns every screen it finds. */
export async function exploreApp(context: BrowserContext, startUrl: string, opts: ExploreOptions = {}): Promise<AppScreen[]> {
  const log = opts.log ?? (() => {});
  const end = Date.now() + (opts.maxMs ?? 90_000);
  let clicks = opts.maxClicks ?? 80;
  const origin = new URL(startUrl).origin;
  const selectors = [...(opts.system?.nav ?? []), ...GENERAL_NAV];
  const screens = new Map<string, AppScreen>();
  const add = (url: string, via: string, inMenu: boolean) => {
    let key: string;
    try {
      key = normaliseUrl(url);
    } catch {
      return;
    }
    if (new URL(key).origin !== origin) return;
    if (isUnsafeLink(key, true) || opts.unsafe?.test(key)) return;
    const had = screens.get(key);
    if (!had) screens.set(key, { url: key, via, inMenu });
    else if (inMenu && !had.inMenu) Object.assign(had, { inMenu: true, via: had.via ?? via });
  };
  const safeItem = (it: Item) => !DANGER_WORDS.test(it.label) && !(it.href && (isUnsafeLink(it.href, true) || opts.unsafe?.test(it.href)));

  const page = await context.newPage();
  const guard = await readOnly(page, { loggedIn: true, unsafe: opts.unsafe });
  page.on("download", (d) => void d.cancel().catch(() => {}));
  page.on("dialog", (d) => void d.dismiss().catch(() => {}));
  const open = async (url: string) => {
    await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
    await settle(page, 300);
    // Marks are lost with the page; the same menu gets the same marks again, in the same order.
    await menuItems(page, selectors).catch(() => {});
    await frameScreens(url);
  };
  /**
   * Screens inside frames: older parts of an app (Salesforce Visualforce, Zoho's embedded pages,
   * reports) are drawn in an iframe. The frame's own address and the links in it are screens too.
   */
  const framed = new Set<string>();
  const frameScreens = async (screenUrl: string) => {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.isDetached()) continue;
      let src: string;
      try {
        src = normaliseUrl(f.url());
      } catch {
        continue;
      }
      if (!/^https?:/.test(src) || new URL(src).origin !== origin || framed.has(src)) continue;
      framed.add(src);
      const label = (await f.title().catch(() => "")) || new URL(src).pathname;
      add(src, `Frame in ${new URL(screenUrl).pathname}: ${label.slice(0, 40)}`, false);
      const links = (await f.$$eval("a[href]", (as) => as.slice(0, 200).map((a) => [(a as HTMLAnchorElement).href, ((a as HTMLElement).innerText || "").trim().slice(0, 40)])).catch(() => [])) as [string, string][];
      for (const [href, text] of links) if (/^https?:/.test(href) && !DANGER_WORDS.test(text)) add(href, `Frame in ${new URL(screenUrl).pathname} > ${text || "link"}`, false);
    }
  };

  /** Explores one screen's menu items; returns the screens it reached by clicking. */
  const exploreScreen = async (screenUrl: string, prefix: string, depth: number, skip: Set<string>): Promise<string[]> => {
    await open(screenUrl);
    const here = page.url();
    const reached: string[] = [];
    const items = (await menuItems(page, selectors).catch(() => [] as Item[])).filter(safeItem);
    const labels = new Set(items.map((i) => i.label));
    for (const it of items) {
      if (skip.has(it.label) && !it.tab) continue;
      const via = prefix ? `${prefix} > ${it.label}` : it.label;
      if (it.href && !it.tab) {
        // A real link in the menu: no need to click it, but it is a menu screen.
        add(it.href, via, true);
        continue;
      }
      if (clicks <= 0 || Date.now() > end) break;
      opts.signal?.throwIfAborted();
      clicks--;
      if (!sameScreen(page.url(), here)) await open(screenUrl);
      const el = page.locator(`[data-glv-x="${it.key}"]`).first();
      if (!(await el.isVisible().catch(() => false))) continue;
      const before = page.url();
      const clicked = await el.click({ timeout: 3_000 }).then(() => true, () => false);
      if (!clicked) continue;
      await settle(page);
      const now = page.url();
      if (!sameScreen(now, before) && /^https?:/.test(now)) {
        add(now, via, true);
        reached.push(normaliseUrl(now));
        continue;
      }
      if (it.tab) {
        // A tab inside the screen: same address, another part of it.
        const s = screens.get(normaliseUrl(here));
        if (s) s.parts = [...new Set([...(s.parts ?? []), it.label])].slice(0, 30);
        continue;
      }
      // A dropdown or sub-menu opened: its new items, one level down.
      if (depth < 2) {
        const sub = (await menuItems(page, selectors).catch(() => [] as Item[])).filter((x) => !labels.has(x.label) && safeItem(x));
        for (const child of sub.slice(0, 20)) {
          labels.add(child.label);
          const childVia = `${via} > ${child.label}`;
          if (child.href) {
            add(child.href, childVia, true);
            continue;
          }
          if (clicks <= 0 || Date.now() > end) break;
          clicks--;
          const c = page.locator(`[data-glv-x="${child.key}"]`).first();
          if (!(await c.isVisible().catch(() => false))) {
            // The menu closed: open it again first.
            await page.locator(`[data-glv-x="${it.key}"]`).first().click({ timeout: 3_000 }).catch(() => {});
            await settle(page, 300);
            await menuItems(page, selectors).catch(() => {});
          }
          const b = page.url();
          if (!(await c.click({ timeout: 3_000 }).then(() => true, () => false))) continue;
          await settle(page);
          if (!sameScreen(page.url(), b) && /^https?:/.test(page.url())) {
            add(page.url(), childVia, true);
            reached.push(normaliseUrl(page.url()));
            await open(screenUrl);
          }
        }
      }
      await page.keyboard.press("Escape").catch(() => {});
    }
    return reached;
  };

  try {
    add(startUrl, "Start screen", true);
    await open(startUrl);
    const first = page.url();
    if (!sameScreen(first, startUrl)) add(first, "Start screen", true);
    const startItems = new Set((await menuItems(page, selectors).catch(() => [] as Item[])).map((i) => i.label));
    const reached = await exploreScreen(first, "", 1, new Set());
    // Then the screens reached by clicking, again, for their own tabs and sub-menus (the main menu is
    // skipped there). Screens with ordinary links are left to the crawler, which reads their links.
    const again = [...screens.values()].filter((s) => !sameScreen(s.url, first) && reached.includes(s.url)).slice(0, opts.deeper ?? 6);
    for (const s of again) {
      if (clicks <= 0 || Date.now() > end) break;
      await exploreScreen(s.url, s.via ?? "", 1, startItems);
    }
  } finally {
    await guard.off();
    await page.close().catch(() => {});
  }
  const out = [...screens.values()];
  log(`App explorer: ${out.length} screens found by clicking the app's menus${guard.blocked.length ? `, ${guard.blocked.length} requests that could change data stopped` : ""}`);
  return out;
}
