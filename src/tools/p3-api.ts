import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 3 (2026 gap report, P3) API / data checks, all in-house and read-only unless noted:
 *  - reconciliation: a total matches across two systems (CRM vs accounting).
 *  - data-quality: nulls, duplicates, ranges and freshness in a data file (Great Expectations style).
 *  - queues: an AsyncAPI spec for message queues/events is complete and valid.
 *  - tracing: distributed tracing (W3C traceparent) is propagated through the service.
 */

function pick(obj: unknown, pathExpr: string): unknown {
  return pathExpr
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((v, k) => {
      if (v && typeof v === "object") {
        const m = k.match(/^(\w+)\[(\d+)\]$/);
        if (m) return ((v as Record<string, unknown>)[m[1]] as unknown[])?.[Number(m[2])];
        return (v as Record<string, unknown>)[k];
      }
      return undefined;
    }, obj);
}

function toNumber(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Data reconciliation
// ---------------------------------------------------------------------------

/** Compares two numeric totals within a tolerance. Pure, for tests. */
export function reconcile(a: number, b: number, tolerancePct: number): { match: boolean; diff: number; diffPct: number } {
  const diff = Math.abs(a - b);
  const diffPct = a === 0 && b === 0 ? 0 : (diff / Math.max(Math.abs(a), Math.abs(b), 1)) * 100;
  return { match: diffPct <= tolerancePct, diff, diffPct };
}

export const reconciliationTool: Tool = {
  id: "reconciliation",
  name: "Data reconciliation",
  maker: "GLV Infotech (built in)",
  description:
    "Reads a total from two different systems (for example a CRM's invoice total and the accounting system's) and checks they agree within a tolerance. Billing errors often hide in the gap between two systems that should match.",
  checks: ["Fetches a value from two endpoints", "Compares them within an allowed tolerance", "Reports the exact difference when they disagree"],
  products: ["api", "crm", "saas", "ecommerce"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "uses-login",
  options: [
    { id: "urlA", label: "First endpoint (JSON)", kind: "text", required: true, pattern: "^https?://.+", placeholder: "https://crm.example.com/api/invoices/total", choices: [], default: "" },
    { id: "fieldA", label: "Field in the first answer", kind: "text", required: true, placeholder: "data.total", choices: [], default: "" },
    { id: "urlB", label: "Second endpoint (JSON)", kind: "text", required: true, pattern: "^https?://.+", placeholder: "https://books.example.com/api/revenue", choices: [], default: "" },
    { id: "fieldB", label: "Field in the second answer", kind: "text", required: true, placeholder: "revenue", choices: [], default: "" },
    { id: "tolerance", label: "Allowed difference (%)", kind: "text", placeholder: "0.5", choices: [], default: "0.5" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const { urlA, fieldA, urlB, fieldB } = ctx.options;
    const tol = Number(ctx.options.tolerance ?? "0.5") || 0.5;
    const headers: Record<string, string> = {};
    if (ctx.login?.token) headers.authorization = `Bearer ${ctx.login.token}`;
    const grab = async (url: string, field: string) => {
      const res = await fetch(url, { headers, signal: ctx.signal });
      const json = (await res.json()) as unknown;
      return toNumber(pick(json, field));
    };
    const a = await grab(urlA, fieldA);
    const b = await grab(urlB, fieldB);
    const findings: ToolFinding[] = [];
    if (a === null || b === null) throw new Error(`Could not read a number from ${a === null ? fieldA : fieldB}. Check the field path.`);
    const r = reconcile(a, b, tol);
    if (!r.match)
      findings.push({
        category: "functional",
        rule: "recon:mismatch",
        severity: "high",
        title: "The two systems disagree on the total",
        detail: `${fieldA} = ${a} and ${fieldB} = ${b} differ by ${r.diff} (${r.diffPct.toFixed(2)}%), over the ${tol}% tolerance. Find the records in one system but not the other (timing, failed sync, rounding, cancelled items).`,
        pageUrl: urlA,
        evidence: `${urlA} → ${a}\n${urlB} → ${b}`,
        key: "recon:mismatch",
      });
    ctx.log(`Reconcile: ${a} vs ${b} (${r.diffPct.toFixed(2)}%)`);
    return { findings, summary: [r.match ? `Totals agree (${a} ≈ ${b})` : `Totals differ by ${r.diffPct.toFixed(2)}%`], tested: "2 endpoints" };
  },
};

// ---------------------------------------------------------------------------
// Data quality / ETL
// ---------------------------------------------------------------------------

export interface DqRule {
  column: string;
  checks: string[];
}

/** Parses "column: not-null, unique, min=0, max=100" lines. Pure, for tests. */
export function parseRules(text: string): DqRule[] {
  const out: DqRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    out.push({ column: line.slice(0, i).trim(), checks: line.slice(i + 1).split(",").map((c) => c.trim()).filter(Boolean) });
  }
  return out;
}

/** Runs the rules over rows of objects. Pure, for tests. */
export function checkRows(rows: Record<string, unknown>[], rules: DqRule[]): { rule: string; column: string; detail: string }[] {
  const out: { rule: string; column: string; detail: string }[] = [];
  for (const r of rules) {
    const values = rows.map((row) => row[r.column]);
    for (const check of r.checks) {
      if (check === "not-null") {
        const n = values.filter((v) => v === null || v === undefined || v === "").length;
        if (n) out.push({ rule: "dq:null", column: r.column, detail: `${n} empty value(s) in "${r.column}"` });
      } else if (check === "unique") {
        const seen = new Set<string>();
        let dup = 0;
        for (const v of values) {
          const k = String(v);
          if (seen.has(k)) dup++;
          else seen.add(k);
        }
        if (dup) out.push({ rule: "dq:duplicate", column: r.column, detail: `${dup} duplicate value(s) in "${r.column}"` });
      } else if (check.startsWith("min=") || check.startsWith("max=")) {
        const bound = Number(check.slice(4));
        const bad = values.filter((v) => {
          const n = toNumber(v);
          return n !== null && (check[1] === "i" ? n < bound : n > bound);
        }).length;
        if (bad) out.push({ rule: "dq:range", column: r.column, detail: `${bad} value(s) in "${r.column}" break ${check}` });
      }
    }
  }
  return out;
}

/** A tiny CSV reader (quoted fields supported). Pure, for tests. */
export function readCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const parse = (line: string) => {
    const out: string[] = [];
    let cur = "";
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ",") {
        out.push(cur);
        cur = "";
      } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = parse(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = parse(l);
    return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""]));
  });
}

export const dataQualityTool: Tool = {
  id: "data-quality",
  name: "Data quality & ETL checks",
  maker: "GLV Infotech (built in), in the way of Great Expectations and Soda",
  description:
    "Runs data-quality expectations over an uploaded CSV or JSON export: empty values, duplicates and out-of-range numbers. For analytics pipelines and data migrations, where bad rows break reports downstream.",
  checks: ["not-null, unique, min=/max= per column", "Counts the exact number of bad rows", "Reads an uploaded CSV/JSON; nothing is changed"],
  products: ["api", "code", "saas", "crm"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://github.com/great-expectations/great_expectations",
  signedIn: "public",
  options: [
    { id: "data", label: "Data file (CSV or JSON array)", kind: "file", accept: ".csv,.json", required: true, choices: [], default: "" },
    { id: "rules", label: "Expectations", kind: "text", required: true, maxLength: 4000, placeholder: "email: not-null, unique\namount: not-null, min=0\nage: min=0, max=120", hint: "One column per line: column name, a colon, then checks (not-null, unique, min=N, max=N).", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const file = ctx.options.data;
    if (!file) throw new Error("Upload a CSV or JSON file.");
    const text = await readFile(path.join(ctx.uploadsDir, file), "utf8").catch(() => {
      throw new Error("Could not read the uploaded file.");
    });
    let rows: Record<string, unknown>[];
    if (file.toLowerCase().endsWith(".json")) {
      const parsed = JSON.parse(text) as unknown;
      rows = Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } else rows = readCsv(text);
    const rules = parseRules(ctx.options.rules ?? "");
    const problems = checkRows(rows, rules);
    const findings: ToolFinding[] = problems.map((p) => ({
      category: "functional",
      rule: p.rule,
      severity: "medium",
      title: `Data quality: ${p.detail}`,
      detail: `${p.detail} (out of ${rows.length} rows). Fix the source or add a cleaning/validation step in the pipeline before this data reaches reports.`,
      pageUrl: file,
      key: `${p.rule}:${p.column}`,
    }));
    ctx.log(`Data quality: ${rows.length} rows, ${problems.length} issue(s)`);
    return { findings, summary: [`${rows.length} rows, ${problems.length} issue(s)`], tested: `${rows.length} rows` };
  },
};

// ---------------------------------------------------------------------------
// Message queues / events (AsyncAPI)
// ---------------------------------------------------------------------------

/** Validates an AsyncAPI document's shape. Pure, for tests. */
export function asyncApiProblems(spec: Record<string, unknown>): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (!spec.asyncapi) out.push({ rule: "queue:not-asyncapi", severity: "high", title: "Not an AsyncAPI document", detail: "The file has no asyncapi version field. Provide a valid AsyncAPI 2.x/3.x spec." });
  const channels = (spec.channels ?? {}) as Record<string, Record<string, unknown>>;
  if (!Object.keys(channels).length) out.push({ rule: "queue:no-channels", severity: "medium", title: "No channels defined", detail: "The spec defines no channels (topics/queues). Add the channels your services publish/subscribe to." });
  for (const [name, ch] of Object.entries(channels)) {
    const ops = [ch.publish, ch.subscribe, ch.messages, (ch as Record<string, unknown>).send, (ch as Record<string, unknown>).receive].filter(Boolean);
    if (!ops.length) out.push({ rule: "queue:channel-no-message", severity: "low", title: `Channel "${name}" has no message`, detail: "Declare the message payload for this channel so producers and consumers agree on the schema." });
  }
  return out;
}

export const queuesTool: Tool = {
  id: "queues",
  name: "Message queues & events (AsyncAPI)",
  maker: "GLV Infotech (built in)",
  description:
    "Validates an uploaded AsyncAPI spec that describes a service's message queues and events (Kafka, RabbitMQ, SQS): channels present, message schemas defined. For microservice clients where events must stay in contract.",
  checks: ["Valid AsyncAPI document", "Channels (topics/queues) defined", "Each channel declares its message schema"],
  products: ["api", "code"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://www.asyncapi.com",
  signedIn: "public",
  options: [{ id: "spec", label: "AsyncAPI file", kind: "file", accept: ".json,.yaml,.yml", required: true, choices: [], default: "" }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const file = ctx.options.spec;
    if (!file) throw new Error("Upload an AsyncAPI JSON/YAML file.");
    const text = await readFile(path.join(ctx.uploadsDir, file), "utf8").catch(() => {
      throw new Error("Could not read the uploaded file.");
    });
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Minimal YAML-ish fallback: just look for asyncapi + channels keys.
      spec = { asyncapi: /asyncapi\s*:/.test(text) ? "yaml" : undefined, channels: /channels\s*:/.test(text) ? { _yaml: {} } : {} };
    }
    const findings: ToolFinding[] = asyncApiProblems(spec).map((p) => ({ category: "functional", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: file, key: p.rule }));
    const channels = Object.keys((spec.channels as Record<string, unknown>) ?? {}).length;
    ctx.log(`AsyncAPI: ${channels} channel(s), ${findings.length} issue(s)`);
    return { findings, summary: [`${channels} channel(s), ${findings.length} issue(s)`], tested: `${channels} channels` };
  },
};

// ---------------------------------------------------------------------------
// Distributed tracing
// ---------------------------------------------------------------------------

/** Judges trace propagation from the response headers seen. Pure, for tests. */
export function traceProblems(reqSent: string, respHeaders: Record<string, string>): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const echoed = respHeaders["traceparent"] || respHeaders["x-trace-id"] || respHeaders["x-request-id"] || respHeaders["x-b3-traceid"];
  if (!echoed)
    out.push({ rule: "trace:no-propagation", severity: "medium", title: "No trace id came back", detail: `We sent a W3C traceparent (${reqSent}) but the service returned no trace/request id header. Without trace propagation you cannot follow one request across microservices. Add OpenTelemetry (or at least echo a request id) and export traces to Jaeger/Tempo.` });
  return out;
}

export const tracingTool: Tool = {
  id: "tracing",
  name: "Distributed tracing",
  maker: "GLV Infotech (built in), with OpenTelemetry / Jaeger",
  description:
    "Sends a request with a W3C traceparent header and checks the service propagates a trace or request id back, so one request can be followed across microservices. For microservice clients tracking latency across hops.",
  checks: ["Sends a W3C traceparent header", "Checks a trace/request id is returned", "Recommends OpenTelemetry + Jaeger/Tempo when tracing is missing"],
  products: ["api"],
  category: "performance",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://opentelemetry.io",
  signedIn: "uses-login",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const url = ctx.options.url || ctx.startUrl || ctx.urls[0];
    if (!url) throw new Error("No endpoint to test.");
    const traceId = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const spanId = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    const traceparent = `00-${traceId}-${spanId}-01`;
    const headers: Record<string, string> = { traceparent };
    if (ctx.login?.token) headers.authorization = `Bearer ${ctx.login.token}`;
    const res = await fetch(url, { headers, signal: ctx.signal });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k.toLowerCase()] = v));
    const findings: ToolFinding[] = traceProblems(traceparent, respHeaders).map((p) => ({ category: "performance", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, key: p.rule }));
    ctx.log(`Tracing: ${findings.length ? "no trace id returned" : "trace id propagated"}`);
    return { findings, summary: [findings.length ? "No trace propagation" : "Trace id propagated"], tested: url };
  },
};
