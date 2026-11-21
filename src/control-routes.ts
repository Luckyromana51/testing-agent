import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  BUILT_IN_PRESETS,
  cleanControl,
  CONTROL_FIELDS,
  ControlError,
  describeControl,
  liveActionsFor,
  NETWORKS,
  newPreset,
  SECTIONS,
  type LiveAction,
  type RunControl,
} from "./control.js";
import type { ScanQueue } from "./queue.js";
import type { Stores } from "./store.js";
import { cleanChoices } from "./tools/index.js";
import type { Project } from "./types.js";

/*
 * Master control: the catalogue of every setting, presets, a project's default settings, starting
 * a test with chosen settings, and the live switches (pause, resume, skip, finish now).
 */

interface Deps {
  stores: Stores;
  queue: ScanQueue;
  getProject: (id: string) => Project;
  fail: (status: number, message: string) => Error;
  userName: (req: FastifyRequest) => string;
}

const MAX_PRESETS = 100;

export function registerControlRoutes(app: FastifyInstance, { stores, queue, getProject, fail, userName }: Deps): void {
  /** Tidies the tester's settings and checks the chosen tools against the project's permissions. */
  const clean = (p: Project, input: unknown): RunControl => {
    let c: RunControl;
    try {
      c = cleanControl(input);
    } catch (err) {
      if (err instanceof ControlError) throw fail(400, err.message);
      throw err;
    }
    if (c.tools) {
      try {
        c.tools = cleanChoices(p.type, c.tools, p.permissions ?? []);
      } catch (err) {
        throw fail(400, (err as Error).message);
      }
    }
    return c;
  };

  const presets = () => [...BUILT_IN_PRESETS, ...(stores.settings.get().presets ?? [])];

  app.get("/api/control", async () => ({
    sections: SECTIONS,
    fields: CONTROL_FIELDS,
    presets: presets(),
    networks: NETWORKS,
  }));

  app.post("/api/control/presets", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: unknown; about?: unknown; control?: unknown };
    const saved = stores.settings.get().presets ?? [];
    if (saved.length >= MAX_PRESETS) throw fail(400, `At most ${MAX_PRESETS} presets: delete one first.`);
    let preset;
    try {
      preset = newPreset(b.name, b.about, b.control, userName(req));
    } catch (err) {
      throw fail(400, (err as Error).message);
    }
    if (presets().some((p) => p.name.toLowerCase() === preset.name.toLowerCase())) throw fail(409, "A preset with this name already exists.");
    // Tools are checked against each project's permissions when a test starts, not here.
    stores.settings.update({ presets: [...saved, preset] });
    return reply.code(201).send(preset);
  });

  app.delete<{ Params: { id: string } }>("/api/control/presets/:id", async (req, reply) => {
    if (BUILT_IN_PRESETS.some((p) => p.id === req.params.id)) throw fail(400, "Built-in presets cannot be deleted.");
    const saved = stores.settings.get().presets ?? [];
    if (!saved.some((p) => p.id === req.params.id)) throw fail(404, "Preset not found.");
    stores.settings.update({ presets: saved.filter((p) => p.id !== req.params.id) });
    return reply.code(204).send();
  });

  /** The project's default settings: every test of it starts with them, scheduled ones too. */
  app.put<{ Params: { id: string } }>("/api/projects/:id/control", async (req) => {
    const p = getProject(req.params.id);
    const control = clean(p, (req.body as { control?: unknown } | undefined)?.control);
    const next: Project = { ...p };
    if (Object.keys(control).length) next.control = control;
    else delete next.control;
    stores.projects.save(next);
    return { control: next.control ?? null, summary: describeControl(next.control) };
  });

  /** Checks settings without starting a test: what they change, and what the safety gates still hold back. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/control/check", async (req) => {
    const p = getProject(req.params.id);
    const control = clean(p, (req.body as { control?: unknown } | undefined)?.control);
    return { control, summary: describeControl(control) };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/runs/controlled", async (req, reply) => {
    const p = getProject(req.params.id);
    if (queue.busy(p.id)) throw fail(409, "A test of this project is already running.");
    const b = (req.body ?? {}) as { control?: unknown; preset?: unknown };
    const control = clean(p, b.control);
    const preset = typeof b.preset === "string" ? presets().find((x) => x.id === b.preset)?.name : undefined;
    return reply.code(201).send(queue.enqueue(p, "manual", { control, by: userName(req), preset }));
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/control", async (req) => {
    const run = stores.runs.get(req.params.id);
    if (!run) throw fail(404, "Run not found");
    const b = (req.body ?? {}) as { action?: unknown; slot?: unknown };
    const action = b.action as LiveAction;
    if (!["pause", "resume", "skip", "finish"].includes(action)) throw fail(400, "Pick pause, resume, skip or finish.");
    if (run.status !== "running") throw fail(409, run.status === "queued" ? "The test has not started yet: cancel it instead." : "This test has already finished.");
    if (!liveActionsFor(run.product ?? "website").includes(action)) throw fail(400, `This kind of test cannot ${action === "skip" ? "skip pages" : action === "finish" ? "finish early" : action}: cancel it instead.`);
    const slot = b.slot === undefined || b.slot === null ? undefined : Number(b.slot);
    if (slot !== undefined && (!Number.isInteger(slot) || slot < 0 || slot > 15)) throw fail(400, "Bad screen number.");
    if (!queue.control(run.id, action, { slot, by: userName(req) })) throw fail(409, "This test has already finished.");
    return stores.runs.get(run.id);
  });
}
