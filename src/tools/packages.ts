import { compareVersions } from "../agents/code/packages.js";
import type { Severity } from "../types.js";
import type { ToolFinding } from "./types.js";

/** One published hole in one package version, as a package tool reports it. */
export interface PackageVuln {
  id: string;
  /** The CVE name when there is one (people search for CVE-2021-23337, not GHSA-35jh-r3h4-6jhm). */
  cve?: string;
  summary?: string;
  severity: Severity;
  /** Versions that fix it, as the database lists them. */
  fixed: string[];
}

const RANK: Severity[] = ["info", "low", "medium", "high", "critical"];
export const worst = (a: Severity, b: Severity): Severity => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

/** CVSS score to severity, as the CVSS scale names them. */
export function cvssSeverity(score: number | undefined): Severity {
  if (score === undefined || Number.isNaN(score)) return "medium";
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low";
}

/**
 * The lowest version that fixes every hole listed: for each hole, the first fixed version above
 * the one in use (on the same major version when the database has one there), then the highest
 * of those.
 */
export function upgradeTarget(version: string, vulns: PackageVuln[]): string | undefined {
  const major = version.replace(/^v/, "").split(".")[0];
  const picks: string[] = [];
  for (const v of vulns) {
    const above = v.fixed.filter((f) => compareVersions(f, version) > 0).sort(compareVersions);
    const pick = above.find((f) => f.replace(/^v/, "").split(".")[0] === major) ?? above[0];
    if (pick) picks.push(pick);
  }
  return picks.sort(compareVersions).pop();
}

/**
 * One finding per package and file, with the worst severity of its holes. The key lets a second
 * tool's copy of the same package fold into the first; sameAs folds it into the platform's own.
 */
export function packageFinding(file: string, name: string, version: string, vulns: PackageVuln[], how: string): ToolFinding {
  const severity = vulns.map((v) => v.severity).reduce(worst, "low" as Severity);
  const target = upgradeTarget(version, vulns);
  const names = [...new Set(vulns.map((v) => v.cve ?? v.id))];
  const listed = vulns
    .slice()
    .sort((a, b) => RANK.indexOf(b.severity) - RANK.indexOf(a.severity))
    .filter((v, i, all) => all.findIndex((o) => (o.cve ?? o.id) === (v.cve ?? v.id)) === i)
    .slice(0, 4)
    .map((v) => `${v.cve ?? v.id}${v.summary ? ` (${v.summary.replace(/\.$/, "").slice(0, 120)})` : ""}`)
    .join("; ");
  return {
    category: "security",
    severity,
    rule: "pkg:vulnerable",
    title: `Package with known security holes: ${name}`,
    detail: `${name} ${version} in ${file} has ${names.length} published vulnerabilit${names.length === 1 ? "y" : "ies"}: ${listed}${
      names.length > 4 ? "; and more" : ""
    }. ${target ? `Upgrade to ${target} or newer.` : "No fixed version is listed yet: upgrade to the latest version, or replace the package."} (${how})`,
    pageUrl: file,
    evidence: `${name}@${version}: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ", ..." : ""}`,
    sameAs: ["code:vulnerable-package"],
    sameScope: "file",
    sameText: `${name}@${version.replace(/^v(?=\d)/, "")}`,
    key: `pkg:${file}:${name.toLowerCase()}@${version.replace(/^v(?=\d)/, "")}`,
  };
}
