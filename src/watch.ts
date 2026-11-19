import { connect as tlsConnect } from "node:tls";
import type { DatabaseSync } from "node:sqlite";
import type { Project, WatchConfig } from "./types.js";
import { validateTarget } from "./runner/urls.js";

/**
 * Uptime and SSL watch: a quick check of each watched site every few minutes, from our own server
 * (like UptimeRobot or Pingdom, without the outside service). Two failed checks in a row open an
 * incident; the first good check closes it. Alerts show in the dashboard and, if the project sets
 * one, go to its own webhook (Slack, Teams, Google Chat or any URL that takes JSON).
 */
export interface WatchCheck {
  at: string;
  ok: boolean;
  status: number | null;
  ms: number;
  error?: string;
}

export interface Incident {
  id: number;
  projectId: string;
  startedAt: string;
  endedAt?: string;
  reason: string;
}

export interface WatchSummary {
  on: boolean;
  everyMin: number;
  /** Shares of good checks, in percent (null: no checks in that time yet). */
  uptime: { day: number | null; week: number | null; month: number | null };
  /** Response times of the last day, oldest first, for the chart. */
  recent: WatchCheck[];
  last?: WatchCheck;
  /** Average response time over the last day. */
  avgMs: number | null;
  ssl?: { validTo: string; daysLeft: number; issuer?: string; checkedAt: string; error?: string };
  incidents: Incident[];
  down: boolean;
}

export const WATCH_INTERVALS = [1, 5, 15, 60];
const DAY = 86_400_000;
const KEEP_DAYS = 31;

export function cleanWatch(input: Partial<WatchConfig> | null | undefined): WatchConfig | undefined {
  if (!input) return undefined;
  const everyMin = WATCH_INTERVALS.includes(Number(input.everyMin)) ? Number(input.everyMin) : 5;
  const out: WatchConfig = { on: Boolean(input.on), everyMin };
  const text = String(input.expectText ?? "").trim().slice(0, 100);
  if (text) out.expectText = text;
  const hook = String(input.webhook ?? "").trim();
  if (hook) {
    const u = new URL(validateTarget(hook));
    if (u.protocol !== "https:" && process.env.ALLOW_PRIVATE_TARGETS !== "1") throw new Error("The alert webhook must use https.");
    out.webhook = u.toString();
  }
  const warn = Number(input.sslWarnDays);
  out.sslWarnDays = Number.isFinite(warn) && warn >= 1 && warn <= 90 ? Math.round(warn) : 21;
  return out;
}

export class WatchStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS watch_checks (project_id TEXT NOT NULL, at TEXT NOT NULL, ok INTEGER NOT NULL, status INTEGER, ms INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS watch_checks_project ON watch_checks (project_id, at);
      CREATE TABLE IF NOT EXISTS watch_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watch_ssl (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    `);
  }

  add(projectId: string, c: WatchCheck): void {
    this.db.prepare("INSERT INTO watch_checks (project_id, at, ok, status, ms, error) VALUES (?, ?, ?, ?, ?, ?)").run(projectId, c.at, c.ok ? 1 : 0, c.status, c.ms, c.error ?? null);
  }

  checks(projectId: string, sinceIso: string): WatchCheck[] {
    const rows = this.db.prepare("SELECT at, ok, status, ms, error FROM watch_checks WHERE project_id = ? AND at >= ? ORDER BY at").all(projectId, sinceIso) as {
      at: string;
      ok: number;
      status: number | null;
      ms: number;
      error: string | null;
    }[];
    return rows.map((r) => ({ at: r.at, ok: r.ok === 1, status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}) }));
  }

  last(projectId: string, n = 2): WatchCheck[] {
    const rows = this.db.prepare("SELECT at, ok, status, ms, error FROM watch_checks WHERE project_id = ? ORDER BY at DESC LIMIT ?").all(projectId, n) as {
      at: string;
      ok: number;
      status: number | null;
      ms: number;
      error: string | null;
    }[];
    return rows.map((r) => ({ at: r.at, ok: r.ok === 1, status: r.status, ms: r.ms, ...(r.error ? { error: r.error } : {}) }));
  }

  uptime(projectId: string, sinceIso: string): number | null {
    const r = this.db.prepare("SELECT COUNT(*) AS n, SUM(ok) AS good FROM watch_checks WHERE project_id = ? AND at >= ?").get(projectId, sinceIso) as { n: number; good: number | null };
    return r.n ? Math.round(((r.good ?? 0) / r.n) * 10000) / 100 : null;
  }

  openIncident(projectId: string): Incident | undefined {
    const r = this.db.prepare("SELECT * FROM watch_incidents WHERE project_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1").get(projectId) as Record<string, string | number | null> | undefined;
    return r ? toIncident(r) : undefined;
  }

  startIncident(projectId: string, at: string, reason: string): Incident {
    const r = this.db.prepare("INSERT INTO watch_incidents (project_id, started_at, reason) VALUES (?, ?, ?)").run(projectId, at, reason);
    return { id: Number(r.lastInsertRowid), projectId, startedAt: at, reason };
  }

  endIncident(id: number, at: string): void {
    this.db.prepare("UPDATE watch_incidents SET ended_at = ? WHERE id = ?").run(at, id);
  }

  incidents(projectId?: string, limit = 20): Incident[] {
    const rows = (
      projectId
        ? this.db.prepare("SELECT * FROM watch_incidents WHERE project_id = ? ORDER BY id DESC LIMIT ?").all(projectId, limit)
        : this.db.prepare("SELECT * FROM watch_incidents ORDER BY id DESC LIMIT ?").all(limit)
    ) as Record<string, string | number | null>[];
    return rows.map(toIncident);
  }

  setSsl(projectId: string, ssl: WatchSummary["ssl"]): void {
    this.db.prepare("INSERT INTO watch_ssl (project_id, data) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data").run(projectId, JSON.stringify(ssl));
  }

  ssl(projectId: string): WatchSummary["ssl"] | undefined {
    const r = this.db.prepare("SELECT data FROM watch_ssl WHERE project_id = ?").get(projectId) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as WatchSummary["ssl"]) : undefined;
  }

  prune(now = Date.now()): void {
    this.db.prepare("DELETE FROM watch_checks WHERE at < ?").run(new Date(now - KEEP_DAYS * DAY).toISOString());
  }

  deleteProject(projectId: string): void {
    for (const t of ["watch_checks", "watch_incidents", "watch_ssl"]) this.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(projectId);
  }

  summary(p: Project, now = Date.now()): WatchSummary {
    const since = (ms: number) => new Date(now - ms).toISOString();
    const recent = this.checks(p.id, since(DAY));
    const good = recent.filter((c) => c.ok);
    const open = this.openIncident(p.id);
    return {
      on: Boolean(p.watch?.on),
      everyMin: p.watch?.everyMin ?? 5,
      uptime: { day: this.uptime(p.id, since(DAY)), week: this.uptime(p.id, since(7 * DAY)), month: this.uptime(p.id, since(30 * DAY)) },
      recent: recent.slice(-300),
      last: recent.at(-1) ?? this.last(p.id, 1)[0],
      avgMs: good.length ? Math.round(good.reduce((n, c) => n + c.ms, 0) / good.length) : null,
      ssl: this.ssl(p.id),
      incidents: this.incidents(p.id, 10),
      down: Boolean(open),
    };
  }
}

function toIncident(r: Record<string, string | number | null>): Incident {
  return {
    id: Number(r.id),
    projectId: String(r.project_id),
    startedAt: String(r.started_at),
    ...(r.ended_at ? { endedAt: String(r.ended_at) } : {}),
    reason: String(r.reason),
  };
}

/** One check: the page answers 2xx/3xx in time and, if asked, contains the expected words. */
export async function checkOnce(url: string, expectText?: string, timeoutMs = 15_000): Promise<WatchCheck> {
  const at = new Date().toISOString();
  const started = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": "GLVTestingAgent-Watch/0.2" },
    });
    const body = expectText ? await res.text() : (await res.body?.cancel(), "");
    const ms = Date.now() - started;
    if (res.status >= 400) return { at, ok: false, status: res.status, ms, error: `HTTP ${res.status}` };
    if (expectText && !body.toLowerCase().includes(expectText.toLowerCase())) return { at, ok: false, status: res.status, ms, error: `"${expectText}" is not on the page` };
    return { at, ok: true, status: res.status, ms };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const reason = e.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : (e.cause?.code ?? e.cause?.message ?? e.message);
    return { at, ok: false, status: null, ms: Date.now() - started, error: String(reason).slice(0, 200) };
  }
}

/** Reads the site's certificate: when it ends and who issued it. */
export function readCertificate(url: string, timeoutMs = 10_000): Promise<{ validTo: string; issuer?: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) return reject(new Error("The site sent no certificate."));
      resolve({ validTo: new Date(cert.valid_to).toISOString(), issuer: [cert.issuer?.O ?? cert.issuer?.CN].flat()[0] });
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("No answer when reading the certificate."));
    });
    socket.on("error", reject);
  });
}

export interface Alert {
  projectId: string;
  projectName: string;
  url: string;
  kind: "down" | "up" | "ssl";
  text: string;
  at: string;
}

export type AlertSender = (hook: string, alert: Alert) => Promise<void>;

/** Sends to the project's own webhook. Slack, Teams and Google Chat all read "text". */
export const postWebhook: AlertSender = async (hook, alert) => {
  await fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(alert),
    signal: AbortSignal.timeout(10_000),
  });
};

/**
 * Runs the checks. `tick` is called every 20 seconds by the server; each watched project is
 * checked when its interval has passed. The certificate is read once every 6 hours.
 */
export class Watcher {
  private due = new Map<string, number>();
  private sslDue = new Map<string, number>();
  private running = new Set<string>();
  readonly alerts: Alert[] = [];
  private timer?: NodeJS.Timeout;

  constructor(
    private store: WatchStore,
    private projects: () => Project[],
    private send: AlertSender = postWebhook,
    private check: typeof checkOnce = checkOnce,
    private cert: typeof readCertificate = readCertificate,
  ) {}

  start(everyMs = 20_000): () => void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
    return () => clearInterval(this.timer);
  }

  private alert(p: Project, kind: Alert["kind"], text: string): Promise<void> {
    const a: Alert = { projectId: p.id, projectName: p.name, url: p.target.url ?? "", kind, text, at: new Date().toISOString() };
    this.alerts.unshift(a);
    this.alerts.length = Math.min(this.alerts.length, 100);
    return p.watch?.webhook ? this.send(p.watch.webhook, a).catch(() => {}) : Promise.resolve();
  }

  async tick(now = Date.now()): Promise<void> {
    const work: Promise<void>[] = [];
    for (const p of this.projects()) {
      if (!p.watch?.on || !p.target.url || this.running.has(p.id)) continue;
      if ((this.due.get(p.id) ?? 0) > now) continue;
      this.due.set(p.id, now + p.watch.everyMin * 60_000);
      this.running.add(p.id);
      work.push(
        this.checkProject(p, now)
          .then(() => {})
          .finally(() => this.running.delete(p.id)),
      );
    }
    await Promise.all(work);
    if (Math.random() < 0.01) this.store.prune(now);
  }

  async checkProject(p: Project, now = Date.now()): Promise<WatchCheck> {
    const url = p.target.url!;
    const c = await this.check(url, p.watch?.expectText);
    this.store.add(p.id, c);
    const open = this.store.openIncident(p.id);
    if (!c.ok && !open) {
      const [, before] = this.store.last(p.id, 2);
      // Two failures in a row: one lost packet is not an outage.
      if (before && !before.ok) {
        this.store.startIncident(p.id, before.at, c.error ?? "failed");
        await this.alert(p, "down", `${p.name} is DOWN: ${url} (${c.error ?? "failed"}).`);
      }
    } else if (c.ok && open) {
      this.store.endIncident(open.id, c.at);
      const mins = Math.max(1, Math.round((new Date(c.at).getTime() - new Date(open.startedAt).getTime()) / 60_000));
      await this.alert(p, "up", `${p.name} is back UP: ${url} (down for about ${mins} min).`);
    }
    if (url.startsWith("https:") && (this.sslDue.get(p.id) ?? 0) <= now) {
      this.sslDue.set(p.id, now + 6 * 3_600_000);
      try {
        const cert = await this.cert(url);
        const daysLeft = Math.floor((new Date(cert.validTo).getTime() - now) / DAY);
        const prev = this.store.ssl(p.id);
        this.store.setSsl(p.id, { ...cert, daysLeft, checkedAt: new Date(now).toISOString() });
        const warn = p.watch?.sslWarnDays ?? 21;
        // Warn once when crossing the limit, not every 6 hours.
        if (daysLeft <= warn && (!prev || prev.error || prev.daysLeft > warn)) {
          await this.alert(p, "ssl", `${p.name}: the SSL certificate of ${new URL(url).hostname} ends in ${daysLeft} days (${cert.validTo.slice(0, 10)}). Renew it.`);
        }
      } catch (err) {
        this.store.setSsl(p.id, { validTo: "", daysLeft: -1, checkedAt: new Date(now).toISOString(), error: (err as Error).message.slice(0, 200) });
      }
    }
    return c;
  }
}
