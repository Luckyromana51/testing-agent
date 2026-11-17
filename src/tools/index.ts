import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { finding } from "../runner/finding.js";
import { scoreFindings } from "../runner/score.js";
import type { AgentStat, Category, Finding, Login, ProductType, ProjectTarget, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { gitleaksTool } from "./gitleaks.js";
import { lighthouseTool } from "./lighthouse.js";
import { newmanTool } from "./newman.js";
import { opengrepTool } from "./opengrep.js";
import { osvTool } from "./osv.js";
import { schemathesisTool } from "./schemathesis.js";
import { sourceDirFor, specFileFor } from "./source.js";
import { trivyTool } from "./trivy.js";
import { nucleiTool } from "./nuclei.js";
import { testsslTool } from "./testssl.js";
import type { Tool, ToolChoice, ToolFinding, ToolInfo, ToolOutput, ToolStat } from "./types.js";
import { vnuTool } from "./vnu.js";
import { zapTool } from "./zap.js";

export type { ToolChoice, ToolInfo, ToolStat } from "./types.js";

/** Every outside tool the platform can run, in the order of their tabs. Add new tools here. */
export const TOOLS: Tool[] = [
  // Websites and web apps
  lighthouseTool,
  vnuTool,
  zapTool,
  nucleiTool,
  testsslTool,
  // APIs
  schemathesisTool,
  newmanTool,
  // Source code
  gitleaksTool,
  opengrepTool,
  osvTool,
  trivyTool,
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);

export function toolsFor(product: ProductType): Tool[] {
  return TOOLS.filter((t) => t.products.includes(product));
}

/** What the dashboard shows of a tool (no functions). */
export function describeTool(t: Tool): ToolInfo {
  const { ready: _r, run: _run, ...info } = t;
  return info;
}

let cache: { at: number; status: Record<string, string | null> } | undefined;

/** Which tools are installed on this server: null when ready, else why not. Checked once a minute. */
export async function toolStatus(fresh = false): Promise<Record<string, string | null>> {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.status;
  const entries = await Promise.all(TOOLS.map(async (t) => [t.id, await t.ready().catch((e: Error) => e.message)] as const));
  cache = { at: Date.now(), status: Object.fromEntries(entries) };
  return cache.status;
}

/**
 * Checks the tools a tester chose: known, fitting the product, and with valid options. Tools that
 * need permission are refused until the permission step exists (phase 3).
 */
export function cleanChoices(product: ProductType, input: unknown): ToolChoice[] {
  if (!Array.isArray(input)) throw new Error("tools must be a list.");
  const out: ToolChoice[] = [];
  for (const raw of input) {
    const c = (typeof raw === "string" ? { id: raw } : raw) as ToolChoice;
    const tool = c && typeof c.id === "string" ? toolById(c.id) : undefined;
    if (!tool) throw new Error(`Unknown tool: ${String(c?.id ?? raw)}.`);
    if (!tool.products.includes(product)) throw new Error(`${tool.name} does not test this kind of product.`);
    if (tool.safety !== "safe") throw new Error(`${tool.name} needs the client's permission, which is not available yet.`);
    if (out.some((o) => o.id === tool.id)) continue;
    const options: Record<string, string> = {};
    for (const opt of tool.options ?? []) {
      const v = c.options?.[opt.id];
      if (opt.kind === "file") {
        // An upload's stored name (from POST /api/uploads), and the name the tester knows it by.
        if (v && !/^[0-9a-f-]{36}\.json$/.test(v)) throw new Error(`${tool.name}: upload the ${opt.label} again.`);
        if (!v && opt.required) throw new Error(`${tool.name}: upload the ${opt.label} first, or turn ${tool.name} off.`);
        if (v) {
          options[opt.id] = v;
          const name = c.options?.[`${opt.id}:name`];
          if (typeof name === "string") options[`${opt.id}:name`] = name.replace(/[^\w. ()-]/g, "_").slice(0, 200);
        }
        continue;
      }
      if (v === undefined) continue;
      if (!opt.choices.some((ch) => ch.value === v)) throw new Error(`${tool.name}: "${v}" is not a choice for ${opt.label}.`);
      options[opt.id] = v;
    }
    out.push({ id: tool.id, ...(Object.keys(options).length ? { options } : {}) });
  }
  return out;
}

/**
 * The tools a test runs when the tester did not choose: every safe tool for the product that is
 * installed. DEFAULT_TOOLS=none in .env turns this off (the tool tabs still work).
 */
export async function defaultChoices(product: ProductType): Promise<ToolChoice[]> {
  if (process.env.DEFAULT_TOOLS === "none") return [];
  const status = await toolStatus();
  return toolsFor(product)
    .filter((t) => t.safety === "safe" && status[t.id] === null && !(t.options ?? []).some((o) => o.required))
    .map((t) => ({ id: t.id }));
}

export interface ToolRunInput {
  product: ProductType;
  target: ProjectTarget;
  choices: ToolChoice[];
  /** Cookie header of the signed-in session, when the test signed in. */
  cookie?: string;
  /** The project's saved login, for tools that use it (API keys for Schemathesis, a Git token for history). */
  login?: Login;
  /** Secrets to hide from every tool's findings and reports. */
  secrets: string[];
  artifactsDir: string;
  uploadsDir: string;
  workDir: string;
  signal: AbortSignal;
  log: (message: string) => void;
  /** The command line's local folder of code, or its local OpenAPI file, instead of the project's. */
  sourceDir?: string;
  specFile?: string;
}

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};
const pathOf = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};
/** Case and a "v" before a version do not matter: "Django@v3.2.0" is "django@3.2.0". */
const norm = (s: string) => s.toLowerCase().replace(/@v(?=\d)/g, "@");
/** "/users/{id}" matches the end of "/v1/users/1". */
const endpointRe = (template: string) =>
  new RegExp(`${template.split(/\{[^}]+\}/).map((p) => p.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("[^/]+")}/?$`);

/**
 * Folds a tool's finding into a finding already in the report for the same problem: the
 * platform's own (a missing header ZAP also reports on every page, a leaked key Gitleaks also
 * found), or an earlier tool's (the same vulnerable package from Trivy and OSV-Scanner). Without
 * this, one problem would be counted as two issues. Returns true when it was folded.
 */
function fold(f: ToolFinding, own: Finding[], byKey: Map<string, Finding>, toolName: string): boolean {
  const scope = f.sameScope ?? "site";
  const where = (o: Finding) => {
    if (scope === "file") return o.pageUrl === f.pageUrl && (!f.sameText || norm(`${o.title}\n${o.evidence ?? ""}`).includes(norm(f.sameText)));
    if (host(o.pageUrl) !== host(f.pageUrl)) return false;
    if (scope === "endpoint") return Boolean(f.sameText) && endpointRe(f.sameText!).test(pathOf(o.pageUrl));
    return !f.sameText || `${o.title}\n${o.evidence ?? ""}`.includes(f.sameText);
  };
  const match = (f.sameAs?.length ? own.find((o) => f.sameAs!.includes(o.rule) && where(o)) : undefined) ?? (f.key ? byKey.get(f.key) : undefined);
  if (!match) return false;
  const note = ` Also found by ${toolName}.`;
  if (!match.detail.includes(note)) match.detail += note;
  return true;
}

/** Hides secrets in a report file a tool wrote (Lighthouse copies request headers into its report). */
async function scrub(file: string, secrets: string[]): Promise<void> {
  if (!secrets.length) return;
  let text = await readFile(file, "utf8");
  for (const s of secrets) {
    for (const form of new Set([s, JSON.stringify(s).slice(1, -1), encodeURIComponent(s)])) text = text.split(form).join("[hidden]");
  }
  await writeFile(file, text);
}

/** The addresses tools work on: the pages the crawl opened, or the API's base address and endpoints. */
function startOf(result: ScanResult, product: ProductType, target: ProjectTarget): string {
  if (product === "api") {
    const base = target.url || result.pages[0]?.url || result.startUrl;
    try {
      return new URL(base).origin + "/";
    } catch {
      return base;
    }
  }
  return result.pages[0]?.url ?? result.startUrl;
}

/**
 * Runs the chosen tools one after another on what the engine just tested, and merges their
 * findings into the result: one report, one score. A tool that cannot run makes the run
 * incomplete (it is never counted as passed).
 */
export async function runTools(result: ScanResult, input: ToolRunInput): Promise<ScanResult> {
  const { signal, log } = input;
  // An API project without its own base address uses the one the engine took from the API file.
  const apiBase = result.scanned?.[1];
  const target =
    input.product === "api" && !input.target.url && apiBase && /^https?:\/\//.test(apiBase) ? { ...input.target, url: apiBase } : input.target;
  const startUrl = startOf(result, input.product, target);
  const urls = result.pages.map((p) => p.url).filter((u) => /^https?:/.test(u));
  const own = result.findings;
  const added: Finding[] = [];
  const byKey = new Map<string, Finding>();
  const stats: AgentStat[] = [];
  const tools: ToolStat[] = [];
  const secrets = input.secrets.filter((s) => s.length >= 6);
  // Code tools read the project's files from disk: the clone, or the uploaded zip unpacked once.
  const sourceDir =
    input.sourceDir ?? (input.choices.length ? await sourceDirFor(input.product, input.target, input.uploadsDir, input.workDir).catch(() => undefined) : undefined);
  const specFile = input.specFile ?? specFileFor(input.product, input.target, input.uploadsDir);
  // Tools write their own reports next to the run's screenshots; code and API runs have none yet.
  if (input.choices.length) await mkdir(input.artifactsDir, { recursive: true });

  for (const choice of input.choices) {
    const tool = toolById(choice.id);
    if (!tool) continue;
    signal.throwIfAborted();
    const started = Date.now();
    const stat: ToolStat = { id: tool.id, name: tool.name, status: "done", ms: 0, findings: 0 };
    let untested: string | undefined;
    let out: ToolOutput | undefined;
    const why = await tool.ready().catch((e: Error) => e.message);
    if (why) untested = why;
    else {
      log(`Tool: ${tool.name}`);
      const options = Object.fromEntries((tool.options ?? []).map((o) => [o.id, choice.options?.[o.id] ?? o.default]));
      try {
        out = await tool.run({
          product: input.product,
          target,
          startUrl,
          urls,
          ...(input.cookie && tool.signedIn === "uses-login" ? { cookie: input.cookie } : {}),
          ...(input.login && tool.signedIn === "uses-login" ? { login: input.login } : {}),
          ...(sourceDir ? { sourceDir } : {}),
          ...(specFile ? { specFile } : {}),
          uploadsDir: input.uploadsDir,
          options,
          outDir: input.artifactsDir,
          workDir: input.workDir,
          signal,
          log,
        });
      } catch (err) {
        if (signal.aborted) throw signal.reason;
        untested = (err as Error).message.split("\n")[0].slice(0, 400);
      }
    }
    stat.ms = Date.now() - started;
    if (out) {
      out = redact(out, secrets);
      for (const r of out.reports ?? []) await scrub(path.join(input.artifactsDir, r.file), secrets).catch(() => {});
      let merged = 0;
      for (const f of out.findings) {
        if (fold(f, own, byKey, tool.name)) {
          merged++;
          continue;
        }
        const { sameAs: _s, sameScope: _sc, sameText: _t, key, ...rest } = f;
        const made = finding({ ...rest, agent: `tool.${tool.id}` });
        added.push(made);
        if (key) byKey.set(key, made);
      }
      Object.assign(stat, {
        findings: out.findings.length - merged,
        ...(merged ? { merged } : {}),
        ...(out.summary?.length ? { summary: out.summary } : {}),
        ...(out.reports?.length ? { reports: out.reports } : {}),
        ...(out.tested ? { tested: out.tested } : {}),
      });
      log(`${tool.name}: ${stat.findings} findings${merged ? `, ${merged} already found by the platform's checks` : ""}`);
    } else {
      stat.status = "untested";
      stat.untested = untested;
      log(`${tool.name} could not run: ${untested}`);
    }
    tools.push(stat);
    stats.push({
      id: `tool.${tool.id}`,
      name: tool.name,
      category: tool.category,
      findings: stat.findings,
      ms: stat.ms,
      errors: untested ? 1 : 0,
      runs: 1,
      ...(untested ? { untested } : {}),
    });
  }

  // The categories the engine scored stay the same (no search checks for a CRM, for example).
  const categories = [...new Set([...Object.keys(result.scores), ...Object.keys(result.notTested ?? {})])] as Category[];
  const findings = [...own, ...added.filter((f) => categories.includes(f.category))];
  const agentStats = [...(result.agentStats ?? []), ...stats];
  const { notTested, incomplete, ...score } = scoreFindings(findings, result.pages.length, categories, agentStats);
  const { notTested: _n, incomplete: _i, ...rest } = result;
  return {
    ...rest,
    findings,
    ...score,
    ...(notTested ? { notTested } : {}),
    ...(incomplete ? { incomplete } : {}),
    agentStats,
    tools,
    finishedAt: new Date().toISOString(),
  };
}
