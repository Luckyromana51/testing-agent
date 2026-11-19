import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { WEB_PRODUCTS } from "../products.js";
import { moduleOn } from "../modules.js";
import { loadFindings, loadSummary, loadTable, type LoadPage, type LoadProfile, type LoadResult, type LoadStep } from "./load.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolOutput } from "./types.js";

/**
 * Grafana k6, the open-source load engine, runs on GLV's own server: many simulated users open
 * the pages the test found (GET only), in one of four shapes. Nothing is sent to Grafana's cloud
 * (usage reports are off) and the charts are made on this server.
 */

const k6Path = () => process.env.K6_PATH || "k6";

/** Most pages one load test spreads its users over. */
const MAX_PAGES = 20;

interface Phase {
  key: string;
  name: string;
  role: LoadStep["role"];
  /** Users at the end of the phase (ramping) or all through it (constant). */
  users: number;
  from?: number;
  seconds: number;
  start: number;
}

/** The phases of each shape, for this many users over this many seconds. */
export function phases(profile: Exclude<LoadProfile, "plan">, users: number, seconds: number): Phase[] {
  const at = (n: number) => Math.max(1, Math.round(n));
  const list: Omit<Phase, "start">[] = [];
  if (profile === "load") {
    const ramp = Math.max(1, Math.round(seconds * 0.2));
    list.push({ key: "rampup", name: "Ramp up", role: "ramp", from: 0, users, seconds: ramp });
    list.push({ key: "hold", name: "Steady", role: "hold", users, seconds: seconds - 2 * ramp });
    list.push({ key: "rampdown", name: "Ramp down", role: "ramp", from: users, users: 0, seconds: ramp });
  } else if (profile === "stress") {
    const steps = Math.min(5, users);
    for (let i = 1; i <= steps; i++) list.push({ key: `step${i}`, name: `Step ${i}`, role: "step", users: at((users * i) / steps), seconds: Math.round(seconds / steps) });
  } else if (profile === "spike") {
    const base = at(users / 10);
    list.push({ key: "base", name: "Before the rush", role: "base", users: base, seconds: Math.round(seconds * 0.3) });
    list.push({ key: "spike", name: "Sudden rush", role: "spike", users, seconds: Math.round(seconds * 0.2) });
    list.push({ key: "recovery", name: "After the rush", role: "recovery", users: base, seconds: seconds - Math.round(seconds * 0.3) - Math.round(seconds * 0.2) });
  } else {
    const third = Math.round(seconds / 3);
    for (const [i, name] of ["First third", "Middle third", "Last third"].entries()) {
      list.push({ key: `third${i + 1}`, name, role: "third", users, seconds: i === 2 ? seconds - 2 * third : third });
    }
  }
  let start = 0;
  return list.map((p) => {
    const out = { ...p, start };
    start += p.seconds;
    return out;
  });
}

/** A short, unique name for each address in k6's numbers: its path, or the whole address for another host. */
export function labels(urls: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const hosts = new Set(urls.map((u) => new URL(u).host));
  for (const u of urls) {
    const x = new URL(u);
    let name = hosts.size > 1 ? `${x.host}${x.pathname}${x.search}` : `${x.pathname}${x.search}`;
    // k6 reads the name back inside a threshold ("http_req_duration{name:/shop?page=2}"): keep to safe characters.
    name = name.replace(/[^\w/.?=&%~+-]/g, "_").slice(0, 120);
    while (used.has(name)) name += "_";
    used.add(name);
    out.set(u, name);
  }
  return out;
}

/** The k6 script: the phases as k6 scenarios, and a threshold per phase and page so k6 reports each. */
export function k6Script(opts: { urls: string[]; phases: Phase[]; pause: number; cookie?: string; summaryFile: string; stopAtFailRate: number }): string {
  const names = labels(opts.urls);
  const scenarios: Record<string, unknown> = {};
  const thresholds: Record<string, unknown> = {};
  for (const p of opts.phases) {
    scenarios[p.key] =
      p.from !== undefined
        ? { executor: "ramping-vus", startVUs: p.from, stages: [{ duration: `${p.seconds}s`, target: p.users }], startTime: `${p.start}s`, gracefulRampDown: "5s", gracefulStop: "5s" }
        : { executor: "constant-vus", vus: p.users, duration: `${p.seconds}s`, startTime: `${p.start}s`, gracefulStop: "5s" };
    // "max>=0" always passes: it only makes k6 report this phase's own numbers.
    thresholds[`http_req_duration{scenario:${p.key}}`] = ["max>=0"];
    // Stops the whole test when most requests of a phase fail: the site is down, and more load only hurts it.
    thresholds[`http_req_failed{scenario:${p.key}}`] = [{ threshold: `rate<${opts.stopAtFailRate}`, abortOnFail: true, delayAbortEval: "15s" }];
  }
  for (const name of names.values()) {
    thresholds[`http_req_duration{name:${name}}`] = ["max>=0"];
    thresholds[`http_req_failed{name:${name}}`] = ["rate<=1"];
  }
  const targets = opts.urls.map((u) => ({ url: u, name: names.get(u)! }));
  const headers: Record<string, string> = { "User-Agent": "GLV-Testing-Agent load test (k6)" };
  if (opts.cookie) headers.Cookie = opts.cookie;
  return `import http from "k6/http";
import { sleep } from "k6";
import { Counter } from "k6/metrics";

const targets = ${JSON.stringify(targets)};
const headers = ${JSON.stringify(headers)};
const pause = ${opts.pause};
const s5xx = new Counter("glv_5xx");
const s429 = new Counter("glv_429");
const s4xx = new Counter("glv_4xx");
const timeouts = new Counter("glv_timeout");
const dropped = new Counter("glv_connection");

export const options = {
  scenarios: ${JSON.stringify(scenarios)},
  thresholds: ${JSON.stringify(thresholds)},
  summaryTrendStats: ["avg", "med", "p(95)", "max"],
  discardResponseBodies: true,
  // Redirects are not followed, so the load never reaches another site: the pages are the
  // addresses the test ended on, and a redirect counts as an answer.
  maxRedirects: 0,
};

export default function () {
  const t = targets[Math.floor(Math.random() * targets.length)];
  const res = http.get(t.url, { headers, tags: { name: t.name }, timeout: "30s", redirects: 0 });
  if (res.status >= 500) s5xx.add(1);
  else if (res.status === 429) s429.add(1);
  else if (res.status >= 400) s4xx.add(1);
  else if (res.status === 0) (res.error_code === 1050 ? timeouts : dropped).add(1);
  if (pause > 0) sleep(pause * (0.5 + Math.random()));
}

export function handleSummary(data) {
  return { ${JSON.stringify(opts.summaryFile)}: JSON.stringify(data) };
}
`;
}

interface K6Metric {
  values?: Record<string, number>;
  thresholds?: Record<string, { ok: boolean }>;
}
interface K6Summary {
  metrics: Record<string, K6Metric>;
  state?: { testRunDurationMs?: number };
}

const numbers = (dur: K6Metric | undefined, failed: K6Metric | undefined, seconds: number) => {
  const v = dur?.values ?? {};
  const f = failed?.values ?? {};
  // k6 counts a failed request as a "pass" of the http_req_failed rate.
  const bad = f.passes ?? 0;
  const requests = bad + (f.fails ?? 0);
  return {
    requests,
    failed: bad,
    rps: seconds > 0 ? requests / seconds : 0,
    avg: v.avg ?? 0,
    p50: v.med ?? 0,
    p95: v["p(95)"] ?? 0,
    max: v.max ?? 0,
  };
};

/** Turns k6's end-of-test summary into the platform's load result. */
export function readK6(summary: K6Summary, opts: { profile: Exclude<LoadProfile, "plan">; phases: Phase[]; urls: string[]; users: number; api: boolean }): LoadResult {
  const m = summary.metrics;
  const ran = (summary.state?.testRunDurationMs ?? 0) / 1000;
  const steps: LoadStep[] = opts.phases.map((p) => {
    // A phase cut short by an early stop ran for less time than planned.
    const seconds = Math.max(0, Math.min(p.seconds, ran - p.start));
    return { name: p.name, role: p.role, users: p.users || p.from || 0, seconds: Math.round(seconds), ...numbers(m[`http_req_duration{scenario:${p.key}}`], m[`http_req_failed{scenario:${p.key}}`], seconds) };
  });
  const names = labels(opts.urls);
  const pages: LoadPage[] = opts.urls.map((url) => ({ url, ...numbers(m[`http_req_duration{name:${names.get(url)}}`], m[`http_req_failed{name:${names.get(url)}}`], ran) }));
  const failedPhase = opts.phases.find((p) => m[`http_req_failed{scenario:${p.key}}`]?.thresholds && Object.values(m[`http_req_failed{scenario:${p.key}}`].thresholds!).some((t) => !t.ok));
  const count = (k: string) => m[k]?.values?.count ?? 0;
  return {
    tool: "k6",
    profile: opts.profile,
    users: opts.users,
    seconds: Math.round(ran),
    steps,
    pages,
    total: numbers(m.http_req_duration, m.http_req_failed, ran),
    failures: { "5xx": count("glv_5xx"), "429": count("glv_429"), "4xx": count("glv_4xx"), timeout: count("glv_timeout"), connection: count("glv_connection") },
    ...(failedPhase ? { stoppedEarly: `most requests failed in "${failedPhase.name}", so the test stopped to spare the site` } : {}),
    api: opts.api,
  };
}

const PROFILES: { value: Exclude<LoadProfile, "plan">; label: string }[] = [
  { value: "load", label: "Load: ramp up, hold, ramp down" },
  { value: "stress", label: "Stress: 5 steps up to find the breaking point" },
  { value: "spike", label: "Spike: a sudden rush, then back" },
  { value: "soak", label: "Soak: steady for the whole time" },
];

export const k6Tool: Tool = {
  id: "k6",
  name: "k6 load test",
  maker: "Grafana Labs (open source), run on GLV's server",
  description:
    "Many simulated users open the pages this test found, at the same time, to show how the site holds up: how fast it answers, when it starts failing, and whether it recovers. GET requests only.",
  checks: [
    "Load, stress (breaking point), spike and soak tests",
    "Answer times (half, 95%, slowest) and failures for each step and each page",
    "Server errors, timeouts and rate limits under load",
    "Stops by itself when most requests fail, to spare the site",
    "Charts of the whole run, made on this server",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "performance",
  safety: "permission",
  permission: "load",
  limits: { users: "users", minutes: "minutes" },
  takes: "the minutes you choose, plus about 10 seconds",
  licence: "AGPL-3.0, free (unchanged, run as a separate program)",
  homepage: "https://grafana.com/docs/k6/latest/",
  signedIn: "uses-login",
  options: [
    { id: "profile", label: "Shape", choices: PROFILES, default: "load" },
    {
      id: "users",
      label: "Most users at once",
      choices: ["5", "10", "25", "50", "100", "200", "500", "1000"].map((v) => ({ value: v, label: v })),
      default: "25",
    },
    {
      id: "minutes",
      label: "How long",
      choices: [
        { value: "0.5", label: "30 seconds (a quick check)" },
        ...["1", "2", "5", "10", "15", "30", "60", "120"].map((v) => ({ value: v, label: `${v} minute${v === "1" ? "" : "s"}` })),
      ],
      default: "5",
    },
    {
      id: "pause",
      label: "Pause between pages",
      choices: [
        { value: "1", label: "About 1 second (a quick visitor)" },
        { value: "3", label: "About 3 seconds (a normal visitor)" },
        { value: "0", label: "None (as fast as possible)" },
      ],
      default: "1",
    },
  ],

  async ready() {
    return (await which(k6Path())) ? null : "k6 is not installed on this server (the Docker image includes it; or set K6_PATH).";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit) throw new Error("k6 runs only with the client's permission for load tests.");
    const profile = (PROFILES.find((p) => p.value === ctx.options.profile)?.value ?? "load") as Exclude<LoadProfile, "plan">;
    const users = Math.min(Number(ctx.options.users) || 25, permit.maxUsers);
    const minutes = Math.min(Number(ctx.options.minutes) || 5, permit.maxMinutes);
    const seconds = Math.max(10, Math.round(minutes * 60));
    const pause = Math.max(0, Number(ctx.options.pause) || 0);
    // The pages the test opened, on the permitted hosts, GET only. An API test uses its endpoints.
    const urls = [...new Set([ctx.startUrl, ...ctx.urls])].filter((u) => /^https?:/.test(u)).slice(0, MAX_PAGES);
    if (!urls.length) throw new Error("No pages on the permitted addresses to load.");
    const plan = phases(profile, users, seconds);
    const summaryFile = path.join(ctx.workDir, "k6-summary.json");
    const script = path.join(ctx.workDir, "k6-script.js");
    await writeFile(script, k6Script({ urls, phases: plan, pause, cookie: ctx.cookie, summaryFile, stopAtFailRate: 0.5 }));
    const report = "tool-k6-report.html";
    ctx.log(`k6: ${profile} test, up to ${users} users for ${minutes < 1 ? `${seconds} seconds` : `${minutes} minute${minutes === 1 ? "" : "s"}`} on ${urls.length} page${urls.length === 1 ? "" : "s"}`);
    // Tells the live progress which phase is running.
    const timers = plan.map((p) => setTimeout(() => ctx.log(`k6: ${p.name} (${p.from !== undefined ? `${p.from} to ${p.users}` : p.users} users)`), p.start * 1000));
    let code: number | null;
    let stderr = "";
    try {
      const res = await runProcess(k6Path(), ["run", "--quiet", "--no-color", "--no-usage-report", ...influxArgs(ctx), script], {
        signal: ctx.signal,
        timeoutMs: (seconds + 120) * 1000,
        cwd: ctx.workDir,
        // A clean environment: k6 sees none of this server's settings or keys.
        env: {
          PATH: process.env.PATH,
          HOME: ctx.workDir,
          K6_NO_USAGE_REPORT: "true",
          K6_WEB_DASHBOARD: "true",
          K6_WEB_DASHBOARD_PORT: "-1",
          K6_WEB_DASHBOARD_PERIOD: `${Math.max(2, Math.round(seconds / 120))}s`,
          K6_WEB_DASHBOARD_EXPORT: path.join(ctx.outDir, report),
        },
        maxOutput: 200_000,
      });
      code = res.code;
      stderr = res.stderr + res.stdout;
    } finally {
      for (const t of timers) clearTimeout(t);
    }
    let summary: K6Summary;
    try {
      summary = JSON.parse(await readFile(summaryFile, "utf8")) as K6Summary;
    } catch {
      throw new Error(`k6 did not finish (exit ${code}): ${lastLine(stderr) || "no output"}`);
    }
    const result = readK6(summary, { profile, phases: plan, urls, users, api: ctx.product === "api" });
    await writeFile(path.join(ctx.outDir, "tool-k6.json"), JSON.stringify(result, null, 2));
    const reports = [{ file: "tool-k6.json", label: "k6 results (JSON)" }];
    try {
      await readFile(path.join(ctx.outDir, report));
      reports.unshift({ file: report, label: "k6 charts (HTML)" });
    } catch {
      // The charts are optional.
    }
    const charts = influxArgs(ctx).length ? grafanaLink(ctx) : undefined;
    return {
      findings: loadFindings(result, ctx.startUrl),
      summary: [...loadSummary(result), ...(charts ? [`Live charts: ${charts}`] : [])],
      table: loadTable(result),
      reports,
      tested: `${profile[0].toUpperCase()}${profile.slice(1)} test of ${urls.length} page${urls.length === 1 ? "" : "s"}, up to ${users} users${ctx.cookie ? ", signed in" : ""}`,
    };
  },
};

/**
 * With the "Live load charts" module on, k6 also streams its numbers to our InfluxDB while it runs
 * (Grafana shows them live). Each test is tagged with its own id so the dashboard can pick it.
 */
export function influxArgs(ctx: Pick<ToolContext, "modules" | "workDir">): string[] {
  const url = process.env.K6_INFLUX_URL;
  if (!url || !moduleOn(ctx.modules, "load-charts")) return [];
  return ["--out", `influxdb=${url.replace(/\/+$/, "")}/k6`, "--tag", `testid=${path.basename(ctx.workDir)}`];
}

/** The Grafana dashboard for this test, when GRAFANA_URL is set. */
export function grafanaLink(ctx: Pick<ToolContext, "workDir">): string | undefined {
  const g = process.env.GRAFANA_URL;
  return g ? `${g.replace(/\/+$/, "")}/d/glv-k6/k6-load-test?var-testid=${encodeURIComponent(path.basename(ctx.workDir))}&refresh=5s` : undefined;
}
