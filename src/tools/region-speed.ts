import { lastLine, runProcess } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Speed from other regions, in the way WebPageTest's locations work, but in-house: GLV measures how
 * long the site takes to answer from each region the owner has set up as an outbound proxy in .env
 * (REGION_<name>_PROXY, e.g. a cheap VPS in Mumbai, Singapore, Frankfurt, US). Without any region
 * proxy it measures from this server only and says so. It only opens the site, so it is safe.
 */

export interface RegionResult {
  region: string;
  ttfbMs: number | null;
  totalMs: number | null;
  status: number | null;
  error?: string;
}

/** Region proxies configured in the environment: REGION_<NAME>_PROXY=http://host:port. Pure, for tests. */
export function regionProxies(env: NodeJS.ProcessEnv): { region: string; proxy: string }[] {
  const out: { region: string; proxy: string }[] = [];
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^REGION_([A-Z0-9_]+)_PROXY$/);
    if (m && v) out.push({ region: m[1].replace(/_/g, " ").toLowerCase(), proxy: v });
  }
  return out;
}

/** Worst/best spread problems. Pure, for tests. */
export function spreadProblem(results: RegionResult[]): { slowest: RegionResult; fastest: RegionResult; ratio: number } | null {
  const ok = results.filter((r) => r.totalMs !== null) as (RegionResult & { totalMs: number })[];
  if (ok.length < 2) return null;
  const sorted = [...ok].sort((a, b) => a.totalMs - b.totalMs);
  const fastest = sorted[0];
  const slowest = sorted[sorted.length - 1];
  return { slowest, fastest, ratio: slowest.totalMs / Math.max(1, fastest.totalMs) };
}

/** Parses curl's "-w" timing line: "<starttransfer> <total> <code>" (seconds, seconds, http). Pure, for tests. */
export function parseCurlTiming(out: string, region: string): RegionResult {
  const m = out.trim().match(/([\d.]+)\s+([\d.]+)\s+(\d{3})/);
  if (!m) return { region, ttfbMs: null, totalMs: null, status: null, error: out.trim().slice(0, 120) || "no answer" };
  return { region, ttfbMs: Math.round(Number(m[1]) * 1000), totalMs: Math.round(Number(m[2]) * 1000), status: Number(m[3]) };
}

async function measure(url: string, region: string, proxy: string | undefined, signal: AbortSignal): Promise<RegionResult> {
  const args = ["-s", "-o", "/dev/null", "--max-time", "20", "-A", "GLV-Testing-Agent region speed", "-w", "%{time_starttransfer} %{time_total} %{http_code}"];
  if (proxy) args.push("-x", proxy);
  args.push(url);
  try {
    const res = await runProcess("curl", args, { signal, timeoutMs: 25_000 });
    if (!res.stdout.trim()) return { region, ttfbMs: null, totalMs: null, status: null, error: lastLine(res.stderr) || "no answer" };
    return parseCurlTiming(res.stdout, region);
  } catch (e) {
    return { region, ttfbMs: null, totalMs: null, status: null, error: (e as Error).message };
  }
}

export const regionSpeedTool: Tool = {
  id: "region-speed",
  name: "Speed from other regions",
  maker: "GLV Infotech (built in), in the way of WebPageTest",
  description:
    "Measures how long the site takes to answer from each region the owner has set up (a proxy in Mumbai, Singapore, Frankfurt, US...). Shows where visitors far from the server wait longest, so the client can add a CDN or an edge cache. With no region set up, it measures from this server only.",
  checks: ["Time to first byte and full load from each configured region", "The spread between the fastest and slowest region", "Regions set up as REGION_<name>_PROXY in .env; none needed to run from here"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api"],
  category: "performance",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://www.webpagetest.org",
  signedIn: "public",
  options: [{ id: "repeat", label: "Measurements per region", choices: ["1", "3", "5"].map((v) => ({ value: v, label: v })), default: "3" }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const regions = regionProxies(process.env);
    const repeat = Number(ctx.options.repeat) || 3;
    const targets = [{ region: "this server", proxy: undefined as string | undefined }, ...regions.map((r) => ({ region: r.region, proxy: r.proxy }))];
    const results: RegionResult[] = [];
    for (const t of targets) {
      const runs: RegionResult[] = [];
      for (let i = 0; i < repeat; i++) runs.push(await measure(ctx.startUrl, t.region, t.proxy, ctx.signal));
      const ok = runs.filter((r) => r.totalMs !== null);
      results.push(
        ok.length
          ? { region: t.region, ttfbMs: Math.round(median(ok.map((r) => r.ttfbMs!))), totalMs: Math.round(median(ok.map((r) => r.totalMs!))), status: ok[0].status }
          : runs[0],
      );
      ctx.log(`Region ${t.region}: ${ok.length ? `${results[results.length - 1].totalMs}ms` : "failed"}`);
    }
    const findings: ToolFinding[] = [];
    const spread = spreadProblem(results);
    if (spread && spread.ratio >= 2 && spread.slowest.totalMs! >= 1500)
      findings.push({
        category: "performance",
        rule: "region:slow-far-away",
        severity: "medium",
        title: `The site is ${spread.ratio.toFixed(1)}× slower from ${spread.slowest.region} than ${spread.fastest.region}`,
        detail: `Visitors in ${spread.slowest.region} wait about ${spread.slowest.totalMs}ms versus ${spread.fastest.totalMs}ms near the server. Put static files and pages on a CDN with edge locations near your visitors, and cache HTML at the edge where you can.`,
        pageUrl: ctx.startUrl,
        evidence: results.map((r) => `${r.region}: ${r.totalMs !== null ? `${r.totalMs}ms (TTFB ${r.ttfbMs}ms)` : r.error ?? "failed"}`).join("\n"),
        key: "region:slow-far-away",
      });
    if (!regions.length)
      findings.push({
        category: "performance",
        rule: "region:no-regions",
        severity: "info",
        title: "Only measured from this server",
        detail: "No region proxies are set up, so speed was measured only from GLV's server. To measure real-world speed from your visitors' regions, add a cheap VPS in each region as REGION_<name>_PROXY in .env (for example REGION_MUMBAI_PROXY, REGION_SINGAPORE_PROXY).",
        pageUrl: ctx.startUrl,
        key: "region:no-regions",
      });
    return {
      findings,
      summary: [`${results.length} vantage point${results.length === 1 ? "" : "s"}: ${results.map((r) => `${r.region} ${r.totalMs !== null ? `${r.totalMs}ms` : "—"}`).join(", ")}`],
      tested: `${ctx.startUrl} from ${results.length} point(s)`,
      table: { title: "Speed by region", columns: ["Region", "TTFB", "Full load", "Status"], rows: results.map((r) => [r.region, r.ttfbMs !== null ? `${r.ttfbMs} ms` : "—", r.totalMs !== null ? `${r.totalMs} ms` : r.error ?? "failed", String(r.status ?? "—")]) },
    };
  },
};

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
