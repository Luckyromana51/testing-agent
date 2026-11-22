import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { PageAgent, PageContext } from "../types.js";

/**
 * Frontend deep profiling: reads the browser's own performance data after the page has settled —
 * long tasks that block the main thread (and hurt INP), total JavaScript shipped, a very large DOM,
 * and layout shift — the things that make a single-page app feel slow even when the server is fast.
 */

export interface ProfileData {
  longTasks: number;
  longestTaskMs: number;
  jsBytes: number;
  scriptCount: number;
  domNodes: number;
  cls: number;
}

/** Performance problems from the browser's own numbers. Pure, for tests. */
export function profileProblems(d: ProfileData): { rule: string; severity: Severity; title: string; detail: string; evidence: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string; evidence: string }[] = [];
  if (d.longTasks >= 3 || d.longestTaskMs >= 250)
    out.push({
      rule: "perf:long-tasks",
      severity: d.longestTaskMs >= 500 ? "medium" : "low",
      title: `${d.longTasks} long main-thread task${d.longTasks === 1 ? "" : "s"} (longest ${Math.round(d.longestTaskMs)}ms)`,
      detail: "Long JavaScript tasks block the page from responding to taps and clicks, which hurts Interaction to Next Paint (INP). Break big scripts into smaller chunks, defer non-critical work, and move heavy work to a web worker.",
      evidence: `${d.longTasks} tasks over 50ms; longest ${Math.round(d.longestTaskMs)}ms`,
    });
  if (d.jsBytes >= 1_500_000)
    out.push({
      rule: "perf:too-much-js",
      severity: d.jsBytes >= 3_000_000 ? "medium" : "low",
      title: `${(d.jsBytes / 1_048_576).toFixed(1)} MB of JavaScript loaded`,
      detail: "A lot of JavaScript is downloaded, parsed and run before the page is interactive, which is slow on mid-range phones. Code-split by route, drop unused libraries, and load non-critical scripts lazily.",
      evidence: `${d.scriptCount} scripts, ${(d.jsBytes / 1_048_576).toFixed(2)} MB transferred`,
    });
  if (d.domNodes >= 5000)
    out.push({
      rule: "perf:huge-dom",
      severity: "low",
      title: `The page has ${d.domNodes} DOM nodes`,
      detail: "A very large DOM (over ~5,000 nodes) slows style, layout and memory, especially on phones. Virtualise long lists and tables so only what is on screen is in the DOM.",
      evidence: `${d.domNodes} nodes`,
    });
  if (d.cls >= 0.1)
    out.push({
      rule: "perf:layout-shift",
      severity: d.cls >= 0.25 ? "medium" : "low",
      title: `Layout shifts after load (CLS ${d.cls.toFixed(2)})`,
      detail: "Content jumps as the page loads (images without size, late-injected banners, web fonts). Set width/height on images and reserve space for dynamic content so nothing moves under the reader (Cumulative Layout Shift).",
      evidence: `CLS ${d.cls.toFixed(3)}`,
    });
  return out;
}

const MEASURE = `(() => new Promise((resolve) => {
  let longTasks = 0, longestTaskMs = 0, cls = 0;
  try {
    for (const e of performance.getEntriesByType("longtask")) { longTasks++; longestTaskMs = Math.max(longestTaskMs, e.duration); }
  } catch {}
  try {
    const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) { if (!e.hadRecentInput) cls += e.value; } });
    po.observe({ type: "layout-shift", buffered: true });
    setTimeout(() => { try { po.disconnect(); } catch {} finish(); }, 400);
  } catch { finish(); }
  function finish() {
    let jsBytes = 0, scriptCount = 0;
    try {
      for (const r of performance.getEntriesByType("resource")) {
        if (r.initiatorType === "script" || /\\.m?js(\\?|$)/.test(r.name)) { scriptCount++; jsBytes += r.transferSize || r.encodedBodySize || 0; }
      }
    } catch {}
    resolve({ longTasks, longestTaskMs, jsBytes, scriptCount, domNodes: document.getElementsByTagName("*").length, cls });
  }
})())`;

async function frontendProfileFindings(ctx: PageContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const d = (await ctx.page.evaluate(MEASURE).catch(() => null)) as ProfileData | null;
  if (!d) return out;
  for (const p of profileProblems(d)) out.push(finding({ category: "performance", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: ctx.url, evidence: p.evidence }));
  return out;
}

export const frontendProfileAgent: PageAgent = {
  id: "perf.frontend",
  name: "Frontend profiling",
  description: "Reads the browser's performance data: long main-thread tasks (INP), how much JavaScript is shipped, a very large DOM, and layout shift (CLS) — what makes a single-page app feel slow even on a fast server.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  run: frontendProfileFindings,
};
