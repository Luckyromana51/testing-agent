import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { aiEnabled } from "../ai/triage.js";
import { parseSteps } from "./journeys.js";

/**
 * Plain-English test writing: "Log in, add a red shirt to the cart and check the total" becomes the
 * journey steps the platform runs (open, click, fill, see…). Claude writes them when an API key is
 * set (ANTHROPIC_API_KEY in .env); otherwise GLV's own rules turn the common phrases into steps.
 * Either way the steps are checked before they are offered, and the tester saves them.
 */

export interface Draft {
  steps: string;
  /** How it was written: by Claude, or by GLV's rules. */
  by: "claude" | "rules";
  /** Phrases that could not be turned into a step, or things to check. */
  notes: string[];
}

const cap = (s: string) => s.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
const titleCase = (s: string) => cap(s).replace(/^\w/, (c) => c.toUpperCase());

/** One phrase to steps. Returns null when no rule fits. Pure, for tests. */
export function phraseToSteps(raw: string): string[] | null {
  const p = raw.trim().replace(/[.!]+$/, "").replace(/^(then|and|next|now|finally|after that|first)\s+/i, "").trim();
  if (!p) return [];
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^(?:log ?in|sign ?in|login)(?:\s+(?:as|with)\s+(.+))?$/i))) {
    const user = m[1] && !/saved|my|the (account|login)/i.test(m[1]) ? cap(m[1]) : "{{username}}";
    return ["fill Email = " + user, "fill Password = {{password}}", "click Log in"];
  }
  if ((m = p.match(/^(?:log ?out|sign ?out|logout)$/i))) return ["click Log out"];
  if ((m = p.match(/^(?:go to|open|visit|navigate to)\s+(?:the\s+)?(.+?)(?:\s+page)?$/i))) {
    const t = cap(m[1]);
    if (/^(https?:\/\/|\/)/.test(t)) return [`open ${t}`];
    if (/^(home|homepage|home page|start)$/i.test(t)) return ["open /"];
    return [`click ${titleCase(t)}`];
  }
  if ((m = p.match(/^(?:add|put)\s+(?:a\s+|an\s+|the\s+|one\s+)?(.+?)\s+(?:to|in|into)\s+(?:the\s+|my\s+)?(?:cart|basket|bag)$/i))) return [`click ${titleCase(m[1])}`, "click Add to cart", "see Cart"];
  if ((m = p.match(/^search\s+(?:for\s+)?(.+)$/i))) return [`fill Search = ${cap(m[1])}`, "press Enter"];
  if ((m = p.match(/^(?:type|enter|fill(?: in)?|put)\s+(.+?)\s+(?:in|into|as|for)\s+(?:the\s+)?(.+?)(?:\s+(?:field|box|input))?$/i))) return [`fill ${titleCase(m[2])} = ${cap(m[1])}`];
  if ((m = p.match(/^(?:fill(?: in)?|set)\s+(?:the\s+)?(.+?)\s+(?:with|to)\s+(.+)$/i))) return [`fill ${titleCase(m[1])} = ${cap(m[2])}`];
  if ((m = p.match(/^(?:choose|select|pick)\s+(.+?)\s+(?:from|in|as)\s+(?:the\s+)?(.+?)(?:\s+(?:list|menu|dropdown))?$/i))) return [`select ${titleCase(m[2])} = ${cap(m[1])}`];
  if ((m = p.match(/^(?:tick|check the box|accept)\s+(?:the\s+)?(.+?)(?:\s+box)?$/i))) return [`check ${titleCase(m[1])}`];
  if ((m = p.match(/^wait(?:\s+for)?\s+(\d+)\s*(?:s|sec|secs|seconds?)?$/i))) return [`wait ${m[1]}`];
  if (/^(?:take a )?(?:screenshot|picture|photo)$/i.test(p)) return ["screenshot"];
  if ((m = p.match(/^(?:check|verify|make sure|ensure|confirm|expect)\s+(?:that\s+)?(?:the\s+)?(?:url|address)\s+(?:has|contains|is)\s+(.+)$/i))) return [`url has ${cap(m[1])}`];
  if ((m = p.match(/^(?:check|verify|make sure|ensure|confirm|expect)\s+(?:that\s+)?(?:there is no|no|it does not show|it doesn'?t show)\s+(.+)$/i))) return [`not see ${titleCase(m[1])}`];
  const check = "(?:check|verify|make sure|ensure|confirm|expect|see|should see)\\s+(?:that\\s+)?(?:the\\s+)?";
  if ((m = p.match(new RegExp(`^${check}(?:page\\s+)?title\\s+(?:is|shows|says|has|contains)\\s+(.+)$`, "i")))) return [`title has ${cap(m[1])}`];
  if ((m = p.match(new RegExp(`^${check}(.+?)\\s+(?:is|are)\\s+(?:shown|visible|displayed|there|on the page)$|^${check}(.+?)\\s+(?:appears|shows up)$`, "i")))) return [`see ${titleCase(m[1] ?? m[2])}`];
  if ((m = p.match(/^(?:check|verify|make sure|ensure|confirm|expect|see|should see)\s+(?:that\s+)?(?:the\s+)?(.+?)\s+(?:is|shows|says|reads|contains|has|equals)\s+(.+)$/i))) return [`see ${titleCase(m[1])}`, `see ${cap(m[2])}`];
  if ((m = p.match(/^(?:check|verify|make sure|ensure|confirm|expect|see|should see)\s+(?:that\s+)?(?:the\s+)?(.+)$/i))) return [`see ${titleCase(m[1])}`];
  if ((m = p.match(/^(?:click|press|tap|hit)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab|icon))?$/i))) return [`click ${titleCase(m[1])}`];
  return null;
}

/** GLV's own rules: splits the text into phrases and turns each into steps. Pure, for tests. */
export function rulesDraft(text: string): Draft {
  const phrases = text
    .split(/\r?\n|;|\.\s+|,\s*(?:and\s+)?then\s+|\s+then\s+|,\s+and\s+|,\s+(?=(?:log|sign|go|open|visit|add|put|search|type|enter|fill|choose|select|pick|tick|wait|take|check|verify|make|ensure|confirm|expect|see|click|press|tap)\b)|\s+and\s+(?=(?:log|sign|go|open|visit|add|search|type|enter|fill|choose|select|tick|wait|check|verify|make sure|ensure|confirm|expect|see|click|press|tap)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  const steps: string[] = [];
  const notes: string[] = [];
  for (const ph of phrases) {
    const got = phraseToSteps(ph);
    if (got === null) notes.push(`Not understood, write it as a step: "${ph}"`);
    else steps.push(...got);
  }
  if (steps.some((s) => s.includes("{{password}}"))) notes.push("Sign-in uses the project's saved login ({{username}} and {{password}}). Change Email or Log in if the form uses other words.");
  return { steps: steps.join("\n"), by: "rules", notes };
}

const DraftSchema = z.object({
  steps: z.array(z.string()).describe("Journey steps, one per item, using only the allowed step words."),
  notes: z.array(z.string()).describe("Short notes for the tester: assumptions made, or parts that could not be written as steps."),
});

const GRAMMAR = `Allowed steps (one per line, exactly these words first):
open <path or https address>
click <visible text of a button, link, tab or menu item>
fill <field label or placeholder> = <value>
select <list label> = <option text>
check <checkbox label> / uncheck <checkbox label>
press <key, e.g. Enter>
hover <text>
see <text that must be on the page> / not see <text>
url has <text> / title has <text>
wait <seconds, at most 15>
screenshot
Values may use {{username}} and {{password}} (the project's saved login), {{random}} (a unique word), {{today}}.`;

/** Asks Claude to write the steps, then checks them. */
async function claudeDraft(text: string, startUrl?: string): Promise<Draft> {
  const client = new Anthropic();
  const response = await client.beta.messages.parse({
    model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(DraftSchema) },
    messages: [
      {
        role: "user",
        content: `Turn this test, written by a tester in plain English, into browser journey steps for ${startUrl ?? "the site"}.\n\n${GRAMMAR}\n\nUse the words a person sees on screen as targets. Sign in with {{username}} and {{password}} unless the tester gives other values. After each important action add a "see" step that proves it worked. Do not invent pages or buttons the text does not imply.\n\nTest:\n${text}`,
      },
    ],
  });
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude's answer did not match the format.");
  return { steps: parsed.steps.join("\n"), by: "claude", notes: parsed.notes };
}

/** Writes journey steps from plain English: Claude when available, else GLV's rules. Always valid steps. */
export async function draftJourney(text: string, startUrl?: string): Promise<Draft> {
  const clean = text.slice(0, 4000).trim();
  if (!clean) throw new Error("Write what the test should do, in plain words.");
  if (aiEnabled() && process.env.PLAIN_TESTS_AI !== "off") {
    try {
      const d = await claudeDraft(clean, startUrl);
      parseSteps(d.steps);
      return d;
    } catch (err) {
      const rules = rulesDraft(clean);
      rules.notes.unshift(`Claude could not write it (${(err as Error).message.slice(0, 120)}), so GLV's rules did.`);
      return rules;
    }
  }
  const d = rulesDraft(clean);
  if (!d.steps) throw new Error(`None of it could be turned into steps. ${d.notes.join(" ")}`);
  parseSteps(d.steps);
  return d;
}
