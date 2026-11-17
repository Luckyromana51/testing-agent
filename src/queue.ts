import { randomUUID } from "node:crypto";
import path from "node:path";
import { aiEnabled, summariseWithClaude } from "./ai/triage.js";
import { scanSite } from "./runner/scan.js";
import type { RunStore } from "./store.js";
import type { Run } from "./types.js";

export interface ScanRequest {
  url: string;
  maxPages?: number;
  checkLinks?: boolean;
  accessibility?: boolean;
}

/**
 * In-process job queue with a concurrency limit.
 * Good for one server; replace with BullMQ + Redis when runners move to separate machines.
 */
export class ScanQueue {
  private waiting: { run: Run; req: ScanRequest }[] = [];
  private active = 0;

  constructor(
    private store: RunStore,
    private dataDir: string,
    private concurrency = 2,
  ) {}

  artifactsDir(runId: string): string {
    return path.join(this.dataDir, "artifacts", runId);
  }

  enqueue(req: ScanRequest): Run {
    const run: Run = {
      id: randomUUID(),
      url: req.url,
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: ["Queued"],
    };
    this.store.save(run);
    this.waiting.push({ run, req });
    this.pump();
    return run;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const job = this.waiting.shift()!;
      this.active++;
      this.execute(job.run, job.req).finally(() => {
        this.active--;
        this.pump();
      });
    }
  }

  private async execute(run: Run, req: ScanRequest): Promise<void> {
    const update = (patch: Partial<Run>) => {
      Object.assign(run, patch);
      this.store.save(run);
    };
    const log = (msg: string) => {
      run.progress = [...run.progress, msg].slice(-200);
      this.store.save(run);
    };

    update({ status: "running", startedAt: new Date().toISOString() });
    try {
      const result = await scanSite({
        url: req.url,
        maxPages: req.maxPages,
        checkLinks: req.checkLinks,
        accessibility: req.accessibility,
        artifactsDir: this.artifactsDir(run.id),
        onProgress: log,
      });
      update({ result });

      if (aiEnabled()) {
        log("Asking Claude to summarise the findings");
        try {
          update({ ai: await summariseWithClaude(result) });
        } catch (err) {
          update({ aiError: (err as Error).message });
        }
      } else {
        update({ aiError: "Claude summary is off: set ANTHROPIC_API_KEY to turn it on." });
      }
      update({ status: "done", finishedAt: new Date().toISOString() });
    } catch (err) {
      update({ status: "failed", error: (err as Error).message, finishedAt: new Date().toISOString() });
    }
  }
}
