import { finding } from "../../runner/finding.js";
import type { Finding, ProductType } from "../../types.js";
import type { CapturedCall, SiteAgent, SiteContext } from "../types.js";

/**
 * Backend profiling from the app's own calls: while the test used the signed-in app, every fetch/XHR
 * it made was timed. This picks out the slowest backend endpoints — the API calls that make screens
 * feel slow — and the endpoints called many times on one screen (a sign of an N+1 query). It points
 * the client at the exact call to profile on the server (where the SSH slow-query log then helps).
 */

export interface CallStat {
  endpoint: string;
  calls: number;
  maxMs: number;
  avgMs: number;
}

/** Normalises a URL to an endpoint shape (ids replaced), for grouping. Pure, for tests. */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split("/")
      .map((seg) => (/^\d+$/.test(seg) ? ":id" : /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i.test(seg) ? ":uuid" : seg))
      .join("/");
    return `${u.host}${path}`;
  } catch {
    return url.slice(0, 120);
  }
}

/** Groups timed calls into per-endpoint stats. Pure, for tests. */
export function callStats(calls: CapturedCall[]): CallStat[] {
  const by = new Map<string, { calls: number; total: number; max: number }>();
  for (const c of calls) {
    if (typeof c.ms !== "number" || c.ms <= 0) continue;
    const key = endpointOf(c.url);
    const n = c.count && c.count > 0 ? c.count : 1;
    const g = by.get(key) ?? { calls: 0, total: 0, max: 0 };
    g.calls += n;
    g.total += c.ms * n;
    g.max = Math.max(g.max, c.ms);
    by.set(key, g);
  }
  return [...by].map(([endpoint, g]) => ({ endpoint, calls: g.calls, maxMs: Math.round(g.max), avgMs: Math.round(g.total / g.calls) })).sort((a, b) => b.maxMs - a.maxMs);
}

function slowCallsFindings({ site }: SiteContext): Finding[] {
  const out: Finding[] = [];
  const calls = site.calls ?? [];
  if (!calls.length) return out;
  const stats = callStats(calls);
  const slow = stats.filter((s) => s.maxMs >= 1000).slice(0, 8);
  if (slow.length)
    out.push(
      finding({
        category: "performance",
        rule: "perf:slow-backend-call",
        severity: slow[0].maxMs >= 3000 ? "medium" : "low",
        title: `${slow.length} backend endpoint${slow.length === 1 ? "" : "s"} took over 1 second`,
        detail:
          "These API calls (made by the signed-in app) are the slow part of the screens that use them. Profile the slowest on the server, add indexes for the queries behind them, cache what rarely changes, and return less data per call. The SSH database health check's slow-query log shows the SQL behind them.",
        pageUrl: site.login ? "app" : (calls[0]?.pageUrl ?? "app"),
        evidence: slow.map((s) => `${s.maxMs}ms (avg ${s.avgMs}ms, ${s.calls}×) ${s.endpoint}`).join("\n"),
      }),
    );
  const chatty = stats.filter((s) => s.calls >= 10).slice(0, 5);
  if (chatty.length)
    out.push(
      finding({
        category: "performance",
        rule: "perf:n-plus-one",
        severity: "low",
        title: `An endpoint was called ${chatty[0].calls} times (possible N+1)`,
        detail: "The same endpoint is called many times over, often once per row — a classic N+1 pattern that multiplies database round-trips. Add a bulk/batch endpoint, or include the related data in one response.",
        pageUrl: "app",
        evidence: chatty.map((s) => `${s.calls}× ${s.endpoint}`).join("\n"),
      }),
    );
  return out;
}

export const slowCallsAgent: SiteAgent = {
  id: "perf.backend",
  name: "Backend slow calls",
  description: "From the signed-in app's own API calls (each timed as it ran), reports the slowest backend endpoints and endpoints called many times on one screen (N+1), pointing to the exact call to profile on the server.",
  category: "performance",
  engine: "web",
  products: ["webapp", "saas", "crm"] as ProductType[],
  stage: "site",
  needsLogin: true,
  run: slowCallsFindings,
};
