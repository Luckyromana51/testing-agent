import type { BrowserContext, Page, Response } from "playwright";
import type { AccessGrid, AppScreen, AppSocket, Category, ChangeReport, Finding, FormFill, Login, PageResult, ProductType, RoleLogin, RumSummary, SeoInput, SeoReport, SystemInfo, WriteConsent } from "../types.js";

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
  /** Changes data: runs only on a test copy or under the client's written permission. */
  needsConsent?: boolean;
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
  /** Every answer the page got, with the headers and size the network inspector reads. */
  responses: NetResponse[];
}

/** One answer the browser received while loading a page. */
export interface NetResponse {
  url: string;
  status: number;
  /** "document", "script", "stylesheet", "image", "font", "fetch", "xhr"... */
  type: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Bytes received for the body (compressed), when the browser knows it. */
  bytes: number;
  /** It came from a redirect (3xx) and was followed. */
  redirected: boolean;
  /** The address first asked for, when it was redirected. */
  redirectedFrom?: string;
}

/** Shared notes that page agents leave for site agents. */
export interface SiteState {
  /** Each page's title and description, and the canonical address it names (if any). */
  seo: Map<string, { title: string; description: string | null; canonical?: string | null }>;
  /** True when the crawl runs signed in: agents then stay away from anything that could change data. */
  loggedIn?: boolean;
  /** The user name or email the test signed in with, to recognise private pages. */
  loginUser?: string;
  /** The main login, for agents that sign in again in their own browser (session checks). Never reported. */
  login?: Login;
  /** Other accounts of the project (roles, another company). */
  roles?: RoleLogin[];
  /** The test mailbox, for sign-ins that email a code. */
  mailUrl?: string;
  /** The app's own calls (fetch, XHR) seen while signed in, with their answers, in memory only. */
  calls?: CapturedCall[];
  /** Live connections (WebSocket) the screens opened. */
  sockets?: AppSocket[];
  /** Calls that changed data in journeys allowed to send forms (test servers), to try as the other accounts. */
  writes?: WriteCall[];
  /** Screens the explorer found. */
  screens?: AppScreen[];
  /** The system the test recognised. */
  system?: SystemInfo;
  /** Addresses this system uses for actions: never opened. */
  unsafe?: RegExp;
  /** Filled in by the access agent for the report. */
  access?: AccessGrid;
  signal?: AbortSignal;
  /** Whether checks that change data may run (a test copy, or the client's written permission). */
  consent?: WriteConsent;
  /** The checks that change data: what ran, what was cleaned up, what is left (filled in by them). */
  changes?: ChangeReport;
  /** Forms filled and sent on a test copy. */
  forms?: FormFill[];
  /** The SEO audit's input and its report. */
  seoInput?: SeoInput;
  seoReport?: SeoReport;
  uploadsDir?: string;
  /** Real visitors' speed. */
  rum?: RumSummary;
  /** Pages where the dark-pattern check saw a countdown (the fake-timer check opens them again). */
  timerPages?: string[];
}

/** One app call with its answer, kept in memory while the test runs. */
/** A call that changed data (POST, PUT, PATCH, DELETE) made by a journey on a test server. */
export interface WriteCall {
  method: string;
  url: string;
  status: number;
  body?: string;
  contentType?: string;
  /** The screen it was made on. */
  pageUrl: string;
  /** The journey that made it. */
  journey: string;
}

export interface CapturedCall {
  method: string;
  url: string;
  status: number;
  ms: number;
  bytes: number;
  pageUrl: string;
  type: string;
  contentType: string;
  /** The answer, when it is text and not too big. */
  body?: string;
  /** Request headers worth replaying (Authorization, X-...), never reported. */
  auth?: Record<string, string>;
  /** A POST that only reads (GraphQL query, Odoo search_read...): what it reads, and its body to send again. */
  read?: string;
  request?: { body: string; contentType: string };
  /** How many times the same call was made. */
  count: number;
  /** What the same call answered with no login (filled in by the calls agent). */
  anon?: number | "same";
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
  /** The page's number in the report, and the folder for files an agent saves about it. */
  index: number;
  artifactsDir: string;
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
  /** Every tested page's links (normalised), by the page's address. */
  pageLinks: Map<string, string[]>;
  /** Folder for files an agent saves (screenshots from other browsers...). */
  artifactsDir: string;
}

/**
 * When a page agent runs:
 * - page: after the page loads, at desktop size
 * - tablet: after the window is resized to a tablet held upright (820 x 1180)
 * - mobile: after the window is resized to a phone
 * - end: last, once every console message and request has been seen
 */
export interface PageAgent extends AgentInfo {
  stage: "page" | "tablet" | "mobile" | "end";
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
  /**
   * Runs after the other site agents, one at a time: it measures speed (other work would slow
   * its numbers), or, with "signed-in", it opens the session in other browsers, which some sites
   * answer by ending it.
   */
  runsLast?: boolean | "signed-in";
  run(ctx: SiteContext): Promise<Finding[]> | Finding[];
}

export type WebAgent = PageAgent | SiteAgent;

/** An agent of the API, code or mobile engine. Each engine passes its own context. */
export interface EngineAgent<Ctx> extends AgentInfo {
  run(ctx: Ctx): Promise<Finding[]> | Finding[];
}
