import { sshRun, sshSession } from "../connections/ssh.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Chaos testing on the client's server, the way Chaos Mesh, Pumba and Toxiproxy experiments work but
 * through the SSH connection: one controlled fault at a time (restart a service, stop it for a short
 * time, add network delay with tc for a short time), while GLV opens the site every two seconds and
 * measures how long it is down and whether it comes back by itself. Every fault undoes itself (the
 * stop and the delay end after the chosen seconds, even if GLV's connection drops). It causes an
 * outage, so it runs only with written permission that allows changes, on the permitted host, and
 * only when someone starts it (best on a test copy).
 */

export const FAULTS = ["restart", "stop", "delay"] as const;
export type Fault = (typeof FAULTS)[number];

/** The command for a fault; each one undoes itself after `seconds`. Pure, for tests. */
export function faultCommand(fault: Fault, service: string, seconds: number): string {
  if (!/^[a-zA-Z0-9@._-]{1,80}$/.test(service)) throw new Error("Service names may only have letters, digits and @ . _ -");
  const s = Math.max(5, Math.min(seconds, 120));
  if (fault === "restart") return `sudo -n systemctl restart ${service}`;
  if (fault === "stop") return `sudo -n systemctl stop ${service} && (nohup sh -c 'sleep ${s}; sudo -n systemctl start ${service}' >/dev/null 2>&1 &) && echo stopped`;
  // Delay: 300 ms added on the default interface, removed after the time even if this session ends.
  return `dev=$(ip route show default | awk '{print $5; exit}'); sudo -n tc qdisc add dev "$dev" root netem delay 300ms 50ms && (nohup sh -c "sleep ${s}; sudo -n tc qdisc del dev $dev root netem" >/dev/null 2>&1 &) && echo delayed`;
}

export interface Probe {
  at: number;
  ok: boolean;
  ms: number;
  status: number;
}

/** Downtime and recovery from the probes taken during the fault. Pure, for tests. */
export function recovery(probes: Probe[], faultAt: number): { downMs: number; recovered: boolean; slowest: number; errors: number } {
  const after = probes.filter((p) => p.at >= faultAt);
  let downStart: number | null = null;
  let downMs = 0;
  for (const p of after) {
    if (!p.ok && downStart === null) downStart = p.at;
    if (p.ok && downStart !== null) {
      downMs += p.at - downStart;
      downStart = null;
    }
  }
  const last = after.at(-1);
  if (downStart !== null && last) downMs += last.at - downStart;
  return { downMs, recovered: Boolean(last?.ok), slowest: Math.max(0, ...after.map((p) => p.ms)), errors: after.filter((p) => !p.ok).length };
}

export const chaosTool: Tool = {
  id: "chaos",
  name: "Chaos test on the server",
  maker: "GLV Infotech (built in), in the way of Chaos Mesh and Pumba",
  description:
    "One controlled fault on the client's server over its SSH connection (restart or briefly stop a service such as nginx, php-fpm or mysql, or add network delay), while the site is opened every two seconds: how long it is down, whether it comes back by itself, and what visitors see meanwhile. Each fault undoes itself. Causes an outage: only with permission that allows changes, best on a test copy.",
  checks: ["Downtime and self-recovery after a service restart or stop", "Error pages visitors see while a service is down", "Slowness under 300 ms added network delay", "Faults undo themselves after the chosen seconds"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api"],
  category: "performance",
  safety: "permission",
  permission: "attack",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://chaos-mesh.org",
  signedIn: "public",
  needsConnection: "ssh",
  manual: true,
  options: [
    { id: "fault", label: "Fault", choices: [{ value: "restart", label: "Restart a service" }, { value: "stop", label: "Stop a service for a while" }, { value: "delay", label: "Add 300 ms network delay for a while" }], default: "restart" },
    { id: "service", label: "Service", kind: "text", pattern: "^[a-zA-Z0-9@._-]{0,80}$", placeholder: "php8.3-fpm", hint: "The systemd name (nginx, apache2, php8.3-fpm, mysql, redis-server). The SSH user needs sudo without a password for systemctl and tc.", choices: [], default: "nginx" },
    { id: "seconds", label: "How long (stop and delay)", choices: ["15", "30", "60"].map((v) => ({ value: v, label: `${v} seconds` })), default: "30" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit?.writes) throw new Error("A chaos test causes an outage, so it needs the client's written permission that allows changes.");
    const c = ctx.connections?.find((x) => x.kind === "ssh");
    if (!c) throw new Error("This project has no SSH connection. Add one on the Connections tab.");
    const siteHost = new URL(ctx.startUrl).hostname.toLowerCase();
    if (!permit.hosts.map((h) => h.toLowerCase()).includes(siteHost)) throw new Error(`${siteHost} is not in the client's permission.`);
    const fault = (FAULTS as readonly string[]).includes(ctx.options.fault) ? (ctx.options.fault as Fault) : "restart";
    const service = ctx.options.service || "nginx";
    const seconds = Number(ctx.options.seconds) || 30;
    const command = faultCommand(fault, service, seconds);
    const probes: Probe[] = [];
    let stop = false;
    const watch = (async () => {
      while (!stop && !ctx.signal.aborted) {
        const at = Date.now();
        try {
          const r = await fetch(ctx.startUrl, { redirect: "manual", signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]) });
          await r.arrayBuffer().catch(() => undefined);
          probes.push({ at, ok: r.status < 500, ms: Date.now() - at, status: r.status });
        } catch {
          probes.push({ at, ok: false, ms: Date.now() - at, status: 0 });
        }
        await new Promise((ok) => setTimeout(ok, 2000));
      }
    })();
    const session = await sshSession(c, { workDir: ctx.workDir, dataDir: ctx.dataDir ?? ctx.workDir });
    let faultAt = 0;
    let said = "";
    try {
      await new Promise((ok) => setTimeout(ok, 6000)); // a baseline first
      faultAt = Date.now();
      ctx.log(`Chaos: ${fault} ${service}`);
      said = await sshRun(session, command, ctx.signal, 60_000).catch((e: Error) => `failed: ${e.message}`);
      if (/failed|sudo: a password is required|not permitted|Operation not permitted/i.test(said)) throw new Error(`The fault could not be started: ${said.trim().slice(0, 200)}. The SSH user needs passwordless sudo for systemctl (and tc for delay).`);
      await new Promise((ok) => setTimeout(ok, (fault === "restart" ? 30 : seconds + 30) * 1000));
    } finally {
      stop = true;
      await watch;
      await session.cleanup();
    }
    const base = probes.filter((p) => p.at < faultAt);
    const baseMs = base.length ? Math.max(...base.map((p) => p.ms)) : 0;
    const r = recovery(probes, faultAt);
    const findings: ToolFinding[] = [];
    const where = ctx.startUrl;
    if (!r.recovered)
      findings.push({ category: "performance", rule: "chaos:no-recovery", severity: "critical", title: `The site did not come back after ${fault === "restart" ? "restarting" : fault === "stop" ? "stopping" : "slowing"} ${service}`, detail: `${Math.round(r.downMs / 1000)} s after the fault ended it was still down. Make the service restart by itself (systemd Restart=always), check its start-up errors (journalctl -u ${service}), and add a health check that pages someone.`, pageUrl: where, evidence: `${fault} ${service}; last answers: ${probes.slice(-3).map((p) => p.status || "none").join(", ")}`, key: `chaos:${fault}:${service}` });
    else if (fault === "restart" && r.downMs > 10_000)
      findings.push({ category: "performance", rule: "chaos:slow-recovery", severity: "medium", title: `The site was down ${Math.round(r.downMs / 1000)} s while ${service} restarted`, detail: `A restart (as during every update) takes the site down for ${Math.round(r.downMs / 1000)} s. Use reload instead of restart where the service supports it, run two instances behind the proxy, or show a maintenance page from the proxy.`, pageUrl: where, evidence: `${r.errors} failed checks out of ${probes.length}`, key: `chaos:slow:${service}` });
    if (fault === "stop" && r.errors && probes.some((p) => p.at >= faultAt && p.status >= 500 && p.status !== 503))
      findings.push({ category: "functional", rule: "chaos:raw-error-page", severity: "low", title: `Visitors see raw ${probes.find((p) => p.at >= faultAt && p.status >= 500)?.status} errors while ${service} is down`, detail: "Serve a friendly 503 maintenance page from the web server (with Retry-After) when the app behind it is down.", pageUrl: where, evidence: probes.filter((p) => p.at >= faultAt && !p.ok).map((p) => p.status).slice(0, 10).join(", "), key: `chaos:errorpage:${service}` });
    if (fault === "delay" && r.slowest > Math.max(5000, baseMs * 5))
      findings.push({ category: "performance", rule: "chaos:delay-amplified", severity: "medium", title: `300 ms of network delay made pages take ${(r.slowest / 1000).toFixed(1)} s`, detail: "A small delay on the server's network made the page many times slower: it probably makes many calls one after another (database or API). Batch them, add caching and timeouts.", pageUrl: where, evidence: `Normal ${baseMs} ms, with delay up to ${r.slowest} ms`, key: "chaos:delay" });
    return {
      findings,
      summary: [`${fault} ${service}: down ${Math.round(r.downMs / 1000)} s, ${r.recovered ? "came back by itself" : "did not come back"}; slowest answer ${r.slowest} ms (normal ${baseMs} ms)`],
      tested: `${fault} of ${service} on ${c.host}`,
      table: { title: "Site checks every 2 s", columns: ["Time", "Status", "Answer time"], rows: probes.map((p) => [`${Math.round((p.at - (faultAt || p.at)) / 1000)} s`, String(p.status || "none"), `${p.ms} ms`]) },
    };
  },
};
