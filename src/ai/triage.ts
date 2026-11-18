import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { groupFindings } from "../group.js";
import type { AiSummary, Finding, Run, ScanResult } from "../types.js";

const SummarySchema = z.object({
  summary: z
    .string()
    .describe("3 to 5 plain-English sentences a non-technical business owner can understand."),
  topFixes: z
    .array(
      z.object({
        title: z.string().describe("Short name of the fix."),
        why: z.string().describe("Business impact in one sentence."),
        how: z.string().describe("Concrete steps or code a developer can apply."),
      }),
    )
    .describe("The 3 to 5 fixes with the biggest impact, most important first."),
});

/** Keeps the prompt small: one line per distinct issue, worst first, with how many pages it hit. */
export function compactFindings(findings: Finding[], limit = 60, unit = "page"): string {
  return groupFindings(findings)
    .slice(0, limit)
    .map(
      ({ first: f, severity, pages }) =>
        `- [${severity}] [${f.category}]${f.agent?.startsWith("tool.") ? ` [found by ${f.agent.slice(5)}]` : ""} ${f.title} (${pages.length} ${unit}(s), e.g. ${f.pageUrl})${
          f.evidence ? ` evidence: ${f.evidence.split("\n").slice(0, 2).join(" | ").slice(0, 200)}` : ""
        }`,
    )
    .join("\n");
}

/**
 * A fingerprint of what the summary is written from: each distinct issue and its severity, which
 * tools ran, and what could not be tested. Page counts and timings are left out, so a re-test that
 * finds the same issues gets the same fingerprint.
 */
export function summaryKey(result: ScanResult): string {
  const issues = groupFindings(result.findings)
    .filter((g) => g.severity !== "info")
    .map((g) => `${g.severity}|${g.key}`)
    .sort();
  const tools = (result.tools ?? []).map((t) => `${t.id}:${t.status}`).sort();
  const untested = (result.agentStats ?? [])
    .filter((a) => a.untested)
    .map((a) => a.id)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ start: result.startUrl, issues, tools, untested, incomplete: result.incomplete ?? [] }))
    .digest("hex")
    .slice(0, 24);
}

/**
 * The summary of the project's last summarised test, when it was written from the same issues:
 * reusing it costs no credits and says the same thing. Runs are newest first.
 */
export function reusableSummary(earlier: Run[], key: string): { run: Run; ai: AiSummary } | undefined {
  const last = earlier.find((r) => r.ai);
  if (!last?.ai || last.ai.key !== key) return undefined;
  return { run: last, ai: last.ai };
}

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** Asks Claude to explain the scan in plain words and rank the fixes that matter most. */
export async function summariseWithClaude(result: ScanResult): Promise<AiSummary> {
  const client = new Anthropic();
  const model = process.env.CLAUDE_MODEL || "claude-opus-5-5";

  const kind = result.label?.pages === "Endpoints" ? "api" : result.label?.pages === "Files" ? "files" : "web";
  const unit = kind === "api" ? "endpoint" : kind === "files" ? "file" : "page";
  const what =
    kind === "api"
      ? `An automated test of the REST API ${result.startUrl} called ${result.pages.length} endpoint(s)`
      : kind === "files"
        ? `An automated offline test checked ${result.startUrl} (source code or a mobile app)`
        : `An automated scan of ${result.startUrl} tested ${result.pages.length} page(s)`;
  const prompt = `You are a senior QA and security engineer at a software agency. ${what}.
${result.notes?.length ? `\nWhat was tested:\n${result.notes.map((n) => `- ${n}`).join("\n")}\n` : ""}${
    result.tools?.length
      ? `\nOutside tools that ran in the same test (their findings are in the list below):\n${result.tools
          .map((t) => `- ${t.name}: ${t.status === "untested" ? `could not run (${t.untested})` : [t.tested, ...(t.summary ?? [])].filter(Boolean).join("; ")}`)
          .join("\n")}\n`
      : ""
  }
Scores out of 100: ${Object.entries(result.scores)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}. Overall ${result.overallScore}.

Findings (grouped by rule):
${compactFindings(result.findings, 60, unit) || "- none"}

Write a summary for the product owner and pick the fixes (for packages, name the version to upgrade to) with the biggest impact on users, security${kind === "web" ? " and search ranking" : " and release readiness"}. Ignore info-level items unless nothing else exists. Base everything only on the findings above; do not invent issues.`;

  // Medium suits a summary of a list; CLAUDE_EFFORT=low spends fewer credits, high thinks longer.
  const effort = (["low", "medium", "high"] as const).find((e) => e === process.env.CLAUDE_EFFORT) ?? "medium";
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(SummarySchema) },
    messages: [{ role: "user", content: prompt }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Claude declined to summarise this scan.");
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Claude returned a summary that did not match the expected format.");
  return {
    model: response.model,
    ...parsed,
    key: summaryKey(result),
    tokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
  };
}
