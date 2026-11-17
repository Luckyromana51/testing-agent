import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { Finding, PageResult, ScanOptions, ScanResult } from "../types.js";
import { accessibilityFindings, tapTargetFindings } from "./checks/accessibility.js";
import { collectSeoFacts, seoFindings } from "./checks/seo.js";
import { cookieFindings, headerFindings, mixedContentFinding } from "./checks/security.js";
import { finding } from "./finding.js";
import { scoreFindings } from "./score.js";

const SKIP_EXT =
  /\.(pdf|zip|rar|7z|gz|jpe?g|png|gif|webp|svg|ico|mp4|mp3|webm|avi|mov|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;
const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
const RETRY_STATUSES = [429, 502, 503, 504];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalises a URL for de-duplication: drops the #hash and trailing slash. */
export function normaliseUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function isCrawlable(link: string, origin: string): boolean {
  try {
    const u = new URL(link);
    return (
      (u.protocol === "http:" || u.protocol === "https:") && u.origin === origin && !SKIP_EXT.test(u.pathname)
    );
  } catch {
    return false;
  }
}

interface PageSignals {
  consoleErrors: { text: string; source: string }[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  insecure: string[];
}

function listen(page: Page, pageUrl: string): PageSignals {
  const s: PageSignals = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
    insecure: [],
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") s.consoleErrors.push({ text: msg.text().slice(0, 300), source: msg.location().url });
  });
  page.on("pageerror", (err) => s.pageErrors.push(err.message.slice(0, 300)));
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "failed";
    if (reason.includes("ERR_ABORTED")) return; // navigation away, not a real failure
    s.failedRequests.push(`${req.url()} (${reason})`);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (res.status() >= 400 && url !== pageUrl) s.badResponses.push(`${res.status()} ${url}`);
  });
  page.on("request", (req) => {
    if (req.url().startsWith("http://")) s.insecure.push(req.url());
  });
  return s;
}

function signalFindings(url: string, s: PageSignals): Finding[] {
  const out: Finding[] = [];
  const group = (
    items: string[],
    rule: string,
    severity: Finding["severity"],
    title: string,
    detail: string,
    category: Finding["category"] = "functional",
  ) => {
    const unique = [...new Set(items)];
    if (!unique.length) return;
    out.push(
      finding({
        category,
        rule,
        severity,
        title: `${unique.length} ${title}`,
        detail,
        pageUrl: url,
        evidence: unique.slice(0, 15).join("\n"),
        count: unique.length,
      }),
    );
  };

  // "Failed to load resource" console lines repeat what broken-resource / failed-request already report.
  const consoleErrors = s.consoleErrors.filter((c) => !/^Failed to load resource/i.test(c.text));
  const sri = consoleErrors.filter((c) => /integrity/i.test(c.text) && /block/i.test(c.text));
  const csp = consoleErrors.filter((c) => /Content Security Policy/i.test(c.text));
  const rest = consoleErrors.filter((c) => !sri.includes(c) && !csp.includes(c));
  const pageOrigin = new URL(url).origin;
  const isThirdParty = (source: string) => {
    try {
      return Boolean(source) && new URL(source).origin !== pageOrigin;
    } catch {
      return false;
    }
  };
  const firstParty = rest.filter((c) => !isThirdParty(c.source)).map((c) => c.text);
  const thirdParty = rest.filter((c) => isThirdParty(c.source)).map((c) => `${c.text} (from ${c.source})`);

  group(
    s.pageErrors,
    "js-exception",
    "high",
    "uncaught JavaScript error(s)",
    "Uncaught errors can break buttons, forms and other features on the page.",
  );
  group(
    sri.map((c) => c.text),
    "sri-blocked",
    "high",
    "script(s) or style(s) blocked by an integrity check",
    "The browser refused to run a file because its content no longer matches the integrity hash in the HTML, so that feature does not work. This usually happens after a deploy when the file changed but the page (or a cache) still has the old hash. Update the integrity attribute and clear the page cache.",
  );
  group(
    csp.map((c) => c.text),
    "csp-violation",
    "medium",
    "Content-Security-Policy violation(s)",
    "The site's own security policy blocked something the page tried to load or run. Either the policy is too strict for a feature you use, or something unexpected was injected.",
    "security",
  );
  group(
    firstParty,
    "console-error",
    "medium",
    "console error(s)",
    "Errors logged in the browser console often point to broken scripts or missing files.",
  );
  group(
    thirdParty,
    "console-error-third-party",
    "low",
    "console error(s) from third-party scripts",
    "These come from code loaded from other sites (chat widgets, analytics, ads). They rarely break your page but are worth a look.",
  );
  group(
    s.badResponses,
    "broken-resource",
    "medium",
    "resource(s) returned an error status",
    "Images, scripts or styles the page needs could not be loaded.",
  );
  group(
    s.failedRequests,
    "failed-request",
    "medium",
    "request(s) failed to load",
    "The browser could not fetch these files at all (DNS, network or blocked).",
  );
  out.push(...mixedContentFinding(url, [...new Set(s.insecure)]));
  return out;
}

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
async function speedFindings(page: Page, url: string, result: PageResult): Promise<Finding[]> {
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

async function scanPage(
  context: BrowserContext,
  requestedUrl: string,
  index: number,
  opts: ScanOptions,
  isFirst: boolean,
): Promise<{ result: PageResult; findings: Finding[]; links: string[] }> {
  const page = await context.newPage();
  // Becomes the final address after redirects (http -> https, example.com -> www.example.com).
  let url = requestedUrl;
  const signals = listen(page, url);
  const findings: Finding[] = [];
  const result: PageResult = { url, status: null, title: "", loadMs: null };
  let links: string[] = [];

  // Each check runs on its own, so one failing check does not hide the others.
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      findings.push(
        finding({
          category: "functional",
          rule: "check-error",
          severity: "info",
          title: `The ${name} check could not finish on this page`,
          detail: (err as Error).message.split("\n")[0],
          pageUrl: url,
        }),
      );
    }
  };

  let res: Response | null = null;
  try {
    let started = Date.now();
    res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    if (res && RETRY_STATUSES.includes(res.status())) {
      // Usually rate limiting or a brief hiccup, not a broken page: wait, then look again.
      await sleep(3000);
      for (const list of Object.values(signals)) list.length = 0;
      started = Date.now();
      res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    }
    result.loadMs = Date.now() - started;
    url = normaliseUrl(page.url());
    result.url = url;
    if (url !== requestedUrl) result.redirectedFrom = requestedUrl;
    // Give late scripts a moment to throw errors or fire requests.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    result.status = res?.status() ?? null;
    result.title = (await page.title()).slice(0, 200);
  } catch (err) {
    result.error = (err as Error).message.split("\n")[0];
    findings.push(
      finding({
        category: "functional",
        rule: "page-load-failed",
        severity: "critical",
        title: "Page failed to load",
        detail: result.error,
        pageUrl: url,
      }),
    );
    findings.push(...signalFindings(url, signals));
    await page.close();
    return { result, findings, links };
  }

  try {
    if (result.status && result.status >= 400) {
      findings.push(
        finding({
          category: "functional",
          rule: "page-error-status",
          severity: result.status >= 500 ? "critical" : "high",
          title: `Page returned HTTP ${result.status}`,
          detail: "Visitors see an error instead of the page.",
          pageUrl: url,
        }),
      );
    }

    await step("speed", async () => {
      findings.push(...(await speedFindings(page, url, result)));
    });

    links = await page.$$eval("a[href]", (as) =>
      as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean),
    );

    // Error pages (404, 500) are reported once above; SEO and accessibility checks on them are noise.
    const isErrorPage = (result.status ?? 0) >= 400;

    if (!isErrorPage)
      await step("SEO", async () => {
        findings.push(...seoFindings(url, await collectSeoFacts(page)));
      });

    if (opts.accessibility !== false && !isErrorPage) {
      await step("accessibility", async () => {
        findings.push(...(await accessibilityFindings(page, url)));
      });
    }

    if (isFirst && res) {
      const response = res;
      await step("security", async () => {
        findings.push(...headerFindings(url, response.headers()));
        findings.push(...cookieFindings(url, await context.cookies(url)));
      });
    }

    const shot = `page-${index}.jpg`;
    await page.screenshot({ path: path.join(opts.artifactsDir, shot), type: "jpeg", quality: 60 });
    result.screenshot = shot;

    await step("mobile", async () => {
      // Mobile layout check: does the page overflow sideways on a phone?
      await page.setViewportSize(MOBILE);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 5) {
        findings.push(
          finding({
            category: "mobile",
            rule: "mobile-overflow",
            severity: "medium",
            title: `Page scrolls sideways on phones (${overflow}px too wide)`,
            detail:
              "Some element is wider than a 390px phone screen. Check fixed widths, large images and tables.",
            pageUrl: url,
          }),
        );
      }
      // axe's WCAG 2.2 target-size rule, run at phone width. Unlike a plain size count it skips
      // links inside sentences and small targets that have enough space around them.
      findings.push(...(await tapTargetFindings(page, url)));
      const mshot = `page-${index}-mobile.jpg`;
      await page.screenshot({ path: path.join(opts.artifactsDir, mshot), type: "jpeg", quality: 60 });
      result.mobileScreenshot = mshot;
    });
  } catch (err) {
    result.error = (err as Error).message.split("\n")[0];
  } finally {
    findings.push(...signalFindings(url, signals));
    await page.close();
  }
  return { result, findings, links };
}

/** Social networks answer automated requests with 999, 403 or a login wall, so a check proves nothing. */
const BOT_BLOCKING_HOSTS =
  /(^|\.)(linkedin\.com|facebook\.com|fb\.com|instagram\.com|x\.com|twitter\.com|wa\.me|whatsapp\.com|t\.me|tiktok\.com|pinterest\.com|threads\.net)$/i;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  410: "Gone",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
const describeStatus = (s: number) => `HTTP ${s}${STATUS_TEXT[s] ? ` ${STATUS_TEXT[s]}` : ""}`;

/** One request with HEAD, then GET if HEAD fails or is refused (many servers mishandle HEAD). */
async function probe(context: BrowserContext, link: string): Promise<{ status: number; error: string }> {
  const opts = { timeout: 15_000, maxRedirects: 5 };
  try {
    const res = await context.request.head(link, opts);
    if (res.status() < 400) return { status: res.status(), error: "" };
  } catch {
    // fall through to GET
  }
  try {
    const res = await context.request.get(link, opts);
    return { status: res.status(), error: "" };
  } catch (e) {
    return { status: 0, error: (e as Error).message.split("\n")[0] };
  }
}

/** Loads the link in a real browser tab, which is what a visitor would get. */
async function browserStatus(context: BrowserContext, link: string): Promise<{ status: number; error: string }> {
  const page = await context.newPage();
  try {
    const res = await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { status: res?.status() ?? 0, error: "" };
  } catch (e) {
    return { status: 0, error: (e as Error).message.split("\n")[0] };
  } finally {
    await page.close();
  }
}

/**
 * Checks every link that was not already opened as a page.
 * A link is only reported as broken after a second look: internal links are re-opened in a real
 * browser after a pause (so rate limiting or a brief outage is not reported as broken), and other
 * sites are retried once. At most 2 requests go to the same host at a time.
 */
async function checkLinks(
  context: BrowserContext,
  origin: string,
  linkSources: Map<string, string>,
  onProgress?: (m: string) => void,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const all = [...linkSources.keys()];
  const skipped = all.filter((l) => BOT_BLOCKING_HOSTS.test(new URL(l).hostname));
  const links = all.filter((l) => !skipped.includes(l)).slice(0, 200);
  onProgress?.(
    `Checking ${links.length} links${skipped.length ? ` (skipping ${skipped.length} social media links, which block automated checks)` : ""}`,
  );

  const perHost = new Map<string, number>();
  const withHostSlot = async <T>(host: string, fn: () => Promise<T>): Promise<T> => {
    while ((perHost.get(host) ?? 0) >= 2) await sleep(50);
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      perHost.set(host, (perHost.get(host) ?? 1) - 1);
    }
  };

  let i = 0;
  const worker = async () => {
    while (i < links.length) {
      const link = links[i++];
      const host = new URL(link).host;
      const internal = new URL(link).origin === origin;
      const failed = (r: { status: number; error: string }) =>
        Boolean(r.error) || r.status === 0 || (r.status >= 400 && ![401, 403, 429].includes(r.status));

      let r = await withHostSlot(host, () => probe(context, link));
      if (!failed(r)) continue;
      // Second look before reporting anything.
      await sleep(2000);
      // Internal pages get a real browser; files (PDFs and so on) would only start a download there.
      const isPage = internal && !SKIP_EXT.test(new URL(link).pathname);
      r = await withHostSlot(host, () => (isPage ? browserStatus(context, link) : probe(context, link)));
      if (!failed(r)) continue;

      const source = linkSources.get(link) ?? link;
      const what = r.error ? r.error : describeStatus(r.status);
      if (internal) {
        out.push(
          finding({
            category: "functional",
            rule: "broken-link",
            severity: "high",
            title: "Broken link on your site",
            detail: `Visitors who click this link get an error (${what}). Checked twice, a few seconds apart, so this is not a brief outage.`,
            pageUrl: source,
            evidence: `${link}  (${r.error ? "could not be reached" : describeStatus(r.status)})`,
          }),
        );
      } else if (r.status === 404 || r.status === 410) {
        out.push(
          finding({
            category: "functional",
            rule: "broken-external-link",
            severity: "medium",
            title: "Link to another website is broken",
            detail: `The page this links to no longer exists (${what}). Update or remove the link.`,
            pageUrl: source,
            evidence: `${link}  (${describeStatus(r.status)})`,
          }),
        );
      } else {
        // Other sites often refuse automated checks (503, timeouts), so this is not proof of a broken link.
        out.push(
          finding({
            category: "functional",
            rule: "unverified-external-link",
            severity: "info",
            title: "Link to another website could not be checked",
            detail: `${what}. Many sites block automated checks, so open it by hand to confirm.`,
            pageUrl: source,
            evidence: `${link}  (${r.error ? "no answer" : describeStatus(r.status)})`,
          }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** An HTTPS site should send visitors who type http:// to the secure version. */
async function httpsRedirectFindings(context: BrowserContext, origin: string): Promise<Finding[]> {
  const u = new URL(origin);
  if (u.protocol !== "https:") return [];
  const httpUrl = `http://${u.host}/`;
  try {
    const res = await context.request.get(httpUrl, { maxRedirects: 0, timeout: 15_000 });
    const location = res.headers()["location"] ?? "";
    if (res.status() >= 300 && res.status() < 400 && location.startsWith("https://")) return [];
    if (res.status() < 300) {
      return [
        finding({
          category: "security",
          rule: "sec:no-https-redirect",
          severity: "medium",
          title: "The http:// address does not redirect to https://",
          detail:
            "Visitors who type the address without https:// get an unencrypted page. Add a permanent (301) redirect from HTTP to HTTPS.",
          pageUrl: httpUrl,
        }),
      ];
    }
  } catch {
    // Port 80 closed or unreachable: nothing is served insecurely.
  }
  return [];
}

/** Crawls a website from `opts.url` and runs every check on each page. */
export async function scanSite(opts: ScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const startUrl = normaliseUrl(opts.url);
  let origin = new URL(startUrl).origin;
  const maxPages = opts.maxPages ?? 20;
  await mkdir(opts.artifactsDir, { recursive: true });

  // Behind a company proxy, route both the browser and the link checker through it.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser: Browser = await chromium.launch(
    proxyServer
      ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } }
      : {},
  );
  const context = await browser.newContext({
    viewport: DESKTOP,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.1",
  });

  const queue = [startUrl];
  const seen = new Set(queue);
  const linkSources = new Map<string, string>();
  const pages: PageResult[] = [];
  const findings: Finding[] = [];

  try {
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      opts.onProgress?.(`Testing page ${pages.length + 1}: ${url}`);
      const isFirst = pages.length === 0;
      const r = await scanPage(context, url, pages.length, opts, isFirst);
      if (isFirst && r.result.redirectedFrom) {
        // Follow the site to where it really lives, e.g. http://example.com -> https://www.example.com.
        origin = new URL(r.result.url).origin;
        seen.add(r.result.url);
      } else if (r.result.redirectedFrom && pages.some((p) => p.url === r.result.url)) {
        continue; // Another link that redirects to a page we already tested.
      }
      pages.push(r.result);
      const source = linkSources.get(url);
      for (const f of r.findings) {
        if (source && (f.rule === "page-error-status" || f.rule === "page-load-failed")) {
          f.detail += ` Linked from ${source}.`;
        }
      }
      findings.push(...r.findings);
      for (const raw of r.links) {
        let link: string;
        try {
          link = normaliseUrl(raw);
        } catch {
          continue;
        }
        if (!/^https?:/.test(link)) continue;
        if (!linkSources.has(link)) linkSources.set(link, r.result.url);
        if (isCrawlable(link, origin) && !seen.has(link)) {
          seen.add(link);
          queue.push(link);
        }
      }
    }
    findings.push(...(await httpsRedirectFindings(context, origin)));
    if (opts.checkLinks !== false) {
      // Pages we already visited were checked by loading them.
      for (const p of pages) linkSources.delete(p.url);
      findings.push(...(await checkLinks(context, origin, linkSources, opts.onProgress)));
    }
  } finally {
    await browser.close();
  }

  const { scores, overallScore } = scoreFindings(findings, pages.length);
  opts.onProgress?.(`Done: ${pages.length} pages, ${findings.length} findings`);
  return {
    startUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    pages,
    findings,
    scores,
    overallScore,
  };
}
