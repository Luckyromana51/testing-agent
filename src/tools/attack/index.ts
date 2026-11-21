import { WEB_PRODUCTS } from "../../products.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "../types.js";
import { accessFamily } from "./access.js";
import { chainFindings } from "./chain.js";
import { corsFamily, crlfFamily, hostHeaderFamily } from "./headers.js";
import { attackHttp } from "./http.js";
import { commandFamily, nosqlFamily, sstiFamily } from "./inject.js";
import { sessionFamily } from "./session.js";
import { ssrfFamily } from "./ssrf.js";
import { exposedFamily } from "./exposed.js";
import { buildSurface } from "./surface.js";
import type { AttackFinding, Family } from "./types.js";

/**
 * The attack agent's techniques, in the order they run (cheap, direct checks first; the slow
 * timing-based command check last). Each is a toggle in the tool's tab, every one on by default —
 * turning them all on is what "enable all attack" means, and the client's written permission is still
 * checked before anything runs.
 */
export const FAMILIES: Family[] = [
  exposedFamily,
  sessionFamily,
  sstiFamily,
  crlfFamily,
  hostHeaderFamily,
  corsFamily,
  ssrfFamily,
  nosqlFamily,
  accessFamily,
  commandFamily,
];

const FAMILY_IDS = FAMILIES.map((f) => f.id);
const ALL = FAMILY_IDS.join(",");

/** Which techniques the tester left on (all by default). */
export function enabledFamilies(value: string | undefined): Family[] {
  if (value === undefined) return FAMILIES;
  const on = new Set(value.split(",").map((s) => s.trim()).filter(Boolean));
  return FAMILIES.filter((f) => on.has(f.id));
}

export const attackTool: Tool = {
  id: "glv-attack",
  name: "GLV attack agent",
  maker: "GLV Infotech (built in)",
  description:
    "GLV's own orchestrated penetration test: it maps the site's parameters, forms, cookies and endpoints, then runs a deep set of attacks — injection (command, template, NoSQL), server-side request forgery, broken access control (IDOR), CORS and header injection, exposed secrets, and session-token weaknesses — and chains the confirmed holes into an attack path. Every finding is verified before it is reported, with evidence, how to reproduce it and how to fix it. Read-only: no payload changes or deletes data.",
  checks: [
    "Injection beyond SQL/XSS: OS command (timed), server-side template, NoSQL operators",
    "Server-side request forgery to cloud metadata and local files, confirmed by what comes back",
    "Broken access control (IDOR): other users' records reachable by stepping an id, signed-in only",
    "CORS, CRLF/header and host-header injection, confirmed by the response itself",
    "Exposed .git/.env/backups and serialized-object (deserialization) surfaces",
    "Session-token (JWT) weaknesses: unsigned, guessable secret, never expiring — read offline",
    "Confirmed holes chained into one realistic attack path",
  ],
  products: [...WEB_PRODUCTS],
  category: "security",
  safety: "permission",
  permission: "attack",
  limits: { minutes: "minutes" },
  takes: "3 to 20 minutes",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "uses-login",
  options: [
    {
      id: "families",
      label: "Attacks to run",
      kind: "toggles",
      hint: "Every attack is on by default. Turn off any you do not want in this run.",
      choices: FAMILIES.map((f) => ({ value: f.id, label: f.label })),
      default: ALL,
    },
    {
      id: "minutes",
      label: "Longest time",
      choices: ["3", "5", "10", "20", "30"].map((v) => ({ value: v, label: `${v} minutes` })),
      default: "10",
    },
  ],

  async ready() {
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit) throw new Error("The attack agent runs only with the client's written permission for attack tests.");
    const minutes = Math.min(Number(ctx.options.minutes) || 10, permit.maxMinutes);
    const deadline = Date.now() + minutes * 60_000;
    const http = attackHttp(ctx, deadline);
    const families = enabledFamilies(ctx.options.families);

    const surface = await buildSurface(ctx, http);
    ctx.log(
      `Attack agent: ${surface.params.length} parameter${surface.params.length === 1 ? "" : "s"} on ${surface.pages.length} page${surface.pages.length === 1 ? "" : "s"}${surface.signedIn ? ", signed in" : ""}; ${families.length} attack${families.length === 1 ? "" : "s"} on`,
    );

    const all: AttackFinding[] = [];
    let cut = false;
    for (const family of families) {
      ctx.signal.throwIfAborted();
      if (http.left() <= 0) {
        cut = true;
        break;
      }
      try {
        all.push(...(await family.run({ http, surface, ctx, log: ctx.log })));
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        ctx.log(`${family.label} stopped: ${(err as Error).message.split("\n")[0].slice(0, 120)}`);
        if ((err as Error).message === "time limit") {
          cut = true;
          break;
        }
      }
    }
    // One per place and hole, then the attack-path summary over everything confirmed.
    const byKey = new Map<string, AttackFinding>();
    for (const f of all) if (!byKey.has(f.key)) byKey.set(f.key, f);
    const confirmed = [...byKey.values()];
    const withChain = [...confirmed, ...chainFindings(confirmed)];

    const findings: ToolFinding[] = withChain.map((f) => ({
      category: "security",
      rule: f.rule,
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      pageUrl: f.pageUrl,
      evidence: f.evidence,
      key: f.key,
    }));

    return {
      findings,
      summary: [
        `${surface.params.length} parameter${surface.params.length === 1 ? "" : "s"} on ${surface.pages.length} page${surface.pages.length === 1 ? "" : "s"} tested with ${http.sent} requests`,
        `${families.map((f) => f.label).join(", ") || "no attacks"} ${families.length === 1 ? "was" : "were"} enabled`,
        ...(cut ? [`Stopped at the ${minutes}-minute limit before every attack finished`] : []),
        `${confirmed.length} confirmed hole${confirmed.length === 1 ? "" : "s"}${confirmed.length ? ` (${confirmed.filter((f) => f.severity === "critical").length} critical, ${confirmed.filter((f) => f.severity === "high").length} high)` : ""}`,
      ],
      tested: `${surface.params.length} parameters on ${surface.pages.length} pages, ${families.length} attack families${surface.signedIn ? ", signed in" : ""}`,
    };
  },
};
