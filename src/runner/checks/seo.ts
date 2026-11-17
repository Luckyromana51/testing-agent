import type { Page } from "playwright";
import type { Finding } from "../../types.js";
import { finding } from "../finding.js";

interface SeoFacts {
  title: string;
  description: string | null;
  h1Count: number;
  imagesWithoutAlt: string[];
  canonical: string | null;
  lang: string | null;
  viewport: string | null;
  robotsNoindex: boolean;
  ogTitle: string | null;
}

export async function collectSeoFacts(page: Page): Promise<SeoFacts> {
  // No named helper functions inside evaluate(): bundlers such as tsx/esbuild wrap them
  // in a __name() helper that does not exist in the browser.
  const metaSelectors = {
    description: 'meta[name="description"]',
    robots: 'meta[name="robots"]',
    viewport: 'meta[name="viewport"]',
    ogTitle: 'meta[property="og:title"]',
  };
  return page.evaluate((sel) => {
    const m: Record<string, string | null> = {};
    for (const [key, selector] of Object.entries(sel)) {
      m[key] = document.querySelector(selector)?.getAttribute("content") ?? null;
    }
    return {
      title: document.title.trim(),
      description: m.description,
      h1Count: document.querySelectorAll("h1").length,
      imagesWithoutAlt: Array.from(document.images)
        .filter((img) => !img.hasAttribute("alt"))
        .map((img) => img.currentSrc || img.src)
        .slice(0, 20),
      canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? null,
      lang: document.documentElement.getAttribute("lang"),
      viewport: m.viewport,
      robotsNoindex: /noindex/i.test(m.robots ?? ""),
      ogTitle: m.ogTitle,
    };
  }, metaSelectors);
}

export function seoFindings(url: string, f: SeoFacts): Finding[] {
  const out: Finding[] = [];
  const add = (
    rule: string,
    severity: Finding["severity"],
    title: string,
    detail: string,
    evidence?: string,
  ) => out.push(finding({ category: "seo", rule, severity, title, detail, pageUrl: url, evidence }));

  if (!f.title) {
    add(
      "seo:title-missing",
      "high",
      "Page has no title",
      "Search engines show the <title> as the result headline.",
    );
  } else if (f.title.length < 10 || f.title.length > 70) {
    add(
      "seo:title-length",
      "low",
      `Title is ${f.title.length < 10 ? "too short" : "too long"} (${f.title.length} characters)`,
      "Google shows about 60 characters of a title before cutting it off. Keep titles between 10 and 70 characters.",
      f.title,
    );
  }
  if (!f.description) {
    add(
      "seo:description-missing",
      "medium",
      "Missing meta description",
      'Add <meta name="description"> with 50 to 160 characters describing the page.',
    );
  } else if (f.description.length < 50 || f.description.length > 160) {
    add(
      "seo:description-length",
      "low",
      `Meta description is ${f.description.length < 50 ? "too short" : "too long"} (${f.description.length} characters)`,
      "Google shows about 160 characters of a description before cutting it off. Aim for 50 to 160.",
      f.description,
    );
  }
  if (f.h1Count === 0) {
    add("seo:h1-missing", "medium", "No <h1> heading", "Each page should have one main <h1> heading.");
  } else if (f.h1Count > 1) {
    add("seo:h1-multiple", "low", `${f.h1Count} <h1> headings`, "Use a single <h1> per page.");
  }
  if (f.imagesWithoutAlt.length) {
    add(
      "seo:img-alt",
      "medium",
      `${f.imagesWithoutAlt.length} image(s) without alt text`,
      "Alt text helps search engines and screen-reader users understand images.",
      f.imagesWithoutAlt.join("\n"),
    );
  }
  if (!f.canonical) {
    add(
      "seo:canonical-missing",
      "low",
      "No canonical URL",
      'Add <link rel="canonical"> to avoid duplicate-content issues.',
    );
  }
  if (!f.lang) {
    add(
      "seo:lang-missing",
      "low",
      "No lang attribute on <html>",
      'Set <html lang="en"> (or the right language).',
    );
  }
  if (!f.viewport) {
    add(
      "seo:viewport-missing",
      "high",
      "No viewport meta tag",
      'Without <meta name="viewport"> the page will not scale on phones, which hurts mobile ranking.',
    );
  }
  if (f.robotsNoindex) {
    add(
      "seo:noindex",
      "high",
      "Page is set to noindex",
      "This page tells search engines not to index it. Remove noindex if the page should be found.",
    );
  }
  if (!f.ogTitle) {
    add(
      "seo:og-missing",
      "info",
      "No Open Graph tags",
      "Add og:title, og:description and og:image so links look good when shared on social media and WhatsApp.",
    );
  }
  return out;
}
