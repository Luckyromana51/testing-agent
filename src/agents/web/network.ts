import { writeFile } from "node:fs/promises";
import path from "node:path";
import { finding } from "../../runner/finding.js";
import { sameSite } from "../../runner/urls.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, PageResult } from "../../types.js";
import type { NetResponse, PageAgent, SiteAgent } from "../types.js";
import { sharedFinding, type SharedItem } from "./once.js";

/**
 * Speed checks beyond the timing numbers: images sent bigger than shown, the main image waiting
 * for lazy loading, files sent without compression or caching (read from the browser's own
 * network log), and the first page on a slow phone connection.
 */

const list = (items: string[], max = 8) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const short = (u: string) => {
  try {
    const x = new URL(u);
    const p = x.pathname.length > 70 ? `…${x.pathname.slice(-67)}` : x.pathname;
    return `${x.host}${p}`;
  } catch {
    return u.slice(0, 90);
  }
};
const LAB_NOTE = "Measured from the testing server, so real visitors may see different numbers.";

interface ImageFacts {
  src: string;
  rw: number;
  rh: number;
  nw: number;
  nh: number;
  fit: string;
  lazy: boolean;
  below: boolean;
  svg: boolean;
}

const IMAGES_JS = `new Promise(function (resolve) {
  var lcp = null;
  try { new PerformanceObserver(function (l) { var e = l.getEntries(); if (e.length) lcp = e[e.length - 1]; }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (e) {}
  setTimeout(function () {
    var out = [];
    var imgs = document.images;
    for (var i = 0; i < imgs.length && i < 400; i++) {
      var img = imgs[i];
      if (!img.complete || !img.naturalWidth) continue;
      var r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      if (img.checkVisibility && !img.checkVisibility({ visibilityProperty: true })) continue;
      var src = img.currentSrc || img.src;
      out.push({
        src: src, rw: Math.round(r.width), rh: Math.round(r.height), nw: img.naturalWidth, nh: img.naturalHeight,
        fit: getComputedStyle(img).objectFit, lazy: img.loading === "lazy",
        below: r.top + scrollY > 2 * innerHeight, svg: /\\.svg(\\?|$)|^data:image\\/svg/i.test(src)
      });
    }
    var el = lcp && lcp.element;
    var main = el && el.tagName === "IMG" && el.loading === "lazy" ? (el.currentSrc || el.src) : "";
    resolve({ images: out, lazyMain: main });
  }, 50);
})`;

/** Images sent much bigger than shown, stretched out of shape, or loaded in the wrong order. */
export const imagesAgent: PageAgent = {
  id: "perf.images",
  name: "Images",
  description:
    "Finds images sent much bigger than they are shown, images stretched out of shape, a main image held back by lazy loading, many images far down the page loaded at once, and large JPEG, PNG and GIF files that WebP or AVIF would shrink.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url, signals }) {
    const r = (await page.evaluate(IMAGES_JS)) as { images: ImageFacts[]; lazyMain: string };
    const bytes = new Map<string, NetResponse>();
    for (const res of signals.responses) if (res.type === "image") bytes.set(res.url, res);
    const size = (src: string) => bytes.get(src)?.bytes ?? 0;
    const out: Finding[] = [];

    const big: SharedItem[] = [];
    const stretched: SharedItem[] = [];
    for (const img of r.images) {
      if (img.svg || img.src.startsWith("data:")) continue;
      const b = size(img.src);
      const wasted = img.nw - img.rw * 2;
      // Twice the shown size is right for sharp screens; three times and more is waste.
      if (img.nw > 3 * img.rw && wasted >= 400 && (b >= 80 * 1024 || (!b && img.nw >= 2000))) {
        big.push({ key: img.src, line: `${short(img.src)}: ${img.nw}×${img.nh} shown at ${img.rw}×${img.rh}${b ? ` (${kb(b)})` : ""}` });
      }
      const drawn = img.rw / img.rh;
      const real = img.nw / img.nh;
      if (img.fit === "fill" && img.rw >= 30 && img.rh >= 30 && Math.abs(drawn / real - 1) > 0.15) {
        stretched.push({ key: `${img.src}|${img.rw}x${img.rh}`, line: `${short(img.src)}: ${img.nw}×${img.nh} drawn at ${img.rw}×${img.rh}` });
      }
    }
    out.push(
      ...sharedFinding("perf:oversized-image", big, (items) =>
        finding({
          category: "performance",
          rule: "perf:oversized-image",
          severity: "low",
          title: `${items.length} image${items.length === 1 ? " is" : "s are"} sent much bigger than shown`,
          detail:
            "Visitors download the full picture and the browser shrinks it, which slows the page on phones. Resize the files to at most twice the shown size, and give the browser several sizes with srcset and sizes.",
          pageUrl: url,
          evidence: list(items.map((i) => i.line)),
          count: items.length,
        }),
      ),
      ...sharedFinding("ui:stretched-image", stretched, (items) =>
        finding({
          category: "functional",
          rule: "ui:stretched-image",
          severity: "low",
          title: `${items.length} image${items.length === 1 ? " is" : "s are"} stretched out of shape`,
          detail:
            "The image is drawn with a different width-to-height ratio than the picture itself, so people and products look squashed. Set only the width (height: auto), or use object-fit: cover or contain.",
          pageUrl: url,
          evidence: list(items.map((i) => i.line)),
          count: items.length,
        }),
      ),
    );

    if (r.lazyMain) {
      out.push(
        finding({
          category: "performance",
          rule: "perf:lcp-lazy",
          severity: "medium",
          title: "The page's main image waits for lazy loading",
          detail:
            'The largest image on the first screen has loading="lazy", so the browser starts downloading it late and the page looks empty for longer (a slower LCP). Remove loading="lazy" from images on the first screen, and add fetchpriority="high" to the main one.',
          pageUrl: url,
          evidence: short(r.lazyMain),
        }),
      );
    }

    const eager = r.images.filter((i) => i.below && !i.lazy && !i.src.startsWith("data:"));
    const eagerBytes = eager.reduce((s, i) => s + size(i.src), 0);
    if (eager.length >= 5 && eagerBytes >= 300 * 1024) {
      out.push(
        finding({
          category: "performance",
          rule: "perf:no-lazy-images",
          severity: "low",
          title: `${eager.length} images far down the page load straight away (${kb(eagerBytes)})`,
          detail:
            'These images are more than two screens down, yet download with the page and compete with what visitors see first. Add loading="lazy" to images below the first screen.',
          pageUrl: url,
          evidence: list(eager.map((i) => short(i.src))),
          count: eager.length,
        }),
      );
    }

    const legacy: SharedItem[] = [];
    const host = new URL(url).hostname;
    for (const res of bytes.values()) {
      // Pictures from other companies' servers (widgets, ads) are not the site's to convert.
      if (!sameSite(res.url, host)) continue;
      const type = res.headers["content-type"] ?? "";
      if (/image\/(jpeg|png|gif)/.test(type) && res.bytes >= 100 * 1024) {
        legacy.push({ key: res.url, line: `${short(res.url)}: ${type.split(";")[0].replace("image/", "").toUpperCase()}, ${kb(res.bytes)}` });
      }
    }
    out.push(
      ...sharedFinding("perf:legacy-image-format", legacy, (items) =>
        finding({
          category: "performance",
          rule: "perf:legacy-image-format",
          severity: "low",
          title: `${items.length} large image${items.length === 1 ? " is" : "s are"} JPEG, PNG or GIF`,
          detail:
            "WebP and AVIF pictures are usually 25 to 50% smaller at the same quality, and every current browser shows them. Convert large photos, and replace big animated GIFs with a short video or animated WebP.",
          pageUrl: url,
          evidence: list(items.map((i) => i.line)),
          count: items.length,
        }),
      ),
    );
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const TEXT_TYPES = /text\/|javascript|json|xml|svg|font\/(ttf|otf)|application\/(x-)?font-(ttf|otf)|wasm/;
const STATIC = new Set(["script", "stylesheet", "font", "image"]);

/** What the network inspector writes for each page: every answer, its size, compression and caching. */
export function networkLog(responses: NetResponse[]) {
  return responses.map((r) => ({
    url: r.url,
    status: r.status,
    type: r.type,
    bytes: r.bytes,
    encoding: r.headers["content-encoding"] ?? "",
    cacheControl: r.headers["cache-control"] ?? "",
    contentType: (r.headers["content-type"] ?? "").split(";")[0],
    redirected: r.redirected,
  }));
}

export const networkAgent: PageAgent = {
  id: "perf.network",
  name: "Network inspector",
  description:
    "Reads every file the page downloads, like the browser's Network tab, and saves the list with the report: files sent without compression or caching, files fetched twice or through a redirect, too many requests, and how much comes from other companies' servers.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ url, signals, result, index, artifactsDir }) {
    // A copy now: the list keeps growing while the page stays open.
    const responses = signals.responses.slice();
    const requests = signals.requests.length;
    const host = new URL(url).hostname;
    const file = `page-${index}-network.json`;
    await writeFile(path.join(artifactsDir, file), JSON.stringify({ page: url, requests, responses: networkLog(responses) }, null, 1));
    result.files = [...(result.files ?? []).filter((f) => f.file !== file), { label: "Network log (JSON)", file }];

    const own = responses.filter((r) => sameSite(r.url, host) && r.url.startsWith("http"));
    const ok = own.filter((r) => r.status === 200 && r.bytes > 0);
    const out: Finding[] = [];

    const raw: SharedItem[] = [];
    for (const r of ok) {
      const type = r.headers["content-type"] ?? "";
      const enc = r.headers["content-encoding"] ?? "";
      if (TEXT_TYPES.test(type) && (!enc || enc === "identity") && r.bytes >= 1400) {
        raw.push({ key: r.url, line: `${short(r.url)}: ${kb(r.bytes)}, ${type.split(";")[0]}` });
      }
    }
    out.push(
      ...sharedFinding("perf:no-compression", raw, (items) =>
        finding({
          category: "performance",
          rule: "perf:no-compression",
          severity: "medium",
          title: `${items.length} text file${items.length === 1 ? " is" : "s are"} sent without compression`,
          detail:
            "HTML, CSS, JavaScript and JSON shrink by 60 to 80% with gzip or Brotli, and every browser accepts them. Turn compression on in the web server or CDN.",
          pageUrl: url,
          evidence: list(items.map((i) => i.line)),
          count: items.length,
        }),
      ),
    );

    const uncached: SharedItem[] = [];
    for (const r of ok) {
      if (!STATIC.has(r.type)) continue;
      const cc = (r.headers["cache-control"] ?? "").toLowerCase();
      const why = /no-store/.test(cc)
        ? "no-store: never kept"
        : !cc && !r.headers["expires"]
          ? "no caching headers"
          : /(^|[,\s])(no-cache|max-age=0)\b/.test(cc) && !r.headers["etag"] && !r.headers["last-modified"]
            ? `${cc}, with no ETag or Last-Modified: downloaded again on every page`
            : "";
      if (why) uncached.push({ key: r.url, line: `${short(r.url)}: ${why}` });
    }
    out.push(
      ...sharedFinding("perf:no-cache", uncached, (items) =>
        finding({
          category: "performance",
          rule: "perf:no-cache",
          severity: "low",
          title: `${items.length} file${items.length === 1 ? " has" : "s have"} no browser caching`,
          detail:
            "Scripts, styles, fonts and images are downloaded again on every visit. Send Cache-Control: public, max-age=31536000, immutable for files whose name changes with each release, and a shorter max-age (for example a day) for the others.",
          pageUrl: url,
          evidence: list(items.map((i) => i.line)),
          count: items.length,
        }),
      ),
    );

    const redirected: SharedItem[] = own
      .filter((r) => r.redirected && r.type !== "document")
      .map((r) => ({ key: r.url, line: r.redirectedFrom ? `${short(r.redirectedFrom)} → ${short(r.url)}` : short(r.url) }));
    out.push(
      ...sharedFinding("perf:redirected-file", redirected, (items) =>
        finding({
          category: "performance",
          rule: "perf:redirected-file",
          severity: "low",
          title: `${items.length} file${items.length === 1 ? " is" : "s are"} fetched through a redirect`,
          detail: "Each redirect costs the browser another round trip before the file arrives. Point the page straight at the final address (often https:// or a missing slash).",
          pageUrl: url,
          evidence: list(items.map((i) => i.line)),
          count: items.length,
        }),
      ),
    );

    const times = new Map<string, number>();
    for (const r of responses) {
      if (STATIC.has(r.type) && r.status === 200 && r.bytes > 0) times.set(r.url, (times.get(r.url) ?? 0) + 1);
    }
    const twice = [...times].filter(([, n]) => n > 1).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (twice.length) {
      out.push(
        finding({
          category: "performance",
          rule: "perf:duplicate-requests",
          severity: "low",
          title: `${twice.length} file${twice.length === 1 ? " is" : "s are"} downloaded more than once`,
          detail: "The same file is downloaded again while the page loads, usually because it is included twice or sent without caching. Include each script and style once.",
          pageUrl: url,
          evidence: list(twice.map(([u, n]) => `${short(u)}: ${n} times`)),
          count: twice.length,
        }),
      );
    }

    if (requests > 120) {
      out.push(
        finding({
          category: "performance",
          rule: "perf:many-requests",
          severity: "low",
          title: `The page makes ${requests} requests while loading`,
          detail: `Each request costs time on phone networks. Combine small images into SVG icons, remove unused scripts and plugins, and load widgets only when needed. ${LAB_NOTE}`,
          pageUrl: url,
        }),
      );
    }

    const total = responses.reduce((s, r) => s + r.bytes, 0);
    const byHost = new Map<string, number>();
    for (const r of responses) {
      if (!r.url.startsWith("http") || sameSite(r.url, host)) continue;
      const h = new URL(r.url).hostname;
      byHost.set(h, (byHost.get(h) ?? 0) + r.bytes);
    }
    const third = [...byHost.values()].reduce((s, b) => s + b, 0);
    if (third >= 1024 * 1024 && third > total / 2) {
      out.push(
        finding({
          category: "performance",
          rule: "perf:third-party-weight",
          severity: "info",
          title: `${Math.round((100 * third) / total)}% of the page's weight (${kb(third)}) comes from other companies' servers`,
          detail:
            "Chat widgets, video players, ads and tracking scripts are outside your control and slow every visit. Check each is still needed, and load the heavy ones only when the visitor uses them. A CDN or shop platform that serves your own files counts here too; that is fine.",
          pageUrl: url,
          evidence: list(
            [...byHost]
              .sort((a, b) => b[1] - a[1])
              .map(([h, b]) => `${h}: ${kb(b)}`),
          ),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Chrome DevTools' "Slow 4G" profile, the one Google's Lighthouse uses for phones. */
export const SLOW_4G = { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 };

/** The first page opened like a mid-range phone on a slow connection: slower processor, slow 4G, nothing cached. */
export const slowNetworkAgent: SiteAgent = {
  id: "perf.slow-network",
  name: "Slow phone connection",
  description:
    "Opens the first page the way a mid-range phone on a slow 4G connection would (Google's Lighthouse settings: 1.6 Mbit/s, 150 ms delay, a processor 4 times slower, nothing cached) and measures when the main content appears.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  runsLast: true,
  async run({ browser, pages }) {
    const first: PageResult | undefined = pages.find((p) => !p.error && (p.status ?? 0) < 400);
    if (!first) return [];
    const page = await browser.newPage();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      const cdp = await browser.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...SLOW_4G });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const started = Date.now();
      try {
        await page.goto(first.url, { waitUntil: "load", timeout: 90_000 });
      } catch {
        return [
          finding({
            category: "performance",
            rule: "perf:slow-phone-network",
            severity: "high",
            title: "On a slow phone connection the page does not finish loading within 90 seconds",
            detail: `Visitors on slow mobile networks give up long before this. Cut the page's weight: smaller images, fewer scripts and fonts. ${LAB_NOTE}`,
            pageUrl: first.url,
          }),
        ];
      }
      const loadMs = Date.now() - started;
      const m = (await page.evaluate(`new Promise(function (resolve) {
        var lcp = 0;
        try { new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { lcp = Math.max(lcp, e.startTime); }); }).observe({ type: "largest-contentful-paint", buffered: true }); } catch (e) {}
        var fcp = (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime || 0;
        setTimeout(function () { resolve({ lcp: lcp, fcp: fcp }); }, 300);
      })`)) as { lcp: number; fcp: number };
      const lcp = m.lcp || loadMs;
      if (lcp <= 4000) return [];
      const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
      return [
        finding({
          category: "performance",
          rule: "perf:slow-phone-network",
          severity: lcp > 8000 ? "high" : "medium",
          title: `On a slow phone connection the main content takes ${sec(lcp)} to appear`,
          detail: `Google counts over 4 s as poor. First text after ${sec(m.fcp)}, page finished after ${sec(loadMs)}. Send less before the first screen shows: compress and resize the main image, inline the critical CSS, defer scripts, and limit web fonts. ${LAB_NOTE}`,
          pageUrl: first.url,
        }),
      ];
    } finally {
      await page.close().catch(() => {});
    }
  },
};
