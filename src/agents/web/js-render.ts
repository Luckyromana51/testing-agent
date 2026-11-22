import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, PageContext } from "../types.js";
import { getText } from "./geo.js";

/**
 * JavaScript SEO render diff: Google first reads the HTML the server sends, then (later, and not
 * always) runs the JavaScript. If the main content or the internal links only appear after the
 * JavaScript runs, Google may index an almost-empty page or miss links. This compares the raw HTML
 * the server returns with the page after the browser has rendered it, and flags a big gap.
 */

/** Visible words in HTML (scripts, styles and tags stripped). Pure, for tests. */
export function textWords(html: string): number {
  const text = html.replace(/<(script|style|template|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Internal <a href> count in HTML. Pure, for tests. */
export function linkCount(html: string): number {
  return (html.match(/<a\b[^>]*\bhref=["'](?!#|javascript:|mailto:|tel:)[^"']+["']/gi) ?? []).length;
}

/** Whether the gap between raw and rendered is big enough to matter. Pure, for tests. */
export function renderGap(rawWords: number, renderedWords: number, rawLinks: number, renderedLinks: number): { contentOnlyInJs: boolean; linksOnlyInJs: boolean } {
  return {
    contentOnlyInJs: renderedWords >= 150 && rawWords < Math.max(50, renderedWords * 0.3),
    linksOnlyInJs: renderedLinks >= 10 && rawLinks < Math.max(3, renderedLinks * 0.3),
  };
}

async function jsRenderFindings(ctx: PageContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const raw = await getText(ctx.browser.request, ctx.url).catch(() => null);
  if (!raw || raw.status >= 400 || !/html/i.test(raw.type)) return out;
  const rendered = await ctx.page.content().catch(() => "");
  if (!rendered) return out;
  const rawWords = textWords(raw.text);
  const renderedWords = textWords(rendered);
  const rawLinks = linkCount(raw.text);
  const renderedLinks = linkCount(rendered);
  const gap = renderGap(rawWords, renderedWords, rawLinks, renderedLinks);
  if (gap.contentOnlyInJs)
    out.push(
      finding({
        category: "seo",
        rule: "seo:content-needs-js",
        severity: "medium",
        title: "Most of the page's content appears only after JavaScript runs",
        detail: `The HTML the server sent has about ${rawWords} words, but after rendering there are about ${renderedWords}. Search engines that do not run the JavaScript (and AI crawlers, link previews and old browsers) see an almost-empty page. Render the main content on the server (SSR) or pre-render it.`,
        pageUrl: ctx.url,
        evidence: `Raw HTML: ${rawWords} words\nAfter JavaScript: ${renderedWords} words`,
      }),
    );
  if (gap.linksOnlyInJs)
    out.push(
      finding({
        category: "seo",
        rule: "seo:links-need-js",
        severity: "low",
        title: "Internal links appear only after JavaScript runs",
        detail: `The raw HTML has ${rawLinks} internal links; the rendered page has ${renderedLinks}. A crawler that does not run JavaScript cannot follow the extra links, so those pages may go undiscovered. Put real <a href> links in the server HTML.`,
        pageUrl: ctx.url,
        evidence: `Raw HTML: ${rawLinks} links\nAfter JavaScript: ${renderedLinks} links`,
      }),
    );
  return out;
}

export const jsRenderAgent: PageAgent = {
  id: "seo.js-render",
  name: "JavaScript SEO render diff",
  description: "Compares the HTML the server sends with the page after the browser renders it; flags pages whose main content or internal links appear only after JavaScript runs, which search engines may miss.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  run: jsRenderFindings,
};
