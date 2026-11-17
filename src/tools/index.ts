import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { finding } from "../runner/finding.js";
import { scoreFindings } from "../runner/score.js";
import type { AgentStat, Category, Finding, ProductType, ProjectTarget, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { lighthouseTool } from "./lighthouse.js";
import { nucleiTool } from "./nuclei.js";
import { testsslTool } from "./testssl.js";
import type { Tool, ToolChoice, ToolFinding, ToolInfo, ToolOutput, ToolStat } from "./types.js";
import { vnuTool } from "./vnu.js";
import { zapTool } from "./zap.js";

export type { ToolChoice, ToolInfo, ToolStat } from "./types.js";

/** Every outside tool the platform can run, in the order of their tabs. Add new tools here. */
export const TOOLS: Tool[] = [lighthouseTool, vnuTool, zapTool, nucleiTool, testsslTool];

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
    .filter((t) => t.safety === "safe" && status[t.id] === null)
    .map((t) => ({ id: t.id }));
}

export interface ToolRunInput {
  product: ProductType;
  target: ProjectTarget;
  choices: ToolChoice[];
  /** Cookie header of the signed-in session, when the test signed in. */
  cookie?: string;
  /** Secrets to hide from every tool's findings and reports. */
  secrets: string[];
  artifactsDir: string;
  workDir: string;
  signal: AbortSignal;
  log: (message: string) => void;
}

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};
/**
 * Folds a tool's finding into the platform's own finding for the same problem on the same site,
 * when there is one. The platform reports a site-wide problem (a missing header) once, while ZAP
 * reports it on every page: without this, one problem would be counted as two issues.
 */
function fold(f: ToolFinding, own: Finding[], toolName: string): boolean {
  if (!f.sameAs?.length) return false;
  const match = own.find((o) => f.sameAs!.includes(o.rule) && host(o.pageUrl) === host(f.pageUrl));
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
    const base = target.url ?? result.pages[0]?.url ?? result.startUrl;
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
  const startUrl = startOf(result, input.product, input.target);
  const urls = result.pages.map((p) => p.url).filter((u) => /^https?:/.test(u));
  const own = result.findings;
  const added: Finding[] = [];
  const stats: AgentStat[] = [];
  const tools: ToolStat[] = [];
  const secrets = input.secrets.filter((s) => s.length >= 6);

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
          target: input.target,
          startUrl,
          urls,
          ...(input.cookie && tool.signedIn === "uses-login" ? { cookie: input.cookie } : {}),
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
        if (fold(f, own, tool.name)) {
          merged++;
          continue;
        }
        const { sameAs: _s, ...rest } = f;
        added.push(finding({ ...rest, agent: `tool.${tool.id}` }));
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
