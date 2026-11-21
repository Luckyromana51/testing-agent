import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readdir, readFile, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { zipSync, type Zippable } from "fflate";
import { ALL_AGENTS, agentsFor, describeAgent } from "./agents/registry.js";
import { aiEnabled, summariseWithClaude, summaryKey } from "./ai/triage.js";
import { Auth, checkPasswordRules, fromOutside, hashPassword, loginTurnedOff, recordFailure, tooManyFailures } from "./auth.js";
import { groupFindings } from "./group.js";
import { cleanInfo, HelperError, helperHub, MAX_ARTIFACT_BYTES, type Helper } from "./helpers.js";
import { ACTIVE, projectKey } from "./issues.js";
import { buildPermission, permissionStatus, writeConsent, verifyPermission, type PermissionInput } from "./permission.js";
import { PRODUCTS } from "./products.js";
import { ScanQueue } from "./queue.js";
import type { LiveInput } from "./live.js";
import { startScheduler } from "./scheduler.js";
import { TOOLS, cleanChoices, defaultChoices, describeTool, toolStatus } from "./tools/index.js";
import { toJunit, toSarif } from "./export.js";
import { openStores, type Settings, type Stores } from "./store.js";
import { buildLogin, buildRole, buildTarget, defaultName, MAX_ROLES, type TargetInput } from "./targets.js";
import { MAX_HOOK_BODY } from "./app/hooks.js";
import { watchJourneys } from "./app/journey-watch.js";
import { authParts } from "./engines/api-auth.js";
import { watchScenarios } from "./engines/api-watch.js";
import { SYSTEM_KINDS, SYSTEMS } from "./app/systems.js";
import type { Issue, IssueStatus, Login, ProductType, Project, ProjectTarget, RoleLogin, Run, Schedule, Severity, User } from "./types.js";
import { MAX_PARALLEL, parallelPages } from "./runner/scan.js";
import { cleanJourney, MAX_JOURNEYS } from "./runner/journeys.js";
import { cleanScenario, MAX_SCENARIOS } from "./agents/api/scenarios.js";
import { mockAddress, registerApiRoutes } from "./api-routes.js";
import { registerMoreRoutes, rumSnippet } from "./more-routes.js";
import { registerMobileRoutes } from "./mobile-routes.js";
import { cleanAppJourneys } from "./mobile/journeys.js";
import { approve as approvePicture, type View } from "./runner/visual.js";
import { loadOwnChecks, moduleOn, moduleReady, MODULES } from "./modules.js";
import { WEB_PRODUCTS } from "./products.js";
import { flakyIssues, trendPoints } from "./trends.js";
import { cleanWatch, watchUrl, Watcher } from "./watch.js";
import { reportHtml, reportPdf } from "./report-html.js";
import { validateTarget } from "./runner/urls.js";

export { validateTarget } from "./runner/urls.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: User;
    /** The Mac helper making the request (helper routes only). */
    helper?: Helper;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Built files Xcode and Finder leave next to the project: never part of the download. */
const HELPER_SKIP = /^(\.DS_Store|DerivedData|xcuserdata|build|.*\.xcresult)$/;

/** Zips helper/mac (the Mac helper and its Xcode project) under a glv-helper/ folder. */
export async function helperZip(dir = path.resolve(here, "../helper/mac"), top = "glv-helper/"): Promise<Uint8Array> {
  if (!existsSync(dir)) throw new HttpError(404, "The helper files are not on this server.");
  const files: Zippable = {};
  const walk = async (from: string, prefix: string) => {
    for (const e of await readdir(from, { withFileTypes: true })) {
      if (HELPER_SKIP.test(e.name)) continue;
      const full = path.join(from, e.name);
      if (e.isDirectory()) await walk(full, `${prefix}${e.name}/`);
      else if (e.isFile()) files[`${prefix}${e.name}`] = await readFile(full);
    }
  };
  await walk(dir, top);
  return zipSync(files, { level: 6 });
}

/** More tests at once than this would starve each one of CPU and memory on a normal server. */
export const MAX_PARALLEL_PROJECTS = 8;

/** How many tests (projects) run at the same time: the owner's setting, else SCAN_CONCURRENCY, else 2. */
export function parallelProjects(asked?: number): number {
  const n = Number(asked ?? process.env.SCAN_CONCURRENCY ?? 2);
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_PARALLEL_PROJECTS, Math.round(n))) : 2;
}

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

let ownChecksLoaded = false;

export async function createApp(opts: AppOptions) {
  const stores = openStores(opts.dataDir);
  migrateLooseRuns(stores);
  const queue = new ScanQueue(stores, opts.dataDir, () => parallelProjects(stores.settings.get().parallelProjects));
  const auth = new Auth(stores.users);
  auth.bootstrapFromEnv();
  const stopScheduler = opts.scheduler ? startScheduler(stores.projects, queue) : () => {};
  helperHub.attach(stores.helpers);
  const watcher = new Watcher(stores.watch, () => stores.projects.list());
  watcher.journeyRunner = (p) => {
    if (!moduleOn(stores.settings.get().modules, "journey-watch") || (p.type !== "api" && !moduleOn(stores.settings.get().modules, "journeys"))) {
      return Promise.resolve({ at: new Date().toISOString(), ok: true, ms: 0, results: [], error: "Journey watch is off in Owner panel > Modules." });
    }
    const login = stores.vault.get(p.id, { quiet: true });
    if (p.type === "api") return watchScenarios(p, login, stores.vault.roles(p.id, { quiet: true }), queue.apiBaselineFile(p.id), queue.uploadsDir());
    return watchJourneys(p, {
      login,
      roles: login?.kind === "web" ? stores.vault.roles(p.id, { quiet: true }) : [],
      mailUrl: moduleOn(stores.settings.get().modules, "mail") ? process.env.MAILPIT_URL : undefined,
      hook: moduleOn(stores.settings.get().modules, "webhooks") ? stores.hooks.inboxFor(p.id) : undefined,
    });
  };
  watcher.headersFor = (p) => {
    const login = p.type === "api" ? stores.vault.get(p.id, { quiet: true }) : undefined;
    return login?.kind === "api" ? authParts(login).headers : {};
  };
  const stopWatcher = opts.scheduler ? watcher.start() : () => {};
  // Own checks are loaded once: switching the module takes effect after a restart.
  if (moduleOn(stores.settings.get().modules, "own-checks") && !ownChecksLoaded) {
    ownChecksLoaded = true;
    await loadOwnChecks(path.join(opts.dataDir, "modules"), (m) => console.log(m));
  }

  const app = Fastify({
    logger: opts.logger ? { level: process.env.LOG_LEVEL ?? "info" } : false,
    trustProxy: process.env.TRUST_PROXY === "1",
    bodyLimit: 1_000_000,
  });
  app.addHook("onClose", async () => {
    stopScheduler();
    stopWatcher();
    helperHub.close();
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
    // The Mac helper signs in with its own token, never a user's session (and works with login off).
    if (req.url.startsWith("/api/helper/")) {
      if (tooManyFailures(req.ip)) return reply.code(429).send({ error: "Too many wrong helper tokens. Try again in 15 minutes." });
      const token = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const helper = token ? stores.helpers.byToken(token) : undefined;
      if (!helper) {
        recordFailure(req.ip);
        return reply.code(401).send({ error: "This helper token is not known here. Pair the Mac again from Owner panel > Mac helpers." });
      }
      req.helper = helper;
      return;
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
      parallelPages: parallelPages(settings.parallelPages),
      maxParallel: MAX_PARALLEL,
      parallelProjects: parallelProjects(settings.parallelProjects),
      maxParallelProjects: MAX_PARALLEL_PROJECTS,
      vault: stores.vault.status(),
      modules: MODULES.map((m) => ({ ...m, on: moduleOn(settings.modules, m.id), ready: moduleReady(m) })),
      // The business systems the signed-in test knows, for the project's "which system is it" choice.
      systems: SYSTEMS.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      systemKinds: SYSTEM_KINDS,
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
      roles: stores.vault.roleSummaries(p.id),
      hookAddress: (() => {
        const t = stores.hooks.token(p.id);
        return t ? stores.hooks.address(t) : null;
      })(),
      permissions: (p.permissions ?? []).map((x) => ({ ...x, status: permissionStatus(x) })),
      mockAddress: p.mockToken ? mockAddress(p.mockToken) : null,
      rumSnippet: p.rumToken ? rumSnippet(p.rumToken) : null,
      repoToken: stores.vault.repoSummary(p.id),
      writes: writeConsent(p.target, p.permissions, "manual"),
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
    const ext = fileName.match(/\.(apk|aab|apks|xapk|ipa|zip|json|ya?ml|jmx|har|txt|sh|curl|proto|csv)$/i)?.[0]?.toLowerCase();
    if (!ext) throw new HttpError(400, "Upload an .apk, .aab, .apks, .xapk, .ipa or .zip file, an API file (OpenAPI .json or .yaml, a Postman collection, a .har file or cURL commands in a .txt), a gRPC .proto file, a Pact contract (.json), a Search Console export (.csv) or a JMeter plan (.jmx).");
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
    if ([".apk", ".aab", ".apks", ".xapk", ".ipa", ".zip"].includes(ext) !== isZip || size === 0) {
      await rm(full, { force: true });
      throw new HttpError(400, size === 0 ? "The file is empty." : `That does not look like a real ${ext} file.`);
    }
    return reply.code(201).send({ file, fileName, size });
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = getProject(req.params.id);
    const runs = stores.runs.list(1000, p.id);
    return {
      project: projectSummary(p),
      runs: runs.map(runSummary),
      trend: runs
        .filter((r) => r.status === "done" && r.result)
        .map((r) => ({ runId: r.id, at: r.createdAt, score: r.result!.overallScore, diff: r.diff }))
        .reverse(),
      agents: agentsFor(p.type, stores.settings.get().agents).map(describeAgent),
      trends: trendPoints(runs),
      flaky: flakyIssues(stores.issues.list(p.id), runs),
      watch: WEB_PRODUCTS.includes(p.type) || p.type === "api" ? { ...stores.watch.summary(p), checkUrl: p.watch?.checkUrl ?? null, expectText: p.watch?.expectText ?? null, journeys: Boolean(p.watch?.journeys), journeysEveryMin: p.watch?.journeysEveryMin ?? 15, lastJourneys: watcher.journeyRuns.get(p.id) ?? null } : null,
    };
  });

  // Uptime and SSL watch: check now, and the alerts and outages across projects.
  app.post<{ Params: { id: string } }>("/api/projects/:id/watch/check", async (req) => {
    const p = getProject(req.params.id);
    if (!watchUrl(p)) throw new HttpError(400, p.type === "api" ? "Choose the endpoint to watch first." : "This project has no address to watch.");
    await watcher.checkProject(p);
    return stores.watch.summary(p);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/watch/journeys", async (req) => {
    const p = getProject(req.params.id);
    if (p.type === "api" ? !p.apiScenarios?.some((x) => !x.off) : !p.journeys?.some((j) => !j.off && !j.allowWrites)) {
      throw new HttpError(400, p.type === "api" ? "This project has no scenarios to watch." : "This project has no read-only journeys to watch.");
    }
    return (await watcher.checkJourneys(p)) ?? null;
  });
  app.get("/api/watch", async () => {
    const projects = new Map(stores.projects.list().map((p) => [p.id, p]));
    return {
      down: [...projects.values()].filter((p) => p.watch?.on && stores.watch.openIncident(p.id)).map((p) => ({ id: p.id, name: p.name, url: p.target.url, since: stores.watch.openIncident(p.id)!.startedAt })),
      alerts: watcher.alerts.slice(0, 30),
      incidents: stores.watch.incidents(undefined, 30).map((i) => ({ ...i, projectName: projects.get(i.projectId)?.name ?? "Deleted project" })),
    };
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const p = getProject(req.params.id);
    const b = body<TargetInput & { name: string; schedule: Schedule; login: Partial<Login> | null; tools: unknown; journeys: unknown; watch: unknown; apiScenarios: unknown; mock: unknown; appJourneys: unknown }>(req);
    const next: Project = { ...p, target: { ...p.target } };
    if (b.name !== undefined) next.name = String(b.name).trim().slice(0, 80) || p.name;
    const { name: _n, schedule: _s, login: loginInput, tools: toolsInput, journeys: journeysInput, watch: watchInput, apiScenarios: scenariosInput, mock: mockInput, appJourneys: appJourneysInput, ...targetInput } = b;
    let login: Login | undefined;
    try {
      if (scenariosInput !== undefined) {
        if (p.type !== "api") throw new Error("API scenarios are for API projects.");
        if (!Array.isArray(scenariosInput)) throw new Error("Scenarios must be a list.");
        if (scenariosInput.length > MAX_SCENARIOS) throw new Error(`A project can have up to ${MAX_SCENARIOS} scenarios.`);
        next.apiScenarios = scenariosInput.map((x, i) => cleanScenario(x as Record<string, unknown>, i));
        if (!next.apiScenarios.length) delete next.apiScenarios;
      }
      if (mockInput !== undefined) {
        if (p.type !== "api") throw new Error("The mock server is for API projects.");
        if (mockInput === "new" || (mockInput === true && !p.mockToken)) next.mockToken = randomBytes(16).toString("hex");
        else if (mockInput === false || mockInput === null) delete next.mockToken;
      }
      if (watchInput !== undefined) {
        if (!WEB_PRODUCTS.includes(p.type) && p.type !== "api") throw new Error("Uptime watch is for websites, web apps and APIs.");
        const w = cleanWatch(watchInput as Record<string, unknown> | null);
        if (w) next.watch = w;
        else delete next.watch;
      }
      if (appJourneysInput !== undefined) {
        if (p.type !== "android" && p.type !== "ios") throw new Error("App journeys are for Android and iOS apps.");
        next.appJourneys = cleanAppJourneys(appJourneysInput);
        if (!next.appJourneys.length) delete next.appJourneys;
      }
      if (journeysInput !== undefined) {
        if (!WEB_PRODUCTS.includes(p.type)) throw new Error("User journeys are for websites and web apps.");
        if (!Array.isArray(journeysInput)) throw new Error("Journeys must be a list.");
        if (journeysInput.length > MAX_JOURNEYS) throw new Error(`A project can have up to ${MAX_JOURNEYS} journeys.`);
        next.journeys = journeysInput.map((j, i) => cleanJourney(j as Record<string, unknown>, i));
        if (!next.journeys.length) delete next.journeys;
      }
      if (toolsInput === null) delete next.tools;
      else if (toolsInput !== undefined) next.tools = cleanChoices(p.type, toolsInput, p.permissions ?? []);
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

  // ---- The client's permission for load and attack tests ------------------------------------
  // Only the owner records or withdraws one. Anyone can check its proof again.
  app.post<{ Params: { id: string } }>("/api/projects/:id/permissions", async (req, reply) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    let permission;
    try {
      permission = buildPermission(body<PermissionInput>(req), req.user?.name || req.user?.email || "Owner");
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    // The proof may already be in place (a renewal): look for it straight away.
    const checked = await verifyPermission(permission);
    const next = { ...(stores.projects.get(p.id) ?? p) };
    next.permissions = [...(next.permissions ?? []), checked.permission];
    stores.projects.save(next);
    return reply.code(201).send({ project: projectSummary(next), permissionId: permission.id, checks: checked.checks });
  });

  app.post<{ Params: { id: string; pid: string } }>("/api/projects/:id/permissions/:pid/check", async (req) => {
    const p = getProject(req.params.id);
    const found = (p.permissions ?? []).find((x) => x.id === req.params.pid);
    if (!found) throw new HttpError(404, "Permission not found");
    if (found.revokedAt) throw new HttpError(400, "This permission was withdrawn.");
    const checked = await verifyPermission(found);
    const latest = stores.projects.get(p.id) ?? p;
    const next = { ...latest, permissions: (latest.permissions ?? []).map((x) => (x.id === found.id ? { ...x, proofs: checked.permission.proofs } : x)) };
    stores.projects.save(next);
    return { project: projectSummary(next), checks: checked.checks };
  });

  app.post<{ Params: { id: string; pid: string } }>("/api/projects/:id/permissions/:pid/revoke", async (req) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    const found = (p.permissions ?? []).find((x) => x.id === req.params.pid);
    if (!found) throw new HttpError(404, "Permission not found");
    if (found.revokedAt) return projectSummary(p);
    const permissions = (p.permissions ?? []).map((x) =>
      x.id === found.id ? { ...x, revokedAt: new Date().toISOString(), revokedBy: req.user?.name || req.user?.email || "Owner" } : x,
    );
    // Tools that no other permission covers are turned off, so the next tests do not try them.
    let tools = p.tools;
    if (tools) {
      tools = tools.filter((c) => {
        try {
          cleanChoices(p.type, [c], permissions);
          return true;
        } catch {
          return false;
        }
      });
    }
    const next = { ...p, permissions, ...(tools ? { tools } : {}) };
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
    stores.vault.deleteRole(p.id);
    stores.vault.deleteRepoToken(p.id);
    stores.rum.deleteForProject(p.id);
    stores.hooks.close(p.id);
    if (p.target.file) await rm(path.join(queue.uploadsDir(), path.basename(p.target.file)), { force: true });
    await rm(queue.baselineDir(p.id), { recursive: true, force: true });
    stores.watch.deleteProject(p.id);
    stores.projects.delete(p.id);
    return reply.code(204).send();
  });

  // ---- Signed-in apps: other accounts (roles), the webhook inbox, the step recorder ------------
  app.get<{ Params: { id: string } }>("/api/projects/:id/roles", async (req) => stores.vault.roleSummaries(getProject(req.params.id).id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/roles", async (req, reply) => {
    const p = getProject(req.params.id);
    const b = body<Partial<RoleLogin> & { login?: Partial<Login> }>(req);
    const existing = stores.vault.roleSummaries(p.id);
    const prev = b.id ? existing.find((r) => r.id === b.id) : undefined;
    if (!prev && existing.length >= MAX_ROLES) throw new HttpError(400, `A project can have up to ${MAX_ROLES} other accounts.`);
    let role: RoleLogin;
    try {
      role = buildRole(p.type, b, stores.vault.summary(p.id), prev);
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    stores.vault.saveRole(p.id, role);
    return reply.code(prev ? 200 : 201).send(stores.vault.roleSummaries(p.id).find((r) => r.id === role.id));
  });
  app.delete<{ Params: { id: string; rid: string } }>("/api/projects/:id/roles/:rid", async (req, reply) => {
    const p = getProject(req.params.id);
    stores.vault.deleteRole(p.id, req.params.rid);
    // Journeys that ran as this role go back to the main account.
    if (p.journeys?.some((j) => j.role === req.params.rid)) {
      stores.projects.save({ ...p, journeys: p.journeys.map((j) => (j.role === req.params.rid ? { ...j, role: undefined } : j)) });
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/hooks", async (req) => {
    const p = getProject(req.params.id);
    const token = stores.hooks.token(p.id);
    return { address: token ? stores.hooks.address(token) : null, messages: token ? stores.hooks.list(p.id, 50) : [] };
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/hooks", async (req) => {
    const p = getProject(req.params.id);
    const b = body<{ fresh?: boolean; clear?: boolean }>(req);
    if (b.clear) stores.hooks.clear(p.id);
    const token = stores.hooks.open(p.id, Boolean(b.fresh));
    return { address: stores.hooks.address(token), messages: stores.hooks.list(p.id, 50) };
  });
  app.delete<{ Params: { id: string } }>("/api/projects/:id/hooks", async (req, reply) => {
    stores.hooks.close(getProject(req.params.id).id);
    return reply.code(204).send();
  });

  // The step recorder: a Chrome extension (ours, loaded unpacked) that turns clicks into journey steps.
  app.get("/api/recorder/download", async (_req, reply) => {
    const zip = await helperZip(path.resolve(here, "../helper/chrome-recorder"), "glv-recorder/");
    reply
      .header("content-type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="glv-recorder.zip"')
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(zip);
  });

  registerApiRoutes(app, { stores, queue, getProject, fail: (status, message) => new HttpError(status, message) });
  registerMobileRoutes(app, { stores, ownerOnly, fail: (status, message) => new HttpError(status, message) });
  await registerMoreRoutes(app, { stores, queue, getProject, projectSummary, fail: (status, message) => new HttpError(status, message), userName: (req) => req.user?.name || req.user?.email || "Owner" });

  // The webhook inbox itself: open to the client's app (no login), only with the project's secret address.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: MAX_HOOK_BODY }, (_req, b, done) => done(null, b));
    scope.route<{ Params: { token: string } }>({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      url: "/hooks/:token",
      handler: async (req, reply) => {
        const projectId = stores.hooks.projectFor(req.params.token);
        if (!projectId || !moduleOn(stores.settings.get().modules, "webhooks")) return reply.code(404).send({ error: "No such inbox." });
        const raw = typeof req.body === "string" ? req.body : req.body === undefined ? "" : JSON.stringify(req.body);
        stores.hooks.add(projectId, { method: req.method, path: req.url, headers: req.headers, body: raw });
        return reply.code(200).send({ ok: true });
      },
    });
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

  /**
   * The live view of a running test, as server-sent events: "screens" (how many), "screen" (what
   * one screen shows and which agents are checking it), "frame" (a JPEG picture), "log" and "end".
   * Pictures are only made while someone is connected here.
   */
  app.get<{ Params: { id: string }; Querystring: { code?: string } }>("/api/runs/:id/live", async (req, reply) => {
    const run = stores.runs.get(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx would otherwise hold the stream back.
      "x-accel-buffering": "no",
    });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const live = queue.live.get(run.id);
    if (!live) {
      write("end", { status: queue.live.endedAs(run.id) ?? run.status });
      res.end();
      return;
    }
    // A viewer on a slow connection skips pictures instead of falling further and further behind.
    const send = (event: string, data: unknown) => {
      if (event === "frame" && res.writableLength > 1_000_000) return;
      write(event, data);
    };
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    // With ?code=1 the viewer has the code panel open and also gets "code" events.
    const off = live.subscribe(send, () => res.end(), { code: req.query.code === "1" });
    req.raw.on("close", () => {
      clearInterval(ping);
      off();
    });
  });

  /** The HTML one live screen shows right now (after its scripts ran), for the code panel. Read only when asked. */
  app.get<{ Params: { id: string; slot: string } }>("/api/runs/:id/live/source/:slot", async (req, reply) => {
    const live = queue.live.get(req.params.id);
    if (!live) return reply.code(404).send({ error: "This test is not running any more." });
    const html = await live.source(Number(req.params.slot));
    if (html === undefined) return reply.code(404).send({ error: "This screen has no page open right now." });
    return reply.type("text/plain; charset=utf-8").header("cache-control", "no-store").send(html);
  });

  /**
   * A click or key from the live view, on a screen the test handed over (to finish a sign-in by
   * hand: a CAPTCHA, a two-step code). Ignored on any other screen.
   */
  app.post<{ Params: { id: string; slot: string } }>("/api/runs/:id/live/input/:slot", async (req, reply) => {
    const live = queue.live.get(req.params.id);
    if (!live) return reply.code(404).send({ error: "This test is not running any more." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const frac = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 1 ? v : undefined);
    let input: LiveInput | undefined;
    if (b.type === "click" && frac(b.x) !== undefined && frac(b.y) !== undefined) input = { type: "click", x: b.x as number, y: b.y as number };
    else if (b.type === "type" && typeof b.text === "string" && b.text.length <= 500) input = { type: "type", text: b.text };
    else if (b.type === "key" && typeof b.key === "string" && /^(Enter|Tab|Backspace|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Space)$/.test(b.key)) input = { type: "key", key: b.key };
    else if (b.type === "scroll" && typeof b.dy === "number" && Math.abs(b.dy) <= 3000) input = { type: "scroll", dy: b.dy };
    else if (b.type === "done") input = { type: "done" };
    if (!input) return reply.code(400).send({ error: "Unknown input." });
    if (!(await live.input(Number(req.params.slot), input))) return reply.code(409).send({ error: "This screen is not waiting for you." });
    return { ok: true };
  });

  /** The tests running now and waiting, with their project names, and the limit. */
  const queueOverview = () => {
    const o = queue.overview();
    const name = (id?: string) => (id ? stores.projects.get(id)?.name : undefined);
    return {
      limit: o.limit,
      maxLimit: MAX_PARALLEL_PROJECTS,
      running: o.running.map((r) => ({ ...r, name: name(r.projectId) ?? r.url })),
      waiting: o.waiting.map((r) => ({ ...r, name: name(r.projectId) ?? r.url })),
    };
  };
  app.get("/api/queue", async () => queueOverview());

  /**
   * Every running test's live view on one stream (the Live page): the same events as one test's
   * stream, each with its runId, plus "runs" whenever a test starts or ends. One connection for all
   * tests, because a browser allows only six open streams to a server.
   */
  app.get("/api/live", async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const subs = new Map<string, () => void>();
    const sync = () => {
      for (const id of queue.live.ids()) {
        const live = queue.live.get(id);
        if (!live || subs.has(id)) continue;
        const send = (event: string, data: unknown) => {
          // With many tests on one stream, a slow connection skips pictures first.
          if (event === "frame" && res.writableLength > 2_000_000) return;
          write(event, { runId: id, ...(data as object) });
        };
        subs.set(id, live.subscribe(send, () => subs.delete(id)));
      }
      write("runs", queueOverview());
    };
    sync();
    const offChange = queue.live.onChange(() => setTimeout(sync, 0));
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.raw.on("close", () => {
      clearInterval(ping);
      offChange();
      for (const off of subs.values()) off();
    });
  });

  // The run's findings for CI and security dashboards: SARIF (GitHub code scanning and others) and JUnit XML.
  const exportOf = (id: string) => {
    const run = stores.runs.get(id);
    if (!run) throw new HttpError(404, "Run not found");
    if (!run.result) throw new HttpError(409, "This test has no result yet.");
    const project = (stores.projects.get(run.projectId ?? "")?.name ?? "report").replace(/[^\w-]+/g, "-").slice(0, 60);
    return { result: run.result, name: `glv-${project}-${run.id.slice(0, 8)}` };
  };
  // The client report: a printable page, and the same page as a PDF printed by our own Chromium.
  const clientReport = (id: string) => {
    const run = stores.runs.get(id);
    if (!run) throw new HttpError(404, "Run not found");
    if (!run.result) throw new HttpError(409, "This test has no result yet.");
    return { html: reportHtml(run, stores.projects.get(run.projectId ?? "")?.name ?? run.url), name: exportOf(id).name };
  };
  app.get<{ Params: { id: string } }>("/api/runs/:id/report.html", async (req, reply) => {
    const { html } = clientReport(req.params.id);
    // Only our inline styles: no scripts, nothing fetched.
    reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:").header("X-Content-Type-Options", "nosniff");
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/report.pdf", async (req, reply) => {
    const { html, name } = clientReport(req.params.id);
    const pdf = await reportPdf(html);
    reply.header("Content-Disposition", `attachment; filename="${name}.pdf"`).header("X-Content-Type-Options", "nosniff");
    return reply.type("application/pdf").send(pdf);
  });

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

  /**
   * Writes the Claude summary for a finished test that has none (for example one that ran before
   * the key was set). One call per test: a test that already has a summary keeps it.
   */
  const summarising = new Set<string>();
  app.post<{ Params: { id: string } }>("/api/runs/:id/summary", async (req) => {
    const run = stores.runs.get(req.params.id);
    if (!run) throw new HttpError(404, "Run not found");
    if (!run.result) throw new HttpError(409, "This test has no result to summarise.");
    if (run.ai) return run;
    // Another test of the project with exactly the same issues already has a summary: use it, for no credits.
    const key = summaryKey(run.result);
    const same = run.projectId ? stores.runs.list(50, run.projectId).find((r) => r.id !== run.id && r.ai?.key === key) : undefined;
    if (same?.ai) {
      const from = same.ai.reusedFrom ?? { runId: same.id, at: same.finishedAt ?? same.createdAt };
      const saved = { ...run, ai: { ...same.ai, tokens: undefined, reusedFrom: from }, aiError: undefined };
      stores.runs.save(saved);
      return saved;
    }
    if (!aiEnabled()) throw new HttpError(409, "Claude summary is off: set ANTHROPIC_API_KEY in .env and restart.");
    if (!stores.settings.get().aiSummary) throw new HttpError(409, "Claude summary is turned off in the owner panel.");
    if (summarising.has(run.id)) throw new HttpError(409, "The summary is already being written.");
    summarising.add(run.id);
    try {
      const ai = await summariseWithClaude(run.result);
      const latest = stores.runs.get(run.id) ?? run;
      const saved = { ...latest, ai, aiError: undefined };
      stores.runs.save(saved);
      return saved;
    } catch (err) {
      throw new HttpError(502, `Claude could not write the summary: ${(err as Error).message.split("\n")[0]}`);
    } finally {
      summarising.delete(run.id);
    }
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

  // Visual compare: make this run's picture of a page the approved one.
  app.post<{ Params: { id: string; index: string } }>("/api/runs/:id/pages/:index/approve", async (req) => {
    const run = stores.runs.get(req.params.id);
    if (!run?.result || !run.projectId) throw new HttpError(404, "Run not found.");
    const page = run.result.pages[Number(req.params.index)];
    const { view } = body<{ view: View }>(req);
    if (!page || (view !== "desktop" && view !== "phone")) throw new HttpError(400, "Pick a page and desktop or phone.");
    const shot = view === "desktop" ? page.screenshot : page.mobileScreenshot;
    if (!shot) throw new HttpError(409, "This page has no picture to approve.");
    await approvePicture(queue.baselineDir(run.projectId), queue.artifactsDir(run.id), shot, page.url, view, run.id, page.moving?.[view]);
    page.visual = { ...page.visual, [view]: { ...page.visual?.[view], status: "approved", approvedAt: new Date().toISOString() } };
    stores.runs.save(run);
    return { ok: true, visual: page.visual };
  });

  app.get<{ Params: { id: string; file: string } }>("/api/runs/:id/artifacts/:file", async (req, reply) => {
    const { id, file } = req.params;
    if (!/^[\w-]+$/.test(id) || !/^[\w.-]+\.(jpg|png)$/.test(file)) {
      // Reports written by the outside tools (Lighthouse, ZAP...).
      if (/^[\w-]+$/.test(id) && /^tool-[\w.-]+\.(html|json|xml|txt)$/.test(file)) {
        // A tool's HTML report runs in a sandbox: it cannot read the dashboard's login or data.
        reply.header("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-downloads");
        reply.header("X-Content-Type-Options", "nosniff");
        if (file.endsWith(".json")) reply.header("Content-Disposition", `inline; filename="${file}"`);
        // A transcript from the Mac helper (what VoiceOver said).
        if (file.endsWith(".txt")) reply.type("text/plain; charset=utf-8");
        // JUnit XML is downloaded, never shown as a page.
        if (file.endsWith(".xml")) {
          reply.header("Content-Disposition", `attachment; filename="${file}"`);
          reply.type("application/xml");
        }
        return reply.sendFile(file, queue.artifactsDir(id));
      }
      // A page's network log as HAR, for Chrome's or any HAR viewer: downloaded, never shown.
      if (/^[\w-]+$/.test(id) && /^page-\d+-network\.har$/.test(file)) {
        reply.header("Content-Disposition", `attachment; filename="${file}"`);
        reply.header("X-Content-Type-Options", "nosniff");
        reply.type("application/json");
        return reply.sendFile(file, queue.artifactsDir(id));
      }
      // What agents saved about a page: the screen reader's view (text) and the network log (JSON).
      if (/^[\w-]+$/.test(id) && /^page-\d+-[a-z-]+\.(txt|json)$/.test(file)) {
        reply.header("Content-Security-Policy", "sandbox");
        reply.header("X-Content-Type-Options", "nosniff");
        if (file.endsWith(".txt")) reply.type("text/plain; charset=utf-8");
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
    const settings = stores.settings.get();
    return { ...settings, parallelPages: parallelPages(settings.parallelPages), maxParallel: MAX_PARALLEL, parallelProjects: parallelProjects(settings.parallelProjects) };
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
    if (b.parallelPages !== undefined) patch.parallelPages = parallelPages(Number(b.parallelPages) || 1);
    if (b.parallelProjects !== undefined) patch.parallelProjects = parallelProjects(Number(b.parallelProjects) || 1);
    if (b.modules && typeof b.modules === "object") {
      patch.modules = { ...stores.settings.get().modules };
      for (const [id, on] of Object.entries(b.modules)) if (MODULES.some((m) => m.id === id)) patch.modules[id] = Boolean(on);
    }
    const saved = stores.settings.update(patch);
    // A higher limit starts waiting tests now.
    if (patch.parallelProjects !== undefined) queue.kick();
    return { ...saved, parallelPages: parallelPages(saved.parallelPages), maxParallel: MAX_PARALLEL, parallelProjects: parallelProjects(saved.parallelProjects) };
  });

  // ---- Mac helpers ------------------------------------------------------------------------------
  const helperOf = (req: FastifyRequest) => {
    if (!req.helper) throw new HttpError(401, "Helper token missing.");
    return req.helper;
  };
  const jobAnswer = (reply: FastifyReply, r: "ok" | "over" | "unknown") =>
    r === "ok" ? { ok: true } : reply.code(r === "over" ? 409 : 404).send(r === "over" ? { cancelled: true, error: "The test is over or was cancelled." } : { error: "Unknown job." });

  app.post("/api/helper/hello", async (req) => {
    const h = helperHub.hello(helperOf(req), cleanInfo(req.body));
    return { name: h.name, wait: 25 };
  });
  app.post("/api/helper/ping", async (req) => {
    helperHub.touch(helperOf(req));
    return { ok: true };
  });
  app.get<{ Querystring: { wait?: string } }>("/api/helper/jobs/next", async (req, reply) => {
    const h = helperOf(req);
    const wait = Math.min(30, Math.max(0, Number(req.query.wait ?? 25) || 0)) * 1000;
    const gone = new AbortController();
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) gone.abort();
    });
    const job = await helperHub.next(h, wait, gone.signal);
    if (!job) return reply.code(204).send();
    if (gone.signal.aborted || reply.raw.destroyed) {
      helperHub.requeue(job.id);
      return reply.code(204).send();
    }
    return { job };
  });
  app.get<{ Params: { id: string } }>("/api/helper/jobs/:id/file", async (req, reply) => {
    const f = helperHub.fileOf(helperOf(req), req.params.id);
    if (!f || !existsSync(f.path)) throw new HttpError(404, "No file for this job.");
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${f.name.replace(/[^\w. ()-]/g, "_")}"`);
    return reply.send(createReadStream(f.path));
  });
  app.post<{ Params: { id: string } }>("/api/helper/jobs/:id/progress", async (req, reply) => {
    return jobAnswer(reply, helperHub.progress(helperOf(req), req.params.id, String(body<{ message: string }>(req).message ?? "")));
  });
  app.post<{ Params: { id: string; name: string } }>("/api/helper/jobs/:id/artifacts/:name", { bodyLimit: MAX_ARTIFACT_BYTES + 1 }, async (req, reply) => {
    const h = helperOf(req);
    if (!(req.body instanceof Readable)) throw new HttpError(400, "Send the file as application/octet-stream.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_ARTIFACT_BYTES) throw new HttpError(413, "The file is too big.");
      chunks.push(chunk);
    }
    try {
      const file = await helperHub.artifact(h, req.params.id, req.params.name, Buffer.concat(chunks));
      return reply.code(201).send({ file });
    } catch (err) {
      if (err instanceof HelperError) throw new HttpError(/over/.test(err.message) ? 409 : 400, err.message);
      throw err;
    }
  });
  app.post<{ Params: { id: string } }>("/api/helper/jobs/:id/result", { bodyLimit: 3_000_000 }, async (req, reply) => {
    return jobAnswer(reply, helperHub.result(helperOf(req), req.params.id, body<{ ok: boolean; data: unknown; error: unknown }>(req)));
  });

  const helperView = (h: Helper) => ({
    id: h.id,
    name: h.name,
    createdAt: h.createdAt,
    createdBy: h.createdBy,
    lastSeen: helperHub.lastSeen(h) ? new Date(helperHub.lastSeen(h)).toISOString() : null,
    online: helperHub.isOnline(h),
    info: h.info ?? null,
    busy: helperHub.busy(h) ?? null,
  });
  app.get("/api/owner/helpers", async (req) => {
    ownerOnly(req);
    return { helpers: stores.helpers.list().map(helperView), queued: helperHub.queued() };
  });
  app.post("/api/owner/helpers", async (req, reply) => {
    ownerOnly(req);
    const name = String(body<{ name: string }>(req).name ?? "").trim().replace(/[\u0000-\u001f]/g, "").slice(0, 60);
    if (!name) throw new HttpError(400, "Give the Mac a name, such as \"Lucky's MacBook\".");
    const { helper, token } = stores.helpers.create(name, req.user!.name || req.user!.email);
    return reply.code(201).send({ helper: helperView(helper), token });
  });
  app.delete<{ Params: { id: string } }>("/api/owner/helpers/:id", async (req, reply) => {
    ownerOnly(req);
    if (!stores.helpers.get(req.params.id)) throw new HttpError(404, "Helper not found");
    helperHub.remove(req.params.id);
    return reply.code(204).send();
  });
  // The Mac helper program and its Xcode audit project, as one zip to unpack on the Mac.
  app.get("/api/owner/helpers/download", async (req, reply) => {
    ownerOnly(req);
    const zip = await helperZip();
    reply
      .header("content-type", "application/zip")
      .header("Content-Disposition", 'attachment; filename="glv-helper.zip"')
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(zip);
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
