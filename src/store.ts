import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HelperStore } from "./helpers.js";
import type { Issue, Project, Role, Run, User } from "./types.js";
import { Vault } from "./vault.js";
import { WatchStore } from "./watch.js";

/**
 * SQLite storage (built into Node 22, no native build step). Each row keeps its object as JSON,
 * plus the columns we filter on. Swap for PostgreSQL when runners move to separate machines.
 */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "runs.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, key TEXT NOT NULL,
      status TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS issues_project ON issues (project_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL);
  `);
  // Databases from the first version have no project column on runs.
  const cols = db.prepare("PRAGMA table_info(runs)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "project_id")) db.exec("ALTER TABLE runs ADD COLUMN project_id TEXT");
  return db;
}

export class RunStore {
  constructor(private db: DatabaseSync) {
    // Runs that were mid-flight when the server stopped will never finish.
    const rows = this.db.prepare("SELECT data FROM runs WHERE status IN ('running', 'queued')").all() as { data: string }[];
    for (const r of rows) {
      const run = JSON.parse(r.data) as Run;
      this.save({ ...run, status: "failed", error: "Server restarted before the scan finished." });
    }
  }

  save(run: Run): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, url, status, created_at, project_id, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, project_id = excluded.project_id, data = excluded.data`,
      )
      .run(run.id, run.url, run.status, run.createdAt, run.projectId ?? null, JSON.stringify(run));
  }

  get(id: string): Run | undefined {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Run) : undefined;
  }

  list(limit = 50, projectId?: string): Run[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT data FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit)
        : this.db.prepare("SELECT data FROM runs ORDER BY created_at DESC LIMIT ?").all(limit)
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Run);
  }

  withoutProject(): Run[] {
    const rows = this.db.prepare("SELECT data FROM runs WHERE project_id IS NULL").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Run);
  }

  count(sinceIso?: string): number {
    const row = (
      sinceIso
        ? this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?").get(sinceIso)
        : this.db.prepare("SELECT COUNT(*) AS n FROM runs").get()
    ) as { n: number };
    return row.n;
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
  }

  deleteForProject(projectId: string): string[] {
    const ids = (this.db.prepare("SELECT id FROM runs WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id);
    this.db.prepare("DELETE FROM runs WHERE project_id = ?").run(projectId);
    return ids;
  }
}

export class ProjectStore {
  constructor(private db: DatabaseSync) {}

  save(p: Project): void {
    this.db
      .prepare("INSERT INTO projects (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(p.id, p.createdAt, JSON.stringify(p));
  }

  get(id: string): Project | undefined {
    const row = this.db.prepare("SELECT data FROM projects WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Project) : undefined;
  }

  list(): Project[] {
    const rows = this.db.prepare("SELECT data FROM projects ORDER BY created_at DESC").all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Project);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }
}

export class IssueStore {
  constructor(private db: DatabaseSync) {}

  save(i: Issue): void {
    this.db
      .prepare(
        `INSERT INTO issues (id, project_id, fingerprint, key, status, updated_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, data = excluded.data`,
      )
      .run(i.id, i.projectId, i.fingerprint, i.key, i.status, i.updatedAt, JSON.stringify(i));
  }

  get(idOrKey: string): Issue | undefined {
    const row = this.db.prepare("SELECT data FROM issues WHERE id = ? OR key = ?").get(idOrKey, idOrKey) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Issue) : undefined;
  }

  list(projectId?: string): Issue[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT data FROM issues WHERE project_id = ? ORDER BY updated_at DESC").all(projectId)
        : this.db.prepare("SELECT data FROM issues ORDER BY updated_at DESC LIMIT 2000").all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Issue);
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM issues WHERE project_id = ?").run(projectId);
  }
}

/** Small JSON settings the owner controls from the panel. */
export interface Settings {
  /** Agent on/off choices. Agents not listed use their default. */
  agents: Record<string, boolean>;
  defaultMaxPages: number;
  /** Turns the Claude summary off even when an API key is set. */
  aiSummary: boolean;
  /** Pages a web test opens at the same time (1 to 16). Unset: PARALLEL_PAGES, or 4. */
  parallelPages?: number;
  /** Tests (projects) run at the same time (1 to 8). Unset: SCAN_CONCURRENCY, or 2. */
  parallelProjects?: number;
  /** Optional modules on/off (see src/modules.ts). Unset: each module's default. */
  modules?: Record<string, boolean>;
}

const DEFAULT_SETTINGS: Settings = { agents: {}, defaultMaxPages: 20, aiSummary: true };

export class SettingsStore {
  constructor(private db: DatabaseSync) {}

  get(): Settings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
    return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.get(), ...patch };
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }
}

export class UserStore {
  constructor(private db: DatabaseSync) {}

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  create(u: User, passwordHash: string): void {
    this.db
      .prepare("INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(u.id, u.email.toLowerCase(), u.name, u.role, passwordHash, u.createdAt);
  }

  byEmail(email: string): (User & { passwordHash: string }) | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()) as Record<string, string> | undefined;
    return row ? { ...toUser(row), passwordHash: row.password_hash } : undefined;
  }

  get(id: string): User | undefined {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Record<string, string> | undefined;
    return row ? toUser(row) : undefined;
  }

  list(): User[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY created_at").all() as Record<string, string>[]).map(toUser);
  }

  setPassword(id: string, passwordHash: string): void {
    this.db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  }

  createSession(tokenHash: string, userId: string, expiresAt: string): void {
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, expiresAt);
  }

  sessionUser(tokenHash: string): User | undefined {
    const row = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as
      | { user_id: string; expires_at: string }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < new Date().toISOString()) {
      this.deleteSession(tokenHash);
      return undefined;
    }
    return this.get(row.user_id);
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }
}

function toUser(row: Record<string, string>): User {
  return { id: row.id, email: row.email, name: row.name, role: row.role as Role, createdAt: row.created_at };
}

export interface Stores {
  runs: RunStore;
  projects: ProjectStore;
  issues: IssueStore;
  settings: SettingsStore;
  users: UserStore;
  /** Encrypted client logins for logged-in testing. */
  vault: Vault;
  /** Paired Mac helpers (their tokens are kept hashed). */
  helpers: HelperStore;
  /** Uptime checks, incidents and certificates of watched projects. */
  watch: WatchStore;
}

export function openStores(dataDir: string): Stores {
  const db = openDatabase(dataDir);
  return {
    runs: new RunStore(db),
    projects: new ProjectStore(db),
    issues: new IssueStore(db),
    settings: new SettingsStore(db),
    users: new UserStore(db),
    vault: new Vault(db, dataDir),
    helpers: new HelperStore(db),
    watch: new WatchStore(db),
  };
}
