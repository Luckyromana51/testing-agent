import type { Severity } from "../types.js";
import type { ToolFinding, ToolTable } from "./types.js";

/**
 * What a load test measured, from k6 or JMeter, and what it means: the findings, the summary
 * lines and the table of steps in the report. Both tools fill the same shape, so a JMeter plan
 * and a k6 profile are judged by the same rules.
 */

export type LoadProfile = "load" | "stress" | "spike" | "soak" | "plan";

export interface LoadNumbers {
  requests: number;
  failed: number;
  /** Requests a second. */
  rps: number;
  /** Answer times in milliseconds. */
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LoadStep extends LoadNumbers {
  /** "Step 2", "Spike", "Last third". */
  name: string;
  /** What the step is for: the hold of a load test is the one measured. */
  role: "ramp" | "hold" | "step" | "base" | "spike" | "recovery" | "third" | "all";
  users: number;
  seconds: number;
}

export interface LoadPage extends LoadNumbers {
  url: string;
}

export interface LoadResult {
  tool: "k6" | "JMeter";
  profile: LoadProfile;
  /** Most users at once. */
  users: number;
  seconds: number;
  steps: LoadStep[];
  pages: LoadPage[];
  total: LoadNumbers;
  /** Failed answers by kind: "500", "4xx", "429", "timeout", "connection". */
  failures: Record<string, number>;
  /** Why the test stopped before its planned end. */
  stoppedEarly?: string;
  /** API endpoints are judged against a stricter time than web pages. */
  api: boolean;
}

/** When answers count as slow under load (95% of them slower than this), in ms. */
export const SLOW = { web: { medium: 3000, high: 8000 }, api: { medium: 1000, high: 3000 } };

export const rate = (n: LoadNumbers) => (n.requests ? n.failed / n.requests : 0);
const pct = (r: number) => `${(r * 100).toFixed(r > 0 && r < 0.01 ? 2 : 1)}%`;
export const secs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`);
const num = (n: number) => n.toLocaleString("en-IN");
const users = (n: number) => `${num(n)} user${n === 1 ? "" : "s"}`;

/** The steps a verdict is based on: the steady part of a load test, everything of a soak or a plan. */
function measured(r: LoadResult): LoadNumbers | undefined {
  const pick = (role: LoadStep["role"]) => r.steps.filter((s) => s.role === role && s.requests > 0);
  const hold = pick("hold");
  if (r.profile === "load" && hold.length) return merge(hold);
  if (r.profile === "spike") return merge(pick("spike"));
  return r.total.requests ? r.total : undefined;
}

/** Combines steps (answer times are weighted by requests; p95 and max take the worst). */
export function merge(steps: LoadNumbers[]): LoadNumbers | undefined {
  const live = steps.filter((s) => s.requests > 0);
  if (!live.length) return undefined;
  const requests = live.reduce((a, s) => a + s.requests, 0);
  return {
    requests,
    failed: live.reduce((a, s) => a + s.failed, 0),
    rps: live.reduce((a, s) => a + s.rps, 0) / live.length,
    avg: live.reduce((a, s) => a + s.avg * s.requests, 0) / requests,
    p50: live.reduce((a, s) => a + s.p50 * s.requests, 0) / requests,
    p95: Math.max(...live.map((s) => s.p95)),
    max: Math.max(...live.map((s) => s.max)),
  };
}

function failureText(f: Record<string, number>): string {
  const label: Record<string, string> = {
    "5xx": "server errors (5xx)",
    "429": "\"too many requests\" (429)",
    "4xx": "other 4xx answers",
    timeout: "timeouts (no answer in 30 s)",
    connection: "connections refused or dropped",
  };
  return Object.entries(f)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${num(n)} ${label[k] ?? k}`)
    .join(", ");
}

const worstPages = (r: LoadResult, by: "p95" | "failed", n = 5) =>
  r.pages
    .filter((p) => p.requests > 0 && (by === "failed" ? p.failed > 0 : true))
    .sort((a, b) => (by === "p95" ? b.p95 - a.p95 : rate(b) - rate(a)))
    .slice(0, n)
    .map((p) => (by === "p95" ? `${p.url}: 95% within ${secs(p.p95)} (${num(p.requests)} requests)` : `${p.url}: ${pct(rate(p))} failed (${num(p.failed)} of ${num(p.requests)})`))
    .join("\n");

/** The first step where the site broke: too many failures, or far slower than at the start. */
export function breakingStep(r: LoadResult): { step: LoadStep; why: "errors" | "slow" } | undefined {
  const steps = r.steps.filter((s) => s.role === "step" && s.requests > 0);
  if (!steps.length) return undefined;
  const slow = r.api ? SLOW.api.medium : SLOW.web.medium;
  const base = steps[0].p95;
  for (const s of steps) {
    if (rate(s) >= 0.05) return { step: s, why: "errors" };
    if (s.p95 >= slow && s.p95 >= base * 3) return { step: s, why: "slow" };
  }
  return undefined;
}

/** What the load test found, as findings for the report and the issue board. */
export function loadFindings(r: LoadResult, startUrl: string): ToolFinding[] {
  const out: ToolFinding[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string, evidence?: string) =>
    out.push({ category: "performance", rule, severity, title, detail, pageUrl: startUrl, ...(evidence ? { evidence } : {}) });
  const slow = r.api ? SLOW.api : SLOW.web;
  const what = r.api ? "API" : "site";
  const m = measured(r);
  const by = r.tool === "JMeter" ? "the JMeter plan" : `${users(r.users)} at once`;

  if (r.profile === "stress") {
    const broke = breakingStep(r);
    if (broke) {
      const { step, why } = broke;
      const first = step === r.steps.find((s) => s.role === "step" && s.requests > 0);
      add(
        "load:breaking-point",
        why === "errors" ? "high" : "medium",
        why === "errors"
          ? `The ${what} starts failing at about ${users(step.users)}`
          : `The ${what} becomes very slow at about ${users(step.users)}`,
        (why === "errors"
          ? `With ${users(step.users)} at once, ${pct(rate(step))} of requests failed${first ? ", already in the first step" : ""}.`
          : `With ${users(step.users)} at once, 95% of answers took up to ${secs(step.p95)}, against ${secs(r.steps.find((s) => s.role === "step")!.p95)} in the first step.`) +
          " This is the most users the site can serve today. Find what runs out first (CPU, memory, database connections, the PHP or Node worker count) in the server's monitoring for that time, then add caching or capacity, or limit how many people can use the heaviest pages at once.",
        failureText(r.failures) || worstPages(r, "p95"),
      );
    }
    // Slow from the lightest step on: not a breaking point, but slow for everyone.
    const lightest = r.steps.find((s) => s.role === "step" && s.requests > 0);
    if (lightest && lightest.p95 >= slow.medium && !(broke && broke.step === lightest)) {
      add(
        "load:slow",
        lightest.p95 >= slow.high ? "high" : "medium",
        `${r.api ? "API answers are" : "Pages are"} slow even under light load: 95% within ${secs(lightest.p95)}`,
        `With only ${users(lightest.users)} at once, 95% of answers took up to ${secs(lightest.p95)}. Aim for under ${secs(slow.medium)}. The slowest addresses are listed; profile them first.`,
        worstPages(r, "p95"),
      );
    }
  } else if (m) {
    const e = rate(m);
    if (e >= 0.01) {
      add(
        "load:errors",
        e >= 0.25 ? "critical" : e >= 0.05 ? "high" : "medium",
        `${pct(e)} of requests failed under load`,
        `With ${by}, ${num(m.failed)} of ${num(m.requests)} requests failed${r.profile === "spike" ? " during the sudden rush" : ""}. ${
          r.failures["429"] ? "Some were refused with 429 \"too many requests\": a firewall or rate limit stopped the test, so ask the client to allow the test's address during the test window. " : ""
        }Real visitors would see error pages at these times. Check the server's error log for the test window.`,
        [failureText(r.failures), worstPages(r, "failed")].filter(Boolean).join("\n"),
      );
    }
    if (r.profile !== "spike" && m.p95 >= slow.medium) {
      add(
        "load:slow",
        m.p95 >= slow.high ? "high" : "medium",
        `${r.api ? "API answers are" : "Pages are"} slow under load: 95% within ${secs(m.p95)}`,
        `With ${by}, 95% of answers took up to ${secs(m.p95)} (half within ${secs(m.p50)}). Aim for under ${secs(slow.medium)}. The slowest addresses are listed; profile them first.`,
        worstPages(r, "p95"),
      );
    }
  }

  if (r.profile === "spike") {
    const base = merge(r.steps.filter((s) => s.role === "base"));
    const after = merge(r.steps.filter((s) => s.role === "recovery"));
    if (base && after && (after.p95 > Math.max(base.p95 * 2, base.p95 + 500) || (rate(after) >= 0.01 && rate(after) > rate(base) * 2))) {
      add(
        "load:spike-recovery",
        "medium",
        `The ${what} stays slow after a sudden rush`,
        `After the rush ended, 95% of answers took up to ${secs(after.p95)}${rate(after) >= 0.01 ? ` and ${pct(rate(after))} failed` : ""}, against ${secs(base.p95)} before it. Queues, caches or worker processes do not recover by themselves: check for requests piling up, and for workers that crash and restart slowly.`,
      );
    }
  }

  if (r.profile === "soak") {
    const thirds = r.steps.filter((s) => s.role === "third" && s.requests > 0);
    if (thirds.length >= 3) {
      const [first, , last] = thirds;
      if (last.p95 > Math.max(first.p95 * 1.5, first.p95 + 300) || (rate(last) >= 0.01 && rate(first) < 0.005)) {
        add(
          "load:degrades",
          "medium",
          `The ${what} gets slower the longer the load lasts`,
          `In the last third of the test, 95% of answers took up to ${secs(last.p95)}${rate(last) >= 0.01 ? ` and ${pct(rate(last))} failed` : ""}, against ${secs(first.p95)} in the first third, with the same ${users(r.users)}. This is the usual sign of a memory leak, a growing queue or database connections that are not given back.`,
        );
      }
    }
  }
  return out;
}

/** Short lines for the report's tool section. */
export function loadSummary(r: LoadResult): string[] {
  const lines: string[] = [];
  const t = r.total;
  lines.push(
    `${r.tool === "JMeter" ? `JMeter plan, up to ${users(r.users)}` : `${PROFILE_NAMES[r.profile]}, up to ${users(r.users)}`} for ${secs(r.seconds * 1000).replace(".0 s", " s")}: ${num(t.requests)} requests, ${t.rps.toFixed(1)} a second`,
  );
  if (t.requests) lines.push(`Half answered within ${secs(t.p50)}, 95% within ${secs(t.p95)}, slowest ${secs(t.max)}; ${pct(rate(t))} failed`);
  if (r.profile === "stress") {
    const broke = breakingStep(r);
    const ran = r.steps.filter((s) => s.role === "step" && s.requests > 0);
    if (broke) lines.push(`Breaking point: about ${users(broke.step.users)} (${broke.why === "errors" ? "requests started failing" : "answers became very slow"})`);
    else if (ran.length) lines.push(`Handled up to ${users(ran[ran.length - 1].users)} without breaking`);
  }
  const f = failureText(r.failures);
  if (f) lines.push(`Failures: ${f}`);
  if (r.stoppedEarly) lines.push(`Stopped early: ${r.stoppedEarly}`);
  return lines;
}

export const PROFILE_NAMES: Record<LoadProfile, string> = {
  load: "Load test",
  stress: "Stress test",
  spike: "Spike test",
  soak: "Soak test",
  plan: "Test plan",
};

/** The steps of the test, as a table in the report. */
export function loadTable(r: LoadResult): ToolTable {
  return {
    title: "Step by step",
    columns: ["Step", "Users", "Requests", "A second", "Half within", "95% within", "Failed"],
    rows: r.steps.map((s) => [
      s.name,
      num(s.users),
      num(s.requests),
      s.requests ? s.rps.toFixed(1) : "–",
      s.requests ? secs(s.p50) : "–",
      s.requests ? secs(s.p95) : "–",
      s.requests ? pct(rate(s)) : "not reached",
    ]),
  };
}
