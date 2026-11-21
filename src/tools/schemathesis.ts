import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { authParts } from "../engines/api.js";
import type { Category, Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface Failure {
  type: string;
  code: string;
  operation: string;
  title: string;
  message?: string;
  case_id: string;
  severity?: string;
}
interface Interaction {
  request: { method: string; uri: string };
  response?: { status_code: number; elapsed?: number };
}
interface Scenario {
  ScenarioFinished?: {
    status: string;
    phase?: string;
    recorder: {
      label: string;
      cases: Record<string, { value: { meta?: { generation?: { mode?: string } } } }>;
      checks: Record<string, { name: string; status: string; failure_info?: { failure: Failure } }[]>;
      interactions: Record<string, Interaction>;
    };
  };
}

/** What each kind of failure means for the client, and the platform's own check for the same problem. */
const KINDS: Record<string, { category: Category; severity: Severity; title: string; fix: string; sameAs?: string[] }> = {
  ST101: {
    category: "functional",
    severity: "high",
    title: "Server error",
    fix: "Find the error in the server log for this request and handle the input; the API should answer 4xx for bad input, never 5xx.",
    sameAs: ["api:server-error", "api:bad-input-crash"],
  },
  ST103: {
    category: "functional",
    severity: "low",
    title: "Status code not in the API file",
    fix: "Add the status code to the endpoint's responses in the OpenAPI file, or change the code to answer with a documented one.",
    sameAs: ["api:undocumented-status"],
  },
  ST105: {
    category: "functional",
    severity: "low",
    title: "Content type not in the API file",
    fix: "Answer with the content type the OpenAPI file promises (usually application/json), or document the one sent.",
    sameAs: ["api:json-content-type", "api:not-json"],
  },
  ST108: {
    category: "functional",
    severity: "medium",
    title: "Answer does not match the API file",
    fix: "Make the answer match the schema in the OpenAPI file (field names, types and required fields), or fix the file: apps built from it will break.",
    sameAs: ["api:schema-mismatch"],
  },
  ST109: {
    category: "functional",
    severity: "high",
    title: "Answer is not valid JSON",
    fix: "Send valid JSON: apps that read this endpoint will fail.",
    sameAs: ["api:invalid-json"],
  },
  ST401: {
    category: "security",
    severity: "high",
    title: "Endpoint works without a valid login",
    fix: "Check the login on the server for this endpoint: it answered with data although the login was missing or wrong.",
    sameAs: ["api:auth-bypass", "api:public-marked-secured"],
  },
};

/** "/users/{id}" from "GET /users/{id}". */
const pathOf = (operation: string) => operation.replace(/^[A-Z]+\s+/, "");

/** Without the API key, when the login is a key in the query string. */
function cleanUri(uri: string, hideParam?: string): string {
  try {
    const u = new URL(uri);
    if (hideParam && u.searchParams.has(hideParam)) u.searchParams.set(hideParam, "[hidden]");
    return u.toString();
  } catch {
    return uri;
  }
}

/**
 * Turns Schemathesis' event log into findings: one per kind of failure and endpoint, with an
 * example request that shows it and what the API answered.
 */
export function readSchemathesis(ndjson: string, hideParam?: string): { findings: ToolFinding[]; tested: Set<string>; cases: number } {
  const groups = new Map<string, { f: Failure; uri: string; status?: number; negative: boolean; count: number }>();
  const tested = new Set<string>();
  let cases = 0;
  for (const line of ndjson.split("\n")) {
    if (!line.startsWith("{")) continue;
    let ev: Scenario;
    try {
      ev = JSON.parse(line) as Scenario;
    } catch {
      continue;
    }
    const s = ev.ScenarioFinished;
    if (!s) continue;
    if (s.status !== "skip") tested.add(s.recorder.label);
    cases += Object.keys(s.recorder.cases ?? {}).length;
    for (const [caseId, checks] of Object.entries(s.recorder.checks ?? {})) {
      for (const c of checks) {
        const f = c.failure_info?.failure;
        if (c.status !== "failure" || !f) continue;
        const k = `${f.code}|${f.operation}`;
        const g = groups.get(k);
        if (g) {
          g.count++;
          continue;
        }
        const it = s.recorder.interactions?.[caseId];
        const mode = s.recorder.cases?.[caseId]?.value.meta?.generation?.mode;
        groups.set(k, { f, uri: cleanUri(it?.request.uri ?? "", hideParam), status: it?.response?.status_code, negative: mode === "negative", count: 1 });
      }
    }
  }
  const findings: ToolFinding[] = [];
  for (const { f, uri, status, negative, count } of groups.values()) {
    // A 5xx is reported once, as a server error, not also as a status code missing from the file.
    if (f.code === "ST103" && status !== undefined && status >= 500 && groups.has(`ST101|${f.operation}`)) continue;
    const kind = KINDS[f.code] ?? {
      category: "functional" as Category,
      severity: f.severity === "critical" || f.severity === "high" ? ("medium" as Severity) : ("low" as Severity),
      title: f.title,
      fix: "See the message and the example request.",
    };
    const title = f.code === "ST101" && status ? `${kind.title} (HTTP ${status})` : kind.title;
    findings.push({
      category: kind.category,
      severity: f.code === "ST101" && negative ? "medium" : kind.severity,
      rule: `schemathesis:${f.code}`,
      title: `${title}: ${f.operation}`,
      detail: `${f.message ? `${f.message.replace(/\s+/g, " ").slice(0, 400).replace(/\.?$/, ".")} ` : ""}${negative ? "It happened with input the API file does not allow. " : ""}${kind.fix}${
        count > 1 ? ` Seen ${count} times.` : ""
      }`,
      pageUrl: uri.split("?")[0] || f.operation,
      evidence: `GET ${uri}${status ? ` -> HTTP ${status}` : ""}`,
      ...(kind.sameAs ? { sameAs: kind.sameAs, sameScope: "endpoint" as const, sameText: pathOf(f.operation) } : {}),
    });
  }
  return { findings, tested, cases };
}

const CHECKS = ["not_a_server_error", "status_code_conformance", "content_type_conformance", "response_headers_conformance", "response_schema_conformance"];

export const schemathesisTool: Tool = {
  id: "schemathesis",
  name: "Schemathesis",
  maker: "Schemathesis (open source)",
  description: "Generates many test calls from the OpenAPI file and checks every answer against it. Sends GET requests only.",
  checks: [
    "Tens of generated calls per endpoint, with edge-case values the file allows",
    "Server errors, answers that break the schema, wrong status codes and content types",
    "Endpoints that answer without a valid login (when a login is saved)",
    "Each problem comes with the request that shows it",
  ],
  products: ["api"],
  category: "functional",
  safety: "safe",
  takes: "1 to 5 minutes",
  licence: "MIT",
  homepage: "https://schemathesis.io",
  signedIn: "uses-login",
  options: [
    {
      id: "examples",
      label: "Calls per endpoint",
      choices: [
        { value: "10", label: "Up to 10 (quick)" },
        { value: "30", label: "Up to 30" },
        { value: "100", label: "Up to 100 (thorough)" },
      ],
      default: "30",
    },
    {
      id: "mode",
      label: "Inputs",
      choices: [
        { value: "positive", label: "Only inputs the API file allows" },
        { value: "all", label: "Also wrong inputs (still GET only)" },
      ],
      default: "positive",
      hint: "Wrong inputs check the API answers 4xx, not a crash.",
    },
  ],

  async ready() {
    return (await which(process.env.SCHEMATHESIS_PATH || "st")) ? null : "Schemathesis is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const location = ctx.specFile ?? ctx.target.specUrl;
    if (!location) throw new Error("The project has no OpenAPI file.");
    const dir = path.join(ctx.workDir, "schemathesis");
    // The saved login goes in through the environment, never on the command line or on disk.
    const auth = ctx.login?.kind === "api" ? authParts(ctx.login) : undefined;
    const env: NodeJS.ProcessEnv = { ...process.env };
    const headers: string[] = [];
    Object.entries(auth?.headers ?? {}).forEach(([name, value], i) => {
      env[`GLV_AUTH_${i}`] = value;
      headers.push(`${JSON.stringify(name)} = "\${GLV_AUTH_${i}}"`);
    });
    const params = auth?.query ? [`${JSON.stringify(`query.${auth.query[0]}`)} = "\${GLV_AUTH_QUERY}"`] : [];
    if (auth?.query) env.GLV_AUTH_QUERY = auth.query[1];
    const config = path.join(ctx.workDir, "schemathesis.toml");
    await writeFile(
      config,
      [
        ...(headers.length ? [`headers = { ${headers.join(", ")} }`] : []),
        ...(params.length ? [`parameters = { ${params.join(", ")} }`] : []),
        // The coverage phase would otherwise also try POST, PUT, DELETE and other methods on every
        // path to see they are refused: never on a live API.
        "[phases.coverage]",
        "unexpected-methods = []",
        "",
      ].join("\n"),
    );
    const checks = [...CHECKS, ...(ctx.options.mode === "all" ? ["negative_data_rejection"] : []), ...(auth ? ["ignored_auth"] : [])];
    const res = await runProcess(
      process.env.SCHEMATHESIS_PATH || "st",
      [
        "--config-file",
        config,
        "run",
        location,
        ...(ctx.target.url ? ["--url", ctx.target.url] : []),
        // Read-only on a live API: only GET operations, and no check that tries other methods.
        "--include-method",
        "GET",
        "--checks",
        checks.join(","),
        "--mode",
        ctx.options.mode === "all" ? "all" : "positive",
        "--max-examples",
        ctx.options.examples ?? "30",
        "--phases",
        "examples,coverage,fuzzing",
        "--rate-limit",
        "10/s",
        "--request-timeout",
        "15",
        "--workers",
        "2",
        "--generation-database",
        "none",
        "--suppress-health-check",
        "all",
        "--warnings",
        "off",
        "--report",
        "ndjson,junit",
        "--report-dir",
        dir,
        "--no-color",
      ],
      { signal: ctx.signal, timeoutMs: 900_000, cwd: ctx.workDir, env },
    );
    const files = await readdir(dir).catch(() => [] as string[]);
    const ndjson = files.find((f) => f.endsWith(".ndjson"));
    // 0: all passed, 1: failures found. Other codes, or no event log, mean it could not test.
    if ((res.code !== 0 && res.code !== 1) || !ndjson) {
      throw new Error(`Schemathesis could not test the API: ${lastLine(res.stdout.replace(/\n[=\s]+$/, "")) || lastLine(res.stderr) || `exit code ${res.code}`}`);
    }
    const { findings, tested, cases } = readSchemathesis(await readFile(path.join(dir, ndjson), "utf8"), auth?.query?.[0]);
    if (!tested.size) throw new Error("Schemathesis found no GET endpoints it could call.");
    const junit = files.find((f) => f.endsWith(".xml"));
    const reports = [];
    if (junit) {
      await writeFile(path.join(ctx.outDir, "tool-schemathesis.xml"), await readFile(path.join(dir, junit)));
      reports.push({ file: "tool-schemathesis.xml", label: "Schemathesis results (JUnit XML)" });
    }
    return {
      findings,
      summary: [`${cases.toLocaleString("en-IN")} generated calls on ${tested.size} GET endpoint${tested.size === 1 ? "" : "s"}`, `${findings.length} problem${findings.length === 1 ? "" : "s"} found`],
      reports,
      tested: `${tested.size} GET endpoints`,
    };
  },
};
