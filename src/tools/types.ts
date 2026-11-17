import type { Category, Finding, ProductType, ProjectTarget } from "../types.js";

/** Safe tools behave like a normal visitor. Permission tools attack or load a site (phase 3). */
export type ToolSafety = "safe" | "permission";

export interface ToolOption {
  id: string;
  label: string;
  choices: { value: string; label: string }[];
  default: string;
}

/** What a tool is, for the tabs on the new-test page. */
export interface ToolInfo {
  id: string;
  name: string;
  /** Who makes it, e.g. "Google" or "OWASP". */
  maker: string;
  /** One or two lines on what it checks. */
  description: string;
  /** What it adds to the platform's own checks, as short lines. */
  checks: string[];
  products: ProductType[];
  /** The score category its findings count towards. */
  category: Category;
  safety: ToolSafety;
  /** Roughly how long it takes, e.g. "about 1 minute". */
  takes: string;
  licence: string;
  homepage: string;
  /** How it treats a saved login: tests the signed-in pages too, or only what a visitor sees. */
  signedIn: "uses-login" | "public";
  options?: ToolOption[];
}

/** A tool the tester turned on for a project, with its options. */
export interface ToolChoice {
  id: string;
  options?: Record<string, string>;
}

/** Everything a tool gets for one run. */
export interface ToolContext {
  product: ProductType;
  target: ProjectTarget;
  /** The address the engine tested (after redirects). */
  startUrl: string;
  /** The pages the platform's crawl opened (web), or the API's endpoint addresses. */
  urls: string[];
  /** Cookie header of the signed-in session, for tools that test signed-in pages. */
  cookie?: string;
  options: Record<string, string>;
  /** Where the tool's own report files go (served with the run's evidence). */
  outDir: string;
  /** Scratch space, removed after the run. */
  workDir: string;
  signal: AbortSignal;
  log: (message: string) => void;
}

export interface ToolReport {
  /** File name in the run's artifacts folder. */
  file: string;
  label: string;
}

/**
 * A finding from a tool. sameAs names the platform's own rules for the same problem: when a
 * platform check already found it on the same site, the tool's copy is folded into that finding
 * instead of being counted twice.
 */
export type ToolFinding = Omit<Finding, "id" | "agent"> & { sameAs?: string[] };

export interface ToolOutput {
  findings: ToolFinding[];
  /** Short result lines shown in the tool's section, e.g. "Performance 72". */
  summary?: string[];
  reports?: ToolReport[];
  /** What was tested, e.g. "Checked 12 pages". */
  tested?: string;
}

export interface Tool extends ToolInfo {
  /** Null when the tool is installed and ready, else why it cannot run on this server. */
  ready(): Promise<string | null>;
  run(ctx: ToolContext): Promise<ToolOutput>;
}

/** What the report shows for each tool that was part of a run. */
export interface ToolStat {
  id: string;
  name: string;
  status: "done" | "untested";
  ms: number;
  findings: number;
  /** Why it could not run or finish (the run is marked incomplete). */
  untested?: string;
  summary?: string[];
  reports?: ToolReport[];
  tested?: string;
  /** Findings dropped because a platform check already reported the same problem. */
  merged?: number;
}
