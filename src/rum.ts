import type { DatabaseSync } from "node:sqlite";
import { finding } from "./runner/finding.js";
import type { Finding, RumSummary } from "./types.js";

/*
 * Real-visitor speed, made in-house (no Google CrUX, no paid service): the client adds one script
 * tag to their site; it measures each visit's Core Web Vitals in the visitor's own browser with
 * the browser's PerformanceObserver, and sends five numbers to this server once the visitor
 * leaves. Nothing personal is sent or kept: no cookie, no IP address, no full address (only the
 * path, without its query), and only a rough device kind.
 */

export const RUM_METRICS = ["lcp", "cls", "inp", "ttfb", "fcp"] as const;
export type RumMetric = (typeof RUM_METRICS)[number];

/** Google's "good" and "poor" lines for each number (web.dev/vitals). */
export const RUM_LIMITS: Record<RumMetric, { good: number; poor: number; name: string; unit: string }> = {
  lcp: { good: 2500, poor: 4000, name: "Largest Contentful Paint", unit: "ms" },
  cls: { good: 0.1, poor: 0.25, name: "Cumulative Layout Shift", unit: "" },
  inp: { good: 200, poor: 500, name: "Interaction to Next Paint", unit: "ms" },
  ttfb: { good: 800, poor: 1800, name: "Time to First Byte", unit: "ms" },
  fcp: { good: 1800, poor: 3000, name: "First Contentful Paint", unit: "ms" },
};

/** Visits kept per project; the oldest go first. */
const KEEP = 50_000;
/** Fewer visits than this is too few to judge a page. */
export const MIN_VISITS = 20;

export interface RumBeacon {
  path: string;
  device: "phone" | "tablet" | "desktop";
  lcp?: number;
  cls?: number;
  inp?: number;
  ttfb?: number;
  fcp?: number;
}

/** Checks a beacon from a visitor's browser: anything odd is dropped, never stored. */
export function readBeacon(raw: unknown): RumBeacon | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  let path = typeof b.p === "string" ? b.p : "";
  path = path.split(/[?#]/)[0].slice(0, 300);
  if (!path.startsWith("/")) return undefined;
  // Long ids in paths are personal or useless for grouping: /orders/8f1c... -> /orders/:id
  path = path.replace(/\/(\d{3,}|[0-9a-f]{16,}|[0-9a-f-]{36})(?=\/|$)/gi, "/:id");
  const device = b.d === "phone" || b.d === "tablet" ? b.d : "desktop";
  const out: RumBeacon = { path, device };
  const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined);
  out.lcp = num(b.lcp, 120_000);
  out.cls = num(b.cls, 50);
  out.inp = num(b.inp, 60_000);
  out.ttfb = num(b.ttfb, 120_000);
  out.fcp = num(b.fcp, 120_000);
  if (RUM_METRICS.every((m) => out[m] === undefined)) return undefined;
  return out;
}

/** The script the client puts on their site, for one project. Plain ES5, about 1.5 KB. */
export function rumScript(endpoint: string): string {
  return `(function () {
  if (!window.PerformanceObserver || !navigator.sendBeacon) return;
  var m = {}, sent = false, inp = 0;
  function obs(type, fn, opts) { try { var o = new PerformanceObserver(function (l) { l.getEntries().forEach(fn); }); o.observe(Object.assign({ type: type, buffered: true }, opts || {})); } catch (e) {} }
  obs("largest-contentful-paint", function (e) { m.lcp = Math.round(e.startTime); });
  obs("paint", function (e) { if (e.name === "first-contentful-paint") m.fcp = Math.round(e.startTime); });
  var cls = 0, win = 0, last = 0, first = 0;
  obs("layout-shift", function (e) {
    if (e.hadRecentInput) return;
    if (e.startTime - last < 1000 && e.startTime - first < 5000) win += e.value; else { win = e.value; first = e.startTime; }
    last = e.startTime; if (win > cls) { cls = win; m.cls = Math.round(cls * 1000) / 1000; }
  });
  obs("event", function (e) { if (e.interactionId && e.duration > inp) { inp = e.duration; m.inp = Math.round(inp); } }, { durationThreshold: 40 });
  try { var nav = performance.getEntriesByType("navigation")[0]; if (nav) m.ttfb = Math.round(nav.responseStart); } catch (e) {}
  var w = Math.min(screen.width, screen.height);
  var d = /Mobi|Android.+Mobile|iPhone/.test(navigator.userAgent) || w < 600 ? "phone" : w < 1025 && "ontouchstart" in window ? "tablet" : "desktop";
  function send() {
    if (sent) return; sent = true;
    m.p = location.pathname; m.d = d;
    navigator.sendBeacon(${JSON.stringify(endpoint)}, new Blob([JSON.stringify(m)], { type: "text/plain" }));
  }
  addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") send(); });
  addEventListener("pagehide", send);
})();`;
}

export class RumStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS rum (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, at TEXT NOT NULL, path TEXT NOT NULL,
      device TEXT NOT NULL, lcp REAL, cls REAL, inp REAL, ttfb REAL, fcp REAL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS rum_project ON rum (project_id, at)");
  }

  add(projectId: string, b: RumBeacon, at = new Date().toISOString()): void {
    this.db
      .prepare("INSERT INTO rum (project_id, at, path, device, lcp, cls, inp, ttfb, fcp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, at, b.path, b.device, b.lcp ?? null, b.cls ?? null, b.inp ?? null, b.ttfb ?? null, b.fcp ?? null);
    const n = (this.db.prepare("SELECT COUNT(*) AS n FROM rum WHERE project_id = ?").get(projectId) as { n: number }).n;
    if (n > KEEP) {
      this.db.prepare("DELETE FROM rum WHERE id IN (SELECT id FROM rum WHERE project_id = ? ORDER BY id LIMIT ?)").run(projectId, n - KEEP);
    }
  }

  /** The last `days` days of visits, as p75 numbers overall, per device and per page. */
  summary(projectId: string, days = 28, now = Date.now()): RumSummary | undefined {
    const since = new Date(now - days * 86_400_000).toISOString();
    const rows = this.db.prepare("SELECT path, device, lcp, cls, inp, ttfb, fcp FROM rum WHERE project_id = ? AND at >= ?").all(projectId, since) as unknown as (RumBeacon & Record<RumMetric, number | null>)[];
    if (!rows.length) return undefined;
    return summarise(rows, since);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM rum WHERE project_id = ?").run(projectId);
  }
}

/** The 75th percentile (nearest rank), as CrUX reports. */
export function p75(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.75) - 1)];
}

function p75s(rows: Partial<Record<RumMetric, number | null>>[]): RumSummary["p75"] {
  const out: RumSummary["p75"] = {};
  for (const m of RUM_METRICS) {
    const v = p75(rows.map((r) => r[m]).filter((x): x is number => typeof x === "number"));
    if (v !== undefined) out[m] = m === "cls" ? Math.round(v * 1000) / 1000 : Math.round(v);
  }
  return out;
}

export function summarise(rows: (Pick<RumBeacon, "path" | "device"> & Partial<Record<RumMetric, number | null>>)[], since: string): RumSummary {
  const devices = (["phone", "tablet", "desktop"] as const)
    .map((device) => {
      const r = rows.filter((x) => x.device === device);
      return { device, visits: r.length, p75: p75s(r) };
    })
    .filter((d) => d.visits);
  const byPath = new Map<string, typeof rows>();
  for (const r of rows) byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  const pages = [...byPath]
    .map(([path, r]) => ({ path, visits: r.length, p75: p75s(r) }))
    .sort((a, b) => b.visits - a.visits || a.path.localeCompare(b.path))
    .slice(0, 50);
  return { since, visits: rows.length, p75: p75s(rows), byDevice: devices, pages };
}

const fmt = (m: RumMetric, v: number) => (m === "cls" ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

/**
 * Findings from real visitors: a number past Google's "poor" line (high) or "needs work" line
 * (medium), for the whole site and for each page with enough visits.
 */
export function rumFindings(s: RumSummary, origin: string): Finding[] {
  const out: Finding[] = [];
  const check = (p75: RumSummary["p75"], where: string, visits: number, pageUrl: string, scope: string) => {
    for (const m of ["lcp", "cls", "inp"] as const) {
      const v = p75[m];
      if (v === undefined) continue;
      const lim = RUM_LIMITS[m];
      if (v <= lim.good) continue;
      const poor = v > lim.poor;
      out.push(
        finding({
          category: "performance",
          rule: `rum:${m}`,
          severity: poor ? "high" : "medium",
          title: `Real visitors: ${lim.name} is ${poor ? "poor" : "slow"}${scope}`,
          detail: `For 3 in 4 of ${visits.toLocaleString("en-IN")} real visits ${where}, ${lim.name} was ${fmt(m, v)} or better, and the rest worse. Google's line for "good" is ${fmt(m, lim.good)}${poor ? `; above ${fmt(m, lim.poor)} counts as poor` : ""}. These are real visitors' phones and networks, which is what search ranking uses.`,
          pageUrl,
          evidence: `p75 ${m.toUpperCase()} ${fmt(m, v)} over ${visits} visits`,
          agent: "web.rum",
        }),
      );
    }
  };
  if (s.visits >= MIN_VISITS) check(s.p75, "to the site", s.visits, origin, "");
  for (const p of s.pages) {
    if (p.visits < MIN_VISITS) continue;
    check(p.p75, `to ${p.path}`, p.visits, new URL(p.path.replace(/:id/g, "1"), origin).href, ` on ${p.path}`);
  }
  return out;
}
