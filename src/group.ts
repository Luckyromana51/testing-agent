import type { Finding, Severity } from "./types.js";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/**
 * Two findings are the same issue when they come from the same rule and their titles match once
 * numbers are ignored ("3 console errors" and "1 console error" are one issue).
 */
export function issueKey(f: Pick<Finding, "rule" | "title">): string {
  return `${f.rule}|${f.title.replace(/\d+(\.\d+)?/g, "#")}`;
}

export interface IssueGroup {
  key: string;
  /** The most severe finding in the group, used for its title and text. */
  first: Finding;
  severity: Severity;
  items: Finding[];
  /** Distinct pages the issue was found on. */
  pages: string[];
}

/** Groups findings into distinct issues, worst first, then by how many pages they affect. */
export function groupFindings(findings: Finding[]): IssueGroup[] {
  const groups = new Map<string, IssueGroup>();
  for (const f of findings) {
    const key = issueKey(f);
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { key, first: f, severity: f.severity, items: [f], pages: [f.pageUrl] });
      continue;
    }
    g.items.push(f);
    if (!g.pages.includes(f.pageUrl)) g.pages.push(f.pageUrl);
    if (SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(g.severity)) {
      g.severity = f.severity;
      g.first = f;
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.pages.length - a.pages.length,
  );
}
