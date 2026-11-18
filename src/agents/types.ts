import type { BrowserContext, Page, Response } from "playwright";
import type { Category, Finding, PageResult, ProductType } from "../types.js";

/** Which test engine runs an agent: the browser, the API caller, the offline code reader, or the app reader. */
export type Engine = "web" | "api" | "code" | "mobile";

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
  category: Category;
  engine: Engine;
  /** Product types this agent is useful for. */
  products: ProductType[];
  /** Off until the owner turns it on. */
  defaultOff?: boolean;
  /** Only useful on a signed-in test (it checks the pages behind the login); skipped otherwise. */
  needsLogin?: boolean;
}

/** Everything the browser saw while loading one page. */
export interface PageSignals {
  consoleErrors: { text: string; source: string }[];
  pageErrors: string[];
  failedRequests: string[];
  badResponses: string[];
  insecure: string[];
  /** Every URL the page requested (for third-party and tracker checks). */
  requests: string[];
}

/** Shared notes that page agents leave for site agents. */
export interface SiteState {
  /** Each page's title and description, and the canonical address it names (if any). */
  seo: Map<string, { title: string; description: string | null; canonical?: string | null }>;
  /** True when the crawl runs signed in: agents then stay away from anything that could change data. */
  loggedIn?: boolean;
  /** The user name or email the test signed in with, to recognise private pages. */
  loginUser?: string;
}

export interface PageContext {
  page: Page;
  /** Final address after redirects. */
  url: string;
  status: number | null;
  response: Response | null;
  isFirst: boolean;
  signals: PageSignals;
  browser: BrowserContext;
  product: ProductType;
  result: PageResult;
  site: SiteState;
}

export interface SiteContext {
  browser: BrowserContext;
  /** Where the site really lives, after the first redirect. */
  origin: string;
  startUrl: string;
  pages: PageResult[];
  /** Every link found, mapped to the page it was found on. */
  linkSources: Map<string, string>;
  product: ProductType;
  site: SiteState;
  log: (message: string) => void;
}

/**
 * When a page agent runs:
 * - page: after the page loads, at desktop size
 * - mobile: after the window is resized to a phone
 * - end: last, once every console message and request has been seen
 */
export interface PageAgent extends AgentInfo {
  stage: "page" | "mobile" | "end";
  /** Skip pages that answered 4xx/5xx (they are already reported once). */
  skipErrorPages?: boolean;
  /**
   * The agent changes the page while it checks (presses keys, zooms, clicks). Such agents run one
   * at a time after the others; agents that only read the page all run at the same time.
   */
  interacts?: boolean;
  run(ctx: PageContext): Promise<Finding[]> | Finding[];
}

/** Runs once per scan, after every page has been visited. */
export interface SiteAgent extends AgentInfo {
  stage: "site";
  run(ctx: SiteContext): Promise<Finding[]> | Finding[];
}

export type WebAgent = PageAgent | SiteAgent;

/** An agent of the API, code or mobile engine. Each engine passes its own context. */
export interface EngineAgent<Ctx> extends AgentInfo {
  run(ctx: Ctx): Promise<Finding[]> | Finding[];
}
