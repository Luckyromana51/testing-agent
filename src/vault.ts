import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Login, LoginKind, LoginSummary } from "./types.js";

/**
 * Encrypted store for client logins: website and app sign-ins, API tokens and Git access tokens.
 *
 * Secrets are sealed with AES-256-GCM. The key comes from SECRET_KEY in the server's .env. Without
 * it, a random key is made once and kept in the data folder (vault.key), which is fine on your own
 * computer; on a server, set SECRET_KEY so the key is not stored next to the data it protects.
 * Secrets never leave the server: the dashboard only sees whether one is saved.
 */

/** The parts of a login that are secret. Everything else (address, user name) can be shown. */
const SECRET_FIELDS = ["password", "token"] as const;
type SecretPart = Partial<Record<(typeof SECRET_FIELDS)[number], string>>;

interface Key {
  id: string;
  key: Buffer;
}

export interface VaultStatus {
  /** Where the key comes from. */
  source: "env" | "file";
  keyId: string;
  saved: number;
  /** Logins saved with a key the server no longer has; they must be entered again. */
  unreadable: number;
}

const deriveKey = (secret: string | Buffer): Key => {
  const key = Buffer.from(hkdfSync("sha256", secret, "glv-testing-agent", "login-vault-v1", 32));
  return { id: createHash("sha256").update(key).digest("hex").slice(0, 12), key };
};

/** Reads SECRET_KEY, or the key file in the data folder (made on first use when SECRET_KEY is not set). */
export function loadKeys(dataDir: string, env: NodeJS.ProcessEnv = process.env): { current: Key; others: Key[]; source: "env" | "file" } {
  const file = path.join(dataDir, "vault.key");
  const fileKey = existsSync(file) ? deriveKey(readFileSync(file, "utf8").trim()) : undefined;
  const secret = env.SECRET_KEY?.trim();
  if (secret) {
    if (secret.length < 16) {
      throw new Error("SECRET_KEY is too short. Make one with: openssl rand -base64 32");
    }
    return { current: deriveKey(secret), others: fileKey ? [fileKey] : [], source: "env" };
  }
  if (fileKey) return { current: fileKey, others: [], source: "file" };
  mkdirSync(dataDir, { recursive: true });
  const fresh = randomBytes(32).toString("base64");
  writeFileSync(file, fresh, { mode: 0o600, flag: "wx" });
  return { current: deriveKey(fresh), others: [], source: "file" };
}

function seal(key: Key, plain: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function open(key: Key, sealed: string, aad: string): string {
  const buf = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key.key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

interface Row {
  project_id: string;
  kind: LoginKind;
  info: string;
  secret: string;
  key_id: string;
  updated_at: string;
}

export class Vault {
  private current: Key;
  private keys: Map<string, Key>;
  readonly source: "env" | "file";

  constructor(
    private db: DatabaseSync,
    dataDir: string,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS logins (
      project_id TEXT PRIMARY KEY, kind TEXT NOT NULL, info TEXT NOT NULL, secret TEXT NOT NULL,
      key_id TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const { current, others, source } = loadKeys(dataDir, env);
    this.current = current;
    this.source = source;
    this.keys = new Map([current, ...others].map((k) => [k.id, k]));
    this.rekey();
  }

  /** Re-seals logins made with an older key (for example before SECRET_KEY was set) with the current one. */
  private rekey(): void {
    const rows = this.db.prepare("SELECT * FROM logins WHERE key_id != ?").all(this.current.id) as unknown as Row[];
    for (const row of rows) {
      const old = this.keys.get(row.key_id);
      if (!old) continue;
      const aad = `${row.project_id}|${row.kind}`;
      const plain = open(old, row.secret, aad);
      this.db
        .prepare("UPDATE logins SET secret = ?, key_id = ? WHERE project_id = ?")
        .run(seal(this.current, plain, aad), this.current.id, row.project_id);
    }
  }

  private row(projectId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM logins WHERE project_id = ?").get(projectId) as unknown as Row | undefined;
  }

  /** Saves a login. Secret fields left empty keep the value saved before. */
  save(projectId: string, login: Login): void {
    const info: Record<string, unknown> = {};
    const secret: SecretPart = {};
    for (const [k, v] of Object.entries(login)) {
      if (v === undefined || v === "") continue;
      if ((SECRET_FIELDS as readonly string[]).includes(k)) secret[k as keyof SecretPart] = String(v);
      else info[k] = v;
    }
    const prev = this.get(projectId, { quiet: true });
    if (prev && prev.kind === login.kind) {
      for (const k of SECRET_FIELDS) if (!secret[k] && prev[k]) secret[k] = prev[k];
    }
    const aad = `${projectId}|${login.kind}`;
    this.db
      .prepare(
        `INSERT INTO logins (project_id, kind, info, secret, key_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET kind = excluded.kind, info = excluded.info, secret = excluded.secret,
         key_id = excluded.key_id, updated_at = excluded.updated_at`,
      )
      .run(projectId, login.kind, JSON.stringify(info), seal(this.current, JSON.stringify(secret), aad), this.current.id, new Date().toISOString());
  }

  /**
   * The full login with its secrets, for a test run only. Throws when it was saved with a key this
   * server no longer has (unless quiet, which returns undefined instead).
   */
  get(projectId: string, opts: { quiet?: boolean } = {}): Login | undefined {
    const row = this.row(projectId);
    if (!row) return undefined;
    const key = this.keys.get(row.key_id);
    if (!key) {
      if (opts.quiet) return undefined;
      throw new Error("The saved login was encrypted with a different SECRET_KEY. Enter the login again in the project settings.");
    }
    const secret = JSON.parse(open(key, row.secret, `${row.project_id}|${row.kind}`)) as SecretPart;
    return { ...(JSON.parse(row.info) as Login), ...secret, kind: row.kind };
  }

  /** What the dashboard may see: everything except the secrets, plus whether each one is saved. */
  summary(projectId: string): LoginSummary | undefined {
    const row = this.row(projectId);
    if (!row) return undefined;
    const readable = this.keys.has(row.key_id);
    let saved: SecretPart = {};
    if (readable) saved = JSON.parse(open(this.keys.get(row.key_id)!, row.secret, `${row.project_id}|${row.kind}`)) as SecretPart;
    return {
      ...(JSON.parse(row.info) as Omit<Login, "password" | "token">),
      kind: row.kind,
      hasPassword: Boolean(saved.password),
      hasToken: Boolean(saved.token),
      unreadable: !readable || undefined,
      updatedAt: row.updated_at,
    };
  }

  delete(projectId: string): void {
    this.db.prepare("DELETE FROM logins WHERE project_id = ?").run(projectId);
  }

  status(): VaultStatus {
    const rows = this.db.prepare("SELECT key_id FROM logins").all() as { key_id: string }[];
    return {
      source: this.source,
      keyId: this.current.id,
      saved: rows.length,
      unreadable: rows.filter((r) => !this.keys.has(r.key_id)).length,
    };
  }
}

/** Every secret in a login, for hiding them in reports and error messages. */
export function secretsOf(login: Login | undefined, repoUrl?: string): string[] {
  if (!login) return [];
  const out = [login.password, login.token].filter((s): s is string => Boolean(s && s.length >= 4));
  if (login.password && login.username) out.push(Buffer.from(`${login.username}:${login.password}`).toString("base64"));
  if (login.token) out.push(Buffer.from(`${gitUser(login.username, repoUrl)}:${login.token}`).toString("base64"));
  return out;
}

/** The user name Git hosts expect with an access token, when none was entered. */
export function gitUser(username: string | undefined, repoUrl: string | undefined): string {
  if (username) return username;
  let host = "";
  try {
    host = new URL(repoUrl ?? "").hostname;
  } catch {
    /* no address */
  }
  if (/(^|\.)gitlab\./.test(host)) return "oauth2";
  if (/(^|\.)bitbucket\.org$/.test(host)) return "x-token-auth";
  return "x-access-token";
}

/** Replaces every secret in a piece of text, JSON included, with [hidden]. */
export function redact<T>(value: T, secrets: string[]): T {
  if (!secrets.length) return value;
  let text = JSON.stringify(value);
  if (text === undefined) return value;
  for (const s of secrets) {
    const inJson = JSON.stringify(s).slice(1, -1);
    text = text.split(inJson).join("[hidden]");
    const encoded = encodeURIComponent(s);
    if (encoded !== s) text = text.split(JSON.stringify(encoded).slice(1, -1)).join("[hidden]");
  }
  return JSON.parse(text) as T;
}
