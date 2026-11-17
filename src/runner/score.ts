import { groupFindings } from "../group.js";
import { CATEGORIES, type Category, type Finding, type Severity } from "../types.js";

const PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0,
};

/**
 * Scores each category from 0 to 100. Each distinct issue takes points off once, by severity,
 * scaled by how widespread it is: half the penalty for an issue on one page, the full penalty for
 * one on every page. So a shared header problem counts as one issue, not one per page.
 */
export function scoreFindings(
  findings: Finding[],
  pageCount: number,
  categories: Category[] = CATEGORIES,
): {
  scores: Partial<Record<Category, number>>;
  overallScore: number;
} {
  const pages = Math.max(1, pageCount);
  const penalty = Object.fromEntries(categories.map((c) => [c, 0])) as Record<Category, number>;
  for (const g of groupFindings(findings)) {
    if (!(g.first.category in penalty)) continue;
    const spread = Math.min(1, g.pages.length / pages);
    penalty[g.first.category] += PENALTY[g.severity] * (0.5 + 0.5 * spread);
  }
  const scores: Partial<Record<Category, number>> = {};
  for (const cat of categories) scores[cat] = Math.max(0, Math.round(100 - penalty[cat]));
  let overallScore = Math.round(categories.reduce((s, c) => s + (scores[c] ?? 100), 0) / categories.length);
  // A single critical issue (site down, no HTTPS, unusable for screen readers) caps the grade.
  if (findings.some((f) => f.severity === "critical")) overallScore = Math.min(overallScore, 69);
  return { scores, overallScore };
}
