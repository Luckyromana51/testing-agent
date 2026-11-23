import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseSpecText } from "../engines/openapi.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * OpenAPI breaking-change diff and lint, in the way oasdiff and Spectral work: the client gives the
 * previous version of their API spec and GLV compares it with the current one, listing changes that
 * would break the apps and partners already calling the API (a removed endpoint, a new required
 * parameter, a removed field). It also lints the current spec for missing descriptions, operation
 * ids, error responses and security. It only reads the two spec files, so it is safe.
 */

type Json = Record<string, any>;

export interface Op {
  method: string;
  path: string;
  params: { name: string; in: string; required: boolean }[];
  requestRequired: string[];
  responses: string[];
  operationId?: string;
  summary?: string;
  security?: boolean;
}

/** Flattens an OpenAPI document into a list of operations. Pure, for tests. */
export function operations(spec: Json): Op[] {
  const out: Op[] = [];
  const paths = (spec.paths ?? {}) as Record<string, Json>;
  const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
  for (const [p, item] of Object.entries(paths)) {
    const shared = (item.parameters ?? []) as Json[];
    for (const m of methods) {
      const op = item[m] as Json | undefined;
      if (!op) continue;
      const params = [...shared, ...((op.parameters ?? []) as Json[])].map((x) => ({ name: String(x.name ?? ""), in: String(x.in ?? ""), required: Boolean(x.required) }));
      const schema = op.requestBody?.content?.["application/json"]?.schema ?? {};
      const requestRequired = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      out.push({
        method: m.toUpperCase(),
        path: p,
        params,
        requestRequired,
        responses: Object.keys(op.responses ?? {}),
        operationId: op.operationId,
        summary: op.summary ?? op.description,
        security: op.security !== undefined || spec.security !== undefined,
      });
    }
  }
  return out;
}

export interface Change {
  rule: string;
  severity: "high" | "medium" | "low";
  title: string;
  where: string;
}

/** Breaking (and risky) changes from an old spec to a new one. Pure, for tests. */
export function breakingChanges(oldSpec: Json, newSpec: Json): Change[] {
  const out: Change[] = [];
  const oldOps = operations(oldSpec);
  const newOps = operations(newSpec);
  const find = (ops: Op[], o: Op) => ops.find((x) => x.method === o.method && x.path === o.path);
  for (const o of oldOps) {
    const n = find(newOps, o);
    const where = `${o.method} ${o.path}`;
    if (!n) {
      out.push({ rule: "apidiff:endpoint-removed", severity: "high", title: `Endpoint removed: ${where}`, where });
      continue;
    }
    for (const rr of n.requestRequired) if (!o.requestRequired.includes(rr)) out.push({ rule: "apidiff:new-required-field", severity: "high", title: `New required request field "${rr}" on ${where}`, where });
    for (const np of n.params.filter((x) => x.required)) {
      const op = o.params.find((x) => x.name === np.name && x.in === np.in);
      if (!op) out.push({ rule: "apidiff:new-required-param", severity: "high", title: `New required parameter "${np.name}" (${np.in}) on ${where}`, where });
      else if (!op.required) out.push({ rule: "apidiff:param-now-required", severity: "high", title: `Parameter "${np.name}" is now required on ${where}`, where });
    }
    for (const op of o.params) if (!n.params.find((x) => x.name === op.name && x.in === op.in)) out.push({ rule: "apidiff:param-removed", severity: "medium", title: `Parameter "${op.name}" (${op.in}) removed from ${where}`, where });
    for (const r of o.responses) if (/^2/.test(r) && !n.responses.includes(r)) out.push({ rule: "apidiff:success-response-removed", severity: "medium", title: `Success response ${r} removed from ${where}`, where });
  }
  return out;
}

/** Style/quality problems in a spec (a light Spectral). Pure, for tests. */
export function lintProblems(spec: Json): Change[] {
  const out: Change[] = [];
  for (const o of operations(spec)) {
    const where = `${o.method} ${o.path}`;
    if (!o.operationId) out.push({ rule: "apilint:no-operation-id", severity: "low", title: `No operationId on ${where}`, where });
    if (!o.summary) out.push({ rule: "apilint:no-summary", severity: "low", title: `No summary or description on ${where}`, where });
    if (!o.responses.some((r) => /^(4|5)/.test(r) || r === "default")) out.push({ rule: "apilint:no-error-response", severity: "low", title: `No error (4xx/5xx) response documented on ${where}`, where });
    if (!o.security && o.method !== "GET") out.push({ rule: "apilint:no-security", severity: "medium", title: `No security scheme on ${where} (a write endpoint)`, where });
  }
  if (!spec.info?.description) out.push({ rule: "apilint:no-info-description", severity: "low", title: "The API has no top-level description", where: "info" });
  if (!spec.servers?.length && !spec.host) out.push({ rule: "apilint:no-servers", severity: "low", title: "No servers listed, so callers cannot tell the base URL", where: "servers" });
  return out;
}

const list = (items: string[], max = 15) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");

export const openapiDiffTool: Tool = {
  id: "openapi-diff",
  name: "API breaking-change and lint",
  maker: "GLV Infotech (built in), in the way of oasdiff and Spectral",
  description:
    "Compares the previous version of an OpenAPI spec with the current one and lists changes that break the apps and partners already calling it (removed endpoints, new required parameters or fields, removed responses). Also lints the current spec for missing descriptions, operation ids, error responses and security.",
  checks: ["Removed endpoints, parameters and success responses", "New required parameters or request fields (break existing callers)", "Missing operationId, summary, error responses and security"],
  products: ["api"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://github.com/Tufin/oasdiff",
  signedIn: "public",
  options: [{ id: "old", label: "Previous spec version", kind: "file", accept: ".json,.yaml,.yml", required: true, hint: "Upload the last released OpenAPI file. The current one is the project's own spec.", choices: [], default: "" }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    if (!ctx.specFile) throw new Error("This project has no current OpenAPI spec. Add one as the API target's spec.");
    const oldFile = ctx.options.old ? path.join(ctx.uploadsDir, ctx.options.old) : "";
    if (!oldFile) throw new Error("Upload the previous version of the spec to diff against.");
    const newSpec = parseSpecText(await readFile(ctx.specFile, "utf8")) as Json;
    const oldSpec = parseSpecText(await readFile(oldFile, "utf8")) as Json;
    const breaks = breakingChanges(oldSpec, newSpec);
    const lint = lintProblems(newSpec);
    ctx.log(`OpenAPI diff: ${breaks.length} breaking changes, ${lint.length} lint issues`);
    const findings: ToolFinding[] = [];
    const byRule = (changes: Change[]) => {
      const groups = new Map<string, Change[]>();
      for (const c of changes) (groups.get(c.rule) ?? groups.set(c.rule, []).get(c.rule)!).push(c);
      return groups;
    };
    for (const [rule, group] of byRule(breaks)) {
      const first = group[0];
      findings.push({
        category: "functional",
        rule,
        severity: first.severity,
        title: group.length === 1 ? first.title : `${group.length} × ${first.title.replace(/:.*/, "")}`,
        detail:
          "This change breaks apps and partners already calling the API. Version the API (a new path prefix or header), keep the old behaviour until callers move, and announce a deprecation window. Make new fields optional with a default.",
        pageUrl: "openapi",
        evidence: list(group.map((c) => c.title)),
        key: rule,
      });
    }
    for (const [rule, group] of byRule(lint)) {
      const first = group[0];
      findings.push({
        category: "functional",
        rule,
        severity: first.severity,
        title: group.length === 1 ? first.title : `${group.length} endpoints: ${first.title.replace(/ on .*/, "")}`,
        detail: "Documenting these makes the API easier to use and safer. Add the missing field to the spec.",
        pageUrl: "openapi",
        evidence: list(group.map((c) => c.where)),
        key: rule,
      });
    }
    return {
      findings,
      summary: [`${breaks.length} breaking change${breaks.length === 1 ? "" : "s"}, ${lint.length} lint issue${lint.length === 1 ? "" : "s"}`],
      tested: "Previous vs current OpenAPI spec",
    };
  },
};
