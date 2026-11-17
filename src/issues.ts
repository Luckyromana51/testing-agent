import { randomUUID } from "node:crypto";
import { WEB_AGENTS } from "./agents/registry.js";
import { groupFindings } from "./group.js";
import type { Issue, IssueStatus, Project, Run, RunDiff } from "./types.js";

/** Statuses where the issue is still a problem. */
export const ACTIVE: IssueStatus[] = ["open", "in_progress", "reopened", "fixed"];
const CLOSED: IssueStatus[] = ["verified"];

const SITE_AGENTS = new Set(WEB_AGENTS.filter((a) => a.stage === "site").map((a) => a.id));

/** Short uppercase key prefix for a project name, like Jira: "GLV Infotech" -> "GLV". */
export function projectKey(name: string, taken: string[] = []): string {
  const words = name
    .replace(/^https?:\/\/(www\.)?/i, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  let base = (words.length > 1 ? words.slice(0, 4).map((w) => w[0]).join("") : (words[0] ?? "PRJ").slice(0, 4)).toUpperCase();
  if (base.length < 2) base = (words[0] ?? "PRJ").slice(0, 3).toUpperCase();
  base = base.replace(/^[0-9]+/, "") || "PRJ";
  let key = base.slice(0, 5);
  for (let n = 2; taken.includes(key); n++) key = `${base.slice(0, 4)}${n}`;
  return key;
}

/**
 * Updates the project's issue list from a finished run (the regression check):
 * - a problem seen for the first time becomes a new open issue
 * - an issue that was fixed or verified and is found again is reopened (a regression)
 * - an active issue that is no longer found, on pages this run tested again, is verified as fixed
 * Info-level findings and the scanner's own errors never become issues.
 */
export function syncIssues(
  project: Project,
  run: Run,
  existing: Issue[],
  now = new Date().toISOString(),
): { changed: Issue[]; created: Issue[]; diff: RunDiff; project: Project } {
  const result = run.result;
  if (!result) throw new Error("The run has no result to compare.");
  const groups = groupFindings(result.findings.filter((f) => f.severity !== "info" && f.rule !== "check-error"));
  const byFingerprint = new Map(existing.map((i) => [i.fingerprint, i]));
  // Pages that failed, crashed or refused us were not really looked at, so their issues stay as they are.
  const looked = result.pages.filter((p) => !p.error && p.status !== null && ![401, 403, 429].includes(p.status) && p.status < 500);
  const scanned = new Set(looked.flatMap((p) => [p.url, p.redirectedFrom].filter(Boolean) as string[]));
  if (looked.length) for (const u of result.scanned ?? []) scanned.add(u);
  const ranAgents = run.agents ? new Set(run.agents) : null;
  const diff: RunDiff = { new: 0, fixed: 0, reopened: 0, open: 0 };
  const changed: Issue[] = [];
  const created: Issue[] = [];
  let seq = project.issueSeq;
  const seen = new Set<string>();

  for (const g of groups) {
    seen.add(g.key);
    const f = g.first;
    const occurrences = g.items.slice(0, 50).map((i) => ({ pageUrl: i.pageUrl, evidence: i.evidence?.split("\n")[0] }));
    const prev = byFingerprint.get(g.key);
    if (!prev) {
      seq += 1;
      const issue: Issue = {
        id: randomUUID(),
        key: `${project.key}-${seq}`,
        projectId: project.id,
        fingerprint: g.key,
        rule: f.rule,
        agent: f.agent,
        title: f.title,
        detail: f.detail,
        category: f.category,
        severity: g.severity,
        status: "open",
        occurrences,
        firstSeenRunId: run.id,
        lastSeenRunId: run.id,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
        history: [{ at: now, type: "created", text: `Found by test run on ${g.pages.length} page(s)`, runId: run.id }],
      };
      created.push(issue);
      diff.new++;
      continue;
    }
    const issue: Issue = {
      ...prev,
      title: f.title,
      detail: f.detail,
      severity: g.severity,
      occurrences,
      lastSeenRunId: run.id,
      lastSeenAt: now,
      updatedAt: now,
      history: [...prev.history],
    };
    if (prev.status === "fixed" || CLOSED.includes(prev.status)) {
      issue.status = "reopened";
      issue.history.push({
        at: now,
        type: "regression",
        text: `Came back: found again after it was marked ${prev.status === "fixed" ? "fixed" : "verified"}`,
        runId: run.id,
      });
      diff.reopened++;
    }
    changed.push(issue);
  }

  for (const prev of existing) {
    if (seen.has(prev.fingerprint) || !ACTIVE.includes(prev.status)) continue;
    // Only call it fixed when this run actually looked again: the agent ran and the pages were re-tested.
    const agentRan = !prev.agent || !ranAgents || ranAgents.has(prev.agent);
    const lookedAgain =
      result.complete ||
      (prev.agent && SITE_AGENTS.has(prev.agent) && looked.length > 0) ||
      prev.occurrences.some((o) => scanned.has(o.pageUrl));
    if (!agentRan || !lookedAgain) continue;
    changed.push({
      ...prev,
      status: "verified",
      updatedAt: now,
      history: [...prev.history, { at: now, type: "verified", text: "Not found in the re-test: fixed and verified", runId: run.id }],
    });
    diff.fixed++;
  }

  const finalStatus = new Map(existing.map((i) => [i.id, i.status]));
  for (const i of [...changed, ...created]) finalStatus.set(i.id, i.status);
  diff.open = [...finalStatus.values()].filter((s) => s !== "verified" && s !== "wont_fix" && s !== "fixed").length;

  return { changed, created, diff, project: { ...project, issueSeq: seq } };
}
