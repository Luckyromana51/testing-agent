import type { ToolFinding } from "../tools/types.js";
import type { ResolvedConnection } from "./types.js";

/**
 * The client's Hostinger account, through Hostinger's own public API with the API token the client
 * made in hPanel. Only GET requests are ever sent: this file has no way to change, buy or delete
 * anything on the account.
 */

export const hostingerBase = (env: NodeJS.ProcessEnv = process.env) => (env.HOSTINGER_API_URL || "https://developers.hostinger.com").replace(/\/+$/, "");

export class HostingerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** One read-only call. */
export async function hostingerGet<T = unknown>(token: string, pathname: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  if (!pathname.startsWith("/api/")) throw new HostingerError("Bad Hostinger path.");
  let res: Response;
  try {
    res = await fetch(`${hostingerBase(env)}${pathname}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "GLVTestingAgent/0.2" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw new HostingerError(`Hostinger's API did not answer: ${(err as Error).message}`);
  }
  if (res.status === 401) throw new HostingerError("Hostinger did not accept the API token. Make a new one in hPanel > Profile > API.", 401);
  if (res.status === 403) throw new HostingerError("The API token may not read this part of the account.", 403);
  if (res.status === 429) throw new HostingerError("Hostinger asked us to slow down. Try again in a minute.", 429);
  if (!res.ok) throw new HostingerError(`Hostinger answered ${res.status}.`, res.status);
  return (await res.json()) as T;
}

/** Lists come either as an array or as { data: [...] }. */
const listOf = (v: unknown): Record<string, unknown>[] => {
  const arr = Array.isArray(v) ? v : Array.isArray((v as { data?: unknown })?.data) ? (v as { data: unknown[] }).data : [];
  return arr.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
};

/** A part of the account the token cannot read is left out (with a note), the rest still counts. */
async function tryList(token: string, pathname: string, notes: string[], label: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<Record<string, unknown>[] | undefined> {
  try {
    return listOf(await hostingerGet(token, pathname, signal, env));
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    if (err instanceof HostingerError && err.status === 401) throw err;
    notes.push(`${label}: ${(err as Error).message}`);
    return undefined;
  }
}

export interface HostingerAccount {
  servers: { id: number; name: string; ip: string; state: string; firewall?: unknown; raw: Record<string, unknown> }[];
  websites: { domain: string; enabled: boolean }[];
  domains: { domain: string; status: string; expiresAt?: string; raw: Record<string, unknown> }[];
  notes: string[];
}

export async function readAccount(token: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<HostingerAccount> {
  const notes: string[] = [];
  const vms = await tryList(token, "/api/vps/v1/virtual-machines", notes, "Servers (VPS)", signal, env);
  const sites = await tryList(token, "/api/hosting/v1/websites", notes, "Websites", signal, env);
  const doms = await tryList(token, "/api/domains/v1/portfolio", notes, "Domains", signal, env);
  if (!vms && !sites && !doms) throw new HostingerError(`The token could not read any part of the account. ${notes.join(" ")}`);
  return {
    servers: (vms ?? []).map((v) => {
      const ipv4 = Array.isArray(v.ipv4) ? (v.ipv4 as { address?: string }[])[0]?.address : undefined;
      return { id: Number(v.id), name: String(v.hostname ?? v.id), ip: String(ipv4 ?? ""), state: String(v.state ?? "unknown"), firewall: v.firewall_group_id, raw: v };
    }),
    websites: (sites ?? []).map((w) => ({ domain: String(w.domain ?? ""), enabled: w.is_enabled !== false })).filter((w) => w.domain),
    domains: (doms ?? []).map((d) => ({ domain: String(d.domain ?? ""), status: String(d.status ?? ""), ...(typeof d.expires_at === "string" ? { expiresAt: d.expires_at } : {}), raw: d })).filter((d) => d.domain),
    notes,
  };
}

/** For the connection's Test button. */
export async function testHostinger(c: ResolvedConnection, signal?: AbortSignal, env?: NodeJS.ProcessEnv) {
  if (!c.secret.token) throw new HostingerError("No Hostinger API token is saved.");
  const a = await readAccount(c.secret.token, signal, env);
  return {
    message: `Connected: ${a.servers.length} server${a.servers.length === 1 ? "" : "s"}, ${a.websites.length} website${a.websites.length === 1 ? "" : "s"}, ${a.domains.length} domain${a.domains.length === 1 ? "" : "s"}`,
    details: [
      ...a.servers.map((s) => `Server ${s.name}${s.ip ? ` (${s.ip})` : ""}: ${s.state}`),
      ...a.websites.slice(0, 30).map((w) => `Website ${w.domain}${w.enabled ? "" : " (suspended)"}`),
      ...a.domains.slice(0, 30).map((d) => `Domain ${d.domain}: ${d.status}${d.expiresAt ? `, ends ${d.expiresAt.slice(0, 10)}` : ""}`),
      ...a.notes,
    ],
    sites: a.websites.filter((w) => w.enabled).map((w) => `https://${w.domain}/`),
    servers: a.servers.filter((s) => s.ip).map((s) => ({ name: s.name, ip: s.ip })),
  };
}

const DAY = 86_400_000;
const MAX_DETAIL = 20;

/** Reads the account and turns what needs care into findings. */
export async function hostingerFindings(c: ResolvedConnection, opts: { signal?: AbortSignal; now?: number; env?: NodeJS.ProcessEnv; domains?: string[] }): Promise<{ findings: ToolFinding[]; summary: string[]; table: { title: string; columns: string[]; rows: string[][] } }> {
  if (!c.secret.token) throw new HostingerError("No Hostinger API token is saved.");
  const token = c.secret.token;
  const now = opts.now ?? Date.now();
  const a = await readAccount(token, opts.signal, opts.env);
  const findings: ToolFinding[] = [];
  const add = (f: ToolFinding) => findings.push(f);
  const rows: string[][] = [];

  for (const s of a.servers.slice(0, MAX_DETAIL)) {
    const where = `hostinger://vps/${s.name}`;
    rows.push(["Server", s.name, s.state, s.ip]);
    if (s.state !== "running") {
      add({ category: "functional", severity: s.state === "stopped" ? "high" : "medium", rule: "hostinger:vps-not-running", title: `Server ${s.name} is ${s.state}`, detail: "The server is not running, so whatever it hosts is down. Start it in hPanel, or remove it if it is no longer used.", pageUrl: where, evidence: `state: ${s.state}` });
    }
    if ("firewall_group_id" in s.raw && !s.firewall) {
      add({ category: "security", severity: "medium", rule: "hostinger:vps-no-firewall", title: `Server ${s.name} has no Hostinger firewall`, detail: "Every port the server opens is reachable from the internet. Add a firewall in hPanel > VPS > Firewall that lets in only the ports the site needs (80, 443 and SSH).", pageUrl: where, evidence: "firewall_group_id: null" });
    }
    if (Number.isFinite(s.id)) {
      const backups = await tryList(token, `/api/vps/v1/virtual-machines/${s.id}/backups`, a.notes, `Backups of ${s.name}`, opts.signal, opts.env);
      if (backups && backups.length === 0) {
        add({ category: "functional", severity: "medium", rule: "hostinger:vps-no-backups", title: `Server ${s.name} has no backups`, detail: "If the server breaks or is hacked there is nothing to go back to. Turn on backups in hPanel, or keep your own copies off the server.", pageUrl: where });
      }
    }
  }

  const soon = (iso?: string) => (iso ? (Date.parse(iso) - now) / DAY : Infinity);
  for (const d of a.domains.slice(0, 200)) {
    const days = soon(d.expiresAt);
    rows.push(["Domain", d.domain, d.status, d.expiresAt ? d.expiresAt.slice(0, 10) : ""]);
    const where = `hostinger://domain/${d.domain}`;
    if (/expired/i.test(d.status) || days < 0) {
      add({ category: "functional", severity: "critical", rule: "hostinger:domain-expired", title: `The domain ${d.domain} has expired`, detail: "Sites and email on this domain stop working, and someone else may register it. Renew it in hPanel now.", pageUrl: where, evidence: d.expiresAt ?? d.status });
    } else if (days <= 30) {
      add({ category: "functional", severity: "high", rule: "hostinger:domain-expiring", title: `The domain ${d.domain} ends in ${Math.ceil(days)} days`, detail: "Renew it, or turn on auto-renew in hPanel, so the site and email do not stop.", pageUrl: where, evidence: d.expiresAt });
    } else if (days <= 60) {
      add({ category: "functional", severity: "medium", rule: "hostinger:domain-expiring", title: `The domain ${d.domain} ends in ${Math.ceil(days)} days`, detail: "Check that auto-renew is on and the payment card is valid.", pageUrl: where, evidence: d.expiresAt });
    }
  }

  // Email protection for the domains whose DNS Hostinger runs (the active ones, or those being tested).
  const dnsDomains = [...new Set([...(opts.domains ?? []), ...a.domains.filter((d) => /active/i.test(d.status)).map((d) => d.domain)])].slice(0, MAX_DETAIL);
  for (const domain of dnsDomains) {
    const zone = await tryList(token, `/api/dns/v1/zones/${encodeURIComponent(domain)}`, a.notes, `DNS of ${domain}`, opts.signal, opts.env);
    if (!zone) continue;
    const txt = (name: string) =>
      zone
        .filter((r) => String(r.type).toUpperCase() === "TXT" && String(r.name ?? "@").replace(/\.$/, "") === name)
        .flatMap((r) => (Array.isArray(r.records) ? (r.records as { content?: string }[]).map((x) => String(x.content ?? "")) : [String(r.content ?? "")]));
    const where = `hostinger://dns/${domain}`;
    if (!txt("@").some((t) => /v=spf1/i.test(t))) {
      add({ category: "security", severity: "medium", rule: "hostinger:dns-no-spf", title: `${domain} has no SPF record`, detail: `Anyone can send email that looks like it comes from @${domain}, and real mail lands in spam more often. Add a TXT record on @ such as "v=spf1 include:_spf.mail.hostinger.com ~all" (with the services that really send your mail).`, pageUrl: where });
    }
    if (!txt("_dmarc").some((t) => /v=DMARC1/i.test(t))) {
      add({ category: "security", severity: "medium", rule: "hostinger:dns-no-dmarc", title: `${domain} has no DMARC record`, detail: `Mail servers are not told what to do with fake mail from @${domain}. Add a TXT record on _dmarc such as "v=DMARC1; p=quarantine; rua=mailto:dmarc@${domain}".`, pageUrl: where });
    }
  }

  for (const w of a.websites) rows.push(["Website", w.domain, w.enabled ? "on" : "suspended", ""]);
  return {
    findings,
    summary: [`${a.servers.length} servers, ${a.websites.length} websites, ${a.domains.length} domains read (read-only)`, ...a.notes.slice(0, 5)],
    table: { title: "Hostinger account", columns: ["Kind", "Name", "State", "Address or end date"], rows: rows.slice(0, 300) },
  };
}
