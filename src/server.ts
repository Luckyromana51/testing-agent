import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
import { openStores, type Settings, type Stores } from "./store.js";
import type { Issue, IssueStatus, ProductType, Project, Run, Schedule, Severity, User } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Only public http(s) URLs. Blocks localhost and private ranges unless ALLOW_PRIVATE_TARGETS=1. */
export function validateTarget(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("That does not look like a website address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https are supported.");
  const host = u.hostname;
  const isPrivate =
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]";
  if (isPrivate && process.env.ALLOW_PRIVATE_TARGETS !== "1") {
    throw new Error("Private and local addresses are blocked. Set ALLOW_PRIVATE_TARGETS=1 to test them.");
  }
  return u.toString();
}

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
  app.addHook("onClose", async () => stopScheduler());

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
    return {
      products: PRODUCTS,
      agents: ALL_AGENTS.map((a) => ({ ...describeAgent(a), enabled: settings.agents[a.id] ?? !a.defaultOff })),
      ai: aiEnabled(),
      aiSummary: settings.aiSummary,
      defaultMaxPages: settings.defaultMaxPages,
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
    };
  };

  app.get("/api/projects", async () => stores.projects.list().map(projectSummary));

  app.post("/api/projects", async (req, reply) => {
    const b = body<{ name: string; type: ProductType; url: string; maxPages: number; schedule: Schedule; checkLinks: boolean }>(req);
    const type = (b.type ?? "website") as ProductType;
    const info = PRODUCTS.find((p) => p.type === type);
    if (!info) throw new HttpError(400, "Unknown product type.");
    if (!info.available) throw new HttpError(400, `${info.name} testing is coming in the next update.`);
    let url: string;
    try {
      url = validateTarget(String(b.url ?? ""));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    const name = (b.name ?? "").trim() || new URL(url).hostname.replace(/^www\./, "");
    const project: Project = {
      id: randomUUID(),
      key: projectKey(name, stores.projects.list().map((p) => p.key)),
      name: name.slice(0, 80),
      type,
      target: {
        url,
        maxPages: Math.min(Math.max(Number(b.maxPages) || stores.settings.get().defaultMaxPages, 1), 200),
        checkLinks: b.checkLinks !== false,
      },
      schedule: SCHEDULES.includes(b.schedule as Schedule) ? (b.schedule as Schedule) : "off",
      createdAt: new Date().toISOString(),
      issueSeq: 0,
    };
    stores.projects.save(project);
    const run = queue.enqueue(project);
    return reply.code(201).send({ project, run });
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
    const b = body<{ name: string; url: string; maxPages: number; schedule: Schedule; checkLinks: boolean }>(req);
    const next: Project = { ...p, target: { ...p.target } };
    if (b.name !== undefined) next.name = String(b.name).trim().slice(0, 80) || p.name;
    if (b.url !== undefined) {
      try {
        next.target.url = validateTarget(String(b.url));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
    }
    if (b.maxPages !== undefined) next.target.maxPages = Math.min(Math.max(Number(b.maxPages) || 1, 1), 200);
    if (b.checkLinks !== undefined) next.target.checkLinks = Boolean(b.checkLinks);
    if (b.schedule !== undefined) {
      if (!SCHEDULES.includes(b.schedule)) throw new HttpError(400, "Schedule must be off, daily or weekly.");
      next.schedule = b.schedule;
    }
    stores.projects.save(next);
    return projectSummary(next);
  });

  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    if (queue.busy(p.id)) throw new HttpError(409, "Wait for the running test to finish before deleting the project.");
    for (const runId of stores.runs.deleteForProject(p.id)) await queue.removeArtifacts(runId);
    stores.issues.deleteForProject(p.id);
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
}
