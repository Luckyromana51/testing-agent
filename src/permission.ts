import { randomBytes, randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { validateTarget } from "./runner/urls.js";

/**
 * Load and attack tests send far more than a visitor would: thousands of requests, or payloads
 * made to break the site. They run only on addresses the client has allowed in writing, for a
 * set period and within set limits, and only while the client keeps a proof file (or DNS record)
 * on each address. The owner records the permission; every test checks it again before it starts.
 */

export type PermissionKind = "load" | "attack" | "changes";

export const PERMISSION_KINDS: Record<PermissionKind, string> = {
  load: "Load tests (many users at once)",
  attack: "Attack tests (security scans that try to break in)",
  changes: "Checks that change data (account lockout, file uploads, mass assignment, forms)",
};

export interface Proof {
  method: "file" | "dns";
  at: string;
}

export interface Permission {
  id: string;
  /** Host names (with a port when not the usual one) it covers, exactly: www.example.com is not example.com. */
  hosts: string[];
  kinds: PermissionKind[];
  /** Who at the client gave permission, and their role: "Ravi Kumar, CTO of Acme". */
  grantedBy: string;
  /** Where the written permission is kept: "Email of 18 Nov 2026" or "Work order WO-12". */
  reference: string;
  /** The client allows requests that create or change data (POST, PUT, DELETE) in uploaded test plans. */
  writes: boolean;
  /** Most virtual users at once in a load test. */
  maxUsers: number;
  /** Longest load test or attack scan, in minutes. */
  maxMinutes: number;
  /** When it starts and ends (ISO times). */
  from: string;
  until: string;
  /** The line the client puts in the proof file or DNS record: "glv-testing=…". */
  token: string;
  /** Which hosts have shown the token, and how. */
  proofs: Record<string, Proof>;
  createdBy: string;
  createdAt: string;
  revokedBy?: string;
  revokedAt?: string;
}

export type PermissionStatus = "active" | "waiting-proof" | "scheduled" | "expired" | "revoked";

/** Where the proof file goes on each host. */
export const PROOF_PATH = "/.well-known/glv-testing.txt";
/** The DNS name of the TXT record, in front of the host name. */
export const PROOF_DNS = "_glv-testing";

export const LIMITS = { maxUsers: 1000, maxMinutes: 120, maxDays: 90, hosts: 10 };

export function permissionStatus(p: Permission, now = Date.now()): PermissionStatus {
  if (p.revokedAt) return "revoked";
  if (Date.parse(p.until) < now) return "expired";
  if (p.hosts.some((h) => !p.proofs[h])) return "waiting-proof";
  if (Date.parse(p.from) > now) return "scheduled";
  return "active";
}

/** "www.example.com" or "127.0.0.1:4000" from what the owner typed (an address or a host). */
export function hostOf(raw: string): string {
  const text = raw.trim();
  if (!text) throw new Error("Add the site's address.");
  let u: URL;
  try {
    u = new URL(/^[a-z][\w+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`"${text}" is not a site address.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`"${text}" is not a web address.`);
  if (u.username || u.password) throw new Error(`"${text}" should not hold a user name or password.`);
  if (u.hostname.startsWith("*") || u.hostname.includes("*")) throw new Error("Each address must be one exact host: no wildcards.");
  if (!u.hostname.includes(".") && u.hostname !== "localhost") throw new Error(`"${text}" is not a full host name.`);
  return u.host.toLowerCase();
}

export interface PermissionInput {
  hosts?: unknown;
  kinds?: unknown;
  grantedBy?: unknown;
  reference?: unknown;
  writes?: unknown;
  maxUsers?: unknown;
  maxMinutes?: unknown;
  from?: unknown;
  until?: unknown;
  /** The owner confirms they hold the client's written permission. */
  confirm?: unknown;
}

const text = (v: unknown, label: string, min = 3) => {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (s.length < min) throw new Error(`${label} is needed.`);
  return s.slice(0, 300);
};

const whole = (v: unknown, label: string, max: number) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${label} must be a whole number above 0.`);
  if (n > max) throw new Error(`${label} can be at most ${max}.`);
  return n;
};

/** Checks what the owner entered and makes a new permission, waiting for its proof. */
export function buildPermission(b: PermissionInput, by: string, now = Date.now()): Permission {
  if (b.confirm !== true) throw new Error("Confirm that the client gave this permission in writing.");
  const rawHosts = Array.isArray(b.hosts) ? b.hosts : typeof b.hosts === "string" ? b.hosts.split(/[\s,]+/) : [];
  const hosts = [...new Set(rawHosts.filter((h): h is string => typeof h === "string" && h.trim() !== "").map(hostOf))];
  if (!hosts.length) throw new Error("Add at least one site address.");
  if (hosts.length > LIMITS.hosts) throw new Error(`At most ${LIMITS.hosts} addresses in one permission.`);
  // The platform's own rule on which addresses it may test (no private networks unless allowed).
  for (const h of hosts) validateTarget(`https://${h}/`);
  const kinds = (Array.isArray(b.kinds) ? b.kinds : []).filter((k): k is PermissionKind => k === "load" || k === "attack" || k === "changes");
  if (!kinds.length) throw new Error("Choose what the client allows: load tests, attack tests, checks that change data, or more than one.");
  const from = Date.parse(String(b.from ?? ""));
  const until = Date.parse(String(b.until ?? ""));
  if (Number.isNaN(from) || Number.isNaN(until)) throw new Error("Set the first and last day of the permission.");
  if (until <= from) throw new Error("The last day must come after the first day.");
  if (until < now) throw new Error("That period is already over.");
  if (until - from > LIMITS.maxDays * 86_400_000) throw new Error(`A permission can last at most ${LIMITS.maxDays} days. Add a new one after that.`);
  return {
    id: randomUUID(),
    hosts,
    kinds: [...new Set(kinds)],
    grantedBy: text(b.grantedBy, "Who gave permission"),
    reference: text(b.reference, "Where the written permission is kept"),
    writes: b.writes === true,
    maxUsers: whole(b.maxUsers, "Most users at once", LIMITS.maxUsers),
    maxMinutes: whole(b.maxMinutes, "Longest test in minutes", LIMITS.maxMinutes),
    from: new Date(from).toISOString(),
    until: new Date(until).toISOString(),
    token: `glv-testing=${randomBytes(16).toString("hex")}`,
    proofs: {},
    createdBy: by,
    createdAt: new Date(now).toISOString(),
  };
}

export interface ProofCheck {
  host: string;
  ok: boolean;
  method?: "file" | "dns";
  /** Why it failed, in plain words. */
  error?: string;
}

/** True when a text holds the token as a whole line (a proof file may hold other lines too). */
export const holdsToken = (body: string, token: string) => body.split(/\r?\n/).some((l) => l.trim() === token);

async function fileProof(host: string, token: string, signal?: AbortSignal): Promise<string | null> {
  let lastError = "";
  // https first; plain http for sites (often internal staging) that have no https.
  for (const scheme of ["https", "http"]) {
    let url = `${scheme}://${host}${PROOF_PATH}`;
    try {
      validateTarget(url);
      // Same-host redirects only (http to https, a trailing slash): the proof must be on this host.
      for (let hop = 0; hop < 4; hop++) {
        const res = await fetch(url, {
          redirect: "manual",
          headers: { "user-agent": "GLV-Testing-Agent (permission check)" },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel();
          const next = new URL(location, url);
          if (next.host.toLowerCase() !== host) return `${url} sends visitors to another host (${next.host}); the file must be on ${host} itself.`;
          url = next.toString();
          continue;
        }
        if (res.status === 404) {
          await res.body?.cancel();
          lastError = `${scheme}://${host}${PROOF_PATH} was not found (404).`;
          break;
        }
        if (!res.ok) {
          await res.body?.cancel();
          lastError = `${url} answered ${res.status}.`;
          break;
        }
        const body = (await res.text()).slice(0, 10_000);
        if (holdsToken(body, token)) return null;
        lastError = `${url} is there but does not hold this permission's line.`;
        break;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      if (!lastError) lastError = `${scheme}://${host} did not answer (${(err as Error).message}).`;
    }
  }
  return lastError || `The file was not found on ${host}.`;
}

async function dnsProof(host: string, token: string): Promise<string | null> {
  const name = host.replace(/:\d+$/, "");
  if (/^[\d.]+$/.test(name) || name.includes(":") || name === "localhost") return "An IP address or localhost has no DNS record to check.";
  try {
    const records = await dns.resolveTxt(`${PROOF_DNS}.${name}`);
    return records.some((r) => r.join("").trim() === token) ? null : `The TXT record ${PROOF_DNS}.${name} does not hold this permission's line.`;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? `No TXT record at ${PROOF_DNS}.${name}.` : `DNS lookup failed (${code ?? (err as Error).message}).`;
  }
}

/** Looks for the token on one host: the proof file first, then the DNS record. */
export async function checkProof(host: string, token: string, signal?: AbortSignal): Promise<ProofCheck> {
  const file = await fileProof(host, token, signal);
  if (!file) return { host, ok: true, method: "file" };
  const record = await dnsProof(host, token);
  if (!record) return { host, ok: true, method: "dns" };
  return { host, ok: false, error: `${file} ${record}` };
}

/** Checks every host of a permission and records the ones that show the token. */
export async function verifyPermission(p: Permission, now = Date.now()): Promise<{ permission: Permission; checks: ProofCheck[] }> {
  const checks = await Promise.all(p.hosts.map((h) => checkProof(h, p.token)));
  const proofs = { ...p.proofs };
  for (const c of checks) {
    if (c.ok) proofs[c.host] = { method: c.method!, at: new Date(now).toISOString() };
    else delete proofs[c.host];
  }
  return { permission: { ...p, proofs }, checks };
}

const hostOfUrl = (u: string) => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
};

export interface Permit {
  permission: Permission;
  /** The addresses the test may use: only those on the permission's hosts. */
  urls: string[];
  /** Hosts of the test that the permission does not cover. */
  outside: string[];
}

/**
 * The permission a load or attack test runs under, for the addresses it would use: active,
 * of the right kind, and covering the test's own host. Returns why not, in plain words, when
 * there is none.
 */
export function permitFor(permissions: Permission[] | undefined, kind: PermissionKind, urls: string[], now = Date.now()): Permit | string {
  const list = (permissions ?? []).filter((p) => p.kinds.includes(kind));
  const hosts = [...new Set(urls.map(hostOfUrl).filter(Boolean))];
  const what = kind === "load" ? "load tests" : kind === "attack" ? "attack tests" : "checks that change data";
  if (!list.length) return `No permission from the client for ${what}. The owner adds it on the project page.`;
  const usable = list.filter((p) => permissionStatus(p, now) === "active");
  const covering = usable.filter((p) => p.hosts.some((h) => hosts.includes(h)));
  if (!covering.length) {
    if (usable.length) {
      return `The permission for ${what} covers ${usable.flatMap((p) => p.hosts).join(", ")}, but this test reached ${hosts.join(", ") || "no pages"}. Add that address to a new permission.`;
    }
    const latest = list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const status = permissionStatus(latest, now);
    if (status === "revoked") return `The permission for ${what} was withdrawn on ${latest.revokedAt!.slice(0, 10)}.`;
    if (status === "expired") return `The permission for ${what} ended on ${latest.until.slice(0, 10)}.`;
    if (status === "scheduled") return `The permission for ${what} starts on ${latest.from.slice(0, 10)}.`;
    return `The permission for ${what} is waiting for its proof file on ${latest.hosts.filter((h) => !latest.proofs[h]).join(", ")}.`;
  }
  // The newest permission wins when two cover the same host.
  const permission = covering.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    permission,
    urls: urls.filter((u) => permission.hosts.includes(hostOfUrl(u))),
    outside: hosts.filter((h) => !permission.hosts.includes(h)),
  };
}

/** A usable permission of this kind for any of the project's hosts, now or later (for choosing tools). */
export function hasPermission(permissions: Permission[] | undefined, kind: PermissionKind, now = Date.now()): Permission | undefined {
  return (permissions ?? [])
    .filter((p) => p.kinds.includes(kind) && !p.revokedAt && Date.parse(p.until) >= now)
    .sort((a, b) => b.maxUsers - a.maxUsers)[0];
}

/**
 * Whether a signed-in app test may run the checks that change data (account lockout, test file
 * uploads, mass assignment, forgot password, forms filled by Claude). Yes on a project marked as a
 * test copy; on anything else only under the client's written "changes" permission, with its proof
 * file on the host. Scheduled tests never change data.
 */
export function writeConsent(
  target: { url?: string; testServer?: boolean },
  permissions: Permission[] | undefined,
  trigger: "manual" | "schedule" | "retest" | undefined,
  now = Date.now(),
): { allowed: boolean; testCopy?: boolean; why: string } {
  if (trigger === "schedule") return { allowed: false, why: "Scheduled tests never change data: start a test by hand to run these checks." };
  if (target.testServer) return { allowed: true, testCopy: true, why: "The project is marked as a test copy, so the test may change data (and cleans up after itself)." };
  if (!target.url) return { allowed: false, why: "No address to check a permission for." };
  const permit = permitFor(permissions, "changes", [target.url], now);
  if (typeof permit === "string") {
    return { allowed: false, why: `${permit} Or, for a staging or test copy, tick "This is a test copy" on the project's Signed-in app tab.` };
  }
  return { allowed: true, why: `The client allowed checks that change data in writing: ${permit.permission.grantedBy} (${permit.permission.reference}), until ${permit.permission.until.slice(0, 10)}.` };
}
