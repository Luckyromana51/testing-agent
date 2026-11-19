import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { HookInbox } from "../types.js";

/**
 * The webhook inbox: our own address per project that catches what the client's app sends out
 * (WhatsApp CRM messages, payment and form notifications, Zapier-style hooks), like webhook.site
 * but on our server. Journeys can wait for a message with "webhook has <words>".
 */

export interface HookMessage {
  id: number;
  at: string;
  method: string;
  path: string;
  /** Request headers, without cookies and login headers. */
  headers: Record<string, string>;
  body: string;
  bytes: number;
}

const KEEP = 200;
export const MAX_HOOK_BODY = 64_000;
const DROP_HEADERS = /^(cookie|authorization|proxy-authorization|x-forwarded-for|x-real-ip)$/i;

export class HookStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS hook_inboxes (project_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS hook_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, at TEXT NOT NULL, method TEXT NOT NULL,
        path TEXT NOT NULL, headers TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hook_messages_project ON hook_messages (project_id, id);`);
  }

  token(projectId: string): string | undefined {
    return (this.db.prepare("SELECT token FROM hook_inboxes WHERE project_id = ?").get(projectId) as { token: string } | undefined)?.token;
  }

  /** Opens the project's inbox (or gives it a new address with `fresh`). */
  open(projectId: string, fresh = false): string {
    const had = this.token(projectId);
    if (had && !fresh) return had;
    const token = randomBytes(18).toString("base64url");
    this.db
      .prepare("INSERT INTO hook_inboxes (project_id, token, created_at) VALUES (?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET token = excluded.token")
      .run(projectId, token, new Date().toISOString());
    return token;
  }

  close(projectId: string): void {
    this.db.prepare("DELETE FROM hook_inboxes WHERE project_id = ?").run(projectId);
    this.clear(projectId);
  }

  projectFor(token: string): string | undefined {
    if (!/^[\w-]{20,40}$/.test(token)) return undefined;
    return (this.db.prepare("SELECT project_id FROM hook_inboxes WHERE token = ?").get(token) as { project_id: string } | undefined)?.project_id;
  }

  add(projectId: string, msg: { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string }): void {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(msg.headers)) {
      if (v === undefined || DROP_HEADERS.test(k)) continue;
      headers[k] = (Array.isArray(v) ? v.join(", ") : v).slice(0, 500);
    }
    const bytes = Buffer.byteLength(msg.body);
    this.db
      .prepare("INSERT INTO hook_messages (project_id, at, method, path, headers, body, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(projectId, new Date().toISOString(), msg.method.slice(0, 10), msg.path.slice(0, 500), JSON.stringify(headers), msg.body.slice(0, MAX_HOOK_BODY), bytes);
    this.db
      .prepare("DELETE FROM hook_messages WHERE project_id = ? AND id NOT IN (SELECT id FROM hook_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?)")
      .run(projectId, projectId, KEEP);
  }

  list(projectId: string, limit = 50, since?: string): HookMessage[] {
    const rows = (since
      ? this.db.prepare("SELECT * FROM hook_messages WHERE project_id = ? AND at >= ? ORDER BY id DESC LIMIT ?").all(projectId, since, limit)
      : this.db.prepare("SELECT * FROM hook_messages WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit)) as unknown as (Omit<HookMessage, "headers"> & { headers: string })[];
    return rows.map((r) => ({ id: r.id, at: r.at, method: r.method, path: r.path, headers: JSON.parse(r.headers), body: r.body, bytes: r.bytes }));
  }

  clear(projectId: string): void {
    this.db.prepare("DELETE FROM hook_messages WHERE project_id = ?").run(projectId);
  }

  /** The address the app should send to. PUBLIC_URL is this server's address as the client's app sees it. */
  address(token: string): string {
    const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");
    return `${base}/hooks/${token}`;
  }

  inboxFor(projectId: string): HookInbox | undefined {
    const token = this.token(projectId);
    if (!token) return undefined;
    return { address: this.address(token), since: (since) => this.list(projectId, 50, since) };
  }
}
