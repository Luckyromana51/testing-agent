import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Response } from "playwright";
import { agentsFor, WEB_AGENTS } from "../agents/registry.js";
import type { PageAgent, PageContext, SiteAgent, SiteState, WebAgent } from "../agents/types.js";
import { listen } from "../agents/web/signals.js";
import type { AgentStat, Finding, PageResult, ScanOptions, ScanResult } from "../types.js";
import { CouldNotTestError, explainLoadError, refusedStatus } from "./coverage.js";
import { finding } from "./finding.js";
import { LoginError, signIn, type SignedIn } from "./login.js";
import { categoriesFor } from "../products.js";
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
  // Only agents meant for this product, even when a list of ids is given (store checks never run on a CRM).
  return WEB_AGENTS.filter((a) => ids.has(a.id) && a.products.includes(product));
}

/** Runs agents and keeps per-agent numbers. One agent failing never stops the others. */
class AgentRunner {
  stats = new Map<string, AgentStat>();
  private lastError = new Map<string, string>();
  private agents: WebAgent[];
  /** Agents left out on purpose, with the reason shown in the report. */
  skipped: AgentStat[];

  constructor(agents: WebAgent[], loggedIn: boolean) {
    const skip = (a: WebAgent): string | undefined => {
      if (loggedIn && a.category === "seo") return "Left out while signed in: private pages are not meant for search engines.";
      if (!loggedIn && a.needsLogin) return "Needs a saved login: add one on the project page to test the pages behind it.";
      return undefined;
    };
    this.agents = agents.filter((a) => !skip(a));
    this.skipped = agents
      .filter((a) => skip(a))
      .map((a) => ({ id: a.id, name: a.name, findings: 0, ms: 0, errors: 0, category: a.category, runs: 0, skipped: skip(a) }));
    for (const a of this.agents) this.stats.set(a.id, { id: a.id, name: a.name, findings: 0, ms: 0, errors: 0, category: a.category, runs: 0 });
  }

  /** Every agent's numbers. An agent that failed everywhere it ran, or never got to run, is "not tested". */
  finalStats(): AgentStat[] {
    const out = [...this.stats.values()].map((s) => {
      if (!s.runs) return { ...s, untested: "No page it could check loaded." };
      if (s.errors >= s.runs) return { ...s, untested: `Stopped with an error every time: ${this.lastError.get(s.id) ?? "unknown error"}` };
      return s;
    });
    return [...out, ...this.skipped];
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
    stat.runs = (stat.runs ?? 0) + 1;
    try {
      const out = await fn();
      for (const f of out) f.agent ??= agent.id;
      stat.findings += out.length;
      return out;
    } catch (err) {
      stat.errors++;
      this.lastError.set(agent.id, (err as Error).message.split("\n")[0]);
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

  const runner = new AgentRunner(selectAgents(opts), Boolean(opts.login));
  log(`${runner.stats.size} specialist agents assigned`);
  if (opts.login && runner.skipped.some((s) => s.category === "seo")) {
    log("Search engine checks are left out: the test runs signed in, and private pages are not for search engines");
  }

  // Behind a company proxy, route both the browser and the agents' requests through it.
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser: Browser = await chromium.launch({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    // The server handles Ctrl-C and docker stop itself: it cancels the run, which closes this browser.
    ...(opts.signal ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
  });
  // Cancelling closes the browser, which ends whatever page the agents are on.
  const stop = () => void browser.close().catch(() => {});
  opts.signal?.addEventListener("abort", stop, { once: true });
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
  const notes: string[] = [];
  const site: SiteState = { seo: new Map(), loggedIn: Boolean(opts.login), loginUser: opts.login?.username };
  let signedIn: SignedIn | undefined;
  let signOuts = 0;
  const loginOrigin = opts.login?.loginUrl ? new URL(opts.login.loginUrl).origin : "";
  const isLoginPage = (url: string) => {
    const u = new URL(url);
    return Boolean(signedIn) && u.origin === loginOrigin && u.pathname === signedIn!.loginPath;
  };

  try {
    if (opts.login) {
      signedIn = await signIn(context, opts.login, log);
      notes.push(`Signed in as ${opts.login.username} at ${opts.login.loginUrl} before testing, so the pages behind the login were tested too.`);
      notes.push("While signed in, links that look like actions (log out, delete, cancel, archive and similar) were not opened, to keep the account and its data unchanged.");
    }
    while (queue.length && pages.length < maxPages) {
      opts.signal?.throwIfAborted();
      const url = queue.shift()!;
      log(`Testing page ${pages.length + 1}: ${url}`);
      const isFirst = pages.length === 0;
      const r = await scanPage(context, url, pages.length, opts, isFirst, runner, site);
      if (signedIn && r.result.redirectedFrom && isLoginPage(r.result.url) && !isLoginPage(url)) {
        // The site sent the agent back to its sign-in page: the session ended. Sign in again and retry.
        signOuts++;
        if (isFirst && signOuts > 1) {
          throw new LoginError(
            `Signed in, but ${url} still sends the agent back to the sign-in page. Check the start address belongs to the same site as the sign-in page.`,
          );
        }
        if (signOuts <= 3) {
          log("The site signed the agent out; signing in again");
          signedIn = await signIn(context, opts.login!, log);
          queue.unshift(url);
          continue;
        }
      }
      if (isFirst) {
        // Nothing on the site can be tested when the first page cannot be opened: say why, never score it.
        const why = r.result.error ? explainLoadError(r.result.error, url) : refusedStatus(r.result.status, url);
        if (why) throw new CouldNotTestError(`Could not test the site: ${why}`);
      }
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
        if (isCrawlable(link, origin, site.loggedIn) && !seen.has(link)) {
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
    opts.signal?.removeEventListener("abort", stop);
    await browser.close().catch(() => {});
  }

  if (signOuts) {
    notes.push(`The site signed the agent out ${signOuts === 1 ? "once" : `${signOuts} times`} during the test, so it signed in again.`);
  }
  if (opts.login && runner.skipped.some((s) => s.category === "seo")) {
    notes.push("Search engine checks were left out because the test ran signed in: private pages are not meant to be found on Google.");
  }
  dropDuplicates(findings);
  // Signed in, the pages are private: search engine advice does not apply, from any agent, and
  // the search category is left out of the score instead of shown as untested.
  const categories = categoriesFor(opts.product ?? "website").filter((c) => !(opts.login && c === "seo"));
  for (let i = findings.length - 1; i >= 0; i--) {
    if (!categories.includes(findings[i].category)) findings.splice(i, 1);
  }
  const agentStats = runner.finalStats();
  const score = scoreFindings(findings, pages.length, categories, agentStats);
  log(`Done: ${pages.length} pages, ${findings.length} findings`);
  return {
    startUrl,
    startedAt,
    finishedAt: new Date().toISOString(),
    pages,
    findings,
    ...score,
    agentStats,
    ...(notes.length ? { notes } : {}),
  };
}
