import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import { packageFinding, type PackageVuln } from "./packages.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface TrivyReport {
  Results?: {
    Target: string;
    Class: string;
    Type?: string;
    Vulnerabilities?: { VulnerabilityID: string; PkgName: string; InstalledVersion: string; FixedVersion?: string; Severity: string; Title?: string }[];
    Misconfigurations?: {
      ID: string;
      Title: string;
      Description?: string;
      Message?: string;
      Resolution?: string;
      Severity: string;
      Status: string;
      CauseMetadata?: { StartLine?: number };
    }[];
    Licenses?: { Severity: string; Category: string; PkgName: string; FilePath?: string; Name: string }[];
  }[];
}

const SEVERITY: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low", UNKNOWN: "medium" };

/**
 * Trivy rates settings for strict hardening audits, so most of them count one step lower here
 * (a missing CPU limit is a note, not a problem). These keep Trivy's level: they hand an
 * attacker the server or the data.
 */
const SERIOUS = new Set([
  "KSV-0017", // privileged container
  "KSV-0008", // host IPC
  "KSV-0009", // host network
  "KSV-0010", // host PID
  "KSV-0023", // host folder mounted
  "KSV-0121", // dangerous host folders
  "DS-0031", // secrets in build arguments or environment
]);
const LOWER: Record<string, Severity> = { CRITICAL: "high", HIGH: "medium", MEDIUM: "low", LOW: "info", UNKNOWN: "low" };

/**
 * Turns Trivy's report into findings: one per vulnerable package and file, one per failed
 * settings check and file, and one per package whose licence may not allow closed-source
 * client work (AGPL, GPL and similar).
 */
export function readTrivy(report: TrivyReport): { findings: ToolFinding[]; counts: { packages: number; settings: number; licences: number; files: number } } {
  const findings: ToolFinding[] = [];
  const counts = { packages: 0, settings: 0, licences: 0, files: 0 };
  for (const r of report.Results ?? []) {
    counts.files++;
    const file = r.Target;
    // Packages: group the holes by package.
    const byPkg = new Map<string, { name: string; version: string; vulns: PackageVuln[] }>();
    for (const v of r.Vulnerabilities ?? []) {
      const k = `${v.PkgName}@${v.InstalledVersion}`;
      const g = byPkg.get(k) ?? { name: v.PkgName, version: v.InstalledVersion, vulns: [] };
      g.vulns.push({
        id: v.VulnerabilityID,
        ...(v.VulnerabilityID.startsWith("CVE-") ? { cve: v.VulnerabilityID } : {}),
        summary: v.Title,
        severity: SEVERITY[v.Severity] ?? "medium",
        fixed: (v.FixedVersion ?? "").split(/,\s*/).filter(Boolean),
      });
      byPkg.set(k, g);
    }
    for (const g of byPkg.values()) {
      counts.packages++;
      findings.push(packageFinding(file, g.name, g.version, g.vulns, "Trivy database"));
    }
    // Settings files: Dockerfile, Kubernetes, Terraform, Compose, CloudFormation, Helm.
    const byCheck = new Map<string, { m: NonNullable<(typeof r.Misconfigurations)>[number]; lines: number[] }>();
    for (const m of r.Misconfigurations ?? []) {
      if (m.Status !== "FAIL") continue;
      const g = byCheck.get(m.ID) ?? { m, lines: [] };
      if (m.CauseMetadata?.StartLine) g.lines.push(m.CauseMetadata.StartLine);
      byCheck.set(m.ID, g);
    }
    for (const { m, lines } of byCheck.values()) {
      counts.settings++;
      findings.push({
        category: "security",
        severity: (SERIOUS.has(m.ID) || /^(AWS|AZU|GCP|GIT|DIG|OCI|CLOUDSTACK)-/.test(m.ID) ? SEVERITY : LOWER)[m.Severity] ?? "low",
        rule: `trivy:${m.ID}`,
        title: `${r.Type === "dockerfile" ? "Dockerfile" : r.Type === "kubernetes" ? "Kubernetes" : r.Type === "terraform" ? "Terraform" : "Settings"}: ${m.Title}`,
        detail: `${file}${lines.length ? ` line ${Math.min(...lines)}` : ""}: ${(m.Message || m.Description || m.Title).replace(/\.?$/, ".")}${m.Resolution ? ` Fix: ${m.Resolution.replace(/\.?$/, ".")}` : ""}`,
        pageUrl: file,
        evidence: `${m.ID}${lines.length ? `, line ${Math.min(...lines)}` : ""}`,
      });
    }
    // Licences: only the ones that may not allow closed-source delivery.
    for (const l of r.Licenses ?? []) {
      if (l.Category !== "forbidden" && l.Category !== "restricted") continue;
      counts.licences++;
      findings.push({
        category: "functional",
        severity: l.Category === "forbidden" ? "medium" : "low",
        rule: "trivy:licence",
        title: `Package licence may not allow closed-source delivery: ${l.PkgName} (${l.Name})`,
        detail: `${l.PkgName} in ${l.FilePath || file} uses the ${l.Name} licence${
          l.Category === "forbidden"
            ? ", which can require sharing the whole product's source code with its users (including users over the internet for AGPL)"
            : ", which has conditions when the product is shipped"
        }. Check it fits how this project is delivered to the client, or replace the package.`,
        pageUrl: l.FilePath || file,
        evidence: `${l.PkgName}: ${l.Name}`,
      });
    }
  }
  return { findings, counts };
}

export const trivyTool: Tool = {
  id: "trivy",
  name: "Trivy",
  maker: "Aqua Security",
  description: "Checks packages for known holes, and Dockerfiles, Kubernetes and Terraform files for unsafe settings.",
  checks: [
    "Known holes in packages (its own database, a second opinion next to OSV)",
    "Unsafe Dockerfile, Kubernetes, Helm, Terraform and Compose settings: running as root, privileged containers, open ports, no limits",
    "Package licences that may not allow closed-source client delivery (AGPL, GPL)",
  ],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute (the first run downloads its database)",
  licence: "Apache-2.0",
  homepage: "https://trivy.dev",
  signedIn: "public",
  options: [
    {
      id: "licences",
      label: "Licence check",
      choices: [
        { value: "on", label: "Flag AGPL, GPL and similar" },
        { value: "off", label: "Off" },
      ],
      default: "on",
    },
  ],

  async ready() {
    return (await which(process.env.TRIVY_PATH || "trivy")) ? null : "Trivy is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const src = ctx.sourceDir;
    if (!src) throw new Error("The code was not on disk for the tools.");
    const out = path.join(ctx.workDir, "trivy.json");
    // The database is kept between runs (TRIVY_CACHE_DIR), so it downloads once a day at most.
    const cache = process.env.TRIVY_CACHE_DIR || path.resolve(process.env.DATA_DIR || "data", "trivy-cache");
    await mkdir(cache, { recursive: true });
    // Secrets are Gitleaks' job. Trivy runs in the work folder, so the project's .trivyignore is not read.
    const scanners = ["vuln", "misconfig", ...(ctx.options.licences === "off" ? [] : ["license"])];
    const res = await runProcess(
      process.env.TRIVY_PATH || "trivy",
      [
        "fs",
        "--scanners",
        scanners.join(","),
        "--format",
        "json",
        "--output",
        out,
        "--cache-dir",
        cache,
        "--quiet",
        "--no-progress",
        "--timeout",
        "10m",
        ...(process.env.TRIVY_OFFLINE === "1" ? ["--skip-db-update", "--skip-check-update", "--offline-scan"] : []),
        src,
      ],
      { signal: ctx.signal, timeoutMs: 900_000, cwd: ctx.workDir },
    );
    if (res.code !== 0 || !existsSync(out)) {
      const why = lastLine(res.stderr);
      if (/db|download|registry|manifest/i.test(why)) throw new Error(`Trivy could not download its vulnerability database: ${why}`);
      throw new Error(`Trivy stopped: ${why || `exit code ${res.code}`}`);
    }
    const report = JSON.parse(await readFile(out, "utf8")) as TrivyReport;
    const { findings, counts } = readTrivy(report);
    const slim = (report.Results ?? []).map((r) => ({
      Target: r.Target,
      Type: r.Type,
      Vulnerabilities: r.Vulnerabilities?.map(({ VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity }) => ({ VulnerabilityID, PkgName, InstalledVersion, FixedVersion, Severity })),
      Misconfigurations: r.Misconfigurations?.map(({ ID, Title, Severity, Status }) => ({ ID, Title, Severity, Status })),
      Licenses: r.Licenses?.filter((l) => l.Category === "forbidden" || l.Category === "restricted"),
    }));
    await writeFile(path.join(ctx.outDir, "tool-trivy.json"), JSON.stringify(slim, null, 1));
    return {
      findings,
      summary: [
        `${counts.packages} package${counts.packages === 1 ? "" : "s"} with known holes`,
        `${counts.settings} unsafe setting${counts.settings === 1 ? "" : "s"} in Dockerfiles, Kubernetes or Terraform files`,
        ...(scanners.includes("license") ? [`${counts.licences} package licence${counts.licences === 1 ? "" : "s"} to check`] : []),
      ],
      reports: [{ file: "tool-trivy.json", label: "Trivy results (JSON)" }],
      tested: `Checked ${counts.files} file${counts.files === 1 ? "" : "s"} with packages or settings`,
    };
  },
};
