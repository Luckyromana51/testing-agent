import { createHash } from "node:crypto";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, PageResult } from "../../types.js";
import type { PageAgent, SiteAgent } from "../types.js";
import { DESCRIBE_JS, readOnly } from "./guard.js";

/**
 * Functional checks that use the site: form fields at their limits (without sending anything),
 * random clicking with every change blocked, screen sizes from phones to full HD, site search,
 * same-page links and the missing-page screen.
 */

/** A made-up word, the same for a site on every re-test, so its findings keep the same address. */
const madeUp = (origin: string, n: number) => createHash("sha1").update(new URL(origin).hostname).digest("hex").slice(0, n);

const list = (items: string[], max = 6) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");

/** Pages that loaded fine, first page first. */
const goodPages = (pages: PageResult[], max: number) => pages.filter((p) => !p.error && (p.status ?? 0) < 400).slice(0, max);

// ---------------------------------------------------------------------------------------------

interface FieldFacts {
  email: string[];
  negative: string[];
  edge: string[];
  phone: string[];
  pattern: string[];
  required: string[];
}

/**
 * Boundary values and wrong kinds of input, checked with the browser's own form validation.
 * Values are set and read back in one step and then restored; nothing is typed, sent or submitted.
 */
export const formFieldsAgent: PageAgent = {
  id: "func.form-fields",
  name: "Form field limits",
  description:
    "Tries boundary and wrong values in every form field (an email without @, -1 as a quantity, letters as a phone number, the lowest and highest allowed numbers) and checks the form stops them. Nothing is typed into the site or sent.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const f = (await page.evaluate(`(function () {
      var describe = ${DESCRIBE_JS};
      var out = { email: [], negative: [], edge: [], phone: [], pattern: [], required: [] };
      var labelOf = function (el) {
        var t = "";
        if (el.labels && el.labels.length) t = el.labels[0].innerText;
        else if (el.getAttribute("aria-label")) t = el.getAttribute("aria-label");
        else if (el.id) { var l = document.querySelector('label[for="' + el.id + '"]'); if (l) t = l.innerText; }
        return (t || "").replace(/\\s+/g, " ").trim();
      };
      var fields = document.querySelectorAll("input, textarea");
      for (var i = 0; i < fields.length && i < 300; i++) {
        var el = fields[i];
        var type = (el.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio", "color", "range"].indexOf(type) >= 0) continue;
        if (el.disabled || el.readOnly) continue;
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        var label = labelOf(el);
        var words = (el.name + " " + el.id + " " + (el.getAttribute("autocomplete") || "") + " " + (el.placeholder || "") + " " + label).toLowerCase();
        var name = describe(el) + (label ? " (" + label.slice(0, 40) + ")" : "");
        var keep = el.value;
        var accepts = function (v) { el.value = v; return el.validity.valid; };
        if (type === "text" && /e-?mail/.test(words) && !el.pattern && accepts("not-an-email")) out.email.push(name);
        if (type === "number") {
          var step = el.step && el.step !== "any" ? Number(el.step) : 1;
          if (el.min === "" && /qty|quantity|age|count|people|guests|persons|amount|price|units/.test(words) && accepts("-1")) out.negative.push(name);
          if (el.min !== "" && !accepts(el.min)) out.edge.push(name + ": its own lowest value " + el.min + " is refused");
          if (el.max !== "" && !accepts(el.max)) out.edge.push(name + ": its own highest value " + el.max + " is refused (step " + step + ")");
        }
        if ((type === "tel" || (type === "text" && /phone|mobile|whatsapp|contact.?no/.test(words))) && !el.pattern && accepts("abcdefgh")) out.phone.push(name);
        if (el.pattern) {
          try { new RegExp("^(?:" + el.pattern + ")$", "v"); } catch (e) { out.pattern.push(name + ' pattern="' + el.pattern.slice(0, 60) + '"'); }
        }
        if (!el.required && el.getAttribute("aria-required") !== "true" && /\\*\\s*:?$|\\(required\\)|\\brequired\\b/i.test(label)) out.required.push(name);
        el.value = keep;
      }
      return out;
    })()`)) as FieldFacts;

    const out: Finding[] = [];
    const add = (items: string[], rule: string, severity: Finding["severity"], title: string, detail: string, category: Finding["category"] = "functional") => {
      if (items.length) out.push(finding({ category, rule, severity, title, detail, pageUrl: url, evidence: list(items), count: items.length }));
    };
    add(f.email, "form:email-accepts-anything", "medium", "Email field accepts text that is not an email address",
      'The field accepts "not-an-email", so wrong addresses reach your inbox or CRM and replies bounce. Use type="email" (the browser then checks it, and phones show the @ keyboard).');
    add(f.negative, "form:negative-number", "medium", "Number field accepts -1",
      'A quantity, age or amount field accepts a negative number. Add min="0" (or min="1"), and check the value on the server too.');
    add(f.edge, "form:boundary-refused", "medium", "Number field refuses its own lowest or highest value",
      "The field's min or max does not fit its step, so the browser refuses a value the form says is allowed. Make max reachable from min in steps (or use step=\"any\").");
    add(f.phone, "form:phone-accepts-letters", "low", "Phone field accepts letters",
      'The field accepts "abcdefgh". Add a pattern, e.g. pattern="[0-9+ ]{10,15}" for Indian mobile numbers, with inputmode="tel".');
    add(f.pattern, "form:pattern-invalid", "medium", "A field's check pattern is broken, so nothing is checked",
      "The browser cannot read the pattern attribute, so it ignores it and accepts anything. Browsers read patterns with the regular expression v flag: escape characters such as - inside [ ].");
    add(f.required, "form:required-not-marked", "medium", "Fields marked * are not required for the browser or screen readers",
      "The label shows the field is required, but the field has no required attribute, so the form can be sent empty and screen readers do not say it is required (WCAG 3.3.2). Add required (or aria-required=\"true\").",
      "accessibility");
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** A small seeded random generator, so a monkey test does the same things on every re-test. */
function seeded(text: string): () => number {
  let a = 0;
  for (const c of text) a = (Math.imul(a ^ c.charCodeAt(0), 2654435761) >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD_VALUES = ["", "   ", "a".repeat(300), "😀 ñ 漢字 हिन्दी", "-1", "0", "99999999999999", "1.5", "test@example.com", "<b>x</b>"];

interface MonkeyResult {
  errors: { message: string; steps: string[] }[];
  crashed: string;
  frozen: string;
}

async function monkey(browser: BrowserContext, url: string, origin: string, loggedIn: boolean): Promise<MonkeyResult> {
  const page = await browser.newPage();
  const guard = await readOnly(page, { loggedIn, stayOnPage: true });
  const result: MonkeyResult = { errors: [], crashed: "", frozen: "" };
  const seen = new Set<string>();
  let steps: string[] = [];
  let loading = true;
  const own = (stack: string) => {
    const where = /(https?:\/\/[^\s)]+)/.exec(stack)?.[1];
    return !where || where.startsWith(origin);
  };
  page.on("pageerror", (err) => {
    if (loading || seen.has(err.message) || !own(err.stack ?? "")) return;
    seen.add(err.message);
    if (result.errors.length < 5) result.errors.push({ message: err.message.slice(0, 200), steps: steps.slice(-4) });
  });
  page.on("crash", () => (result.crashed = steps.slice(-4).join(" → ") || "while loading"));
  try {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    guard.stayOn(page.url());
    await page.waitForTimeout(500);
    loading = false;
    const random = seeded(url);
    for (let i = 0; i < 40 && !result.crashed; i++) {
      const pick = random();
      const value = ODD_VALUES[Math.floor(random() * ODD_VALUES.length)];
      let timer: NodeJS.Timeout | undefined;
      const action = (await Promise.race([
        page.evaluate(
          `(function (pick, value) {
            var describe = ${DESCRIBE_JS};
            var all = document.querySelectorAll('a[href], button, [role=button], input:not([type=hidden]):not([type=file]), select, textarea, summary, [onclick], [tabindex]:not([tabindex="-1"])');
            var shown = [];
            for (var i = 0; i < all.length; i++) {
              var r = all[i].getBoundingClientRect();
              if (r.width > 0 && r.height > 0 && !all[i].disabled) shown.push(all[i]);
            }
            if (!shown.length) return null;
            var el = shown[Math.floor(pick * shown.length)];
            el.scrollIntoView({ block: "center" });
            var r2 = el.getBoundingClientRect();
            var tag = el.tagName;
            var type = (el.getAttribute("type") || "").toLowerCase();
            if (tag === "SELECT" && el.options.length) {
              el.selectedIndex = Math.floor(pick * 997) % el.options.length;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return { what: "pick an option in " + describe(el) };
            }
            if ((tag === "INPUT" && ["checkbox", "radio", "submit", "button", "reset", "image"].indexOf(type) < 0) || tag === "TEXTAREA") {
              el.focus();
              return { what: 'type "' + value.slice(0, 20) + '" in ' + describe(el), type: true };
            }
            return { what: "click " + describe(el), x: r2.left + r2.width / 2, y: r2.top + r2.height / 2 };
          })(${JSON.stringify(pick)}, ${JSON.stringify(value)})`,
        ),
        new Promise((resolve) => (timer = setTimeout(() => resolve("frozen"), 8_000))),
      ]).finally(() => clearTimeout(timer))) as { what: string; type?: boolean; x?: number; y?: number } | "frozen" | null;
      if (action === "frozen") {
        result.frozen = steps.slice(-4).join(" → ") || "after loading";
        break;
      }
      if (!action) break;
      steps = [...steps, action.what];
      if (action.type) await page.keyboard.insertText(value).catch(() => {});
      else if (action.x !== undefined && action.y !== undefined) await page.mouse.click(action.x, action.y).catch(() => {});
      if (random() < 0.15) await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(120);
    }
  } finally {
    await guard.off();
    await page.close().catch(() => {});
  }
  return result;
}

/** Random clicks and typing, like a curious or impatient visitor, with every change to the site blocked. */
export const monkeyAgent: SiteAgent = {
  id: "func.monkey",
  name: "Monkey testing",
  description:
    "Clicks, types and picks options at random on up to 3 pages (40 actions each, the same ones on every re-test) and reports JavaScript errors, crashes and freezes. Every request that could change data is blocked.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, origin, site }) {
    const sample = goodPages(pages, 3);
    const results = await Promise.all(sample.map((p) => monkey(browser, p.url, origin, Boolean(site.loggedIn)).catch(() => null)));
    const out: Finding[] = [];
    sample.forEach((p, i) => {
      const r = results[i];
      if (!r) return;
      if (r.crashed) {
        out.push(
          finding({
            category: "functional",
            rule: "monkey:crash",
            severity: "high",
            title: "The page crashed while it was being used",
            detail: "The browser tab crashed (usually it ran out of memory or got stuck in a loop) after these steps.",
            pageUrl: p.url,
            evidence: r.crashed,
          }),
        );
      }
      if (r.frozen) {
        out.push(
          finding({
            category: "functional",
            rule: "monkey:frozen",
            severity: "high",
            title: "The page froze while it was being used",
            detail: "The page stopped responding for more than 8 seconds after these steps. Look for a loop or heavy work on the main thread.",
            pageUrl: p.url,
            evidence: r.frozen,
          }),
        );
      }
      for (const e of r.errors) {
        out.push(
          finding({
            category: "functional",
            rule: "monkey:js-error",
            severity: "medium",
            title: "Using the page causes a JavaScript error",
            detail: `The error "${e.message}" happened after the steps below. Visitors doing the same may find a button or form that stops working.`,
            pageUrl: p.url,
            evidence: e.steps.join(" → "),
          }),
        );
      }
    });
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Our own device lab: the phone (390 px) and desktop (1366 px) sizes are tested on every page already. */
export const DEVICES: { name: string; width: number; height: number }[] = [
  { name: "Android phone", width: 360, height: 800 },
  { name: "iPhone SE", width: 375, height: 667 },
  { name: "Pixel 7", width: 412, height: 915 },
  { name: "iPhone Pro Max", width: 430, height: 932 },
  { name: "Small tablet", width: 600, height: 960 },
  { name: "iPad, upright", width: 768, height: 1024 },
  { name: "iPad Air, upright", width: 820, height: 1180 },
  { name: "iPad, sideways", width: 1024, height: 768 },
  { name: "Laptop", width: 1280, height: 800 },
  { name: "Desktop", width: 1440, height: 900 },
  { name: "Full HD screen", width: 1920, height: 1080 },
];

export const devicesAgent: SiteAgent = {
  id: "func.devices",
  name: "Screen sizes (device lab)",
  description:
    "Opens up to 4 pages at 11 more screen sizes, from small Android phones and iPads to laptops and full HD screens, finds sizes where the page scrolls sideways, and saves a picture of the first page at each size.",
  category: "mobile",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, artifactsDir }) {
    const sample = goodPages(pages, 4);
    const out: Finding[] = [];
    await Promise.all(
      sample.map(async (p, n) => {
        const page = await browser.newPage();
        const bad: string[] = [];
        try {
          await page.setViewportSize({ width: DEVICES[0].width, height: DEVICES[0].height });
          await page.goto(p.url, { waitUntil: "load", timeout: 30_000 });
          for (const d of DEVICES) {
            await page.setViewportSize({ width: d.width, height: d.height });
            await page.waitForTimeout(200);
            const overflow = (await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")) as number;
            if (overflow > 5) bad.push(`${d.name} (${d.width} px): ${overflow} px too wide`);
            if (n === 0) {
              const file = `device-${d.width}x${d.height}.jpg`;
              await page.screenshot({ path: path.join(artifactsDir, file), type: "jpeg", quality: 55 });
              p.files = [...(p.files ?? []), { label: `${d.name} ${d.width}×${d.height}`, file }];
            }
          }
        } catch {
          // A page that cannot be opened again is reported by the crawler, not here.
        } finally {
          await page.close().catch(() => {});
        }
        if (bad.length) {
          const phones = bad.some((b) => Number(/\((\d+) px/.exec(b)?.[1]) < 1024);
          out.push(
            finding({
              category: phones ? "mobile" : "functional",
              rule: "layout:sideways-at-size",
              severity: "medium",
              title: `Page scrolls sideways on ${bad.length} screen size${bad.length === 1 ? "" : "s"}`,
              detail:
                "At these sizes something on the page is wider than the screen, so visitors must scroll sideways. Look for fixed widths, wide tables and images without max-width: 100%, and test between your CSS breakpoints.",
              pageUrl: p.url,
              evidence: list(bad, 11),
            }),
          );
        }
      }),
    );
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

export const anchorsAgent: PageAgent = {
  id: "func.anchors",
  name: "Same-page links",
  description: "Finds links that should jump to a section of the same page (#section) but the section does not exist.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const missing = (await page.evaluate(`(function () {
      var describe = ${DESCRIBE_JS};
      var out = [];
      var as = document.querySelectorAll('a[href*="#"]');
      for (var i = 0; i < as.length; i++) {
        var a = as[i];
        var href = a.getAttribute("href") || "";
        if (href === "#" || /^#[!\\/]/.test(href) || /^javascript:/i.test(href)) continue;
        if (a.getAttribute("role") === "tab" || a.hasAttribute("data-toggle") || a.hasAttribute("data-bs-toggle") || a.hasAttribute("aria-controls")) continue;
        var u;
        try { u = new URL(a.href); } catch (e) { continue; }
        if (u.origin + u.pathname + u.search !== location.origin + location.pathname + location.search) continue;
        var id = "";
        try { id = decodeURIComponent(u.hash.slice(1)); } catch (e) { id = u.hash.slice(1); }
        if (!id || id === "top" || /^[\\/!]/.test(id)) continue;
        if (document.getElementById(id) || document.getElementsByName(id).length) continue;
        out.push(describe(a) + " → #" + id);
      }
      return out;
    })()`)) as string[];
    if (!missing.length) return [];
    return [
      finding({
        category: "functional",
        rule: "link:missing-anchor",
        severity: "low",
        title: `${missing.length} link${missing.length === 1 ? " jumps" : "s jump"} to a section that does not exist`,
        detail: "These links point to #section on this page, but nothing on the page has that id, so the click does nothing. Fix the id, or the link.",
        pageUrl: url,
        evidence: list([...new Set(missing)]),
        count: missing.length,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------

const NO_RESULTS = /\b(no (results|products|matches|items|records)|nothing (was )?found|0 results|did not match|didn't match|couldn't find|could not find)\b|कोई परिणाम नहीं/i;

/** The site's own search, through its GET search form: a word from the site, and a word that is nowhere. */
export const searchAgent: SiteAgent = {
  id: "func.search",
  name: "Site search",
  description:
    "Finds the site's search box and searches for a word from the site's own pages and for a made-up word: the results page must load without errors, find the real word, and say clearly when nothing matches.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, origin }) {
    const sample = goodPages(pages, 3);
    type SearchForm = { action: string; params: [string, string][]; field: string; word: string; from: string };
    let found: SearchForm | null = null;
    for (const p of sample) {
      let form: SearchForm | null = null;
      const page = await browser.newPage();
      try {
        await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        form = (await page.evaluate(`(function () {
          var inputs = document.querySelectorAll('form input[type=search], form input[name=q], form input[name=s], form input[name=search], form input[name=query], form input[name=keyword], form[role=search] input[type=text]');
          for (var i = 0; i < inputs.length; i++) {
            var input = inputs[i];
            var f = input.form;
            if (!f || !input.name || (f.getAttribute("method") || "get").toLowerCase() !== "get") continue;
            var params = [];
            for (var j = 0; j < f.elements.length; j++) {
              var e = f.elements[j];
              if (!e.name || e === input || e.disabled) continue;
              if ((e.type === "checkbox" || e.type === "radio") && !e.checked) continue;
              if (e.type === "submit" || e.type === "button") continue;
              params.push([e.name, e.value]);
            }
            var stop = ["home", "page", "welcome", "store", "shop", "about", "with", "your", "from", "this", "that", "best", "online", "india"];
            var source = ((document.querySelector("h1") || {}).innerText || "") + " " + document.title;
            var words = source.split(/[^A-Za-z]+/).filter(function (w) { return w.length >= 4 && stop.indexOf(w.toLowerCase()) < 0; });
            if (!words.length) continue;
            return { action: f.action || location.href, params: params, field: input.name, word: words[0], from: location.href };
          }
          return null;
        })()`)) as SearchForm | null;
      } catch {
        form = null;
      } finally {
        await page.close().catch(() => {});
      }
      if (form) {
        found = form;
        break;
      }
    }
    const form = found;
    if (!form || !form.action.startsWith(origin)) return [];

    const search = async (term: string) => {
      const u = new URL(form.action);
      for (const [k, v] of form.params) u.searchParams.set(k, v);
      u.searchParams.set(form.field, term);
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
      try {
        const started = Date.now();
        const res = await page.goto(u.toString(), { waitUntil: "load", timeout: 30_000 });
        const ms = Date.now() - started;
        const text = await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "");
        return { url: u.toString(), status: res?.status() ?? 0, ms, errors, none: NO_RESULTS.test(String(text)) };
      } catch (err) {
        return { url: u.toString(), status: 0, ms: 0, errors: [(err as Error).message.split("\n")[0]], none: false };
      } finally {
        await page.close().catch(() => {});
      }
    };
    const real = await search(form.word);
    const nonsense = await search(`zqx${madeUp(origin, 6)}`);
    const out: Finding[] = [];
    for (const r of [real, nonsense]) {
      if (r.status === 0 || r.status >= 400) {
        out.push(
          finding({
            category: "functional",
            rule: "search:error",
            severity: r.status >= 500 || r.status === 0 ? "high" : "medium",
            title: `Site search answers ${r.status ? `HTTP ${r.status}` : "with an error"}`,
            detail: "Searching from the site's own search box shows an error page instead of results.",
            pageUrl: r.url,
            evidence: r.errors.join("\n") || undefined,
          }),
        );
        return out;
      }
    }
    if (real.none && nonsense.none) {
      out.push(
        finding({
          category: "functional",
          rule: "search:finds-nothing",
          severity: "medium",
          title: `Site search finds nothing for "${form.word}", a word on the site's own page`,
          detail: `The word comes from ${form.from}, yet the search says nothing matches. Check the search index is built and includes all pages or products.`,
          pageUrl: real.url,
        }),
      );
    }
    if (!nonsense.none) {
      out.push(
        finding({
          category: "functional",
          rule: "search:no-empty-message",
          severity: "low",
          title: "Site search does not say when nothing matches",
          detail: "A search for a made-up word shows no clear \"No results\" message. Tell visitors nothing matched, and suggest what to try instead.",
          pageUrl: nonsense.url,
        }),
      );
    }
    const errors = [...new Set([...real.errors, ...nonsense.errors])];
    if (errors.length) {
      out.push(
        finding({
          category: "functional",
          rule: "search:js-error",
          severity: "medium",
          title: "The search results page has JavaScript errors",
          detail: "The results page throws errors, so filters, sorting or \"load more\" may not work.",
          pageUrl: real.url,
          evidence: list(errors, 3),
        }),
      );
    }
    if (real.ms > 3000) {
      out.push(
        finding({
          category: "performance",
          rule: "search:slow",
          severity: "low",
          title: `Site search takes ${(real.ms / 1000).toFixed(1)} s`,
          detail: "Visitors expect results in under 2 seconds. Add a search index (database full-text index or a search engine) and cache common searches.",
          pageUrl: real.url,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** The page visitors see after a broken link: it should say so and offer a way on. */
export const notFoundPageAgent: SiteAgent = {
  id: "func.not-found-page",
  name: "Missing-page screen",
  description: "Opens an address that does not exist and checks the error page says the page was not found and offers a way back (a link home, the menu or search).",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, origin }) {
    const url = `${origin}/glv-missing-${madeUp(origin, 10)}`;
    const page: Page = await browser.newPage();
    try {
      const res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      const status = res?.status() ?? 0;
      if (status !== 404 && status !== 410) return []; // 200 is the soft-404 agent's finding; other answers are the server's
      const facts = (await page.evaluate(`(function () {
        var text = (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim();
        var links = 0;
        var as = document.querySelectorAll("a[href]");
        for (var i = 0; i < as.length; i++) { try { if (new URL(as[i].href).origin === location.origin) links++; } catch (e) {} }
        return { words: text ? text.split(" ").length : 0, links: links, search: Boolean(document.querySelector("input[type=search], input[name=q], input[name=s]")) };
      })()`)) as { words: number; links: number; search: boolean };
      if (facts.links > 0 || facts.search) return [];
      return [
        finding({
          category: "functional",
          rule: "ux:dead-end-404",
          severity: "low",
          title: facts.words < 5 ? "The missing-page screen is blank" : "The missing-page screen has no way back",
          detail:
            "Visitors who follow an old or mistyped link land on this page with no link to the home page, no menu and no search, so most of them leave. Use the site's normal layout with a short message and a link home.",
          pageUrl: url,
        }),
      ];
    } catch {
      return [];
    } finally {
      await page.close().catch(() => {});
    }
  },
};
