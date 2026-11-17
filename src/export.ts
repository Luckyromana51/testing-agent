import { createHash } from "node:crypto";
import { groupFindings, issueKey } from "./group.js";
import type { Finding, ScanResult, Severity } from "./types.js";

const LEVEL: Record<Severity, "error" | "warning" | "note"> = { critical: "error", high: "error", medium: "warning", low: "note", info: "note" };
/** GitHub code scanning sorts by this 0-10 score. */
const SCORE: Record<Severity, string> = { critical: "9.5", high: "8.0", medium: "5.5", low: "3.0", info: "0.0" };

/** "line 12: ..." in the evidence, for a code finding. */
const lineOf = (f: Finding) => Number(f.evidence?.match(/^line (\d+)/)?.[1]) || undefined;
const isUrl = (s: string) => /^https?:\/\//.test(s);

/** Who found it: an outside tool (tool.zap) or a GLV agent (web.security). */
const source = (f: Finding) => (f.agent?.startsWith("tool.") ? f.agent.slice(5) : f.agent ? `glv.${f.agent}` : "glv");

/**
 * The run's findings as SARIF 2.1.0, the format GitHub code scanning, GitLab, Azure DevOps and
 * most security dashboards read. Code findings point at the file and line; web and API findings
 * at the page or endpoint address. Each result has a fingerprint that stays the same between
 * runs, so dashboards can tell new problems from old ones.
 */
export function toSarif(result: ScanResult, opts: { version?: string; uri?: string } = {}): object {
  const findings = result.findings.filter((f) => f.rule !== "check-error");
  const rules = new Map<string, Finding>();
  for (const f of findings) if (!rules.has(f.rule)) rules.set(f.rule, f);
  const ruleIds = [...rules.keys()];
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "GLV Testing Agent",
            informationUri: "https://glvinfotechsolutions.com",
            ...(opts.version ? { version: opts.version } : {}),
            rules: ruleIds.map((id) => {
              const f = rules.get(id)!;
              return {
                id,
                name: id.replace(/[^A-Za-z0-9]+/g, "-"),
                shortDescription: { text: f.title.slice(0, 200) },
                fullDescription: { text: f.detail.slice(0, 1000) },
                defaultConfiguration: { level: LEVEL[f.severity] },
                properties: { "security-severity": SCORE[f.severity], tags: [f.category, source(f)] },
              };
            }),
          },
        },
        ...(opts.uri ? { originalUriBaseIds: { TARGET: { uri: opts.uri } } } : {}),
        invocations: [
          {
            executionSuccessful: !result.incomplete,
            startTimeUtc: result.startedAt,
            endTimeUtc: result.finishedAt,
            ...(result.incomplete ? { toolExecutionNotifications: [{ level: "warning", message: { text: result.incomplete } }] } : {}),
          },
        ],
        results: findings.map((f) => {
          const line = lineOf(f);
          return {
            ruleId: f.rule,
            ruleIndex: ruleIds.indexOf(f.rule),
            level: LEVEL[f.severity],
            message: { text: `${f.title}. ${f.detail}`.slice(0, 4000) },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: isUrl(f.pageUrl) ? { uri: f.pageUrl } : { uri: f.pageUrl, ...(opts.uri ? {} : { uriBaseId: "%SRCROOT%" }) },
                  ...(line ? { region: { startLine: line } } : {}),
                },
              },
            ],
            partialFingerprints: { glvIssue: createHash("sha1").update(`${issueKey(f)}|${f.pageUrl}`).digest("hex").slice(0, 16) },
            properties: { severity: f.severity, category: f.category, foundBy: source(f), ...(f.evidence ? { evidence: f.evidence.slice(0, 500) } : {}) },
          };
        }),
      },
    ],
  };
}

const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * The run as JUnit XML, the format CI servers (Jenkins, GitLab, Azure DevOps, GitHub Actions
 * test reporters) show as passed and failed tests: one suite per agent or tool, one failed test
 * per issue (info-level notes are not failures), one passed test for an agent that found
 * nothing, and a skipped test for one that could not test.
 */
export function toJunit(result: ScanResult, name = "GLV Testing Agent"): string {
  const stats = result.agentStats ?? [];
  const byAgent = new Map<string, Finding[]>();
  for (const f of result.findings) {
    if (f.rule === "check-error") continue;
    const k = f.agent ?? "glv";
    byAgent.set(k, [...(byAgent.get(k) ?? []), f]);
  }
  const agents = [...new Set([...stats.map((s) => s.id), ...byAgent.keys()])];
  const seconds = (ms?: number) => ((ms ?? 0) / 1000).toFixed(3);
  let tests = 0;
  let failures = 0;
  let skipped = 0;
  const suites = agents.map((id) => {
    const stat = stats.find((s) => s.id === id);
    const label = stat?.name ?? id;
    const groups = groupFindings(byAgent.get(id) ?? []);
    const cases: string[] = [];
    for (const g of groups) {
      tests++;
      const where = g.pages.slice(0, 5).join(", ") + (g.pages.length > 5 ? ` and ${g.pages.length - 5} more` : "");
      if (g.severity === "info") {
        cases.push(`    <testcase classname="${xml(id)}" name="${xml(g.first.title)}"><system-out>${xml(`${g.first.detail}\n${where}`)}</system-out></testcase>`);
        continue;
      }
      failures++;
      cases.push(
        `    <testcase classname="${xml(id)}" name="${xml(g.first.title)}"><failure type="${xml(g.severity)}" message="${xml(`[${g.severity}] ${g.first.title}`)}">${xml(
          `${g.first.detail}\nWhere: ${where}${g.first.evidence ? `\nEvidence: ${g.first.evidence}` : ""}`,
        )}</failure></testcase>`,
      );
    }
    if (stat?.untested || stat?.skipped) {
      tests++;
      skipped++;
      cases.push(`    <testcase classname="${xml(id)}" name="${xml(`${label}: not tested`)}"><skipped message="${xml(stat.untested ?? stat.skipped ?? "")}"/></testcase>`);
    } else if (!groups.length) {
      tests++;
      cases.push(`    <testcase classname="${xml(id)}" name="${xml(`${label}: no problems found`)}" time="${seconds(stat?.ms)}"/>`);
    }
    const f = groups.filter((g) => g.severity !== "info").length;
    const s = stat?.untested || stat?.skipped ? 1 : 0;
    return `  <testsuite name="${xml(label)}" tests="${cases.length}" failures="${f}" errors="0" skipped="${s}" time="${seconds(stat?.ms)}">\n${cases.join("\n")}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(`${name}: ${result.startUrl}`)}" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}">\n${suites.join("\n")}\n</testsuites>\n`;
}
