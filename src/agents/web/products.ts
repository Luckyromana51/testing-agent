import { request as playwrightRequest } from "playwright";
import { finding } from "../../runner/finding.js";
import type { Finding, ProductType } from "../../types.js";
import type { PageAgent, SiteAgent } from "../types.js";

/**
 * Checks that only make sense for one kind of product: an online store's policies, product pages
 * and checkout; and for web apps, SaaS and CRMs, the pages behind the login.
 */

const STORE: ProductType[] = ["ecommerce"];
const APPS: ProductType[] = ["webapp", "saas", "crm"];

const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return (x.pathname + x.search).toLowerCase();
  } catch {
    return "";
  }
};

// ---------------------------------------------------------------------------------------------
// Online store

/** The pages Indian (and most) e-commerce rules expect a store to link to, and how to recognise them. */
const POLICY_PAGES: { what: string; re: RegExp; why: string }[] = [
  {
    what: "return and refund policy",
    re: /refund|return|cancell?ation|exchange/,
    why: "Shoppers look for it before paying, payment gateways (Razorpay, PayU, Stripe) ask for it, and the Consumer Protection (E-Commerce) Rules, 2020 require it for stores selling in India.",
  },
  {
    what: "shipping and delivery policy",
    re: /shipping|delivery|dispatch/,
    why: "Shoppers want to know delivery times and charges before they buy, and payment gateways ask for this page when you apply.",
  },
  { what: "terms and conditions", re: /terms|conditions|\btos\b|legal/, why: "It sets the rules of sale and protects the business in disputes." },
  {
    what: "privacy policy",
    re: /privacy/,
    why: "A store collects names, addresses and phone numbers, so the DPDP Act 2023 (and GDPR for EU buyers) expects a privacy notice.",
  },
  { what: "contact page", re: /contact|support|help|grievance/, why: "Shoppers need a way to reach the seller; the 2020 e-commerce rules also ask for a grievance officer's contact." },
];

export const storePoliciesAgent: SiteAgent = {
  id: "store.policies",
  name: "Store policies",
  description: "Checks the store links to its refund, shipping, terms, privacy and contact pages, which shoppers and payment gateways look for.",
  category: "functional",
  engine: "web",
  products: STORE,
  stage: "site",
  run({ linkSources, pages, startUrl }) {
    const out: Finding[] = [];
    const seen = [...linkSources.keys(), ...pages.map((p) => p.url)].map(pathOf);
    for (const p of POLICY_PAGES) {
      if (seen.some((s) => p.re.test(s))) continue;
      out.push(
        finding({
          category: "functional",
          rule: "store:missing-policy",
          severity: p.what.startsWith("return") ? "high" : "medium",
          title: `No link to a ${p.what}`,
          detail: `None of the pages tested link to a ${p.what}. ${p.why} Add the page and link it from the footer.`,
          pageUrl: startUrl,
          evidence: p.what,
        }),
      );
    }
    return out;
  },
};

export const storeProductAgent: PageAgent = {
  id: "store.product",
  name: "Product pages",
  description: "On product pages, checks a price is shown, there is a way to buy, and the price and stock are in the product data.",
  category: "functional",
  engine: "web",
  products: STORE,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const facts = (await page.evaluate(`(function () {
      var product = null;
      var s = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < s.length && !product; i++) {
        try {
          var j = JSON.parse(s[i].textContent || "");
          var nodes = [j].concat(Array.isArray(j) ? j : []).concat((j && j["@graph"]) || []);
          for (var k = 0; k < nodes.length; k++) {
            var t = nodes[k] && nodes[k]["@type"];
            if (t === "Product" || (Array.isArray(t) && t.indexOf("Product") >= 0)) { product = nodes[k]; break; }
          }
        } catch (e) {}
      }
      var og = document.querySelector('meta[property="og:type"]');
      var isProduct = !!product || (og && /product/i.test(og.getAttribute("content") || ""));
      var text = (document.body && document.body.innerText) || "";
      var buy = Array.prototype.some.call(document.querySelectorAll('button, input[type=submit], a[role=button], a.button, a.btn'), function (b) {
        return /add to (cart|bag|basket)|buy now|order now|add to order/i.test((b.innerText || b.value || "").trim());
      });
      var offers = product && product.offers ? (Array.isArray(product.offers) ? product.offers[0] : product.offers) : null;
      return {
        isProduct: !!isProduct,
        visiblePrice: /(₹|rs\\.?\\s?|inr\\s?|\\$|€|£|usd\\s?|aed\\s?)\\s?\\d/i.test(text),
        buy: buy,
        hasProductData: !!product,
        price: offers ? String(offers.price || offers.lowPrice || "") : "",
        currency: offers ? String(offers.priceCurrency || "") : "",
        availability: offers ? String(offers.availability || "") : "",
        name: product ? String(product.name || "") : "",
      };
    })()`)) as {
      isProduct: boolean;
      visiblePrice: boolean;
      buy: boolean;
      hasProductData: boolean;
      price: string;
      currency: string;
      availability: string;
      name: string;
    };
    if (!facts.isProduct) return [];
    const out: Finding[] = [];
    const outOfStock = /OutOfStock|SoldOut|Discontinued/i.test(facts.availability);
    if (!facts.visiblePrice) {
      out.push(
        finding({
          category: "functional",
          rule: "store:no-price",
          severity: "high",
          title: "Product page shows no price",
          detail: "Shoppers leave when they cannot see the price, and Google Shopping rejects products without one. Show the price near the product name.",
          pageUrl: url,
          evidence: facts.name || undefined,
        }),
      );
    }
    if (!facts.buy && !outOfStock) {
      out.push(
        finding({
          category: "functional",
          rule: "store:no-buy-button",
          severity: "medium",
          title: "No Add to cart or Buy button on a product page",
          detail: "The page describes a product but has no visible button to buy it (Add to cart, Buy now). If the product is out of stock, say so in the page and the product data.",
          pageUrl: url,
          evidence: facts.name || undefined,
        }),
      );
    }
    if (facts.hasProductData && (!facts.price || !facts.currency || !facts.availability)) {
      const missing = [!facts.price && "price", !facts.currency && "priceCurrency", !facts.availability && "availability"].filter(Boolean).join(", ");
      out.push(
        finding({
          category: "seo",
          rule: "store:product-data-incomplete",
          severity: "medium",
          title: "Product data is missing the price or stock",
          detail: `The product's structured data has no ${missing}. Google needs these to show the price and stock in search results and Shopping. Most store plugins fill them in when the product has a price and stock status.`,
          pageUrl: url,
          evidence: `missing: ${missing}`,
        }),
      );
    }
    return out;
  },
};

/** Payment and checkout services whose scripts are expected on a checkout page. */
const PAYMENT_HOSTS =
  /(^|\.)(razorpay\.com|payu\.in|payumoney\.com|cashfree\.com|paytm\.(com|in)|phonepe\.com|stripe\.com|stripe\.network|paypal\.com|paypalobjects\.com|braintreegateway\.com|ccavenue\.com|instamojo\.com|juspay\.in|shopify\.com|shopifycdn\.com|cdn\.shopify\.com|google\.com|gstatic\.com|recaptcha\.net|hcaptcha\.com|cloudflare\.com|challenges\.cloudflare\.com)$/i;

export const storeCheckoutAgent: PageAgent = {
  id: "store.checkout",
  name: "Checkout safety",
  description: "On cart and checkout pages, counts scripts from other websites (card-skimming risk) and checks for a Content Security Policy.",
  category: "security",
  engine: "web",
  products: STORE,
  stage: "end",
  skipErrorPages: true,
  async run({ page, url, response }) {
    if (!/\/(cart|checkout|basket|bag|payment|pay|order)(\/|\?|$|-)/.test(pathOf(url))) return [];
    const site = new URL(url).hostname.replace(/^www\./, "");
    const scripts = (await page.$$eval("script[src]", (els) => els.map((e) => (e as HTMLScriptElement).src))).filter(Boolean);
    const others = new Set<string>();
    for (const src of scripts) {
      try {
        const host = new URL(src).hostname;
        if (host === site || host.endsWith(`.${site}`) || PAYMENT_HOSTS.test(host)) continue;
        others.add(host);
      } catch {
        /* inline or broken src */
      }
    }
    const out: Finding[] = [];
    if (others.size >= 4) {
      out.push(
        finding({
          category: "security",
          rule: "store:checkout-third-party-scripts",
          severity: others.size >= 8 ? "high" : "medium",
          title: `Checkout page runs scripts from ${others.size} other websites`,
          detail:
            "Any of these scripts can read what shoppers type, including card details, if its website is hacked (card skimming, as in the Magecart attacks). Keep only what checkout needs; PCI DSS 4.0 (rule 6.4.3) asks stores to list and approve every script on payment pages.",
          pageUrl: url,
          evidence: [...others].slice(0, 12).join("\n"),
        }),
      );
    }
    const csp = response?.headers()["content-security-policy"];
    if (!csp) {
      out.push(
        finding({
          category: "security",
          rule: "store:checkout-no-csp",
          severity: "medium",
          title: "Checkout page has no Content Security Policy",
          detail:
            "A Content Security Policy tells the browser which websites may run scripts on the page, so an injected skimmer cannot send card details elsewhere. Add one to the cart and checkout pages, starting in report-only mode.",
          pageUrl: url,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Web apps, SaaS and CRMs: the pages behind the login

const LOGOUT_LINK = /\/(log-?out|sign-?out|logoff)(\/|\?|$)|[?&](action|do)=logout/i;
const LOGOUT_TEXT = /\b(log ?out|sign ?out|log off)\b/i;

/**
 * True when the text shows this user's own name or email. Short or common user names ("admin")
 * appear on many pages, so only an email, or a name of 6 or more characters as a whole word, counts.
 */
export function showsUser(text: string, user?: string): boolean {
  if (!user) return false;
  const u = user.trim().toLowerCase();
  const t = text.toLowerCase();
  if (u.includes("@")) return u.length >= 6 && t.includes(u);
  if (u.length < 6 || /^(admin|administrator|tester|test|user|demo|guest)$/.test(u)) return false;
  return new RegExp(`(^|[^a-z0-9_.-])${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9_-])`).test(t);
}

/** Signs that a page is showing a signed-in user's view: a log-out link, or the user's own name or email. */
function privateMarkers(html: string, user?: string): { logout?: string; user: boolean } {
  let logout: string | undefined;
  if (/href=["'][^"']*(\/(log-?out|sign-?out|logoff)\b|[?&](action|do)=logout)/i.test(html)) logout = "a log-out link";
  else if (/>\s*(log ?out|sign ?out|log off)\s*</i.test(html)) logout = "a log-out button";
  return { logout, user: showsUser(html, user) };
}

export const privatePagesAgent: SiteAgent = {
  id: "app.private-pages",
  name: "Private pages need a login",
  description: "Opens the signed-in pages again without the login, to find private pages anyone can open.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  async run({ browser, pages, site, log }) {
    const loaded = pages.filter((p) => p.status !== null && p.status < 400 && !p.error).slice(0, 15);
    if (!loaded.length) return [];
    log(`Opening ${loaded.length} signed-in pages again without the login`);
    const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
    // A fresh client with no cookies: exactly what a stranger gets.
    const stranger = await playwrightRequest.newContext({
      ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.4",
    });
    const out: Finding[] = [];
    try {
      for (const p of loaded) {
        const signedIn = await browser.request.get(p.url, { timeout: 15_000, maxRedirects: 5 }).catch(() => null);
        if (!signedIn || signedIn.status() >= 400) continue;
        const mine = privateMarkers(await signedIn.text().catch(() => ""), site.loginUser);
        // Only pages that show the signed-in view in their HTML can be compared reliably.
        if (!mine.logout && !mine.user) continue;
        const anon = await stranger.get(p.url, { timeout: 15_000, maxRedirects: 5 }).catch(() => null);
        if (!anon || anon.status() >= 400) continue;
        const html = await anon.text().catch(() => "");
        if (/type=["']?password/i.test(html)) continue; // sent to a sign-in form: protected
        const theirs = privateMarkers(html, site.loginUser);
        if (!theirs.user && !theirs.logout) continue;
        const shows = [theirs.user && "the signed-in user's name or email", theirs.logout].filter(Boolean).join(" and ");
        out.push(
          finding({
            category: "security",
            rule: "app:private-page-public",
            // The user's own details on a stranger's screen is proof; a log-out link alone is a strong sign.
            severity: theirs.user ? "critical" : "high",
            title: theirs.user ? "Private page opens without signing in" : "Private page seems to open without signing in",
            detail: `${p.url} is meant for signed-in users, but a visitor with no login gets it too (HTTP ${anon.status()}, showing ${shows}). Anyone with the address can read it. Check the login check (middleware) covers this route.`,
            pageUrl: p.url,
            evidence: `Without a login: HTTP ${anon.status()}, shows ${shows}`,
          }),
        );
      }
    } finally {
      await stranger.dispose();
    }
    return out;
  },
};

export const privateCacheAgent: PageAgent = {
  id: "app.private-cache",
  name: "Private pages not cached",
  description: "Checks signed-in pages tell browsers and proxies not to keep a copy (Cache-Control: no-store or private).",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "page",
  skipErrorPages: true,
  needsLogin: true,
  async run({ page, url, response, site }) {
    if (!response) return [];
    const links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href + " " + (a.textContent ?? "")));
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const isPrivate = links.some((l) => LOGOUT_LINK.test(l.split(" ")[0]) || LOGOUT_TEXT.test(l)) || showsUser(text, site.loginUser);
    if (!isPrivate) return [];
    const cc = (response.headers()["cache-control"] ?? "").toLowerCase();
    if (/no-store|private/.test(cc)) return [];
    return [
      finding({
        category: "security",
        rule: "app:private-page-cacheable",
        severity: "medium",
        title: "Signed-in pages can be kept by browsers and proxies",
        detail:
          "These pages show a signed-in user's data but do not send Cache-Control: no-store (or private). A shared computer's browser, or a proxy on the way, can keep a copy that the next person sees, even after logging out. Send Cache-Control: no-store on every signed-in page.",
        pageUrl: url,
        evidence: cc ? `Cache-Control: ${cc}` : "no Cache-Control header",
      }),
    ];
  },
};

const EMAIL_IN_URL = /[\w.+-]+(%40|@)[\w-]+\.[\w.-]{2,}/i;
const PHONE_IN_URL = /[?&][^=]*(phone|mobile|tel|whatsapp|contact)[^=]*=\+?(91)?[6-9]\d{9}\b|[?&=/](\+|%2B)?91[6-9]\d{9}\b/i;

export const dataInUrlAgent: SiteAgent = {
  id: "app.data-in-url",
  name: "Personal data in addresses",
  description: "Finds e-mail addresses and phone numbers in page addresses, where they leak into logs, analytics and other sites.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  run({ linkSources, pages, startUrl }) {
    const all = [...new Set([...pages.map((p) => p.url), ...linkSources.keys()])];
    const hits = all.filter((u) => {
      try {
        const x = new URL(u);
        if (x.origin !== new URL(startUrl).origin) return false;
        const where = decodeURIComponent(x.pathname + x.search);
        return EMAIL_IN_URL.test(where) || PHONE_IN_URL.test(x.pathname + x.search);
      } catch {
        return false;
      }
    });
    if (!hits.length) return [];
    return [
      finding({
        category: "security",
        rule: "app:personal-data-in-url",
        severity: "medium",
        title: "Customers' e-mail addresses or phone numbers are in page addresses",
        detail: `${hits.length} address(es) carry personal data. Addresses are saved in server logs, browser history and analytics, and sent to other websites as the referrer, so the data leaks. Use record ids (or POST) instead of e-mails and phone numbers in links.`,
        pageUrl: hits[0],
        evidence: hits
          .slice(0, 5)
          .map((h) => h.replace(/([\w.+-])[\w.+-]*(%40|@)/g, "$1***$2").replace(/(\d{2})\d{6}(\d{2})/g, "$1******$2"))
          .join("\n"),
      }),
    ];
  },
};

export const saasTrustAgent: SiteAgent = {
  id: "saas.trust",
  name: "SaaS trust pages",
  description: "Checks a SaaS product links to pricing, terms, privacy and a refund or cancellation policy, which buyers and payment gateways expect.",
  category: "functional",
  engine: "web",
  products: ["saas"],
  stage: "site",
  run({ linkSources, pages, startUrl, site }) {
    // Signed in, the crawl sees the app rather than the marketing site.
    if (site.loggedIn) return [];
    const seen = [...linkSources.keys(), ...pages.map((p) => p.url)].map(pathOf);
    const want: [string, RegExp, string][] = [
      ["pricing page", /pricing|plans|price/, "Buyers compare plans before signing up; without prices most leave or email to ask."],
      ["terms of service", /terms|\btos\b|legal/, "Subscriptions need terms that cover billing, renewals and acceptable use."],
      ["privacy policy", /privacy/, "A SaaS stores customer data, so the DPDP Act 2023 (and GDPR for EU customers) expects a privacy notice."],
      ["refund or cancellation policy", /refund|cancel/, "Payment gateways (Razorpay, Stripe) and RBI rules on recurring payments expect customers to see how to cancel and get refunds."],
    ];
    return want
      .filter(([, re]) => !seen.some((s) => re.test(s)))
      .map(([what, , why]) =>
        finding({
          category: "functional",
          rule: "saas:missing-page",
          severity: "medium",
          title: `No link to a ${what}`,
          detail: `None of the pages tested link to a ${what}. ${why}`,
          pageUrl: startUrl,
          evidence: what,
        }),
      );
  },
};

export const PRODUCT_AGENTS = [storePoliciesAgent, storeProductAgent, storeCheckoutAgent, privatePagesAgent, privateCacheAgent, dataInUrlAgent, saasTrustAgent];
