#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { aiEnabled, summariseWithClaude } from "./ai/triage.js";
import { scanSite } from "./runner/scan.js";
import { groupFindings } from "./group.js";
import type { ProductType, Severity } from "./types.js";

const HELP = `glvtest - GLV Testing Agent

Usage:
  glvtest scan <url> [options]

Options:
  --pages <n>     Maximum pages to crawl (default 10)
  --product <t>   website, ecommerce, webapp, saas or crm (default website)
  --out <dir>     Where to write report.json and screenshots (default ./glvtest-report)
  --no-links      Skip checking every link for 404s
  --no-a11y       Skip accessibility checks
  --fail-on <s>   Exit with code 1 if any finding is at least this severe
                  (critical, high, medium, low). Useful in CI.
  -h, --help      Show this help

Set ANTHROPIC_API_KEY to add a Claude summary and top fixes.`;

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      pages: { type: "string", default: "10" },
      product: { type: "string", default: "website" },
      out: { type: "string", default: "glvtest-report" },
      "no-links": { type: "boolean", default: false },
      "no-a11y": { type: "boolean", default: false },
      "fail-on": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, url] = positionals;
  if (values.help || command !== "scan" || !url) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const outDir = path.resolve(values.out!);
  const result = await scanSite({
    url: url.includes("://") ? url : `https://${url}`,
    maxPages: Number(values.pages),
    product: values.product as ProductType,
    checkLinks: !values["no-links"],
    accessibility: !values["no-a11y"],
    artifactsDir: outDir,
    onProgress: (m) => console.error(`  ${m}`),
  });

  let ai;
  if (aiEnabled()) {
    console.error("  Asking Claude to summarise the findings");
    ai = await summariseWithClaude(result).catch((e: Error) => {
      console.error(`  Claude summary failed: ${e.message}`);
      return undefined;
    });
  }
  await writeFile(path.join(outDir, "report.json"), JSON.stringify({ ...result, ai }, null, 2));

  const issues = groupFindings(result.findings);
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<Severity, number>;
  for (const g of issues) counts[g.severity]++;

  console.log(`\nGLV Testing Agent report for ${result.startUrl}`);
  console.log(`Pages tested: ${result.pages.length}   Overall score: ${result.overallScore}/100\n`);
  console.table(result.scores);
  console.log(
    `Issues: ${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info`,
  );
  for (const g of issues.slice(0, 15)) {
    const where = g.pages.length > 1 ? `${g.pages.length} pages` : g.first.pageUrl;
    console.log(`  [${g.severity.toUpperCase()}] ${g.first.title}  (${where})`);
  }
  if (ai) {
    console.log(`\nClaude summary (${ai.model}):\n${ai.summary}\n`);
    ai.topFixes.forEach((fix, i) => console.log(`${i + 1}. ${fix.title}: ${fix.how}`));
  }
  console.log(`\nFull report: ${path.join(outDir, "report.json")}`);

  const failOn = values["fail-on"] as Severity | undefined;
  if (failOn && result.findings.some((f) => RANK[f.severity] >= RANK[failOn])) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
