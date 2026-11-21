import type { LiveSink } from "./live.js";
import type { ToolChoice, ToolStat } from "./tools/types.js";
import type { Permission } from "./permission.js";

import type { GateState, RunControl, RunGate, Verdict } from "./control.js";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Category = "functional" | "accessibility" | "seo" | "security" | "performance" | "mobile";

export const CATEGORIES: Category[] = [
  "functional",
  "accessibility",
  "seo",
  "security",
  "performance",
  "mobile",
];

/** What kind of product is being tested. Picks the engine and the specialist agents. */
export type ProductType = "website" | "webapp" | "saas" | "crm" | "ecommerce" | "api" | "code" | "android" | "ios";

export interface Finding {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  detail: string;
  pageUrl: string;
  /** Short machine-readable rule name, e.g. "broken-link" or "axe:color-contrast". */
  rule: string;
  evidence?: string;
  /** How many times the same rule fired on this page (grouped findings). */
  count?: number;
  /** The specialist agent that found it. */
  agent?: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageResult {
  url: string;
  /** The address we asked for, when the site redirected somewhere else. */
  redirectedFrom?: string;
  status: number | null;
  title: string;
  loadMs: number | null;
  /** The tester skipped this page from master control before every check ran. */
  skipped?: string;
  /** Speed numbers from the browser's timing data (lab measurement). */
  metrics?: {
    ttfbMs: number;
    lcpMs: number | null;
    cls: number;
    loadMs: number | null;
    bytes: number;
  };
  screenshot?: string;
  mobileScreenshot?: string;
  /** The page at tablet size (820 x 1180, an iPad Air held upright). */
  tabletScreenshot?: string;
  /** More files about the page that agents saved (the screen reader view, the network log...). */
  files?: { label: string; file: string }[];
  /** The inspect screen's recording (page-N-inspect.json), with the page's HTML and HAR. */
  inspect?: { file: string; dom?: string; har: string };
  /** Compared with the project's approved pictures. */
  visual?: { desktop?: VisualResult; phone?: VisualResult };
  /**
   * Parts of each picture that move by themselves (sliders, tickers, videos), in its pixels. Visual
   * compare leaves them out, so a slider caught on another slide is not a change.
   */
  moving?: { desktop?: Box[]; phone?: Box[] };
  error?: string;
}

/** A page's picture compared with its approved picture. */
export interface VisualResult {
  /** new: nothing to compare with, so this picture became the approved one. */
  status: "new" | "same" | "changed" | "approved";
  /** Share of the picture that changed, in percent. */
  changed?: number;
  /** The approved picture, copied into the run so the report keeps showing what it was compared with. */
  baseline?: string;
  /** The new picture faded, with the changes in red. */
  diff?: string;
  approvedAt?: string;
  /** Where the changes are, in the picture's pixels. */
  box?: { x: number; y: number; w: number; h: number };
}

/** Steps a person takes on the site, written in plain words (see src/runner/journeys.ts). */
export interface Journey {
  id: string;
  name: string;
  /** One step per line: open, click, fill … = …, see, url has… */
  steps: string;
  /** May send forms (POST and other changes). Only for staging or test sites. */
  allowWrites?: boolean;
  /** Kept, but not run. */
  off?: boolean;
  /** Run signed in as this role (its id) instead of the main account. */
  role?: string;
  /** Steps that always run at the end, even when the journey fails (delete the test record...). */
  cleanup?: string;
  /** Test data: a small table (CSV with a header row). The journey runs once per row, with {{column}} words. */
  data?: string;
}

export interface JourneyStepResult {
  /** Line number in the journey's text. */
  line: number;
  text: string;
  ok: boolean;
  ms: number;
  error?: string;
  /** Picture after the step. */
  shot?: string;
  url?: string;
  /** Requests stopped because they could change data. */
  blocked?: string[];
  /** The app's own calls during the step. */
  calls?: { method: string; url: string; status: number; ms: number }[];
  /** A clean-up step. */
  cleanup?: boolean;
}

export interface JourneyResult {
  id: string;
  name: string;
  ok: boolean;
  ms: number;
  /** Steps in the journey (the results stop at the first that fails). */
  total: number;
  steps: JourneyStepResult[];
  allowWrites?: boolean;
  /** The role it ran as. */
  role?: string;
  /** The test data row it ran with (1 = the first row under the header). */
  row?: number;
}

export interface ScanOptions {
  url: string;
  maxPages?: number;
  /** Check every link found (internal and external) for 4xx/5xx. */
  checkLinks?: boolean;
  /** Run axe-core accessibility checks. */
  accessibility?: boolean;
  /** Directory where screenshots are written. */
  artifactsDir: string;
  /** Called as the scan progresses. */
  onProgress?: (message: string) => void;
  /** Product type; decides which agents apply. Defaults to "website". */
  product?: ProductType;
  /** Ids of the agents to run. Defaults to every agent for the product that is on by default. */
  agents?: string[];
  /** Sign in with this before testing, to test the pages behind the login. */
  login?: Login;
  /** Stops the test (closes the browser) when the run is cancelled or the server stops. */
  signal?: AbortSignal;
  /** Called with the signed-in session's Cookie header at the end, for the outside tools. */
  onSession?: (cookie: string) => void;
  /** How many pages are tested at the same time (1 to 16). Defaults to PARALLEL_PAGES, or 4. */
  parallel?: number;
  /** Where the live view of the test goes (screens and what each agent is doing). */
  live?: LiveSink;
  /** Record the inspect screen (network, console, steps, HTML, HAR) for every page. */
  inspect?: boolean;
  /** Folder with the project's approved pictures: compare each page with them. Unset: no visual compare. */
  baselineDir?: string;
  /** User journeys to follow after the pages are tested. */
  journeys?: Journey[];
  /** The test mailbox (Mailpit) address, for journeys that check emails. */
  mailUrl?: string;
  /** Other accounts (roles, another company) for the access grid and role journeys. */
  roles?: RoleLogin[];
  /** Click through the signed-in app's menus to find its screens. Defaults to on for signed-in web apps, SaaS and CRMs. */
  explore?: boolean;
  /** The system chosen on the project (a known system's id); otherwise the test spots it. */
  system?: string;
  /** Webhook inbox for journeys: where to read what the app sent. */
  hookInbox?: HookInbox;
  /**
   * Checks that change data (account lockout, file uploads, mass assignment, forgot password, the
   * Salesforce guest check, Claude filling forms) run only when this says so: the project is a test
   * copy, or the client allowed it in writing (a "changes" permission with its proof file).
   */
  writes?: WriteConsent;
  /** The project's SEO audit input: keywords per page, known backlinks, a Search Console export. */
  seo?: SeoInput;
  /** Speed numbers from real visitors (the in-house speed snippet), folded into the report. */
  rum?: RumSummary;
  /** Where uploaded files are kept (the Search Console export). */
  uploadsDir?: string;
  /** Master control: the tester's settings for this test (sizes, network, crawl limits...). */
  control?: RunControl;
  /** Master control's live switches: pause, skip a page, finish now. */
  gate?: RunGate;
}

/** Whether a test may change data, and why. */
export interface WriteConsent {
  allowed: boolean;
  /** The project is marked as a test copy (not just allowed by a permission on a live system). */
  testCopy?: boolean;
  /** "The project is marked as a test copy" or "Permission from Ravi Kumar, CTO (Email of 18 Nov)". */
  why: string;
}

/** What the owner gave the SEO audit (see src/seo/audit.ts). */
export interface SeoInput {
  /** One per line: "https://site/page | keyword one, keyword two" (or "/page | words"). */
  keywords?: string;
  /** Pages on other sites that link here, one address per line (from the client, an outreach list, Search Console's Links export). */
  backlinks?: string;
  /** An uploaded Search Console "Queries" or "Pages" CSV export (the client's own data), under data/uploads. */
  gscFile?: string;
  gscFileName?: string;
}

/** Real visitors' speed for a project, from the in-house snippet (see src/rum.ts). */
export interface RumSummary {
  since: string;
  visits: number;
  /** 75th percentile of each number, as Google's Core Web Vitals use. */
  p75: { lcp?: number; cls?: number; inp?: number; ttfb?: number; fcp?: number };
  byDevice: { device: "phone" | "tablet" | "desktop"; visits: number; p75: RumSummary["p75"] }[];
  pages: { path: string; visits: number; p75: RumSummary["p75"] }[];
}

/** Reads the project's webhook inbox (see src/app/hooks.ts). */
export interface HookInbox {
  address: string;
  /** Messages that arrived after `since` (ISO time), newest first. */
  since(since: string): { at: string; method: string; body: string; headers: Record<string, string> }[];
}

export interface AgentStat {
  id: string;
  name: string;
  findings: number;
  /** Time spent, summed over every page. */
  ms: number;
  errors: number;
  /** The category the agent's checks count towards. */
  category?: Category;
  /** How many times it ran (once per page for page agents). */
  runs?: number;
  /** Why the check could not be done (it is shown as "not tested", never as passed). */
  untested?: string;
  /** Why the agent was left out on purpose (for example search checks on signed-in pages). */
  skipped?: string;
}

export interface ScanResult {
  startUrl: string;
  startedAt: string;
  finishedAt: string;
  pages: PageResult[];
  findings: Finding[];
  /** Only the categories that apply to the product (an API has no phone layout). */
  scores: Partial<Record<Category, number>>;
  /** Averages the categories that were tested; categories that could not be tested are left out. */
  overallScore: number;
  /** Categories with no check that could run, and why. They have no score. */
  notTested?: Partial<Record<Category, string>>;
  /** Checks that could not run. When set, the run is incomplete and the report says so first. */
  incomplete?: string[];
  /** What each specialist agent did. */
  agentStats?: AgentStat[];
  /** What was tested, for engines without pages ("Scanned 1,203 files"). */
  notes?: string[];
  /** What to call the "pages" of this result: "Endpoints" for an API, "Files" for code. */
  label?: { pages: string };
  /** Other addresses this run looked at (the API file, the base address), for the regression check. */
  scanned?: string[];
  /** True when the run re-checked the whole target (code and app tests), so anything not found again is fixed. */
  complete?: boolean;
  /** What each outside tool (Lighthouse, ZAP...) did in this run. */
  tools?: ToolStat[];
  /** The user journeys followed in this run. */
  journeys?: JourneyResult[];
  /** Every cookie the site set during the test (never their values). */
  cookies?: CookieInfo[];
  /** Signed-in app: the screens found (links and menus). */
  screens?: AppScreen[];
  /** Signed-in app: the calls the screens made to the app's server. */
  calls?: AppCall[];
  /** Signed-in app: live connections (WebSocket) the screens opened, login values hidden. */
  sockets?: AppSocket[];
  /** Signed-in app: who can open which screen and call. */
  access?: AccessGrid;
  /** The business system or framework the test recognised (Odoo, Salesforce, Laravel...). */
  system?: SystemInfo;
  /** API tests: every call with its request and answer, scenarios, changes and the access grid. */
  api?: ApiReport;
  /** Signed-in apps: the checks that change data, what they made and what was cleaned up. */
  changes?: ChangeReport;
  /** Signed-in apps: forms Claude (or the form filler) filled and sent on a test copy. */
  forms?: FormFill[];
  /** Websites: the SEO audit (keywords, backlinks, Search Console). */
  seo?: SeoReport;
  /** Websites: real visitors' speed, when the speed snippet is on the site. */
  rum?: RumSummary;
  /** Mobile apps: what the app is made of (framework, SDKs, libraries, servers), and what changed since the last upload. */
  app?: AppSummary;
}

/** A mobile app journey: its steps are lines of text (see src/mobile/journeys.ts). */
export interface AppJourney {
  id: string;
  name: string;
  steps: string;
  off?: boolean;
}

/** A mobile app's make-up, kept with each test so the next upload can be compared with it. */
export interface AppSummary {
  platform: "android" | "ios";
  id: string;
  name?: string;
  version?: string;
  build?: string;
  /** apk, aab, apks (split set), ipa or app (a zipped .app). */
  packaging: string;
  minOs?: string;
  /** Android: the target API level. */
  target?: string;
  /** File size in bytes. */
  size: number;
  /** "Flutter", "React Native", "Native (Kotlin/Java)" and so on. */
  framework: string;
  permissions: string[];
  sdks: { id: string; name: string; kind: string; tracker: boolean }[];
  libraries: { name: string; version: string; purl?: string }[];
  /** Servers named in the app's code (not those of known SDKs). */
  servers: string[];
  /** Languages the app has texts for. */
  languages: string[];
  /** Web links the app opens (App Links, Universal Links). */
  links: string[];
  /** The biggest files, for the size section. */
  biggest?: { file: string; size: number }[];
  /** What changed since the project's previous test of this app. */
  changes?: { since: string; version?: string; lines: string[] };
}

/** The checks that change data, for the report. */
export interface ChangeReport {
  allowed: boolean;
  why: string;
  /** The checks that ran: "Account lockout", "File uploads"... */
  ran: string[];
  /** Checks that did not run, and why. */
  skipped: { check: string; why: string }[];
  /** Things the test made and put back or removed. */
  cleanedUp: string[];
  /** Things the test made that it could not remove: delete them by hand. */
  leftOver: string[];
}

/** A form filled and sent on a test copy. */
export interface FormFill {
  pageUrl: string;
  form: string;
  /** Who chose the values: Claude, or the built-in filler when no API key is set. */
  by: "claude" | "filler";
  fields: { name: string; label?: string; type: string; value: string }[];
  status?: number;
  /** "saved", "refused" (the form showed its own error), "server-error", "no-change", "blocked". */
  outcome: "saved" | "refused" | "server-error" | "no-change" | "blocked";
  message?: string;
  shot?: string;
}

/** The SEO audit's results. What needs outside data is said plainly. */
export interface SeoReport {
  keywords: { page: string; keyword: string; inTitle: boolean; inH1: boolean; inUrl: boolean; inDescription: boolean; count: number; score: number }[];
  backlinks: { from: string; status: number | null; linked: boolean; to?: string; anchor?: string; rel?: string; note?: string }[];
  /** From the Search Console export: queries or pages, with their average position. */
  searchConsole?: { kind: "queries" | "pages"; rows: { key: string; clicks: number; impressions: number; ctr: number; position: number }[]; nearTop: number };
  /** Links from the site to other sites, and how many are broken or nofollow. */
  outbound: { total: number; domains: number; broken: string[]; nofollow: number; sponsored: number };
  limits: string[];
}

/** One call the API test made, for the Endpoints tab (secrets are never in it). */
export interface ApiCallView {
  method: string;
  path: string;
  /** The address called (a key sent in the address is left out). */
  url: string;
  status: number | null;
  /** Median time of the calls made, in milliseconds. */
  ms: number;
  /** The 95% time, when several calls were made. */
  p95?: number;
  samples?: number;
  bytes: number;
  contentType: string;
  /** Request headers, with the login shown as [hidden]. */
  requestHeaders: Record<string, string>;
  requestBody?: string;
  responseHeaders: Record<string, string>;
  /** The start of the answer (up to 8 KB). */
  body: string;
  /** Where the answer differs from the API file. */
  problems?: string[];
  /** Fields in the answer the API file does not list. */
  extra?: string[];
  error?: string;
  /** Where a real id in the address came from: "GET /users → $[0].id". */
  idFrom?: string;
  /** Path values that are only a guess ("1"), because the file gives no example and no list had one. */
  guessed?: string[];
  /** The test-server write test this call belongs to ("create", "read back", "update", "delete", "clean-up"). */
  step?: string;
  deprecated?: boolean;
}

export interface ApiCoverage {
  documented: number;
  called: number;
  passed: number;
  /** Endpoints not called, with why. */
  skipped: { method: string; path: string; why: string }[];
}

export interface ApiScenarioStep {
  line: number;
  text: string;
  ok: boolean;
  /** Set for a request step. */
  call?: ApiCallView;
  /** The checks after the request, with what was found. */
  checks?: { line: number; text: string; ok: boolean; actual?: string }[];
  error?: string;
  cleanup?: boolean;
}

export interface ApiScenarioResult {
  id: string;
  name: string;
  ok: boolean;
  ms: number;
  steps: ApiScenarioStep[];
  error?: string;
  /** Requests that would have changed data on a server that is not marked as a test server. */
  blocked?: string[];
}

/** An API test written in plain words: requests, values saved from answers, and checks. */
export interface ApiScenario {
  id: string;
  name: string;
  steps: string;
  cleanup?: string;
  off?: boolean;
}

export interface ApiChange {
  kind: "breaking" | "safe";
  /** "GET /users/{id}", or "API" for the whole file. */
  where: string;
  text: string;
}

export interface ApiAccessRow {
  method: string;
  path: string;
  url: string;
  /** Account name -> HTTP status (null: no answer); "No login" is the call without credentials. */
  cells: Record<string, { status: number | null; same?: boolean; bad?: string }>;
}

export interface ApiReport {
  /** Where the endpoint list came from. */
  source: "openapi" | "found" | "postman" | "har" | "curl" | "graphql" | "soap" | "grpc" | "websocket" | "pact";
  /** The address the API file was found at, when the test looked for it. */
  foundAt?: string;
  calls: ApiCallView[];
  coverage: ApiCoverage;
  /** Test-server write tests, when the project is marked as a test server. */
  writes?: { ran: boolean; why?: string; created: number; cleanedUp: number; leftOver: string[] };
  scenarios?: ApiScenarioResult[];
  /** Differences from the approved copy of the API file. */
  changes?: { since: string; list: ApiChange[]; approvedAt?: string };
  /** First test (no approved copy yet): this run's file became the approved copy. */
  baselineSaved?: boolean;
  access?: { accounts: string[]; rows: ApiAccessRow[] };
  /** The API file audit: a score out of 100 and how many rules it breaks. */
  audit?: { score: number; failed: number; rules: number };
  graphql?: { queries: number; mutations: number; types: number; introspection: boolean };
  /** SOAP, gRPC and WebSocket tests: what the service offers and what was called. */
  protocol?: { kind: "soap" | "grpc" | "websocket"; service: string; operations: number; called: number; notCalled: number; detail?: string };
  /** Contract tests (Pact): each interaction the consumer expects, and whether the API still does it. */
  contract?: ContractReport;
}

export interface ContractReport {
  consumer: string;
  provider: string;
  /** The Pact file's version (2, 3 or 4). */
  spec: string;
  interactions: {
    description: string;
    state?: string;
    method: string;
    path: string;
    ok: boolean;
    /** Why it was not sent (a change on a live API) or what did not match. */
    skipped?: string;
    problems: string[];
    status?: number | null;
  }[];
}

export interface SystemInfo {
  id: string;
  name: string;
  kind: string;
  /** What gave it away: "address", "page", "cookie". */
  by: string[];
  tip?: string;
  framework?: string;
}

/** A cookie the site set, without its value. */
export interface CookieInfo {
  name: string;
  domain: string;
  path: string;
  /** Set by the site itself (true) or by another website it loads. */
  firstParty: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None";
  /** When it ends; unset: when the browser closes. */
  expires?: string;
  size: number;
}

export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface AiSummary {
  model: string;
  summary: string;
  topFixes: { title: string; why: string; how: string }[];
  /** Fingerprint of the issues the summary was written from (see summaryKey). */
  key?: string;
  /** Tokens the summary used (input, output), to keep an eye on credits. */
  tokens?: { input: number; output: number };
  /** Set when an earlier test had the same issues, so its summary was reused and no credits were spent. */
  reusedFrom?: { runId: string; at: string };
}

/** Compared with the project's issue list before this run. */
export interface RunDiff {
  new: number;
  /**
   * Of the new ones: found by a check that could not run or finish in the test before (a tool that
   * timed out, one just turned on), so they are new to the board, not new on the site.
   */
  firstChecked?: number;
  fixed: number;
  reopened: number;
  open: number;
}

export interface Run {
  id: string;
  url: string;
  projectId?: string;
  product?: ProductType;
  trigger?: "manual" | "schedule" | "retest";
  /** Agent ids that ran. */
  agents?: string[];
  /** Outside tools this run uses, with their options. */
  tools?: ToolChoice[];
  diff?: RunDiff;
  /** Master control settings this test ran with (only what was changed from normal). */
  control?: RunControl;
  /** Who started it with master control, and which preset. */
  controlBy?: { name?: string; preset?: string };
  /** Pass or fail under master control's rules. */
  verdict?: Verdict;
  /** Paused, finishing early, pages skipped: while it runs and after. */
  gateState?: GateState;
  status: RunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress: string[];
  result?: ScanResult;
  ai?: AiSummary;
  aiError?: string;
  error?: string;
}

export type Schedule = "off" | "daily" | "weekly";

export interface ProjectTarget {
  /** Website or web app address, or the API's base address. */
  url?: string;
  maxPages?: number;
  checkLinks?: boolean;
  /** Signed-in apps: the system it is (a known system's id), when the test cannot spot it on its own. */
  system?: string;
  /** API: address of the OpenAPI (Swagger) file, JSON or YAML. */
  specUrl?: string;
  /** API: a GraphQL endpoint to test instead of a REST API file. */
  graphqlUrl?: string;
  /** API and signed-in apps: the project is a test server or test copy, so tests may create, change and delete data (and clean up). */
  testServer?: boolean;
  /** API: a SOAP service's WSDL address. */
  soapUrl?: string;
  /** API: a gRPC server, host:port (grpcs:// for TLS, grpc:// for plain). */
  grpcUrl?: string;
  /** API: an uploaded .proto file for the gRPC server (otherwise the server's reflection is used). */
  protoFile?: string;
  protoFileName?: string;
  /** API: a WebSocket address (wss://...). */
  wsUrl?: string;
  /** API: messages to send on the WebSocket, one per line, each optionally "=> text the answer must have". */
  wsMessages?: string;
  /** API: an uploaded Pact contract (JSON) the API must keep. */
  contractFile?: string;
  contractFileName?: string;
  /** Any project: the source repository fixes are proposed to (a pull request), with its own token in the vault. */
  fixRepoUrl?: string;
  fixBranch?: string;
  /** Source code: Git repository to clone (https). */
  repoUrl?: string;
  branch?: string;
  /** An uploaded file (APK, IPA, a zip of source code, or the API file), stored under data/uploads. */
  file?: string;
  /** The uploaded file's original name, for display. */
  fileName?: string;
}

export type LoginKind = "web" | "api" | "git" | "app";
export type ApiAuthType = "bearer" | "header" | "basic" | "query" | "oauth2" | "login";

/**
 * A saved login for logged-in testing, kept encrypted in the vault on GLV's server.
 * password and token are secret: they are only decrypted for a test run and never sent to the dashboard.
 */
export interface Login {
  kind: LoginKind;
  /** web: the sign-in page. */
  loginUrl?: string;
  /** web and basic auth: the user name or email. git: optional user name to go with the token. */
  username?: string;
  password?: string;
  /** web: CSS selectors, only needed when the sign-in form is unusual. */
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  /** web: text that only shows once signed in, like "Sign out" or the user's name. */
  successText?: string;
  /** api: how the key or token is sent. */
  authType?: ApiAuthType;
  /** api: the header or query parameter name, for header and query keys. */
  paramName?: string;
  /** api oauth2: the token address (client credentials). login: the sign-in call's address. */
  tokenUrl?: string;
  /** api oauth2: the scopes to ask for. */
  scope?: string;
  /** api login: where the token is in the sign-in answer, like $.token or $.data.access_token. */
  tokenPath?: string;
  /** api and git: the token or key. */
  token?: string;
  /** web: the secret behind the two-step code (the text under the QR code), for sign-ins that ask for a one-time code. */
  totpSecret?: string;
  /** web: where the one-time code comes from: the saved secret (authenticator app) or an email to the test mailbox. */
  codeFrom?: "totp" | "email";
  /** web: sign-in steps, in journey words, for sign-ins the form filler cannot do on its own (several pages, a company picker...). */
  steps?: string;
  /** web: what this account is, shown in the access grid ("Admin", "Sales staff"). */
  roleName?: string;
}

/** Another account to test the app with: a lower role, or a user of another client company. */
export interface RoleLogin {
  id: string;
  name: string;
  login: Login;
  /** A user of another company (tenant): it must never see the main account's records. */
  otherCompany?: boolean;
  /** Addresses this role must never open, one per line: /admin, /settings/billing, /users/* */
  mustNotOpen?: string;
  /** A spare account the lockout check may lock (wrong passwords until the site blocks it). */
  lockoutTest?: boolean;
}

/** What the dashboard sees of a role: no secrets. */
export interface RoleSummary extends Omit<RoleLogin, "login"> {
  login: LoginSummary;
}

/** A screen of the signed-in app, found by its links or by clicking its menus. */
export interface AppScreen {
  url: string;
  title?: string;
  /** How the explorer got there: "Menu > Contacts > Import". Unset when an ordinary link led there. */
  via?: string;
  /** In the app's own menu (sidebar, top bar, tabs). */
  inMenu?: boolean;
  /** Tabs and panels inside the screen that open without changing its address. */
  parts?: string[];
  tested?: boolean;
}

/** A call the app's screens made to its own server (fetch or XHR), without its answer. */
export interface AppCall {
  method: string;
  url: string;
  status: number;
  ms: number;
  bytes: number;
  /** The screen that made it. */
  pageUrl: string;
  type?: string;
  /** Sent a login header (Authorization) rather than only cookies. */
  bearer?: boolean;
  /** What the same call answered with no login: the status, or "same" when it gave the same data. */
  anon?: number | "same";
  /** A POST that only reads: what it asks (a GraphQL query, an Odoo read). */
  what?: string;
}

/** A live connection (WebSocket) a screen opened. The address has its login values hidden. */
export interface AppSocket {
  url: string;
  pageUrl: string;
}

export type AccessCell = "opens" | "blocked" | "error" | "same-data" | "other-data" | "not-tried";

/** Who can open what: a row per screen or call, a column per account. */
export interface AccessGrid {
  roles: { id: string; name: string; otherCompany?: boolean; signedIn: boolean; error?: string }[];
  rows: {
    /** A screen, an app call (GET, or a POST that only reads), or a save made on a test server. */
    kind: "screen" | "call" | "change";
    url: string;
    /** The method, for calls and saves that are not GET. */
    method?: string;
    /** What a POST call reads ("GraphQL query Contacts"), or the journey that made a save. */
    what?: string;
    /** A known admin screen of the system, tried directly (no menu leads to it). */
    known?: boolean;
    /** In the main account's menu. */
    inMenu?: boolean;
    cells: Record<string, AccessCell>;
    /** Roles whose own menu has this screen. */
    menuOf?: string[];
    /** Cells that are a problem, by role: the role must never open it, its menu hides it, or another company got the data. */
    flags?: Record<string, "forbidden" | "hidden" | "other-company" | "admin" | "no-login">;
  }[];
}

/** What the dashboard sees of a saved login: no secrets, only whether each one is saved. */
export interface LoginSummary extends Omit<Login, "password" | "token" | "totpSecret"> {
  hasPassword: boolean;
  hasToken: boolean;
  hasTotp?: boolean;
  /** Saved with a key this server no longer has, so it must be entered again. */
  unreadable?: boolean;
  updatedAt: string;
}

export interface Project {
  id: string;
  /** Short uppercase prefix for issue keys, like Jira: GLV-12. */
  key: string;
  name: string;
  type: ProductType;
  target: ProjectTarget;
  schedule: Schedule;
  createdAt: string;
  lastRunId?: string;
  lastRunAt?: string;
  lastScore?: number;
  /** Last issue number used. */
  issueSeq: number;
  /** Outside tools turned on for this project's tests. Unset: every safe tool installed on the server. */
  tools?: ToolChoice[];
  /** The client's written permissions for load and attack tests, newest last (withdrawn ones are kept). */
  permissions?: Permission[];
  /** Steps a person takes on the site, followed on every test (websites and web apps). */
  journeys?: Journey[];
  /** Uptime and SSL watch between tests. */
  watch?: WatchConfig;
  /** API tests written in plain words, run on every test. */
  apiScenarios?: ApiScenario[];
  /** Mobile apps: steps in plain words run on the test phone (tap "Sign in", see "Welcome"). */
  appJourneys?: AppJourney[];
  /** The mock server's secret address part, when the mock is on. */
  mockToken?: string;
  /** The real-visitor speed snippet's id, when it is on. */
  rumToken?: string;
  /** SEO audit input. */
  seo?: SeoInput;
  /** Pull requests Claude opened with fixes. */
  fixPrs?: FixPr[];
  /** Master control settings every test of this project starts with (scheduled ones too). */
  control?: RunControl;
}

/** A fix Claude wrote and opened as a pull request on the project's repository. */
export interface FixPr {
  id: string;
  /** The issue key or finding rule it fixes. */
  issue: string;
  title: string;
  url?: string;
  branch: string;
  files: string[];
  status: "opened" | "failed";
  error?: string;
  at: string;
  by: string;
}

/** Uptime and SSL watch for a website project (see src/watch.ts). */
export interface WatchConfig {
  on: boolean;
  /** Minutes between checks: 1, 5, 15 or 60. */
  everyMin: number;
  /** Words the page must contain, to catch a blank or error page that still answers 200. */
  expectText?: string;
  /** API projects: the endpoint to check (called with the saved login). */
  checkUrl?: string;
  /** The project's own webhook for alerts (Slack, Teams, Google Chat...). */
  webhook?: string;
  /** Warn this many days before the certificate ends. */
  sslWarnDays?: number;
  /** Also run the project's journeys (read-only ones) between tests. */
  journeys?: boolean;
  /** Minutes between journey runs: 15, 30 or 60. */
  journeysEveryMin?: number;
}

/** The last journey watch run of a project. */
export interface JourneyWatchRun {
  at: string;
  ok: boolean;
  ms: number;
  results: { id: string; name: string; ok: boolean; ms: number; failedStep?: string; error?: string }[];
  error?: string;
}

export type IssueStatus = "open" | "in_progress" | "fixed" | "verified" | "reopened" | "wont_fix";

export interface IssueEvent {
  at: string;
  type: "created" | "status" | "regression" | "verified" | "comment" | "seen";
  text: string;
  by?: string;
  runId?: string;
}

/** A tracked issue: one distinct problem in a project, followed across test runs. */
export interface Issue {
  id: string;
  key: string;
  projectId: string;
  /** Same as the report's issue key (rule + title without numbers). */
  fingerprint: string;
  rule: string;
  agent?: string;
  title: string;
  detail: string;
  category: Category;
  severity: Severity;
  status: IssueStatus;
  occurrences: { pageUrl: string; evidence?: string }[];
  assignee?: string;
  firstSeenRunId: string;
  lastSeenRunId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt: string;
  history: IssueEvent[];
  /**
   * Speed results change from run to run, so a speed issue changes state only when two runs in a
   * row agree: these count the runs in a row that did not find it (while open) or found it again
   * (while fixed or verified).
   */
  missedRuns?: number;
  backRuns?: number;
  /** Closed because it is the same problem as this issue key (only a count in its title differed). */
  mergedInto?: string;
}

export type Role = "owner" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}
