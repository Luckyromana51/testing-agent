import type { ModuleId } from "../modules.js";
import type { PermissionKind } from "../permission.js";
import type { AppJourney, AppSummary, Category, Finding, Login, ProductType, ProjectTarget } from "../types.js";

/** Safe tools behave like a normal visitor. Permission tools load or attack a site, only with the client's written permission. */
export type ToolSafety = "safe" | "permission";

export interface ToolOption {
  id: string;
  label: string;
  /** "choice" (the default) picks from choices; "file" is a file the tester uploads (a Postman collection). */
  kind?: "choice" | "file";
  /** For a file: the file types the upload takes, e.g. ".json". */
  accept?: string;
  /** For a file: the tool cannot run without it. */
  required?: boolean;
  /** One line under the option. */
  hint?: string;
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
  /** For a permission tool: which kind of permission it needs. */
  permission?: PermissionKind;
  /** For a permission tool: the option that sets how many users it simulates, and how many minutes it runs, checked against the permission. */
  limits?: { users?: string; minutes?: string };
  /** Roughly how long it takes, e.g. "about 1 minute". */
  takes: string;
  licence: string;
  homepage: string;
  /** How it treats a saved login: tests the signed-in pages too, or only what a visitor sees. */
  signedIn: "uses-login" | "public";
  options?: ToolOption[];
  /**
   * Runs on GLV's Mac helper (Safari, VoiceOver, the iOS Simulator): ready only while a paired Mac is
   * connected, so its status is checked on every request, and it is never switched on by default.
   */
  needsMac?: boolean;
  /** Runs on a test phone (Owner panel > Devices): checked on every request, never on by default. */
  needsDevice?: boolean;
  /**
   * Its category is scored even when the engine does not score it (Apple's accessibility audit for an
   * iOS app). When it cannot run, the category shows as not tested rather than as a free 100.
   */
  ownCategory?: boolean;
  /** Runs only when this optional module is on (Owner panel > Modules). */
  module?: ModuleId;
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
  /** The project's saved login (API key or Git token), decrypted for this run, for tools that use it. */
  login?: Login;
  /** Code tests: the project's files on disk (the clone, or the unpacked zip). */
  sourceDir?: string;
  /** API tests: the uploaded OpenAPI file on disk (else target.specUrl). */
  specFile?: string;
  /** Where uploaded files are kept (a tool's own upload, such as a Postman collection). */
  uploadsDir: string;
  options: Record<string, string>;
  /** Where the tool's own report files go (served with the run's evidence). */
  outDir: string;
  /** Scratch space, removed after the run. */
  workDir: string;
  signal: AbortSignal;
  log: (message: string) => void;
  /** For a permission tool: the limits of the client's permission it runs under. */
  permit?: { hosts: string[]; maxUsers: number; maxMinutes: number; writes: boolean };
  /** The owner's module switches. */
  modules?: Record<string, boolean>;
  /** Mobile apps: what the engine found the app is made of (its id, SDKs, servers). */
  app?: AppSummary;
  /** Mobile apps: the project's journeys for the test phone. */
  appJourneys?: AppJourney[];
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
export type ToolFinding = Omit<Finding, "id" | "agent"> & {
  sameAs?: string[];
  /**
   * Where the platform's finding must be: on the same site (the default), on the same page, in the
   * same file (code), or on the same API endpoint (sameText then holds its path, such as "/users/{id}").
   */
  sameScope?: "site" | "page" | "file" | "endpoint";
  /** Text the platform's finding must also hold, such as "lodash@4.17.15" or "line 12:". */
  sameText?: string;
  /**
   * Names the problem across tools, such as "pkg:lodash@4.17.15": when an earlier tool in the same
   * run reported the same key, this copy is folded into that finding.
   */
  key?: string;
};

/** A picture a tool took (Safari on an iPhone, an app screen), shown in the report. */
export interface ToolImage {
  /** File name in the run's artifacts folder. */
  file: string;
  label: string;
}

export interface ToolOutput {
  findings: ToolFinding[];
  images?: ToolImage[];
  /** Short result lines shown in the tool's section, e.g. "Performance 72". */
  summary?: string[];
  reports?: ToolReport[];
  /** What was tested, e.g. "Checked 12 pages". */
  tested?: string;
  /**
   * The pages this tool really looked at, when it checks only some of them (the first 20, the start
   * page). Its issues on other pages are then not called fixed just because it did not look there.
   */
  checked?: string[];
  /** A small table for the report, such as a load test's steps. */
  table?: ToolTable;
}

export interface ToolTable {
  title: string;
  columns: string[];
  rows: string[][];
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
  images?: ToolImage[];
  tested?: string;
  /** The pages it really looked at, when it checks only some (see ToolOutput.checked). */
  checked?: string[];
  /** Findings dropped because a platform check already reported the same problem. */
  merged?: number;
  table?: ToolTable;
  /** For a load or attack test: the client's permission it ran under. */
  permit?: { id: string; grantedBy: string; reference: string; recordedBy: string; until: string; hosts: string[] };
}
