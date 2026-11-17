import type { ScanQueue } from "./queue.js";
import type { ProjectStore } from "./store.js";

const DAY = 86_400_000;

/**
 * Re-tests projects on their schedule (daily or weekly), so regressions are caught
 * without anyone pressing a button. Checks once a minute.
 */
export function startScheduler(projects: ProjectStore, queue: ScanQueue, everyMs = 60_000): () => void {
  const tick = () => {
    const now = Date.now();
    for (const p of projects.list()) {
      if (p.schedule === "off" || queue.busy(p.id)) continue;
      const gap = p.schedule === "daily" ? DAY : 7 * DAY;
      const last = p.lastRunAt ? new Date(p.lastRunAt).getTime() : new Date(p.createdAt).getTime();
      if (now - last >= gap) queue.enqueue(p, "schedule");
    }
  };
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
