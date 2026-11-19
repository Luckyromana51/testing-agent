import { deref, parseSpec, type ApiOperation, type Json } from "../../engines/openapi.js";
import { finding } from "../../runner/finding.js";
import type { ApiChange, Finding } from "../../types.js";
import type { ApiAgent } from "./shared.js";

/*
 * Breaking changes, like oasdiff and Optic: the API file is compared with the approved copy (the
 * first test's file, or the one approved on the Changes tab). Removed endpoints, removed answer
 * fields, new required inputs, changed types and removed values break apps built on the old file.
 * They stay issues until the change is undone or approved as the new version.
 */

const key = (o: ApiOperation) => `${o.method} ${o.path.replace(/\{[^}]+\}/g, "{}")}`;

/** The fields of a schema, flattened one level into objects ("customer.email"), with their types. */
function shape(spec: Json, schema: Json, prefix = "", out = new Map<string, { type: string; enum?: unknown[]; required: boolean }>(), depth = 0, required = true) {
  const s = deref(spec, schema);
  if (!s || typeof s !== "object" || depth > 3) return out;
  for (const part of s.allOf ?? []) shape(spec, part, prefix, out, depth + 1, required);
  if (s.type === "array" && s.items) return shape(spec, s.items, `${prefix}[]`, out, depth + 1, required);
  const req = new Set<string>(s.required ?? []);
  for (const [k, raw] of Object.entries<Json>(s.properties ?? {})) {
    const d = deref(spec, raw);
    const name = prefix ? `${prefix}.${k}` : k;
    out.set(name, { type: String(d?.type ?? (d?.properties ? "object" : "any")), ...(Array.isArray(d?.enum) ? { enum: d.enum } : {}), required: req.has(k) && required });
    if (d && (d.type === "object" || d.properties || d.type === "array")) shape(spec, d, name, out, depth + 1, req.has(k));
  }
  return out;
}

const okSchema = (o: ApiOperation) => {
  const code = Object.keys(o.responses).sort().find((c) => /^2/.test(c));
  return code ? o.responses[code].schema : undefined;
};

export function diffSpecs(oldSpec: Json, newSpec: Json): ApiChange[] {
  const base = "https://glv.invalid/";
  const a = parseSpec(oldSpec, base, base);
  const b = parseSpec(newSpec, base, base);
  const before = new Map([...a.operations, ...a.writes].map((o) => [key(o), o]));
  const after = new Map([...b.operations, ...b.writes].map((o) => [key(o), o]));
  const out: ApiChange[] = [];
  const add = (kind: ApiChange["kind"], where: string, text: string) => out.push({ kind, where, text });
  for (const [k, o] of before) if (!after.has(k)) add("breaking", `${o.method} ${o.path}`, "The endpoint was removed");
  for (const [k, o] of after) if (!before.has(k)) add("safe", `${o.method} ${o.path}`, "New endpoint");
  for (const [k, n] of after) {
    const o = before.get(k);
    if (!o) continue;
    const where = `${n.method} ${n.path}`;
    if (!o.secured && n.secured) add("breaking", where, "Now needs a login");
    if (o.secured && !n.secured) add("safe", where, "No longer needs a login");
    if (!o.deprecated && n.deprecated) add("safe", where, "Marked as deprecated");
    // Inputs.
    const oldParams = new Map((o.params ?? []).map((p) => [`${p.in} ${p.name}`, p]));
    for (const p of n.params ?? []) {
      const before = oldParams.get(`${p.in} ${p.name}`);
      if (!before && p.required) add("breaking", where, `New required ${p.in} parameter "${p.name}"`);
      else if (!before) add("safe", where, `New optional ${p.in} parameter "${p.name}"`);
      else {
        if (!before.required && p.required) add("breaking", where, `The ${p.in} parameter "${p.name}" is now required`);
        const ot = deref(oldSpec, before.schema)?.type;
        const nt = deref(newSpec, p.schema)?.type;
        if (ot && nt && ot !== nt) add("breaking", where, `The ${p.in} parameter "${p.name}" changed from ${ot} to ${nt}`);
      }
    }
    for (const [k2, p] of oldParams) if (!(n.params ?? []).some((x) => `${x.in} ${x.name}` === k2)) add("safe", where, `The ${p.in} parameter "${p.name}" was removed`);
    // Request body fields.
    if (o.body || n.body) {
      const ob = shape(oldSpec, o.body?.schema);
      const nb = shape(newSpec, n.body?.schema);
      for (const [f, info] of nb) {
        const was = ob.get(f);
        if (!was && info.required) add("breaking", where, `New required field "${f}" in the request`);
        else if (was && !was.required && info.required) add("breaking", where, `Request field "${f}" is now required`);
        else if (was && was.type !== info.type && was.type !== "any" && info.type !== "any") add("breaking", where, `Request field "${f}" changed from ${was.type} to ${info.type}`);
        if (was?.enum && info.enum) for (const v of was.enum) if (!info.enum.includes(v)) add("breaking", where, `Request field "${f}" no longer takes ${JSON.stringify(v)}`);
      }
    }
    // Answers.
    const oldCodes = Object.keys(o.responses).filter((c) => /^2/.test(c));
    const newCodes = Object.keys(n.responses).filter((c) => /^2/.test(c));
    for (const c of oldCodes) if (!newCodes.includes(c) && newCodes.length) add("breaking", where, `The success answer ${c} is no longer documented (now ${newCodes.join(", ")})`);
    const os = shape(oldSpec, okSchema(o));
    const ns = shape(newSpec, okSchema(n));
    for (const [f, info] of os) {
      const now = ns.get(f);
      if (!now) add("breaking", where, `Answer field "${f}" was removed`);
      else {
        if (info.type !== now.type && info.type !== "any" && now.type !== "any") add("breaking", where, `Answer field "${f}" changed from ${info.type} to ${now.type}`);
        if (now.enum && !info.enum) add("breaking", where, `Answer field "${f}" now only takes a fixed list of values`);
        if (info.enum && now.enum) for (const v of now.enum) if (!info.enum.includes(v)) add("breaking", where, `Answer field "${f}" can now be ${JSON.stringify(v)}, which old apps do not know`);
      }
    }
    for (const f of ns.keys()) if (!os.has(f)) add("safe", where, `New answer field "${f}"`);
  }
  if (a.baseUrl !== b.baseUrl) add("breaking", "API", `The base address changed`);
  // A fixed order: breaking first, then by place and text.
  return out.sort((x, y) => (x.kind === y.kind ? 0 : x.kind === "breaking" ? -1 : 1) || x.where.localeCompare(y.where) || x.text.localeCompare(y.text));
}

export const apiChangesAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.changes",
  name: "Breaking changes",
  description:
    "Compares the API file with the approved copy (the first test's, or the one approved on the Changes tab): removed endpoints and answer fields, new required inputs, changed types and values. Breaking changes stay issues until they are undone or approved.",
  category: "functional",
  run(ctx) {
    const { baseline, spec, specUrl, parsed } = ctx;
    if (!baseline) {
      ctx.report.baselineSaved = true;
      return [];
    }
    const list = diffSpecs(baseline.spec, spec);
    ctx.report.changes = { since: baseline.at, list };
    const out: Finding[] = [];
    for (const c of list.filter((x) => x.kind === "breaking")) {
      const op = [...parsed.operations, ...parsed.writes].find((o) => `${o.method} ${o.path}` === c.where);
      out.push(
        finding({
          category: "functional",
          rule: "api:breaking-change",
          severity: "high",
          title: "A change in the API file breaks apps built on the old version",
          detail: `${c.where}: ${c.text}. Apps and partners built on the approved version will fail. Undo it, add it in a new version (/v2) and keep the old one for a while, or, if every client is updated, approve the change on the report's Changes tab.`,
          pageUrl: op?.url ?? specUrl,
          evidence: `${c.where}: ${c.text}`,
        }),
      );
    }
    return out;
  },
};
