import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOC_LINK } from "../agents/web/documents.js";
import { WEB_PRODUCTS } from "../products.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/** One failed PDF/UA rule, as veraPDF reports it. */
export interface VeraRule {
  clause: string;
  test: number;
  description: string;
  failed: number;
}

/** Reads veraPDF's JSON report (--format json): each file, whether it passed, and its failed rules. */
export function readVera(json: string): { file: string; compliant: boolean; rules: VeraRule[] }[] {
  let data: { report?: { jobs?: unknown[] } };
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const out: { file: string; compliant: boolean; rules: VeraRule[] }[] = [];
  for (const job of (data.report?.jobs ?? []) as Record<string, unknown>[]) {
    const name = String((job.itemDetails as { name?: string } | undefined)?.name ?? "");
    const results = ([] as Record<string, unknown>[]).concat((job.validationResult as Record<string, unknown>[] | Record<string, unknown>) ?? []);
    for (const r of results) {
      const details = (r.details ?? {}) as { ruleSummaries?: Record<string, unknown>[] };
      const rules = (details.ruleSummaries ?? [])
        .filter((s) => String(s.status ?? s.ruleStatus ?? "").toLowerCase() === "failed")
        .map((s) => ({ clause: String(s.clause ?? ""), test: Number(s.testNumber ?? 0), description: String(s.description ?? "").trim(), failed: Number(s.failedChecks ?? 1) }));
      out.push({ file: name, compliant: Boolean(r.compliant ?? r.isCompliant), rules });
    }
  }
  return out;
}

export const verapdfTool: Tool = {
  id: "verapdf",
  name: "veraPDF (PDF/UA)",
  maker: "Open Preservation Foundation and the PDF Association",
  description: "Checks every PDF the site links to against all the rules of PDF/UA-1 (ISO 14289), the standard for accessible PDFs that the European Accessibility Act, EN 301 549 and India's GIGW 3.0 point to.",
  checks: ["Every machine-checkable PDF/UA-1 rule (the Matterhorn Protocol)", "Tags, reading order, alt text, fonts, metadata and language", "Up to 20 PDFs a test, downloaded like a visitor"],
  products: WEB_PRODUCTS,
  category: "accessibility",
  safety: "safe",
  takes: "1 to 5 minutes",
  licence: "GPL-3.0 or MPL-2.0, free",
  homepage: "https://verapdf.org",
  signedIn: "uses-login",

  async ready() {
    return (await which(process.env.VERAPDF_PATH || "verapdf")) ? null : "veraPDF is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const headers: Record<string, string> = ctx.cookie ? { cookie: ctx.cookie } : {};
    const pdfs = new Map<string, string>();
    for (const u of [...new Set([ctx.startUrl, ...ctx.urls])].slice(0, 80)) {
      if (pdfs.size >= 20) break;
      if (/\.pdf(?:[?#]|$)/i.test(new URL(u).pathname)) pdfs.set(u, u);
      try {
        const res = await fetch(u, { headers, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]) });
        if (!/html/i.test(res.headers.get("content-type") ?? "")) continue;
        const html = await res.text();
        for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
          try {
            const link = new URL(m[1], u);
            if (DOC_LINK.test(link.pathname) && /\.pdf/i.test(link.pathname) && link.hostname === new URL(ctx.startUrl).hostname && !pdfs.has(link.href)) pdfs.set(link.href, u);
          } catch {
            // Not an address.
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }
    if (!pdfs.size) return { findings: [], summary: ["The pages link to no PDF"], tested: "No PDF found" };
    const dir = path.join(ctx.workDir, "verapdf");
    await mkdir(dir, { recursive: true });
    const files = new Map<string, string>();
    let n = 0;
    for (const [u] of [...pdfs].slice(0, 20)) {
      try {
        const res = await fetch(u, { headers, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(60_000)]) });
        if (!res.ok) continue;
        const file = path.join(dir, `${n++}.pdf`);
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
        files.set(file, u);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }
    if (!files.size) throw new Error("None of the PDFs could be downloaded.");
    const res = await runProcess(process.env.VERAPDF_PATH || "verapdf", ["--flavour", "ua1", "--format", "json", "--maxfailuresdisplayed", "3", ...files.keys()], { signal: ctx.signal, timeoutMs: 900_000, maxOutput: 30_000_000 });
    const report = readVera(res.stdout);
    if (!report.length) throw new Error(`veraPDF stopped: ${lastLine(res.stderr) || `exit code ${res.code}`}`);
    await writeFile(path.join(ctx.outDir, "tool-verapdf.json"), res.stdout);
    const findings: ToolFinding[] = [];
    let passed = 0;
    for (const r of report) {
      const file = [...files.keys()].find((f) => r.file === f || r.file.endsWith(path.basename(f)));
      const url = file ? files.get(file)! : r.file;
      if (r.compliant) {
        passed++;
        continue;
      }
      findings.push({
        category: "accessibility",
        rule: "verapdf:pdfua-fails",
        severity: "high",
        title: `PDF fails ${r.rules.length} PDF/UA rule${r.rules.length === 1 ? "" : "s"}`,
        detail: `veraPDF checked this PDF against PDF/UA-1 (ISO 14289-1). Fix the source document (Word, InDesign) and export a tagged PDF, or repair it in Acrobat's Accessibility tool, then check again. Failed rules: ${r.rules
          .slice(0, 6)
          .map((x) => `${x.clause}-${x.test} ${x.description}`)
          .join("; ")}.`,
        pageUrl: url,
        evidence: r.rules.slice(0, 15).map((x) => `ISO 14289-1 ${x.clause} test ${x.test}: ${x.description} (${x.failed}×)`).join("\n"),
        sameAs: ["doc:pdf-untagged"],
        sameScope: "page",
        key: `verapdf:${url}`,
      });
    }
    return {
      findings,
      summary: [`${passed} of ${report.length} PDFs pass PDF/UA-1`],
      reports: [{ file: "tool-verapdf.json", label: "veraPDF report (JSON)" }],
      tested: `${report.length} PDFs`,
    };
  },
};
