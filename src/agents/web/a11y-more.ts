import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS, PUBLIC_WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { PageAgent, PageContext, SiteAgent, SiteContext } from "../types.js";
import { getText } from "./geo.js";

/* ============================================================================================== */
/* Colour-blind and low-vision: things shown by colour alone (WCAG 1.4.1 Use of Colour).           */

/** The colour-blind simulation matrices (feColorMatrix values), for the report note. Pure, for tests. */
export const COLOUR_MATRICES: Record<string, string> = {
  deuteranopia: "0.625 0.375 0 0 0  0.7 0.3 0 0 0  0 0.3 0.7 0 0  0 0 0 1 0",
  protanopia: "0.567 0.433 0 0 0  0.558 0.442 0 0 0  0 0.242 0.758 0 0  0 0 0 1 0",
  tritanopia: "0.95 0.05 0 0 0  0 0.433 0.567 0 0  0 0.475 0.525 0 0  0 0 0 1 0",
};

/** Decides whether a link is told apart from body text by colour only. Pure, for tests. */
export function colourOnlyLink(info: { underline: boolean; bold: boolean; bordered: boolean; differentBg: boolean; inParagraph: boolean }): boolean {
  if (!info.inParagraph) return false; // Standalone links (nav, buttons) are found by position.
  return !info.underline && !info.bold && !info.bordered && !info.differentBg;
}

async function colourVisionFindings(ctx: PageContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const colourLinks = await ctx.page
    .evaluate(() => {
      const bad: string[] = [];
      const paras = Array.from(document.querySelectorAll("p, li, td")).slice(0, 400);
      for (const para of paras) {
        const paraColour = getComputedStyle(para).color;
        for (const a of Array.from(para.querySelectorAll("a[href]"))) {
          const s = getComputedStyle(a as Element);
          const underline = s.textDecorationLine.includes("underline");
          const bold = Number(s.fontWeight) >= 600 || s.fontWeight === "bold";
          const bordered = s.borderBottomWidth !== "0px" || s.outlineStyle !== "none";
          const differentBg = s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== getComputedStyle(para).backgroundColor;
          const colourDiffers = s.color !== paraColour;
          if (colourDiffers && !underline && !bold && !bordered && !differentBg) {
            const text = (a.textContent || "").trim().slice(0, 40);
            if (text) bad.push(text);
          }
        }
      }
      return [...new Set(bad)].slice(0, 20);
    })
    .catch(() => [] as string[]);
  if (colourLinks.length)
    out.push(
      finding({
        category: "accessibility",
        rule: "a11y:links-colour-only",
        severity: "medium",
        title: `${colourLinks.length} in-text link${colourLinks.length === 1 ? "" : "s"} told apart by colour only`,
        detail:
          "Links inside paragraphs are shown only by a different colour, with no underline, bold or border. People with colour blindness (about 1 in 12 men) cannot see them (WCAG 1.4.1 Use of Colour). Underline in-text links, or add another visible cue. Preview the page with a deuteranopia/protanopia simulation to confirm.",
        pageUrl: ctx.url,
        evidence: colourLinks.join(", "),
      }),
    );
  return out;
}

export const colourVisionAgent: PageAgent = {
  id: "a11y.colour-vision",
  name: "Colour-blind and low-vision",
  description: "Finds information shown by colour alone — in-text links with no underline, states shown only in red/green — which colour-blind and low-vision users cannot see (WCAG 1.4.1).",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  run: colourVisionFindings,
};

/* ============================================================================================== */
/* WCAG AAA and cognitive accessibility: reading level, time limits, consistent help (COGA).       */

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch–Kincaid US grade level of some text. Pure, for tests. */
export function readingGrade(text: string): number {
  const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) ?? []).length);
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (!words.length) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return Math.round((0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59) * 10) / 10;
}

/** AAA / cognitive problems found across the sampled pages. Pure, for tests. */
export function aaaProblems(input: { grade: number; metaRefresh: boolean; helpLinkPages: number; totalPages: number }): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (input.grade > 12) out.push({ rule: "a11y:reading-level", severity: "low", title: `Text reads at about grade ${input.grade}`, detail: "WCAG 2.1 AAA (3.1.5) and COGA ask for a reading level around lower-secondary (grade 9) for general content. Shorten sentences, use common words, and add a plain summary for complex pages." });
  if (input.metaRefresh) out.push({ rule: "a11y:time-limit", severity: "medium", title: "A page refreshes or redirects on a timer", detail: "A meta refresh moves or reloads the page on a timer. This fails WCAG 2.2.1 (Timing Adjustable) for people who read slowly or use assistive tech. Remove the timed refresh, or let the user turn it off or extend it." });
  if (input.totalPages >= 3 && input.helpLinkPages > 0 && input.helpLinkPages < input.totalPages) out.push({ rule: "a11y:inconsistent-help", severity: "low", title: "Help/contact is not on every page", detail: "WCAG 2.2 (3.2.6 Consistent Help) asks that a way to get help (contact, support link, chat) be in the same place on every page. It was found on some pages but not all. Add it site-wide, in the same spot." });
  return out;
}

async function aaaFindings({ browser, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const sample = pages.filter((p) => p.status !== null && p.status < 400).slice(0, 10);
  let words = "";
  let metaRefresh = false;
  let helpLinkPages = 0;
  let read = 0;
  let firstUrl = "";
  for (const p of sample) {
    const got = await getText(browser.request, p.url);
    if (!got || got.status >= 400 || !/html/i.test(got.type)) continue;
    read++;
    firstUrl ||= got.url;
    const html = got.text;
    if (/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["']\s*\d/i.test(html)) metaRefresh = true;
    if (/href=["'][^"']*(contact|help|support|faq)[^"']*["']|>\s*(help|support|contact)\s*</i.test(html)) helpLinkPages++;
    const body = html.replace(/<(script|style|nav|footer|header)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (body.split(" ").length > 120) words += " " + body.slice(0, 4000);
  }
  if (!read) {
    log("WCAG AAA: no page could be read");
    return out;
  }
  const grade = words ? readingGrade(words) : 0;
  for (const p of aaaProblems({ grade, metaRefresh, helpLinkPages, totalPages: read })) out.push(finding({ category: "accessibility", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: firstUrl }));
  return out;
}

export const aaaAgent: SiteAgent = {
  id: "a11y.aaa",
  name: "WCAG AAA and cognitive",
  description: "Beyond AA: reading level (Flesch–Kincaid), timed refreshes/redirects (2.2.1), and consistent help on every page (2.2.6) — the AAA and COGA cognitive-accessibility patterns.",
  category: "accessibility",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run: aaaFindings,
};
