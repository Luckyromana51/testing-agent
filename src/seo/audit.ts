import { readFile } from "node:fs/promises";
import type { SiteAgent } from "../agents/types.js";
import { uploadedPath } from "../engines/index.js";
import { PUBLIC_WEB_PRODUCTS } from "../products.js";
import { finding } from "../runner/finding.js";
import { siteOf } from "../runner/urls.js";
import type { Finding, SeoInput, SeoReport } from "../types.js";
import { rumFindings } from "../rum.js";

/*
 * An SEO audit made in-house, in the spirit of Ahrefs or SEMrush, with what can honestly be done
 * without their web-wide crawl or Google's own data:
 * - keywords: how well each page targets the words the owner chose (title, H1, address, description, text)
 * - backlinks: the owner's list of pages that link here (from the client, an outreach sheet or
 *   Search Console's Links export) is visited, to check each link is still there, where it points,
 *   its anchor text and whether it passes value (nofollow, sponsored, ugc)
 * - Search Console: the client's own export (CSV) shows real Google positions; queries just off
 *   page one ("striking distance") and pages with few clicks for their position are listed
 * - outbound links: how many other sites the pages link to, and how many of those links are nofollow
 * What it cannot do is said in the report: find backlinks nobody listed, or check rankings by
 * searching Google (Google does not allow automated searches; that is what the export is for).
 */

export const SEO_LIMITS = [
  "Backlinks are checked from the list you give. Finding links nobody listed needs a crawl of the whole web (what Ahrefs and SEMrush run); this audit does not guess them.",
  "Google positions come from the Search Console export you upload (your own data). The test never searches Google itself: Google does not allow automated searches, and results change by place and person.",
  "Domain or page \"authority\" scores are made-up numbers from those services' own crawls, so none is shown.",
];

const strip = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const first = (html: string, re: RegExp) => strip(html.match(re)?.[1] ?? "");

export interface PageText {
  title: string;
  h1: string;
  description: string;
  text: string;
}

export function readPage(html: string): PageText {
  return {
    title: first(html, /<title[^>]*>([\s\S]*?)<\/title>/i),
    h1: (html.match(/<h1[^>]*>[\s\S]*?<\/h1>/gi) ?? []).map(strip).join(" "),
    description: html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ?? "",
    text: strip(html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html),
  };
}

const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** How well a page targets a keyword, out of 100, and where the keyword is. */
export function keywordFit(page: PageText, url: string, keyword: string): Omit<SeoReport["keywords"][number], "page" | "keyword"> {
  const k = words(keyword);
  const has = (s: string) => Boolean(k) && ` ${words(s)} `.includes(` ${k} `);
  const body = ` ${words(page.text)} `;
  let count = 0;
  for (let at = body.indexOf(` ${k} `); k && at >= 0; at = body.indexOf(` ${k} `, at + 1)) count++;
  let path = "";
  try {
    path = decodeURIComponent(new URL(url).pathname).replace(/[-_/.]+/g, " ");
  } catch {
    /* not an address */
  }
  const inTitle = has(page.title);
  const inH1 = has(page.h1);
  const inUrl = has(path);
  const inDescription = has(page.description);
  const score = (inTitle ? 30 : 0) + (inH1 ? 25 : 0) + (inUrl ? 15 : 0) + (inDescription ? 15 : 0) + (count >= 2 ? 15 : count === 1 ? 8 : 0);
  return { inTitle, inH1, inUrl, inDescription, count, score };
}

/** "https://site/page | one, two" or "/page | one" lines. */
export function parseKeywords(text: string, origin: string): { url: string; keywords: string[] }[] {
  const out: { url: string; keywords: string[] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [where, list] = line.split("|").map((x) => x?.trim());
    if (!where || !list) continue;
    let url: string;
    try {
      url = new URL(where, origin).href;
    } catch {
      continue;
    }
    const keywords = list.split(",").map((k) => k.trim()).filter((k) => k.length >= 2).slice(0, 10);
    if (keywords.length) out.push({ url, keywords });
  }
  return out.slice(0, 50);
}

/** The links in a page's HTML: address, rel and anchor text. */
export function anchors(html: string, pageUrl: string): { href: string; rel: string; text: string }[] {
  const out: { href: string; rel: string; text: string }[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const raw = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
    let href: string;
    try {
      href = new URL(raw.replace(/&amp;/g, "&"), pageUrl).href;
    } catch {
      continue;
    }
    const rel = (attrs.match(/\brel\s*=\s*["']([^"']*)["']/i)?.[1] ?? "").toLowerCase();
    const img = m[2].match(/<img[^>]+alt=["']([^"']*)["']/i)?.[1];
    out.push({ href, rel, text: (strip(m[2]) || (img ? `[image: ${img}]` : "")).slice(0, 100) });
  }
  return out;
}

/** A CSV line, with quoted fields. */
function csvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") out.push(cur), (cur = "");
    else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const num = (s: string | undefined) => Number(String(s ?? "").replace(/[%,\s]/g, "")) || 0;

/** Search Console's Queries.csv or Pages.csv (Performance > Export), in any of its languages' English headers. */
export function parseSearchConsole(csv: string): NonNullable<SeoReport["searchConsole"]> | undefined {
  const lines = csv.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return undefined;
  const head = csvLine(lines[0]).map((h) => h.toLowerCase());
  const keyAt = head.findIndex((h) => /^(top )?(queries|query|pages|page)$/.test(h));
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const clicks = col(/^clicks$/);
  const impressions = col(/^impressions$/);
  const ctr = col(/^ctr$/);
  const position = col(/^position$/);
  if (keyAt < 0 || position < 0 || impressions < 0) return undefined;
  const kind = /page/.test(head[keyAt]) ? "pages" : "queries";
  const rows = lines
    .slice(1)
    .map(csvLine)
    .map((c) => ({ key: c[keyAt] ?? "", clicks: num(c[clicks]), impressions: num(c[impressions]), ctr: ctr >= 0 ? num(c[ctr]) : 0, position: Math.round(num(c[position]) * 10) / 10 }))
    .filter((r) => r.key)
    .sort((a, b) => b.impressions - a.impressions || a.key.localeCompare(b.key))
    .slice(0, 500);
  return { kind, rows, nearTop: rows.filter((r) => r.position > 3 && r.position <= 20 && r.impressions >= 50).length };
}

/** The share of clicks a result usually gets at a position (rounded industry averages). */
const EXPECTED_CTR = [0, 28, 15, 10, 7, 5, 4, 3, 2.5, 2, 1.8];

async function get(ctx: Parameters<SiteAgent["run"]>[0], url: string): Promise<{ status: number | null; html: string; final: string }> {
  try {
    const res = await ctx.browser.request.get(url, { timeout: 15_000, maxRedirects: 5, failOnStatusCode: false });
    const type = res.headers()["content-type"] ?? "";
    const html = /html|xml|text/.test(type) ? (await res.text()).slice(0, 2_000_000) : "";
    return { status: res.status(), html, final: res.url() };
  } catch {
    return { status: null, html: "", final: url };
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export const seoAuditAgent: SiteAgent = {
  id: "seo.audit",
  name: "SEO audit: keywords, backlinks, Search Console",
  description:
    "Checks how well pages target the keywords you chose, visits the pages you list as backlinks to check each link is still there and passes value, reads your Search Console export for queries just off page one, and counts outbound and nofollow links. Built in-house: it says plainly what needs outside data.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "site",
  async run(ctx) {
    const { site, pages, origin, log } = ctx;
    const input: SeoInput = site.seoInput ?? {};
    const out: Finding[] = [];
    const report: SeoReport = { keywords: [], backlinks: [], outbound: { total: 0, domains: 0, broken: [], nofollow: 0, sponsored: 0 }, limits: SEO_LIMITS };
    const host = new URL(origin).hostname;
    const ours = (u: string) => {
      try {
        return siteOf(new URL(u).hostname) === siteOf(host);
      } catch {
        return false;
      }
    };

    // The tested pages' HTML, read once.
    const good = pages.filter((p) => !p.error && (p.status ?? 0) < 400).slice(0, 30);
    const html = new Map<string, string>();
    await pool(good, 4, async (p) => html.set(p.url, (await get(ctx, p.url)).html));

    // Outbound links: other sites the pages link to.
    const domains = new Set<string>();
    for (const [url, h] of html) {
      for (const a of anchors(h, url)) {
        if (!/^https?:/.test(a.href) || ours(a.href)) continue;
        report.outbound.total++;
        domains.add(new URL(a.href).hostname);
        if (/\bnofollow\b/.test(a.rel)) report.outbound.nofollow++;
        if (/\bsponsored\b/.test(a.rel)) report.outbound.sponsored++;
      }
    }
    report.outbound.domains = domains.size;

    // Keywords per page.
    if (input.keywords) {
      for (const { url, keywords } of parseKeywords(input.keywords, origin)) {
        const tested = good.find((p) => p.url.replace(/\/$/, "") === url.replace(/\/$/, "") || p.redirectedFrom?.replace(/\/$/, "") === url.replace(/\/$/, ""));
        const pageHtml = tested ? html.get(tested.url) ?? "" : (await get(ctx, url)).html;
        if (!pageHtml) continue;
        const text = readPage(pageHtml);
        for (const keyword of keywords) {
          const fit = keywordFit(text, url, keyword);
          report.keywords.push({ page: url, keyword, ...fit });
          if (fit.score < 50) {
            const missing = [!fit.inTitle && "title", !fit.inH1 && "main heading (H1)", !fit.inDescription && "description", !fit.inUrl && "address", fit.count < 2 && "page text (at least twice)"].filter(Boolean);
            out.push(
              finding({
                category: "seo",
                rule: "seo:keyword-weak",
                severity: fit.score < 25 ? "medium" : "low",
                title: `The page is weak for "${keyword}"`,
                detail: `It scores ${fit.score}/100 for the keyword you chose. Search engines look first at the title, the main heading and the text. Add "${keyword}" to: ${missing.join(", ")}. Write it naturally; repeating it many times does not help.`,
                pageUrl: url,
                evidence: `Title: ${text.title.slice(0, 80) || "(none)"}\nH1: ${text.h1.slice(0, 80) || "(none)"}\nIn the text ${fit.count} time${fit.count === 1 ? "" : "s"}`,
                agent: "seo.audit",
              }),
            );
          }
        }
      }
      // Two pages chasing the same keyword compete with each other.
      const byKeyword = new Map<string, string[]>();
      for (const k of report.keywords) byKeyword.set(words(k.keyword), [...(byKeyword.get(words(k.keyword)) ?? []), k.page]);
      for (const [k, list] of byKeyword) {
        const pagesFor = [...new Set(list)];
        if (pagesFor.length > 1) {
          out.push(finding({ category: "seo", rule: "seo:keyword-cannibal", severity: "low", title: `Several pages aim at the same keyword "${k}"`, detail: "When two pages target the same words, search engines pick one (often the wrong one) and both rank lower. Give each page its own keyword, or merge them and redirect one to the other.", pageUrl: pagesFor[0], evidence: pagesFor.join("\n"), agent: "seo.audit" }));
        }
      }
    }

    // Backlinks: visit each listed page and look for the link.
    const backlinks = [...new Set((input.backlinks ?? "").split(/\r?\n/).map((l) => l.trim().split(/[\s,]+/)[0]).filter((l) => /^https?:\/\//i.test(l)))].slice(0, 100);
    if (backlinks.length) {
      log(`SEO audit: checking ${backlinks.length} backlink${backlinks.length === 1 ? "" : "s"}`);
      report.backlinks = await pool(backlinks, 4, async (from) => {
        site.signal?.throwIfAborted();
        const r = await get(ctx, from);
        if (r.status === null || r.status >= 400) return { from, status: r.status, linked: false, note: r.status === null ? "The page did not answer" : `The page answers HTTP ${r.status}` };
        const link = anchors(r.html, r.final).find((a) => ours(a.href));
        if (!link) return { from, status: r.status, linked: false, note: "The page no longer links to the site" };
        return { from, status: r.status, linked: true, to: link.href, anchor: link.text, rel: link.rel || undefined };
      });
      for (const b of report.backlinks) {
        if (!b.linked) {
          out.push(finding({ category: "seo", rule: b.status !== null && b.status < 400 ? "seo:backlink-lost" : "seo:backlink-page-gone", severity: "medium", title: b.status !== null && b.status < 400 ? "A backlink was removed" : "A page that linked here is gone", detail: `${b.from}: ${b.note}. Links from other sites are one of the strongest ranking signals. Ask the site's owner to put the link back, or replace it.`, pageUrl: origin, evidence: b.from, agent: "seo.audit" }));
        } else if (b.to) {
          const status = (await get(ctx, b.to)).status;
          if (status !== null && status >= 400) {
            out.push(finding({ category: "seo", rule: "seo:backlink-broken-target", severity: "high", title: "A backlink points at a page that no longer exists", detail: `${b.from} links to ${b.to}, which answers HTTP ${status}. The link's value is lost. Redirect ${new URL(b.to).pathname} (301) to the page that replaced it.`, pageUrl: b.to, evidence: `${b.from} → ${b.to} (${status})`, agent: "seo.audit" }));
          }
        }
      }
      const nofollow = report.backlinks.filter((b) => b.linked && /\b(nofollow|ugc|sponsored)\b/.test(b.rel ?? ""));
      if (nofollow.length && nofollow.length === report.backlinks.filter((b) => b.linked).length) {
        out.push(finding({ category: "seo", rule: "seo:backlinks-all-nofollow", severity: "info", title: "Every listed backlink is nofollow, sponsored or ugc", detail: "These links bring visitors but pass little ranking value. A mix with ordinary links from relevant sites helps more.", pageUrl: origin, evidence: nofollow.slice(0, 5).map((b) => `${b.from} (${b.rel})`).join("\n"), agent: "seo.audit" }));
      }
    }

    // Search Console: the client's own positions.
    if (input.gscFile && site.uploadsDir) {
      const csv = await readFile(uploadedPath(site.uploadsDir, input.gscFile), "utf8").catch(() => "");
      const gsc = parseSearchConsole(csv);
      if (!gsc) {
        log("SEO audit: the Search Console file is not a Queries or Pages export");
      } else {
        report.searchConsole = gsc;
        const near = gsc.rows.filter((r) => r.position > 3 && r.position <= 20 && r.impressions >= 50).slice(0, 15);
        if (near.length) {
          out.push(finding({ category: "seo", rule: "seo:striking-distance", severity: "low", title: `${near.length} ${gsc.kind === "queries" ? "searches" : "pages"} rank just below the top results`, detail: "These are already on Google's first or second page with many people seeing them. A better title, more helpful text and a few internal links usually move them into the top three, where most clicks go.", pageUrl: origin, evidence: near.map((r) => `${r.key}: position ${r.position}, ${r.impressions} views, ${r.clicks} clicks`).join("\n"), agent: "seo.audit" }));
        }
        const lowCtr = gsc.rows.filter((r) => r.position >= 1 && r.position <= 10 && r.impressions >= 200 && r.ctr > 0 && r.ctr < EXPECTED_CTR[Math.max(1, Math.round(r.position))] / 2).slice(0, 10);
        if (lowCtr.length) {
          out.push(finding({ category: "seo", rule: "seo:low-ctr", severity: "low", title: "Results on page one that few people click", detail: "These show on Google's first page but get less than half the usual clicks for their position. The title and description shown in Google are probably not convincing: rewrite them to match what people search for.", pageUrl: origin, evidence: lowCtr.map((r) => `${r.key}: position ${r.position}, ${r.ctr}% clicked`).join("\n"), agent: "seo.audit" }));
        }
      }
    }

    // Real visitors' speed (the speed snippet), since search ranking uses field data.
    if (site.rum) out.push(...rumFindings(site.rum, origin));

    site.seoReport = report;
    return out;
  },
};
