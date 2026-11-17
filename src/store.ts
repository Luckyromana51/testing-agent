import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Run } from "./types.js";

/**
 * Stores runs in SQLite (built into Node 22, no native build step).
 * Each run is one row holding its JSON. Swap for PostgreSQL when we add multi-user projects.
 */
export class RunStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "runs.db"));
    this.db.exec(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    )`);
    // Runs that were mid-flight when the server stopped will never finish.
    for (const run of this.list(1000)) {
      if (run.status === "running" || run.status === "queued") {
        this.save({ ...run, status: "failed", error: "Server restarted before the scan finished." });
      }
    }
  }

  save(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, url, status, created_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(run.id, run.url, run.status, run.createdAt, JSON.stringify(run));
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Run) : undefined;
  }

  list(limit = 50): Run[] {
    const rows = this.db.prepare("SELECT data FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as Run);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  }
}
