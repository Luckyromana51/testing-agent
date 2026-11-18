import type { LiveSink } from "./live.js";
import type { ToolChoice, ToolStat } from "./tools/types.js";
import type { Permission } from "./permission.js";

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

export interface PageResult {
  url: string;
  /** The address we asked for, when the site redirected somewhere else. */
  redirectedFrom?: string;
  status: number | null;
  title: string;
  loadMs: number | null;
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
  /** More files about the page that agents saved (the screen reader view, the network log...). */
  files?: { label: string; file: string }[];
  error?: string;
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
  /** API: address of the OpenAPI (Swagger) file, JSON or YAML. */
  specUrl?: string;
  /** Source code: Git repository to clone (https). */
  repoUrl?: string;
  branch?: string;
  /** An uploaded file (APK, IPA, a zip of source code, or the API file), stored under data/uploads. */
  file?: string;
  /** The uploaded file's original name, for display. */
  fileName?: string;
}

export type LoginKind = "web" | "api" | "git";
export type ApiAuthType = "bearer" | "header" | "basic" | "query";

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
  /** api and git: the token or key. */
  token?: string;
}

/** What the dashboard sees of a saved login: no secrets, only whether each one is saved. */
export interface LoginSummary extends Omit<Login, "password" | "token"> {
  hasPassword: boolean;
  hasToken: boolean;
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
}

export type Role = "owner" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}
