import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { lastLine, runProcess, which } from "./process.js";
import { cvssSeverity, packageFinding, type PackageVuln } from "./packages.js";
import { relPath } from "./source.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface OsvReport {
  results?: {
    source: { path: string; type: string };
    packages: {
      package: { name: string; version: string; ecosystem: string };
      vulnerabilities?: {
        id: string;
        summary?: string;
        aliases?: string[];
        affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events: { introduced?: string; fixed?: string }[] }[] }[];
      }[];
      groups?: { ids: string[]; aliases?: string[]; max_severity?: string }[];
    }[];
  }[];
}

/** Turns OSV-Scanner's JSON into one finding per vulnerable package and lockfile. */
export function readOsv(report: OsvReport, sourceDir: string): { findings: ToolFinding[]; packages: number; files: string[] } {
  const findings: ToolFinding[] = [];
  let packages = 0;
  const files: string[] = [];
  for (const r of report.results ?? []) {
    const file = relPath(sourceDir, r.source.path);
    files.push(file);
    for (const p of r.packages) {
      packages++;
      if (!p.vulnerabilities?.length) continue;
      // OSV lists one hole under several ids (GHSA, PYSEC, CVE): its groups join them.
      const groups = p.groups?.length ? p.groups : p.vulnerabilities.map((v) => ({ ids: [v.id], aliases: v.aliases, max_severity: undefined }));
      const vulns: PackageVuln[] = groups.map((g) => {
        const all = p.vulnerabilities!.filter((v) => g.ids.includes(v.id));
        const ids = [...g.ids, ...(g.aliases ?? []), ...all.flatMap((v) => v.aliases ?? [])];
        const fixed = all.flatMap((v) =>
          (v.affected ?? [])
            .filter((a) => !a.package?.name || a.package.name.toLowerCase() === p.package.name.toLowerCase())
            .flatMap((a) => (a.ranges ?? []).flatMap((rg) => rg.events.map((e) => e.fixed).filter((f): f is string => Boolean(f)))),
        );
        const malware = g.ids.some((id) => id.startsWith("MAL-"));
        return {
          id: g.ids[0],
          cve: ids.find((i) => i.startsWith("CVE-")),
          summary: all.find((v) => v.summary)?.summary,
          severity: malware ? "critical" : cvssSeverity(g.max_severity ? Number(g.max_severity) : undefined),
          fixed: [...new Set(fixed)],
        };
      });
      findings.push(packageFinding(file, p.package.name, p.package.version, vulns, "OSV database"));
    }
  }
  return { findings, packages, files };
}

export const osvTool: Tool = {
  id: "osv-scanner",
  name: "OSV-Scanner",
  maker: "Google",
  description: "Checks every package the code uses against Google's open vulnerability database (OSV).",
  checks: [
    "More lockfile types than the platform's own check: npm, pnpm, yarn, pip, Poetry, Composer, Go, Cargo, Maven, Gradle, NuGet, Pub (Flutter), Gems",
    "Packages that are malware, not just buggy",
    "The version to upgrade to for each hole",
  ],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "Apache-2.0",
  homepage: "https://google.github.io/osv-scanner/",
  signedIn: "public",

  async ready() {
    return (await which(process.env.OSV_SCANNER_PATH || "osv-scanner")) ? null : "OSV-Scanner is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const src = ctx.sourceDir;
    if (!src) throw new Error("The code was not on disk for the tools.");
    const out = path.join(ctx.workDir, "osv.json");
    // OSV_SCANNER_OFFLINE=1 uses a downloaded copy of the database instead of asking osv.dev
    // about each package (the folder is OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY).
    const offline = process.env.OSV_SCANNER_OFFLINE === "1" ? ["--offline-vulnerabilities", "--download-offline-databases"] : [];
    const res = await runProcess(
      process.env.OSV_SCANNER_PATH || "osv-scanner",
      // Call analysis would build the code (Rust runs its build scripts): never on a client's code.
      ["scan", "source", "-r", "--format", "json", "--output-file", out, "--no-call-analysis=all", "--allow-no-lockfiles", "--verbosity", "error", ...offline, src],
      { signal: ctx.signal, timeoutMs: 600_000, cwd: ctx.workDir },
    );
    // 0: no holes, 1: holes found. Anything else is a failure.
    if ((res.code !== 0 && res.code !== 1) || !existsSync(out)) throw new Error(`OSV-Scanner stopped: ${lastLine(res.stderr) || `exit code ${res.code}`}`);
    const report = JSON.parse(await readFile(out, "utf8")) as OsvReport;
    const { findings, files } = readOsv(report, src);
    const slim = (report.results ?? []).map((r) => ({
      source: relPath(src, r.source.path),
      packages: r.packages.filter((p) => p.vulnerabilities?.length).map((p) => ({ ...p.package, vulnerabilities: p.vulnerabilities!.map((v) => v.id) })),
    }));
    await writeFile(path.join(ctx.outDir, "tool-osv-scanner.json"), JSON.stringify(slim, null, 1));
    return {
      findings,
      summary: files.length
        ? [`${findings.length} package${findings.length === 1 ? "" : "s"} with known holes`, `Lockfiles with holes: ${files.slice(0, 6).join(", ")}${files.length > 6 ? " and more" : ""}`]
        : ["No lockfile or package list found, so there was nothing to look up."],
      reports: [{ file: "tool-osv-scanner.json", label: "OSV-Scanner results (JSON)" }],
      tested: "Looked up every package in the lockfiles",
    };
  },
};
