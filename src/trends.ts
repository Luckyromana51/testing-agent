import { issueKey } from "./group.js";
import type { Category, Issue, Run } from "./types.js";

/** One finished test, as a point on the project's trend charts. */
export interface TrendPoint {
  runId: string;
  at: string;
  score: number;
  scores: Partial<Record<Category, number>>;
  /** New and fixed issues compared with the test before. */
  new: number;
  fixed: number;
  open: number;
  findings: number;
  pages: number;
  /** How long the test took, in seconds. */
  seconds: number | null;
  journeys?: { passed: number; total: number };
  visualChanged?: number;
}

/** An issue that keeps coming and going: a flaky check, or a problem that only shows sometimes. */
export interface FlakyIssue {
  id: string;
  key: string;
  title: string;
  severity: Issue["severity"];
  /** Times it was fixed and then found again. */
  cameBack: number;
  /** Runs out of the last 10 that found it. */
  seenIn: number;
  checked: number;
}

export function trendPoints(runs: Run[]): TrendPoint[] {
  return runs
    .filter((r) => r.status === "done" && r.result)
    .map((r) => {
      const res = r.result!;
      const seconds = r.startedAt && r.finishedAt ? Math.round((new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000) : null;
      const visualChanged = res.pages.filter((p) => p.visual?.desktop?.status === "changed" || p.visual?.phone?.status === "changed").length;
      return {
        runId: r.id,
        at: r.createdAt,
        score: res.overallScore,
        scores: res.scores,
        new: (r.diff?.new ?? 0) + (r.diff?.reopened ?? 0),
        fixed: r.diff?.fixed ?? 0,
        open: r.diff?.open ?? 0,
        findings: res.findings.length,
        pages: res.pages.length,
        seconds,
        ...(res.journeys?.length ? { journeys: { passed: res.journeys.filter((j) => j.ok).length, total: res.journeys.length } } : {}),
        ...(res.pages.some((p) => p.visual) ? { visualChanged } : {}),
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Flaky: came back after being fixed at least twice, or was found in some but not most of the
 * last 10 tests (between 30% and 70%). Those need a look before anyone trusts a red or green result.
 */
export function flakyIssues(issues: Issue[], runs: Run[]): FlakyIssue[] {
  const recent = runs
    .filter((r) => r.status === "done" && r.result)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);
  const keysPerRun = recent.map((r) => new Set(r.result!.findings.map(issueKey)));
  const out: FlakyIssue[] = [];
  for (const i of issues) {
    if (i.mergedInto) continue;
    const key = issueKey(i);
    const cameBack = i.history.filter((h) => h.type === "regression").length;
    const seenIn = keysPerRun.filter((k) => k.has(key) || k.has(i.fingerprint)).length;
    const share = recent.length ? seenIn / recent.length : 0;
    const onAndOff = recent.length >= 4 && share >= 0.3 && share <= 0.7;
    if (cameBack >= 2 || onAndOff) {
      out.push({ id: i.id, key: i.key, title: i.title, severity: i.severity, cameBack, seenIn, checked: recent.length });
    }
  }
  return out.sort((a, b) => b.cameBack - a.cameBack || a.key.localeCompare(b.key));
}
