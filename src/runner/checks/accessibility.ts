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

/** Runs axe-core against WCAG 2.x A and AA rules and turns each violation into a finding. */
export async function accessibilityFindings(page: Page, url: string): Promise<Finding[]> {
  // @axe-core/playwright pins its own playwright-core types; the runtime Page is compatible.
  type AxePage = ConstructorParameters<typeof AxeBuilder>[0]["page"];
  const results = await new AxeBuilder({ page: page as unknown as AxePage })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();

  return results.violations.map((v) =>
    finding({
      category: "accessibility",
      rule: `axe:${v.id}`,
      severity: IMPACT[v.impact ?? "minor"] ?? "low",
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
