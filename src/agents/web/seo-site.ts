import { finding } from "../../runner/finding.js";
import { normaliseUrl } from "../../runner/urls.js";
import { PUBLIC_WEB_PRODUCTS } from "../../products.js";
import type { Finding, PageResult } from "../../types.js";
import type { PageAgent, SiteAgent } from "../types.js";

/**
 * Search checks across pages: how many clicks each page is from the home page, internal links
 * that go through a redirect, pages with too little text, and addresses search engines handle badly.
 */

const list = (items: string[], max = 8) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const norm = (u: string) => {
  try {
    return normaliseUrl(u);
  } catch {
    return u;
  }
};

/** Clicks from the first page to every tested page, following the links the pages really have. */
export function clickDepths(pages: PageResult[], pageLinks: Map<string, string[]>): Map<string, number> {
  // A link to an address that redirects reaches the page it lands on.
  const landing = new Map<string, string>();
  for (const p of pages) {
    landing.set(norm(p.url), norm(p.url));
    if (p.redirectedFrom) landing.set(norm(p.redirectedFrom), norm(p.url));
  }
  const links = new Map<string, string[]>();
  for (const [from, to] of pageLinks) links.set(norm(from), to.map(norm));
  const depth = new Map<string, number>();
  if (!pages.length) return depth;
  const start = norm(pages[0].url);
  depth.set(start, 0);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const raw of links.get(at) ?? []) {
      const to = landing.get(raw);
      if (!to || depth.has(to)) continue;
      depth.set(to, depth.get(at)! + 1);
      queue.push(to);
    }
  }
  return depth;
}

export const linkGraphAgent: SiteAgent = {
  id: "seo.link-graph",
  name: "Site structure",
  description:
    "Maps the links between the tested pages: pages more than 3 clicks from the home page (search engines and visitors reach them less), and internal links that point to an old address and go through a redirect.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run({ pages, pageLinks, linkSources }) {
    const out: Finding[] = [];
    const good = pages.filter((p) => !p.error && (p.status ?? 0) < 400);
    const depth = clickDepths(pages, pageLinks);
    const deep = good.filter((p) => (depth.get(norm(p.url)) ?? 0) > 3);
    if (deep.length) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:deep-page",
          severity: "low",
          title: `${deep.length} page${deep.length === 1 ? " is" : "s are"} more than 3 clicks from the home page`,
          detail:
            "Search engines visit and rank deeply buried pages less, and visitors rarely find them. Link important pages from the menu, the footer, category pages or related articles.",
          pageUrl: pages[0].url,
          evidence: list(deep.map((p) => `${p.url}: ${depth.get(norm(p.url))} clicks`)),
          count: deep.length,
        }),
      );
    }
    // Links inside the site that lead to an address which then redirects (not the start address the tester typed).
    const moved = pages.slice(1).filter((p) => p.redirectedFrom && linkSources.has(p.redirectedFrom) && !p.error);
    if (moved.length) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:internal-redirect",
          severity: "low",
          title: `${moved.length} internal link${moved.length === 1 ? " goes" : "s go"} through a redirect`,
          detail:
            "The site links to an old address that then redirects to the new one. Every visit costs an extra round trip, and search engines pass on less ranking through redirects. Update the links to point straight at the new address.",
          pageUrl: pages[0].url,
          evidence: list(moved.map((p) => `${p.redirectedFrom} → ${p.url} (linked from ${linkSources.get(p.redirectedFrom!)})`)),
          count: moved.length,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Pages that are short on purpose. */
const SHORT_ON_PURPOSE =
  /\/(contact|contact-us|login|log-in|signin|sign-in|register|signup|sign-up|cart|basket|bag|checkout|account|my-account|search|thank-you|thanks|404|wishlist|compare|track|order|password|reset|logout|feed|amp)(\/|\.|$|\?)|[?&](s|q|search)=/i;

const WORDS_JS = `(function () {
  var root = document.querySelector("main, [role=main], article") || document.body;
  if (!root) return { words: 0, media: 0, noindex: false };
  var clone = root.cloneNode(true);
  var drop = clone.querySelectorAll("nav, header, footer, aside, script, style, noscript, form, [role=navigation], [role=banner], [role=contentinfo]");
  for (var i = 0; i < drop.length; i++) drop[i].remove();
  var text = (clone.textContent || "").replace(/\\s+/g, " ").trim();
  var cjk = (text.match(/[\\u3040-\\u30FF\\u4E00-\\u9FFF\\u0E00-\\u0E7F]/g) || []).length;
  var words = text ? text.split(" ").length : 0;
  var media = root.querySelectorAll("img, video, iframe, picture, canvas").length;
  var fields = root.querySelectorAll("form input:not([type=hidden]), form select, form textarea").length;
  var robots = (document.querySelector('meta[name="robots"]') || {}).content || "";
  return { words: cjk > 100 ? -1 : words, media: media, fields: fields, noindex: /noindex/i.test(robots) };
})()`;

export const thinContentAgent: PageAgent = {
  id: "seo.thin-content",
  name: "Thin pages",
  description:
    "Counts the words in each page's main content, without menus, header and footer. Pages under 150 words rarely rank on Google. Contact, sign-in, cart, search, form and gallery pages are left out, since they are short on purpose.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url, isFirst }) {
    if (isFirst || SHORT_ON_PURPOSE.test(new URL(url).pathname + new URL(url).search)) return [];
    const c = (await page.evaluate(WORDS_JS)) as { words: number; media: number; fields: number; noindex: boolean };
    // A gallery, video or product grid says it with pictures, a form page with its form; noindex pages are not for search.
    if (c.words < 0 || c.noindex || c.media >= 6 || c.fields >= 3 || c.words >= 150) return [];
    return [
      finding({
        category: "seo",
        rule: "seo:thin-content",
        severity: "low",
        title: `Only ${c.words} word${c.words === 1 ? "" : "s"} of content on the page`,
        detail:
          "Search engines rarely rank pages with this little text, and may treat many of them as low quality for the whole site. Add useful detail (what it is, who it is for, prices, questions people ask), merge it with a similar page, or mark it noindex if it is not meant for search.",
        pageUrl: url,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------

const SESSION_IN_URL = /[;?&](jsessionid|phpsessid|sessionid|session_id|sid|aspsessionid\w*|cfid|cftoken|zenid|osCsid)=/i;

export const urlsAgent: SiteAgent = {
  id: "seo.urls",
  name: "Page addresses",
  description:
    "Reads every tested page's address: session ids in the address (duplicate pages, and a session that leaks when the link is shared), capital letters, underscores, and addresses over 115 characters.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  run({ pages }) {
    const urls = [...new Set(pages.filter((p) => !p.error && (p.status ?? 0) < 400).map((p) => p.url))];
    const out: Finding[] = [];
    const first = pages[0]?.url ?? "";
    const path = (u: string) => {
      try {
        return decodeURIComponent(new URL(u).pathname);
      } catch {
        return new URL(u).pathname;
      }
    };
    /** The title's words for one address and for several. */
    const add = (rule: string, severity: Finding["severity"], hits: string[], title: [one: string, many: string], detail: string, category: Finding["category"] = "seo") => {
      if (!hits.length) return;
      out.push(
        finding({
          category,
          rule,
          severity,
          title: `${hits.length} page address${hits.length === 1 ? ` ${title[0]}` : `es ${title[1]}`}`,
          detail,
          pageUrl: first,
          evidence: list(hits),
          count: hits.length,
        }),
      );
    };
    add(
      "seo:session-in-url",
      "medium",
      urls.filter((u) => SESSION_IN_URL.test(u)),
      ["carries a session id", "carry a session id"],
      "Each visitor then gets different addresses for the same page, which search engines count as duplicates, and anyone who shares a link shares their session. Keep sessions in cookies only.",
      "security",
    );
    add(
      "seo:url-uppercase",
      "info",
      urls.filter((u) => /[A-Z]/.test(path(u))),
      ["uses capital letters", "use capital letters"],
      "Addresses are case-sensitive: /About and /about are two pages to a search engine, and people typing the address get it wrong. Use lower case, and redirect the old addresses.",
    );
    add(
      "seo:url-underscore",
      "info",
      urls.filter((u) => /_/.test(path(u))),
      ["joins words with underscores", "join words with underscores"],
      "Google reads hyphens as spaces between words but underscores as part of one word, so red_shoes is one word to it. Use hyphens in new addresses (keep existing ones unless you redirect them).",
    );
    add(
      "seo:url-long",
      "info",
      urls.filter((u) => u.length > 115),
      ["is over 115 characters", "are over 115 characters"],
      "Long addresses are cut off in search results and are hard to share. Keep the words that describe the page and drop dates, ids and filler words.",
    );
    return out;
  },
};
