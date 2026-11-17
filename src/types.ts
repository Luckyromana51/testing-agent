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
}

export interface AgentStat {
  id: string;
  name: string;
  findings: number;
  /** Time spent, summed over every page. */
  ms: number;
  errors: number;
}

export interface ScanResult {
  startUrl: string;
  startedAt: string;
  finishedAt: string;
  pages: PageResult[];
  findings: Finding[];
  scores: Record<Category, number>;
  overallScore: number;
  /** What each specialist agent did. */
  agentStats?: AgentStat[];
}

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface AiSummary {
  model: string;
  summary: string;
  topFixes: { title: string; why: string; how: string }[];
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
  /** Website, web app or API base address. */
  url?: string;
  maxPages?: number;
  checkLinks?: boolean;
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
}

export type Role = "owner" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  createdAt: string;
}
