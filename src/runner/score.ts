import { CATEGORIES, type Category, type Finding, type Severity } from "../types.js";

const PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0,
};

/**
 * Scores each category from 0 to 100. Every finding takes points off by severity;
 * the penalty is averaged per page so a big site is not punished just for being big.
 */
export function scoreFindings(
  findings: Finding[],
  pageCount: number,
): {
  scores: Record<Category, number>;
  overallScore: number;
} {
  const pages = Math.max(1, pageCount);
  const scores = {} as Record<Category, number>;
  for (const cat of CATEGORIES) {
    const penalty = findings
      .filter((f) => f.category === cat)
      .reduce((sum, f) => sum + PENALTY[f.severity], 0);
    // Site-wide findings (security headers) repeat on every page, so average them out.
    scores[cat] = Math.max(0, Math.round(100 - penalty / Math.sqrt(pages)));
  }
  let overallScore = Math.round(CATEGORIES.reduce((s, c) => s + scores[c], 0) / CATEGORIES.length);
  // A single critical issue (site down, no HTTPS, unusable for screen readers) caps the grade.
  if (findings.some((f) => f.severity === "critical")) overallScore = Math.min(overallScore, 69);
  return { scores, overallScore };
}
