import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Out-of-band (blind) detection: GLV's own callback server. Many real holes never show in the
 * answer: the server fetches an address later (blind SSRF), a log line runs a lookup (Log4Shell), or
 * an admin opens a page with stored script (blind XSS). The attack agent puts a unique GLV address in
 * its payloads; when the client's server calls it, the hit lands here and proves the hole.
 *
 * Two ways in, both run by GLV (no outside service):
 * - HTTP: this server's own /oob/<token>/… route, reachable from the internet at OOB_BASE_URL
 *   (for example https://oob.glvinfotechsolutions.com, pointed at this server).
 * - DNS and more: a self-hosted Interactsh server (docker compose --profile oob) on a GLV domain,
 *   read with interactsh-client when INTERACTSH_SERVER is set.
 */

export interface OobHit {
  token: string;
  /** The payload's own label (which parameter or header it went in). */
  label: string;
  protocol: "http" | "dns" | "smtp" | "ldap" | "other";
  from: string;
  at: string;
  /** The first request line, or the DNS name asked for. */
  request: string;
}

interface Waiting {
  created: number;
  hits: OobHit[];
}

const tokens = new Map<string, Waiting>();
const TTL = 6 * 3600_000;
/** Late hits (an admin opened the page an hour later) are kept here for the report's re-test. */
const late: OobHit[] = [];

export function oobBase(): string | null {
  const b = process.env.OOB_BASE_URL?.trim().replace(/\/+$/, "");
  return b && /^https?:\/\//.test(b) ? b : null;
}

/** A new token, good for six hours. Its payload addresses are <base>/oob/<token>/<label>. */
export function newOobToken(): string {
  const now = Date.now();
  for (const [t, w] of tokens) if (now - w.created > TTL) tokens.delete(t);
  const t = randomBytes(10).toString("hex");
  tokens.set(t, { created: now, hits: [] });
  return t;
}

export const oobUrl = (base: string, token: string, label: string) => `${base}/oob/${token}/${encodeURIComponent(label)}`;

/** Records a call to /oob/<token>/<label>. Returns false for an unknown token (so the route can answer 404). */
export function recordOobHit(token: string, label: string, from: string, request: string, protocol: OobHit["protocol"] = "http"): boolean {
  const w = tokens.get(token);
  if (!w) return false;
  const hit: OobHit = { token, label: label.replace(/\.js$/, ""), protocol, from, at: new Date().toISOString(), request: request.slice(0, 300) };
  w.hits.push(hit);
  if (w.hits.length > 500) w.hits.shift();
  late.push(hit);
  if (late.length > 2000) late.shift();
  return true;
}

export const oobHits = (token: string): OobHit[] => [...(tokens.get(token)?.hits ?? [])];
export const lateHits = (since?: string): OobHit[] => late.filter((h) => !since || h.at >= since);

/** Waits until the token has hits, or the time is up (callbacks can take a few seconds). */
export async function waitForHits(token: string, ms: number, signal: AbortSignal, extra?: () => OobHit[]): Promise<OobHit[]> {
  const end = Date.now() + ms;
  for (;;) {
    signal.throwIfAborted();
    const all = [...oobHits(token), ...(extra?.() ?? [])];
    if (Date.now() >= end) return all;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

// ---------------------------------------------------------------------------------------------
// Interactsh (self-hosted): DNS, HTTP, SMTP and LDAP callbacks on a GLV domain

export interface InteractshSession {
  /** The session's own domain, such as c5a1….oast.glvinfotechsolutions.com. Payloads use <label>.<domain>. */
  domain: string;
  hits(): OobHit[];
  close(): void;
}

/** Reads one line of interactsh-client -json output into a hit, when it is one. */
export function readInteractshLine(line: string, domain: string): OobHit | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const j = JSON.parse(line) as { protocol?: string; "full-id"?: string; "unique-id"?: string; "remote-address"?: string; timestamp?: string; "raw-request"?: string; "q-type"?: string };
    const full = j["full-id"] ?? j["unique-id"] ?? "";
    const label = full.toLowerCase().endsWith(domain.toLowerCase()) ? full.slice(0, -domain.length - 1) : full.split(".")[0];
    const p = (j.protocol ?? "other").toLowerCase();
    return {
      token: domain,
      label: label.split(".")[0],
      protocol: (["http", "dns", "smtp", "ldap"].includes(p) ? p : "other") as OobHit["protocol"],
      from: j["remote-address"] ?? "",
      at: j.timestamp ?? new Date().toISOString(),
      request: (j["raw-request"] ?? `${j["q-type"] ?? ""} ${full}`).split("\n")[0].trim(),
    };
  } catch {
    return null;
  }
}

/** Starts interactsh-client against GLV's own Interactsh server, when one is set up. */
export async function startInteractsh(signal: AbortSignal, log: (m: string) => void): Promise<InteractshSession | null> {
  const server = process.env.INTERACTSH_SERVER?.trim();
  if (!server) return null;
  const bin = process.env.INTERACTSH_CLIENT_PATH || "interactsh-client";
  const args = ["-server", server, "-json", "-nc", "-poll-interval", "2", "-n", "1"];
  if (process.env.INTERACTSH_TOKEN) args.push("-token", process.env.INTERACTSH_TOKEN);
  let child: ChildProcess;
  try {
    child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
  const hits: OobHit[] = [];
  let domain = "";
  let buffer = "";
  const onLine = (line: string) => {
    if (!domain) {
      const m = line.match(/([a-z0-9]{20,}\.[a-z0-9.-]+\.[a-z]{2,})/i);
      if (m) domain = m[1].toLowerCase();
      return;
    }
    const hit = readInteractshLine(line, domain);
    if (hit) hits.push(hit);
  };
  const feed = (d: Buffer) => {
    buffer += d.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const l of lines) onLine(l);
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
  const close = () => child.kill("SIGTERM");
  signal.addEventListener("abort", close, { once: true });
  const end = Date.now() + 20_000;
  while (!domain && Date.now() < end && child.exitCode === null) await new Promise((ok) => setTimeout(ok, 250));
  if (!domain) {
    close();
    log("Blind checks: the Interactsh server did not answer, so only the HTTP callbacks are used");
    return null;
  }
  return { domain, hits: () => [...hits], close };
}
