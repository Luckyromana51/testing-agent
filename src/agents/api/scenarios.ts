import { randomUUID } from "node:crypto";
import { readPath } from "../../engines/api-auth.js";
import { validateSchema, type ApiOperation } from "../../engines/openapi.js";
import { finding } from "../../runner/finding.js";
import type { ApiScenario, ApiScenarioResult, ApiScenarioStep, Finding, RoleLogin } from "../../types.js";
import type { ApiCall, ApiContext } from "./context.js";
import { documentedResponse, type ApiAgent } from "./shared.js";

/*
 * API scenarios: tests written in plain words, like Postman tests and Karate, one step a line.
 *
 *   GET /orders
 *   expect status 200
 *   save id = $.data[0].id
 *   GET /orders/{{id}}
 *   expect $.total > 0
 *   expect time < 800
 *
 * Requests that change data run only on a test server. Clean-up steps always run at the end.
 */

export type Step =
  | { kind: "request"; method: string; path: string }
  | { kind: "header"; name: string; value: string }
  | { kind: "body"; value: string }
  | { kind: "as"; who: string }
  | { kind: "save"; name: string; from: string }
  | { kind: "set"; name: string; value: string }
  | { kind: "wait"; ms: number }
  | { kind: "expect"; what: string };

export interface ParsedLine {
  line: number;
  text: string;
  step: Step;
}

const METHODS = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)$/i;

/** Reads a scenario's text; throws with the line number on a line it does not understand. */
export function parseScenario(text: string, offset = 0): ParsedLine[] {
  const out: ParsedLine[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) return;
    const line = i + 1 + offset;
    let m: RegExpExecArray | null;
    let step: Step | undefined;
    if ((m = METHODS.exec(t))) step = { kind: "request", method: m[1].toUpperCase(), path: m[2] };
    else if ((m = /^header\s+([\w-]+)\s*:\s*(.*)$/i.exec(t))) step = { kind: "header", name: m[1], value: m[2] };
    else if ((m = /^body\s+(.+)$/i.exec(t))) step = { kind: "body", value: m[1] };
    else if ((m = /^as\s+(.+)$/i.exec(t))) step = { kind: "as", who: m[1].trim() };
    else if ((m = /^save\s+(\w+)\s*=\s*(.+)$/i.exec(t))) step = { kind: "save", name: m[1], from: m[2].trim() };
    else if ((m = /^set\s+(\w+)\s*=\s*(.*)$/i.exec(t))) step = { kind: "set", name: m[1], value: m[2] };
    else if ((m = /^wait\s+(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(t))) step = { kind: "wait", ms: Math.min(30_000, Number(m[1]) * (m[2]?.toLowerCase() === "ms" ? 1 : 1000)) };
    else if ((m = /^expect\s+(.+)$/i.exec(t))) {
      parseExpect(m[1], line);
      step = { kind: "expect", what: m[1] };
    }
    if (!step) throw new Error(`Line ${line}: "${t.slice(0, 60)}" is not a step. Steps start with GET, POST, PUT, PATCH, DELETE, header, body, as, save, set, wait or expect.`);
    if (step.kind === "body") {
      try {
        JSON.parse(step.value);
      } catch {
        if (!/\{\{/.test(step.value)) throw new Error(`Line ${line}: the body is not valid JSON.`);
      }
    }
    out.push({ line, text: t, step });
  });
  if (!out.some((l) => l.step.kind === "request") && out.length) throw new Error("A scenario needs at least one request line, like GET /users.");
  return out;
}

type Check =
  | { kind: "status"; codes: string[] }
  | { kind: "time"; op: "<" | "<="; ms: number }
  | { kind: "schema" }
  | { kind: "header"; name: string; op: "exists" | "contains"; value?: string }
  | { kind: "json"; path: string; op: string; value?: string; length?: boolean };

/** "status 200", "status 2xx or 404", "time < 800", "schema", "header location exists", "$.items length > 0", "$.name == Asha". */
export function parseExpect(text: string, line = 0): Check {
  const t = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^status\s+(.+)$/i.exec(t))) {
    const codes = m[1].split(/\s*(?:,|or)\s*/i).map((c) => c.trim().toLowerCase());
    if (codes.some((c) => !/^[1-5](\d\d|xx)$/.test(c))) throw new Error(`Line ${line}: write the status as a number like 200, or 2xx.`);
    return { kind: "status", codes };
  }
  if ((m = /^time\s*(<=?)\s*(\d+)\s*(ms|s)?$/i.exec(t))) return { kind: "time", op: m[1] as "<" | "<=", ms: Number(m[2]) * (m[3]?.toLowerCase() === "s" ? 1000 : 1) };
  if (/^(schema|matches the file|matches schema)$/i.test(t)) return { kind: "schema" };
  if ((m = /^header\s+([\w-]+)\s+(exists|contains\s+(.+))$/i.exec(t))) return { kind: "header", name: m[1].toLowerCase(), op: m[3] !== undefined ? "contains" : "exists", value: m[3]?.trim() };
  if ((m = /^(\$[^\s]*)\s+(length\s+)?(exists|missing|is\s+(?:string|number|boolean|array|object|null)|==|!=|>=|<=|>|<|contains|matches)\s*(.*)$/i.exec(t))) {
    const op = m[3].toLowerCase().replace(/\s+/g, " ");
    if (["==", "!=", ">", "<", ">=", "<=", "contains", "matches"].includes(op) && !m[4]) throw new Error(`Line ${line}: "${op}" needs a value after it.`);
    return { kind: "json", path: m[1], op, value: m[4] || undefined, length: Boolean(m[2]) };
  }
  throw new Error(`Line ${line}: "expect ${t.slice(0, 50)}" is not a check. Try: expect status 200, expect time < 800, expect schema, expect header content-type contains json, expect $.items length > 0, expect $.name == Asha.`);
}

const fmt = (v: unknown) => (v === undefined ? "nothing" : typeof v === "string" ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : JSON.stringify(v)?.slice(0, 80));

function literal(v: string): unknown {
  const t = v.trim();
  if (/^".*"$/.test(t) || /^'.*'$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  if (t === "null") return null;
  return t;
}

/** Runs one check on an answer: ok, and what was found (never a timing in the issue text). */
export function runCheck(check: Check, c: ApiCall, spec: unknown): { ok: boolean; actual?: string } {
  switch (check.kind) {
    case "status": {
      const s = String(c.status ?? "none");
      return { ok: check.codes.some((code) => (code.endsWith("xx") ? s[0] === code[0] : s === code)), actual: `HTTP ${c.status ?? "no answer"}` };
    }
    case "time":
      return { ok: c.status !== null && (check.op === "<" ? c.ms < check.ms : c.ms <= check.ms), actual: `${c.ms} ms` };
    case "schema": {
      const doc = c.status !== null ? documentedResponse(c.op, c.status) : undefined;
      if (!doc?.schema) return { ok: false, actual: "the file documents no answer shape for this status" };
      const p = validateSchema(spec, doc.schema, c.json);
      return { ok: p.length === 0, actual: p.slice(0, 2).join("; ") || "matches" };
    }
    case "header": {
      const v = c.headers[check.name];
      if (check.op === "exists") return { ok: v !== undefined, actual: v === undefined ? "not sent" : v.slice(0, 80) };
      return { ok: v !== undefined && v.toLowerCase().includes((check.value ?? "").toLowerCase()), actual: v?.slice(0, 80) ?? "not sent" };
    }
    case "json": {
      let v = readPath(c.json, check.path);
      if (check.length) v = Array.isArray(v) || typeof v === "string" ? v.length : undefined;
      const want = check.value !== undefined ? literal(check.value) : undefined;
      const actual = fmt(v);
      switch (check.op) {
        case "exists":
          return { ok: v !== undefined, actual };
        case "missing":
          return { ok: v === undefined, actual };
        case "==":
          return { ok: JSON.stringify(v) === JSON.stringify(want) || String(v) === String(want), actual };
        case "!=":
          return { ok: !(JSON.stringify(v) === JSON.stringify(want) || String(v) === String(want)), actual };
        case ">":
        case "<":
        case ">=":
        case "<=": {
          const a = Number(v);
          const b = Number(want);
          if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, actual };
          return { ok: check.op === ">" ? a > b : check.op === "<" ? a < b : check.op === ">=" ? a >= b : a <= b, actual };
        }
        case "contains":
          return { ok: Array.isArray(v) ? v.some((x) => String(x) === String(want)) : String(v ?? "").includes(String(want)), actual };
        case "matches":
          try {
            const src = String(want).replace(/^\/(.*)\/$/, "$1");
            return { ok: new RegExp(src).test(String(v ?? "")), actual };
          } catch {
            return { ok: false, actual: "the pattern is not valid" };
          }
        default: {
          const type = check.op.replace(/^is /, "");
          const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
          return { ok: t === type, actual: t };
        }
      }
    }
  }
}

/** Fills {{name}}, {{random}}, {{today}} and {{uuid}}. */
function fill(text: string, vars: Map<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => {
    if (vars.has(k)) return vars.get(k)!;
    if (k === "random") return `glv${Math.random().toString(36).slice(2, 8)}`;
    if (k === "today") return new Date().toISOString().slice(0, 10);
    if (k === "uuid") return randomUUID();
    return m;
  });
}

const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function runScenario(s: ApiScenario, ctx: ApiContext): Promise<ApiScenarioResult> {
  const started = Date.now();
  const steps: ApiScenarioStep[] = [];
  const blocked: string[] = [];
  const vars = new Map<string, string>();
  const main = parseScenario(s.steps);
  const cleanup = s.cleanup ? parseScenario(s.cleanup, 1000).map((l) => ({ ...l, line: l.line - 1000, cleanup: true })) : [];
  let failed: string | undefined;
  let headers: Record<string, string> = {};
  let body: string | undefined;
  let as: false | RoleLogin | undefined;
  let last: { call: ApiCall; step: ApiScenarioStep } | undefined;

  const run = async (l: ParsedLine & { cleanup?: boolean }) => {
    const st = l.step;
    if (st.kind === "request") {
      const path = fill(st.path, vars);
      const url = /^https?:\/\//.test(path) ? path : `${ctx.parsed.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;
      const step: ApiScenarioStep = { line: l.line, text: l.text, ok: true, ...(l.cleanup ? { cleanup: true } : {}) };
      steps.push(step);
      if (new URL(url).origin !== new URL(ctx.parsed.baseUrl).origin) {
        step.ok = false;
        step.error = "Scenarios only call the API being tested.";
        throw new Error(step.error);
      }
      if (WRITE.has(st.method) && !ctx.testServer) {
        step.ok = false;
        step.error = "Not sent: it changes data, and this project is not marked as a test server.";
        blocked.push(`${st.method} ${path}`);
        throw new Error(step.error);
      }
      const op: ApiOperation =
        [...ctx.parsed.operations, ...ctx.parsed.writes].find((o) => o.method === st.method && new RegExp(`^${o.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\\?\{[^}]+\\?\}/g, "[^/]+")}$`).test(new URL(url).pathname.slice(new URL(ctx.parsed.baseUrl).pathname.replace(/\/$/, "").length))) ??
        { method: st.method, path: new URL(url).pathname, url, title: l.text, secured: false, responses: {} };
      const filledHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), fill(v, vars)]));
      let sentBody: unknown;
      if (body !== undefined) {
        const b = fill(body, vars);
        try {
          sentBody = JSON.parse(b);
        } catch {
          sentBody = b;
        }
      }
      const c = await ctx.send({ method: st.method, url, headers: filledHeaders, body: sentBody, as }, op);
      headers = {};
      body = undefined;
      last = { call: c, step };
      step.call = { method: st.method, path, url, status: c.status, ms: c.ms, bytes: c.bytes ?? c.text.length, contentType: c.contentType, requestHeaders: filledHeaders, ...(c.sent?.body ? { requestBody: c.sent.body.slice(0, 4000) } : {}), responseHeaders: {}, body: c.text.slice(0, 4000), ...(c.error ? { error: c.error } : {}) };
      if (c.status === null) {
        step.ok = false;
        step.error = `No answer: ${c.error ?? "the connection failed"}`;
        throw new Error(step.error);
      }
      return;
    }
    if (st.kind === "header") headers[st.name] = st.value;
    else if (st.kind === "body") body = st.value;
    else if (st.kind === "as") {
      if (/^(nobody|no login|anonymous)$/i.test(st.who)) as = false;
      else if (/^(main|main login|me)$/i.test(st.who)) as = undefined;
      else {
        const role = ctx.roles.find((r) => r.name.toLowerCase() === st.who.toLowerCase());
        if (!role) throw new Error(`Line ${l.line}: no other account is called "${st.who}".`);
        as = role;
      }
    } else if (st.kind === "set") vars.set(st.name, fill(st.value, vars));
    else if (st.kind === "wait") await new Promise((r) => setTimeout(r, st.ms));
    else if (st.kind === "save") {
      if (!last) throw new Error(`Line ${l.line}: "save" needs a request before it.`);
      const m = /^header\s+([\w-]+)$/i.exec(st.from);
      const v = m ? last.call.headers[m[1].toLowerCase()] : readPath(last.call.json, st.from);
      if (v === undefined || v === null || typeof v === "object") {
        last.step.ok = false;
        const err = `Line ${l.line}: nothing to save at ${st.from}`;
        (last.step.checks ??= []).push({ line: l.line, text: l.text, ok: false, actual: fmt(v) });
        throw new Error(err);
      }
      vars.set(st.name, String(v));
      (last.step.checks ??= []).push({ line: l.line, text: l.text, ok: true, actual: fmt(v) });
    } else if (st.kind === "expect") {
      if (!last) throw new Error(`Line ${l.line}: "expect" needs a request before it.`);
      const r = runCheck(parseExpect(st.what, l.line), last.call, ctx.spec);
      (last.step.checks ??= []).push({ line: l.line, text: l.text, ok: r.ok, actual: r.actual });
      if (!r.ok) {
        last.step.ok = false;
        throw new Error(`Line ${l.line}: ${l.text}`);
      }
    }
  };

  for (const l of main) {
    try {
      await run(l);
    } catch (err) {
      failed = (err as Error).message;
      break;
    }
  }
  // Clean-up always runs, with the values saved so far.
  as = undefined;
  headers = {};
  body = undefined;
  for (const l of cleanup) {
    try {
      await run(l);
    } catch {
      /* the next clean-up step still runs */
    }
  }
  return { id: s.id, name: s.name, ok: !failed, ms: Date.now() - started, steps, ...(failed ? { error: failed } : {}), ...(blocked.length ? { blocked } : {}) };
}

export const apiScenariosAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.scenarios",
  name: "API scenarios",
  description:
    "Runs the project's API scenarios: requests written in plain words, values saved from one answer and used in the next, and checks on status, fields, headers, time and the file's schema. Clean-up steps always run. Requests that change data run only on a test server.",
  category: "functional",
  async run(ctx) {
    if (!ctx.scenarios.length) return [];
    const out: Finding[] = [];
    const results: ApiScenarioResult[] = [];
    for (const s of ctx.scenarios) {
      ctx.log(`Scenario "${s.name}"`);
      let r: ApiScenarioResult;
      try {
        r = await runScenario(s, ctx);
      } catch (err) {
        r = { id: s.id, name: s.name, ok: false, ms: 0, steps: [], error: (err as Error).message };
      }
      results.push(r);
      if (!r.ok) {
        // The failing line is the evidence: the same failure gives the same issue every time.
        const step = [...r.steps].reverse().find((x) => !x.ok);
        const check = step?.checks?.find((x) => !x.ok);
        out.push(
          finding({
            category: "functional",
            rule: "api:scenario-failed",
            severity: r.blocked?.length ? "info" : "high",
            title: r.blocked?.length ? `Scenario "${s.name}" needs a test server` : `Scenario "${s.name}" fails`,
            detail: r.blocked?.length
              ? `The scenario sends ${r.blocked[0]}, which changes data. It runs only when the project is marked as a test server.`
              : `${check ? `${check.text}: found ${check.actual}.` : (r.error ?? "It stopped.")} The Scenarios tab shows every step with its request and answer.`,
            pageUrl: `${ctx.parsed.baseUrl}#scenario-${s.id}`,
            evidence: check ? `Line ${check.line}: ${check.text}` : (step ? `Line ${step.line}: ${step.text}` : (r.error ?? s.name)),
          }),
        );
      }
    }
    ctx.report.scenarios = results;
    return out;
  },
};

export const MAX_SCENARIOS = 30;

/** Checks a scenario entered on the project page. */
export function cleanScenario(input: Record<string, unknown>, i: number): ApiScenario {
  const name = String(input.name ?? "").trim().slice(0, 80) || `Scenario ${i + 1}`;
  const steps = String(input.steps ?? "").slice(0, 8000);
  const cleanup = String(input.cleanup ?? "").slice(0, 4000).trim();
  try {
    parseScenario(steps);
    if (cleanup) parseScenario(cleanup);
  } catch (err) {
    throw new Error(`Scenario "${name}": ${(err as Error).message}`);
  }
  return {
    id: String(input.id ?? "").replace(/[^\w-]/g, "").slice(0, 20) || `s${Date.now().toString(36)}${i}`,
    name,
    steps,
    ...(cleanup ? { cleanup } : {}),
    ...(input.off ? { off: true } : {}),
  };
}
