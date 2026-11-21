import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Vault } from "../vault.js";
import {
  CONNECTION_KINDS,
  KIND_LABEL,
  type Connection,
  type ConnectionKind,
  type ConnectionSecret,
  type ConnectionView,
  type ResolvedConnection,
} from "./types.js";

export class ConnectionError extends Error {}

/** Most connections one project keeps. */
export const MAX_CONNECTIONS = 10;

interface Row {
  id: string;
  project_id: string;
  info: string;
  secret: string | null;
  key_id: string | null;
}

const aadOf = (projectId: string, id: string) => `${projectId}|connection|${id}`;

/** Where SSH key files referenced as file:name are kept (a folder only the server reads). */
export const keysDir = (env: NodeJS.ProcessEnv = process.env) => env.SSH_KEYS_DIR || path.join(env.DATA_DIR || "./data", "ssh-keys");

/**
 * Reads a secret reference. Only names starting with CONN_ are read from the .env, so a connection
 * can never send the server's own keys (SECRET_KEY, ANTHROPIC_API_KEY) to a client's address.
 */
export function readReference(ref: string, env: NodeJS.ProcessEnv = process.env): string {
  const m = /^(env|file):(.+)$/.exec(ref.trim());
  if (!m) throw new ConnectionError('A secret reference is env:CONN_NAME (a line in the server\'s .env) or file:name (a key file in SSH_KEYS_DIR).');
  const [, kind, name] = m;
  if (kind === "env") {
    if (!/^CONN_[A-Z0-9_]{1,60}$/.test(name)) throw new ConnectionError("Only .env names that start with CONN_ can be used, like env:CONN_ACME_TOKEN.");
    const value = env[name];
    if (!value) throw new ConnectionError(`${name} is not set in the server's .env. Add it there and restart the app.`);
    // .env files cannot hold line breaks: keys may be written with \n.
    return value.replace(/\\n/g, "\n");
  }
  if (!/^[\w.-]{1,100}$/.test(name) || name.startsWith(".")) throw new ConnectionError("A key file name has only letters, digits, dots, dashes and underscores.");
  const file = path.join(keysDir(env), name);
  if (!existsSync(file)) throw new ConnectionError(`No key file ${name} in the server's SSH key folder (${keysDir(env)}).`);
  return readFileSync(file, "utf8");
}

const HOST = /^(?=.{1,253}$)(?!-)[a-zA-Z0-9.-]+$|^\[?[0-9a-fA-F:]+\]?$/;
const USER = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}$/;

export interface ConnectionInput {
  kind?: unknown;
  name?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  auth?: unknown;
  tunnel?: unknown;
  siteUrl?: unknown;
  url?: unknown;
  secretRef?: unknown;
  checks?: unknown;
  key?: unknown;
  password?: unknown;
  token?: unknown;
}

const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Checks what the tester typed, and splits it into what is saved in the open and what is sealed. */
export function cleanConnection(input: ConnectionInput, before?: Connection): { info: Omit<Connection, "id" | "projectId" | "createdAt" | "updatedAt" | "by">; secret: ConnectionSecret } {
  const kind = (before?.kind ?? input.kind) as ConnectionKind;
  if (!CONNECTION_KINDS.includes(kind)) throw new ConnectionError("Choose SSH, Hostinger or MCP.");
  const name = str(input.name, 80) || before?.name || KIND_LABEL[kind];
  const secretRef = input.secretRef === undefined ? before?.secretRef : str(input.secretRef, 120) || undefined;
  if (secretRef && !/^(env|file):/.test(secretRef)) throw new ConnectionError("A secret reference starts with env: or file:.");
  if (secretRef?.startsWith("file:") && kind !== "ssh") throw new ConnectionError("Key files are for SSH. For a token use env:CONN_NAME.");
  const checks = input.checks === undefined ? (before?.checks ?? true) : input.checks !== false;
  const secret: ConnectionSecret = {};
  const key = str(input.key, 20_000);
  const password = typeof input.password === "string" ? input.password.slice(0, 500) : "";
  const token = str(input.token, 4000);

  if (kind === "ssh") {
    const host = str(input.host, 253) || before?.host || "";
    if (!host || !HOST.test(host)) throw new ConnectionError("Enter the server's address, like 203.0.113.7 or server.example.com.");
    const port = input.port === undefined || input.port === "" ? (before?.port ?? 22) : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectionError("The SSH port is a number from 1 to 65535.");
    const username = str(input.username, 32) || before?.username || "";
    if (!USER.test(username)) throw new ConnectionError("Enter the user to sign in as, like deploy or ubuntu.");
    const auth = input.auth === "password" ? "password" : input.auth === "key" ? "key" : (before?.auth ?? "key");
    if (key && !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new ConnectionError("That does not look like a private key. It starts with -----BEGIN OPENSSH PRIVATE KEY-----.");
    if (key) secret.key = key.endsWith("\n") ? key : `${key}\n`;
    if (password) secret.password = password;
    const tunnel = input.tunnel === undefined ? Boolean(before?.tunnel) : input.tunnel === true;
    let siteUrl = input.siteUrl === undefined ? before?.siteUrl : str(input.siteUrl, 500) || undefined;
    if (siteUrl) {
      try {
        const u = new URL(siteUrl.includes("://") ? siteUrl : `http://${siteUrl}`);
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
        siteUrl = u.toString();
      } catch {
        throw new ConnectionError("The site address through the server is like http://localhost:8080 or http://staging.internal.");
      }
    }
    if (tunnel && !siteUrl) throw new ConnectionError("Enter the test site's address as the server sees it, like http://localhost:8080.");
    const hostKey = before && (before.host !== host || before.port !== port) ? undefined : before?.hostKey;
    return { info: { kind, name, host, port, username, auth, tunnel, ...(siteUrl ? { siteUrl } : {}), ...(hostKey ? { hostKey } : {}), ...(secretRef ? { secretRef } : {}), checks, ...(before?.lastTest ? { lastTest: before.lastTest } : {}) }, secret };
  }

  if (token) secret.token = token;
  if (kind === "mcp") {
    const raw = str(input.url, 500) || before?.url || "";
    let url: string;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
      url = u.toString();
    } catch {
      throw new ConnectionError("Enter the MCP server's address, like https://mcp.example.com/mcp.");
    }
    return { info: { kind, name, url, ...(secretRef ? { secretRef } : {}), checks, ...(before?.lastTest && before.url === url ? { lastTest: before.lastTest } : {}) }, secret };
  }
  return { info: { kind, name, ...(secretRef ? { secretRef } : {}), checks, ...(before?.lastTest ? { lastTest: before.lastTest } : {}) }, secret };
}

/** Client connections of each project, with their secrets sealed by the vault's key. */
export class ConnectionStore {
  constructor(
    private db: DatabaseSync,
    private vault: Vault,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS connections (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, info TEXT NOT NULL, secret TEXT, key_id TEXT, updated_at TEXT NOT NULL
    )`);
    db.exec("CREATE INDEX IF NOT EXISTS connections_project ON connections (project_id)");
    db.exec(`CREATE TABLE IF NOT EXISTS mcp_tokens (
      token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL, last_used TEXT
    )`);
  }

  private rows(projectId: string): Row[] {
    return this.db.prepare("SELECT * FROM connections WHERE project_id = ? ORDER BY updated_at").all(projectId) as unknown as Row[];
  }

  private row(projectId: string, id: string): Row | undefined {
    return this.db.prepare("SELECT * FROM connections WHERE project_id = ? AND id = ?").get(projectId, id) as unknown as Row | undefined;
  }

  list(projectId: string): Connection[] {
    return this.rows(projectId).map((r) => JSON.parse(r.info) as Connection);
  }

  get(projectId: string, id: string): Connection | undefined {
    const r = this.row(projectId, id);
    return r ? (JSON.parse(r.info) as Connection) : undefined;
  }

  /** What the dashboard sees. */
  views(projectId: string): ConnectionView[] {
    return this.rows(projectId).map((r) => {
      const c = JSON.parse(r.info) as Connection;
      const readable = r.secret && r.key_id ? this.vault.openText(r.secret, r.key_id, aadOf(projectId, c.id)) !== undefined : false;
      return { ...c, label: KIND_LABEL[c.kind], secret: c.secretRef ? "reference" : r.secret ? (readable ? "saved" : "unreadable") : "none" };
    });
  }

  private sealedSecret(r: Row): ConnectionSecret {
    if (!r.secret || !r.key_id) return {};
    const text = this.vault.openText(r.secret, r.key_id, aadOf(r.project_id, r.id));
    return text ? (JSON.parse(text) as ConnectionSecret) : {};
  }

  /**
   * Saves a new connection, or changes one. A secret left empty keeps the one saved before; a
   * reference (env: or file:) replaces any sealed secret.
   */
  save(projectId: string, input: ConnectionInput, by: string, id?: string): Connection {
    const before = id ? this.get(projectId, id) : undefined;
    if (id && !before) throw new ConnectionError("Connection not found.");
    if (!before && this.rows(projectId).length >= MAX_CONNECTIONS) throw new ConnectionError(`A project keeps at most ${MAX_CONNECTIONS} connections.`);
    const { info, secret } = cleanConnection(input, before);
    const now = new Date().toISOString();
    const c: Connection = { ...info, id: before?.id ?? randomUUID(), projectId, createdAt: before?.createdAt ?? now, updatedAt: now, by: before?.by ?? by };
    const oldRow = before ? this.row(projectId, before.id) : undefined;
    const merged: ConnectionSecret = c.secretRef ? {} : { ...(oldRow ? this.sealedSecret(oldRow) : {}), ...secret };
    // A switch from key to password (or back) drops the other kind's secret.
    if (c.kind === "ssh" && c.auth === "password") delete merged.key;
    const hasSecret = Object.values(merged).some(Boolean);
    if (!c.secretRef && !hasSecret && c.kind === "hostinger") throw new ConnectionError("Paste the Hostinger API token (hPanel > Profile > API), or write env:CONN_NAME for one kept in the .env.");
    if (!c.secretRef && c.kind === "ssh" && (c.auth === "password" ? !merged.password : !merged.key)) {
      throw new ConnectionError(c.auth === "password" ? "Enter the SSH password, or use a key." : "Paste the private key, or write file:name for a key file on the server, or env:CONN_NAME.");
    }
    const sealed = hasSecret ? this.vault.sealText(JSON.stringify(merged), aadOf(projectId, c.id)) : undefined;
    this.db
      .prepare(
        `INSERT INTO connections (id, project_id, info, secret, key_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET info = excluded.info, secret = excluded.secret, key_id = excluded.key_id, updated_at = excluded.updated_at`,
      )
      .run(c.id, projectId, JSON.stringify(c), sealed?.secret ?? null, sealed?.keyId ?? null, now);
    return c;
  }

  /** Keeps a connection's own facts (the last test, the server key it learned) without touching its secret. */
  update(projectId: string, id: string, patch: Partial<Pick<Connection, "lastTest" | "hostKey">>): Connection | undefined {
    const c = this.get(projectId, id);
    if (!c) return undefined;
    const next = { ...c, ...patch };
    this.db.prepare("UPDATE connections SET info = ? WHERE id = ? AND project_id = ?").run(JSON.stringify(next), id, projectId);
    return next;
  }

  /** The connection with its secret, for one test or check. Throws when the secret cannot be read. */
  resolve(projectId: string, id: string, env: NodeJS.ProcessEnv = process.env): ResolvedConnection {
    const r = this.row(projectId, id);
    if (!r) throw new ConnectionError("Connection not found.");
    const c = JSON.parse(r.info) as Connection;
    if (c.secretRef) {
      const value = readReference(c.secretRef, env);
      const secret: ConnectionSecret = c.kind === "ssh" ? (c.auth === "password" ? { password: value } : { key: value.endsWith("\n") ? value : `${value}\n` }) : { token: value.trim() };
      return { ...c, secret };
    }
    const secret = this.sealedSecret(r);
    if (r.secret && !Object.keys(secret).length) throw new ConnectionError("This connection's secret was saved with a key this server no longer has (SECRET_KEY changed). Enter it again.");
    return { ...c, secret };
  }

  /** Every connection of the project whose checks run in tests, with secrets; unreadable ones come back as errors. */
  forRun(projectId: string, env: NodeJS.ProcessEnv = process.env): { ok: ResolvedConnection[]; failed: { connection: Connection; error: string }[] } {
    const ok: ResolvedConnection[] = [];
    const failed: { connection: Connection; error: string }[] = [];
    for (const c of this.list(projectId)) {
      if (!c.checks && !c.tunnel) continue;
      try {
        ok.push(this.resolve(projectId, c.id, env));
      } catch (err) {
        failed.push({ connection: c, error: (err as Error).message });
      }
    }
    return { ok, failed };
  }

  delete(projectId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM connections WHERE project_id = ? AND id = ?").run(projectId, id).changes > 0;
  }

  deleteForProject(projectId: string): void {
    this.db.prepare("DELETE FROM connections WHERE project_id = ?").run(projectId);
    this.db.prepare("DELETE FROM mcp_tokens WHERE project_id = ?").run(projectId);
  }

  // ---- Tokens for the client's AI to reach GLV's own MCP server (this project only) ----

  createMcpToken(projectId: string, name: string, by: string): { token: string; id: string } {
    const token = `glvm_${randomBytes(24).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    this.db
      .prepare("INSERT INTO mcp_tokens (token_hash, project_id, name, created_at, created_by) VALUES (?, ?, ?, ?, ?)")
      .run(hash, projectId, name.slice(0, 80) || "Client AI", new Date().toISOString(), by);
    return { token, id: hash.slice(0, 16) };
  }

  mcpTokens(projectId: string): { id: string; name: string; createdAt: string; createdBy: string; lastUsed?: string }[] {
    const rows = this.db.prepare("SELECT * FROM mcp_tokens WHERE project_id = ? ORDER BY created_at").all(projectId) as Record<string, string | null>[];
    return rows.map((r) => ({ id: String(r.token_hash).slice(0, 16), name: String(r.name), createdAt: String(r.created_at), createdBy: String(r.created_by), ...(r.last_used ? { lastUsed: r.last_used } : {}) }));
  }

  deleteMcpToken(projectId: string, id: string): boolean {
    if (!/^[0-9a-f]{16}$/.test(id)) return false;
    return this.db.prepare("DELETE FROM mcp_tokens WHERE project_id = ? AND substr(token_hash, 1, 16) = ?").run(projectId, id).changes > 0;
  }

  /** The project a GLV MCP token opens, when it is known. */
  mcpProject(token: string): string | undefined {
    if (!/^glvm_[\w-]{20,}$/.test(token)) return undefined;
    const hash = createHash("sha256").update(token).digest("hex");
    const row = this.db.prepare("SELECT project_id FROM mcp_tokens WHERE token_hash = ?").get(hash) as { project_id: string } | undefined;
    if (row) this.db.prepare("UPDATE mcp_tokens SET last_used = ? WHERE token_hash = ?").run(new Date().toISOString(), hash);
    return row?.project_id;
  }
}

/** Every secret of the connections, for hiding them in reports and logs. */
export function connectionSecrets(list: ResolvedConnection[]): string[] {
  return list.flatMap((c) => [c.secret.key, c.secret.password, c.secret.token]).filter((s): s is string => Boolean(s && s.length >= 6));
}
