import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Category, Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import { relPath } from "./source.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface OpengrepReport {
  results: {
    check_id: string;
    path: string;
    start: { line: number };
    extra: { message: string; severity: string; metadata?: Record<string, unknown>; lines?: string };
  }[];
  errors?: { level?: string; type?: unknown; message?: string; path?: string }[];
  paths?: { scanned?: string[] };
}

/** GLV's own rules (rules/opengrep in this repository), unless OPENGREP_RULES names another folder. */
export function rulesDir(): string {
  return process.env.OPENGREP_RULES || fileURLToPath(new URL("../../rules/opengrep", import.meta.url));
}

const SEVERITY: Record<string, Severity> = { ERROR: "high", WARNING: "medium", INFO: "low" };

/** The rule's own id: Opengrep puts the rules folder's path in front of it ("app.rules.opengrep.glv.js.eval"). */
export const ruleId = (checkId: string) => checkId.match(/(?:^|\.)(glv\.[\w.-]+)$/)?.[1] ?? checkId;

/**
 * Turns Opengrep's JSON into findings: one per rule and file, with the first line and how many
 * more. A rule that names the platform's own check (glv-same-as) is folded into it when the
 * platform found the same thing in the same file.
 */
export function readOpengrep(report: OpengrepReport, sourceDir: string, lineOf: (file: string, line: number) => string): ToolFinding[] {
  const groups = new Map<string, { r: OpengrepReport["results"][number]; file: string; lines: number[] }>();
  for (const r of report.results) {
    const file = relPath(sourceDir, r.path);
    const k = `${ruleId(r.check_id)}|${file}`;
    const g = groups.get(k);
    if (g) g.lines.push(r.start.line);
    else groups.set(k, { r, file, lines: [r.start.line] });
  }
  const out: ToolFinding[] = [];
  for (const { r, file, lines } of groups.values()) {
    const id = ruleId(r.check_id);
    const meta = r.extra.metadata ?? {};
    const same = typeof meta["glv-same-as"] === "string" ? (meta["glv-same-as"] as string) : undefined;
    const first = Math.min(...lines);
    const message = r.extra.message.replace(/\s+/g, " ").trim();
    const code = lineOf(file, first).trim().slice(0, 160);
    out.push({
      category: (typeof meta["glv-category"] === "string" ? meta["glv-category"] : "security") as Category,
      severity: SEVERITY[r.extra.severity] ?? "medium",
      rule: `opengrep:${id}`,
      title: typeof meta["glv-title"] === "string" ? (meta["glv-title"] as string) : message.split(/\. /)[0],
      detail: `${file} line ${first}${lines.length > 1 ? ` (and ${lines.length - 1} more in this file)` : ""}. ${message}${
        typeof meta.cwe === "string" ? ` (${meta.cwe})` : ""
      }`,
      pageUrl: file,
      evidence: `line ${first}: ${code}`,
      count: lines.length,
      ...(same ? { sameAs: [same], sameScope: "file" as const } : {}),
    });
  }
  return out;
}

async function countRules(dir: string): Promise<number> {
  let n = 0;
  for (const f of await readdir(dir)) if (/\.ya?ml$/.test(f)) n += ((await readFile(path.join(dir, f), "utf8")).match(/^ {2}- id: /gm) ?? []).length;
  return n;
}

export const opengrepTool: Tool = {
  id: "opengrep",
  name: "Opengrep",
  maker: "Opengrep (open source), with GLV's own rules",
  description: "Reads the code's structure to find risky patterns: input reaching SQL, shell commands, file paths or HTML.",
  checks: [
    "Follows request data through the code to SQL, shell commands, file paths, redirects and HTML",
    "JavaScript, TypeScript, Python, PHP, Java, Go and C#",
    "GLV's own rule set, so it can be used for paid client work",
  ],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute for most projects",
  licence: "LGPL-2.1 (rules: GLV's own)",
  homepage: "https://github.com/opengrep/opengrep",
  signedIn: "public",

  async ready() {
    if (!(await which(process.env.OPENGREP_PATH || "opengrep"))) return "Opengrep is not installed on this server.";
    return existsSync(rulesDir()) ? null : `The rules folder ${rulesDir()} is missing.`;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const src = ctx.sourceDir;
    if (!src) throw new Error("The code was not on disk for the tools.");
    const bin = process.env.OPENGREP_PATH || "opengrep";
    const out = path.join(ctx.workDir, "opengrep.json");
    // Semgrep CE (same rules and output) can stand in for Opengrep: it needs its telemetry switched off.
    const semgrep = /semgrep$/.test(path.basename(bin)) ? ["--metrics=off", "--disable-version-check"] : [];
    const res = await runProcess(
      bin,
      ["scan", "--config", rulesDir(), "--json", "--output", out, "--quiet", "--timeout", "30", "--max-target-bytes", "1000000", ...semgrep, "."],
      { signal: ctx.signal, timeoutMs: 900_000, cwd: src, env: { ...process.env, SEMGREP_SEND_METRICS: "off" } },
    );
    if (!existsSync(out)) throw new Error(`Opengrep stopped: ${lastLine(res.stderr) || `exit code ${res.code}`}`);
    const report = JSON.parse(await readFile(out, "utf8")) as OpengrepReport;
    const lines = new Map<string, string[]>();
    const lineOf = (file: string, n: number) => {
      if (!lines.has(file)) {
        try {
          lines.set(file, readFileSync(path.join(src, file), "utf8").split("\n"));
        } catch {
          lines.set(file, []);
        }
      }
      return lines.get(file)![n - 1] ?? "";
    };
    const findings = readOpengrep(report, src, lineOf);
    const ruleErrors = (report.errors ?? []).filter((e) => /rule|config/i.test(JSON.stringify(e.type ?? "")));
    const scanned = report.paths?.scanned?.length ?? 0;
    const slim = report.results.map((r) => ({ rule: ruleId(r.check_id), path: relPath(src, r.path), line: r.start.line, severity: r.extra.severity, message: r.extra.message }));
    await writeFile(path.join(ctx.outDir, "tool-opengrep.json"), JSON.stringify(slim, null, 1));
    return {
      findings,
      summary: [
        `${report.results.length} risky place${report.results.length === 1 ? "" : "s"} in ${new Set(slim.map((s) => s.path)).size} file${slim.length === 1 ? "" : "s"}`,
        `${await countRules(rulesDir())} GLV rules on ${scanned.toLocaleString("en-IN")} files (tests and installed packages are skipped)`,
        ...(ruleErrors.length ? [`${ruleErrors.length} rule${ruleErrors.length === 1 ? "" : "s"} could not load: ${lastLine(ruleErrors[0].message ?? "")}`] : []),
      ],
      reports: [{ file: "tool-opengrep.json", label: "Opengrep results (JSON)" }],
      tested: `Read ${scanned.toLocaleString("en-IN")} files`,
    };
  },
};
