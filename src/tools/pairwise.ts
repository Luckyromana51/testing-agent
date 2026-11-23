import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Pairwise (all-pairs) combinations for forms, the way PICT and ACTS work: testing every combination
 * of a form's fields explodes (5 fields of 4 values each is 1024 cases), but most bugs appear from a
 * pair of values together. This picks the smallest set of cases so that every pair of values from any
 * two fields appears at least once. The tester lists each field's values; GLV returns the case table
 * to run by hand or to feed the form-fill check. It only computes a table, so it is safe.
 */

export interface Field {
  name: string;
  values: string[];
}

/** Parses "field: a, b, c" lines into fields. Pure, for tests. */
export function parseFields(text: string): Field[] {
  const out: Field[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const values = line.slice(i + 1).split(/[,|]/).map((v) => v.trim()).filter(Boolean);
    if (name && values.length) out.push({ name, values });
  }
  return out;
}

/** Every unordered pair of field indexes. Pure, for tests. */
function fieldPairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

/**
 * A greedy all-pairs set: every (field a = value x, field b = value y) pair appears in some case.
 * Not provably minimal, but close, and far smaller than the full product. Pure, for tests.
 */
export function pairwise(fields: Field[]): string[][] {
  if (fields.length < 2) return fields.length === 1 ? fields[0].values.map((v) => [v]) : [];
  const pairs = fieldPairs(fields.length);
  // All pairs still needed, keyed "ai:vi|bj:vj".
  const need = new Set<string>();
  const key = (a: number, va: number, b: number, vb: number) => `${a}:${va}|${b}:${vb}`;
  for (const [a, b] of pairs) for (let va = 0; va < fields[a].values.length; va++) for (let vb = 0; vb < fields[b].values.length; vb++) need.add(key(a, va, b, vb));

  const cases: number[][] = [];
  let guard = 0;
  while (need.size && guard++ < 100_000) {
    // Build one case greedily, choosing each field's value to cover the most still-needed pairs.
    const pick: number[] = new Array(fields.length).fill(-1);
    // Seed with a needed pair so progress is guaranteed.
    const [seed] = need;
    const [left, right] = seed.split("|");
    const [sa, sva] = left.split(":").map(Number);
    const [sb, svb] = right.split(":").map(Number);
    pick[sa] = sva;
    pick[sb] = svb;
    for (let f = 0; f < fields.length; f++) {
      if (pick[f] !== -1) continue;
      let best = 0;
      let bestCovers = -1;
      for (let v = 0; v < fields[f].values.length; v++) {
        let covers = 0;
        for (let g = 0; g < fields.length; g++) {
          if (g === f || pick[g] === -1) continue;
          const [a, va, b, vb] = f < g ? [f, v, g, pick[g]] : [g, pick[g], f, v];
          if (need.has(key(a, va, b, vb))) covers++;
        }
        if (covers > bestCovers) {
          bestCovers = covers;
          best = v;
        }
      }
      pick[f] = best;
    }
    // Record which pairs this case now covers.
    for (const [a, b] of pairs) need.delete(key(a, pick[a], b, pick[b]));
    cases.push(pick);
  }
  return cases.map((c) => c.map((v, f) => fields[f].values[v]));
}

export const pairwiseTool: Tool = {
  id: "pairwise",
  name: "Pairwise form combinations",
  maker: "GLV Infotech (built in), in the way of PICT and ACTS",
  description:
    "For a form with many fields and values, computes the smallest set of test cases so that every pair of values from any two fields is tried at least once. Most form bugs come from two values together, so this finds them with a handful of cases instead of thousands.",
  checks: ["Every pair of field values appears in at least one case", "The case count stays small (orders of magnitude below the full product)", "A table to run by hand or feed the form-fill check"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://github.com/microsoft/pict",
  signedIn: "public",
  options: [
    {
      id: "fields",
      label: "Fields and their values",
      kind: "text",
      required: true,
      maxLength: 4000,
      placeholder: "country: India, US, UK\npayment: card, upi, cod\nplan: free, pro, team",
      hint: "One field per line: name, a colon, then the values separated by commas.",
      choices: [],
      default: "",
    },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const fields = parseFields(ctx.options.fields ?? "");
    if (fields.length < 2) throw new Error("List at least two fields, each with two or more values, one field per line (name: a, b, c).");
    const full = fields.reduce((n, f) => n * f.values.length, 1);
    const cases = pairwise(fields);
    ctx.log(`Pairwise: ${fields.length} fields → ${cases.length} cases (full product ${full})`);
    const header = fields.map((f) => f.name);
    await writeFile(
      path.join(ctx.outDir, "tool-pairwise.csv"),
      [header.join(","), ...cases.map((c) => c.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","))].join("\n"),
    );
    const findings: ToolFinding[] = [];
    if (full > 50 && cases.length < full)
      findings.push({
        category: "functional",
        rule: "pairwise:use-cases",
        severity: "info",
        title: `Test ${cases.length} cases instead of ${full} to cover every value pair`,
        detail: `Trying every combination of these ${fields.length} fields is ${full} cases. Covering every pair of values takes only ${cases.length}. Run the ${cases.length} cases in the attached CSV; add a few hand-picked cases for known risky combinations.`,
        pageUrl: ctx.startUrl,
        evidence: [header.join(" | "), ...cases.slice(0, 10).map((c) => c.join(" | "))].join("\n"),
        key: "pairwise:use-cases",
      });
    return {
      findings,
      summary: [`${fields.length} fields, ${full} full combinations → ${cases.length} pairwise cases`],
      reports: [{ file: "tool-pairwise.csv", label: "Pairwise test cases (CSV)" }],
      tested: `${fields.length} fields`,
      table: { title: `Pairwise cases (${cases.length})`, columns: header, rows: cases.slice(0, 50) },
    };
  },
};
