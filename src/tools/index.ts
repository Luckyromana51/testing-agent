import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CONNECTION_TOOLS } from "../connections/tools.js";
import path from "node:path";
import { checkProof, hasPermission, permitFor, PERMISSION_KINDS, type Permission } from "../permission.js";
import { moduleOn, MODULES } from "../modules.js";
import { finding } from "../runner/finding.js";
import { scoreFindings } from "../runner/score.js";
import type { AgentStat, AppJourney, Category, Finding, Login, ProductType, ProjectTarget, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { byoTool } from "./byo.js";
import { gitleaksTool } from "./gitleaks.js";
import { jmeterTool } from "./jmeter.js";
import { k6Tool } from "./k6.js";
import { lighthouseTool } from "./lighthouse.js";
import { newmanTool } from "./newman.js";
import { opengrepTool } from "./opengrep.js";
import { osvTool } from "./osv.js";
import { probesTool } from "./probes.js";
import { schemathesisTool } from "./schemathesis.js";
import { sourceDirFor, specFileFor } from "./source.js";
import { trivyTool } from "./trivy.js";
import { nucleiTool } from "./nuclei.js";
import { testsslTool } from "./testssl.js";
import type { Tool, ToolChoice, ToolContext, ToolFinding, ToolInfo, ToolOutput, ToolStat } from "./types.js";
import { vnuTool } from "./vnu.js";
import { iosSimulatorTool, safariTool, voiceOverTool } from "./mac.js";
import { appiumTool } from "./appium.js";
import { zapActiveTool, zapTool } from "./zap.js";
import { attackTool } from "./attack/index.js";

export type { ToolChoice, ToolInfo, ToolStat } from "./types.js";

/** Every outside tool the platform can run, in the order of their tabs. Add new tools here. */
export const TOOLS: Tool[] = [
  // Websites and web apps
  lighthouseTool,
  vnuTool,
  zapTool,
  nucleiTool,
  testsslTool,
  // Optional module: the client's own Playwright tests.
  byoTool,
  // Only with the client's written permission: attacks, then load (GLV's probes first, so ZAP's
  // copies of the same holes fold into them). The attack agent runs the deeper, orchestrated pen test.
  probesTool,
  attackTool,
  zapActiveTool,
  k6Tool,
  jmeterTool,
  // APIs
  schemathesisTool,
  newmanTool,
  // Source code
  gitleaksTool,
  opengrepTool,
  osvTool,
  trivyTool,
  // On GLV's Mac helper: real Safari and VoiceOver for websites, the iOS Simulator for iOS apps.
  safariTool,
  voiceOverTool,
  iosSimulatorTool,
  // Mobile apps on a test phone (Appium).
  appiumTool,
  // Client connections (Connections tab): the client's server over SSH, their Hostinger account, their MCP server.
  ...CONNECTION_TOOLS,
];

export const toolById = (id: string) => TOOLS.find((t) => t.id === id);

export function toolsFor(product: ProductType): Tool[] {
  return TOOLS.filter((t) => t.products.includes(product));
}

/** What the dashboard shows of a tool (no functions). */
export function describeTool(t: Tool): ToolInfo {
  const { ready: _r, run: _run, ...info } = t;
  // Options can be worked out when asked (the test phones on this server), so read them now.
  return { ...info, ...(t.options ? { options: t.options } : {}) };
}

let cache: { at: number; status: Record<string, string | null> } | undefined;

/**
 * Which tools are installed on this server: null when ready, else why not. Checked once a minute;
 * tools on the Mac helper every time, since a Mac comes and goes.
 */
export async function toolStatus(fresh = false): Promise<Record<string, string | null>> {
  const check = async (t: Tool) => [t.id, await t.ready().catch((e: Error) => e.message)] as const;
  if (fresh || !cache || Date.now() - cache.at >= 60_000) {
    const entries = await Promise.all(TOOLS.filter((t) => !t.needsMac && !t.needsDevice).map(check));
    cache = { at: Date.now(), status: Object.fromEntries(entries) };
  }
  return { ...cache.status, ...Object.fromEntries(await Promise.all(TOOLS.filter((t) => t.needsMac || t.needsDevice).map(check))) };
}

/**
 * Checks the tools a tester chose: known, fitting the product, and with valid options. Tools that
 * load or attack a site need the client's written permission on the project (permissions), within
 * its limits; a new project has none yet.
 */
export function cleanChoices(product: ProductType, input: unknown, permissions?: Permission[]): ToolChoice[] {
  if (!Array.isArray(input)) throw new Error("tools must be a list.");
  const out: ToolChoice[] = [];
  for (const raw of input) {
    const c = (typeof raw === "string" ? { id: raw } : raw) as ToolChoice;
    const tool = c && typeof c.id === "string" ? toolById(c.id) : undefined;
    if (!tool) throw new Error(`Unknown tool: ${String(c?.id ?? raw)}.`);
    if (!tool.products.includes(product)) throw new Error(`${tool.name} does not test this kind of product.`);
    const permit = tool.safety === "permission" ? hasPermission(permissions, tool.permission ?? "attack") : undefined;
    if (tool.safety === "permission" && !permit) {
      const kind = PERMISSION_KINDS[tool.permission ?? "attack"].split(" (")[0].toLowerCase();
      throw new Error(
        permissions === undefined
          ? `${tool.name} needs the client's written permission for ${kind}. Create the project first, then the owner adds the permission on its page.`
          : `${tool.name} needs the client's written permission for ${kind}. The owner adds it on the project page.`,
      );
    }
    if (out.some((o) => o.id === tool.id)) continue;
    const options: Record<string, string> = {};
    for (const opt of tool.options ?? []) {
      const v = c.options?.[opt.id];
      if (opt.kind === "file") {
        // An upload's stored name (from POST /api/uploads), and the name the tester knows it by.
        const ext = (opt.accept ?? ".json").replace(/^\./, "");
        if (v && !(/^[a-z]+$/.test(ext) && new RegExp(`^[0-9a-f-]{36}\\.${ext}$`).test(v))) throw new Error(`${tool.name}: upload the ${opt.label} again.`);
        if (!v && opt.required) throw new Error(`${tool.name}: upload the ${opt.label} first, or turn ${tool.name} off.`);
        if (v) {
          options[opt.id] = v;
          const name = c.options?.[`${opt.id}:name`];
          if (typeof name === "string") options[`${opt.id}:name`] = name.replace(/[^\w. ()-]/g, "_").slice(0, 200);
        }
        continue;
      }
      if (v === undefined) continue;
      if (opt.kind === "toggles") {
        // A set of switched-on values, joined by commas; each must be one of the option's choices.
        const picked = v.split(",").map((s) => s.trim()).filter(Boolean);
        for (const p of picked) if (!opt.choices.some((ch) => ch.value === p)) throw new Error(`${tool.name}: "${p}" is not a choice for ${opt.label}.`);
        options[opt.id] = [...new Set(picked)].join(",");
        continue;
      }
      if (!opt.choices.some((ch) => ch.value === v)) throw new Error(`${tool.name}: "${v}" is not a choice for ${opt.label}.`);
      options[opt.id] = v;
    }
    if (permit && tool.limits) {
      const value = (id?: string) => Number(id ? (options[id] ?? tool.options?.find((o) => o.id === id)?.default) : NaN);
      if (value(tool.limits.users) > permit.maxUsers) throw new Error(`${tool.name}: the client allows at most ${permit.maxUsers} users at once.`);
      if (value(tool.limits.minutes) > permit.maxMinutes) throw new Error(`${tool.name}: the client allows tests of at most ${permit.maxMinutes} minutes.`);
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
    .filter((t) => t.safety === "safe" && !t.needsMac && !t.needsDevice && !t.needsConnection && status[t.id] === null && !(t.options ?? []).some((o) => o.required))
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
  /** The client's permissions for load and attack tests (the project's). */
  permissions?: Permission[];
  /** The owner's module switches (Owner panel > Modules). */
  modules?: Record<string, boolean>;
  /** Mobile apps: the project's journeys for the test phone. */
  appJourneys?: AppJourney[];
  /** The project's client connections, decrypted for this run only (connection tools use them). */
  connections?: import("../connections/types.js").ResolvedConnection[];
  dataDir?: string;
}

/** Load and attack tests run one at a time on this server, so two never compete for it (or for the client's site). */
let heavyTurn: Promise<unknown> = Promise.resolve();

/**
 * The permission a load or attack tool runs under, checked again just before it starts: still
 * active, covering the pages it would use, and with the client's proof still on each host.
 */
async function permitForTool(tool: Tool, startUrl: string, urls: string[], input: ToolRunInput): Promise<{ ctx: NonNullable<ToolContext["permit"]>; stat: NonNullable<ToolStat["permit"]>; startUrl: string; urls: string[] } | string> {
  const permit = permitFor(input.permissions, tool.permission ?? "attack", [startUrl, ...urls]);
  if (typeof permit === "string") return permit;
  const p = permit.permission;
  const used = [...new Set(permit.urls.map((u) => new URL(u).host.toLowerCase()))];
  const checks = await Promise.all(used.map((h) => checkProof(h, p.token, input.signal)));
  const gone = checks.find((c) => !c.ok);
  if (gone) return `The client's proof is no longer on ${gone.host}, so the test did not run (${gone.error}).`;
  if (permit.outside.length) input.log(`${tool.name}: leaving out ${permit.outside.join(", ")}, which the permission does not cover`);
  const allowedStart = permit.urls.includes(startUrl) ? startUrl : permit.urls[0];
  return {
    ctx: { hosts: p.hosts, maxUsers: p.maxUsers, maxMinutes: p.maxMinutes, writes: p.writes },
    stat: { id: p.id, grantedBy: p.grantedBy, reference: p.reference, recordedBy: p.createdBy, until: p.until, hosts: p.hosts },
    startUrl: allowedStart,
    urls: permit.urls.filter((u) => u !== allowedStart),
  };
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
    if (scope === "page") return o.pageUrl === f.pageUrl && (!f.sameText || `${o.title}\n${o.evidence ?? ""}`.includes(f.sameText));
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
    const mod = tool.module ? MODULES.find((m) => m.id === tool.module) : undefined;
    const why = mod && !moduleOn(input.modules, mod.id) ? `Turn on "${mod.name}" in Owner panel > Modules to run it.` : await tool.ready().catch((e: Error) => e.message);
    if (why) untested = why;
    else {
      const options = Object.fromEntries((tool.options ?? []).map((o) => [o.id, choice.options?.[o.id] ?? o.default]));
      const notes: string[] = [];
      let place = { startUrl, urls };
      let permit: Awaited<ReturnType<typeof permitForTool>> | undefined;
      if (tool.safety === "permission") {
        permit = await permitForTool(tool, startUrl, urls, input);
        if (typeof permit === "string") untested = permit;
        else {
          place = { startUrl: permit.startUrl, urls: permit.urls };
          stat.permit = permit.stat;
          // A permission narrowed since the tool was chosen: run within it, and say so.
          for (const [id, max, unit] of [[tool.limits?.users, permit.ctx.maxUsers, "users"], [tool.limits?.minutes, permit.ctx.maxMinutes, "minutes"]] as const) {
            if (id && Number(options[id]) > max) {
              options[id] = String(max);
              notes.push(`Limited to ${max} ${unit} by the client's permission`);
            }
          }
        }
      }
      if (!untested) {
        log(`Tool: ${tool.name}`);
        const go = () => {
          signal.throwIfAborted();
          return tool.run({
            product: input.product,
            target,
            startUrl: place.startUrl,
            urls: place.urls,
            ...(input.cookie && tool.signedIn === "uses-login" ? { cookie: input.cookie } : {}),
            ...(input.login && tool.signedIn === "uses-login" ? { login: input.login } : {}),
            ...(sourceDir ? { sourceDir } : {}),
            ...(specFile ? { specFile } : {}),
            ...(permit && typeof permit !== "string" ? { permit: permit.ctx } : {}),
            uploadsDir: input.uploadsDir,
            ...(input.modules ? { modules: input.modules } : {}),
            ...(result.app ? { app: result.app } : {}),
            ...(input.appJourneys ? { appJourneys: input.appJourneys } : {}),
            ...(tool.needsConnection && input.connections ? { connections: input.connections, dataDir: input.dataDir } : {}),
            options,
            outDir: input.artifactsDir,
            workDir: input.workDir,
            signal,
            log,
          });
        };
        try {
          if (tool.safety === "permission") {
            const mine = heavyTurn.then(go);
            heavyTurn = mine.catch(() => {});
            out = await mine;
          } else out = await go();
          if (out && notes.length) out = { ...out, summary: [...notes, ...(out.summary ?? [])] };
        } catch (err) {
          if (signal.aborted) throw signal.reason;
          untested = (err as Error).message.split("\n")[0].slice(0, 400);
        }
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
        ...(out.images?.length ? { images: out.images } : {}),
        ...(out.tested ? { tested: out.tested } : {}),
        ...(out.checked ? { checked: out.checked } : {}),
        ...(out.table ? { table: out.table } : {}),
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

  // The categories the engine scored stay the same (no search checks for a CRM, for example), plus
  // those of tools that bring their own (Apple's accessibility audit for an iOS app).
  const ownCategories = input.choices.map((c) => toolById(c.id)).filter((t): t is Tool => Boolean(t?.ownCategory)).map((t) => t.category);
  const categories = [...new Set([...Object.keys(result.scores), ...Object.keys(result.notTested ?? {}), ...ownCategories])] as Category[];
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
