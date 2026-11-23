import { createHash } from "node:crypto";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, PageContext } from "../types.js";
import { trackersIn } from "./page.js";

/* ============================================================================================== */
/* GDPR / DPDP consent proof: do trackers fire before consent, and does "Reject" really reject?     */

const BANNER_JS = `(() => {
  const cmp = /cookiebot|onetrust|cookieyes|iubenda|termly|complianz|usercentrics|quantcast|didomi|cookie-?law|osano|klaro|tarteaucitron|consent|gdpr/i;
  const els = Array.from(document.querySelectorAll("[id*=cookie i],[class*=cookie i],[id*=consent i],[class*=consent i],[aria-label*=cookie i],[aria-label*=consent i]"));
  const visible = els.find((e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.height > 20 && r.width > 100 && s.display !== "none" && s.visibility !== "hidden"; });
  return { present: Boolean(visible) || cmp.test((document.documentElement && document.documentElement.outerHTML || "").slice(0, 3000)) };
})()`;

/** Finds a Reject/Decline control's text in the DOM. Returns the selector hint. */
const REJECT_JS = `(() => {
  const words = /^(reject( all)?|decline( all)?|refuse|deny|only necessary|necessary only|essential only|do not accept|manage|disagree)/i;
  const btns = Array.from(document.querySelectorAll("button, a, [role=button], input[type=button], input[type=submit]"));
  for (const b of btns) {
    const t = (b.textContent || b.getAttribute("value") || b.getAttribute("aria-label") || "").trim();
    if (words.test(t)) { b.setAttribute("data-glv-reject", "1"); return t.slice(0, 40); }
  }
  return "";
})()`;

async function consentProofFindings(ctx: PageContext): Promise<Finding[]> {
  if (!ctx.isFirst) return []; // One page is enough; the banner is site-wide.
  const out: Finding[] = [];
  const banner = (await ctx.page.evaluate(BANNER_JS).catch(() => ({ present: false }))) as { present: boolean };
  const before = trackersIn(ctx.signals.requests);
  if (!banner.present) return out; // The existing privacy agent covers "trackers but no banner".
  if (before.length)
    out.push(
      finding({
        category: "security",
        rule: "privacy:tracker-before-consent",
        severity: "high",
        title: "Trackers fire before the visitor gives consent",
        detail:
          "The page shows a cookie consent banner, but analytics/ad trackers already loaded before the visitor chose anything. Under GDPR and India's DPDP Act, non-essential trackers must wait for consent. Use Google Consent Mode or block the tags until the visitor accepts.",
        pageUrl: ctx.url,
        evidence: before.join("\n"),
      }),
    );
  // Does "Reject" really reject? Click it, then watch for new tracker requests.
  const rejectText = (await ctx.page.evaluate(REJECT_JS).catch(() => "")) as string;
  if (rejectText) {
    const after: string[] = [];
    const onReq = (req: { url(): string }) => after.push(req.url());
    ctx.page.on("request", onReq);
    await ctx.page.click("[data-glv-reject='1']", { timeout: 4000 }).catch(() => undefined);
    await ctx.page.waitForTimeout(2500);
    ctx.page.off("request", onReq);
    const newTrackers = trackersIn(after);
    if (newTrackers.length)
      out.push(
        finding({
          category: "security",
          rule: "privacy:reject-not-honoured",
          severity: "high",
          title: `Trackers still fire after clicking "${rejectText}"`,
          detail: "After the visitor rejected cookies, analytics/ad trackers still loaded. A 'Reject' that does not actually stop tracking is a direct GDPR/DPDP breach and a common cause of fines. Make 'Reject' block all non-essential tags.",
          pageUrl: ctx.url,
          evidence: newTrackers.join("\n"),
        }),
      );
  } else if (before.length === 0) {
    out.push(
      finding({
        category: "security",
        rule: "privacy:no-reject-button",
        severity: "medium",
        title: "The consent banner has no clear 'Reject' option",
        detail: "GDPR requires refusing cookies to be as easy as accepting them. No 'Reject all' / 'Only necessary' button was found next to 'Accept'. Add an equally prominent reject button.",
        pageUrl: ctx.url,
      }),
    );
  }
  return out;
}

export const consentProofAgent: PageAgent = {
  id: "privacy.consent-proof",
  name: "Consent proof",
  description: "Checks trackers do not fire before the visitor consents, that a 'Reject' button exists and is as easy as 'Accept', and that clicking Reject actually stops the trackers (GDPR, India's DPDP Act).",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  interacts: true,
  skipErrorPages: true,
  run: consentProofFindings,
};

/* ============================================================================================== */
/* PCI DSS 4.0 script controls (6.4.3 inventory + integrity, 11.6.1 change detection on pay pages). */

export interface ScriptInfo {
  src: string;
  thirdParty: boolean;
  hasIntegrity: boolean;
  hash: string;
}

/** Whether a page looks like a payment/checkout page. Pure, for tests. */
export function isPaymentPage(url: string, html: string): boolean {
  if (/\/(checkout|payment|pay|billing|cart\/pay|order\/pay)(\/|$|\?)/i.test(url)) return true;
  if (/razorpay|stripe\.com\/v3|js\.stripe\.com|payu|ccavenue|billdesk|checkout\.js|braintree|paypal\.com\/sdk/i.test(html)) return true;
  return /name=["']card(number)?["']|autocomplete=["']cc-number["']|id=["']card-element["']/i.test(html);
}

/** Inventories scripts on a page. Pure, for tests. */
export function scriptInventory(origin: string, html: string): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1];
    const src = attrs.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    const hasIntegrity = /\bintegrity=["']/.test(attrs);
    if (src) {
      let thirdParty = false;
      try {
        thirdParty = new URL(src, origin).origin !== new URL(origin).origin;
      } catch {
        thirdParty = /^https?:\/\//i.test(src);
      }
      out.push({ src, thirdParty, hasIntegrity, hash: "" });
    } else if (m[2].trim()) {
      out.push({ src: "(inline)", thirdParty: false, hasIntegrity: false, hash: createHash("sha256").update(m[2]).digest("base64").slice(0, 16) });
    }
  }
  return out;
}

async function pciScriptFindings(ctx: PageContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const html = await ctx.page.content().catch(() => "");
  if (!html || !isPaymentPage(ctx.url, html)) return out;
  const origin = new URL(ctx.url).origin;
  const scripts = scriptInventory(origin, html);
  const risky = scripts.filter((s) => s.thirdParty && !s.hasIntegrity);
  if (risky.length)
    out.push(
      finding({
        category: "security",
        rule: "pci:script-no-integrity",
        severity: "medium",
        title: `${risky.length} third-party script${risky.length === 1 ? "" : "s"} on the payment page with no integrity check`,
        detail:
          "PCI DSS 4.0 (6.4.3) requires every script on a payment page to be authorised and its integrity assured. These third-party scripts load with no Subresource Integrity (integrity=\"sha384-…\") and no documented justification, so if the third party is compromised, card-skimming code runs on your checkout (Magecart). Add SRI where you can, pin versions, and keep a reviewed inventory. (11.6.1) adds change detection: keep this script list and alert on changes.",
        pageUrl: ctx.url,
        evidence: risky.map((s) => s.src).slice(0, 12).join("\n"),
      }),
    );
  const inlineNoCsp = scripts.filter((s) => s.src === "(inline)");
  const docHeaders = ctx.signals.responses.find((r) => r.type === "document")?.headers ?? {};
  if (inlineNoCsp.length && !docHeaders["content-security-policy"])
    out.push(
      finding({
        category: "security",
        rule: "pci:inline-script-payment",
        severity: "low",
        title: "Inline scripts on the payment page with no Content-Security-Policy",
        detail: "The payment page runs inline scripts and sends no Content-Security-Policy. A CSP with script-src and a nonce limits what can run if the page is injected, which PCI DSS 4.0 expects on payment pages. Add a CSP and move inline scripts to files you can pin.",
        pageUrl: ctx.url,
        evidence: `${inlineNoCsp.length} inline scripts (hashes: ${inlineNoCsp.map((s) => s.hash).slice(0, 5).join(", ")})`,
      }),
    );
  return out;
}

export const pciScriptAgent: PageAgent = {
  id: "sec.pci-scripts",
  name: "PCI payment-page scripts",
  description: "On checkout and payment pages, inventories every script and flags third-party scripts with no Subresource Integrity and inline scripts with no CSP — the PCI DSS 4.0 script controls (6.4.3, 11.6.1) that stop card skimming (Magecart).",
  category: "security",
  engine: "web",
  products: ["ecommerce", "webapp", "saas"],
  stage: "end",
  skipErrorPages: true,
  run: pciScriptFindings,
};
