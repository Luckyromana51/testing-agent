import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { agentsFor } from "./agents/registry.js";
import { aiEnabled, reusableSummary, summariseWithClaude, summaryKey } from "./ai/triage.js";
import { syncIssues } from "./issues.js";
import { runEngine } from "./engines/index.js";
import { LiveHub, liveFeed } from "./live.js";
import { defaultChoices, runTools, toolById } from "./tools/index.js";
import { secretsOf } from "./vault.js";
import { writeConsent } from "./permission.js";
import type { Stores } from "./store.js";
import { moduleOn } from "./modules.js";
import type { Project, Run } from "./types.js";
import { controlAgents, controlScope, describeControl, extraOn, mergeControl, RunGate, verdictOf, type LiveAction, type RunControl } from "./control.js";

/**
 * In-process job queue with a concurrency limit.
 * Good for one server; replace with BullMQ + Redis when runners move to separate machines.
 */
/** A short, readable error: the first line, without the browser's full log that Playwright appends. */
export function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const first = text.split("\n")[0].replace(/\s*=+\s*logs\s*=+.*$/i, "").trim();
  return first.length > 500 ? `${first.slice(0, 500)}…` : first || "Unknown error";
}

class Cancelled extends Error {}

export class ScanQueue {
  private waiting: Run[] = [];
  /** Running run id -> project id. */
  private active = new Map<string, string | undefined>();
  /** Running run id -> how to stop it, and the promise that settles once it has stopped. */
  private running = new Map<string, { stop: AbortController; done: Promise<void> }>();
  /** Master control's live switches of each running test. */
  private gates = new Map<string, RunGate>();
  private stopping = false;
  /** What running tests show live in the dashboard. */
  readonly live = new LiveHub();

  constructor(
    private stores: Stores,
    private dataDir: string,
    /** How many tests run at the same time; read on every start, so a new setting applies at once. */
    private limit: number | (() => number) = 2,
  ) {}

  private get concurrency(): number {
    return typeof this.limit === "function" ? this.limit() : this.limit;
  }

  /** Starts waiting tests when the owner raises the limit. */
  kick(): void {
    this.pump();
  }

  /** The tests running now and the ones waiting, for the dashboard. */
  overview(): { running: { runId: string; projectId?: string; url: string; startedAt?: string }[]; waiting: { runId: string; projectId?: string; url: string }[]; limit: number } {
    const runs = [...this.active.keys()].map((id) => this.stores.runs.get(id)).filter((r): r is Run => Boolean(r));
    return {
      running: runs.map((r) => ({ runId: r.id, projectId: r.projectId, url: r.url, startedAt: r.startedAt })),
      waiting: this.waiting.map((r) => ({ runId: r.id, projectId: r.projectId, url: r.url })),
      limit: this.concurrency,
    };
  }

  artifactsDir(runId: string): string {
    return path.join(this.dataDir, "artifacts", runId);
  }

  /** The project's approved pictures, for visual compare. */
  baselineDir(projectId: string): string {
    return path.join(this.dataDir, "baselines", projectId.replace(/[^\w-]/g, ""));
  }

  /** The approved copy of an API project's file, for breaking changes and the mock server. */
  apiBaselineFile(projectId: string): string {
    return path.join(this.baselineDir(projectId), "api-spec.json");
  }

  /** Makes a test's copy of the API file the approved one. */
  async approveApiFile(projectId: string, runId: string): Promise<void> {
    await mkdir(this.baselineDir(projectId), { recursive: true });
    await copyFile(path.join(this.artifactsDir(runId), "api-spec.json"), this.apiBaselineFile(projectId));
  }

  uploadsDir(): string {
    return path.join(this.dataDir, "uploads");
  }

  async removeArtifacts(runId: string): Promise<void> {
    await rm(this.artifactsDir(runId), { recursive: true, force: true });
  }

  status(): { active: number; waiting: number; concurrency: number } {
    return { active: this.active.size, waiting: this.waiting.length, concurrency: this.concurrency };
  }

  /** True while the project has a run queued or running. */
  busy(projectId: string): boolean {
    return this.waiting.some((r) => r.projectId === projectId) || [...this.active.values()].includes(projectId);
  }

  /** True when the project's test is waiting for a free slot, not yet running. */
  waitingFor(projectId: string): boolean {
    return this.waiting.some((r) => r.projectId === projectId) && ![...this.active.values()].includes(projectId);
  }

  /**
   * Stops a run: a queued one never starts, a running one closes its browser or clone and ends as
   * cancelled. Its issues are left as they were. Returns false when the run is not queued or running.
   */
  async cancel(runId: string, why = "Cancelled"): Promise<boolean> {
    const i = this.waiting.findIndex((r) => r.id === runId);
    if (i >= 0) {
      const [run] = this.waiting.splice(i, 1);
      this.stores.runs.save({
        ...run,
        status: "cancelled",
        error: `${why} before it started.`,
        finishedAt: new Date().toISOString(),
        progress: [...run.progress, why],
      });
      return true;
    }
    const job = this.running.get(runId);
    if (!job) return false;
    job.stop.abort(new Cancelled(why));
    this.gates.get(runId)?.resume();
    await job.done;
    return true;
  }

  /** Cancels every queued and running test of a project (before it is deleted). */
  async cancelProject(projectId: string, why = "Cancelled"): Promise<void> {
    const ids = [...this.waiting.filter((r) => r.projectId === projectId).map((r) => r.id)];
    for (const [id, pid] of this.active) if (pid === projectId) ids.push(id);
    for (const id of ids) await this.cancel(id, why);
  }

  /** Stops everything for a server shutdown: queued tests are cancelled, running ones are stopped. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const ids = [...this.waiting.map((r) => r.id), ...this.running.keys()];
    await Promise.all(ids.map((id) => this.cancel(id, "The server was stopped")));
  }

  /**
   * Master control while a test runs: pause, resume, skip the open pages (or one screen's), or
   * finish now (stop opening pages, then score what was tested). Returns false when it is not running.
   */
  control(runId: string, action: LiveAction, opts: { slot?: number; by?: string } = {}): boolean {
    const gate = this.gates.get(runId);
    if (!gate) return false;
    const who = opts.by ? ` by ${opts.by}` : "";
    const live = this.live.get(runId);
    if (action === "pause") gate.pause(opts.by);
    else if (action === "resume") gate.resume();
    let skipped = true;
    if (action === "skip") skipped = gate.skip(opts.slot);
    else if (action === "finish") gate.finish(`Finished early${who} from master control`);
    const msg = {
      pause: `Paused${who}: open pages finish their current step, then wait`,
      resume: `Resumed${who}`,
      skip: skipped
        ? `Skipping ${opts.slot === undefined ? "the open pages" : `the page on screen ${opts.slot + 1}`}${who}`
        : `Nothing to skip${who}: no page is open now. The test is signing in or running its site-wide checks (sign-in, access and tool checks), which end on their own. The picture on the screen is the last page tested.`,
      finish: `Finishing now${who}: no new pages, then the site checks and the score`,
    }[action];
    live?.log(msg);
    const run = this.stores.runs.get(runId);
    if (run) this.stores.runs.save({ ...run, progress: [...run.progress, msg].slice(-200), gateState: gate.state() });
    return true;
  }

  /** Queues a test run of a project with the agents the owner has turned on, and master control's settings. */
  enqueue(project: Project, trigger: Run["trigger"] = "manual", tester?: { control?: RunControl; by?: string; preset?: string }): Run {
    const settings = this.stores.settings.get();
    // The project's defaults, then this test's own choices.
    const control = mergeControl(project.control, tester?.control);
    const used = Object.keys(control).length ? control : undefined;
    const run: Run = {
      id: randomUUID(),
      url: project.target.url ?? project.target.specUrl ?? project.target.repoUrl ?? project.target.fileName ?? "",
      projectId: project.id,
      product: project.type,
      trigger,
      agents: used
        ? controlAgents(project.type, settings.agents, { ...control, checkLinks: control.checkLinks ?? project.target.checkLinks })
        : agentsFor(project.type, settings.agents)
            .filter((a) => project.target.checkLinks !== false || a.id !== "web.links")
            .map((a) => a.id),
      ...(used ? { control: used } : {}),
      ...(tester?.by || tester?.preset ? { controlBy: { name: tester.by, preset: tester.preset } } : {}),
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: ["Queued"],
    };
    this.stores.runs.save(run);
    this.waiting.push(run);
    this.pump();
    return run;
  }

  private pump(): void {
    while (!this.stopping && this.active.size < this.concurrency && this.waiting.length) {
      const run = this.waiting.shift()!;
      this.active.set(run.id, run.projectId);
      const stop = new AbortController();
      const done = this.execute(run, stop.signal).finally(() => {
        this.live.close(run.id, run.status);
        this.active.delete(run.id);
        this.running.delete(run.id);
        this.pump();
      });
      this.running.set(run.id, { stop, done });
    }
  }

  private async execute(run: Run, signal: AbortSignal): Promise<void> {
    const { runs, projects, issues, settings } = this.stores;
    const update = (patch: Partial<Run>) => {
      Object.assign(run, patch);
      runs.save(run);
    };
    const live = this.live.open(run.id);
    const log = (msg: string) => {
      run.progress = [...run.progress, msg].slice(-200);
      runs.save(run);
      live.log(msg);
    };

    update({ status: "running", startedAt: new Date().toISOString() });
    const project = run.projectId ? projects.get(run.projectId) : undefined;
    const control: RunControl = run.control ?? {};
    const gate = new RunGate({ maxMinutes: control.maxMinutes, onChange: (s) => update({ gateState: s }) });
    this.gates.set(run.id, gate);
    if (run.control) for (const line of describeControl(run.control)) log(`Master control: ${line}`);
    const mods = settings.get().modules;
    const on = (module: Parameters<typeof moduleOn>[1], extra: Parameters<typeof extraOn>[1]) => extraOn(control, extra, moduleOn(mods, module));
    try {
      if (!project) throw new Error("The project for this run was deleted.");
      const workDir = path.join(this.dataDir, "work", run.id);
      await mkdir(workDir, { recursive: true });
      let result;
      try {
        // Decrypted only for this run, kept in memory, and hidden from the report and the log.
        const login = this.stores.vault.get(project.id);
        if (login) log("Using the saved login (kept encrypted on this server)");
        const roles = (login?.kind === "web" || login?.kind === "api") && extraOn(control, "roles") ? this.stores.vault.roles(project.id) : [];
        if (roles.length) log(`Also testing as ${roles.length} other account${roles.length === 1 ? "" : "s"}: ${roles.map((r) => r.name).join(", ")}`);
        let cookie: string | undefined;
        // Tests without screens (API, code, apps) send their calls and problems to the code panel through liveFeed.
        const screenless = ["api", "code", "android", "ios"].includes(project.type);
        const start = () => runEngine({
          product: project.type,
          target: project.target,
          login,
          agents: run.agents,
          maxPages: control.maxPages ?? project.target.maxPages ?? settings.get().defaultMaxPages,
          artifactsDir: this.artifactsDir(run.id),
          uploadsDir: this.uploadsDir(),
          workDir,
          signal,
          onProgress: (m) => {
            if (!signal.aborted) log(m);
          },
          onSession: (c) => (cookie = c),
          parallel: control.parallel ?? settings.get().parallelPages,
          live,
          inspect: on("inspect", "inspect"),
          baselineDir: on("visual", "visual") ? this.baselineDir(project.id) : undefined,
          journeys: on("journeys", "journeys") ? project.journeys : undefined,
          mailUrl: on("mail", "mail") ? process.env.MAILPIT_URL : undefined,
          roles,
          explore: on("explorer", "explorer"),
          system: project.target.system,
          hookInbox: on("webhooks", "webhooks") ? this.stores.hooks.inboxFor(project.id) : undefined,
          apiScenarios: project.type === "api" && extraOn(control, "scenarios") ? project.apiScenarios : undefined,
          apiBaselineFile: project.type === "api" ? this.apiBaselineFile(project.id) : undefined,
          // Checks that change data: a test copy, or the client's written permission (newest copy).
          writes: writeConsent(project.target, (projects.get(project.id) ?? project).permissions, run.trigger),
          seo: project.seo,
          rum: project.rumToken ? this.stores.rum.summary(project.id) : undefined,
          previousApp: (() => {
            if (project.type !== "android" && project.type !== "ios") return undefined;
            const prev = runs.list(20, project.id).find((r) => r.id !== run.id && r.status === "done" && r.result?.app);
            return prev?.result?.app ? { app: prev.result.app, at: prev.finishedAt ?? prev.createdAt } : undefined;
          })(),
        });
        const scoped = () => controlScope.run({ control, gate }, start);
        const engine = screenless ? liveFeed.run(live, scoped) : scoped();
        // The engine stops its browser or clone on the signal; the run ends at once either way.
        engine.catch(() => {});
        result = await Promise.race([
          engine,
          new Promise<never>((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ]);
        // Then the outside tools the project uses (Lighthouse, ZAP...), merged into the same report.
        // Master control may choose other tools for this test; permissions are checked again before each one runs.
        let choices = (control.tools ?? project.tools ?? (await defaultChoices(project.type))).filter((c) => toolById(c.id)?.products.includes(project.type));
        // Load and attack tests run only when someone starts the test, never on the schedule.
        if (run.trigger === "schedule" && choices.some((c) => toolById(c.id)?.safety === "permission")) {
          choices = choices.filter((c) => toolById(c.id)?.safety !== "permission");
          log("Load and attack tools are left out of scheduled tests: start a test by hand to run them");
        }
        if (choices.length) {
          update({ tools: choices });
          const cookieValues = (cookie ?? "").split(/;\s*/).map((p) => p.slice(p.indexOf("=") + 1));
          result = await runTools(result, {
            product: project.type,
            target: project.target,
            choices,
            cookie,
            login,
            secrets: [...secretsOf(login, project.target.repoUrl), ...roles.flatMap((r) => secretsOf(r.login)), ...cookieValues],
            artifactsDir: this.artifactsDir(run.id),
            uploadsDir: this.uploadsDir(),
            workDir,
            signal,
            log: (m) => {
              if (!signal.aborted) log(m);
            },
            // The newest copy: a permission withdrawn while this test waited no longer counts.
            permissions: (projects.get(project.id) ?? project).permissions,
            modules: settings.get().modules,
            appJourneys: extraOn(control, "appJourneys") ? (projects.get(project.id) ?? project).appJourneys?.filter((j) => !j.off) : undefined,
          });
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
      update({ result });
      // The first API test's file becomes the approved copy that later tests are compared with.
      if (project.type === "api" && result.api?.baselineSaved) await this.approveApiFile(project.id, run.id).catch(() => {});

      // Regression check: compare with the project's issue list.
      const current = projects.get(project.id) ?? project;
      // The test before this one, to tell problems new on the site from checks that ran for the first time.
      const previous = runs.list(20, project.id).find((r) => r.id !== run.id && r.status === "done" && r.result);
      const synced = syncIssues(current, run, issues.list(project.id), undefined, previous);
      for (const i of [...synced.created, ...synced.changed]) issues.save(i);
      projects.save({
        ...synced.project,
        lastRunId: run.id,
        lastRunAt: new Date().toISOString(),
        lastScore: result.overallScore,
      });
      update({ diff: synced.diff });
      // Master control's pass-or-fail rules.
      const verdict = verdictOf(control.gate, {
        score: result.overallScore,
        critical: result.findings.filter((f) => f.severity === "critical").length,
        high: result.findings.filter((f) => f.severity === "high").length,
        newIssues: synced.diff.new,
      });
      if (verdict) {
        update({ verdict });
        log(verdict.passed ? "Pass: every pass-or-fail rule in master control was met" : `Fail: ${verdict.reasons.join("; ")}`);
      }
      log(
        `Issues: ${synced.diff.new} new${synced.diff.firstChecked ? ` (${synced.diff.firstChecked} by a check that did not finish last time)` : ""}, ${synced.diff.fixed} fixed, ${synced.diff.reopened} came back, ${synced.diff.open} open`,
      );

      if (!extraOn(control, "ai")) {
        update({ aiError: "Claude summary was turned off in master control for this test." });
      } else if (aiEnabled() && settings.get().aiSummary) {
        // Same issues as the last summarised test: its summary still fits, and costs no credits.
        const earlier = runs.list(20, project.id).filter((r) => r.id !== run.id);
        const same = reusableSummary(earlier, summaryKey(result));
        if (same) {
          log("Same issues as the last test: reusing its Claude summary (no credits used)");
          // A summary reused before keeps pointing at the test it was written for.
          const from = same.ai.reusedFrom ?? { runId: same.run.id, at: same.run.finishedAt ?? same.run.createdAt };
          update({ ai: { ...same.ai, tokens: undefined, reusedFrom: from } });
        } else {
          log("Asking Claude to summarise the findings");
          try {
            const ai = await summariseWithClaude(result);
            update({ ai });
            if (ai.tokens) log(`Claude summary used ${(ai.tokens.input + ai.tokens.output).toLocaleString("en-IN")} tokens`);
          } catch (err) {
            update({ aiError: (err as Error).message });
          }
        }
      } else {
        update({
          aiError: aiEnabled()
            ? "Claude summary is turned off in the owner panel."
            : "Claude summary is off: set ANTHROPIC_API_KEY to turn it on.",
        });
      }
      update({ status: "done", finishedAt: new Date().toISOString() });
    } catch (err) {
      if (signal.aborted) {
        const why = signal.reason instanceof Error ? signal.reason.message : "Cancelled";
        // A deleted project's runs are already gone: do not bring the row back.
        if (!run.projectId || projects.get(run.projectId)) {
          update({ status: "cancelled", error: `${why} while it was running. Nothing was scored and no issues were changed.`, finishedAt: new Date().toISOString() });
          log(why);
        }
        return;
      }
      update({ status: "failed", error: shortError(err), finishedAt: new Date().toISOString() });
    } finally {
      gate.resume();
      this.gates.delete(run.id);
    }
  }
}
