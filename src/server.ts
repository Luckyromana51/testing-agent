import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { ALL_AGENTS, agentsFor, describeAgent } from "./agents/registry.js";
import { aiEnabled } from "./ai/triage.js";
import { Auth, checkPasswordRules, fromOutside, hashPassword, loginTurnedOff, recordFailure, tooManyFailures } from "./auth.js";
import { groupFindings } from "./group.js";
import { ACTIVE, projectKey } from "./issues.js";
import { PRODUCTS } from "./products.js";
import { ScanQueue } from "./queue.js";
import { startScheduler } from "./scheduler.js";
import { TOOLS, cleanChoices, defaultChoices, describeTool, toolStatus } from "./tools/index.js";
import { toJunit, toSarif } from "./export.js";
import { openStores, type Settings, type Stores } from "./store.js";
import { buildLogin, buildTarget, defaultName, type TargetInput } from "./targets.js";
import type { Issue, IssueStatus, Login, ProductType, Project, ProjectTarget, Run, Schedule, Severity, User } from "./types.js";
import { validateTarget } from "./runner/urls.js";

export { validateTarget } from "./runner/urls.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Largest file that can be uploaded (APKs with native code can be big). */
const MAX_UPLOAD = 300_000_000;

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
const STATUSES: IssueStatus[] = ["open", "in_progress", "fixed", "verified", "reopened", "wont_fix"];
const SCHEDULES: Schedule[] = ["off", "daily", "weekly"];

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function runSummary({ result, ai, progress, ...run }: Run) {
  return {
    ...run,
    overallScore: result?.overallScore,
    pageCount: result?.pages.length,
    findingCount: result ? groupFindings(result.findings).length : undefined,
    lastProgress: progress.at(-1),
  };
}

function issueCounts(issues: Issue[]) {
  const open = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
  for (const i of issues) {
    byStatus[i.status]++;
    if (ACTIVE.includes(i.status) && i.status !== "fixed") open[i.severity]++;
  }
  return { open, byStatus };
}

/** Gives runs from the first version (before projects existed) a project per website. */
function migrateLooseRuns(stores: Stores): void {
  const loose = stores.runs.withoutProject();
  if (!loose.length) return;
  const byOrigin = new Map<string, Run[]>();
  for (const r of loose) {
    let origin: string;
    try {
      origin = new URL(r.url).origin;
    } catch {
      continue;
    }
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), r]);
  }
  for (const [origin, runs] of byOrigin) {
    const name = new URL(origin).hostname.replace(/^www\./, "");
    const latest = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const project: Project = {
      id: randomUUID(),
      key: projectKey(name, stores.projects.list().map((p) => p.key)),
      name,
      type: "website",
      target: { url: latest.url, maxPages: 20 },
      schedule: "off",
      createdAt: runs.at(-1)!.createdAt,
      lastRunId: latest.id,
      lastRunAt: latest.createdAt,
      lastScore: latest.result?.overallScore,
      issueSeq: 0,
    };
    stores.projects.save(project);
    for (const r of runs) stores.runs.save({ ...r, projectId: project.id, product: "website" });
  }
}

export interface AppOptions {
  dataDir: string;
  logger?: boolean;
  /** Start the daily/weekly re-test scheduler (off in tests). */
  scheduler?: boolean;
}

export async function createApp(opts: AppOptions) {
  const stores = openStores(opts.dataDir);
  migrateLooseRuns(stores);
  const queue = new ScanQueue(stores, opts.dataDir, Number(process.env.SCAN_CONCURRENCY ?? 2));
  const auth = new Auth(stores.users);
  auth.bootstrapFromEnv();
  const stopScheduler = opts.scheduler ? startScheduler(stores.projects, queue) : () => {};

  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    trustProxy: process.env.TRUST_PROXY === "1",
    bodyLimit: 1_000_000,
  });
  app.addHook("onClose", async () => {
    stopScheduler();
    await queue.shutdown();
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.code(status).send({ error: status >= 500 ? "Something went wrong on the server." : err.message });
  });

  const loginOff = loginTurnedOff();
  if (loginOff) {
    app.log.warn(
      "Login is turned off (AUTH_DISABLED=1): everyone who opens the dashboard is the owner. Only visits from this computer and its local network are accepted. Set AUTH_DISABLED=0 before putting this on a server.",
    );
  }

  const PUBLIC = new Set(["/api/health", "/api/auth/state", "/api/auth/setup", "/api/auth/login", "/api/auth/logout"]);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    // Refuse state-changing requests sent from other websites.
    if (req.method !== "GET" && req.headers.origin) {
      let originHost = "";
      try {
        originHost = new URL(req.headers.origin).host;
      } catch {
        // unreadable origin: refused below
      }
      if (originHost !== req.headers.host) return reply.code(403).send({ error: "Cross-site request refused." });
    }
    if (loginOff) {
      // Safety net in case the switch is left on by mistake on a server that the internet can reach.
      if (fromOutside(req)) {
        return reply.code(403).send({
          error: "Login is turned off on this server (AUTH_DISABLED=1), so it only accepts visits from its own computer and local network.",
        });
      }
      req.user = auth.localOwner();
      return;
    }
    req.user = auth.userFor(req);
    if (!PUBLIC.has(req.url.split("?")[0]) && !req.user) {
      return reply.code(401).send({ error: "Please sign in." });
    }
  });

  const ownerOnly = (req: FastifyRequest) => {
    if (req.user?.role !== "owner") throw new HttpError(403, "Only the owner can do this.");
  };
  const body = <T>(req: FastifyRequest) => (req.body ?? {}) as Partial<T>;
  const getProject = (id: string) => {
    const p = stores.projects.get(id);
    if (!p) throw new HttpError(404, "Project not found");
    return p;
  };

  // ---- Auth -----------------------------------------------------------------------------------
  app.get("/api/health", async () => ({ ok: true, ai: aiEnabled() }));

  app.get("/api/auth/state", async (req) => ({
    setupNeeded: !loginOff && auth.setupNeeded(),
    user: req.user ?? null,
    loginOff,
  }));

  app.post("/api/auth/setup", async (req, reply) => {
    if (!auth.setupNeeded()) throw new HttpError(409, "The owner account already exists. Please sign in.");
    const b = body<{ email: string; name: string; password: string }>(req);
    if (!b.email || !/^\S+@\S+\.\S+$/.test(b.email)) throw new HttpError(400, "Enter a valid email address.");
    const problem = checkPasswordRules(String(b.password ?? ""));
    if (problem) throw new HttpError(400, problem);
    const user = auth.createUser({ email: b.email, name: b.name ?? "", role: "owner", password: String(b.password) });
    auth.startSession(reply, req, user);
    return { user };
  });

  app.post("/api/auth/login", async (req, reply) => {
    if (tooManyFailures(req.ip)) throw new HttpError(429, "Too many failed sign-ins. Try again in 15 minutes.");
    const b = body<{ email: string; password: string }>(req);
    const user = auth.login(String(b.email ?? ""), String(b.password ?? ""));
    if (!user) {
      recordFailure(req.ip);
      throw new HttpError(401, "Wrong email or password.");
    }
    auth.startSession(reply, req, user);
    return { user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    auth.endSession(reply, req);
    return { ok: true };
  });

  app.post("/api/auth/password", async (req) => {
    if (loginOff) throw new HttpError(400, "Login is turned off (AUTH_DISABLED=1), so there is no password to change.");
    const b = body<{ current: string; password: string }>(req);
    if (!auth.login(req.user!.email, String(b.current ?? ""))) throw new HttpError(400, "The current password is wrong.");
    const problem = checkPasswordRules(String(b.password ?? ""));
    if (problem) throw new HttpError(400, problem);
    stores.users.setPassword(req.user!.id, hashPassword(String(b.password)));
    return { ok: true };
  });

  // ---- Meta -----------------------------------------------------------------------------------
  app.get("/api/meta", async () => {
    const settings = stores.settings.get();
    const status = await toolStatus();
    return {
      // Outside tools, with whether each is installed on this server (and why not).
      tools: TOOLS.map((t) => ({ ...describeTool(t), ready: status[t.id] === null, ...(status[t.id] ? { notReady: status[t.id] } : {}) })),
      products: PRODUCTS,
      agents: ALL_AGENTS.map((a) => ({ ...describeAgent(a), enabled: settings.agents[a.id] ?? !a.defaultOff })),
      ai: aiEnabled(),
      aiSummary: settings.aiSummary,
      defaultMaxPages: settings.defaultMaxPages,
      vault: stores.vault.status(),
    };
  });

  // ---- Projects -------------------------------------------------------------------------------
  const projectSummary = (p: Project) => {
    const runs = stores.runs.list(1, p.id);
    return {
      ...p,
      counts: issueCounts(stores.issues.list(p.id)),
      lastRun: runs[0] ? runSummary(runs[0]) : null,
      busy: queue.busy(p.id),
      waiting: queue.waitingFor(p.id),
      // Never the secrets themselves: only whether they are saved.
      login: stores.vault.summary(p.id) ?? null,
    };
  };

  app.get("/api/projects", async () => stores.projects.list().map(projectSummary));

  app.post("/api/projects", async (req, reply) => {
    const b = body<TargetInput & { name: string; type: ProductType; schedule: Schedule; login: Partial<Login> | null; tools: unknown }>(req);
    const type = (b.type ?? "website") as ProductType;
    const info = PRODUCTS.find((p) => p.type === type);
    if (!info) throw new HttpError(400, "Unknown product type.");
    if (!info.available) throw new HttpError(400, `${info.name} testing is coming in a later update.`);
    let target: ProjectTarget;
    let login: Login | undefined;
    let tools;
    try {
      const { login: loginInput, tools: toolsInput, ...targetInput } = b;
      target = buildTarget(type, targetInput, queue.uploadsDir(), stores.settings.get().defaultMaxPages);
      if (loginInput) login = buildLogin(type, loginInput);
      // The tester's choice from the tool tabs; without one, every safe tool installed here.
      tools = toolsInput === undefined ? await defaultChoices(type) : cleanChoices(type, toolsInput);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const name = (b.name ?? "").trim() || defaultName(type, target);
    const project: Project = {
      id: randomUUID(),
      key: projectKey(name, stores.projects.list().map((p) => p.key)),
      name: name.slice(0, 80),
      type,
      target,
      schedule: SCHEDULES.includes(b.schedule as Schedule) ? (b.schedule as Schedule) : "off",
      createdAt: new Date().toISOString(),
      issueSeq: 0,
      tools,
    };
    stores.projects.save(project);
    if (login) stores.vault.save(project.id, login);
    const run = queue.enqueue(project);
    return reply.code(201).send({ project: projectSummary(project), run });
  });

  // Uploads: the raw file in the body (APK, IPA, a zip of code, or an OpenAPI file).
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  app.post("/api/uploads", { bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    const fileName = decodeURIComponent(String(req.headers["x-file-name"] ?? "")).replace(/[^\w. ()-]/g, "_").slice(0, 200);
    const ext = fileName.match(/\.(apk|ipa|zip|json|ya?ml)$/i)?.[0]?.toLowerCase();
    if (!ext) throw new HttpError(400, "Upload an .apk, .ipa or .zip file, or an OpenAPI file (.json or .yaml).");
    if (!(req.body instanceof Readable)) throw new HttpError(400, "Send the file as application/octet-stream.");
    await mkdir(queue.uploadsDir(), { recursive: true });
    const file = `${randomUUID()}${ext}`;
    const full = path.join(queue.uploadsDir(), file);
    let size = 0;
    try {
      await pipeline(
        req.body,
        new Transform({
          transform(chunk: Buffer, _enc, cb) {
            size += chunk.length;
            cb(size > MAX_UPLOAD ? new Error("too big") : null, chunk);
          },
        }),
        createWriteStream(full),
      );
    } catch {
      await rm(full, { force: true });
      throw new HttpError(413, `The file is too big. The limit is ${MAX_UPLOAD / 1e6} MB.`);
    }
    const head = Buffer.alloc(4);
    const fd = await open(full, "r");
    await fd.read(head, 0, 4, 0);
    await fd.close();
    const isZip = head.readUInt32LE(0) === 0x04034b50;
    if ([".apk", ".ipa", ".zip"].includes(ext) !== isZip || size === 0) {
      await rm(full, { force: true });
      throw new HttpError(400, size === 0 ? "The file is empty." : `That does not look like a real ${ext} file.`);
    }
    return reply.code(201).send({ file, fileName, size });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = getProject(req.params.id);
    const runs = stores.runs.list(100, p.id);
    return {
      project: projectSummary(p),
      runs: runs.map(runSummary),
      trend: runs
        .filter((r) => r.status === "done" && r.result)
        .map((r) => ({ runId: r.id, at: r.createdAt, score: r.result!.overallScore, diff: r.diff }))
        .reverse(),
      agents: agentsFor(p.type, stores.settings.get().agents).map(describeAgent),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = getProject(req.params.id);
    const b = body<TargetInput & { name: string; schedule: Schedule; login: Partial<Login> | null; tools: unknown }>(req);
    const next: Project = { ...p, target: { ...p.target } };
    if (b.name !== undefined) next.name = String(b.name).trim().slice(0, 80) || p.name;
    const { name: _n, schedule: _s, login: loginInput, tools: toolsInput, ...targetInput } = b;
    let login: Login | undefined;
    try {
      if (toolsInput === null) delete next.tools;
      else if (toolsInput !== undefined) next.tools = cleanChoices(p.type, toolsInput);
      if (Object.keys(targetInput).length) {
        next.target = buildTarget(p.type, targetInput, queue.uploadsDir(), stores.settings.get().defaultMaxPages, p.target);
      }
      if (loginInput) login = buildLogin(p.type, loginInput, stores.vault.summary(p.id));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    if (loginInput === null) stores.vault.delete(p.id);
    else if (login) stores.vault.save(p.id, login);
    if (b.schedule !== undefined) {
      if (!SCHEDULES.includes(b.schedule)) throw new HttpError(400, "Schedule must be off, daily or weekly.");
      next.schedule = b.schedule;
    }
    if (p.target.file && p.target.file !== next.target.file) await rm(path.join(queue.uploadsDir(), path.basename(p.target.file)), { force: true });
    stores.projects.save(next);
    return projectSummary(next);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    // A queued or running test is stopped first, so nothing writes to the project after it is gone.
    await queue.cancelProject(p.id, "The project was deleted");
    for (const runId of stores.runs.deleteForProject(p.id)) await queue.removeArtifacts(runId);
    stores.issues.deleteForProject(p.id);
    stores.vault.delete(p.id);
    if (p.target.file) await rm(path.join(queue.uploadsDir(), path.basename(p.target.file)), { force: true });
    stores.projects.delete(p.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/runs", async (req, reply) => {
    const p = getProject(req.params.id);
    if (queue.busy(p.id)) throw new HttpError(409, "A test of this project is already running.");
    const b = body<{ trigger: Run["trigger"] }>(req);
    return reply.code(201).send(queue.enqueue(p, b.trigger === "retest" ? "retest" : "manual"));
  });

  // ---- Runs -----------------------------------------------------------------------------------
  app.get<{ Querystring: { projectId?: string } }>("/api/runs", async (req) =>
    stores.runs.list(50, req.query.projectId).map(runSummary),
  );

  /** Quick scan by address (the first version's API): reuses the website project for that site. */
  app.post("/api/runs", async (req, reply) => {
    const b = body<{ url: string; maxPages: number; checkLinks: boolean }>(req);
    let url: string;
    try {
      url = validateTarget(String(b.url ?? ""));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const host = new URL(url).hostname.replace(/^www\./, "");
    let project = stores.projects
      .list()
      .find((p) => p.target.url && new URL(p.target.url).hostname.replace(/^www\./, "") === host);
    if (!project) {
      project = {
        id: randomUUID(),
        key: projectKey(host, stores.projects.list().map((p) => p.key)),
        name: host,
        type: "website",
        target: { url },
        schedule: "off",
        createdAt: new Date().toISOString(),
        issueSeq: 0,
      };
    }
    project = {
      ...project,
      target: {
        ...project.target,
        url,
        maxPages: Math.min(Math.max(Number(b.maxPages) || project.target.maxPages || 10, 1), 200),
        checkLinks: b.checkLinks !== false,
      },
    };
    stores.projects.save(project);
    return reply.code(201).send(queue.enqueue(project));
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = stores.runs.get(req.params.id);
    return run ?? reply.code(404).send({ error: "Run not found" });
  });

  // The run's findings for CI and security dashboards: SARIF (GitHub code scanning and others) and JUnit XML.
  const exportOf = (id: string) => {
    const run = stores.runs.get(id);
    if (!run) throw new HttpError(404, "Run not found");
    if (!run.result) throw new HttpError(409, "This test has no result yet.");
    const project = (stores.projects.get(run.projectId ?? "")?.name ?? "report").replace(/[^\w-]+/g, "-").slice(0, 60);
    return { result: run.result, name: `glv-${project}-${run.id.slice(0, 8)}` };
  };
  app.get<{ Params: { id: string } }>("/api/runs/:id/report.sarif", async (req, reply) => {
    const { result, name } = exportOf(req.params.id);
    reply.header("Content-Disposition", `attachment; filename="${name}.sarif"`).header("X-Content-Type-Options", "nosniff");
    return reply.type("application/sarif+json").send(JSON.stringify(toSarif(result), null, 1));
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/report.junit.xml", async (req, reply) => {
    const { result, name } = exportOf(req.params.id);
    reply.header("Content-Disposition", `attachment; filename="${name}.junit.xml"`).header("X-Content-Type-Options", "nosniff");
    return reply.type("application/xml").send(toJunit(result));
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req) => {
    const run = stores.runs.get(req.params.id);
    if (!run) throw new HttpError(404, "Run not found");
    if (run.status !== "queued" && run.status !== "running") throw new HttpError(409, "This test has already finished.");
    const who = req.user && req.user.id !== "local-owner" ? req.user.name || req.user.email : "";
    if (!(await queue.cancel(run.id, who ? `Cancelled by ${who}` : "Cancelled"))) {
      throw new HttpError(409, "This test has already finished.");
    }
    return stores.runs.get(run.id);
  });

  app.delete<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = stores.runs.get(req.params.id);
    if (run && (run.status === "queued" || run.status === "running")) {
      throw new HttpError(409, "Wait for the test to finish before deleting it.");
    }
    stores.runs.delete(req.params.id);
    await queue.removeArtifacts(req.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string; file: string } }>("/api/runs/:id/artifacts/:file", async (req, reply) => {
    const { id, file } = req.params;
    if (!/^[\w-]+$/.test(id) || !/^[\w.-]+\.(jpg|png)$/.test(file)) {
      // Reports written by the outside tools (Lighthouse, ZAP...).
      if (/^[\w-]+$/.test(id) && /^tool-[\w.-]+\.(html|json|xml)$/.test(file)) {
        // A tool's HTML report runs in a sandbox: it cannot read the dashboard's login or data.
        reply.header("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-downloads");
        reply.header("X-Content-Type-Options", "nosniff");
        if (file.endsWith(".json")) reply.header("Content-Disposition", `inline; filename="${file}"`);
        // JUnit XML is downloaded, never shown as a page.
        if (file.endsWith(".xml")) {
          reply.header("Content-Disposition", `attachment; filename="${file}"`);
          reply.type("application/xml");
        }
        return reply.sendFile(file, queue.artifactsDir(id));
      }
      return reply.code(400).send({ error: "Bad file name" });
    }
    return reply.sendFile(file, queue.artifactsDir(id));
  });

  // ---- Issues ---------------------------------------------------------------------------------
  app.get<{ Querystring: { projectId?: string } }>("/api/issues", async (req) => {
    const projects = new Map(stores.projects.list().map((p) => [p.id, p]));
    return stores.issues
      .list(req.query.projectId)
      .filter((i) => projects.has(i.projectId))
      .map(({ history, ...i }) => ({ ...i, projectName: projects.get(i.projectId)!.name, events: history.length }));
  });

  app.get<{ Params: { id: string } }>("/api/issues/:id", async (req) => {
    const issue = stores.issues.get(req.params.id);
    if (!issue) throw new HttpError(404, "Issue not found");
    return { ...issue, projectName: stores.projects.get(issue.projectId)?.name };
  });

  app.patch<{ Params: { id: string } }>("/api/issues/:id", async (req) => {
    const issue = stores.issues.get(req.params.id);
    if (!issue) throw new HttpError(404, "Issue not found");
    const b = body<{ status: IssueStatus; assignee: string; comment: string }>(req);
    const now = new Date().toISOString();
    const by = req.user!.name;
    const next: Issue = { ...issue, history: [...issue.history], updatedAt: now };
    if (b.status !== undefined && b.status !== issue.status) {
      if (!STATUSES.includes(b.status)) throw new HttpError(400, "Unknown status.");
      if (b.status === "verified") throw new HttpError(400, "Only a re-test can verify a fix. Mark it fixed, then re-test.");
      next.status = b.status;
      next.history.push({ at: now, type: "status", text: `Status changed to ${b.status.replace("_", " ")}`, by });
    }
    if (b.assignee !== undefined) {
      next.assignee = String(b.assignee).trim().slice(0, 80) || undefined;
      next.history.push({ at: now, type: "status", text: next.assignee ? `Assigned to ${next.assignee}` : "Unassigned", by });
    }
    if (b.comment) next.history.push({ at: now, type: "comment", text: String(b.comment).slice(0, 4000), by });
    stores.issues.save(next);
    return { ...next, projectName: stores.projects.get(next.projectId)?.name };
  });

  // ---- Owner panel ----------------------------------------------------------------------------
  app.get("/api/owner/overview", async (req) => {
    ownerOnly(req);
    const projects = stores.projects.list();
    const issues = stores.issues.list();
    const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const settings = stores.settings.get();
    return {
      projects: projects.length,
      scheduled: projects.filter((p) => p.schedule !== "off").length,
      runsTotal: stores.runs.count(),
      runsThisWeek: stores.runs.count(weekAgo),
      issues: issueCounts(issues),
      fixedThisWeek: issues.filter((i) => i.status === "verified" && i.updatedAt >= weekAgo).length,
      queue: queue.status(),
      agents: { total: ALL_AGENTS.length, on: ALL_AGENTS.filter((a) => settings.agents[a.id] ?? !a.defaultOff).length },
      ai: aiEnabled(),
      users: stores.users.count(),
      products: PRODUCTS.map((p) => ({ type: p.type, name: p.name, available: p.available, projects: projects.filter((x) => x.type === p.type).length })),
    };
  });

  app.get("/api/owner/settings", async (req) => {
    ownerOnly(req);
    return stores.settings.get();
  });

  app.patch("/api/owner/settings", async (req) => {
    ownerOnly(req);
    const b = body<Settings>(req);
    const patch: Partial<Settings> = {};
    if (b.agents) {
      const known = new Set(ALL_AGENTS.map((a) => a.id));
      patch.agents = { ...stores.settings.get().agents };
      for (const [id, on] of Object.entries(b.agents)) if (known.has(id)) patch.agents[id] = Boolean(on);
    }
    if (b.defaultMaxPages !== undefined) patch.defaultMaxPages = Math.min(Math.max(Number(b.defaultMaxPages) || 20, 1), 200);
    if (b.aiSummary !== undefined) patch.aiSummary = Boolean(b.aiSummary);
    return stores.settings.update(patch);
  });

  app.get("/api/owner/users", async (req) => {
    ownerOnly(req);
    return stores.users.list();
  });

  app.post("/api/owner/users", async (req, reply) => {
    ownerOnly(req);
    const b = body<{ email: string; name: string; password: string; role: "owner" | "member" }>(req);
    if (!b.email || !/^\S+@\S+\.\S+$/.test(b.email)) throw new HttpError(400, "Enter a valid email address.");
    if (stores.users.byEmail(b.email)) throw new HttpError(409, "Someone with that email already has an account.");
    const problem = checkPasswordRules(String(b.password ?? ""));
    if (problem) throw new HttpError(400, problem);
    const user = auth.createUser({
      email: b.email,
      name: b.name ?? "",
      role: b.role === "owner" ? "owner" : "member",
      password: String(b.password),
    });
    return reply.code(201).send(user);
  });

  app.delete<{ Params: { id: string } }>("/api/owner/users/:id", async (req, reply) => {
    ownerOnly(req);
    if (req.params.id === req.user!.id) throw new HttpError(400, "You cannot remove your own account.");
    stores.users.delete(req.params.id);
    return reply.code(204).send();
  });

  // ---- Dashboard ------------------------------------------------------------------------------
  // Serve the built dashboard (npm run build). In dev, Vite serves it on :5173 instead.
  const webDist = path.resolve(here, "../web/dist");
  await app.register(fastifyStatic, {
    root: existsSync(webDist) ? webDist : opts.dataDir,
    serve: existsSync(webDist),
    wildcard: false,
  });
  app.setNotFoundHandler((req, reply: FastifyReply) =>
    req.url.startsWith("/api/") || !existsSync(webDist)
      ? reply.code(404).send({ error: "Not found" })
      : reply.sendFile("index.html", webDist),
  );

  return { app, stores, queue };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { app } = await createApp({
    dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
    logger: true,
    scheduler: true,
  });
  await app.listen({ port: Number(process.env.PORT ?? 4000), host: process.env.HOST ?? "0.0.0.0" });
  // Ctrl-C and docker stop: stop the tests (closing their browsers), then exit. In Docker the app
  // is process 1, which ignores these signals unless it handles them. A second signal exits at once.
  let closing = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (closing) process.exit(1);
      closing = true;
      app.log.info(`${sig}: stopping running tests and closing`);
      const force = setTimeout(() => process.exit(1), 15_000);
      force.unref();
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}
