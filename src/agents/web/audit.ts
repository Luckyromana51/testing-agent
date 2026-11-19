import { writeFile } from "node:fs/promises";
import path from "node:path";
import { finding } from "../../runner/finding.js";
import { normaliseUrl } from "../../runner/urls.js";
import { PUBLIC_WEB_PRODUCTS, WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, SiteAgent } from "../types.js";

/**
 * Site-audit checks that Screaming Frog, Sitebulb, Ahrefs, Burp and Mozilla Observatory have and we
 * did not: redirect chains, content only JavaScript draws, orphan pages, CORS and CSP strength.
 * All of them only read: GET requests, like any visitor.
 */

// ---- Redirect chains -----------------------------------------------------------------------------

export const redirectChainAgent: PageAgent = {
  id: "seo.redirect-chain",
  name: "Redirect chains",
  description: "Finds pages reached through two or more redirects in a row (http → https → www → page), and temporary redirects that should be permanent.",
  category: "seo",
  engine: "web",
  products: [...PUBLIC_WEB_PRODUCTS],
  stage: "page",
  run: ({ response, url }) => {
    if (!response) return [];
    const chain: string[] = [];
    let r = response.request().redirectedFrom();
    while (r && chain.length < 20) {
      chain.unshift(r.url());
      r = r.redirectedFrom();
    }
    if (!chain.length) return [];
    const out: Finding[] = [];
    const hops = [...chain, url];
    if (chain.length >= 2) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:redirect-chain",
          severity: chain.length >= 3 ? "medium" : "low",
          title: `The page is reached through ${chain.length} redirects in a row`,
          detail: `Each redirect costs visitors a round trip and search engines may stop following after a few. Point links, the sitemap and the canonical tag straight at ${url}, and make the first address redirect there in one step.`,
          pageUrl: url,
          evidence: hops.join(" → "),
        }),
      );
    }
    return out;
  },
};

// ---- Content only JavaScript draws ---------------------------------------------------------------

const textOf = (html: string) =>
  html
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
const words = (s: string) => (s.match(/[\p{L}\p{N}]{2,}/gu) ?? []).length;
const tag = (html: string, re: RegExp) => html.match(re)?.[1]?.replace(/\s+/g, " ").trim() ?? "";

export interface RawVsRendered {
  raw: { words: number; title: string; h1: string; description: string; canonical: string; links: number };
  rendered: { words: number; title: string; h1: string; description: string; canonical: string; links: number };
}

export function compareRendered(rawHtml: string, renderedHtml: string): RawVsRendered {
  const read = (html: string) => {
    // Markup inside scripts is not part of the page until the script runs.
    const h = html.replace(/<(script|template|noscript)[\s\S]*?<\/\1>/gi, " ");
    return {
    words: words(textOf(h.replace(/^[\s\S]*?<body[^>]*>/i, ""))),
    title: tag(h, /<title[^>]*>([\s\S]*?)<\/title>/i),
    h1: textOf(tag(h, /<h1[^>]*>([\s\S]*?)<\/h1>/i)),
    description: tag(h, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)/i),
    canonical: tag(h, /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']*)/i),
    links: (h.match(/<a\s[^>]*href=/gi) ?? []).length,
    };
  };
  return { raw: read(rawHtml), rendered: read(renderedHtml) };
}

export const renderedHtmlAgent: PageAgent = {
  id: "seo.rendered-html",
  name: "Raw vs rendered HTML",
  description:
    "Compares the HTML the server sends with the page after JavaScript runs, like Screaming Frog's rendering check: text, title, main heading, description and links that only JavaScript adds may be missed by search engines and link previews.",
  category: "seo",
  engine: "web",
  products: [...PUBLIC_WEB_PRODUCTS],
  stage: "page",
  skipErrorPages: true,
  run: async ({ page, url, browser, result, index, artifactsDir }) => {
    let raw = "";
    try {
      const res = await browser.request.get(url, { timeout: 15_000, headers: { accept: "text/html" } });
      if (!res.ok() || !/html/i.test(res.headers()["content-type"] ?? "")) return [];
      raw = (await res.text()).slice(0, 3_000_000);
    } catch {
      return [];
    }
    const rendered = await page.content();
    const c = compareRendered(raw, rendered);
    const file = `page-${index}-rendered.json`;
    await writeFile(path.join(artifactsDir, file), JSON.stringify(c, null, 1)).catch(() => {});
    result.files = [...(result.files ?? []), { label: "Raw vs rendered HTML", file }];
    const out: Finding[] = [];
    const missing = (["title", "h1", "description", "canonical"] as const).filter((k) => !c.raw[k] && c.rendered[k]);
    if (c.rendered.words >= 80 && c.raw.words < c.rendered.words * 0.3) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:js-only-content",
          severity: "medium",
          title: "Most of the page's text appears only after JavaScript runs",
          detail: `The server sends ${c.raw.words} words; after JavaScript the page has ${c.rendered.words}. Google renders JavaScript later and not always; other search engines, AI crawlers and link previews often do not. Render the main content on the server (SSR, pre-rendering or static HTML).`,
          pageUrl: url,
          evidence: `raw ${c.raw.words} words, rendered ${c.rendered.words} words`,
        }),
      );
    }
    if (missing.length) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:js-only-tags",
          severity: missing.includes("title") || missing.includes("canonical") ? "medium" : "low",
          title: `${missing.map((m) => (m === "h1" ? "main heading" : m)).join(", ")} added only by JavaScript`,
          detail: "These are missing from the HTML the server sends and appear only after scripts run. Link previews (WhatsApp, LinkedIn, Slack) and many crawlers read only the server's HTML. Put them in the server's HTML.",
          pageUrl: url,
          evidence: missing.map((m) => `${m}: "${String(c.rendered[m]).slice(0, 80)}"`).join("\n"),
        }),
      );
    }
    if (c.rendered.links >= 5 && c.raw.links < c.rendered.links * 0.3) {
      out.push(
        finding({
          category: "seo",
          rule: "seo:js-only-links",
          severity: "low",
          title: "Most links appear only after JavaScript runs",
          detail: `The server's HTML has ${c.raw.links} links; the rendered page has ${c.rendered.links}. Crawlers that do not run scripts cannot find the other pages. Use real <a href> links in the server's HTML.`,
          pageUrl: url,
        }),
      );
    }
    return out;
  },
};

// ---- Orphan pages --------------------------------------------------------------------------------

export const orphanPagesAgent: SiteAgent = {
  id: "seo.orphans",
  name: "Orphan pages",
  description: "Pages listed in the sitemap that no tested page links to. Checked only when the test reached every page the site links to, so the answer is sure.",
  category: "seo",
  engine: "web",
  products: [...PUBLIC_WEB_PRODUCTS],
  stage: "site",
  run: async ({ browser, origin, pages, pageLinks, log }) => {
    const crawled = new Set(pages.flatMap((p) => [p.url, p.redirectedFrom].filter((u): u is string => Boolean(u)).map((u) => normaliseUrl(u))));
    const internal = new Set<string>();
    for (const links of pageLinks.values()) {
      for (const l of links) {
        try {
          if (new URL(l).origin === origin) internal.add(normaliseUrl(l));
        } catch {
          // not an address
        }
      }
    }
    // Every internal link must have been tested, or a page we did not open could be the one linking.
    const skipped = [...internal].filter((l) => !crawled.has(l) && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i.test(l));
    if (skipped.length) {
      log(`Orphan pages: not checked, ${skipped.length} linked pages were not tested (raise the page limit to check)`);
      return [];
    }
    let text = "";
    for (const u of [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`]) {
      try {
        const r = await browser.request.get(u, { timeout: 15_000 });
        if (r.ok()) {
          text = await r.text();
          if (/<(urlset|sitemapindex)/i.test(text)) break;
        }
      } catch {
        // try the next
      }
      text = "";
    }
    if (!text || /<sitemapindex/i.test(text)) return [];
    const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
    const linked = new Set([...internal, ...crawled]);
    const start = pages[0] ? normaliseUrl(pages[0].url) : "";
    const orphans = locs
      .map((l) => {
        try {
          return normaliseUrl(l);
        } catch {
          return "";
        }
      })
      .filter((l) => l && l !== start && l.startsWith(origin) && !linked.has(l));
    if (!orphans.length) return [];
    return [
      finding({
        category: "seo",
        rule: "seo:orphan-page",
        severity: orphans.length >= 5 ? "medium" : "low",
        title: `${orphans.length} page${orphans.length === 1 ? " is" : "s are"} in the sitemap but linked from nowhere`,
        detail: "Visitors cannot reach these pages and search engines treat pages with no links as unimportant. Link to them from a menu, a category page or related posts, or take them out of the sitemap if they are old.",
        pageUrl: `${origin}/sitemap.xml`,
        evidence: orphans.slice(0, 20).join("\n"),
      }),
    ];
  },
};

// ---- CORS ----------------------------------------------------------------------------------------

const EVIL = "https://glv-cors-check.example";

export const corsAgent: PageAgent = {
  id: "sec.cors",
  name: "CORS",
  description: "Asks the page and the site's own API calls (GET only) as if from another website: answers that let any site read them, with the visitor's cookies, are a data leak.",
  category: "security",
  engine: "web",
  products: [...WEB_PRODUCTS],
  stage: "end",
  run: async ({ url, browser, signals, isFirst }) => {
    const origin = new URL(url).origin;
    const targets = new Set<string>(isFirst ? [url] : []);
    for (const r of signals.responses) {
      if ((r.type === "fetch" || r.type === "xhr") && r.status < 400) {
        try {
          if (new URL(r.url).origin === origin) targets.add(r.url.split("#")[0]);
        } catch {
          // not an address
        }
      }
      if (targets.size >= 6) break;
    }
    const out: Finding[] = [];
    for (const t of targets) {
      try {
        const res = await browser.request.get(t, { timeout: 10_000, headers: { Origin: EVIL }, maxRedirects: 0 });
        const h = res.headers();
        const acao = h["access-control-allow-origin"];
        const creds = h["access-control-allow-credentials"] === "true";
        if (acao === EVIL || acao === "null") {
          out.push(
            finding({
              category: "security",
              rule: "sec:cors-reflects-origin",
              severity: creds ? "high" : "medium",
              title: creds ? "Any website can read this address with the visitor's login" : "Any website can read this address",
              detail: `Asked as if from ${EVIL}, the server answered Access-Control-Allow-Origin: ${acao}${creds ? " with Access-Control-Allow-Credentials: true, so another site can read signed-in visitors' data" : ""}. Allow only your own sites by name (a fixed list), never echo the Origin header.`,
              pageUrl: t,
              evidence: `Access-Control-Allow-Origin: ${acao}${creds ? "\nAccess-Control-Allow-Credentials: true" : ""}`,
            }),
          );
        }
      } catch {
        // unreachable: nothing to say
      }
    }
    return out;
  },
};

// ---- CSP strength --------------------------------------------------------------------------------

export function cspProblems(csp: string): string[] {
  const dirs = new Map<string, string[]>();
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) dirs.set(name.toLowerCase(), values);
  }
  const script = dirs.get("script-src") ?? dirs.get("default-src");
  const problems: string[] = [];
  if (!script) problems.push("no script-src or default-src: scripts from anywhere can run");
  else {
    const hasNonce = script.some((v) => /^'(nonce-|sha(256|384|512)-)/.test(v));
    const strictDynamic = script.includes("'strict-dynamic'");
    if (script.includes("'unsafe-inline'") && !hasNonce) problems.push("'unsafe-inline' in script-src: injected inline scripts run (no protection against XSS)");
    if (script.includes("'unsafe-eval'")) problems.push("'unsafe-eval' in script-src: eval() and new Function() are allowed");
    if (!strictDynamic && script.some((v) => v === "*" || v === "https:" || v === "http:" || v === "data:")) problems.push(`script-src allows ${script.find((v) => v === "*" || v === "https:" || v === "http:" || v === "data:")}: scripts from any site run`);
  }
  const obj = dirs.get("object-src") ?? dirs.get("default-src");
  if (!obj || !obj.includes("'none'")) problems.push("no object-src 'none': old plugin content (Flash, Java) is allowed");
  if (!dirs.has("base-uri")) problems.push("no base-uri: an injected <base> tag can redirect the page's scripts");
  return problems;
}

export const cspAgent: PageAgent = {
  id: "sec.csp-strength",
  name: "CSP strength",
  description: "Reads the Content-Security-Policy like Google's CSP Evaluator and Mozilla Observatory: unsafe-inline, unsafe-eval, wildcards, and missing object-src and base-uri.",
  category: "security",
  engine: "web",
  products: [...WEB_PRODUCTS],
  stage: "page",
  run: ({ response, url, isFirst }) => {
    const csp = response?.headers()["content-security-policy"];
    if (!csp || !isFirst) return [];
    const problems = cspProblems(csp);
    if (!problems.length) return [];
    const serious = problems.some((p) => /unsafe-inline|any site|no script-src/.test(p));
    return [
      finding({
        category: "security",
        rule: "sec:csp-weak",
        severity: serious ? "medium" : "low",
        title: `The Content-Security-Policy is weak (${problems.length} problem${problems.length === 1 ? "" : "s"})`,
        detail: `${problems.join("; ")}. Use nonces or hashes for inline scripts with 'strict-dynamic', and add object-src 'none' and base-uri 'self'.`,
        pageUrl: url,
        evidence: csp.slice(0, 500),
      }),
    ];
  },
};
