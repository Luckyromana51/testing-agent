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
}

export interface ScanResult {
  startUrl: string;
  startedAt: string;
  finishedAt: string;
  pages: PageResult[];
  findings: Finding[];
  scores: Record<Category, number>;
  overallScore: number;
}

export type RunStatus = "queued" | "running" | "done" | "failed";

export interface AiSummary {
  model: string;
  summary: string;
  topFixes: { title: string; why: string; how: string }[];
}

export interface Run {
  id: string;
  url: string;
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
