import { accessibilityFindings, tapTargetFindings } from "../../runner/checks/accessibility.js";
import { collectSeoFacts, seoFindings } from "../../runner/checks/seo.js";
import { cookieFindings, headerFindings } from "../../runner/checks/security.js";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent } from "../types.js";

export const seoAgent: PageAgent = {
  id: "web.seo",
  name: "On-page SEO",
  description: "Title, meta description, headings, image alt text, canonical, language, viewport, noindex and social sharing tags.",
  category: "seo",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url, site }) {
    const facts = await collectSeoFacts(page);
    site.seo.set(url, { title: facts.title, description: facts.description });
    return seoFindings(url, facts);
  },
};

export const accessibilityAgent: PageAgent = {
  id: "web.accessibility",
  name: "Accessibility (WCAG 2.2)",
  description: "Runs the axe-core rules for WCAG 2.0 to 2.2, levels A and AA: contrast, labels, alt text, keyboard names and more.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  run: ({ page, url }) => accessibilityFindings(page, url),
};

export const securityHeadersAgent: PageAgent = {
  id: "web.security-headers",
  name: "Security headers and cookies",
  description: "Reads the server's security headers (HTTPS, HSTS, CSP, clickjacking, nosniff, referrer) and cookie flags. Passive only.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  async run({ url, response, isFirst, browser }) {
    if (!isFirst || !response) return [];
    return [...headerFindings(url, response.headers()), ...cookieFindings(url, await browser.cookies(url))];
  },
};

export const mobileAgent: PageAgent = {
  id: "web.mobile",
  name: "Phone layout",
  description: "Resizes to a 390 px phone: sideways scrolling, tap targets that are too small or too close (WCAG 2.2), and text too small to read.",
  category: "mobile",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  async run({ page, url }) {
    const out: Finding[] = [];
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 5) {
      out.push(
        finding({
          category: "mobile",
          rule: "mobile-overflow",
          severity: "medium",
          title: `Page scrolls sideways on phones (${overflow}px too wide)`,
          detail: "Some element is wider than a 390px phone screen. Check fixed widths, large images and tables.",
          pageUrl: url,
        }),
      );
    }
    // Text smaller than 12px on a phone is hard to read. Count visible text blocks only.
    const tiny = (await page.evaluate(`(function () {
      var n = 0, samples = [];
      var els = document.querySelectorAll("p, li, span, a, td, label, small");
      for (var i = 0; i < els.length && i < 3000; i++) {
        var el = els[i];
        var own = "";
        for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) own += c.textContent;
        own = own.trim();
        if (own.length < 20) continue;
        var r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        var size = parseFloat(getComputedStyle(el).fontSize);
        if (size && size < 12) { n++; if (samples.length < 3) samples.push(size + "px: " + own.slice(0, 60)); }
      }
      return { n: n, samples: samples };
    })()`)) as { n: number; samples: string[] };
    if (tiny.n >= 3) {
      out.push(
        finding({
          category: "mobile",
          rule: "mobile-small-text",
          severity: "low",
          title: `${tiny.n} blocks of text smaller than 12px on phones`,
          detail: "Small text is hard to read on a phone. Use at least 14px for body text and 12px for footnotes.",
          pageUrl: url,
          evidence: tiny.samples.join("\n"),
        }),
      );
    }
    // axe's WCAG 2.2 target-size rule, run at phone width. Unlike a plain size count it skips
    // links inside sentences and small targets that have enough space around them.
    out.push(...(await tapTargetFindings(page, url)));
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Text left over from development: lorem ipsum, {{template}} tags, "undefined" and "NaN". */
export const contentAgent: PageAgent = {
  id: "web.content",
  name: "Content mistakes",
  description: 'Finds leftovers visitors should never see: lorem ipsum, unfilled {{template}} tags, "undefined", "NaN" or "[object Object]" on the page, and an out-of-date copyright year.',
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const facts = (await page.evaluate(`(function () {
      var text = document.body ? document.body.innerText : "";
      var bad = [];
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode()) && bad.length < 10) {
        var t = (node.textContent || "").trim();
        var parent = node.parentElement;
        if (!t || !parent || /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA)$/.test(parent.tagName)) continue;
        if (!parent.getClientRects().length) continue;
        if (/^(undefined|null|NaN)$/.test(t) || /\\[object Object\\]/.test(t) || /(^|[\\s$₹€£])NaN(\\s|%|$)/.test(t) || /(^|\\s)undefined(\\s|$)/.test(t) && t.length < 40)
          bad.push(t.slice(0, 80));
      }
      return { text: text.slice(0, 200000), bad: bad };
    })()`)) as { text: string; bad: string[] };

    const out: Finding[] = [];
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string) =>
      out.push(finding({ category: "functional", rule, severity, title, detail, pageUrl: url, evidence }));

    const lorem = facts.text.match(/.{0,40}\b(lorem ipsum|dolor sit amet)\b.{0,40}/i);
    if (lorem) {
      add("content:placeholder", "medium", "Placeholder text (lorem ipsum) on the page", "Dummy text from the design stage was never replaced with real content.", lorem[0]);
    }
    const token = facts.text.match(/\{\{\s*[\w.]+\s*\}\}|\{%\s*\w+[^%]*%\}|%%[A-Z_]+%%|\[\[[\w.]+\]\]/);
    if (token) {
      add("content:template-tag", "medium", "Unfilled template tag on the page", "A placeholder such as {{name}} is shown instead of real data. The template or the data behind it is broken.", token[0]);
    }
    if (facts.bad.length) {
      add(
        "content:broken-value",
        "medium",
        'The page shows "undefined", "NaN" or "[object Object]"',
        "A value failed to load or calculate and the raw programming value is shown to visitors. This often hits prices, totals and names.",
        facts.bad.join("\n"),
      );
    }
    const now = new Date();
    const years = [...facts.text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
    const latest = Math.max(0, ...years);
    if (latest >= 1990 && latest < now.getFullYear() && now.getMonth() >= 1) {
      add("content:copyright-old", "low", `Copyright year is ${latest}`, "An old year in the footer makes the site look unmaintained. Show the current year (most site builders can do this automatically).", `© ${latest}`);
    }
    return out;
  },
};

export const formsAgent: PageAgent = {
  id: "web.forms",
  name: "Forms",
  description: "Checks forms: passwords on pages without HTTPS, data sent over plain HTTP, fields that would not be submitted, and email fields that show the wrong phone keyboard.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const forms = (await page.evaluate(`(function () {
      var out = [];
      var forms = document.querySelectorAll("form");
      for (var i = 0; i < forms.length && i < 50; i++) {
        var f = forms[i];
        var actionAttr = f.getAttribute("action");
        var fields = f.querySelectorAll("input, select, textarea");
        var unnamed = 0, password = false, emailAsText = [];
        for (var j = 0; j < fields.length; j++) {
          var el = fields[j];
          var type = (el.getAttribute("type") || "text").toLowerCase();
          if (/^(submit|button|reset|image|hidden)$/.test(type)) continue;
          if (type === "password") password = true;
          if (!el.getAttribute("name")) unnamed++;
          var hint = ((el.getAttribute("name") || "") + " " + (el.id || "") + " " + (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("autocomplete") || "")).toLowerCase();
          if (el.tagName === "INPUT" && type === "text" && /e-?mail/.test(hint)) emailAsText.push(el.getAttribute("name") || el.id || "email");
        }
        out.push({ action: actionAttr ? f.action : "", hasAction: !!actionAttr && !/^(#|javascript:)/i.test(actionAttr), method: (f.getAttribute("method") || "get").toLowerCase(), unnamed: unnamed, fields: fields.length, password: password, emailAsText: emailAsText, id: f.id || f.getAttribute("name") || ("form " + (i + 1)) });
      }
      return out;
    })()`)) as {
      action: string;
      hasAction: boolean;
      method: string;
      unnamed: number;
      fields: number;
      password: boolean;
      emailAsText: string[];
      id: string;
    }[];

    const out: Finding[] = [];
    const add = (category: Finding["category"], rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string) =>
      out.push(finding({ category, rule, severity, title, detail, pageUrl: url, evidence }));
    const pageIsHttps = url.startsWith("https://");

    for (const f of forms) {
      if (f.password && !pageIsHttps) {
        add("security", "sec:password-over-http", "critical", "Password field on a page without HTTPS", "Passwords typed here travel unencrypted and can be read on public Wi-Fi. Serve this page over HTTPS.", f.id);
      }
      if (pageIsHttps && f.hasAction && f.action.startsWith("http://")) {
        add("security", "sec:form-over-http", "high", "Form sends data over plain HTTP", "The page is secure but the form posts to an http:// address, so what visitors type is sent unencrypted. Change the form action to https://.", `${f.id}: ${f.action}`);
      }
      if (f.hasAction && f.method === "post" && f.unnamed > 0) {
        add("functional", "forms:unnamed-fields", "medium", `${f.unnamed} form field(s) have no name and will not be sent`, "Browsers only submit fields that have a name attribute, so whatever visitors type in these is lost.", f.id);
      }
      if (f.emailAsText.length) {
        add("mobile", "forms:email-type", "low", "Email field uses a plain text box", 'Use <input type="email"> so phones show the @ keyboard and the browser checks the address.', f.emailAsText.join(", "));
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Known analytics, advertising and session-recording hosts. */
const TRACKERS: [RegExp, string][] = [
  [/(^|\.)google-analytics\.com$|(^|\.)googletagmanager\.com$|(^|\.)analytics\.google\.com$/, "Google Analytics / Tag Manager"],
  [/(^|\.)doubleclick\.net$|(^|\.)googleadservices\.com$|(^|\.)googlesyndication\.com$/, "Google Ads"],
  [/(^|\.)connect\.facebook\.net$/, "Meta (Facebook) Pixel"],
  [/(^|\.)hotjar\.com$|(^|\.)hotjar\.io$/, "Hotjar"],
  [/(^|\.)clarity\.ms$/, "Microsoft Clarity"],
  [/(^|\.)bat\.bing\.com$/, "Microsoft Ads"],
  [/(^|\.)snap\.licdn\.com$|(^|\.)px\.ads\.linkedin\.com$/, "LinkedIn Insight"],
  [/(^|\.)analytics\.tiktok\.com$/, "TikTok Pixel"],
  [/(^|\.)mc\.yandex\.ru$/, "Yandex Metrica"],
  [/(^|\.)mixpanel\.com$/, "Mixpanel"],
  [/(^|\.)cdn\.segment\.com$|(^|\.)api\.segment\.io$/, "Segment"],
];

/** Names of the trackers among the requested URLs. */
export function trackersIn(urls: string[]): string[] {
  const found = new Set<string>();
  for (const u of urls) {
    let host = "";
    try {
      host = new URL(u).hostname;
    } catch {
      continue;
    }
    for (const [re, name] of TRACKERS) if (re.test(host)) found.add(name);
  }
  return [...found];
}

export const privacyAgent: PageAgent = {
  id: "web.privacy",
  name: "Privacy and cookie consent",
  description: "Lists the analytics and ad trackers the site loads, and checks there is a cookie consent banner when it does (GDPR, India's DPDP Act).",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  async run({ page, url, isFirst, signals }) {
    if (!isFirst) return [];
    const trackers = trackersIn(signals.requests);
    if (!trackers.length) return [];
    const hasConsent = (await page.evaluate(`(function () {
      var cmp = /cookiebot|onetrust|cookieyes|iubenda|termly|complianz|usercentrics|quantcast|didomi|cookie-?law|osano|klaro|tarteaucitron|consent/i;
      var scripts = document.querySelectorAll("script[src]");
      for (var i = 0; i < scripts.length; i++) if (cmp.test(scripts[i].src)) return true;
      var els = document.querySelectorAll("[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i]");
      for (var j = 0; j < els.length; j++) if (els[j].getClientRects().length) return true;
      return /accept (all )?cookies|cookie (settings|preferences)|we use cookies/i.test(document.body ? document.body.innerText : "");
    })()`)) as boolean;
    if (hasConsent) return [];
    return [
      finding({
        category: "security",
        rule: "privacy:no-consent",
        severity: "medium",
        title: "Tracking starts without a cookie consent banner",
        detail: "The site loads trackers but shows no way to accept or refuse them. The EU's GDPR and India's DPDP Act expect consent first. Add a consent banner and load trackers only after visitors agree (Google Consent Mode can help).",
        pageUrl: url,
        evidence: trackers.join("\n"),
      }),
    ];
  },
};

export const structuredDataAgent: PageAgent = {
  id: "web.structured-data",
  name: "Structured data",
  description: "Checks schema.org JSON-LD for syntax errors, and that store product pages describe their product for Google rich results.",
  category: "seo",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url, product }) {
    const data = (await page.evaluate(`(function () {
      var blocks = [];
      var s = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < s.length; i++) blocks.push(s[i].textContent || "");
      var og = document.querySelector('meta[property="og:type"]');
      return { blocks: blocks, ogType: og ? og.getAttribute("content") : "", hasPrice: !!document.querySelector('[itemprop="price"], .price, .woocommerce-Price-amount, [data-product-price]') };
    })()`)) as { blocks: string[]; ogType: string; hasPrice: boolean };

    const out: Finding[] = [];
    const types: string[] = [];
    const broken: string[] = [];
    for (const b of data.blocks) {
      try {
        const json = JSON.parse(b);
        const nodes = [json, ...(Array.isArray(json) ? json : []), ...(json?.["@graph"] ?? [])];
        for (const n of nodes) {
          const t = n?.["@type"];
          if (t) types.push(...(Array.isArray(t) ? t : [t]));
        }
      } catch (e) {
        broken.push(`${(e as Error).message.slice(0, 80)}: ${b.trim().slice(0, 80)}`);
      }
    }
    if (broken.length) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:structured-data-invalid",
          severity: "medium",
          title: "Structured data (JSON-LD) has a syntax error",
          detail: "Google ignores structured data it cannot read, so rich results (stars, prices, FAQs) will not show. Test it at search.google.com/test/rich-results and fix the JSON.",
          pageUrl: url,
          evidence: broken.join("\n"),
        }),
      );
    }
    const looksLikeProduct = /product/i.test(data.ogType) || (/\/products?\//i.test(new URL(url).pathname) && data.hasPrice);
    if (product === "ecommerce" && looksLikeProduct && !types.some((t) => /product/i.test(String(t)))) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:product-schema-missing",
          severity: "low",
          title: "Product page has no Product structured data",
          detail: "Without schema.org/Product, Google cannot show price, stock and reviews in search results. Shopify themes and WooCommerce SEO plugins can add it.",
          pageUrl: url,
        }),
      );
    }
    return out;
  },
};
