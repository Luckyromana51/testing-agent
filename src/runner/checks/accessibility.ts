import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import type { Finding, Severity } from "../../types.js";
import { finding } from "../finding.js";

const IMPACT: Record<string, Severity> = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low",
};

/**
 * Rules where axe's impact overstates the real-world effect. label-content-name-mismatch fires on
 * logo links whose aria-label differs from the styled text ("GLV Infotech Solutions home" vs
 * "GLVINFOTECH"); screen readers still work, only voice-control users are affected.
 */
const SEVERITY_OVERRIDE: Record<string, Severity> = {
  "label-content-name-mismatch": "medium",
};

// @axe-core/playwright pins its own playwright-core types; the runtime Page is compatible.
type AxePage = ConstructorParameters<typeof AxeBuilder>[0]["page"];

/** Runs axe-core against WCAG 2.x A and AA rules and turns each violation into a finding. */
export async function accessibilityFindings(page: Page, url: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page: page as unknown as AxePage })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    // Tap target size is checked at phone width instead, where it matters (see tapTargetFindings).
    .disableRules(["target-size"])
    .analyze();

  return results.violations.map((v) =>
    finding({
      category: "accessibility",
      rule: `axe:${v.id}`,
      severity: SEVERITY_OVERRIDE[v.id] ?? IMPACT[v.impact ?? "minor"] ?? "low",
      title: v.help,
      detail: `${v.description} Learn more: ${v.helpUrl}`,
      pageUrl: url,
      evidence: v.nodes
        .slice(0, 5)
        .map((n) => n.target.join(" "))
        .join("\n"),
      count: v.nodes.length,
    }),
  );
}

/** WCAG 2.2 target size (24 x 24 px, with axe's spacing and inline-link exceptions), run at phone width. */
export async function tapTargetFindings(page: Page, url: string): Promise<Finding[]> {
  const results = await new AxeBuilder({ page: page as unknown as AxePage }).withRules(["target-size"]).analyze();
  const nodes = results.violations.flatMap((v) => v.nodes);
  if (!nodes.length) return [];
  return [
    finding({
      category: "mobile",
      rule: "small-tap-targets",
      severity: "low",
      title: `${nodes.length} tap target(s) too small or too close together on phones`,
      detail:
        "Buttons and links should be at least 24 x 24 px, or have enough space around them, so they can be tapped without hitting a neighbour (WCAG 2.2, 2.5.8).",
      pageUrl: url,
      evidence: nodes
        .slice(0, 8)
        .map((n) => n.target.join(" "))
        .join("\n"),
      count: nodes.length,
    }),
  ];
}
