import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS, WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { PageAgent, SiteAgent, SiteContext } from "../types.js";
import { getText } from "./geo.js";

/**
 * India pack: the Digital Personal Data Protection Act 2023 with the DPDP Rules 2025 (notified
 * November 2025, in force in phases by 2027), and the Guidelines for Indian Government Websites
 * (GIGW 3.0, 2023) with IS 17802 for accessibility.
 */

const strip = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** Links of a page: [text, absolute address]. */
export function linksOf(html: string, base: string): [string, string][] {
  const out: [string, string][] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      out.push([strip(m[3]).trim() || (m[0].match(/aria-label=["']([^"']+)/)?.[1] ?? ""), new URL(m[2].replace(/&amp;/g, "&"), base).href]);
    } catch {
      // Not an address.
    }
  }
  return out;
}

/** What a DPDP privacy notice must tell people (Section 5 of the Act and Rule 3), with how to recognise it. */
export const DPDP_ITEMS: { id: string; what: string; sign: RegExp; severity: Severity; ref: string }[] = [
  { id: "purpose", what: "what personal data is collected and the purpose of each", sign: /\b(purpose|we (collect|use) (your|the following)|personal (data|information) (we|that we) (collect|process))/i, severity: "medium", ref: "Section 5(1)(i), Rule 3(b)" },
  { id: "withdraw", what: "how to withdraw consent, as easily as it was given", sign: /\bwithdraw(al)?\b[^.]{0,80}\bconsent|\bconsent\b[^.]{0,80}\bwithdraw/i, severity: "high", ref: "Section 6(4), Rule 3(c)(i)" },
  { id: "rights", what: "the rights to access, correct, update and erase personal data", sign: /\b(erase|erasure|delete your (data|information|account)|correction|right to (access|correct|update))/i, severity: "medium", ref: "Sections 11 to 13, Rule 3(c)(ii)" },
  { id: "grievance", what: "a grievance officer or Data Protection Officer with contact details", sign: /\b(grievance (officer|redressal)|data protection officer|\bDPO\b|nodal officer)/i, severity: "high", ref: "Section 8(10), Rule 9 and Rule 14" },
  { id: "board", what: "the right to complain to the Data Protection Board of India", sign: /data protection board/i, severity: "medium", ref: "Section 5(1)(iii), Rule 3(c)(iii)" },
  { id: "nominate", what: "the right to nominate someone to act after death or incapacity", sign: /\bnominat(e|ion)\b/i, severity: "low", ref: "Section 14" },
  { id: "retention", what: "how long data is kept and when it is erased", sign: /\b(retain|retention|kept for|store (it|your data) for|delete(d)? after)\b/i, severity: "low", ref: "Section 8(7), Rule 8 (erasure after 3 years for large platforms)" },
  { id: "children", what: "how children's data is handled (verifiable parental consent under 18)", sign: /\b(child(ren)?|minor|under (the age of )?18|parent(al)? consent|guardian)\b/i, severity: "low", ref: "Section 9, Rule 10" },
  { id: "breach", what: "that people will be told about a personal data breach", sign: /\b(data )?breach\b/i, severity: "low", ref: "Section 8(6), Rule 7" },
];

/** Pure: which notice items a privacy policy's text is missing. */
export function missingDpdpItems(text: string): typeof DPDP_ITEMS {
  return DPDP_ITEMS.filter((i) => !i.sign.test(text));
}

/** Languages of India's Eighth Schedule, as language codes (DPDP Rule 3 lets people read the notice in any of them). */
export const INDIAN_LANGS = ["hi", "bn", "te", "mr", "ta", "ur", "gu", "kn", "ml", "or", "pa", "as", "mai", "sat", "ks", "ne", "kok", "sd", "doi", "mni", "brx", "sa"];
const INDIAN_LANG_WORDS = /(हिन्दी|हिंदी|বাংলা|తెలుగు|मराठी|தமிழ்|اردو|ગુજરાતી|ಕನ್ನಡ|മലയാളം|ଓଡ଼ିଆ|ਪੰਜਾਬੀ|অসমীয়া|\bhindi\b|\btamil\b|\btelugu\b|\bmarathi\b|\bbengali\b|\bkannada\b|\bmalayalam\b|\bgujarati\b)/i;

/** Pure: does the page offer an Indian language besides English? */
export function offersIndianLanguage(html: string): boolean {
  if (INDIAN_LANG_WORDS.test(strip(html))) return true;
  return [...html.matchAll(/hreflang=["']([a-z-]+)["']/gi)].some((m) => INDIAN_LANGS.includes(m[1].toLowerCase().split("-")[0]));
}

async function dpdpFindings({ browser, origin, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const home = await getText(browser.request, `${origin}/`);
  if (!home) throw new Error("The home page could not be read.");
  const add = (rule: string, severity: Severity, title: string, detail: string, pageUrl: string, evidence?: string) =>
    out.push(finding({ category: "security", rule, severity, title, detail, pageUrl, evidence }));
  // Find the privacy notice: a link on the home page, or a crawled page about privacy.
  const links = linksOf(home.text, home.url);
  const privacyUrl =
    links.find(([t, h]) => /privacy|data protection|गोपनीयता/i.test(t) || /privacy|data-protection/i.test(new URL(h).pathname))?.[1] ??
    pages.find((p) => /privacy|data-protection/i.test(p.url))?.url;
  if (!privacyUrl) {
    add(
      "dpdp:no-notice",
      "high",
      "No privacy notice linked from the home page",
      "The DPDP Act (Section 5) and Rule 3 need a clear notice, before or when asking for consent, of what personal data is collected and why, how to withdraw consent, and how to complain. Link a privacy notice from every page footer.",
      home.url,
    );
  } else {
    const notice = await getText(browser.request, privacyUrl, {}, 2_000_000);
    const text = notice && notice.status < 400 ? strip(notice.text) : "";
    if (!text) add("dpdp:notice-broken", "high", "The privacy notice link does not open", "The link to the privacy notice is broken, so people cannot read it.", privacyUrl, notice ? `Answered ${notice.status}` : "No answer");
    else {
      const missing = missingDpdpItems(text);
      for (const m of missing) {
        add(
          `dpdp:notice-no-${m.id}`,
          m.severity,
          `Privacy notice does not explain ${m.what}`,
          `India's DPDP Act needs the notice to tell people ${m.what} (${m.ref}). Add a short, plain-language section on it.`,
          privacyUrl,
        );
      }
      if (/\bgdpr\b/i.test(text) && !/\b(dpdp|digital personal data protection)\b/i.test(text)) {
        add("dpdp:notice-gdpr-only", "low", "Privacy notice is written for GDPR only", "It names the EU's GDPR but not India's DPDP Act 2023. Indian users have their own rights (nomination, the Data Protection Board) that the notice should name.", privacyUrl);
      }
      if (text.split(/\s+/).length > 6000) add("dpdp:notice-too-long", "low", "Privacy notice is very long", "Rule 3 asks for a notice that is clear and can be understood on its own. Put a one-screen summary at the top with the purposes, withdrawal and contact.", privacyUrl, `${text.split(/\s+/).length} words`);
    }
  }
  if (!offersIndianLanguage(home.text)) {
    add(
      "dpdp:english-only",
      "low",
      "Notice only in English",
      "DPDP Rule 3 and Section 5(3) give people the option to read the notice in English or any language of the Eighth Schedule. Offer at least Hindi (and the language of your main region).",
      home.url,
    );
  }
  log(`DPDP: privacy notice ${privacyUrl ?? "not found"}`);
  return out;
}

export const dpdpAgent: SiteAgent = {
  id: "india.dpdp",
  name: "India DPDP Act and Rules",
  description:
    "India's Digital Personal Data Protection Act 2023 and DPDP Rules 2025: a privacy notice is linked, it explains purposes, withdrawing consent, rights, the grievance officer, the Data Protection Board, children's data, retention and breaches, and it is offered in an Indian language.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: dpdpFindings,
};

/** Forms that collect personal data with no notice or consent next to them. */
export const dpdpFormsAgent: PageAgent = {
  id: "india.dpdp-forms",
  name: "Consent on forms (DPDP)",
  description: "Forms that ask for a phone number, email, Aadhaar or PAN must link the privacy notice and ask for consent with an unticked box (DPDP Act Sections 5 and 6).",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const forms = (await page.evaluate(`(function () {
      var out = [];
      var forms = document.querySelectorAll("form");
      for (var i = 0; i < forms.length; i++) {
        var f = forms[i];
        var r = f.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        var fields = f.querySelectorAll("input, textarea, select");
        var personal = [];
        for (var j = 0; j < fields.length; j++) {
          var el = fields[j];
          var key = ((el.name || "") + " " + (el.id || "") + " " + (el.type || "") + " " + (el.placeholder || "") + " " + (el.autocomplete || "")).toLowerCase();
          if (/password|search|q\\b/.test(key)) { if (/password/.test(key)) { personal = []; break; } continue; }
          if (/email|e-mail/.test(key)) personal.push("email");
          else if (/phone|mobile|tel|whatsapp/.test(key)) personal.push("phone");
          else if (/aadhaar|aadhar|\\bpan\\b|pan_?(no|number|card)/.test(key)) personal.push("ID number");
          else if (/\\b(dob|birth|address)\\b/.test(key)) personal.push("address or birth date");
        }
        if (!personal.length) continue;
        var text = (f.innerText || "") + " " + (f.parentElement ? f.parentElement.innerText : "");
        var links = f.querySelectorAll("a[href]");
        var privacyLink = false;
        for (var k = 0; k < links.length; k++) if (/privacy|data protection|terms/i.test(links[k].innerText + " " + links[k].href)) privacyLink = true;
        var consentBox = false, preTicked = false;
        var boxes = f.querySelectorAll("input[type=checkbox]");
        for (var m = 0; m < boxes.length; m++) {
          var lab = (boxes[m].closest("label") ? boxes[m].closest("label").innerText : (boxes[m].parentElement ? boxes[m].parentElement.innerText : "")) || "";
          if (/consent|agree|privacy|terms|contact me|whatsapp|call me/i.test(lab)) { consentBox = true; if (boxes[m].defaultChecked) preTicked = true; }
        }
        out.push({ personal: personal.filter(function (v, x, a) { return a.indexOf(v) === x; }), privacyLink: privacyLink || /privacy (policy|notice)/i.test(text), consentBox: consentBox, preTicked: preTicked, action: f.getAttribute("action") || "" });
      }
      return out;
    })()`)) as { personal: string[]; privacyLink: boolean; consentBox: boolean; preTicked: boolean; action: string }[];
    const out: Finding[] = [];
    for (const f of forms) {
      if (!f.privacyLink) {
        out.push(
          finding({
            category: "security",
            rule: "dpdp:form-no-notice",
            severity: "medium",
            title: `A form asks for ${f.personal.join(", ")} with no link to the privacy notice`,
            detail: "Under the DPDP Act the notice must be given before or when the data is collected (Section 5). Put a short line under the form: what the data is used for, and a link to the privacy notice.",
            pageUrl: url,
            evidence: `Form${f.action ? ` to ${f.action}` : ""} collects ${f.personal.join(", ")}`,
          }),
        );
      }
      if (f.preTicked) {
        out.push(
          finding({
            category: "security",
            rule: "dpdp:pre-ticked-consent",
            severity: "high",
            title: "Consent box on a form is ticked already",
            detail: "Consent under the DPDP Act must be a clear affirmative action (Section 6(1)): a ticked box the person did not tick is not consent. Leave it unticked.",
            pageUrl: url,
            evidence: `Form collects ${f.personal.join(", ")}`,
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// GIGW 3.0: what an Indian government or public-sector website must have

/** GIGW 3.0 page requirements, with how to recognise each among the site's links or text. */
export const GIGW_ITEMS: { id: string; what: string; link?: RegExp; text?: RegExp; ref: string; severity: Severity }[] = [
  { id: "hindi", what: "a Hindi (bilingual) version", link: /हिन्दी|हिंदी|\bhindi\b/i, ref: "GIGW 3.0 §5.2 (bilingual: Hindi and English)", severity: "high" },
  { id: "accessibility", what: "an accessibility statement", link: /accessibility( statement)?|सुगम्यता|अभिगम्यता/i, ref: "GIGW 3.0 §6, IS 17802", severity: "high" },
  { id: "screen-reader", what: "a screen reader access page", link: /screen ?reader/i, ref: "GIGW 3.0 §6.2", severity: "medium" },
  { id: "skip", what: "a Skip to main content link", text: /skip to (main )?content|मुख्य (सामग्री|विषयवस्तु) पर जाएं/i, ref: "GIGW 3.0 §6, WCAG 2.4.1", severity: "medium" },
  { id: "privacy", what: "a privacy policy", link: /privacy/i, ref: "GIGW 3.0 §4.4", severity: "high" },
  { id: "copyright", what: "a copyright policy", link: /copyright/i, ref: "GIGW 3.0 §4.4", severity: "medium" },
  { id: "hyperlink", what: "a hyperlinking policy", link: /hyper ?link(ing)? policy/i, ref: "GIGW 3.0 §4.4", severity: "medium" },
  { id: "terms", what: "terms and conditions", link: /terms|disclaimer/i, ref: "GIGW 3.0 §4.4", severity: "medium" },
  { id: "contact", what: "a Contact us page", link: /contact/i, ref: "GIGW 3.0 §4.7", severity: "high" },
  { id: "feedback", what: "a feedback page", link: /feedback|प्रतिक्रिया/i, ref: "GIGW 3.0 §4.7", severity: "medium" },
  { id: "help", what: "a help page", link: /\bhelp\b|सहायता/i, ref: "GIGW 3.0 §4.6", severity: "low" },
  { id: "sitemap", what: "a sitemap page", link: /site ?map/i, ref: "GIGW 3.0 §4.5", severity: "medium" },
  { id: "updated", what: "a last updated or last reviewed date", text: /last (updated|reviewed|modified)|अंतिम (अद्यतन|समीक्षा)/i, ref: "GIGW 3.0 §4.3", severity: "medium" },
  { id: "text-size", what: "text size controls (A+ A A-)", text: /\bA\s*\+|\bA-\b|text size|font size|फ़ॉन्ट/i, ref: "GIGW 3.0 §6.3", severity: "low" },
  { id: "ownership", what: "a statement of who owns the site (ministry or department)", text: /(content )?(owned|managed|maintained|provided) by|website (is )?(designed|developed|hosted)|government of [a-z ]+|भारत सरकार/i, ref: "GIGW 3.0 §4.1", severity: "medium" },
];

/** Pure: GIGW items missing from a home page. */
export function missingGigw(html: string, base: string): typeof GIGW_ITEMS {
  const links = linksOf(html, base).map(([t, h]) => `${t} ${decodeURIComponent(new URL(h).pathname)}`);
  const text = strip(html);
  return GIGW_ITEMS.filter((i) => !((i.link && links.some((l) => i.link!.test(l))) || (i.text && i.text.test(text)) || (i.link && i.link.test(text) && i.id === "hindi")));
}

async function gigwFindings({ browser, origin }: SiteContext): Promise<Finding[]> {
  const home = await getText(browser.request, `${origin}/`, {}, 2_000_000);
  if (!home || home.status >= 400) throw new Error("The home page could not be read.");
  return missingGigw(home.text, home.url).map((m) =>
    finding({
      category: "accessibility",
      rule: `gigw:no-${m.id}`,
      severity: m.severity,
      title: `GIGW 3.0: no ${m.what}`,
      detail: `Indian government and public-sector websites must have ${m.what} (${m.ref}). Add it, linked from the header or footer of every page.`,
      pageUrl: home.url,
    }),
  );
}

export const gigwAgent: SiteAgent = {
  id: "india.gigw",
  name: "India GIGW 3.0 (government sites)",
  description:
    "Guidelines for Indian Government Websites 3.0: Hindi version, accessibility statement and screen reader page, skip link, text size controls, privacy, copyright, hyperlinking and terms policies, contact, feedback, help, sitemap, last-updated date and ownership. Off by default: turn it on for government and PSU projects.",
  category: "accessibility",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  defaultOff: true,
  stage: "site",
  run: gigwFindings,
};
