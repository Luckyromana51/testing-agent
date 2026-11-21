import type { Severity } from "../../types.js";
import type { AttackFinding } from "./types.js";

const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

/** A short, plain name for each hole, for the attack-path story. */
function label(f: AttackFinding): string {
  if (f.rule.includes("command-injection")) return "run commands on the server (command injection)";
  if (f.rule.includes("template-injection")) return "run code through the template engine (SSTI)";
  if (f.rule.includes("ssrf")) return "make the server fetch internal addresses (SSRF)";
  if (f.rule.includes("idor")) return "open other users' records (broken access control)";
  if (f.rule.includes("nosql")) return "bend database queries (NoSQL injection)";
  if (f.rule.includes("cors")) return "read answers from any website (CORS)";
  if (f.rule.includes("host-header")) return "poison links with a fake host (host-header injection)";
  if (f.rule.includes("crlf")) return "add headers to responses (CRLF injection)";
  if (f.rule.includes("exposed-file")) return "download secrets left on the web (exposed files)";
  if (f.rule.includes("deserialization")) return "feed the app serialized objects (deserialization surface)";
  return f.title;
}

/**
 * Joins the confirmed holes into one realistic attack path, the way a pentester writes the headline
 * of a report: what an attacker reaches first, how they climb, and the worst they can do. It makes
 * nothing up — it only names holes that were already confirmed — and is added only when at least two
 * stand together.
 */
export function chainFindings(findings: AttackFinding[]): AttackFinding[] {
  const real = findings.filter((f) => !f.rule.includes(":chain"));
  if (real.length < 2) return [];
  const tags = new Set(real.map((f) => f.tag));
  const top = [...real].sort((a, b) => RANK[b.severity] - RANK[a.severity]);

  // Build the story from the kinds of hole present.
  const steps: string[] = [];
  if (tags.has("rce")) steps.push("take over the server itself");
  if (tags.has("ssrf")) steps.push("reach internal services and cloud credentials");
  if (tags.has("idor")) steps.push("read and change every user's records");
  if (tags.has("injection")) steps.push("pull data straight from the database or exposed secrets");
  if (tags.has("cors") || tags.has("header")) steps.push("attack signed-in users through their own browser");
  if (tags.has("deserialize")) steps.push("aim for code execution through serialized input");

  const worst: Severity = tags.has("rce") || tags.has("ssrf") || top[0].severity === "critical" ? "critical" : "high";
  const holes = top.map((f) => `• ${label(f)} — ${f.pageUrl}`);

  const detail =
    `This test confirmed ${real.length} separate holes that an attacker chains into one attack. Put together, they let an attacker ${joinList(steps)}. ` +
    `The confirmed holes, worst first:\n${holes.join("\n")}\n\n` +
    `A real attacker does not stop at one finding: ${pathStory(tags)} Fix the critical and high items first; each one on its own is enough to cause real harm. See the individual findings above for how to reproduce and fix each.`;

  return [
    {
      rule: "attack:chain",
      severity: worst,
      tag: "injection",
      title: `Attack path: ${real.length} confirmed holes chain into ${tags.has("rce") || tags.has("ssrf") ? "a full compromise" : "account and data takeover"}`,
      detail,
      pageUrl: top[0].pageUrl,
      evidence: top.map((f) => f.rule).join(" + "),
      key: `chain:${[...tags].sort().join("+")}`,
    },
  ];
}

const joinList = (items: string[]): string => {
  const uniq = [...new Set(items)];
  if (uniq.length <= 1) return uniq[0] ?? "escalate the attack";
  return `${uniq.slice(0, -1).join(", ")} and ${uniq[uniq.length - 1]}`;
};

function pathStory(tags: Set<string>): string {
  if (tags.has("rce")) return "once code runs on the server, the database, other customers' data and the wider network are all within reach.";
  if (tags.has("ssrf")) return "server-side request forgery is the classic first step to stolen cloud keys, which unlock the rest of the account.";
  if (tags.has("idor") && (tags.has("cors") || tags.has("header"))) return "weak record checks reachable from any website turn one victim's visit into access to everyone's data.";
  if (tags.has("idor")) return "once records open by id, an attacker scripts a download of every account in minutes.";
  return "one hole opens the door the next one walks through.";
}
