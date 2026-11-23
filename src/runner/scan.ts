import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page, type Response } from "playwright";
import { agentsFor, WEB_AGENTS } from "../agents/registry.js";
import type { PageAgent, PageContext, SiteAgent, SiteState, WebAgent } from "../agents/types.js";
import { listen } from "../agents/web/signals.js";
import type { LiveSink } from "../live.js";
import type { AgentStat, Box, CookieInfo, Finding, JourneyResult, PageResult, ScanOptions, ScanResult } from "../types.js";
import { Inspector } from "./inspect.js";
import { feedCode, stepCode } from "./live-code.js";
import { runJourneys } from "./journeys.js";
import { compareVisuals } from "./visual.js";
import { keepFirstSightings } from "../agents/web/once.js";
import { withCases } from "./cases.js";
import { CouldNotTestError, explainLoadError, NotTestedError, refusedStatus } from "./coverage.js";
import { finding } from "./finding.js";
import { LoginError, signIn, type SignedIn } from "./login.js";
import { liveSignIn } from "./hand-over.js";
import { APPS, captureCalls, hideSocketSecrets, reportCall, sortCalls } from "../app/calls.js";
import { exploreApp } from "../app/explore.js";
import { chosenSystem, detectSystem, profileOf } from "../app/systems.js";
import type { RoleSession } from "./journeys.js";
import { categoriesFor } from "../products.js";
import { isCrawlable, normaliseUrl, siteOf } from "./urls.js";
import { scoreFindings } from "./score.js";
import { addressAllowed, controlScope, globMatch, NETWORKS, type RunControl } from "../control.js";

export { isCrawlable, normaliseUrl } from "./urls.js";

const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844 };
/** An iPad Air held upright. */
export const TABLET = { width: 820, height: 1180 };
const RETRY_STATUSES = [429, 502, 503, 504];
/** More pages at once than this does not make a test faster: the site and the server become the limit. */
export const MAX_PARALLEL = 16;

/** How many pages to test at the same time: the run's choice, else PARALLEL_PAGES, else 4. */
export function parallelPages(asked?: number): number {
  const n = Number(asked ?? process.env.PARALLEL_PAGES ?? 4);
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARALLEL, Math.round(n))) : 4;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The tester skipped the page from master control: its checks so far are kept, the rest is left out. */
class SkippedPage extends Error {}

/** Slow network and slow CPU from master control, on one page (Chromium's DevTools protocol). */
async function emulateSpeed(page: Page, control: RunControl): Promise<void> {
  const net = control.network ? NETWORKS[control.network as keyof typeof NETWORKS] : undefined;
  if (!net && !control.cpuSlowdown) return;
  const cdp = await page.context().newCDPSession(page);
  if (net) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: net.latencyMs,
      downloadThroughput: (net.downKbps * 1000) / 8,
      uploadThroughput: (net.upKbps * 1000) / 8,
    });
  }
  if (control.cpuSlowdown) await cdp.send("Emulation.setCPUThrottlingRate", { rate: control.cpuSlowdown });
}

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

  constructor(agents: WebAgent[], loggedIn: boolean, consent?: { allowed: boolean; why: string }, control: RunControl = {}) {
    const skip = (a: WebAgent): string | undefined => {
      if (control.tabletOn === false && "stage" in a && a.stage === "tablet") return "Left out: the tablet pass was turned off in master control.";
      if (control.phoneOn === false && "stage" in a && a.stage === "mobile") return "Left out: the phone pass was turned off in master control.";
      if (loggedIn && a.category === "seo") return "Left out while signed in: private pages are not meant for search engines.";
      if (!loggedIn && a.needsLogin) return "Needs a saved login: add one on the project page to test the pages behind it.";
      if (a.needsConsent && !consent?.allowed) return `Changes data, so it runs only with consent. ${consent?.why ?? "Mark the project as a test copy, or record the client's written permission for checks that change data."}`;
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
    const cases = { tried: 0, failed: 0 };
    try {
      const out = await withCases(cases, fn);
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
      if (cases.tried) {
        stat.cases = (stat.cases ?? 0) + cases.tried;
        stat.casesFailed = (stat.casesFailed ?? 0) + cases.failed;
      }
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

/** Waits (up to 3 s) for the page's web fonts, so text is measured and drawn in its real font. */
export async function waitForFonts(page: Page): Promise<void> {
  await page
    .evaluate("Promise.race([document.fonts ? document.fonts.ready.then(function () { return true; }) : true, new Promise(function (r) { setTimeout(r, 3000); })])")
    .catch(() => {});
}

/**
 * Waits until the page stops changing size after a resize (menus collapse, scripts re-lay the page),
 * at most 2 s, so the phone checks see the finished phone layout every time.
 */
export async function settleLayout(page: Page): Promise<void> {
  let last = "";
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(250);
    const now = await page.evaluate("document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight").catch(() => "");
    if (now === last) return;
    last = String(now);
  }
}

/** Starts noting which elements a script changes, before the picture. */
const WATCH_JS = `(function () {
  var seen = new Set();
  var mo = new MutationObserver(function (list) {
    list.forEach(function (m) { var el = m.target.nodeType === 1 ? m.target : m.target.parentElement; if (el) seen.add(el); });
  });
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  window.__glvMoving = { mo: mo, seen: seen };
})()`;

/**
 * Stops noting, and returns the boxes of what moves by itself: elements a script changed while the
 * pictures were taken, and sliders, videos, animations drawn on a canvas and embedded frames,
 * which change on their own even when they did not just now. Boxes as big as the screen are left
 * out, so a real change of the whole page is still seen.
 */
const MOVING_JS = `(function () {
  var w = window.__glvMoving; var els = w ? Array.from(w.seen) : [];
  if (w) { w.mo.disconnect(); delete window.__glvMoving; }
  var sel = 'video, canvas, iframe, marquee, [aria-roledescription=carousel], [class*=carousel], [class*=slider], [class*=swiper], [class*=slick], [class*=owl-], [class*=marquee], [class*=ticker], [class*=countdown]';
  els = els.concat(Array.from(document.querySelectorAll(sel)));
  var vw = innerWidth, vh = innerHeight, out = [];
  els.forEach(function (el) {
    if (!el.getBoundingClientRect || el === document.body || el === document.documentElement) return;
    var r = el.getBoundingClientRect();
    var x = Math.max(0, r.left), y = Math.max(0, r.top), x2 = Math.min(vw, r.right), y2 = Math.min(vh, r.bottom);
    if (x2 <= x || y2 <= y) return;
    if ((x2 - x) * (y2 - y) > vw * vh * 0.6) return;
    out.push({ x: Math.floor(x), y: Math.floor(y), w: Math.ceil(x2 - x), h: Math.ceil(y2 - y) });
  });
  return out.slice(0, 200);
})()`;

/**
 * A picture of the page that is the same on every run of an unchanged page: CSS animations and
 * transitions stopped at their end, videos paused, no blinking text cursor. With `twice`, a second
 * picture a moment later, and the boxes of what moves by itself (a slider run by a script, a
 * ticker), which visual compare then leaves out. Returns those boxes.
 */
export async function stillPicture(page: Page, file: string, twice = false): Promise<Box[] | undefined> {
  await page.evaluate("window.scrollTo(0, 0); document.querySelectorAll('video').forEach(function (v) { try { v.pause(); v.currentTime = 0; } catch (e) {} })").catch(() => {});
  const take = (to: string) => page.screenshot({ path: to, type: "jpeg", quality: 60, animations: "disabled", caret: "hide", timeout: 15_000 });
  if (twice) await page.evaluate(WATCH_JS).catch(() => {});
  await take(file);
  if (!twice) return undefined;
  await page.waitForTimeout(1200);
  await take(file.replace(/\.jpg$/, "-b.jpg")).catch(() => {});
  return ((await page.evaluate(MOVING_JS).catch(() => [])) as Box[]) ?? [];
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
  const control = opts.control ?? {};
  const gate = opts.gate;
  const DESK = control.desktop ?? DESKTOP;
  const TAB = control.tablet ?? TABLET;
  const PHONE = control.phone ?? MOBILE;
  gate?.pageStarted(slot);
  /** Master control: the tester asked to skip this screen's page. */
  const checkSkip = () => {
    if (gate?.takeSkip(slot)) throw new SkippedPage("Skipped by the tester from master control");
  };
  await emulateSpeed(page, control).catch(() => {});
  const live = opts.live;
  const stopCast = live ? await castScreen(page, slot, live) : undefined;
  // Becomes the final address after redirects (http -> https, example.com -> www.example.com).
  let url = requestedUrl;
  const signals = listen(page);
  const codeFeed = feedCode(page, slot, live, url);
  const inspector = opts.inspect ? new Inspector(page, url, DESK) : undefined;
  if (inspector) await inspector.startCoverage();
  const findings: Finding[] = [];
  const result: PageResult = { url, status: null, title: "", loadMs: null };
  let links: string[] = [];
  let res: Response | null = null;
  let throttled = false;
  let view: "desktop" | "tablet" | "phone" = "desktop";
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
    const t = Date.now();
    try {
      const found = await runner.run(agent, url, () => agent.run(ctx()));
      const detail = found.length ? `${found.length} finding${found.length === 1 ? "" : "s"}` : undefined;
      inspector?.step(agent.name, { at, ms: inspector.now() - at, ok: true, detail });
      codeFeed.step(agent.name, { code: stepCode.agent(agent.id, agent.name), ms: Date.now() - t, ok: !found.length, detail: detail ?? "Nothing found" });
      codeFeed.found(found);
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
        codeFeed.step(`Open ${url}`, { code: stepCode.open(url) });
        const at = inspector?.now() ?? 0;
        try {
          const answer = await page.goto(url, { waitUntil: control.waitUntil ?? "load", timeout: (control.pageTimeout ?? 30) * 1000 });
          result.loadMs = Date.now() - started;
          inspector?.step(`Open ${url}`, { at, ms: inspector.now() - at, ok: true, detail: answer ? `HTTP ${answer.status()}` : undefined });
          codeFeed.step("Page opened", { ms: result.loadMs ?? undefined, ok: (answer?.status() ?? 200) < 400, detail: answer ? `HTTP ${answer.status()}` : undefined });
          return answer;
        } catch (err) {
          inspector?.step(`Open ${url}`, { at, ms: inspector.now() - at, ok: false, detail: (err as Error).message.split("\n")[0] });
          codeFeed.step("Page did not open", { ok: false, detail: (err as Error).message.split("\n")[0] });
          throw err;
        }
      });
    res = await open();
    for (let attempt = 0; attempt < (control.retries ?? 1) && res && RETRY_STATUSES.includes(res.status()); attempt++) {
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
    if (url !== requestedUrl) codeFeed.step(`Landed on ${url}`, { detail: "The site sent the browser here" });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    codeFeed.step("Wait for the page to go quiet", { code: stepCode.wait() });
    // Web fonts change the size of text: checks of overlapping or cut-off text, and the pictures,
    // must see the page with its fonts, or they find different things from run to run.
    await waitForFonts(page);
    if (control.settleMs) await page.waitForTimeout(control.settleMs);
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
    codeFeed.found(findings);
    await runStage("end");
    await saveInspect();
    codeFeed.stop();
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
      codeFeed.found(findings.slice(-1));
    }
    checkSkip();
    links = await page.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href).filter(Boolean));

    // The picture is taken as the page loaded, before any agent presses keys, zooms or opens menus,
    // with animations stopped: an unchanged page then gives the same picture on every run.
    // The boxes drawn over it are read at the same moment.
    if (inspector) {
      await inspector.readLayout();
      inspector.step("Desktop picture");
    }
    const shot = `page-${index}.jpg`;
    codeFeed.step("Desktop picture", { code: stepCode.picture(shot) });
    const moving = await stillPicture(page, path.join(opts.artifactsDir, shot), Boolean(opts.baselineDir));
    if (moving?.length) result.moving = { desktop: moving };
    result.screenshot = shot;

    checkSkip();
    await runStage("page");
    await inspector?.stopCoverage();
    checkSkip();

    // Tablet: between desktop and phone, where menus often vanish. Only when an agent checks it.
    if (runner.pageAgents("tablet").length && control.tabletOn !== false) {
      view = "tablet";
      show("Resizing to a tablet");
      codeFeed.step(`Resize to a tablet (${TAB.width}×${TAB.height})`, { code: stepCode.resize(TAB.width, TAB.height) });
      await page.setViewportSize(TAB);
      await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
      await settleLayout(page);
      inspector?.step(`Resize to a tablet (${TAB.width}×${TAB.height})`);
      const tshot = `page-${index}-tablet.jpg`;
      codeFeed.step("Tablet picture", { code: stepCode.picture(tshot) });
      await stillPicture(page, path.join(opts.artifactsDir, tshot));
      result.tabletScreenshot = tshot;
      await runStage("tablet");
      checkSkip();
    }

    if (control.phoneOn === false) return { result, findings, links, throttled };
    view = "phone";
    show("Resizing to a phone");
    codeFeed.step(`Resize to a phone (${PHONE.width}×${PHONE.height})`, { code: stepCode.resize(PHONE.width, PHONE.height) });
    await page.setViewportSize(PHONE);
    await page.evaluate("window.scrollTo(0, 0)").catch(() => {});
    await settleLayout(page);
    inspector?.step(`Resize to a phone (${PHONE.width}×${PHONE.height})`);
    const mshot = `page-${index}-mobile.jpg`;
    codeFeed.step("Phone picture", { code: stepCode.picture(mshot) });
    const mmoving = await stillPicture(page, path.join(opts.artifactsDir, mshot), Boolean(opts.baselineDir));
    if (mmoving?.length) result.moving = { ...result.moving, phone: mmoving };
    result.mobileScreenshot = mshot;
    await runStage("mobile");
  } catch (err) {
    if (err instanceof SkippedPage) {
      result.skipped = err.message;
      codeFeed.step("Skipped by the tester", { ok: true, detail: "The rest of this page's checks were left out" });
    } else result.error = (err as Error).message.split("\n")[0];
  } finally {
    await runStage("end");
    await saveInspect();
    codeFeed.step("Page finished", { ok: true, detail: `${findings.length} finding${findings.length === 1 ? "" : "s"} on this page` });
    codeFeed.stop();
    await stopCast?.();
    gate?.pageEnded(slot);
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
export async function scanSite(input: ScanOptions): Promise<ScanResult> {
  // Master control: passed in, or the running test's (the queue sets it around the engine).
  const scoped = controlScope.get();
  const opts: ScanOptions = { ...input, control: input.control ?? scoped?.control, gate: input.gate ?? scoped?.gate };
  const control: RunControl = opts.control ?? {};
  const gate = opts.gate;
  const startedAt = new Date().toISOString();
  const startUrl = normaliseUrl(opts.url);
  let origin = new URL(startUrl).origin;
  const maxPages = opts.maxPages ?? 20;
  const log = (m: string) => opts.onProgress?.(m);
  await mkdir(opts.artifactsDir, { recursive: true });

  const runner = new AgentRunner(selectAgents(opts), Boolean(opts.login), opts.writes, control);
  log(`${runner.stats.size} specialist agents assigned`);
  if (maxPages > 1000) log(`Big crawl: up to ${maxPages.toLocaleString("en")} pages. The test stops when the site has no more pages, and you can finish it early from the live bar`);
  if (opts.login && runner.skipped.some((s) => s.category === "seo")) {
    log("Search engine checks are left out: the test runs signed in, and private pages are not for search engines");
  }

  // Behind a company proxy, route both the browser and the agents' requests through it.
  // A tunnel through the client's server carries everything, the site's own name included.
  const proxyServer = opts.proxy ?? (process.env.HTTPS_PROXY || process.env.https_proxy);
  const browser: Browser = await chromium.launch({
    // "<-loopback>": the client server's own localhost goes through the tunnel too.
    ...(opts.proxy ? { proxy: { server: opts.proxy, bypass: "<-loopback>" } } : proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    // The server handles Ctrl-C and docker stop itself: it cancels the run, which closes this browser.
    ...(opts.signal ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
  });
  // Cancelling closes the browser, which ends whatever page the agents are on.
  const stop = () => void browser.close().catch(() => {});
  opts.signal?.addEventListener("abort", stop, { once: true });
  const context = await browser.newContext({
    viewport: control.desktop ?? DESKTOP,
    userAgent:
      control.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.2",
    ...(control.locale ? { locale: control.locale } : {}),
    ...(control.timezone ? { timezoneId: control.timezone } : {}),
    ...(control.colorScheme ? { colorScheme: control.colorScheme } : {}),
    ...(control.reducedMotion ? { reducedMotion: control.reducedMotion } : {}),
    ...(control.javascript === false ? { javaScriptEnabled: false } : {}),
    ...(control.headers ? { extraHTTPHeaders: control.headers } : {}),
  });
  if (control.blockUrls?.length) {
    const blocked = control.blockUrls.map((p) => (p.includes("*") ? p : `*${p}*`));
    await context.route(
      (u) => blocked.some((p) => globMatch(p, u.href)),
      (route) => route.abort("blockedbyclient"),
    );
  }
  const testerNotes = describeTesterSetup(control);

  const queue = [startUrl];
  const seen = new Set(queue);
  /** Clicks from the start page, for master control's depth limit. */
  const depth = new Map<string, number>([[startUrl, 0]]);
  for (const extra of control.extraUrls ?? []) {
    try {
      const u = normaliseUrl(extra);
      if (new URL(u).origin === origin && !seen.has(u)) {
        seen.add(u);
        queue.push(u);
        depth.set(u, 0);
      }
    } catch {
      // Not an address: cleanControl already refused it.
    }
  }
  const linkSources = new Map<string, string>();
  const pageLinks = new Map<string, string[]>();
  /** Tested pages with their findings, by the order they were started in (the report keeps that order). */
  const done: { index: number; requested: string; gen: number; result: PageResult; findings: Finding[] }[] = [];
  const findings: Finding[] = [];
  const notes: string[] = [];
  const site: SiteState = {
    seo: new Map(),
    loggedIn: Boolean(opts.login),
    loginUser: opts.login?.username,
    login: opts.login,
    roles: opts.roles,
    mailUrl: opts.mailUrl,
    signal: opts.signal,
    consent: opts.writes,
    seoInput: opts.seo,
    uploadsDir: opts.uploadsDir,
    rum: opts.rum,
  };
  const isApp = APPS.includes(opts.product ?? "website");
  let stopCalls: (() => void) | undefined;
  /** Browsers signed in as the project's roles, for journeys that run as a role. */
  const roleContexts = new Map<string, Promise<RoleSession>>();
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
  let outOfScope = 0;
  const addLinks = (pageUrl: string, links: string[]) => {
    const next = (depth.get(pageUrl) ?? 0) + 1;
    for (const link of links) {
      if (!linkSources.has(link)) linkSources.set(link, pageUrl);
      if (isCrawlable(link, origin, site.loggedIn) && !site.unsafe?.test(link) && !seen.has(link)) {
        seen.add(link);
        if ((control.maxDepth !== undefined && next > control.maxDepth) || !addressAllowed(link, control)) {
          outOfScope++;
          continue;
        }
        depth.set(link, next);
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
      signingIn = signIn(context, opts.login!, log, { mailUrl: opts.mailUrl, signal: opts.signal, hints: loginHints })
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
    if (!depth.has(r.result.url)) depth.set(r.result.url, depth.get(url) ?? 0);
    if (control.stopOnCritical && r.findings.some((f) => f.severity === "critical")) gate?.finish(`A critical problem was found on ${r.result.url}, and master control says to finish at the first one`);
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

  // A system chosen on the project wins over spotting it.
  const chosen = chosenSystem(opts.system);
  if (chosen) {
    site.system = chosen;
    site.unsafe = profileOf(chosen.id)?.unsafe;
    log(`System chosen on the project: ${chosen.name}`);
  }
  let loginHints: { username?: string; password?: string; submit?: string } | undefined = chosen && !opts.login?.usernameSelector ? profileOf(chosen.id)?.login : undefined;
  try {
    if (opts.login) {
      // Spot the system on its sign-in page (Odoo, Zoho, WordPress...) to use its own sign-in fields.
      if (!chosen && opts.login.loginUrl && !opts.login.usernameSelector && !opts.login.steps) {
        const html = await context.request
          .get(opts.login.loginUrl, { timeout: 15_000 })
          .then((r) => r.text())
          .catch(() => "");
        const sys = detectSystem({ url: opts.login.loginUrl, html });
        if (sys) {
          site.system = sys;
          loginHints = profileOf(sys.id)?.login;
          log(`The sign-in page looks like ${sys.name}`);
        }
      }
      live?.screen({ slot: 0, view: "desktop", doing: "Signing in", agents: [], state: "busy" });
      signedIn = await signIn(context, opts.login, log, { mailUrl: opts.mailUrl, signal: opts.signal, hints: loginHints, ...liveSignIn(live, castScreen, opts.signal) });
      if (isApp) {
        const cap = captureCalls(context, new URL(startUrl).origin);
        site.calls = cap.calls;
        site.sockets = cap.sockets;
        stopCalls = cap.stop;
      }
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

    // A signed-in app: spot the system on its first screen, then click through its menus to find
    // every screen, including those with no ordinary link (a full system test after login).
    if (isApp && done.length) {
      const first = done[0].result.url;
      const html = await context.request
        .get(first, { timeout: 15_000 })
        .then((r) => r.text())
        .catch(() => "");
      const cookieNames = (await context.cookies().catch(() => [])).map((c) => c.name);
      const sys = chosen ?? detectSystem({ url: first, html, cookies: cookieNames }) ?? site.system;
      if (sys) {
        if (!site.system || site.system.id !== sys.id) log(`Recognised the system: ${sys.name}${sys.framework ? ` (built on ${sys.framework})` : ""}`);
        site.system = sys;
        site.unsafe = profileOf(sys.id)?.unsafe;
      }
      if (signedIn && (opts.explore ?? true)) {
        log("Full system test: clicking through the app's menus to find every screen");
        const screens = await exploreApp(context, first, { system: profileOf(site.system?.id), unsafe: site.unsafe, log, signal: opts.signal }).catch((err: Error) => {
          if (opts.signal?.aborted) throw err;
          log(`App explorer stopped: ${err.message.split("\n")[0]}`);
          return [];
        });
        site.screens = screens;
        addLinks(first, screens.map((x) => x.url));
        const fromMenu = screens.filter((x) => x.via && x.via !== "Start screen").length;
        if (fromMenu) notes.push(`Full system test: the app explorer clicked through the menus and found ${screens.length} screens (${fromMenu} from menus, tabs and dropdowns), and tested them like any page.`);
      }
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
          if (gate?.isPaused()) {
            live?.screen({ slot, doing: "Paused by the tester", agents: [], state: "idle" });
            await gate.wait(opts.signal);
          }
          if (gate?.finishing()) {
            if (busy === 0) wake();
            return;
          }
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
            if (control.delayMs) await sleep(control.delayMs);
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
    // Record the links from any pages still buffered in page order (a page can finish out of order,
    // and if an earlier page never released its turn the later ones wait here). The site-wide checks
    // (linked documents, broken links) must see every link a crawled page found, as one screen would,
    // so several pages at once and one page at a time agree. Flush in page order before they run.
    for (const index of [...found.keys()].sort((a, b) => a - b)) {
      const entry = found.get(index)!;
      found.delete(index);
      addLinks(entry.pageUrl, entry.links);
    }
    gate?.clearSkipAll();
    const finishedEarly = gate?.finishing();
    if (finishedEarly) {
      notes.push(`${finishedEarly}: the test stopped opening new pages after ${done.length}, then ran the site-wide checks and scored what it tested.`);
      log(`${finishedEarly}: finishing with the pages tested so far`);
    }
    if (outOfScope) notes.push(`${outOfScope} linked page${outOfScope === 1 ? " was" : "s were"} left out by master control's depth limit or address lists.`);
    const skippedPages = done.filter((d) => d.result.skipped).length;
    if (skippedPages) notes.push(`The tester skipped ${skippedPages} page${skippedPages === 1 ? "" : "s"} from master control before every check ran on ${skippedPages === 1 ? "it" : "them"}.`);
    notes.push(...testerNotes);
    await gate?.wait(opts.signal);

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
        hook: opts.hookInbox,
        log,
        signal: opts.signal,
        roleSession: (roleId: string) => {
          if (!roleContexts.has(roleId)) {
            roleContexts.set(
              roleId,
              (async () => {
                const role = opts.roles?.find((r) => r.id === roleId);
                if (!role) throw new Error("The journey's role was deleted from the project.");
                const ctx = await browser.newContext({ viewport: control.desktop ?? DESKTOP, ...(control.headers ? { extraHTTPHeaders: control.headers } : {}) });
                await signIn(ctx, role.login, log, { mailUrl: opts.mailUrl, signal: opts.signal });
                return { context: ctx, login: role.login, name: role.name };
              })(),
            );
          }
          return roleContexts.get(roleId)!;
        },
      });
      journeys = r.results;
      findings.push(...r.findings);
      if (r.writes.length) site.writes = r.writes;
    }
    if (opts.baselineDir) findings.push(...(await compareVisuals(context, pages, opts.artifactsDir, opts.baselineDir, log)));
    cookies = cookieList(await context.cookies().catch(() => []), origin);

    // Site-wide agents (links, exposed files, duplicates...) run at the same time, except those
    // that measure speed or could end the session: they run afterwards, one at a time.
    if (site.calls) sortCalls(site.calls);
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
    stopCalls?.();
    opts.signal?.removeEventListener("abort", stop);
    for (const r of roleContexts.values()) await r.then((x) => x.context.close(), () => {}).catch(() => {});
    await browser.close().catch(() => {});
  }

  if (signOuts) {
    notes.push(`The site signed the agent out ${signOuts === 1 ? "once" : `${signOuts} times`} during the test, so it signed in again.`);
  }
  if (opts.login && runner.skipped.some((s) => s.category === "seo")) {
    notes.push("Search engine checks were left out because the test ran signed in: private pages are not meant to be found on Google.");
  }
  // The report's "Checks that change data" box lists the ones left out for want of consent too.
  const consentSkipped = runner.skipped.filter((a) => WEB_AGENTS.find((w) => w.id === a.id)?.needsConsent && a.skipped?.startsWith("Changes data"));
  if (isApp && opts.login && consentSkipped.length) {
    site.changes ??= { allowed: Boolean(opts.writes?.allowed), why: opts.writes?.why ?? "Checks that change data were not asked for.", ran: [], skipped: [], cleanedUp: [], leftOver: [] };
    for (const a of consentSkipped) if (!site.changes.skipped.some((x) => x.check === a.name)) site.changes.skipped.push({ check: a.name, why: opts.writes?.why ?? "Not allowed." });
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
    ...(site.screens?.length ? { screens: site.screens.map((x) => ({ ...x, tested: pages.some((p) => normaliseUrl(p.url) === x.url || (p.redirectedFrom && normaliseUrl(p.redirectedFrom) === x.url)) })) } : {}),
    ...(site.calls?.length ? { calls: site.calls.map(reportCall) } : {}),
    ...(site.sockets?.length ? { sockets: site.sockets.map((x) => ({ url: hideSocketSecrets(x.url), pageUrl: x.pageUrl })) } : {}),
    ...(site.access ? { access: site.access } : {}),
    ...(site.system ? { system: site.system } : {}),
    ...(site.changes ? { changes: site.changes } : {}),
    ...(site.forms?.length ? { forms: site.forms } : {}),
    ...(site.seoReport ? { seo: site.seoReport } : {}),
    ...(site.rum ? { rum: site.rum } : {}),
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

/** Report notes for master control settings that change what the browser saw. */
function describeTesterSetup(c: RunControl): string[] {
  const out: string[] = [];
  if (c.network) out.push(`Master control: pages were loaded on ${NETWORKS[c.network as keyof typeof NETWORKS]?.label ?? c.network}, so load times are slower than on full speed.`);
  if (c.cpuSlowdown) out.push(`Master control: the browser's CPU was slowed ${c.cpuSlowdown}× to act like a slower phone.`);
  if (c.javascript === false) out.push("Master control: JavaScript was off, so this is what visitors and search engines see without scripts.");
  if (c.blockUrls?.length) out.push(`Master control: requests to ${c.blockUrls.join(", ")} were blocked.`);
  if (c.phoneOn === false) out.push("Master control: the phone pass was off, so no phone checks ran.");
  if (c.locale || c.timezone) out.push(`Master control: the browser used ${[c.locale && `language ${c.locale}`, c.timezone && `time zone ${c.timezone}`].filter(Boolean).join(" and ")}.`);
  return out;
}
