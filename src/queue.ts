import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { agentsFor } from "./agents/registry.js";
import { aiEnabled, reusableSummary, summariseWithClaude, summaryKey } from "./ai/triage.js";
import { syncIssues } from "./issues.js";
import { runEngine } from "./engines/index.js";
import { LiveHub } from "./live.js";
import { defaultChoices, runTools, toolById } from "./tools/index.js";
import { secretsOf } from "./vault.js";
import type { Stores } from "./store.js";
import type { Project, Run } from "./types.js";

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
  private stopping = false;
  /** What running tests show live in the dashboard. */
  readonly live = new LiveHub();

  constructor(
    private stores: Stores,
    private dataDir: string,
    private concurrency = 2,
  ) {}

  artifactsDir(runId: string): string {
    return path.join(this.dataDir, "artifacts", runId);
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

  /** Queues a test run of a project with the agents the owner has turned on. */
  enqueue(project: Project, trigger: Run["trigger"] = "manual"): Run {
    const settings = this.stores.settings.get();
    const run: Run = {
      id: randomUUID(),
      url: project.target.url ?? project.target.specUrl ?? project.target.repoUrl ?? project.target.fileName ?? "",
      projectId: project.id,
      product: project.type,
      trigger,
      agents: agentsFor(project.type, settings.agents)
        .filter((a) => project.target.checkLinks !== false || a.id !== "web.links")
        .map((a) => a.id),
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
    try {
      if (!project) throw new Error("The project for this run was deleted.");
      const workDir = path.join(this.dataDir, "work", run.id);
      await mkdir(workDir, { recursive: true });
      let result;
      try {
        // Decrypted only for this run, kept in memory, and hidden from the report and the log.
        const login = this.stores.vault.get(project.id);
        if (login) log("Using the saved login (kept encrypted on this server)");
        let cookie: string | undefined;
        const engine = runEngine({
          product: project.type,
          target: project.target,
          login,
          agents: run.agents,
          maxPages: project.target.maxPages ?? settings.get().defaultMaxPages,
          artifactsDir: this.artifactsDir(run.id),
          uploadsDir: this.uploadsDir(),
          workDir,
          signal,
          onProgress: (m) => {
            if (!signal.aborted) log(m);
          },
          onSession: (c) => (cookie = c),
          parallel: settings.get().parallelPages,
          live,
        });
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
        let choices = (project.tools ?? (await defaultChoices(project.type))).filter((c) => toolById(c.id)?.products.includes(project.type));
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
            secrets: [...secretsOf(login, project.target.repoUrl), ...cookieValues],
            artifactsDir: this.artifactsDir(run.id),
            uploadsDir: this.uploadsDir(),
            workDir,
            signal,
            log: (m) => {
              if (!signal.aborted) log(m);
            },
            // The newest copy: a permission withdrawn while this test waited no longer counts.
            permissions: (projects.get(project.id) ?? project).permissions,
          });
        }
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
      update({ result });

      // Regression check: compare with the project's issue list.
      const current = projects.get(project.id) ?? project;
      const synced = syncIssues(current, run, issues.list(project.id));
      for (const i of [...synced.created, ...synced.changed]) issues.save(i);
      projects.save({
        ...synced.project,
        lastRunId: run.id,
        lastRunAt: new Date().toISOString(),
        lastScore: result.overallScore,
      });
      update({ diff: synced.diff });
      log(
        `Issues: ${synced.diff.new} new, ${synced.diff.fixed} fixed, ${synced.diff.reopened} came back, ${synced.diff.open} open`,
      );

      if (aiEnabled() && settings.get().aiSummary) {
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
    }
  }
}
