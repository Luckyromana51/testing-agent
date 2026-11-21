import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent } from "../types.js";
import { DESCRIBE_JS } from "./guard.js";

/**
 * Screens that block the app until the user accepts a policy or terms ("Read and accept the
 * communication policy before posting"). The test never presses the accept button: that records a
 * real acceptance for the account. It checks a person could: the button is there, and it is not
 * hidden behind a bar that stays on screen (a phone's bottom menu often covers the last thing on a
 * long page). It also says the rest of that screen was not tested behind the gate.
 */

export interface ConsentGate {
  /** The sentence that asks for acceptance. */
  ask: string;
  /** Buttons that accept, with what covers each one when it is scrolled into view. */
  buttons: { label: string; covered?: string; offscreen?: boolean }[];
  /** Other buttons on the gate (Try again, Refresh...), for the evidence. */
  others: string[];
}

export const CONSENT_JS = `(function () {
  var describe = ${DESCRIBE_JS};
  var text = (document.body && document.body.innerText) || "";
  var ASK = /[^.\\n]{0,80}\\b(accept|agree to|acknowledge)\\b[^.\\n]{0,80}\\b(policy|policies|terms|conditions|rules|code of conduct|guidelines)\\b[^.\\n]{0,80}/i;
  var m = ASK.exec(text);
  if (!m || /cookie/i.test(m[0])) return null;
  var ACCEPT = /\\b(i agree|agree|accept|i accept|acknowledge|i have read|i understand|continue)\\b/i;
  var NOT = /\\b(cookie|decline|reject|don.?t|do not|cancel)\\b/i;
  var els = document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"], input[type="checkbox"], a[href]');
  var buttons = [], others = [];
  var sx = scrollX, sy = scrollY;
  for (var i = 0; i < els.length && i < 400; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    var r = el.getBoundingClientRect();
    if (cs.display === "none" || cs.visibility === "hidden" || r.width < 2 || r.height < 2) continue;
    var label = el.type === "checkbox" ? ((el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || "") : (el.getAttribute("aria-label") || el.innerText || el.value || "");
    label = String(label).replace(/\\s+/g, " ").trim().slice(0, 80);
    if (!label) continue;
    if (!ACCEPT.test(label) || NOT.test(label) || el.tagName === "A") {
      if (el.tagName !== "A" && others.length < 6) others.push(label);
      continue;
    }
    el.scrollIntoView({ block: "center", inline: "nearest" });
    r = el.getBoundingClientRect();
    var item = { label: label };
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) item.offscreen = true;
    else {
      var top = document.elementFromPoint(x, y);
      var target = el.type === "checkbox" && el.labels && el.labels[0] ? el.labels[0] : el;
      if (top && top !== el && !el.contains(top) && !top.contains(el) && !(target !== el && (target === top || target.contains(top)))) item.covered = describe(top);
    }
    buttons.push(item);
  }
  scrollTo(sx, sy);
  return { ask: m[0].replace(/\\s+/g, " ").trim().slice(0, 200), buttons: buttons, others: others };
})()`;

export const consentGateAgent: PageAgent = {
  id: "ui.consent-gate",
  name: "Policy and terms screens",
  description:
    "Finds screens that block the app until the user accepts a policy or terms, and checks a person can accept: the button is there and no bar covers it on a phone. It never presses it.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  interacts: true,
  async run({ page, url }) {
    const g = (await page.evaluate(CONSENT_JS).catch(() => null)) as ConsentGate | null;
    if (!g) return [];
    const out: Finding[] = [];
    const others = g.others.length ? `\nOther buttons on the screen: ${g.others.join(", ")}` : "";
    if (!g.buttons.length) {
      out.push(
        finding({
          category: "functional",
          rule: "ui:consent-no-button",
          severity: "high",
          title: "The screen asks to accept a policy but has no button to accept it",
          detail:
            "People are blocked here: the screen says to read and accept a policy, but no button or tick box to accept it is shown, so they cannot go on. Show an \"I agree\" button right under the policy (and near the top on a long policy), and make sure it appears even when the policy text loads slowly or fails.",
          pageUrl: url,
          evidence: `Asks: "${g.ask}"${others}`,
        }),
      );
    }
    const covered = g.buttons.filter((b) => b.covered);
    if (covered.length) {
      out.push(
        finding({
          category: "mobile",
          rule: "ui:consent-button-covered",
          severity: "high",
          title: `The "${covered[0].label}" button is hidden behind ${covered[0].covered} on a phone`,
          detail:
            "On a phone the accept button sits under a bar that stays on screen, so a tap lands on the bar and people cannot accept the policy. Give the page room at the bottom (padding-bottom as tall as the bar), or put the button in the bar's place while the policy is open.",
          pageUrl: url,
          evidence: covered.map((b) => `"${b.label}" is covered by ${b.covered}`).join("\n") + `\nAsks: "${g.ask}"`,
        }),
      );
    }
    out.push(
      finding({
        category: "functional",
        rule: "ui:consent-gate",
        severity: "info",
        title: "This screen is behind a policy the test account has not accepted",
        detail:
          "The test does not accept policies or terms for the account (that records a real acceptance), so only the policy screen was tested here, not the screen behind it. To test it, sign in once with the test account, accept the policy by hand, and run the test again.",
        pageUrl: url,
        evidence: `Asks: "${g.ask}"\nAccept buttons: ${g.buttons.map((b) => b.label).join(", ") || "none"}${others}`,
      }),
    );
    return out;
  },
};
