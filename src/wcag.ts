import type { Finding, ScanResult } from "./types.js";

/**
 * WCAG 2.2 level A and AA, criterion by criterion, as an accessibility conformance report (the
 * shape of a VPAT): which criteria the test found failing, which the automatic checks covered with
 * no problem, and which need a person to check (no tool can fully test those).
 */
export interface Criterion {
  id: string;
  name: string;
  level: "A" | "AA";
  /** Rules (finding rules, exact or a prefix ending in *) that fail this criterion. */
  rules: string[];
  /** Agents that check it. When one ran and found nothing, the criterion counts as passed by the automatic checks. */
  agents: string[];
}

const AXE = "web.accessibility";

export const WCAG22: Criterion[] = [
  { id: "1.1.1", name: "Non-text content", level: "A", rules: ["axe:image-alt", "axe:input-image-alt", "axe:area-alt", "axe:svg-img-alt", "axe:object-alt", "axe:role-img-alt", "axe:image-redundant-alt", "seo:img-alt"], agents: [AXE] },
  { id: "1.2.1", name: "Audio-only and video-only (prerecorded)", level: "A", rules: [], agents: [] },
  { id: "1.2.2", name: "Captions (prerecorded)", level: "A", rules: ["axe:video-caption"], agents: [] },
  { id: "1.2.3", name: "Audio description or media alternative", level: "A", rules: [], agents: [] },
  { id: "1.2.4", name: "Captions (live)", level: "AA", rules: [], agents: [] },
  { id: "1.2.5", name: "Audio description (prerecorded)", level: "AA", rules: [], agents: [] },
  { id: "1.3.1", name: "Info and relationships", level: "A", rules: ["axe:label", "axe:list", "axe:listitem", "axe:definition-list", "axe:dlitem", "axe:th-has-data-cells", "axe:td-headers-attr", "axe:table-fake-caption", "axe:aria-required-children", "axe:aria-required-parent", "axe:p-as-heading", "a11y:heading-skip", "a11y:no-main", "axe:landmark-*", "axe:region"], agents: [AXE, "a11y.screen-reader"] },
  { id: "1.3.2", name: "Meaningful sequence", level: "A", rules: [], agents: [] },
  { id: "1.3.3", name: "Sensory characteristics", level: "A", rules: [], agents: [] },
  { id: "1.3.4", name: "Orientation", level: "AA", rules: ["axe:css-orientation-lock", "browser:sideways", "layout:sideways-at-size"], agents: ["func.devices"] },
  { id: "1.3.5", name: "Identify input purpose", level: "AA", rules: ["axe:autocomplete-valid"], agents: [AXE] },
  { id: "1.4.1", name: "Use of color", level: "A", rules: ["axe:link-in-text-block"], agents: [AXE] },
  { id: "1.4.2", name: "Audio control", level: "A", rules: ["a11y:autoplay-sound", "axe:no-autoplay-audio"], agents: ["a11y.motion"] },
  { id: "1.4.3", name: "Contrast (minimum)", level: "AA", rules: ["axe:color-contrast"], agents: [AXE] },
  { id: "1.4.4", name: "Resize text", level: "AA", rules: ["a11y:zoom-200", "axe:meta-viewport", "axe:meta-viewport-large"], agents: ["a11y.zoom"] },
  { id: "1.4.5", name: "Images of text", level: "AA", rules: [], agents: [] },
  { id: "1.4.10", name: "Reflow", level: "AA", rules: ["a11y:reflow-400", "mobile-overflow"], agents: ["a11y.zoom", "web.mobile"] },
  { id: "1.4.11", name: "Non-text contrast", level: "AA", rules: [], agents: [] },
  { id: "1.4.12", name: "Text spacing", level: "AA", rules: ["a11y:text-spacing"], agents: ["a11y.text-spacing"] },
  { id: "1.4.13", name: "Content on hover or focus", level: "AA", rules: [], agents: [] },
  { id: "2.1.1", name: "Keyboard", level: "A", rules: ["a11y:click-only", "axe:scrollable-region-focusable", "axe:frame-focusable-content"], agents: ["a11y.keyboard"] },
  { id: "2.1.2", name: "No keyboard trap", level: "A", rules: ["a11y:keyboard-trap"], agents: ["a11y.keyboard"] },
  { id: "2.1.4", name: "Character key shortcuts", level: "A", rules: ["axe:accesskeys"], agents: [] },
  { id: "2.2.1", name: "Timing adjustable", level: "A", rules: ["axe:meta-refresh"], agents: [AXE] },
  { id: "2.2.2", name: "Pause, stop, hide", level: "A", rules: ["axe:blink", "axe:marquee", "a11y:ignores-reduced-motion"], agents: ["a11y.motion"] },
  { id: "2.3.1", name: "Three flashes or below threshold", level: "A", rules: [], agents: [] },
  { id: "2.4.1", name: "Bypass blocks", level: "A", rules: ["axe:bypass", "axe:skip-link", "a11y:no-main"], agents: [AXE] },
  { id: "2.4.2", name: "Page titled", level: "A", rules: ["axe:document-title", "seo:title-missing"], agents: [AXE, "web.seo"] },
  { id: "2.4.3", name: "Focus order", level: "A", rules: ["a11y:positive-tabindex", "axe:tabindex"], agents: ["a11y.keyboard"] },
  { id: "2.4.4", name: "Link purpose (in context)", level: "A", rules: ["axe:link-name", "a11y:vague-link", "a11y:same-name-links"], agents: [AXE, "a11y.screen-reader"] },
  { id: "2.4.5", name: "Multiple ways", level: "AA", rules: [], agents: [] },
  { id: "2.4.6", name: "Headings and labels", level: "AA", rules: ["axe:empty-heading", "axe:empty-table-header"], agents: [AXE] },
  { id: "2.4.7", name: "Focus visible", level: "AA", rules: ["a11y:focus-not-visible"], agents: ["a11y.keyboard"] },
  { id: "2.4.11", name: "Focus not obscured (minimum)", level: "AA", rules: ["a11y:focus-obscured"], agents: ["a11y.keyboard"] },
  { id: "2.5.1", name: "Pointer gestures", level: "A", rules: [], agents: [] },
  { id: "2.5.2", name: "Pointer cancellation", level: "A", rules: [], agents: [] },
  { id: "2.5.3", name: "Label in name", level: "A", rules: ["axe:label-content-name-mismatch"], agents: [] },
  { id: "2.5.4", name: "Motion actuation", level: "A", rules: [], agents: [] },
  { id: "2.5.7", name: "Dragging movements", level: "AA", rules: [], agents: [] },
  { id: "2.5.8", name: "Target size (minimum)", level: "AA", rules: ["small-tap-targets", "axe:target-size"], agents: ["web.mobile"] },
  { id: "3.1.1", name: "Language of page", level: "A", rules: ["axe:html-has-lang", "axe:html-lang-valid", "l10n:wrong-lang", "seo:lang-missing"], agents: [AXE, "l10n.language"] },
  { id: "3.1.2", name: "Language of parts", level: "AA", rules: ["axe:valid-lang"], agents: [AXE] },
  { id: "3.2.1", name: "On focus", level: "A", rules: [], agents: [] },
  { id: "3.2.2", name: "On input", level: "A", rules: [], agents: [] },
  { id: "3.2.3", name: "Consistent navigation", level: "AA", rules: [], agents: [] },
  { id: "3.2.4", name: "Consistent identification", level: "AA", rules: [], agents: [] },
  { id: "3.2.6", name: "Consistent help", level: "A", rules: [], agents: [] },
  { id: "3.3.1", name: "Error identification", level: "A", rules: [], agents: [] },
  { id: "3.3.2", name: "Labels or instructions", level: "A", rules: ["axe:label", "axe:select-name", "form:required-not-marked"], agents: [AXE, "func.form-fields"] },
  { id: "3.3.3", name: "Error suggestion", level: "AA", rules: [], agents: [] },
  { id: "3.3.4", name: "Error prevention (legal, financial, data)", level: "AA", rules: [], agents: [] },
  { id: "3.3.7", name: "Redundant entry", level: "A", rules: [], agents: [] },
  { id: "3.3.8", name: "Accessible authentication (minimum)", level: "AA", rules: ["sec:password-manager-blocked"], agents: ["sec.auth-forms"] },
  { id: "4.1.2", name: "Name, role, value", level: "A", rules: ["axe:button-name", "axe:aria-*", "axe:frame-title", "axe:input-button-name", "axe:nested-interactive", "axe:select-name"], agents: [AXE] },
  { id: "4.1.3", name: "Status messages", level: "AA", rules: [], agents: [] },
];

export type CriterionStatus = "fails" | "passes" | "manual" | "not-tested";

export interface CriterionResult extends Criterion {
  status: CriterionStatus;
  findings: number;
  pages: number;
  /** Titles of the problems found, for the report. */
  problems: string[];
}

export interface WcagReport {
  results: CriterionResult[];
  counts: Record<CriterionStatus, number>;
  /** True only when no criterion fails; a person must still check the manual ones. */
  noFailuresFound: boolean;
}

const matches = (rule: string, pattern: string) => (pattern.endsWith("*") ? rule.startsWith(pattern.slice(0, -1)) : rule === pattern);

export function wcagReport(result: ScanResult): WcagReport {
  const ran = new Set((result.agentStats ?? []).filter((s) => !s.untested && !s.skipped && (s.runs ?? 1) > 0).map((s) => s.id));
  const results: CriterionResult[] = WCAG22.map((c) => {
    const hits: Finding[] = result.findings.filter((f) => f.severity !== "info" && c.rules.some((r) => matches(f.rule, r)));
    let status: CriterionStatus;
    if (hits.length) status = "fails";
    else if (!c.agents.length) status = "manual";
    else status = c.agents.some((a) => ran.has(a)) ? "passes" : "not-tested";
    return {
      ...c,
      status,
      findings: hits.reduce((n, f) => n + (f.count ?? 1), 0),
      pages: new Set(hits.map((f) => f.pageUrl)).size,
      problems: [...new Set(hits.map((f) => f.title))].slice(0, 5),
    };
  });
  const counts = { fails: 0, passes: 0, manual: 0, "not-tested": 0 } as Record<CriterionStatus, number>;
  for (const r of results) counts[r.status]++;
  return { results, counts, noFailuresFound: counts.fails === 0 };
}
