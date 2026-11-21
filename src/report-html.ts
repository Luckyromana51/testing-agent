import { chromium } from "playwright";
import { fixFor } from "./fixes.js";
import { groupFindings, SEVERITY_ORDER } from "./group.js";
import type { Category, Run } from "./types.js";
import { wcagReport } from "./wcag.js";
import { handbookReport } from "./handbook.js";

/**
 * The client report: one printable page with our brand (scores, the major issues with how to fix
 * them, every issue, the WCAG 2.2 table, journeys, visual changes and cookies). The PDF is the same
 * page printed by our own Chromium, so nothing leaves the server.
 */
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LABEL: Record<Category, string> = {
  functional: "Functional",
  accessibility: "Accessibility",
  seo: "SEO",
  security: "Security",
  performance: "Performance",
  mobile: "Mobile",
};
const tone = (s: number) => (s >= 90 ? "#16a34a" : s >= 70 ? "#ca8a04" : "#dc2626");

export function reportHtml(run: Run, projectName: string, brand = process.env.REPORT_BRAND || "GLV Infotech Solutions"): string {
  const r = run.result!;
  const groups = groupFindings(r.findings.filter((f) => f.severity !== "info"));
  const major = groups.filter((g) => g.severity === "critical" || g.severity === "high");
  const date = new Date(run.finishedAt ?? run.createdAt).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" });
  const isWeb = r.pages.length > 0 && /^https?:/.test(r.pages[0].url);
  const wcag = isWeb ? wcagReport(r) : null;
  const types = handbookReport(r, run.product ?? "website");
  const TYPE_TEXT = { fails: "Problems found", passes: "Tested, no problems", platform: "Done by the platform", "not-run": "Not run this time", manual: "Needs a person" } as const;
  const typeRows = types.rows
    .map((t) => `<tr><td>${esc(t.section)}</td><td><b>${esc(t.name)}</b></td><td class="st ${t.status === "fails" ? "fails" : t.status === "passes" || t.status === "platform" ? "passes" : t.status === "manual" ? "manual" : "not-tested"}">${TYPE_TEXT[t.status]}${t.findings ? ` (${t.findings})` : ""}</td><td>${t.problems.map(esc).join("<br>") || esc(t.ranBy.join(", ") || t.platform || t.manual || "")}</td></tr>`)
    .join("");
  const scoreCards = (Object.entries(r.scores) as [Category, number][])
    .map(([c, s]) => `<div class="score"><b style="color:${tone(s)}">${s}</b><span>${LABEL[c]}</span></div>`)
    .join("");
  const issueRows = groups
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    .map(
      (g) =>
        `<tr><td><span class="sev ${g.severity}">${g.severity}</span></td><td><b>${esc(g.first.title)}</b><div class="muted">${esc(LABEL[g.first.category])} · ${g.pages.length} page${g.pages.length === 1 ? "" : "s"}</div></td></tr>`,
    )
    .join("");
  const majorBlocks = major
    .slice(0, 15)
    .map((g) => {
      const fix = fixFor(g.first);
      return `<div class="issue"><div><span class="sev ${g.severity}">${g.severity}</span> <b>${esc(g.first.title)}</b></div>
<p>${esc(g.first.detail)}</p><p class="fix"><b>How to fix:</b> ${esc(fix.steps)}</p>
<div class="muted">Pages: ${g.pages.slice(0, 5).map(esc).join(", ")}${g.pages.length > 5 ? ` and ${g.pages.length - 5} more` : ""}</div></div>`;
    })
    .join("");
  const wcagRows = wcag
    ? wcag.results
        .map(
          (c) =>
            `<tr><td>${c.id}</td><td>${esc(c.name)}</td><td>${c.level}</td><td class="st ${c.status}">${
              { fails: "Fails", passes: "No problems found", manual: "Check by hand", "not-tested": "Not tested" }[c.status]
            }</td><td>${c.problems.map(esc).join("<br>")}</td></tr>`,
        )
        .join("")
    : "";
  const journeys = (r.journeys ?? [])
    .map((j) => `<tr><td>${j.ok ? "✓ Passed" : "✗ Failed"}</td><td>${esc(j.name)}</td><td>${j.steps.filter((s) => s.ok).length} of ${j.total} steps${j.ok ? "" : ` · ${esc(j.steps.at(-1)?.text)}: ${esc(j.steps.at(-1)?.error)}`}</td></tr>`)
    .join("");
  const visual = r.pages
    .filter((p) => p.visual?.desktop?.status === "changed" || p.visual?.phone?.status === "changed")
    .map((p) => `<tr><td>${esc(p.url)}</td><td>${p.visual?.desktop?.changed ?? 0}%</td><td>${p.visual?.phone?.changed ?? 0}%</td></tr>`)
    .join("");
  const cookies = (r.cookies ?? [])
    .map(
      (c) =>
        `<tr><td>${esc(c.name)}</td><td>${esc(c.domain)}${c.firstParty ? "" : " (other site)"}</td><td>${c.secure ? "✓" : "✗"}</td><td>${c.httpOnly ? "✓" : "✗"}</td><td>${c.sameSite}</td><td>${c.expires ? c.expires.slice(0, 10) : "when closed"}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(projectName)} test report</title>
<style>
@page{size:A4;margin:16mm 14mm}
body{font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#16202e;font-size:12.5px;line-height:1.5;margin:0;padding:24px;max-width:900px;margin:auto}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #2563eb;padding-bottom:12px;margin-bottom:18px}
h1{font-size:24px;margin:4px 0}h2{font-size:17px;margin:26px 0 8px;border-bottom:1px solid #e3e7ed;padding-bottom:4px;page-break-after:avoid}
.brand{font-weight:800;color:#2563eb;font-size:15px}.muted{color:#5f6b7a;font-size:11.5px}
.overall{display:flex;gap:18px;align-items:center}.big{font-size:46px;font-weight:800}
.scores{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.score{border:1px solid #e3e7ed;border-radius:8px;padding:8px 12px;min-width:90px}.score b{font-size:22px;display:block}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e3e7ed;padding:5px 6px;text-align:left;vertical-align:top}th{font-size:11px;color:#5f6b7a;text-transform:uppercase}
.sev{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;padding:1px 6px;border-radius:4px;color:#fff;background:#64748b}
.sev.critical{background:#b91c1c}.sev.high{background:#ea580c}.sev.medium{background:#ca8a04}.sev.low{background:#2563eb}
.issue{border:1px solid #e3e7ed;border-left:4px solid #ea580c;border-radius:6px;padding:10px 12px;margin:8px 0;page-break-inside:avoid}.issue p{margin:6px 0}.fix{background:#effaf3;padding:6px 8px;border-radius:4px}
.st.fails{color:#dc2626;font-weight:700}.st.passes{color:#16a34a}.st.manual{color:#5f6b7a}.st.not-tested{color:#ca8a04}
tr{page-break-inside:avoid}footer{margin-top:30px;color:#5f6b7a;font-size:11px;border-top:1px solid #e3e7ed;padding-top:8px}
</style></head><body>
<header><div><div class="brand">${esc(brand)}</div><h1>${esc(projectName)}</h1><div class="muted">${esc(r.startUrl)} · tested ${esc(date)}</div></div>
<div class="overall"><div><div class="big" style="color:${tone(r.overallScore)}">${r.overallScore}</div><div class="muted">overall score</div></div></div></header>
${r.incomplete?.length ? `<p><b>Incomplete test:</b> ${r.incomplete.map(esc).join("; ")}</p>` : ""}
<div class="scores">${scoreCards}</div>
<p>${r.pages.length} ${isWeb ? "pages" : "items"} tested · ${groups.length} issues (${major.length} major) · ${run.diff ? `${run.diff.new} new, ${run.diff.fixed} fixed since the last test` : "first test"}</p>
${run.ai?.summary ? `<h2>Summary</h2><p>${esc(run.ai.summary)}</p>` : ""}
${majorBlocks ? `<h2>Major issues and how to fix them</h2>${majorBlocks}` : ""}
<h2>All issues</h2>${issueRows ? `<table>${issueRows}</table>` : "<p>No issues found.</p>"}
${journeys ? `<h2>User journeys</h2><table>${journeys}</table>` : ""}
${visual ? `<h2>Pages that look different from their approved picture</h2><table><tr><th>Page</th><th>Desktop changed</th><th>Phone changed</th></tr>${visual}</table>` : ""}
${
  wcag
    ? `<h2>WCAG 2.2 level A and AA</h2><p>${wcag.counts.fails} criteria fail · ${wcag.counts.passes} had no problems in the automatic checks · ${wcag.counts.manual} need a person to check · ${wcag.counts["not-tested"]} not tested in this run. Automatic checks find about a third to a half of accessibility problems, so a full conformance claim also needs the manual checks.</p>
<table><tr><th>Criterion</th><th>Name</th><th>Level</th><th>Result</th><th>Problems found</th></tr>${wcagRows}</table>`
    : ""
}
<h2>Testing types (Software Testing Handbook)</h2><p>${types.counts.fails} types found problems · ${types.counts.passes} tested with no problems · ${types.counts.platform} done by the platform · ${types.counts["not-run"]} not run this time · ${types.counts.manual} need a person.${types.cases ? ` ${types.cases.toLocaleString("en-IN")} test cases counted, ${types.casesFailed.toLocaleString("en-IN")} failed.` : ""}</p>
<table><tr><th>Group</th><th>Testing type</th><th>Result</th><th>Details</th></tr>${typeRows}</table>
${cookies ? `<h2>Cookies the site sets</h2><table><tr><th>Name</th><th>Set by</th><th>Secure</th><th>HttpOnly</th><th>SameSite</th><th>Ends</th></tr>${cookies}</table>` : ""}
<footer>Made by ${esc(brand)} with the GLV Testing Agent. Test run ${esc(run.id)}.</footer>
</body></html>`;
}

/** Prints the report to PDF with our own Chromium. */
export async function reportPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // Offline: the report has everything inline, and must not fetch anything.
    await page.route("**/*", (route) => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
  } finally {
    await browser.close();
  }
}
