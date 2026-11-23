import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";
import { getText } from "./geo.js";

/* ============================================================================================== */
/* Local SEO: name/address/phone the same everywhere, LocalBusiness schema, map, Google Business.  */

/** Phone numbers and a postal-code-ish address hint found in the page text. Pure, for tests. */
export function extractNap(html: string): { phones: string[]; hasAddress: boolean } {
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ");
  const phones = [...new Set((text.match(/(?:\+?\d[\d ().-]{7,}\d)/g) ?? []).map((p) => p.replace(/[^\d+]/g, "")).filter((p) => p.replace(/\D/g, "").length >= 8 && p.replace(/\D/g, "").length <= 13))];
  const hasAddress = /\b(street|road|lane|avenue|marg|nagar|sector|floor|suite|p\.?o\.?\s*box)\b/i.test(text) || /\b\d{6}\b/.test(text) || /\b\d{5}(?:-\d{4})?\b/.test(text);
  return { phones, hasAddress };
}

async function localSeoFindings({ browser, origin, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string, pageUrl: string, evidence?: string) => out.push(finding({ category: "seo", rule, severity, title, detail, pageUrl, evidence }));
  const sample = pages.filter((p) => p.status !== null && p.status < 400).slice(0, 10);
  const naps: { url: string; phones: string[] }[] = [];
  let hasLocalBusiness = false;
  let hasMap = false;
  let hasGbp = false;
  let anyAddress = false;
  for (const p of sample) {
    const got = await getText(browser.request, p.url);
    if (!got || got.status >= 400 || !/html/i.test(got.type)) continue;
    const html = got.text;
    const nap = extractNap(html);
    naps.push({ url: p.url, phones: nap.phones });
    anyAddress ||= nap.hasAddress;
    if (/"@type"\s*:\s*"?(LocalBusiness|Store|Restaurant|ProfessionalService|Dentist|MedicalBusiness|[A-Za-z]+Business)"?/.test(html)) hasLocalBusiness = true;
    if (/google\.com\/maps|maps\.google|goo\.gl\/maps|openstreetmap|<iframe[^>]+maps/i.test(html)) hasMap = true;
    if (/g\.page\/|business\.google|google\.com\/maps\/place|places\.googleapis/i.test(html)) hasGbp = true;
  }
  if (!naps.length) {
    log("Local SEO: no page could be read");
    return out;
  }
  if (!hasLocalBusiness) add("seo:no-localbusiness-schema", "medium", "No LocalBusiness schema", "A business with a physical place should add LocalBusiness JSON-LD (name, address, phone, opening hours, geo) so Google and maps show it correctly and it can appear in the local pack.", naps[0].url);
  const phoneSets = naps.filter((n) => n.phones.length).map((n) => n.phones[0]);
  const distinct = new Set(phoneSets);
  if (distinct.size > 1) add("seo:nap-phone-mismatch", "low", "The phone number differs between pages", "Keep the name, address and phone (NAP) identical on every page and matching your Google Business Profile; mismatches confuse local ranking and customers.", naps[0].url, [...distinct].slice(0, 6).join("\n"));
  if (!anyAddress && !hasLocalBusiness) add("seo:no-address", "low", "No address found on the site", "If this is a local business, show the full address in the footer (as text, not only an image) and in LocalBusiness schema.", naps[0].url);
  if (!hasMap && (hasLocalBusiness || anyAddress)) add("seo:no-map", "info", "No map embed found", "A map (Google Maps or OpenStreetMap embed) on the contact page helps customers and confirms the location.", naps[0].url);
  if (!hasGbp && (hasLocalBusiness || anyAddress)) add("seo:no-gbp-link", "info", "No link to a Google Business Profile", "Link to your Google Business Profile (g.page or a Maps place link) so visitors can see reviews and directions, and to tie the site to the verified listing.", naps[0].url);
  return out;
}

export const localSeoAgent: SiteAgent = {
  id: "seo.local",
  name: "Local SEO",
  description: "For businesses with a physical place: LocalBusiness schema, a consistent name/address/phone across pages, a map embed and a Google Business Profile link.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run: localSeoFindings,
};

/* ============================================================================================== */
/* hreflang and international SEO depth: return links, valid language codes, x-default.             */

export interface Hreflang {
  lang: string;
  href: string;
}

/** Reads hreflang <link> tags from HTML. Pure, for tests. */
export function parseHreflang(html: string): Hreflang[] {
  const out: Hreflang[] = [];
  for (const m of html.matchAll(/<link\b[^>]*rel=["']alternate["'][^>]*>/gi)) {
    const tag = m[0];
    const lang = tag.match(/hreflang=["']([^"']+)["']/i)?.[1];
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    if (lang && href) out.push({ lang: lang.toLowerCase(), href });
  }
  return out;
}

const LANG_OK = /^[a-z]{2,3}(-[a-z]{4})?(-[a-z]{2}|-\d{3})?$|^x-default$/i;

/** Problems in a set of hreflang tags for one page. Pure, for tests. */
export function hreflangProblems(tags: Hreflang[]): string[] {
  const out: string[] = [];
  if (!tags.length) return out;
  const bad = tags.filter((t) => !LANG_OK.test(t.lang));
  if (bad.length) out.push(`Invalid language code(s): ${bad.map((b) => b.lang).join(", ")}. Use ISO codes like "en", "en-in", "hi".`);
  if (!tags.some((t) => t.lang === "x-default")) out.push('No x-default hreflang: add one pointing to the default/chooser page for visitors whose language you do not target.');
  const dupes = tags.map((t) => t.lang).filter((l, i, a) => a.indexOf(l) !== i);
  if (dupes.length) out.push(`The same hreflang appears more than once: ${[...new Set(dupes)].join(", ")}.`);
  return out;
}

async function hreflangFindings({ browser, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const sample = pages.filter((p) => p.status !== null && p.status < 400).slice(0, 12);
  const byPage = new Map<string, Hreflang[]>();
  for (const p of sample) {
    const got = await getText(browser.request, p.url);
    if (!got || got.status >= 400 || !/html/i.test(got.type)) continue;
    const tags = parseHreflang(got.text);
    if (tags.length) byPage.set(got.url, tags);
  }
  if (!byPage.size) {
    log("hreflang: no page declares hreflang (single-language site, or none set)");
    return out;
  }
  for (const [url, tags] of byPage) {
    for (const problem of hreflangProblems(tags)) out.push(finding({ category: "seo", rule: `seo:hreflang-${/x-default/.test(problem) ? "no-x-default" : /Invalid/.test(problem) ? "bad-lang" : "duplicate"}`, severity: "low", title: "hreflang problem", detail: problem, pageUrl: url, evidence: tags.map((t) => `${t.lang} → ${t.href}`).slice(0, 8).join("\n") }));
  }
  // Return-link check: each target page should name this page back.
  const pagesWithHreflang = [...byPage.keys()];
  const first = pagesWithHreflang[0];
  const tags = byPage.get(first)!;
  for (const t of tags.filter((x) => x.lang !== "x-default").slice(0, 4)) {
    const target = await getText(browser.request, t.href).catch(() => null);
    if (!target || target.status >= 400 || !/html/i.test(target.type)) continue;
    const back = parseHreflang(target.text);
    if (back.length && !back.some((b) => b.href.replace(/\/$/, "") === first.replace(/\/$/, ""))) {
      out.push(finding({ category: "seo", rule: "seo:hreflang-no-return", severity: "medium", title: "hreflang has no return link", detail: `${first} points to ${t.href} with hreflang, but ${t.href} does not point back. Google ignores hreflang unless both pages name each other. Add the return <link rel="alternate" hreflang>.`, pageUrl: first, evidence: `${first}\n→ ${t.href} (no return link)` }));
    }
  }
  return out;
}

export const hreflangAgent: SiteAgent = {
  id: "seo.hreflang",
  name: "hreflang and international SEO",
  description: "For multi-language sites: valid hreflang language codes, an x-default, no duplicates, and return links (each language version must point back), which Google requires.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run: hreflangFindings,
};

/* ============================================================================================== */
/* Social preview: Open Graph and Twitter cards, og:image size (WhatsApp, LinkedIn, X).            */

/** Problems with a page's social-preview tags. Pure, for tests. */
export function socialProblems(html: string): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const meta = (prop: string) => new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
  const content = (tag: string) => tag.match(/content=["']([^"']*)["']/i)?.[1] ?? "";
  const ogTitle = meta("og:title");
  const ogImage = meta("og:image");
  const ogDesc = meta("og:description");
  const twCard = meta("twitter:card");
  if (!ogTitle) out.push({ rule: "seo:no-og-title", severity: "low", title: "No og:title", detail: "Add Open Graph tags (og:title, og:description, og:image, og:url) so links shared on WhatsApp, LinkedIn, Facebook and Slack show a proper preview card." });
  if (!ogImage) out.push({ rule: "seo:no-og-image", severity: "low", title: "No og:image", detail: "Add an og:image (1200×630px, under 5 MB, absolute https URL) so shared links show a picture instead of a bare link." });
  else if (!/^https:\/\//i.test(content(ogImage))) out.push({ rule: "seo:og-image-relative", severity: "low", title: "og:image is not an absolute https URL", detail: "og:image must be a full https:// URL; relative paths are not fetched by WhatsApp and most scrapers." });
  if (!ogDesc) out.push({ rule: "seo:no-og-description", severity: "info", title: "No og:description", detail: "Add og:description (about 2 lines) so the shared card has a summary." });
  if (!twCard) out.push({ rule: "seo:no-twitter-card", severity: "info", title: "No twitter:card", detail: 'Add twitter:card="summary_large_image" (and twitter:image) for a large preview on X.' });
  return out;
}

async function socialFindings({ browser, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const home = pages[0];
  if (!home) return out;
  const got = await getText(browser.request, home.url);
  if (!got || got.status >= 400 || !/html/i.test(got.type)) {
    log("Social preview: home page could not be read");
    return out;
  }
  for (const p of socialProblems(got.text)) out.push(finding({ category: "seo", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: home.url }));
  return out;
}

export const socialPreviewAgent: SiteAgent = {
  id: "seo.social",
  name: "Social preview cards",
  description: "Checks the Open Graph and Twitter card tags so links shared on WhatsApp, LinkedIn, Facebook and X show a title, description and image instead of a bare link.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run: socialFindings,
};
