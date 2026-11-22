import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS, WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, SiteAgent, SiteContext } from "../types.js";

/**
 * Dark patterns: designs that trick people into buying, signing up or sharing more than they meant
 * to. Named after India's Guidelines for Prevention and Regulation of Dark Patterns, 2023 (CCPA,
 * 13 patterns) and the EU Digital Services Act. Read-only: the page is looked at, never submitted.
 */

export const CCPA_PATTERNS: Record<string, string> = {
  "false-urgency": "False urgency (CCPA 2023, Annexure 1 no. 1)",
  "basket-sneaking": "Basket sneaking (no. 2)",
  "confirm-shaming": "Confirm shaming (no. 3)",
  "forced-action": "Forced action (no. 4)",
  "subscription-trap": "Subscription trap (no. 5)",
  "interface-interference": "Interface interference (no. 6)",
  "drip-pricing": "Drip pricing (no. 8)",
  "nagging": "Nagging (no. 10)",
  "trick-question": "Trick question (no. 11)",
};

/** Button and link text that shames people for saying no. */
export const SHAMING = /\b(no,? (thanks,? )?i (don'?t|do not) (want|like|need|care)|no,? i (prefer|would rather|('?d|would) like to) (pay|miss|stay|lose|keep)|i('?m| am) not interested in (saving|deals|discounts|being)|i don'?t (want|like) (to )?(save|savings|discounts|free|deals|money|better)|i('?ll| will) pay full price|i('?d| would) rather (pay|miss|stay)|i hate (saving|deals|discounts|money)|no,? i('?m| am) (rich|happy paying)|i('?m| am) okay (with )?(missing|losing))\b/i;

/** Pressure text that often comes with no real limit behind it. */
export const SCARCITY = /\b(only \d{1,2} (left|remaining|in stock)|\d{1,3} (people|others|shoppers|users) (are )?(viewing|looking at|watching) (this|right now)|\d{1,3} (people )?(bought|purchased) (this )?in the (last|past) \d+ (hours?|minutes?)|selling fast|almost (gone|sold out)|hurry[,!]? (only|offer|sale)|deal ends in|offer ends in|last chance)\b/i;

/** Ticked boxes that sign people up or add something they did not ask for. */
export const SNEAKY_CHECK = /(newsletter|marketing|promotional|offers|updates|subscribe|sms|whatsapp|partners|third[- ]part(y|ies)|insurance|protection plan|warranty|donat|tip\b|gift wrap|priority|express|auto[- ]?renew|recurring|share (my )?data)/i;

/** A label that says the opposite of what ticking does ("Untick to not receive…"). */
export const DOUBLE_NEGATIVE = /\b(un-?(tick|check|select) (this|the box)? ?(if|to) (you )?(do not|don'?t|not)|do not (un-?tick|uncheck)|if you (do not|don'?t) (want|wish) to not)\b/i;

/** Extra charges that appear only late in the flow. */
export const HIDDEN_FEE = /\b(convenience|handling|platform|service|processing|booking|packaging|small cart|surge|payment gateway) (fee|charge)s?\b/i;

interface Facts {
  checked: { label: string; name: string }[];
  shaming: string[];
  scarcity: string[];
  doubleNeg: string[];
  timers: string[];
  fees: string[];
  consent: { accept: boolean; reject: boolean; settings: boolean } | null;
  trialCard: boolean;
}

const READ = `(function () {
  function label(el) {
    var t = "";
    if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.innerText; }
    if (!t && el.closest("label")) t = el.closest("label").innerText;
    if (!t) t = el.getAttribute("aria-label") || (el.parentElement ? el.parentElement.innerText : "");
    return (t || "").replace(/\\s+/g, " ").trim().slice(0, 160);
  }
  function shown(el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; }
  var checked = [];
  var boxes = document.querySelectorAll('input[type=checkbox], input[type=radio]');
  for (var i = 0; i < boxes.length; i++) {
    var b = boxes[i];
    if (b.defaultChecked && shown(b.closest("label") || b)) checked.push({ label: label(b), name: b.name || "" });
  }
  var clickables = document.querySelectorAll("button, a, [role=button], input[type=submit], input[type=button]");
  var shaming = [];
  for (var j = 0; j < clickables.length; j++) {
    var c = clickables[j];
    var t = (c.innerText || c.value || "").replace(/\\s+/g, " ").trim();
    if (t && t.length < 120 && shown(c)) shaming.push(t);
  }
  var body = document.body ? document.body.innerText : "";
  var lines = body.split(/\\n+/).map(function (s) { return s.trim(); }).filter(function (s) { return s && s.length < 200; });
  var timers = [];
  var all = document.querySelectorAll("body *");
  for (var k = 0; k < all.length && timers.length < 5; k++) {
    var el = all[k];
    if (el.children.length > 4) continue;
    var tx = (el.innerText || "").trim();
    if (/^(\\d{1,2}\\s*[:h]\\s*)?\\d{1,2}\\s*[:m]\\s*\\d{2}\\s*s?$/.test(tx) || /^\\d{1,2}\\s*(hrs?|hours?)\\s*\\d{1,2}\\s*(min|mins|minutes?)\\s*\\d{1,2}\\s*(sec|secs|seconds?)$/i.test(tx)) timers.push(tx);
  }
  var accept = false, reject = false, settings = false, banner = false;
  var cb = document.querySelectorAll("[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i], [aria-label*=consent i]");
  for (var m = 0; m < cb.length; m++) {
    if (!shown(cb[m])) continue;
    var btns = cb[m].querySelectorAll("button, a, [role=button]");
    for (var n = 0; n < btns.length; n++) {
      var bt = (btns[n].innerText || "").trim().toLowerCase();
      if (!shown(btns[n])) continue;
      if (/^(accept|allow|agree|i agree|ok|got it|accept all|allow all)/.test(bt)) { accept = true; banner = true; }
      if (/(reject|decline|deny|refuse|necessary only|only necessary|essential only|disagree)/.test(bt)) reject = true;
      if (/(settings|preferences|customi[sz]e|manage|options|choose)/.test(bt)) settings = true;
    }
  }
  return {
    checked: checked.slice(0, 20),
    shaming: shaming.slice(0, 400),
    lines: lines.slice(0, 2000),
    timers: timers,
    consent: banner ? { accept: accept, reject: reject, settings: settings } : null,
    trialCard: /free trial/i.test(body) && /(credit|debit) card (is )?(required|needed)|enter your card|add (a )?payment method/i.test(body)
  };
})()`;

/** Pure: reads the dark patterns out of what the page shows. */
export function readPatterns(raw: { checked: Facts["checked"]; shaming: string[]; lines: string[]; timers: string[]; consent: Facts["consent"]; trialCard: boolean }): Facts {
  const lines = raw.lines;
  return {
    checked: raw.checked.filter((c) => SNEAKY_CHECK.test(`${c.label} ${c.name}`) && !/(remember me|keep me (signed|logged) in|i agree to the terms|terms (and|&) conditions|privacy policy)/i.test(c.label)),
    shaming: raw.shaming.filter((t) => SHAMING.test(t)),
    scarcity: [...new Set(lines.filter((l) => SCARCITY.test(l)).map((l) => l.slice(0, 120)))].slice(0, 5),
    doubleNeg: lines.filter((l) => DOUBLE_NEGATIVE.test(l)).slice(0, 3),
    timers: raw.timers,
    fees: [...new Set(lines.filter((l) => HIDDEN_FEE.test(l) && /(₹|rs\.?|inr|\$|€|£)\s?\d/i.test(l)).map((l) => l.slice(0, 120)))].slice(0, 5),
    consent: raw.consent,
    trialCard: raw.trialCard,
  };
}

export const darkPatternsAgent: PageAgent = {
  id: "ux.dark-patterns",
  name: "Dark patterns",
  description:
    "Finds tricks India's 2023 dark-pattern guidelines (CCPA) and the EU DSA ban: pre-ticked add-ons and sign-ups, confirm-shaming buttons, fake scarcity and countdowns, trick questions, late fees (drip pricing), cookie banners with no Reject, and free trials that need a card.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  async run({ page, url, site }) {
    const raw = (await page.evaluate(READ)) as Parameters<typeof readPatterns>[0];
    const f = readPatterns(raw);
    const out: Finding[] = [];
    const add = (rule: string, kind: keyof typeof CCPA_PATTERNS, severity: Finding["severity"], title: string, detail: string, evidence: string) =>
      out.push(finding({ category: "functional", rule, severity, title, detail: `${detail} (${CCPA_PATTERNS[kind]}.)`, pageUrl: url, evidence }));
    if (f.checked.length) {
      const sneaks = f.checked.filter((c) => /(insurance|protection|warranty|donat|tip\b|gift wrap|priority|express)/i.test(c.label));
      add(
        sneaks.length ? "dark:basket-sneaking" : "dark:pre-ticked",
        sneaks.length ? "basket-sneaking" : "trick-question",
        sneaks.length ? "high" : "medium",
        sneaks.length ? "Paid extras are ticked for the customer" : "Sign-up boxes are ticked already",
        sneaks.length
          ? "Insurance, donations, tips or other paid extras are added unless the buyer notices and unticks them. India's dark-pattern guidelines ban adding items without consent. Leave every extra unticked."
          : "Consent to marketing, sharing data or auto-renewal must be given by ticking, not by failing to untick (DPDP Act and GDPR). Leave these boxes unticked.",
        f.checked.map((c) => c.label || c.name).join("\n"),
      );
    }
    if (f.shaming.length) add("dark:confirm-shaming", "confirm-shaming", "medium", "Buttons shame people for saying no", "The way out is worded to make people feel guilty or foolish. Use a neutral \"No thanks\".", f.shaming.slice(0, 5).join("\n"));
    if (f.scarcity.length) add("dark:false-urgency", "false-urgency", "low", "Pressure messages: check they are true", "Stock counts, \"people viewing now\" and \"offer ends\" messages are only allowed when they are real. If the numbers are made up or never change, remove them.", f.scarcity.join("\n"));
    if (f.doubleNeg.length) add("dark:trick-question", "trick-question", "medium", "Confusing double-negative wording", "Wording like \"untick to not receive\" makes people choose the opposite of what they want. Ask a plain yes question with an unticked box.", f.doubleNeg.join("\n"));
    if (f.fees.length) add("dark:drip-pricing", "drip-pricing", "medium", "Extra fees appear on the page: check they were shown up front", "Convenience, platform or handling fees that are first shown late in the purchase are drip pricing. Show the full price, fees included, from the product page.", f.fees.join("\n"));
    if (f.consent && f.consent.accept && !f.consent.reject) {
      add(
        "dark:no-reject",
        "interface-interference",
        "medium",
        "Cookie banner has Accept but no Reject",
        f.consent.settings ? "Saying no takes more steps (open settings, untick, save) than saying yes. Put Reject all next to Accept all on the first layer." : "There is no way to refuse except leaving the page. Add a Reject all button as easy to press as Accept all.",
        `Accept: yes, Reject: no, Settings: ${f.consent.settings ? "yes" : "no"}`,
      );
    }
    if (f.trialCard) add("dark:trial-needs-card", "subscription-trap", "low", "The free trial asks for a card", "A trial that needs a card and renews into a paid plan must say clearly when billing starts, send a reminder before it does, and be as easy to cancel as to start.", "free trial + card required");
    if (f.timers.length) {
      (site.timerPages ??= []).push(url);
      out.push(
        finding({ category: "functional", rule: "dark:countdown", severity: "info", title: "Countdown timer on the page", detail: "The countdown is checked across a reload by the fake-timer check. Real deadlines are fine; timers that restart are banned (false urgency).", pageUrl: url, evidence: f.timers.join("\n") }),
      );
    }
    return out;
  },
};

/** Reloading a page restarts a fake countdown from the same value. Pure, for tests: seconds left, or null. */
export function timerSeconds(text: string): number | null {
  const t = text.trim();
  let m = t.match(/^(?:(\d{1,2})\s*[:h]\s*)?(\d{1,2})\s*[:m]\s*(\d{2})\s*s?$/);
  if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  m = t.match(/^(\d{1,2})\s*(?:hrs?|hours?)\s*(\d{1,2})\s*(?:min|mins|minutes?)\s*(\d{1,2})\s*(?:sec|secs|seconds?)$/i);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

async function fakeTimerFindings({ browser, site }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  // Only pages where the dark-pattern check saw a countdown.
  for (const url of [...new Set(site.timerPages ?? [])].slice(0, 3)) {
    site.signal?.throwIfAborted();
    const read = async () => {
      const page = await browser.newPage();
      try {
        await page.goto(url, { waitUntil: "load", timeout: 30_000 });
        await page.waitForTimeout(1500);
        return (await page.evaluate(`(function () {
          var out = [];
          var all = document.querySelectorAll("body *");
          for (var k = 0; k < all.length && out.length < 5; k++) {
            if (all[k].children.length > 4) continue;
            var tx = (all[k].innerText || "").trim();
            if (/^(\\d{1,2}\\s*[:h]\\s*)?\\d{1,2}\\s*[:m]\\s*\\d{2}\\s*s?$/.test(tx)) out.push(tx);
          }
          return out;
        })()`)) as string[];
      } finally {
        await page.close().catch(() => {});
      }
    };
    const first = (await read()).map(timerSeconds).filter((n): n is number => n !== null);
    await new Promise((ok) => setTimeout(ok, 4000));
    const second = (await read()).map(timerSeconds).filter((n): n is number => n !== null);
    if (!first.length || !second.length) continue;
    // A real deadline keeps counting down; a fake one starts again near where it began.
    if (second[0] >= first[0] - 1) {
      out.push(
        finding({
          category: "functional",
          rule: "dark:fake-timer",
          severity: "high",
          title: "The countdown starts again on every visit",
          detail: `The timer showed ${first[0]} seconds left, and after a reload four seconds later it showed ${second[0]}: there is no real deadline. India's dark-pattern guidelines ban false urgency (CCPA 2023, no. 1). Use a real end date or remove the timer.`,
          pageUrl: url,
          evidence: `First visit: ${first[0]}s left\nReload 4s later: ${second[0]}s left`,
        }),
      );
    }
  }
  return out;
}

export const fakeTimerAgent: SiteAgent = {
  id: "ux.fake-timer",
  name: "Fake countdown timers",
  description: "Opens each page with a countdown twice, a few seconds apart, and flags timers that start again (false urgency).",
  category: "functional",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run: fakeTimerFindings,
};
