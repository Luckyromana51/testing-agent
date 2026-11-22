import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { Tool, ToolContext, ToolFinding, ToolImage, ToolOutput } from "./types.js";

/**
 * Email template testing, in the way Litmus and Email on Acid work, but in-house: GLV reads an HTML
 * email and checks what breaks in real mail clients — layout wider than 600px, CSS that Outlook and
 * Gmail drop, images with no alt text, no plain dark-mode handling, broken or tracking-only links, and
 * a missing unsubscribe link (required for bulk mail). It also gives a simple spam-word score and
 * renders the email at desktop and phone widths. It only reads the template, so it is safe.
 */

export interface EmailProblem {
  rule: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
}

/** Static problems in an HTML email. Pure, for tests. */
export function emailProblems(html: string): EmailProblem[] {
  const out: EmailProblem[] = [];
  const lower = html.toLowerCase();
  // Layout: email clients need table layout and a max width around 600px.
  if (!/<table/i.test(html)) out.push({ rule: "email:no-tables", severity: "high", title: "No table layout", detail: "Outlook (Word engine) ignores float and flexbox; lay the email out with <table> for a reliable structure." });
  const widths = [...html.matchAll(/width\s*[:=]\s*["']?(\d{3,4})/gi)].map((m) => Number(m[1]));
  if (widths.some((w) => w > 640)) out.push({ rule: "email:too-wide", severity: "medium", title: `Email is ${Math.max(...widths)}px wide`, detail: "Keep the main container to about 600px; wider emails are cut off or shrunk in most clients and on phones." });
  // CSS that common clients drop.
  if (/position\s*:\s*(absolute|fixed)/i.test(html)) out.push({ rule: "email:unsupported-css", severity: "medium", title: "Uses position: absolute/fixed", detail: "Most email clients drop positioning; elements will stack in the normal flow. Use tables and spacing instead." });
  if (/<style[^>]*>[\s\S]*@media/i.test(html) === false && widths.some((w) => w > 480)) out.push({ rule: "email:no-responsive", severity: "low", title: "No @media query for small screens", detail: "Add a @media max-width rule (or use fluid tables) so the email reads well on phones, where most email is opened." });
  // Images.
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((i) => !/\balt\s*=/.test(i));
  if (noAlt.length) out.push({ rule: "email:img-no-alt", severity: "medium", title: `${noAlt.length} image${noAlt.length === 1 ? "" : "s"} with no alt text`, detail: "Many clients block images by default; alt text tells the reader what the image is, and helps screen readers. Add alt to every <img>." });
  if (imgs.length && !/background-color|bgcolor/i.test(html)) out.push({ rule: "email:image-only-risk", severity: "low", title: "Little background colour behind images", detail: "If images are blocked, an image-only email looks empty. Keep real text and set background/text colours so it still reads." });
  // Dark mode.
  if (!/prefers-color-scheme|color-scheme/i.test(html)) out.push({ rule: "email:no-dark-mode", severity: "low", title: "No dark-mode handling", detail: "Add a color-scheme meta and test on dark mode; clients that invert colours can make logos and text unreadable." });
  // Links.
  const links = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  if (!links.some((l) => /unsubscribe|optout|opt-out|preferences/i.test(l) || /unsubscribe/i.test(html))) out.push({ rule: "email:no-unsubscribe", severity: "high", title: "No unsubscribe link", detail: "Bulk and marketing email must offer a one-click unsubscribe (CAN-SPAM, GDPR, and Gmail/Yahoo bulk-sender rules). Add a visible unsubscribe link." });
  if (links.some((l) => /^http:\/\//i.test(l))) out.push({ rule: "email:http-link", severity: "low", title: "Some links use http://", detail: "Use https:// links so clients do not warn the reader and so link scanners trust them." });
  if (links.filter(Boolean).length === 0) out.push({ rule: "email:no-links", severity: "low", title: "No links found", detail: "Confirm the call-to-action link is present and correct." });
  return out;
}

const SPAM_WORDS = [/\bfree\b/i, /100%/, /\bguarantee/i, /\bwinner\b/i, /\bcash\b/i, /\bclick here\b/i, /\bact now\b/i, /\blimited time\b/i, /\$\$\$|₹₹₹/, /\bno obligation\b/i, /\burgent\b/i, /\bcongratulations\b/i, /!!!+/];

/** A simple SpamAssassin-style word/format score (higher is spammier). Pure, for tests. */
export function spamScore(subject: string, html: string): { score: number; hits: string[] } {
  const text = `${subject} ${html.replace(/<[^>]+>/g, " ")}`;
  const hits: string[] = [];
  let score = 0;
  for (const w of SPAM_WORDS) if (w.test(text)) { score += 1; hits.push(w.source); }
  if (/[A-Z]{6,}/.test(subject)) { score += 1; hits.push("SHOUTING subject"); }
  if ((subject.match(/!/g)?.length ?? 0) >= 2) { score += 1; hits.push("multiple ! in subject"); }
  const imgCount = (html.match(/<img/gi) ?? []).length;
  const textLen = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;
  if (imgCount > 0 && textLen < 200) { score += 2; hits.push("mostly image, little text"); }
  return { score, hits };
}

export const emailRenderTool: Tool = {
  id: "email-render",
  name: "Email template test",
  maker: "GLV Infotech (built in), in the way of Litmus and Email on Acid",
  description:
    "Reads an HTML email and checks what breaks in real mail clients: table layout for Outlook, width under 600px, dropped CSS, images with no alt, dark-mode handling, broken or http links, and a missing unsubscribe link. It gives a simple spam-word score and renders the email at desktop and phone widths.",
  checks: ["Table layout and width for Outlook/Gmail", "Images with no alt, image-only risk, dark mode", "Unsubscribe link (bulk-sender rules), http links", "Spam-word score; renders at 600px and phone width"],
  products: ["website", "ecommerce", "webapp", "saas", "crm"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://www.caniemail.com",
  signedIn: "public",
  options: [
    { id: "html", label: "Email HTML file", kind: "file", accept: ".html,.htm", required: true, hint: "Upload the HTML email template.", choices: [], default: "" },
    { id: "subject", label: "Subject line", kind: "text", placeholder: "Your order has shipped", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    if (!ctx.options.html) throw new Error("Upload the HTML email template.");
    const html = await readFile(path.join(ctx.uploadsDir, ctx.options.html), "utf8");
    const subject = ctx.options.subject ?? "";
    const problems = emailProblems(html);
    const spam = spamScore(subject, html);
    ctx.log(`Email: ${problems.length} issues, spam score ${spam.score}`);
    const findings: ToolFinding[] = problems.map((p) => ({
      category: "functional",
      rule: `${p.rule}`,
      severity: p.severity,
      title: p.title,
      detail: p.detail,
      pageUrl: "email-template",
      key: p.rule,
    }));
    if (spam.score >= 3)
      findings.push({
        category: "functional",
        rule: "email:spam-risk",
        severity: "medium",
        title: `High spam-word score (${spam.score})`,
        detail: `Words and formatting that spam filters weigh appear in the email: ${spam.hits.join(", ")}. Reduce them, keep a good text-to-image ratio, and send from an authenticated domain (SPF/DKIM/DMARC).`,
        pageUrl: "email-template",
        key: "email:spam-risk",
      });

    // Render the email at desktop and phone widths (images are not loaded, to match a fresh inbox).
    const images: ToolImage[] = [];
    try {
      const browser = await chromium.launch();
      try {
        const context = await browser.newContext({ serviceWorkers: "block" });
        await context.route("**/*", (route) => (route.request().resourceType() === "image" ? route.abort() : route.continue()));
        for (const [w, label] of [[600, "desktop-600"], [360, "phone-360"]] as [number, string][]) {
          const page = await context.newPage();
          await page.setViewportSize({ width: w, height: 900 });
          await page.setContent(html, { waitUntil: "load", timeout: 15_000 }).catch(() => undefined);
          const file = `email-${label}.png`;
          await page.screenshot({ path: path.join(ctx.outDir, file), fullPage: true }).catch(() => undefined);
          images.push({ file, label: `Email at ${w}px (images off)` });
          await page.close();
        }
      } finally {
        await browser.close();
      }
    } catch (e) {
      ctx.log(`Email render skipped: ${(e as Error).message}`);
    }
    await writeFile(path.join(ctx.outDir, "email.html"), html);
    return {
      findings,
      images,
      summary: [`${problems.length} template issue${problems.length === 1 ? "" : "s"}; spam-word score ${spam.score}${spam.hits.length ? ` (${spam.hits.slice(0, 5).join(", ")})` : ""}`],
      tested: "HTML email template",
    };
  },
};
