import { findLeak } from "../agents/api/index.js";
import { finding } from "../runner/finding.js";
import { scoreFindings } from "../runner/score.js";
import type { AgentStat, ApiCallView, ApiReport, Finding, PageResult, ScanResult } from "../types.js";
import { API_CATEGORIES } from "./api.js";

/** What every SOAP, gRPC and WebSocket test collects, turned into one report. */
export interface ProtocolRun {
  kind: "soap" | "grpc" | "websocket" | "pact";
  agent: string;
  agentName: string;
  url: string;
  service: string;
  operations: number;
  notCalled: { method: string; path: string; why: string }[];
  views: ApiCallView[];
  findings: Finding[];
  notes: string[];
  startedAt: string;
  detail?: string;
}

/** A finding of a protocol test. */
export const protoFinding = (agent: string, pageUrl: string) => (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string, category: Finding["category"] = "security") =>
  finding({ category, rule, severity, title, detail, pageUrl, evidence, agent });

/** The same leak check the REST test makes, over every answer. */
export function leakFindings(agent: string, url: string, views: ApiCallView[]): Finding[] {
  for (const v of views) {
    const leak = findLeak(v.body);
    if (leak) {
      return [finding({ category: "security", rule: "api:error-leak", severity: "high", title: "Answers show internal details", detail: `An answer contains ${leak.what}. Return short errors in production and log the details on the server.`, pageUrl: url, evidence: `${v.path}: ${leak.snippet}`, agent })];
    }
  }
  return [];
}

export function protocolResult(r: ProtocolRun, extra: Partial<ApiReport> = {}): ScanResult {
  const ok = r.views.filter((v) => v.status !== null && v.status < 400 && !v.error && !v.problems?.length);
  // Operations reached: each counted once (extra calls without the login or with a wrong request are not new operations).
  const called = Math.min(r.operations || Infinity, new Set(r.views.filter((v) => !v.step || r.kind === "pact").map((v) => `${v.method} ${v.path}`)).size);
  const passed = Math.min(called, new Set(ok.filter((v) => !v.step || r.kind === "pact").map((v) => `${v.method} ${v.path}`)).size);
  const stats: AgentStat[] = [{ id: r.agent, name: r.agentName, findings: r.findings.length, ms: 0, errors: 0, category: "security", runs: 1 }];
  const pages: PageResult[] = r.views.map((v) => ({ url: v.url, status: v.status, title: `${v.method} ${v.path}`, loadMs: v.status === null ? null : v.ms, error: v.error }));
  const score = scoreFindings(r.findings, Math.max(1, pages.length), API_CATEGORIES, stats);
  return {
    startUrl: r.url,
    startedAt: r.startedAt,
    finishedAt: new Date().toISOString(),
    pages,
    findings: r.findings,
    ...score,
    agentStats: stats,
    notes: r.notes,
    label: { pages: "Endpoints" },
    scanned: [r.url],
    api: {
      source: r.kind,
      calls: r.views,
      coverage: { documented: r.operations, called, passed, skipped: r.notCalled },
      ...(r.kind === "pact" ? {} : { protocol: { kind: r.kind, service: r.service, operations: r.operations, called: r.views.length, notCalled: r.notCalled.length, ...(r.detail ? { detail: r.detail } : {}) } }),
      ...extra,
    },
  };
}

/** Operation names that only read, by the usual naming (GetOrder, ListUsers, findById, Check). */
export const READ_NAME = /^(get|list|find|search|query|read|fetch|lookup|look_up|check|validate|verify|describe|count|is|has|ping|status|health|echo|version|info|show|view|retrieve|watch)/i;

/** Joins two results of the same API project (a protocol test and its contract test). */
export function mergeResults(a: ScanResult, b: ScanResult): ScanResult {
  const findings = [...a.findings, ...b.findings];
  const stats = [...(a.agentStats ?? []), ...(b.agentStats ?? [])];
  const pages = [...a.pages, ...b.pages];
  const score = scoreFindings(findings, Math.max(1, pages.length), API_CATEGORIES, stats);
  return {
    ...a,
    pages,
    findings,
    ...score,
    agentStats: stats,
    notes: [...(a.notes ?? []), ...(b.notes ?? [])],
    scanned: [...new Set([...(a.scanned ?? []), ...(b.scanned ?? [])])],
    incomplete: a.incomplete || b.incomplete ? [...(a.incomplete ?? []), ...(b.incomplete ?? [])] : undefined,
    api: a.api && b.api ? { ...a.api, calls: [...a.api.calls, ...b.api.calls], contract: b.api.contract ?? a.api.contract, coverage: { documented: a.api.coverage.documented + b.api.coverage.documented, called: a.api.coverage.called + b.api.coverage.called, passed: a.api.coverage.passed + b.api.coverage.passed, skipped: [...a.api.coverage.skipped, ...b.api.coverage.skipped] } } : (a.api ?? b.api),
  };
}
