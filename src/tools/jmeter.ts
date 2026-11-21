import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { uploadedPath } from "../engines/index.js";
import { WEB_PRODUCTS } from "../products.js";
import { checkPlan } from "./jmx.js";
import { loadFindings, loadSummary, loadTable, type LoadNumbers, type LoadPage, type LoadResult, type LoadStep } from "./load.js";
import { lastLine, runProcess, ToolTimeout, which } from "./process.js";
import type { Tool, ToolContext, ToolOutput } from "./types.js";

/**
 * Apache JMeter runs a test plan the tester made in JMeter (a .jmx file), on GLV's server and
 * without its window. The plan is checked first (see jmx.ts): only known, harmless parts, only
 * the client's permitted addresses, within the permission's users and minutes.
 */

const jmeterPath = () => process.env.JMETER_PATH || "jmeter";

/** Splits one CSV line as JMeter writes it (fields with commas or quotes are quoted). */
export function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The value below which a share of the sorted times falls (nearest rank). */
const pick = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : 0);

class Bucket {
  times: number[] = [];
  failed = 0;
  users = 0;
  first = Infinity;
  last = 0;
  add(t: number, ms: number, ok: boolean, users: number) {
    this.times.push(ms);
    if (!ok) this.failed++;
    if (users > this.users) this.users = users;
    if (t < this.first) this.first = t;
    if (t > this.last) this.last = t;
  }
  numbers(seconds: number): LoadNumbers {
    const sorted = this.times.slice().sort((a, b) => a - b);
    const n = sorted.length;
    return {
      requests: n,
      failed: this.failed,
      rps: seconds > 0 ? n / seconds : 0,
      avg: n ? sorted.reduce((a, b) => a + b, 0) / n : 0,
      p50: pick(sorted, 0.5),
      p95: pick(sorted, 0.95),
      max: n ? sorted[n - 1] : 0,
    };
  }
}

/** What kind of failure a JMeter result is: an HTTP status class, a timeout, a dropped connection or a failed check. */
export function failureKind(code: string, ok: boolean): string | undefined {
  const status = Number(code);
  if (Number.isInteger(status) && status >= 100) {
    if (status >= 500) return "5xx";
    if (status === 429) return "429";
    if (status >= 400) return "4xx";
    return ok ? undefined : "assertion";
  }
  if (ok) return undefined;
  return /timeout|timed out/i.test(code) ? "timeout" : "connection";
}

/** Reads JMeter's results file (CSV with a header line) into the platform's load result. */
export async function readResults(file: string, opts: { api: boolean }): Promise<LoadResult> {
  const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  let header: string[] | undefined;
  const rows: { t: number; ms: number; ok: boolean; users: number; url: string; kind?: string }[] = [];
  let pending = "";
  for await (const raw of lines) {
    // A quoted field can hold a line break: join lines until the quotes are balanced.
    const line = pending ? `${pending}\n${raw}` : raw;
    if ((line.match(/"/g)?.length ?? 0) % 2 === 1) {
      pending = line;
      continue;
    }
    pending = "";
    if (!header) {
      header = csvFields(line);
      continue;
    }
    const f = csvFields(line);
    const get = (name: string) => f[header!.indexOf(name)] ?? "";
    const url = get("URL");
    // Transaction controllers add a summary result of their own, with no address: not a request.
    if (!url || url === "null") continue;
    const ok = get("success") === "true";
    const code = get("responseCode");
    rows.push({ t: Number(get("timeStamp")), ms: Number(get("elapsed")), ok, users: Number(get("allThreads")) || 0, url, kind: failureKind(code, ok) });
  }
  if (!rows.length) throw new Error("JMeter ran but recorded no requests.");
  // Loops, not Math.min(...rows): a long test has more results than a call can take as arguments.
  let start = Infinity;
  let end = 0;
  let most = 0;
  for (const r of rows) {
    if (r.t < start) start = r.t;
    if (r.t + r.ms > end) end = r.t + r.ms;
    if (r.users > most) most = r.users;
  }
  const seconds = Math.max(1, (end - start) / 1000);
  // Up to 10 steps of equal length, rounded to a readable size.
  const size = [10, 15, 30, 60, 120, 300, 600].find((s) => seconds / s <= 10) ?? Math.ceil(seconds / 10);
  const buckets = new Map<number, Bucket>();
  const pages = new Map<string, Bucket>();
  const total = new Bucket();
  const failures: Record<string, number> = {};
  for (const r of rows) {
    const i = Math.floor((r.t - start) / 1000 / size);
    if (!buckets.has(i)) buckets.set(i, new Bucket());
    buckets.get(i)!.add(r.t, r.ms, r.ok, r.users);
    if (!pages.has(r.url)) pages.set(r.url, new Bucket());
    pages.get(r.url)!.add(r.t, r.ms, r.ok, r.users);
    total.add(r.t, r.ms, r.ok, r.users);
    // A failed answer counts once, by its kind; a 4xx the plan expected (success) does not.
    if (!r.ok && r.kind) failures[r.kind] = (failures[r.kind] ?? 0) + 1;
  }
  const label = (s: number) => (s >= 60 && s % 60 === 0 ? `${s / 60} min` : `${s} s`);
  const steps: LoadStep[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, b]) => {
      const from = i * size;
      const length = Math.min(size, seconds - from);
      return { name: `${label(from)} to ${label(Math.round(from + length))}`, role: "all", users: b.users, seconds: Math.round(length), ...b.numbers(length) };
    });
  const pageList: LoadPage[] = [...pages.entries()]
    .map(([url, b]) => ({ url, ...b.numbers(seconds) }))
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 50);
  return {
    tool: "JMeter",
    profile: "plan",
    users: most,
    seconds: Math.round(seconds),
    steps,
    pages: pageList,
    total: total.numbers(seconds),
    failures,
    api: opts.api,
  };
}

export const jmeterTool: Tool = {
  id: "jmeter",
  name: "JMeter test plan",
  maker: "Apache Software Foundation, run on GLV's server",
  description:
    "Runs a load test plan made in Apache JMeter (.jmx): log in, search, add to cart, whatever journey the plan describes, with as many users as it sets. The plan is checked first, and only runs within the client's permission.",
  checks: [
    "Your own user journeys under load, as designed in JMeter",
    "Answer times and failures for each step and each request",
    "The plan is refused if it runs code, reads files or sends to other sites",
    "POST, PUT and DELETE only when the client allows test data",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "performance",
  safety: "permission",
  permission: "load",
  takes: "as long as the plan runs (stopped at the permission's limit)",
  licence: "Apache-2.0, free",
  homepage: "https://jmeter.apache.org",
  signedIn: "public",
  options: [
    {
      id: "plan",
      label: "JMeter test plan",
      kind: "file",
      accept: ".jmx",
      required: true,
      hint: "Save the plan in JMeter (File → Save Test Plan as). Scripts (Groovy, BeanShell), CSV files and other sites are not allowed.",
      choices: [],
      default: "",
    },
  ],

  async ready() {
    return (await which(jmeterPath())) ? null : "JMeter is not installed on this server (the Docker image includes it; or set JMETER_PATH).";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit) throw new Error("JMeter runs only with the client's permission for load tests.");
    const file = ctx.options.plan;
    if (!file) throw new Error("Upload a JMeter test plan (.jmx) first.");
    const planPath = uploadedPath(ctx.uploadsDir, file);
    const xml = await readFile(planPath, "utf8");
    const check = checkPlan(xml, permit);
    if (check.problems.length) {
      throw new Error(`The JMeter plan cannot run: ${check.problems.slice(0, 3).join(" ")}${check.problems.length > 3 ? ` (and ${check.problems.length - 3} more)` : ""}`);
    }
    const results = path.join(ctx.workDir, "jmeter-results.csv");
    const name = ctx.options["plan:name"] ?? "the plan";
    ctx.log(`JMeter: running ${name} with up to ${check.users} users${check.seconds ? ` for ${Math.ceil(check.seconds / 60)} minutes` : ""}`);
    let stoppedAtLimit = false;
    let res;
    try {
      res = await runProcess(
        jmeterPath(),
        [
          "-n",
          "-t",
          planPath,
          "-l",
          results,
          "-j",
          path.join(ctx.workDir, "jmeter.log"),
          // The results file in a fixed CSV shape, whatever this server's JMeter settings say.
          "-Jjmeter.save.saveservice.output_format=csv",
          "-Jjmeter.save.saveservice.print_field_names=true",
          "-Jjmeter.save.saveservice.timestamp_format=ms",
          "-Jjmeter.save.saveservice.thread_counts=true",
          "-Jjmeter.save.saveservice.url=true",
          "-Jjmeter.save.saveservice.response_message=false",
          "-Jjmeter.save.saveservice.assertion_results_failure_message=false",
          "-Jsummariser.out=false",
        ],
        {
          signal: ctx.signal,
          // The permission's limit is a hard stop: JMeter and every thread it started are ended.
          timeoutMs: permit.maxMinutes * 60_000 + 30_000,
          cwd: ctx.workDir,
          // A clean environment: the plan sees none of this server's settings or keys.
          env: { PATH: process.env.PATH, HOME: ctx.workDir, JVM_ARGS: "-Xms256m -Xmx1g", ...(process.env.JAVA_HOME ? { JAVA_HOME: process.env.JAVA_HOME } : {}) },
          maxOutput: 200_000,
        },
      );
    } catch (err) {
      if (!(err instanceof ToolTimeout)) throw err;
      stoppedAtLimit = true;
    }
    let result: LoadResult;
    try {
      result = await readResults(results, { api: ctx.product === "api" });
    } catch (err) {
      const log = await readFile(path.join(ctx.workDir, "jmeter.log"), "utf8").catch(() => "");
      throw new Error(`JMeter did not record results: ${lastLine(`${res?.stdout ?? ""}\n${log}`) || (err as Error).message}`);
    }
    if (stoppedAtLimit) result.stoppedEarly = `stopped at the client's limit of ${permit.maxMinutes} minutes`;
    // The plan's users, not only those seen at the same moment (short plans finish before all have started).
    result.users = Math.max(result.users, check.users);
    await writeFile(path.join(ctx.outDir, "tool-jmeter.json"), JSON.stringify({ plan: name, requests: check.requests, ...result }, null, 2));
    return {
      findings: loadFindings(result, ctx.startUrl),
      summary: loadSummary(result),
      table: loadTable(result),
      reports: [{ file: "tool-jmeter.json", label: "JMeter results (JSON)" }],
      tested: `${name}: ${check.requests.length} request${check.requests.length === 1 ? "" : "s"} in the plan, up to ${result.users} users`,
    };
  },
};
