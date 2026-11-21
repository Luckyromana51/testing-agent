import type { Page } from "playwright";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, PageResult } from "../../types.js";
import type { PageAgent } from "../types.js";

interface PageMetrics {
  ttfb: number;
  load: number;
  lcp: number;
  cls: number;
  weight: number;
}

const LAB_NOTE =
  "Measured once from the testing server, so real visitors on other networks may see different numbers.";

/**
 * Speed numbers from the browser's own timing data, judged against Google's Core Web Vitals
 * thresholds (LCP good under 2.5 s, poor over 4 s; CLS good under 0.1, poor over 0.25; TTFB good under 0.8 s).
 */
export async function speedFindings(page: Page, url: string, result: PageResult): Promise<Finding[]> {
  // A string, not a function: bundlers rewrite named functions in ways the browser cannot run.
  const m = (await page.evaluate(`new Promise(function (resolve) {
    var lcp = 0, cls = 0;
    try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { lcp = Math.max(lcp, e.startTime); }); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (e) {}
    try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { if (!e.hadRecentInput) cls += e.value; }); }).observe({ type: "layout-shift", buffered: true }); } catch (e) {}
    var nav = performance.getEntriesByType("navigation")[0] || {};
    var weight = performance.getEntriesByType("resource").reduce(function (s, e) { return s + (e.transferSize || 0); }, nav.transferSize || 0);
    setTimeout(function () { resolve({ ttfb: nav.responseStart || 0, load: nav.loadEventEnd || 0, lcp: lcp, cls: cls, weight: weight }); }, 200);
  })`)) as PageMetrics;

  result.metrics = {
    ttfbMs: Math.round(m.ttfb),
    lcpMs: m.lcp ? Math.round(m.lcp) : null,
    cls: Math.round(m.cls * 1000) / 1000,
    loadMs: m.load ? Math.round(m.load) : null,
    bytes: m.weight,
  };
  if (m.load) result.loadMs = Math.round(m.load);

  const out: Finding[] = [];
  const add = (rule: string, severity: Finding["severity"], title: string, detail: string) =>
    out.push(finding({ category: "performance", rule, severity, title, detail: `${detail} ${LAB_NOTE}`, pageUrl: url }));
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

  if (m.lcp > 2500) {
    add(
      "perf:lcp",
      m.lcp > 4000 ? "high" : "medium",
      `Main content takes ${sec(m.lcp)} to appear (LCP)`,
      "Largest Contentful Paint should be under 2.5 s (Google ranks pages over 4 s as poor). Compress and resize the main image, preload it, and cut render-blocking scripts and fonts.",
    );
  } else if (m.load > 10_000) {
    add(
      "slow-page",
      "medium",
      `Page takes ${sec(m.load)} to finish loading`,
      "The main content shows quickly, but the page keeps loading for a long time. Defer or lazy-load scripts, videos and images below the fold.",
    );
  }
  if (m.cls > 0.1) {
    add(
      "perf:cls",
      m.cls > 0.25 ? "medium" : "low",
      `Layout jumps while loading (CLS ${m.cls.toFixed(2)})`,
      "Content moves after it appears, which causes mis-taps. Set width and height on images and embeds, and reserve space for banners.",
    );
  }
  if (m.ttfb > 800) {
    add(
      "perf:ttfb",
      m.ttfb > 1800 ? "medium" : "low",
      `Server takes ${sec(m.ttfb)} to start answering`,
      "Time to first byte should be under 0.8 s. Turn on page caching (LiteSpeed Cache, a CDN), and check slow database queries.",
    );
  }
  if (m.weight > 3_000_000) {
    add(
      "heavy-page",
      m.weight > 6_000_000 ? "high" : "medium",
      `Page downloads ${(m.weight / 1_000_000).toFixed(1)} MB`,
      "Heavy pages are slow on mobile data. Compress images (WebP or AVIF), lazy-load videos, and remove unused scripts.",
    );
  }
  return out;
}

export const speedAgent: PageAgent = {
  id: "web.speed",
  name: "Speed (Core Web Vitals)",
  description:
    "Measures how fast the main content appears (LCP), layout jumps (CLS), server response time and download size, against Google's thresholds.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  run: ({ page, url, result }) => speedFindings(page, url, result),
};
