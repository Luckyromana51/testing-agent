import type { FastifyInstance, FastifyRequest } from "fastify";
import { cleanControl, ControlError, type RunControl } from "./control.js";
import { hostOf, permissionStatus, type Permission } from "./permission.js";
import type { ScanQueue } from "./queue.js";
import type { Stores } from "./store.js";
import { cleanChoices, TOOLS } from "./tools/index.js";
import type { ToolChoice } from "./tools/types.js";
import type { Project } from "./types.js";

/*
 * The hack agent: one place to run the attack tools (GLV's attack agent, GLV's probes, ZAP's
 * active scan) on many systems at once. It opens no gate of its own. A system can be chosen only
 * when an attack permission covers its address and its proof is in place, each test is started by
 * a person (never on the schedule), the tools only read, and each one checks the permission and its
 * proof again just before it runs. A site nobody here runs cannot hold the proof file, so it stays
 * out.
 */

export const HACK_PRESET = "Hack agent";

/** The attack tools the hack agent can run. Load tools (k6, JMeter) stay on the project page. */
export const HACK_TOOLS = TOOLS.filter((t) => t.safety === "permission" && (t.permission ?? "attack") === "attack").map((t) => t.id);

export type HackState = "ready" | "waiting-proof" | "not-unlocked" | "no-address" | "busy" | "not-supported";

export interface HackTarget {
  projectId: string;
  name: string;
  type: Project["type"];
  host?: string;
  state: HackState;
  /** Plain words for the state, and what to do next. */
  why: string;
  own?: boolean;
  until?: string;
  /** Hack-agent tools that test this kind of product. */
  tools: string[];
  last?: { runId: string; at: string; status: string; score?: number; findings?: number };
}

/** The host a project's attack tools aim at (its site, or its API). */
function targetHost(p: Project): string | undefined {
  const url = p.target.url ?? p.target.specUrl ?? p.target.graphqlUrl ?? p.target.soapUrl;
  if (!url) return undefined;
  try {
    return hostOf(url);
  } catch {
    return undefined;
  }
}

/** Where a project stands for the hack agent. */
export function hackTarget(p: Project, busy: boolean, now = Date.now()): HackTarget {
  const tools = TOOLS.filter((t) => HACK_TOOLS.includes(t.id) && t.products.includes(p.type)).map((t) => t.id);
  const host = targetHost(p);
  const base = { projectId: p.id, name: p.name, type: p.type, host, tools };
  if (!tools.length) return { ...base, state: "not-supported", why: "The attack tools test websites, web apps and APIs, not this kind of product." };
  if (!host) return { ...base, state: "no-address", why: "This project has no web address to test." };
  const covering = (p.permissions ?? []).filter((x: Permission) => x.kinds.includes("attack") && x.hosts.includes(host));
  const active = covering.filter((x) => permissionStatus(x, now) === "active").sort((a, b) => Date.parse(b.until) - Date.parse(a.until))[0];
  if (!active) {
    const waiting = covering.find((x) => permissionStatus(x, now) === "waiting-proof");
    if (waiting) return { ...base, state: "waiting-proof", why: `Unlocked, but the proof file is not on ${host} yet. Put it there and press Check the proof.`, own: Boolean(waiting.own) };
    return {
      ...base,
      state: "not-unlocked",
      why: `Not unlocked for attacks. The owner unlocks ${host} once: as our own system, or with the client's written permission.`,
    };
  }
  if (busy) return { ...base, state: "busy", why: "A test of this project is running. It can join the next hack run.", own: Boolean(active.own), until: active.until };
  return { ...base, state: "ready", why: active.own ? "Our own system, verified." : `Allowed by ${active.grantedBy}.`, own: Boolean(active.own), until: active.until };
}

interface Deps {
  stores: Stores;
  queue: ScanQueue;
  fail: (status: number, message: string) => Error;
  userName: (req: FastifyRequest) => string;
}

const MAX_SYSTEMS = 50;

export function registerHackRoutes(app: FastifyInstance, { stores, queue, fail, userName }: Deps): void {
  const lastHack = (projectId: string): HackTarget["last"] => {
    const r = stores.runs.list(30, projectId).find((x) => x.controlBy?.preset === HACK_PRESET);
    if (!r) return undefined;
    return {
      runId: r.id,
      at: r.createdAt,
      status: r.status,
      ...(r.result?.scores.security !== undefined ? { score: r.result.scores.security } : {}),
      ...(r.result ? { findings: r.result.findings.filter((f) => (f.agent ?? "").startsWith("tool.") && f.severity !== "info").length } : {}),
    };
  };

  app.get("/api/hack", async () => ({
    tools: HACK_TOOLS,
    targets: stores.projects
      .list()
      .map((p) => ({ ...hackTarget(p, queue.busy(p.id)), last: lastHack(p.id) }))
      .sort((a, b) => Number(b.state === "ready") - Number(a.state === "ready") || a.name.localeCompare(b.name)),
  }));

  /** Starts the hack agent on each chosen system that is ready. Never scheduled: a person presses Start. */
  app.post("/api/hack/runs", async (req, reply) => {
    const b = (req.body ?? {}) as { projectIds?: unknown; tools?: unknown; maxPages?: unknown };
    const ids = Array.isArray(b.projectIds) ? [...new Set(b.projectIds.filter((x): x is string => typeof x === "string"))] : [];
    if (!ids.length) throw fail(400, "Choose at least one system.");
    if (ids.length > MAX_SYSTEMS) throw fail(400, `At most ${MAX_SYSTEMS} systems in one hack run.`);
    const wanted = (Array.isArray(b.tools) ? b.tools : []).filter(
      (t): t is ToolChoice => Boolean(t) && typeof (t as ToolChoice).id === "string" && HACK_TOOLS.includes((t as ToolChoice).id),
    );
    if (!wanted.length) throw fail(400, "Choose at least one attack tool.");

    const started: { projectId: string; name: string; runId: string }[] = [];
    const skipped: { projectId: string; name: string; why: string }[] = [];
    for (const id of ids) {
      const p = stores.projects.get(id);
      if (!p) {
        skipped.push({ projectId: id, name: id, why: "Project not found." });
        continue;
      }
      const t = hackTarget(p, queue.busy(p.id));
      if (t.state !== "ready") {
        skipped.push({ projectId: p.id, name: p.name, why: t.why });
        continue;
      }
      const tools = wanted.filter((w) => t.tools.includes(w.id));
      if (!tools.length) {
        skipped.push({ projectId: p.id, name: p.name, why: "None of the chosen tools tests this kind of product." });
        continue;
      }
      let control: RunControl;
      try {
        // Security checks and the chosen attack tools only: no phone or tablet pass, no extras.
        control = cleanControl({
          categories: ["security"],
          tabletOn: false,
          phoneOn: false,
          checkLinks: false,
          extras: { inspect: false, visual: false, journeys: false, ai: false },
          ...(b.maxPages !== undefined ? { maxPages: b.maxPages } : {}),
        });
        // Checked against the project's permissions again, the same way as every other test.
        control.tools = cleanChoices(p.type, tools, p.permissions ?? []);
      } catch (err) {
        if (err instanceof ControlError) throw fail(400, err.message);
        skipped.push({ projectId: p.id, name: p.name, why: (err as Error).message });
        continue;
      }
      const run = queue.enqueue(p, "manual", { control, by: userName(req), preset: HACK_PRESET });
      started.push({ projectId: p.id, name: p.name, runId: run.id });
    }
    return reply.code(started.length ? 201 : 200).send({ started, skipped });
  });
}
