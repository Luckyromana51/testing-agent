import type { Finding, Severity } from "./types.js";

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

/** Numbers with their unit ("6.7 s", "20,480 ms", "25 KiB", "0.18"), which change from run to run. */
const MEASURE = /\d[\d,]*(\.\d+)?\s*(ms|s|kib|kb|mib|mb|gb|%)?(?![a-z])/gi;
const BE = /\b(is|are|was|were)\b/g;

/** "places" -> "place", "boxes" -> "box", "items are" -> "item": one problem counted 1 or 8 times reads the same. */
const singular = (w: string) =>
  w.length < 4 || w.endsWith("ss") || !w.endsWith("s") ? w : /(x|ch|sh|ss)es$/.test(w) ? w.slice(0, -2) : w.slice(0, -1);

/**
 * Two findings are the same issue when they come from the same rule and their titles match once
 * numbers, units, plurals and "is/are" are ignored: "1 focused item is hidden" and "8 focused items
 * are hidden" are one issue, and so are "takes 6.7 s" and "takes 4.8 s". Measured numbers change
 * from run to run on an unchanged site, so they must never make a new issue.
 */
export function issueKey(f: Pick<Finding, "rule" | "title">): string {
  const words = f.title
    .toLowerCase()
    .replace(MEASURE, "#")
    .replace(BE, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/^([^a-z#]*)([a-z]+)([^a-z]*)$/, (_m, a: string, b: string, c: string) => a + singular(b) + c));
  return `${f.rule}|${words.join(" ")}`;
}

/** The key the platform used before numbers' units and plurals were ignored, to match older issues. */
export function oldIssueKey(f: Pick<Finding, "rule" | "title">): string {
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
