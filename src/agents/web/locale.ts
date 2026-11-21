import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS, WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, SiteAgent } from "../types.js";
import { readOnly } from "./guard.js";

/**
 * Language and region checks: the page says the language it is really written in (screen readers
 * pick their voice from it), right-to-left text runs right to left, characters are not garbled,
 * prices and dates follow the visitor's region, and the site still works for a visitor whose
 * browser is set to another language and time zone.
 */

const list = (items: string[], max = 6) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");

/** The writing system of each script range, for text that is mostly one script. */
const SCRIPTS: [string, RegExp][] = [
  ["Latin", /[A-Za-zÀ-ɏ]/g],
  ["Devanagari", /[ऀ-ॿ]/g],
  ["Bengali", /[ঀ-৿]/g],
  ["Gurmukhi", /[਀-੿]/g],
  ["Gujarati", /[઀-૿]/g],
  ["Odia", /[଀-୿]/g],
  ["Tamil", /[஀-௿]/g],
  ["Telugu", /[ఀ-౿]/g],
  ["Kannada", /[ಀ-೿]/g],
  ["Malayalam", /[ഀ-ൿ]/g],
  ["Arabic", /[؀-ۿݐ-ݿ]/g],
  ["Hebrew", /[֐-׿]/g],
  ["Cyrillic", /[Ѐ-ӿ]/g],
  ["Greek", /[Ͱ-Ͽ]/g],
  ["Thai", /[฀-๿]/g],
  ["Chinese or Japanese", /[぀-ヿ一-鿿]/g],
  ["Korean", /[가-힯]/g],
];

/** The script each language is written in. Languages written in several scripts are left out. */
const LANG_SCRIPT: Record<string, string> = {
  en: "Latin", fr: "Latin", de: "Latin", es: "Latin", it: "Latin", pt: "Latin", nl: "Latin", sv: "Latin", da: "Latin", nb: "Latin", no: "Latin", fi: "Latin", pl: "Latin", cs: "Latin", ro: "Latin", hu: "Latin", tr: "Latin", id: "Latin", ms: "Latin", vi: "Latin", sw: "Latin", tl: "Latin", fil: "Latin",
  hi: "Devanagari", mr: "Devanagari", ne: "Devanagari", sa: "Devanagari", kok: "Devanagari", mai: "Devanagari",
  bn: "Bengali", as: "Bengali", pa: "Gurmukhi", gu: "Gujarati", or: "Odia", ta: "Tamil", te: "Telugu", kn: "Kannada", ml: "Malayalam",
  ar: "Arabic", fa: "Arabic", ur: "Arabic", ps: "Arabic", he: "Hebrew", yi: "Hebrew",
  ru: "Cyrillic", uk: "Cyrillic", bg: "Cyrillic", be: "Cyrillic", mk: "Cyrillic", kk: "Cyrillic",
  el: "Greek", th: "Thai", zh: "Chinese or Japanese", ja: "Chinese or Japanese", ko: "Korean",
};

/** The main script of a text: the one with at least 60% of its letters, if any. */
export function mainScript(text: string): { script: string; letters: number } | null {
  let total = 0;
  let best = { script: "", letters: 0 };
  for (const [name, re] of SCRIPTS) {
    const n = (text.match(re) ?? []).length;
    total += n;
    if (n > best.letters) best = { script: name, letters: n };
  }
  return total && best.letters / total >= 0.6 ? best : null;
}

export function badHreflang(code: string): string | null {
  if (code.toLowerCase() === "x-default") return null;
  const m = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i.exec(code);
  if (!m) return `${code}: not a language code (use en, en-IN, hi-IN...)`;
  const region = m[3]?.toLowerCase();
  if (region === "uk") return `${code}: the country code for the United Kingdom is GB (en-GB)`;
  if (region === "eu") return `${code}: EU is not a country code; list each country, or use the language alone`;
  try {
    Intl.getCanonicalLocales(code);
  } catch {
    return `${code}: not a valid language code`;
  }
  return null;
}

const LANG_JS = `(function () {
  var html = document.documentElement;
  var main = document.querySelector("main, [role=main], article") || document.body;
  var text = main ? (main.innerText || "").slice(0, 20000) : "";
  var alts = [];
  document.querySelectorAll('link[rel="alternate"][hreflang]').forEach(function (l) { alts.push([l.getAttribute("hreflang") || "", l.getAttribute("href") || ""]); });
  return {
    lang: html.getAttribute("lang") || "",
    dir: (html.getAttribute("dir") || "").toLowerCase(),
    bodyDir: document.body ? getComputedStyle(document.body).direction : "ltr",
    charset: document.characterSet,
    text: text,
    alts: alts
  };
})()`;

/** Signs of text decoded with the wrong character set (UTF-8 read as Latin-1 or Windows-1252). */
const MOJIBAKE = /â€[™œ\u009d“”˜¦]|Ã[©¨¢ª®´¶¼½]|à¤[\u0080-¿]|à¥[\u0080-¿]|Â[ ©®°£]/;

export const languageAgent: PageAgent = {
  id: "l10n.language",
  name: "Page language",
  description:
    "Checks the language the page declares against the script it is really written in (Hindi, Tamil, Arabic...), that Arabic, Urdu and Hebrew run right to left, that characters are not garbled, that the page is UTF-8, and that hreflang codes for other languages are valid.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url, product }) {
    const r = (await page.evaluate(LANG_JS)) as { lang: string; dir: string; bodyDir: string; charset: string; text: string; alts: [string, string][] };
    const out: Finding[] = [];
    const main = mainScript(r.text);
    const primary = r.lang.split(/[-_]/)[0].toLowerCase();
    const scriptTag = /-(latn|deva|arab|cyrl|beng|taml|telu|knda|mlym|gujr|guru|orya)\b/i.test(r.lang);
    const expected = LANG_SCRIPT[primary];
    if (main && main.letters >= 200 && expected && !scriptTag && expected !== main.script) {
      out.push(
        finding({
          category: "accessibility",
          rule: "l10n:wrong-lang",
          severity: "medium",
          title: `The page says its language is "${r.lang}", but the text is in ${main.script} script`,
          detail: `Screen readers read the page with the voice for "${r.lang}", which mispronounces every word, and search engines may show it to the wrong audience (WCAG 3.1.1). Set <html lang> to the language the page is written in${main.script === "Latin" && expected !== "Latin" ? ` (for ${primary} written in Latin letters, use ${primary}-Latn)` : ""}.`,
          pageUrl: url,
        }),
      );
    }
    if (main && (main.script === "Arabic" || main.script === "Hebrew") && main.letters >= 100 && r.dir !== "rtl" && r.bodyDir !== "rtl") {
      out.push(
        finding({
          category: "accessibility",
          rule: "l10n:rtl-missing",
          severity: "medium",
          title: `${main.script} text is laid out left to right`,
          detail:
            'Without dir="rtl", punctuation, numbers and mixed words land in the wrong place and the layout reads backwards for these visitors. Add dir="rtl" to <html> (or to the elements that hold this text) and check the layout mirrors.',
          pageUrl: url,
        }),
      );
    }
    if (r.charset.toUpperCase() !== "UTF-8") {
      out.push(
        finding({
          category: "functional",
          rule: "l10n:not-utf8",
          severity: "low",
          title: `The page uses the ${r.charset} character set, not UTF-8`,
          detail:
            'Indian scripts, the rupee sign and emoji can only be shown in UTF-8. Save the pages as UTF-8 and send Content-Type: text/html; charset=utf-8 (or <meta charset="utf-8"> first in <head>).',
          pageUrl: url,
        }),
      );
    }
    const garbled = MOJIBAKE.exec(r.text);
    if (garbled) {
      const at = Math.max(0, garbled.index - 30);
      out.push(
        finding({
          category: "functional",
          rule: "l10n:garbled-text",
          severity: "medium",
          title: "Some characters show as garbage (like â€™ or à¤)",
          detail:
            "Text saved in UTF-8 is being read as another character set somewhere, usually the database connection or an imported file. Set the database, the connection (utf8mb4 on MySQL) and the page all to UTF-8, then fix the stored text.",
          pageUrl: url,
          evidence: r.text.slice(at, at + 90).replace(/\s+/g, " "),
        }),
      );
    }
    if (PUBLIC_WEB_PRODUCTS.includes(product)) {
      const bad = r.alts.map(([code]) => badHreflang(code)).filter((b): b is string => Boolean(b));
      const relative = r.alts.filter(([, href]) => href && !/^https?:\/\//i.test(href)).map(([c, h]) => `${c}: ${h}`);
      if (bad.length || relative.length) {
        out.push(
          finding({
            category: "seo",
            rule: "seo:hreflang-invalid",
            severity: "low",
            title: "Links to the page's other languages (hreflang) have mistakes",
            detail:
              "Search engines ignore hreflang links with wrong codes or relative addresses, and may show visitors the wrong language. Use a language code with an optional country (en-IN, hi-IN, en-GB, x-default) and full https:// addresses.",
            pageUrl: url,
            evidence: list([...bad, ...relative.map((x) => `${x}: use a full address`)]),
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Dates written month first that cannot be read day first (the day is over 12). */
const US_DATE = /\b(0?[1-9]|1[0-2])\/(1[3-9]|2\d|3[01])\/(19|20)\d{2}\b/g;

export const formatsAgent: PageAgent = {
  id: "l10n.formats",
  name: "Prices and dates",
  description:
    "Finds prices in two currencies on one page (rupees next to dollars, for example) and, on Indian sites, dates written the US way (month first), which Indian visitors read as a different day.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const r = (await page.evaluate(`(function () {
      var root = document.querySelector("main, [role=main]") || document.body;
      return { text: root ? (root.innerText || "").slice(0, 100000) : "", lang: document.documentElement.getAttribute("lang") || "", switcher: !!document.querySelector('select[name*=currency i], [class*="currency-switch" i], [class*="currency-selector" i], [id*="currency" i]') };
    })()`)) as { text: string; lang: string; switcher: boolean };
    const out: Finding[] = [];
    const count = (re: RegExp) => (r.text.match(re) ?? []).length;
    const money: [string, number][] = [
      ["₹ / Rs / INR", count(/(₹|\bRs\.?|\bINR)\s?\d/g)],
      ["$ / USD", count(/(?<![A-Za-z])(US)?\$\s?\d|\bUSD\s?\d|\d\s?USD\b/g)],
      ["€ / EUR", count(/€\s?\d|\d\s?€|\bEUR\s?\d/g)],
      ["£ / GBP", count(/£\s?\d|\bGBP\s?\d/g)],
      ["AED", count(/\bAED\s?\d|\d\s?AED\b/g)],
    ];
    const used = money.filter(([, n]) => n >= 2);
    if (used.length >= 2 && !r.switcher) {
      out.push(
        finding({
          category: "functional",
          rule: "l10n:mixed-currency",
          severity: "low",
          title: `Prices on the page are in ${used.length} currencies`,
          detail:
            "Visitors cannot tell what they will pay when one page mixes currencies. Show every price in the visitor's currency (with a currency switcher if you sell abroad), and check for products whose price was entered in the wrong currency.",
          pageUrl: url,
          evidence: used.map(([c, n]) => `${c}: ${n} prices`).join("\n"),
        }),
      );
    }
    const indian = /-IN\b/i.test(r.lang) || /^(hi|mr|bn|ta|te|kn|ml|gu|pa|or)\b/i.test(r.lang) || /\.in$/i.test(new URL(url).hostname) || money[0][1] >= 2;
    const us = [...r.text.matchAll(US_DATE)].map((m) => m[0]);
    if (indian && us.length) {
      out.push(
        finding({
          category: "functional",
          rule: "l10n:us-date",
          severity: "low",
          title: "Dates are written month first (US style) on an Indian site",
          detail:
            "In India 03/04/2026 means 3 April, so visitors read month-first dates as a different day, and dates like 03/25/2026 look wrong. Write dates as 25/03/2026 or, clearer, 25 Mar 2026 (Intl.DateTimeFormat('en-IN') does it).",
          pageUrl: url,
          evidence: list([...new Set(us)]),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

interface LocaleView {
  errors: string[];
  broken: number;
}

/** "Invalid Date", "NaN" and "undefined" where text should be. */
const BROKEN_TEXT = /\bInvalid Date\b|\bNaN\b|\bundefined\b|\{\{\s*\w+/g;

export const otherLocaleAgent: SiteAgent = {
  id: "l10n.locale",
  name: "Other language and time zone",
  description:
    "Opens the first pages as a visitor whose browser is set to Arabic (Egypt) in the Pacific/Kiritimati time zone (14 hours ahead), next to a normal visitor, and reports script errors and broken dates (Invalid Date, NaN) that only that visitor gets.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages }) {
    const own = browser.browser();
    const sample = pages.filter((p) => !p.error && (p.status ?? 0) < 400).slice(0, 3);
    if (!own || !sample.length) return [];
    const view = async (opts: { locale?: string; timezoneId?: string }) => {
      const context = await own.newContext({ viewport: { width: 1366, height: 900 }, ...opts });
      const views: LocaleView[] = [];
      try {
        for (const p of sample) {
          const page = await context.newPage();
          const guard = await readOnly(page, { loggedIn: true });
          const errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message.split("\n")[0].slice(0, 200)));
          try {
            await page.goto(p.url, { waitUntil: "load", timeout: 30_000 });
            await page.waitForTimeout(500);
            const text = String(await page.evaluate("document.body ? document.body.innerText : ''"));
            views.push({ errors, broken: (text.match(BROKEN_TEXT) ?? []).length });
          } catch {
            views.push({ errors, broken: -1 });
          } finally {
            await guard.off();
            await page.close().catch(() => {});
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
      return views;
    };
    const [normal, other] = await Promise.all([view({ locale: "en-IN", timezoneId: "Asia/Kolkata" }), view({ locale: "ar-EG", timezoneId: "Pacific/Kiritimati" })]);
    const out: Finding[] = [];
    sample.forEach((p, i) => {
      const a = normal[i];
      const b = other[i];
      if (!a || !b || a.broken < 0 || b.broken < 0) return;
      if (b.errors.length > a.errors.length) {
        out.push(
          finding({
            category: "functional",
            rule: "l10n:locale-error",
            severity: "medium",
            title: "The page has script errors for visitors in another language and time zone",
            detail:
              "A browser set to Arabic (Egypt) in a time zone 14 hours ahead gets errors a visitor in India does not. Code that reads dates or numbers from text (new Date(\"25/03/2026\"), parseFloat(\"1,299\")) or expects English month names usually breaks first. Use Intl.DateTimeFormat and Intl.NumberFormat, and send dates as ISO strings (2026-03-25).",
            pageUrl: p.url,
            evidence: list([...new Set(b.errors)]),
          }),
        );
      }
      if (b.broken > a.broken) {
        out.push(
          finding({
            category: "functional",
            rule: "l10n:locale-broken-text",
            severity: "medium",
            title: `"Invalid Date", "NaN" or "undefined" appears for visitors in another language and time zone`,
            detail: `The page shows broken values ${b.broken - a.broken} more time${b.broken - a.broken === 1 ? "" : "s"} for a browser set to Arabic (Egypt) in a time zone 14 hours ahead. Dates are usually parsed from text in one fixed format; parse ISO dates and format them with Intl.DateTimeFormat.`,
            pageUrl: p.url,
          }),
        );
      }
    });
    return out;
  },
};
