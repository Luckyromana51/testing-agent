import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  buildChecklist,
  cleanOwnCase,
  countRound,
  isOn,
  MANUAL_STATUSES,
  ManualError,
  roundCsv,
  roundMarkdown,
  type ManualCase,
  type ManualRound,
  type ManualStatus,
} from "./manual.js";
import type { Stores } from "./store.js";
import type { Issue, Project, Severity } from "./types.js";

/*
 * Manual testing: the project's checklist (every case on unless turned off), the team's own
 * cases, rounds with a result, note and screenshots per case, failures sent to the issue board,
 * and CSV / Markdown exports.
 */

interface Deps {
  stores: Stores;
  dataDir: string;
  getProject: (id: string) => Project;
  fail: (status: number, message: string) => Error;
  userName: (req: FastifyRequest) => string;
}

const MAX_SHOT = 8 * 1024 * 1024;
const MAX_SHOTS_PER_CASE = 10;
const MAX_OWN = 500;
const IMAGE_TYPES: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

/** The folder that holds a project's manual screenshots. */
export const manualFilesDir = (dataDir: string, projectId: string) => path.join(dataDir, "manual-files", projectId.replace(/[^\w-]/g, "_"));

export function registerManualRoutes(app: FastifyInstance, { stores, dataDir, getProject, fail, userName }: Deps): void {
  const checklist = (p: Project) =>
    buildChecklist(p, {
      roles: stores.vault.roleSummaries(p.id).map((r) => ({ id: r.id, name: r.name })),
      hasLogin: Boolean(stores.vault.get(p.id, { quiet: true })),
    });

  const getRound = (id: string): ManualRound => {
    const r = stores.manual.get(id);
    if (!r) throw fail(404, "That manual test round was not found.");
    getProject(r.projectId);
    return r;
  };

  const summary = (r: ManualRound) => ({
    id: r.id,
    name: r.name,
    tester: r.tester,
    build: r.build,
    env: r.env,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    counts: countRound(r),
  });

  /** Each case's results in the last rounds, newest first, for the history dots. */
  const history = (rounds: ManualRound[]) => {
    const h: Record<string, (ManualStatus | null)[]> = {};
    for (const r of rounds.slice(0, 8)) for (const c of r.cases) (h[c.id] ??= []).push(r.results[c.id]?.status ?? null);
    return h;
  };

  // Every project with its checklist size and last round, for the Manual tests page.
  app.get("/api/manual", async () =>
    stores.projects.list().map((p) => {
      const cases = checklist(p);
      const last = stores.manual.list(p.id, 1)[0];
      return { id: p.id, name: p.name, type: p.type, cases: cases.length, on: cases.filter((c) => isOn(p, c.id)).length, last: last ? summary(last) : null };
    }),
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/manual", async (req) => {
    const p = getProject(req.params.id);
    const rounds = stores.manual.list(p.id);
    return {
      project: { id: p.id, name: p.name, type: p.type, key: p.key },
      cases: checklist(p).map((c) => ({ ...c, on: isOn(p, c.id) })),
      rounds: rounds.map(summary),
      history: history(rounds),
    };
  });

  // Turn cases on or off: { on: [ids] }, { off: [ids] }, or { all: true | false }.
  app.patch<{ Params: { id: string } }>("/api/projects/:id/manual", async (req) => {
    const p = getProject(req.params.id);
    const b = (req.body ?? {}) as { on?: unknown; off?: unknown; all?: unknown };
    const ids = new Set(checklist(p).map((c) => c.id));
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ids.has(x)) : []);
    let off = new Set(p.manual?.off ?? []);
    if (b.all === true) off = new Set();
    else if (b.all === false) off = new Set(ids);
    for (const id of list(b.on)) off.delete(id);
    for (const id of list(b.off)) off.add(id);
    // Forget ids that no longer exist (a deleted journey), so the list does not grow for ever.
    const next: Project = { ...p, manual: { ...p.manual, off: [...off].filter((id) => ids.has(id)) } };
    stores.projects.save(next);
    return { on: ids.size - next.manual!.off!.length, total: ids.size };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/manual/cases", async (req, reply) => {
    const p = getProject(req.params.id);
    const own = p.manual?.own ?? [];
    if (own.length >= MAX_OWN) throw fail(400, `A project can have up to ${MAX_OWN} of its own cases.`);
    let c: ManualCase;
    try {
      c = cleanOwnCase(req.body);
    } catch (err) {
      if (err instanceof ManualError) throw fail(400, err.message);
      throw err;
    }
    stores.projects.save({ ...p, manual: { ...p.manual, own: [...own, c] } });
    return reply.code(201).send(c);
  });

  app.put<{ Params: { id: string; caseId: string } }>("/api/projects/:id/manual/cases/:caseId", async (req) => {
    const p = getProject(req.params.id);
    const own = p.manual?.own ?? [];
    if (!own.some((c) => c.id === req.params.caseId)) throw fail(404, "Only your own cases can be changed.");
    let c: ManualCase;
    try {
      c = cleanOwnCase(req.body, req.params.caseId);
    } catch (err) {
      if (err instanceof ManualError) throw fail(400, err.message);
      throw err;
    }
    stores.projects.save({ ...p, manual: { ...p.manual, own: own.map((x) => (x.id === c.id ? c : x)) } });
    return c;
  });

  app.delete<{ Params: { id: string; caseId: string } }>("/api/projects/:id/manual/cases/:caseId", async (req, reply) => {
    const p = getProject(req.params.id);
    const own = p.manual?.own ?? [];
    if (!own.some((c) => c.id === req.params.caseId)) throw fail(404, "Only your own cases can be deleted.");
    stores.projects.save({ ...p, manual: { ...p.manual, own: own.filter((x) => x.id !== req.params.caseId), off: (p.manual?.off ?? []).filter((x) => x !== req.params.caseId) } });
    return reply.code(204).send();
  });

  // A new round: every case that is on, or { only: "failed" } for the cases that failed or were not finished last time.
  app.post<{ Params: { id: string } }>("/api/projects/:id/manual/rounds", async (req, reply) => {
    const p = getProject(req.params.id);
    const b = (req.body ?? {}) as { name?: unknown; build?: unknown; env?: unknown; only?: unknown; tester?: unknown };
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    let cases = checklist(p).filter((c) => isOn(p, c.id));
    if (b.only === "failed") {
      const last = stores.manual.list(p.id, 1)[0];
      if (!last) throw fail(400, "There is no earlier round to repeat.");
      const again = new Set(last.cases.filter((c) => last.results[c.id]?.status !== "pass" && last.results[c.id]?.status !== "skip").map((c) => c.id));
      cases = last.cases.filter((c) => again.has(c.id));
      if (!cases.length) throw fail(400, "Every case in the last round passed or was skipped. Start a full round instead.");
    }
    if (!cases.length) throw fail(400, "Every case is turned off. Turn some on first.");
    const n = stores.manual.list(p.id).length + 1;
    const round: ManualRound = {
      id: randomUUID(),
      projectId: p.id,
      name: str(b.name, 120) || (b.only === "failed" ? `Re-check ${n}` : `Round ${n}`),
      tester: str(b.tester, 80) || userName(req),
      build: str(b.build, 120) || undefined,
      env: str(b.env, 120) || undefined,
      createdAt: new Date().toISOString(),
      cases,
      results: {},
    };
    stores.manual.save(round);
    return reply.code(201).send(round);
  });

  app.get<{ Params: { rid: string } }>("/api/manual/rounds/:rid", async (req) => {
    const r = getRound(req.params.rid);
    const p = getProject(r.projectId);
    return { round: r, counts: countRound(r), project: { id: p.id, name: p.name, type: p.type, key: p.key } };
  });

  app.patch<{ Params: { rid: string } }>("/api/manual/rounds/:rid", async (req) => {
    const r = getRound(req.params.rid);
    const b = (req.body ?? {}) as { finished?: unknown; name?: unknown; build?: unknown; env?: unknown };
    const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
    const next: ManualRound = { ...r };
    if (b.finished === true) next.finishedAt = new Date().toISOString();
    if (b.finished === false) delete next.finishedAt;
    if (str(b.name, 120)) next.name = str(b.name, 120)!;
    if (b.build !== undefined) next.build = str(b.build, 120) || undefined;
    if (b.env !== undefined) next.env = str(b.env, 120) || undefined;
    stores.manual.save(next);
    return { round: next, counts: countRound(next) };
  });

  app.delete<{ Params: { rid: string } }>("/api/manual/rounds/:rid", async (req, reply) => {
    const r = getRound(req.params.rid);
    stores.manual.delete(r.id);
    await rm(path.join(manualFilesDir(dataDir, r.projectId), r.id), { recursive: true, force: true });
    return reply.code(204).send();
  });

  const caseOf = (r: ManualRound, caseId: string) => {
    const c = r.cases.find((x) => x.id === caseId);
    if (!c) throw fail(404, "That case is not in this round.");
    return c;
  };
  const open = (r: ManualRound) => {
    if (r.finishedAt) throw fail(409, "This round is finished. Reopen it to change results.");
  };

  // Mark a case: { status: "pass" | "fail" | "skip" | null, note }.
  app.put<{ Params: { rid: string; caseId: string } }>("/api/manual/rounds/:rid/results/:caseId", async (req) => {
    const r = getRound(req.params.rid);
    open(r);
    caseOf(r, req.params.caseId);
    const b = (req.body ?? {}) as { status?: unknown; note?: unknown };
    const prev = r.results[req.params.caseId];
    const results = { ...r.results };
    if (b.status === null) {
      // Back to "not tested": the note and screenshots go too.
      delete results[req.params.caseId];
      for (const f of prev?.shots ?? []) await rm(path.join(manualFilesDir(dataDir, r.projectId), r.id, path.basename(f)), { force: true });
    } else {
      const status = (b.status === undefined ? prev?.status : b.status) as ManualStatus | undefined;
      if (!status || !MANUAL_STATUSES.includes(status)) throw fail(400, "The result is pass, fail or skip.");
      const note = typeof b.note === "string" ? b.note.slice(0, 5000) : prev?.note;
      results[req.params.caseId] = { ...prev, status, note: note || undefined, at: new Date().toISOString(), by: userName(req) };
    }
    const next = { ...r, results };
    stores.manual.save(next);
    return { result: results[req.params.caseId] ?? null, counts: countRound(next) };
  });

  // A screenshot for a case: { dataUrl: "data:image/png;base64,..." }. Pasted or chosen in the browser.
  app.post<{ Params: { rid: string; caseId: string } }>("/api/manual/rounds/:rid/results/:caseId/shots", { bodyLimit: Math.ceil(MAX_SHOT * 1.4) + 4096 }, async (req, reply) => {
    const r = getRound(req.params.rid);
    open(r);
    caseOf(r, req.params.caseId);
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String((req.body as { dataUrl?: unknown })?.dataUrl ?? ""));
    if (!m) throw fail(400, "Send a PNG, JPEG, WebP or GIF picture.");
    const bytes = Buffer.from(m[2], "base64");
    if (!bytes.length) throw fail(400, "The picture is empty.");
    if (bytes.length > MAX_SHOT) throw fail(413, `The picture is too big. The limit is ${MAX_SHOT / 1024 / 1024} MB.`);
    const magic: Record<string, (b: Buffer) => boolean> = {
      "image/png": (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
      "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
      "image/webp": (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
      "image/gif": (b) => b.subarray(0, 3).toString() === "GIF",
    };
    if (!magic[m[1]](bytes)) throw fail(400, "That file is not the picture type it says it is.");
    const prev = r.results[req.params.caseId];
    if ((prev?.shots?.length ?? 0) >= MAX_SHOTS_PER_CASE) throw fail(400, `Up to ${MAX_SHOTS_PER_CASE} screenshots per case.`);
    const dir = path.join(manualFilesDir(dataDir, r.projectId), r.id);
    await mkdir(dir, { recursive: true });
    const file = `${randomUUID()}${IMAGE_TYPES[m[1]]}`;
    await writeFile(path.join(dir, file), bytes);
    // Read again: another screenshot may have been saved while this one was written.
    const fresh = getRound(r.id);
    const cur = fresh.results[req.params.caseId];
    const result = { ...cur, status: cur?.status ?? ("fail" as ManualStatus), shots: [...(cur?.shots ?? []), file], at: new Date().toISOString(), by: userName(req) };
    stores.manual.save({ ...fresh, results: { ...fresh.results, [req.params.caseId]: result } });
    return reply.code(201).send({ file, result });
  });

  app.delete<{ Params: { rid: string; caseId: string; file: string } }>("/api/manual/rounds/:rid/results/:caseId/shots/:file", async (req, reply) => {
    const r = getRound(req.params.rid);
    open(r);
    const cur = r.results[req.params.caseId];
    if (!cur?.shots?.includes(req.params.file)) throw fail(404, "That screenshot was not found.");
    await rm(path.join(manualFilesDir(dataDir, r.projectId), r.id, path.basename(req.params.file)), { force: true });
    stores.manual.save({ ...r, results: { ...r.results, [req.params.caseId]: { ...cur, shots: cur.shots.filter((f) => f !== req.params.file) } } });
    return reply.code(204).send();
  });

  app.get<{ Params: { rid: string; file: string } }>("/api/manual/rounds/:rid/files/:file", async (req, reply) => {
    const r = getRound(req.params.rid);
    const file = path.basename(req.params.file);
    if (!Object.values(r.results).some((x) => x.shots?.includes(file))) throw fail(404, "That screenshot was not found.");
    const dir = path.join(manualFilesDir(dataDir, r.projectId), r.id);
    if (!existsSync(path.join(dir, file))) throw fail(404, "That screenshot was not found.");
    return reply.header("x-content-type-options", "nosniff").header("cache-control", "private, max-age=86400").sendFile(file, dir);
  });

  // Send a failed case to the issue board: { severity }.
  app.post<{ Params: { rid: string; caseId: string } }>("/api/manual/rounds/:rid/results/:caseId/issue", async (req, reply) => {
    const r = getRound(req.params.rid);
    const c = caseOf(r, req.params.caseId);
    const res = r.results[c.id];
    if (res?.status !== "fail") throw fail(400, "Only a failed case can go to the issue board.");
    if (res.issue) throw fail(409, `Already on the issue board as ${res.issue}.`);
    const sev = (req.body as { severity?: unknown })?.severity;
    const severity: Severity = SEVERITIES.includes(sev as Severity) ? (sev as Severity) : "medium";
    const p = getProject(r.projectId);
    const now = new Date().toISOString();
    const seq = p.issueSeq + 1;
    const by = userName(req);
    const issue: Issue = {
      id: randomUUID(),
      key: `${p.key}-${seq}`,
      projectId: p.id,
      fingerprint: `manual:${c.id}:${r.id}`,
      rule: `manual:${c.id}`,
      agent: "manual",
      title: `Manual test failed: ${c.title}`,
      detail: [
        `Found by ${res.by} in the manual test "${r.name}"${r.build ? ` (build ${r.build})` : ""}${r.env ? ` on ${r.env}` : ""}.`,
        "",
        "Steps:",
        ...c.steps.map((s, i) => `${i + 1}. ${s}`),
        "",
        `Should happen: ${c.expected}`,
        ...(res.note ? ["", `What happened: ${res.note}`] : []),
        ...(res.shots?.length ? ["", `${res.shots.length} screenshot(s) in the manual test round.`] : []),
      ].join("\n"),
      category: categoryOf(c),
      severity,
      status: "open",
      occurrences: [{ pageUrl: p.target.url ?? p.name, evidence: res.note?.split("\n")[0] }],
      firstSeenRunId: r.id,
      lastSeenRunId: r.id,
      firstSeenAt: now,
      lastSeenAt: now,
      updatedAt: now,
      history: [{ at: now, type: "created", text: `Sent from the manual test "${r.name}"`, by }],
    };
    stores.projects.save({ ...p, issueSeq: seq });
    stores.issues.save(issue);
    const fresh = getRound(r.id);
    stores.manual.save({ ...fresh, results: { ...fresh.results, [c.id]: { ...fresh.results[c.id]!, issue: issue.key } } });
    return reply.code(201).send({ key: issue.key, id: issue.id });
  });

  app.get<{ Params: { rid: string }; Querystring: { format?: string } }>("/api/manual/rounds/:rid/export", async (req, reply) => {
    const r = getRound(req.params.rid);
    const p = getProject(r.projectId);
    const base = `${p.name}-${r.name}`.replace(/[^\w-]+/g, "-").replace(/-+/g, "-").slice(0, 80);
    if (req.query.format === "md") {
      return reply.type("text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${base}.md"`).send(roundMarkdown(r, p.name));
    }
    return reply.type("text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${base}.csv"`).send("﻿" + roundCsv(r));
  });
}

function categoryOf(c: ManualCase) {
  const s = `${c.section} ${c.title}`.toLowerCase();
  if (/access|screen reader|keyboard|zoom|colour|caption/.test(s)) return "accessibility" as const;
  if (/security|https|session|upload|password|sign|role|refused/.test(s)) return "security" as const;
  if (/speed|slow|performance|load/.test(s)) return "performance" as const;
  if (/phone|mobile|rotate/.test(s)) return "mobile" as const;
  if (/seo/.test(s)) return "seo" as const;
  return "functional" as const;
}
