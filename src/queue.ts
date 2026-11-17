import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { agentsFor } from "./agents/registry.js";
import { aiEnabled, summariseWithClaude } from "./ai/triage.js";
import { syncIssues } from "./issues.js";
import { scanSite } from "./runner/scan.js";
import type { Stores } from "./store.js";
import type { Project, Run } from "./types.js";

/**
 * In-process job queue with a concurrency limit.
 * Good for one server; replace with BullMQ + Redis when runners move to separate machines.
 */
export class ScanQueue {
  private waiting: Run[] = [];
  /** Running run id -> project id. */
  private active = new Map<string, string | undefined>();

  constructor(
    private stores: Stores,
    private dataDir: string,
    private concurrency = 2,
  ) {}

  artifactsDir(runId: string): string {
    return path.join(this.dataDir, "artifacts", runId);
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

  /** Queues a test run of a project with the agents the owner has turned on. */
  enqueue(project: Project, trigger: Run["trigger"] = "manual"): Run {
    const settings = this.stores.settings.get();
    const run: Run = {
      id: randomUUID(),
      url: project.target.url ?? "",
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
    while (this.active.size < this.concurrency && this.waiting.length) {
      const run = this.waiting.shift()!;
      this.active.set(run.id, run.projectId);
      this.execute(run).finally(() => {
        this.active.delete(run.id);
        this.pump();
      });
    }
  }

  private async execute(run: Run): Promise<void> {
    const { runs, projects, issues, settings } = this.stores;
    const update = (patch: Partial<Run>) => {
      Object.assign(run, patch);
      runs.save(run);
    };
    const log = (msg: string) => {
      run.progress = [...run.progress, msg].slice(-200);
      runs.save(run);
    };

    update({ status: "running", startedAt: new Date().toISOString() });
    const project = run.projectId ? projects.get(run.projectId) : undefined;
    try {
      if (!project) throw new Error("The project for this run was deleted.");
      const result = await scanSite({
        url: run.url,
        maxPages: project.target.maxPages ?? settings.get().defaultMaxPages,
        product: project.type,
        agents: run.agents,
        artifactsDir: this.artifactsDir(run.id),
        onProgress: log,
      });
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
        log("Asking Claude to summarise the findings");
        try {
          update({ ai: await summariseWithClaude(result) });
        } catch (err) {
          update({ aiError: (err as Error).message });
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
      update({ status: "failed", error: (err as Error).message, finishedAt: new Date().toISOString() });
    }
  }
}
