import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "playwright";
import { WEB_PRODUCTS } from "../products.js";
import type { Severity } from "../types.js";
import { lastLine, runProcess } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

const require = createRequire(import.meta.url);

/** The parts of a Lighthouse result (LHR) that the platform reads. */
interface Audit {
  id: string;
  title: string;
  description?: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  numericValue?: number;
  metricSavings?: Record<string, number>;
  details?: { type?: string; overallSavingsMs?: number; items?: { url?: string }[] };
}
interface Lhr {
  finalDisplayedUrl?: string;
  runtimeError?: { code: string; message: string };
  runWarnings?: string[];
  categories: Record<string, { title: string; score: number | null; auditRefs: { id: string; weight: number; group?: string }[] }>;
  audits: Record<string, Audit>;
}

/** Core Web Vitals and the other speed numbers, with the platform's own rule for the same number. */
const METRICS: Record<string, { short: string; sameAs?: string[] }> = {
  "largest-contentful-paint": { short: "lcp", sameAs: ["perf:lcp"] },
  "cumulative-layout-shift": { short: "cls", sameAs: ["perf:cls"] },
  "total-blocking-time": { short: "tbt" },
  "first-contentful-paint": { short: "fcp" },
  "speed-index": { short: "si" },
};

/** Best-practice audits the platform's own checks already cover (HTTPS, JavaScript errors). */
const COVERED = new Set(["errors-in-console", "is-on-https", "redirects-http", "uses-http2"]);

const plain = (md = "") => md.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)").replace(/`/g, "").trim();
const pct = (s: number | null | undefined) => (s === null || s === undefined ? "n/a" : String(Math.round(s * 100)));

/** Turns one Lighthouse result into findings and a score line. */
export function readLighthouse(lhr: Lhr, pageUrl: string, device: string): { findings: ToolFinding[]; summary: string } {
  const findings: ToolFinding[] = [];
  const where = `Lighthouse, ${device}`;
  const cats = lhr.categories;
  const summary = [
    `Performance ${pct(cats.performance?.score)}`,
    `Accessibility ${pct(cats.accessibility?.score)}`,
    `Best practices ${pct(cats["best-practices"]?.score)}`,
    `SEO ${pct(cats.seo?.score)}`,
  ].join(" · ");

  for (const [id, m] of Object.entries(METRICS)) {
    const a = lhr.audits[id];
    if (!a || a.score === null || a.score >= 0.9) continue;
    const severity: Severity = a.score < 0.5 ? "medium" : "low";
    findings.push({
      category: "performance",
      rule: `lighthouse:perf-${m.short}`,
      severity,
      title: `${a.title} is ${a.displayValue ?? "slow"} (${where})`,
      detail: `${a.score < 0.5 ? "Poor" : "Needs improvement"} by Google's Lighthouse thresholds, measured on a simulated ${device === "phone" ? "mid-range phone on a slow 4G connection" : "desktop connection"}. ${plain(a.description)}`,
      pageUrl,
      evidence: a.displayValue,
      sameAs: m.sameAs,
    });
  }

  // Suggestions that would make the page faster, biggest savings first.
  const perfRefs = cats.performance?.auditRefs ?? [];
  const tips = perfRefs
    .filter((r) => r.group !== "metrics" && !(r.id in METRICS))
    .map((r) => lhr.audits[r.id])
    .filter((a): a is Audit => Boolean(a) && a.score !== null && a.score < 0.9 && ["metricSavings", "numeric", "binary"].includes(a.scoreDisplayMode))
    .map((a) => ({ a, savings: a.details?.overallSavingsMs ?? Math.max(0, ...Object.values(a.metricSavings ?? {})) }))
    // Insights without a time saving (an LCP breakdown, a request tree) are explanations, not problems.
    .filter(({ savings }) => savings >= 100)
    .sort((x, y) => y.savings - x.savings)
    .slice(0, 8);
  for (const { a, savings } of tips) {
    const urls = (a.details?.items ?? []).map((i) => i.url).filter((u): u is string => Boolean(u)).slice(0, 5);
    findings.push({
      category: "performance",
      rule: `lighthouse:perf-${a.id}`,
      severity: savings >= 1000 ? "medium" : "low",
      title: `${a.title}${a.displayValue ? ` (${a.displayValue})` : ""}`,
      detail: `${plain(a.description)}${savings ? ` Lighthouse estimates this saves about ${(savings / 1000).toFixed(1)} s on a ${device}.` : ""}`,
      pageUrl,
      ...(urls.length ? { evidence: urls.join("\n") } : {}),
    });
  }

  for (const r of cats["best-practices"]?.auditRefs ?? []) {
    const a = lhr.audits[r.id];
    if (!a || r.weight === 0 || COVERED.has(a.id) || a.score === null || a.score >= 1) continue;
    if (a.scoreDisplayMode !== "binary" && a.scoreDisplayMode !== "numeric") continue;
    findings.push({
      category: /https|csp|vulnerab|geolocation|notification|inspector|deprecat/i.test(a.id) ? "security" : "functional",
      rule: `lighthouse:bp-${a.id}`,
      severity: "low",
      title: a.title,
      detail: `${plain(a.description)} (${where})`,
      pageUrl,
      ...(a.displayValue ? { evidence: a.displayValue } : {}),
    });
  }
  return { findings, summary };
}

export const lighthouseTool: Tool = {
  id: "lighthouse",
  name: "Lighthouse",
  maker: "Google",
  description: "Google's own speed test. Gives the 0 to 100 scores that clients see in PageSpeed Insights, and what to fix first to make each page faster.",
  checks: [
    "Performance, Accessibility, Best practices and SEO scores",
    "Core Web Vitals on a slow phone (LCP, CLS, Total Blocking Time)",
    "What slows the page most, with the time each fix saves",
    "Browser best practices (old APIs, image sizes, unsafe links)",
  ],
  products: WEB_PRODUCTS,
  category: "performance",
  safety: "safe",
  takes: "about 30 seconds a page",
  licence: "Apache-2.0, free",
  homepage: "https://developer.chrome.com/docs/lighthouse",
  signedIn: "uses-login",
  options: [
    {
      id: "device",
      label: "Device",
      choices: [
        { value: "phone", label: "Phone (what Google ranks on)" },
        { value: "desktop", label: "Desktop" },
      ],
      default: "phone",
    },
    {
      id: "pages",
      label: "Pages",
      choices: [
        { value: "1", label: "Start page" },
        { value: "3", label: "First 3 pages" },
        { value: "5", label: "First 5 pages" },
      ],
      default: "1",
    },
  ],

  async ready() {
    try {
      require.resolve("lighthouse/cli/index.js");
    } catch {
      return "Lighthouse is not installed on this server (npm install).";
    }
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const cli = require.resolve("lighthouse/cli/index.js");
    const device = ctx.options.device === "desktop" ? "desktop" : "phone";
    const count = Math.min(5, Math.max(1, Number(ctx.options.pages) || 1));
    const pages = [...new Set([ctx.startUrl, ...ctx.urls])].slice(0, count);
    const headersFile = path.join(ctx.workDir, "lighthouse-headers.json");
    // The session cookie goes in a file, never on the command line where other processes can see it.
    if (ctx.cookie) await writeFile(headersFile, JSON.stringify({ Cookie: ctx.cookie }), { mode: 0o600 });
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const chromeFlags = ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", ...(proxy ? [`--proxy-server=${proxy}`] : [])];
    const out: ToolOutput = { findings: [], summary: [], reports: [] };
    const failed: string[] = [];
    for (const [i, url] of pages.entries()) {
      ctx.signal.throwIfAborted();
      ctx.log(`Lighthouse (${device}): ${url}`);
      // Written to scratch space first: Lighthouse copies the request headers (the session cookie)
      // into its report, so only the HTML report is kept, and the runner hides the secrets in it.
      const base = path.join(ctx.workDir, `lighthouse-${i + 1}`);
      const args = [
        cli,
        url,
        "--output=json",
        "--output=html",
        `--output-path=${base}`,
        "--quiet",
        `--chrome-flags=${chromeFlags.join(" ")}`,
        "--only-categories=performance,accessibility,best-practices,seo",
        "--max-wait-for-load=45000",
        ...(device === "desktop" ? ["--preset=desktop"] : []),
        ...(ctx.cookie ? [`--extra-headers=${headersFile}`] : []),
      ];
      const env = { ...process.env, CHROME_PATH: process.env.CHROME_PATH || chromium.executablePath() };
      const res = await runProcess(process.execPath, args, { signal: ctx.signal, timeoutMs: 180_000, env });
      let lhr: Lhr;
      try {
        lhr = JSON.parse(await readFile(`${base}.report.json`, "utf8")) as Lhr;
      } catch {
        failed.push(`${url}: ${lastLine(res.stderr) || `Lighthouse stopped with code ${res.code}`}`);
        continue;
      }
      if (lhr.runtimeError) {
        failed.push(`${url}: ${lhr.runtimeError.message || lhr.runtimeError.code}`);
        continue;
      }
      await copyFile(`${base}.report.html`, path.join(ctx.outDir, `tool-lighthouse-${i + 1}.html`));
      const read = readLighthouse(lhr, url, device);
      out.findings.push(...read.findings);
      out.summary!.push(`${pages.length > 1 ? `${new URL(url).pathname}: ` : ""}${read.summary}`);
      out.reports!.push({ file: `tool-lighthouse-${i + 1}.html`, label: `Lighthouse report${pages.length > 1 ? ` ${i + 1}` : ""}` });
    }
    if (failed.length === pages.length) throw new Error(`Lighthouse could not test the page. ${failed[0]}`);
    if (failed.length) out.summary!.push(...failed.map((f) => `Not tested: ${f}`));
    out.tested = `${device === "phone" ? "Phone" : "Desktop"} test of ${pages.length - failed.length} page${pages.length - failed.length === 1 ? "" : "s"}${ctx.cookie ? ", signed in" : ""}`;
    return out;
  },
};
