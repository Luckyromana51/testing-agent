import { groupFindings } from "../group.js";
import { CATEGORIES, type AgentStat, type Category, type Finding, type Severity } from "../types.js";

const PENALTY: Record<Severity, number> = {
  critical: 25,
  high: 10,
  medium: 4,
  low: 1,
  info: 0,
};

/**
 * Which categories had no check that could run, and which checks could not run at all.
 * A category is only "not tested" when every agent assigned to it was left out or could not run.
 */
export function coverage(stats: AgentStat[], categories: Category[]) {
  const notTested: Partial<Record<Category, string>> = {};
  for (const cat of categories) {
    const own = stats.filter((s) => s.category === cat);
    if (!own.length || own.some((s) => !s.untested && !s.skipped)) continue;
    notTested[cat] = own.find((s) => s.untested)?.untested ?? own[0].skipped ?? "No check could run.";
  }
  const incomplete = stats.filter((s) => s.untested).map((s) => `${s.name}: ${s.untested}`);
  return { notTested, incomplete };
}

/**
 * Scores each category from 0 to 100. Each distinct issue takes points off once, by severity,
 * scaled by how widespread it is: half the penalty for an issue on one page, the full penalty for
 * one on every page. So a shared header problem counts as one issue, not one per page.
 *
 * With the agents' stats, categories that could not be tested get no score (never a free 100),
 * and the overall score averages only the categories that were tested.
 */
export function scoreFindings(
  findings: Finding[],
  pageCount: number,
  categories: Category[] = CATEGORIES,
  stats: AgentStat[] = [],
): {
  scores: Partial<Record<Category, number>>;
  overallScore: number;
  notTested?: Partial<Record<Category, string>>;
  incomplete?: string[];
} {
  const { notTested, incomplete } = coverage(stats, categories);
  const tested = categories.filter((c) => !(c in notTested));
  const pages = Math.max(1, pageCount);
  const penalty = Object.fromEntries(tested.map((c) => [c, 0])) as Record<Category, number>;
  for (const g of groupFindings(findings)) {
    if (!(g.first.category in penalty)) continue;
    const spread = Math.min(1, g.pages.length / pages);
    penalty[g.first.category] += PENALTY[g.severity] * (0.5 + 0.5 * spread);
  }
  const scores: Partial<Record<Category, number>> = {};
  for (const cat of tested) scores[cat] = Math.max(0, Math.round(100 - penalty[cat]));
  let overallScore = tested.length ? Math.round(tested.reduce((s, c) => s + (scores[c] ?? 100), 0) / tested.length) : 0;
  // A single critical issue (site down, no HTTPS, unusable for screen readers) caps the grade.
  if (findings.some((f) => f.severity === "critical")) overallScore = Math.min(overallScore, 69);
  return {
    scores,
    overallScore,
    ...(Object.keys(notTested).length ? { notTested } : {}),
    ...(incomplete.length ? { incomplete } : {}),
  };
}
