import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Response } from "playwright";
import { agentsFor, WEB_AGENTS } from "../agents/registry.js";
import type { PageAgent, PageContext, SiteAgent, SiteState, WebAgent } from "../agents/types.js";
import { listen } from "../agents/web/signals.js";
import type { LiveSink } from "../live.js";
import type { AgentStat, CookieInfo, Finding, JourneyResult, PageResult, ScanOptions, ScanResult } from "../types.js";
import { Inspector } from "./inspect.js";
import { runJourneys } from "./journeys.js";
import { compareVisuals } from "./visual.js";
import { keepFirstSightings } from "../agents/web/once.js";
import { CouldNotTestError, explainLoadError, NotTestedError, refusedStatus } from "./coverage.js";
import { finding } from "./finding.js";
import { LoginError, signIn, type SignedIn } from "./login.js";
import { categoriesFor } from "../products.js";
import { isCrawlable, normaliseUrl, siteOf } from "./urls.js";
import { scoreFindings } from "./score.js";

export { isCrawlable, normaliseUrl } from "./urls.js";

const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
const RETRY_STATUSES = [429, 502, 503, 504];
/** More pages at once than this does not make a test faster: the site and the server become the limit. */
export const MAX_PARALLEL = 16;

/** How many pages to test at the same time: the run's choice, else PARALLEL_PAGES, else 4. */
export function parallelPages(asked?: number): number {
  const n = Number(asked ?? process.env.PARALLEL_PAGES ?? 4);
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARALLEL, Math.round(n))) : 4;
}

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
  private notTested = new Map<string, string>();
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
      const why = this.notTested.get(s.id);
      if (why) return { ...s, untested: why };
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

  /** Findings an agent made that the report shows on another page instead. */
  uncount(agentId: string, n: number): void {
    const stat = this.stats.get(agentId);
    if (stat) stat.findings = Math.max(0, stat.findings - n);
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
      if (err instanceof NotTestedError) {
        // The check could not be done here (a browser it needs is missing...): "not tested", never "passed".
        this.notTested.set(agent.id, err.message);
        for (const f of err.partial) f.agent ??= agent.id;
        stat.findings += err.partial.length;
        return err.partial;
      }
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

/**
 * Sends a page's pictures to the live view while someone watches (the browser's own screencast,
 * which only sends a picture when the page changes). Returns a function that stops it.
 */
async function castScreen(page: Page, slot: number, live: LiveSink): Promise<() => Promise<void>> {
  let cdp: CDPSession | undefined;
  let on = false;
  const start = async () => {
    if (on || page.isClosed()) return;
    on = true;
    try {
      if (!cdp) {
        cdp = await page.context().newCDPSession(page);
        cdp.on("Page.screencastFrame", (f) => {
          live.frame(slot, f.data, f.metadata.deviceWidth, f.metadata.deviceHeight);
          cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        });
      }
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 50, maxWidth: 960, maxHeight: 960, everyNthFrame: 2 });
    } catch {
      on = false; // the page closed meanwhile
    }
  };
  const stop = async () => {
    if (!on) return;
    on = false;
    await cdp?.send("Page.stopScreencast").catch(() => {});
  };
  if (live.watching()) await start();
  const off = live.onWatchers((w) => void (w ? start() : stop()));
  return async () => {
    off();
    await stop();
    await cdp?.detach().catch(() => {});
  };
}

interface PageOutcome {
  result: PageResult;
  findings: Finding[];
  links: string[];
  /** The site answered 429 Too Many Requests: test fewer pages at once. */
  throttled: boolean;
}

/** Runs one task at a time, in the order asked. */
function oneAtATime() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
type Lock = ReturnType<typeof oneAtATime>;

async function scanPage(
  context: BrowserContext,
  requestedUrl: string,
  index: number,
  opts: ScanOptions,
  isFirst: boolean,
  runner: AgentRunner,
  site: SiteState,
  slot = 0,
  loading: Lock = (task) => task(),
): Promise<PageOutcome> {
  const page = await context.newPage();
  const live = opts.live;
  const stopCast = live ? await castScreen(page, slot, live) : undefined;
  // Becomes the final address after redirects (http -> https, example.com -> www.example.com).
  let url = requestedUrl;
  const signals = listen(page);
  const inspector = opts.inspect ? new Inspector(page, url, DESKTOP) : undefined;
  if (inspector) await inspector.startCoverage();
  const findings: Finding[] = [];
  const result: PageResult = { url, status: null, title: "", loadMs: null };
  let links: string[] = [];
  let res: Response | null = null;
  let throttled = false;
  let view: "desktop" | "phone" = "desktop";
  const busy = new Set<string>();
  const show = (doing: string) => live?.screen({ slot, url, view, doing, agents: [...busy], state: "busy" });

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
    index,
    artifactsDir: opts.artifactsDir,
  });
  const runAgent = async (agent: PageAgent) => {
    busy.add(agent.name);
    show("Checking");
    const at = inspector?.now() ?? 0;
    try {
      const found = await runner.run(agent, url, () => agent.run(ctx()));
      inspector?.step(agent.name, { at, ms: inspector.now() - at, ok: true, detail: found.length ? `${found.length} finding${found.length === 1 ? "" : "s"}` : undefined });
      return found;
    } finally {
      busy.delete(agent.name);
      show("Checking");
    }
  };
  /**
   * Agents that only read the page run at the same time; agents that press keys or zoom run one
   * by one after them, so they never disturb each other.
   */
  const runStage = async (stage: PageAgent["stage"]) => {
    const isErrorPage = (result.status ?? 0) >= 400 || Boolean(result.error);
    const agents = runner.pageAgents(stage).filter((a) => !(a.skipErrorPages && isErrorPage));
    const together = await Promise.all(agents.filter((a) => !a.interacts).map(runAgent));
    findings.push(...together.flat());
    for (const agent of agents.filter((a) => a.interacts)) findings.push(...(await runAgent(agent)));
  };

  const saveInspect = async () => {
    if (!inspector) return;
    try {
      await inspector.stopCoverage();
      result.inspect = await inspector.save(opts.artifactsDir, index);
    } catch {
      // The inspect screen is extra: a page closed early still has its report.
    }
  };

  try {
    show("Waiting its turn to open the page");
    // Pages load one at a time even when several are checked at once, so the site's speed is
    // measured as one visitor would see it; the agents' checks, which take longer, overlap.
    let started = 0;
    const open = () =>
      loading(async () => {
        show("Opening the page");
        started = Date.now();
        const at = inspector?.now() ?? 0;
        try {
          const answer = await page.goto(url, { waitUntil: "load", timeout: 30_000 });
          result.loadMs = Date.now() - started;
          inspector?.step(`Open ${url}`, { at, ms: inspector.now() - at, ok: true, detail: answer ? `HTTP ${answer.status()}` : undefined });
          return answer;
        } catch (err) {
          inspector?.step(`Open ${url}`, { at, ms: inspector.now() - at, ok: false, detail: (err as Error).message.split("\n")[0] });
          throw err;
        }
      });
    res = await open();
    if (res && RETRY_STATUSES.includes(res.status())) {
      // Usually rate limiting or a brief hiccup, not a broken page: wait, then look again.
      throttled ||= res.status() === 429;
      show(`The site answered ${res.status()}: waiting, then trying again`);
      await sleep(3000);
      for (const list of Object.values(signals)) list.length = 0;
      res = await open();
    }
    url = normaliseUrl(page.url());
    result.url = url;
    if (url !== requestedUrl) result.redirectedFrom = requestedUrl;
    // Give late scripts a moment to throw errors or fire requests.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    result.status = res?.status() ?? null;
    throttled ||= result.status === 429;
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
    await saveInspect();
    await stopCast?.();
    await page.close();
    return { result, findings, links, throttled };
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

    // The picture (and the boxes drawn over it) start at the top, so pictures compare run to run.
    await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
    if (inspector) {
      await inspector.stopCoverage();
      await inspector.readLayout();
      inspector.step("Desktop picture");
    }
    const shot = `page-${index}.jpg`;
    await page.screenshot({ path: path.join(opts.artifactsDir, shot), type: "jpeg", quality: 60 });
    result.screenshot = shot;

    view = "phone";
    show("Resizing to a phone");
    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(300);
    inspector?.step(`Resize to a phone (${MOBILE.width}×${MOBILE.height})`);
    await runStage("mobile");
    await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
    const mshot = `page-${index}-mobile.jpg`;
    await page.screenshot({ path: path.join(opts.artifactsDir, mshot), type: "jpeg", quality: 60 });
    result.mobileScreenshot = mshot;
  } catch (err) {
    result.error = (err as Error).message.split("\n")[0];
  } finally {
    await runStage("end");
    await saveInspect();
    await stopCast?.();
    await page.close();
  }
  return { result, findings, links, throttled };
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
  const pageLinks = new Map<string, string[]>();
  /** Tested pages with their findings, by the order they were started in (the report keeps that order). */
  const done: { index: number; requested: string; gen: number; result: PageResult; findings: Finding[] }[] = [];
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

  const pages: PageResult[] = [];
  let journeys: JourneyResult[] | undefined;
  let cookies: CookieInfo[] | undefined;
  const parallel = parallelPages(opts.parallel);
  const live = opts.live;
  live?.setScreens(Math.min(parallel, maxPages));
  /** Drops to 1 when the site answers 429 Too Many Requests. */
  let limit = parallel;
  let nextIndex = 0;
  /** Each sign-in starts a new generation; pages loaded before it may have been signed out. */
  let signInGen = 0;
  let signingIn: Promise<void> | undefined;
  const retried = new Map<string, number>();
  const indexOf = new Map<string, number>();
  /** Pages to test again: taken before new ones, in the order they were first started (as one screen would). */
  const retests: string[] = [];
  const testAgain = (...urls: string[]) => {
    for (const u of urls) if (!retests.includes(u)) retests.push(u);
    retests.sort((a, b) => (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0));
  };
  const nextUrl = () => retests.shift() ?? queue.shift();
  const loading = oneAtATime();
  /**
   * Links found on each page wait here and join the queue in page order, whatever order the pages
   * finish in. Several pages at once then find, and test, the same pages as one page at a time,
   * which keeps re-tests comparable when the site has more pages than the limit.
   */
  const found = new Map<number, { pageUrl: string; links: string[] }>();
  let released = 0;
  const addLinks = (pageUrl: string, links: string[]) => {
    for (const link of links) {
      if (!linkSources.has(link)) linkSources.set(link, pageUrl);
      if (isCrawlable(link, origin, site.loggedIn) && !seen.has(link)) {
        seen.add(link);
        queue.push(link);
      }
    }
  };
  const release = (index: number, pageUrl: string, links: string[]) => {
    // A page tested again after its turn (the site signed the agent out) adds what it newly finds at the end.
    if (index < released) return addLinks(pageUrl, links);
    found.set(index, { pageUrl, links });
    for (let next = found.get(released); next; next = found.get(released)) {
      found.delete(released++);
      addLinks(next.pageUrl, next.links);
    }
  };

  /** Signs in again once for all the pages that found themselves signed out at the same time. */
  const signInAgain = async (gen: number) => {
    if (gen === signInGen && !signingIn) {
      signOuts++;
      log("The site signed the agent out; signing in again");
      signingIn = signIn(context, opts.login!, log)
        .then((s) => {
          signedIn = s;
          signInGen++;
        })
        .finally(() => (signingIn = undefined));
    }
    await signingIn;
  };

  /** Tests one page. Returns false when it does not count towards the page limit (to be retried, or a repeat). */
  const testPage = async (url: string, slot: number, isFirst: boolean): Promise<boolean> => {
    // A page tested again keeps its number, so the report lists pages in the order they were found.
    const again = indexOf.has(url);
    const index = indexOf.get(url) ?? nextIndex++;
    indexOf.set(url, index);
    const gen = signInGen;
    log(`Testing page ${index + 1}${again ? " again" : ""}${parallel > 1 ? ` on screen ${slot + 1}` : ""}: ${url}`);
    const r = await scanPage(context, url, index, opts, isFirst, runner, site, slot, loading);
    if (r.throttled && limit > 1) {
      limit = 1;
      log("The site answered 429 (too many requests): testing one page at a time from now on");
      notes.push("The site asked the test to slow down (HTTP 429), so pages were then tested one at a time.");
    }
    if (signedIn && r.result.redirectedFrom && isLoginPage(r.result.url) && !isLoginPage(url)) {
      // The site sent the agent back to its sign-in page: the session ended. Sign in again and retry.
      if (isFirst && signOuts >= 1) {
        throw new LoginError(
          `Signed in, but ${url} still sends the agent back to the sign-in page. Check the start address belongs to the same site as the sign-in page.`,
        );
      }
      const tries = retried.get(url) ?? 0;
      if (signOuts < 3 || (gen !== signInGen && tries < 2)) {
        retried.set(url, tries + 1);
        if (limit > 1 && gen === signInGen) {
          // Other pages loaded at the same time may have been tested signed out without being sent
          // to the sign-in page. Test this session's pages again, one at a time, as a visitor would.
          limit = 1;
          // The first page was tested alone, before the others started.
          const redo = done.filter((d) => d.gen === gen && d.index > 0);
          for (const d of redo) done.splice(done.indexOf(d), 1);
          testAgain(...redo.map((d) => d.requested));
          if (redo.length) log(`Testing ${redo.length} page${redo.length === 1 ? "" : "s"} of that session again, one at a time`);
          notes.push("The site signed the agent out while several pages were open, so the pages of that session were tested again one at a time.");
        }
        await signInAgain(gen);
        testAgain(url);
        return false;
      }
    }
    if (signedIn && limit === 1 && (gen !== signInGen || signingIn) && (retried.get(url) ?? 0) < 2) {
      // It started before the agent signed in again, so it may have been tested signed out.
      retried.set(url, (retried.get(url) ?? 0) + 1);
      testAgain(url);
      return false;
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
    } else if (r.result.redirectedFrom) {
      // Another link that redirects to a page already tested: keep the one found first, as one screen would.
      const same = done.find((d) => d.result.url === r.result.url);
      if (same && same.index < index) {
        release(index, r.result.url, []);
        return false;
      }
      if (same) done.splice(done.indexOf(same), 1);
    }
    done.push({ index, requested: url, gen, result: r.result, findings: r.findings });
    const source = linkSources.get(url);
    for (const f of r.findings) {
      if (source && (f.rule === "page-error-status" || f.rule === "page-load-failed")) {
        f.detail += ` Linked from ${source}.`;
      }
    }
    const links: string[] = [];
    pageLinks.set(r.result.url, links);
    for (const raw of r.links) {
      try {
        const link = normaliseUrl(raw);
        if (/^https?:/.test(link)) links.push(link);
      } catch {
        // Not an address.
      }
    }
    release(index, r.result.url, links);
    return true;
  };

  try {
    if (opts.login) {
      signedIn = await signIn(context, opts.login, log);
      notes.push(`Signed in as ${opts.login.username} at ${opts.login.loginUrl} before testing, so the pages behind the login were tested too.`);
      notes.push("While signed in, links that look like actions (log out, delete, cancel, archive and similar) were not opened, to keep the account and its data unchanged.");
    }
    // The first page alone: it decides where the site lives and whether it can be tested at all.
    // The other screens say why they wait: they start on the links the first page finds.
    for (let slot = 1; slot < Math.min(parallel, maxPages); slot++) live?.screen({ slot, doing: "Waits for page 1, which finds the links", agents: [], state: "idle" });
    while (!done.length && (queue.length || retests.length)) {
      opts.signal?.throwIfAborted();
      await testPage(nextUrl()!, 0, true);
    }

    // Then a pool of screens: each takes the next address from the queue until the page limit.
    if (parallel > 1 && maxPages > 1) log(`Testing up to ${parallel} pages at the same time`);
    let busy = 0;
    let failed = false;
    let waiters: (() => void)[] = [];
    const wake = () => {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    };
    const idle = (slot: number) => live?.screen({ slot, doing: "Waiting for a page", agents: [], state: "idle" });
    const worker = async (slot: number) => {
      try {
        for (;;) {
          opts.signal?.throwIfAborted();
          if (failed || slot >= limit) return;
          // Pages being tested count towards the limit; one that turns out to be a repeat frees its place.
          const url = done.length + busy < maxPages ? nextUrl() : undefined;
          if (!url) {
            // Pages still being tested may find more links (or give one back): wait for them.
            if (busy === 0) return;
            idle(slot);
            await new Promise<void>((r) => waiters.push(r));
            continue;
          }
          busy++;
          try {
            await testPage(url, slot, false);
          } finally {
            busy--;
            wake();
          }
        }
      } catch (err) {
        failed = true;
        wake();
        throw err;
      } finally {
        live?.screen({ slot, doing: "Finished", agents: [], state: "done" });
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, maxPages) }, (_, slot) => worker(slot)));

    done.sort((a, b) => a.index - b.index);
    // Site agents read the pages' notes in page order, as one screen would have written them.
    const order = new Map(done.map((d, i) => [d.result.url, i]));
    site.seo = new Map([...site.seo].sort((a, b) => (order.get(a[0]) ?? done.length) - (order.get(b[0]) ?? done.length)));
    for (const d of done) findings.push(...d.findings);
    // A script or image that every page loads is reported once, on the first page that has it.
    for (const [agent, n] of keepFirstSightings(findings)) runner.uncount(agent, n);
    pages.push(...done.map((d) => d.result));
    if (signedIn && opts.onSession) {
      // The outside tools (Lighthouse, ZAP...) test the signed-in pages with the same session,
      // taken before the site agents open it in other browsers.
      const cookies = await context.cookies(pages[0]?.url ?? startUrl);
      if (cookies.length) opts.onSession(cookies.map((c) => `${c.name}=${c.value}`).join("; "));
    }

    // User journeys, while the session is still signed in, then the pictures against the approved ones.
    if (opts.journeys?.some((j) => !j.off)) {
      const r = await runJourneys(context, opts.journeys, {
        startUrl: pages[0]?.url ?? startUrl,
        artifactsDir: opts.artifactsDir,
        login: opts.login,
        loggedIn: Boolean(signedIn),
        mailUrl: opts.mailUrl,
        log,
        signal: opts.signal,
      });
      journeys = r.results;
      findings.push(...r.findings);
    }
    if (opts.baselineDir) findings.push(...(await compareVisuals(context, pages, opts.artifactsDir, opts.baselineDir, log)));
    cookies = cookieList(await context.cookies().catch(() => []), origin);

    // Site-wide agents (links, exposed files, duplicates...) run at the same time, except those
    // that measure speed or could end the session: they run afterwards, one at a time.
    const siteAgents = runner.siteAgents();
    if (siteAgents.length) log(`Site-wide checks: ${siteAgents.map((a) => a.name).join(", ")}`);
    const last = (a: SiteAgent) => a.runsLast === true || (a.runsLast === "signed-in" && Boolean(signedIn));
    const runSite = (agent: SiteAgent) =>
      runner.run(agent, startUrl, () =>
        agent.run({
          browser: context,
          origin,
          startUrl: pages[0]?.url ?? startUrl,
          pages,
          linkSources,
          product: opts.product ?? "website",
          site,
          log,
          pageLinks,
          artifactsDir: opts.artifactsDir,
        }),
      );
    findings.push(...(await Promise.all(siteAgents.filter((a) => !last(a)).map(runSite))).flat());
    for (const agent of siteAgents.filter(last)) findings.push(...(await runSite(agent)));
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
    ...(journeys ? { journeys } : {}),
    ...(cookies?.length ? { cookies } : {}),
  };
}

/** The cookies the site set, without their values, first-party first. */
export function cookieList(list: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }[], origin: string): CookieInfo[] {
  const host = new URL(origin).hostname;
  const site = siteOf(host);
  return list
    .map((c) => {
      const domain = c.domain.replace(/^\./, "");
      return {
        name: c.name.slice(0, 100),
        domain,
        path: c.path,
        firstParty: domain === host || siteOf(domain) === site,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        ...(c.expires > 0 ? { expires: new Date(c.expires * 1000).toISOString() } : {}),
        size: c.name.length + c.value.length,
      };
    })
    .sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name))
    .slice(0, 300);
}
