import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Response } from "playwright";
import { agentsFor, WEB_AGENTS } from "../agents/registry.js";
import type { PageAgent, PageContext, SiteAgent, SiteState, WebAgent } from "../agents/types.js";
import { listen } from "../agents/web/signals.js";
import type { AgentStat, Finding, PageResult, ScanOptions, ScanResult } from "../types.js";
import { finding } from "./finding.js";
import { isCrawlable, normaliseUrl } from "./urls.js";
import { scoreFindings } from "./score.js";

export { isCrawlable, normaliseUrl } from "./urls.js";

const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
const RETRY_STATUSES = [429, 502, 503, 504];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Picks the agents for this scan from the options (agent ids, or the old on/off flags). */
export function selectAgents(opts: ScanOptions): WebAgent[] {
  const product = opts.product ?? "website";
  const ids = new Set(opts.agents ?? agentsFor(product).map((a) => a.id));
  if (opts.checkLinks === false) ids.delete("web.links");
  if (opts.accessibility === false) ids.delete("web.accessibility");
  return WEB_AGENTS.filter((a) => ids.has(a.id));
}

/** Runs agents and keeps per-agent numbers. One agent failing never stops the others. */
class AgentRunner {
  stats = new Map<string, AgentStat>();

  constructor(private agents: WebAgent[]) {
    for (const a of agents) this.stats.set(a.id, { id: a.id, name: a.name, findings: 0, ms: 0, errors: 0 });
  }

  pageAgents(stage: PageAgent["stage"]): PageAgent[] {
    return this.agents.filter((a): a is PageAgent => a.stage === stage);
  }

  siteAgents(): SiteAgent[] {
    return this.agents.filter((a): a is SiteAgent => a.stage === "site");
  }

  async run(agent: WebAgent, pageUrl: string, fn: () => Promise<Finding[]> | Finding[]): Promise<Finding[]> {
    const stat = this.stats.get(agent.id)!;
    const started = Date.now();
    try {
      const out = await fn();
      for (const f of out) f.agent ??= agent.id;
      stat.findings += out.length;
      return out;
    } catch (err) {
      stat.errors++;
      return [
        finding({
          category: "functional",
          rule: "check-error",
          severity: "info",
          title: `The ${agent.name} agent could not finish on this page`,
          detail: (err as Error).message.split("\n")[0],
          pageUrl,
          agent: agent.id,
        }),
      ];
    } finally {
      stat.ms += Date.now() - started;
    }
  }
}

async function scanPage(
  context: BrowserContext,
  requestedUrl: string,
  index: number,
  opts: ScanOptions,
  isFirst: boolean,
  runner: AgentRunner,
  site: SiteState,
): Promise<{ result: PageResult; findings: Finding[]; links: string[] }> {
  const page = await context.newPage();
  // Becomes the final address after redirects (http -> https, example.com -> www.example.com).
  let url = requestedUrl;
  const signals = listen(page);
  const findings: Finding[] = [];
  const result: PageResult = { url, status: null, title: "", loadMs: null };
  let links: string[] = [];
  let res: Response | null = null;

  const ctx = (): PageContext => ({
    page,
    url,
    status: result.status,
    response: res,
    isFirst,
    signals,
    browser: context,
    product: opts.product ?? "website",
    result,
    site,
  });
  const runStage = async (stage: PageAgent["stage"]) => {
    const isErrorPage = (result.status ?? 0) >= 400 || Boolean(result.error);
    for (const agent of runner.pageAgents(stage)) {
      if (agent.skipErrorPages && isErrorPage) continue;
      findings.push(...(await runner.run(agent, url, () => agent.run(ctx()))));
    }
  };

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
    await runStage("end");
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
    links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean));

    await runStage("page");

    const shot = `page-${index}.jpg`;
    await page.screenshot({ path: path.join(opts.artifactsDir, shot), type: "jpeg", quality: 60 });
    result.screenshot = shot;

    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(300);
    await runStage("mobile");
    const mshot = `page-${index}-mobile.jpg`;
    await page.screenshot({ path: path.join(opts.artifactsDir, mshot), type: "jpeg", quality: 60 });
    result.mobileScreenshot = mshot;
  } catch (err) {
    result.error = (err as Error).message.split("\n")[0];
  } finally {
    await runStage("end");
    await page.close();
  }
  return { result, findings, links };
}

/**
 * The SEO agent and axe both flag missing alt text, language and title. When axe found it on a
 * page, keep only the accessibility finding (it is the stricter one) and note the SEO impact there.
 */
const SAME_PROBLEM: Record<string, string> = {
  "seo:img-alt": "axe:image-alt",
  "seo:lang-missing": "axe:html-has-lang",
  "seo:title-missing": "axe:document-title",
};

function dropDuplicates(findings: Finding[]): void {
  const axeOnPage = new Set(findings.filter((f) => f.rule.startsWith("axe:")).map((f) => `${f.rule}|${f.pageUrl}`));
  for (let i = findings.length - 1; i >= 0; i--) {
    const twin = SAME_PROBLEM[findings[i].rule];
    if (!twin || !axeOnPage.has(`${twin}|${findings[i].pageUrl}`)) continue;
    const axe = findings.find((f) => f.rule === twin && f.pageUrl === findings[i].pageUrl);
    if (axe && !axe.detail.includes("search")) axe.detail += " This also hurts search ranking.";
    findings.splice(i, 1);
  }
}

/** Crawls a website from `opts.url` and runs every selected agent on each page, then on the site. */
export async function scanSite(opts: ScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const startUrl = normaliseUrl(opts.url);
  let origin = new URL(startUrl).origin;
  const maxPages = opts.maxPages ?? 20;
  const log = (m: string) => opts.onProgress?.(m);
  await mkdir(opts.artifactsDir, { recursive: true });

  const runner = new AgentRunner(selectAgents(opts));
  log(`${runner.stats.size} specialist agents assigned`);

  // Behind a company proxy, route both the browser and the agents' requests through it.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser: Browser = await chromium.launch(
    proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {},
  );
  const context = await browser.newContext({
    viewport: DESKTOP,
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.2",
  });

  const queue = [startUrl];
  const seen = new Set(queue);
  const linkSources = new Map<string, string>();
  const pages: PageResult[] = [];
  const findings: Finding[] = [];
  const site: SiteState = { seo: new Map() };

  try {
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      log(`Testing page ${pages.length + 1}: ${url}`);
      const isFirst = pages.length === 0;
      const r = await scanPage(context, url, pages.length, opts, isFirst, runner, site);
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

    for (const agent of runner.siteAgents()) {
      log(`Agent: ${agent.name}`);
      findings.push(
        ...(await runner.run(agent, startUrl, () =>
          agent.run({
            browser: context,
            origin,
            startUrl: pages[0]?.url ?? startUrl,
            pages,
            linkSources,
            product: opts.product ?? "website",
            site,
            log,
          }),
        )),
      );
    }
  } finally {
    await browser.close();
  }

  dropDuplicates(findings);
  const { scores, overallScore } = scoreFindings(findings, pages.length);
  log(`Done: ${pages.length} pages, ${findings.length} findings`);
  return {
    startUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    pages,
    findings,
    scores,
    overallScore,
    agentStats: [...runner.stats.values()],
  };
}
