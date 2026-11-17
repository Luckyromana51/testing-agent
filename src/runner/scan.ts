import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page, type Response } from "playwright";
import type { Finding, PageResult, ScanOptions, ScanResult } from "../types.js";
import { accessibilityFindings } from "./checks/accessibility.js";
import { collectSeoFacts, seoFindings } from "./checks/seo.js";
import { cookieFindings, headerFindings, mixedContentFinding } from "./checks/security.js";
import { finding } from "./finding.js";
import { scoreFindings } from "./score.js";

const SKIP_EXT =
  /\.(pdf|zip|rar|7z|gz|jpe?g|png|gif|webp|svg|ico|mp4|mp3|webm|avi|mov|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;
const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
const SLOW_PAGE_MS = 3000;

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
  consoleErrors: string[];
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
    if (msg.type() === "error") s.consoleErrors.push(msg.text().slice(0, 300));
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
  ) => {
    const unique = [...new Set(items)];
    if (!unique.length) return;
    out.push(
      finding({
        category: "functional",
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
  group(
    s.pageErrors,
    "js-exception",
    "high",
    "uncaught JavaScript error(s)",
    "Uncaught errors can break buttons, forms and other features on the page.",
  );
  group(
    s.consoleErrors,
    "console-error",
    "medium",
    "console error(s)",
    "Errors logged in the browser console often point to broken scripts or missing files.",
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

async function scanPage(
  context: BrowserContext,
  url: string,
  index: number,
  opts: ScanOptions,
  isFirst: boolean,
): Promise<{ result: PageResult; findings: Finding[]; links: string[] }> {
  const page = await context.newPage();
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
    const started = Date.now();
    res = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
    result.loadMs = Date.now() - started;
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

    if (result.loadMs !== null && result.loadMs > SLOW_PAGE_MS) {
      findings.push(
        finding({
          category: "performance",
          rule: "slow-page",
          severity: result.loadMs > 8000 ? "high" : "medium",
          title: `Page took ${(result.loadMs / 1000).toFixed(1)} s to load`,
          detail: `Pages should load in under ${SLOW_PAGE_MS / 1000} s. Compress images, defer scripts and enable caching.`,
          pageUrl: url,
        }),
      );
    }

    await step("page weight", async () => {
      const weight = await page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .reduce((sum, e) => sum + ((e as PerformanceResourceTiming).transferSize || 0), 0),
      );
      if (weight > 3_000_000) {
        findings.push(
          finding({
            category: "performance",
            rule: "heavy-page",
            severity: weight > 6_000_000 ? "high" : "medium",
            title: `Page downloads ${(weight / 1_000_000).toFixed(1)} MB`,
            detail:
              "Heavy pages are slow on mobile data. Compress images (WebP/AVIF) and remove unused scripts.",
            pageUrl: url,
          }),
        );
      }
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
      const smallTargets = await page.evaluate(() => {
        let n = 0;
        for (const el of Array.from(document.querySelectorAll("a, button, input, select"))) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.width < 24 || r.height < 24)) n++;
        }
        return n;
      });
      if (smallTargets > 5) {
        findings.push(
          finding({
            category: "mobile",
            rule: "small-tap-targets",
            severity: "low",
            title: `${smallTargets} tap targets smaller than 24px on phones`,
            detail: "Small links and buttons are hard to tap. WCAG 2.2 asks for at least 24 x 24 px.",
            pageUrl: url,
          }),
        );
      }
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

async function checkLinks(
  context: BrowserContext,
  linkSources: Map<string, string>,
  onProgress?: (m: string) => void,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const links = [...linkSources.keys()].slice(0, 200);
  onProgress?.(`Checking ${links.length} links`);
  let i = 0;
  const worker = async () => {
    while (i < links.length) {
      const link = links[i++];
      let status = 0;
      let error = "";
      try {
        let res = await context.request.head(link, { timeout: 15_000, maxRedirects: 5 });
        // Some servers do not support HEAD; retry with GET.
        if (res.status() === 405 || res.status() === 501 || res.status() === 403) {
          res = await context.request.get(link, { timeout: 15_000, maxRedirects: 5 });
        }
        status = res.status();
      } catch (e) {
        error = (e as Error).message.split("\n")[0];
      }
      // 401/403/429 usually mean "blocked for bots", not broken.
      if (error || (status >= 400 && ![401, 403, 429].includes(status))) {
        out.push(
          finding({
            category: "functional",
            rule: "broken-link",
            severity: status >= 500 || status === 404 || error ? "high" : "medium",
            title: error ? `Link could not be reached` : `Broken link (HTTP ${status})`,
            detail: `Linked from ${linkSources.get(link)}.${error ? ` ${error}` : ""}`,
            pageUrl: linkSources.get(link) ?? link,
            evidence: link,
          }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

/** Crawls a website from `opts.url` and runs every check on each page. */
export async function scanSite(opts: ScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const startUrl = normaliseUrl(opts.url);
  const origin = new URL(startUrl).origin;
  const maxPages = opts.maxPages ?? 20;
  await mkdir(opts.artifactsDir, { recursive: true });

  const browser: Browser = await chromium.launch();
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
      const r = await scanPage(context, url, pages.length, opts, pages.length === 0);
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
        if (!linkSources.has(link)) linkSources.set(link, url);
        if (isCrawlable(link, origin) && !seen.has(link)) {
          seen.add(link);
          queue.push(link);
        }
      }
    }
    if (opts.checkLinks !== false) {
      // Pages we already visited were checked by loading them.
      for (const p of pages) linkSources.delete(p.url);
      findings.push(...(await checkLinks(context, linkSources, opts.onProgress)));
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
