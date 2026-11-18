import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * Mac helpers: a small program on a Mac with Xcode (helper/mac/glv-helper.mjs) that runs the tests
 * a Linux server cannot: real Safari on the Mac and in the iOS Simulator, VoiceOver, and iOS apps in
 * the Simulator with Apple's accessibility audit. The Mac connects out to this server (nothing has
 * to reach the Mac), asks for work, runs it and sends the results back. The server turns the
 * results into findings, so the helper stays small and all the rules are tested here.
 */

/** The kinds of work a helper can do. */
export type HelperKind = "safari" | "voiceover" | "ios-app";
export const HELPER_KINDS: HelperKind[] = ["safari", "voiceover", "ios-app"];

export interface HelperSimulator {
  name: string;
  udid: string;
  runtime: string;
  type: "iphone" | "ipad";
}

/** What the Mac reports about itself when it connects. */
export interface HelperInfo {
  version: string;
  macos?: string;
  xcode?: string;
  safari?: string;
  /** The kinds of work this Mac can do now. */
  kinds: HelperKind[];
  /** Why a kind cannot run on this Mac, with the step that fixes it. */
  problems?: Partial<Record<HelperKind, string>>;
  simulators?: HelperSimulator[];
  /** iPhones and iPads connected to the Mac. */
  devices?: { name: string; udid: string; os?: string }[];
}

export interface Helper {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  lastSeen?: string;
  info?: HelperInfo;
}

/** A helper is online while it keeps asking for work (it asks at least every 30 seconds). */
export const ONLINE_MS = 75_000;
const TOKEN_PREFIX = "glvh_";
const MAX_ARTIFACTS = 60;
export const MAX_ARTIFACT_BYTES = 15_000_000;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class HelperStore {
  constructor(private db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS helpers (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL)");
  }

  /** A new helper and its token. The token is shown once; only its hash is kept. */
  create(name: string, createdBy: string): { helper: Helper; token: string } {
    const token = TOKEN_PREFIX + randomBytes(24).toString("base64url");
    const helper: Helper = { id: randomUUID(), name, createdAt: new Date().toISOString(), createdBy };
    this.db.prepare("INSERT INTO helpers (id, token_hash, data) VALUES (?, ?, ?)").run(helper.id, hashToken(token), JSON.stringify(helper));
    return { helper, token };
  }

  byToken(token: string): Helper | undefined {
    if (!token.startsWith(TOKEN_PREFIX) || token.length > 100) return undefined;
    const row = this.db.prepare("SELECT data FROM helpers WHERE token_hash = ?").get(hashToken(token)) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Helper) : undefined;
  }

  get(id: string): Helper | undefined {
    const row = this.db.prepare("SELECT data FROM helpers WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Helper) : undefined;
  }

  list(): Helper[] {
    return (this.db.prepare("SELECT data FROM helpers").all() as { data: string }[]).map((r) => JSON.parse(r.data) as Helper).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  save(h: Helper): void {
    this.db.prepare("UPDATE helpers SET data = ? WHERE id = ?").run(JSON.stringify(h), h.id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM helpers WHERE id = ?").run(id);
  }
}

/** What a helper is given for one job. */
export interface JobView {
  id: string;
  kind: HelperKind;
  params: Record<string, unknown>;
  /** The job has a file to download (the app to install). */
  file?: { name: string; size?: number };
}

export interface JobOutcome {
  data: unknown;
  /** Files the helper sent, by the name the report serves them under. */
  artifacts: { name: string; file: string }[];
}

interface Job extends JobView {
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  label: string;
  helperId?: string;
  filePath?: string;
  outDir: string;
  artifacts: { name: string; file: string }[];
  createdAt: number;
  startedAt?: number;
  runMs: number;
  log: (m: string) => void;
  resolve: (o: JobOutcome) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  cleanup: () => void;
}

export interface SubmitOptions {
  label: string;
  /** A file the helper downloads (the uploaded app). */
  file?: { path: string; name: string; size?: number };
  /** Where the helper's screenshots and logs go (the run's artifacts). */
  outDir: string;
  signal: AbortSignal;
  log: (m: string) => void;
  /** How long the job may wait for a free helper. */
  queueMs?: number;
  /** How long the helper may take once it has started. */
  runMs?: number;
}

export class HelperError extends Error {}

const clean = (s: unknown, max = 300) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .slice(0, max);

/** One per server: the jobs waiting for a Mac, and the Macs waiting for jobs. */
export class HelperHub {
  private store?: HelperStore;
  private jobs = new Map<string, Job>();
  private waiters = new Map<string, (job: JobView | null) => void>();
  private seen = new Map<string, number>();

  attach(store: HelperStore): void {
    this.store = store;
  }

  get helpers(): HelperStore | undefined {
    return this.store;
  }

  /** Marks a helper as seen (every request it makes), and saves it now and then. */
  touch(h: Helper): void {
    const now = Date.now();
    const last = this.seen.get(h.id) ?? (h.lastSeen ? Date.parse(h.lastSeen) : 0);
    this.seen.set(h.id, now);
    if (now - last > 60_000) this.store?.save({ ...(this.store.get(h.id) ?? h), lastSeen: new Date(now).toISOString() });
  }

  lastSeen(h: Helper): number {
    return this.seen.get(h.id) ?? (h.lastSeen ? Date.parse(h.lastSeen) : 0);
  }

  isOnline(h: Helper): boolean {
    return Date.now() - this.lastSeen(h) < ONLINE_MS;
  }

  hello(h: Helper, info: HelperInfo): Helper {
    const next = { ...(this.store?.get(h.id) ?? h), info, lastSeen: new Date().toISOString() };
    this.store?.save(next);
    this.seen.set(h.id, Date.now());
    // A helper that starts again has lost whatever it was doing.
    for (const j of this.jobs.values()) if (j.helperId === h.id && j.status === "running") this.fail(j, "The Mac helper restarted during the test.");
    return next;
  }

  /** Null when an online helper can do this kind of work, else why not and what fixes it. */
  status(kind: HelperKind): string | null {
    const all = this.store?.list() ?? [];
    if (!all.length) return "No Mac helper is paired with this server. The owner adds one in Owner panel > Mac helpers, then starts it on a Mac with Xcode.";
    const online = all.filter((h) => this.isOnline(h));
    if (!online.length) {
      const h = all.sort((a, b) => this.lastSeen(b) - this.lastSeen(a))[0];
      const seen = this.lastSeen(h);
      return `The Mac helper "${h.name}" is not connected${seen ? ` (last seen ${new Date(seen).toISOString().slice(0, 16).replace("T", " ")} UTC)` : " yet"}. Start it on the Mac: node glv-helper.mjs`;
    }
    if (online.some((h) => h.info?.kinds.includes(kind))) return null;
    const why = online.map((h) => h.info?.problems?.[kind]).find(Boolean);
    return why ? `The Mac helper cannot run this yet: ${why}` : "The connected Mac helper does not offer this test. Update it to the latest glv-helper.mjs.";
  }

  /** Sends work to a Mac and waits for the result. */
  run(kind: HelperKind, params: Record<string, unknown>, opts: SubmitOptions): Promise<JobOutcome> {
    const why = this.status(kind);
    if (why) return Promise.reject(new HelperError(why));
    opts.signal.throwIfAborted();
    return new Promise<JobOutcome>((resolve, reject) => {
      const id = randomUUID();
      const onAbort = () => {
        const j = this.jobs.get(id);
        if (j && (j.status === "queued" || j.status === "running")) {
          j.status = "cancelled";
          j.cleanup();
          reject(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Cancelled"));
        }
      };
      const queueTimer = setTimeout(() => {
        const j = this.jobs.get(id);
        if (j?.status === "queued") this.fail(j, `No Mac helper was free to start it within ${Math.round((opts.queueMs ?? 15 * 60_000) / 60_000)} minutes (it may be busy with another test, or asleep).`);
      }, opts.queueMs ?? 15 * 60_000);
      const job: Job = {
        id,
        kind,
        params,
        label: opts.label,
        ...(opts.file ? { file: { name: opts.file.name, ...(opts.file.size ? { size: opts.file.size } : {}) }, filePath: opts.file.path } : {}),
        status: "queued",
        outDir: opts.outDir,
        artifacts: [],
        createdAt: Date.now(),
        runMs: opts.runMs ?? 20 * 60_000,
        log: opts.log,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(queueTimer);
          if (job.timer) clearTimeout(job.timer);
          opts.signal.removeEventListener("abort", onAbort);
          // Finished jobs are forgotten after a while; a helper still sending for one is told it is over.
          setTimeout(() => this.jobs.delete(id), 10 * 60_000).unref();
        },
      };
      this.jobs.set(id, job);
      opts.signal.addEventListener("abort", onAbort, { once: true });
      opts.log(`${opts.label}: waiting for the Mac helper`);
      this.offer();
    });
  }

  /** Gives queued jobs to helpers that are waiting for work. */
  private offer(): void {
    for (const [helperId, wake] of this.waiters) {
      const h = this.store?.get(helperId);
      const job = h && this.pick(h);
      if (job) {
        this.waiters.delete(helperId);
        wake(job);
      }
    }
  }

  private pick(h: Helper): JobView | undefined {
    if ([...this.jobs.values()].some((j) => j.helperId === h.id && j.status === "running")) return undefined;
    const job = [...this.jobs.values()].filter((j) => j.status === "queued" && h.info?.kinds.includes(j.kind)).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return undefined;
    job.status = "running";
    job.helperId = h.id;
    job.startedAt = Date.now();
    job.timer = setTimeout(() => this.fail(job, `The Mac helper did not finish within ${Math.round(job.runMs / 60_000)} minutes.`), job.runMs);
    job.log(`${job.label}: started on the Mac "${h.name}"`);
    return { id: job.id, kind: job.kind, params: job.params, ...(job.file ? { file: job.file } : {}) };
  }

  /**
   * The helper asks for work: a job now, or one that arrives while it waits, or null. gone stops the
   * wait when the helper hangs up first, so no job is handed to a connection nobody reads.
   */
  next(h: Helper, waitMs: number, gone?: AbortSignal): Promise<JobView | null> {
    this.touch(h);
    const job = this.pick(this.store?.get(h.id) ?? h);
    if (job) return Promise.resolve(job);
    this.waiters.get(h.id)?.(null);
    return new Promise((resolve) => {
      const stop = () => {
        clearTimeout(timer);
        if (this.waiters.get(h.id) === done) this.waiters.delete(h.id);
        resolve(null);
      };
      const timer = setTimeout(stop, waitMs);
      const done = (j: JobView | null) => {
        clearTimeout(timer);
        gone?.removeEventListener("abort", stop);
        resolve(j);
      };
      gone?.addEventListener("abort", stop, { once: true });
      this.waiters.set(h.id, done);
    });
  }

  /** Puts a job back in the queue (it was handed to a helper that had already hung up). */
  requeue(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job?.status !== "running") return;
    if (job.timer) clearTimeout(job.timer);
    job.status = "queued";
    delete job.helperId;
    delete job.startedAt;
    this.offer();
  }

  /** A job the helper is running, or why it may not send for it. */
  private mine(h: Helper, jobId: string): Job | string {
    const job = this.jobs.get(jobId);
    if (!job || job.helperId !== h.id) return "unknown";
    if (job.status !== "running") return "over";
    return job;
  }

  progress(h: Helper, jobId: string, message: string): "ok" | "over" | "unknown" {
    this.touch(h);
    const job = this.mine(h, jobId);
    if (typeof job === "string") return job as "over" | "unknown";
    const m = clean(message, 200).trim();
    if (m) job.log(`${job.label}: ${m}`);
    return "ok";
  }

  fileOf(h: Helper, jobId: string): { path: string; name: string } | undefined {
    const job = this.mine(h, jobId);
    if (typeof job === "string" || !job.filePath || !job.file) return undefined;
    return { path: job.filePath, name: job.file.name };
  }

  /** Saves a screenshot or log the helper sent, into the run's artifacts. */
  async artifact(h: Helper, jobId: string, name: string, body: Buffer): Promise<string> {
    this.touch(h);
    const job = this.mine(h, jobId);
    if (typeof job === "string") throw new HelperError(job === "over" ? "The test is over." : "Unknown job.");
    if (!/^[a-z0-9][a-z0-9_-]{0,60}\.(png|jpg|txt|json)$/.test(name)) throw new HelperError("Bad file name.");
    if (job.artifacts.length >= MAX_ARTIFACTS) throw new HelperError("Too many files for one test.");
    if (!body.length || body.length > MAX_ARTIFACT_BYTES) throw new HelperError("The file is empty or too big.");
    const ext = name.split(".").pop();
    const looksRight =
      ext === "png"
        ? body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        : ext === "jpg"
          ? body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
          : ext === "json"
            ? (() => {
                try {
                  JSON.parse(body.toString("utf8"));
                  return true;
                } catch {
                  return false;
                }
              })()
            : !body.includes(0);
    if (!looksRight) throw new HelperError(`That is not a real .${ext} file.`);
    const file = `tool-${job.kind}-${name}`;
    await mkdir(job.outDir, { recursive: true });
    await writeFile(path.join(job.outDir, file), body);
    job.artifacts = [...job.artifacts.filter((a) => a.name !== name), { name, file }];
    return file;
  }

  result(h: Helper, jobId: string, body: { ok?: boolean; data?: unknown; error?: unknown }): "ok" | "over" | "unknown" {
    this.touch(h);
    const job = this.mine(h, jobId);
    if (typeof job === "string") return job as "over" | "unknown";
    if (body.ok === true) {
      job.status = "done";
      job.cleanup();
      job.log(`${job.label}: the Mac helper finished in ${((Date.now() - (job.startedAt ?? Date.now())) / 1000).toFixed(0)} s`);
      job.resolve({ data: body.data, artifacts: job.artifacts });
    } else this.fail(job, `The Mac helper could not run it: ${clean(body.error, 400) || "no reason given"}`);
    this.offer();
    return "ok";
  }

  private fail(job: Job, message: string): void {
    if (job.status !== "queued" && job.status !== "running") return;
    job.status = "failed";
    job.cleanup();
    job.reject(new HelperError(message));
    this.offer();
  }

  /** The job a helper is busy with, for the owner panel. */
  busy(h: Helper): { label: string; since: string } | undefined {
    const j = [...this.jobs.values()].find((x) => x.helperId === h.id && x.status === "running");
    return j ? { label: j.label, since: new Date(j.startedAt ?? j.createdAt).toISOString() } : undefined;
  }

  queued(): number {
    return [...this.jobs.values()].filter((j) => j.status === "queued").length;
  }

  remove(id: string): void {
    for (const j of this.jobs.values()) if (j.helperId === id) this.fail(j, "The Mac helper was removed from this server.");
    this.waiters.get(id)?.(null);
    this.waiters.delete(id);
    this.seen.delete(id);
    this.store?.delete(id);
  }

  /** Lets waiting helpers go (the server is stopping). */
  close(): void {
    for (const wake of this.waiters.values()) wake(null);
    this.waiters.clear();
  }
}

/** The one hub of this server. */
export const helperHub = new HelperHub();

/** Checks what a helper says about itself: known kinds, short strings, a few dozen simulators. */
export function cleanInfo(raw: unknown): HelperInfo {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kinds = Array.isArray(r.kinds) ? (r.kinds.filter((k) => HELPER_KINDS.includes(k as HelperKind)) as HelperKind[]) : [];
  const problems: Partial<Record<HelperKind, string>> = {};
  if (r.problems && typeof r.problems === "object") {
    for (const k of HELPER_KINDS) {
      const p = (r.problems as Record<string, unknown>)[k];
      if (typeof p === "string" && p) problems[k] = clean(p, 400);
    }
  }
  const sims = Array.isArray(r.simulators) ? r.simulators.slice(0, 60) : [];
  const devices = Array.isArray(r.devices) ? r.devices.slice(0, 20) : [];
  const opt = (v: unknown, max = 60) => (typeof v === "string" && v ? { value: clean(v, max) } : undefined);
  return {
    version: clean(r.version, 20) || "?",
    ...(opt(r.macos) ? { macos: opt(r.macos)!.value } : {}),
    ...(opt(r.xcode) ? { xcode: opt(r.xcode)!.value } : {}),
    ...(opt(r.safari) ? { safari: opt(r.safari)!.value } : {}),
    kinds: [...new Set(kinds)],
    ...(Object.keys(problems).length ? { problems } : {}),
    simulators: sims
      .map((s) => s as Record<string, unknown>)
      .filter((s) => typeof s.udid === "string" && /^[0-9A-F-]{36}$/i.test(s.udid) && (s.type === "iphone" || s.type === "ipad"))
      .map((s) => ({ name: clean(s.name, 60), udid: String(s.udid), runtime: clean(s.runtime, 40), type: s.type as "iphone" | "ipad" })),
    devices: devices
      .map((d) => d as Record<string, unknown>)
      .filter((d) => typeof d.udid === "string" && /^[0-9A-Za-z-]{8,64}$/.test(d.udid))
      .map((d) => ({ name: clean(d.name, 60), udid: String(d.udid), ...(typeof d.os === "string" ? { os: clean(d.os, 20) } : {}) })),
  };
}
