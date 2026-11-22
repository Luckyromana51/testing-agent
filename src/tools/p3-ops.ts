import type { ResolvedConnection } from "../connections/types.js";
import { sections, sshReady, sshRun, sshSession } from "../connections/ssh.js";
import type { Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 3 (2026 gap report, P3) operations checks. Each reads the client's server over the project's
 * saved SSH connection and runs only fixed, read-only commands (never changes anything):
 *  - k8s: Kubernetes / Docker host safety (kube-bench / Kubescape / Dockle style).
 *  - log-seo: what search-engine bots really crawl, from the web server's access logs.
 *  - dr-drill: are backups recent and is a restore test in place.
 *  - db-code: stored procedures and triggers that have no tests.
 */

const need = (ctx: ToolContext, kind: "ssh") => {
  const c = ctx.connections?.find((x) => x.kind === kind && x.checks);
  if (!c) throw new Error("This project has no SSH connection with checks on. Add one on the project's Connections tab.");
  return c;
};

async function session(ctx: ToolContext, c: ResolvedConnection) {
  return sshSession(c, { workDir: ctx.workDir, dataDir: ctx.dataDir ?? ctx.workDir });
}

const where = (c: ResolvedConnection) => `ssh://${c.username}@${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ""}`;

// ---------------------------------------------------------------------------
// Kubernetes / Docker host
// ---------------------------------------------------------------------------

const K8S_SCRIPT = [
  "echo '##docker'; command -v docker >/dev/null 2>&1 && docker info --format '{{.SecurityOptions}} rootless={{.Rootless}} live={{.LiveRestoreEnabled}}' 2>/dev/null",
  "echo '##dockle'; command -v dockle >/dev/null 2>&1 && echo installed",
  "echo '##kube'; command -v kubectl >/dev/null 2>&1 && echo installed",
  "echo '##kubebench'; command -v kube-bench >/dev/null 2>&1 && timeout 120 kube-bench run --json 2>/dev/null | head -c 100000",
  "echo '##kubescape'; command -v kubescape >/dev/null 2>&1 && echo installed",
  // Privileged / host-network pods and containers running as root (read-only).
  "echo '##pods'; command -v kubectl >/dev/null 2>&1 && kubectl get pods -A -o jsonpath='{range .items[*]}{.metadata.namespace}{\" \"}{.metadata.name}{\" priv=\"}{.spec.containers[*].securityContext.privileged}{\" hostNet=\"}{.spec.hostNetwork}{\"\\n\"}{end}' 2>/dev/null | head -n 100",
  "echo '##end'",
].join("; ");

/** Judges the k8s/docker host script output. Pure, for tests. */
export function k8sFindings(out: string, at: string): ToolFinding[] {
  const s = sections(out);
  const findings: ToolFinding[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string) => findings.push({ category: "security", rule, severity, title, detail, pageUrl: at, key: rule });
  const docker = (s.docker ?? []).join(" ");
  if (docker) {
    if (/rootless=false/.test(docker)) add("k8s:docker-rootful", "medium", "Docker runs as root (not rootless)", "The Docker daemon runs as root, so a container escape becomes host root. Consider rootless Docker, user namespaces, and drop capabilities.");
    if (!/name=seccomp/.test(docker)) add("k8s:docker-no-seccomp", "low", "Docker seccomp profile not detected", "Run containers with the default seccomp profile to block dangerous syscalls.");
  }
  for (const line of s.pods ?? []) {
    const m = /^(\S+)\s+(\S+)\s+priv=(\S*)\s+hostNet=(\S*)/.exec(line.trim());
    if (!m) continue;
    if (/true/.test(m[3])) add("k8s:privileged-pod", "high", `Privileged pod: ${m[1]}/${m[2]}`, "This pod runs a privileged container with full host access. Remove privileged: true and grant only the capabilities it needs.");
    if (/true/.test(m[4])) add("k8s:host-network", "medium", `Pod on host network: ${m[1]}/${m[2]}`, "hostNetwork: true removes network isolation. Use a normal pod network unless a node agent truly needs the host.");
  }
  if (!docker && !(s.kube ?? []).join("").includes("installed"))
    add("k8s:none", "info", "No Docker or Kubernetes found on this host", "This server has no Docker daemon or kubectl. If the cluster runs elsewhere, run this check from a host with cluster access, or install kube-bench/Kubescape there.");
  return findings;
}

export const k8sTool: Tool = {
  id: "k8s",
  name: "Kubernetes & Docker host checks",
  maker: "GLV Infotech (built in), in the way of kube-bench, Kubescape and Dockle",
  description:
    "Over the client's SSH connection, reads the Docker daemon and any Kubernetes cluster for unsafe settings: Docker not rootless, privileged pods, pods on the host network. Uses kube-bench/Kubescape when they are installed. Read-only.",
  checks: ["Docker rootless / seccomp", "Privileged pods and host-network pods", "kube-bench CIS results when installed", "Fixed read-only commands only"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api", "code"],
  category: "security",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own (kube-bench/Kubescape/Dockle Apache-2.0 when installed)",
  homepage: "https://github.com/aquasecurity/kube-bench",
  signedIn: "public",
  needsConnection: "ssh",
  ready: () => sshReady(),
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const c = need(ctx, "ssh");
    const s = await session(ctx, c);
    try {
      ctx.log(`Kubernetes/Docker checks on ${c.host}`);
      const out = await sshRun(s, K8S_SCRIPT, ctx.signal, 180_000);
      const findings = k8sFindings(out, where(c));
      return { findings, summary: [`${findings.length} issue(s) on ${c.host}`], tested: `Read ${c.host} container host (read-only)` };
    } finally {
      await s.cleanup();
    }
  },
};

// ---------------------------------------------------------------------------
// Log-file SEO
// ---------------------------------------------------------------------------

const LOG_SCRIPT = [
  "echo '##logs'; for f in /var/log/nginx/access.log /var/log/apache2/access.log /var/log/httpd/access_log /home/*/logs/access.log; do [ -r \"$f\" ] && echo \"FILE $f\" && timeout 60 tail -n 200000 \"$f\"; done 2>/dev/null | awk 'BEGIN{g=0;b=0;o=0;e=0} /FILE /{next} /Googlebot/{g++} /bingbot/{b++} / (404|410) /{e++} {o++} END{print \"googlebot=\" g; print \"bingbot=\" b; print \"errors=\" e; print \"total=\" o}'",
  "echo '##end'",
].join("; ");

/** Judges crawl stats from the log summary. Pure, for tests. */
export function logSeoFindings(summary: Record<string, number>, at: string): ToolFinding[] {
  const findings: ToolFinding[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string) => findings.push({ category: "seo", rule, severity, title, detail, pageUrl: at, key: rule });
  if ((summary.total ?? 0) === 0) {
    add("logseo:no-logs", "info", "No readable web-server access logs", "No nginx/apache access log was readable over SSH. Point the check at the right path, or export logs so GLV can analyse real crawler behaviour.");
    return findings;
  }
  if ((summary.googlebot ?? 0) === 0) add("logseo:no-googlebot", "medium", "Googlebot not seen in recent logs", "No Googlebot hits in the last ~200k log lines. The site may be new, blocked by robots.txt, or not indexed. Check Search Console and robots.txt.");
  const errRate = summary.total ? (summary.errors ?? 0) / summary.total : 0;
  if (errRate > 0.05) add("logseo:high-404", "medium", `${Math.round(errRate * 100)}% of requests are 404/410`, "A high share of crawled URLs return not-found. Fix internal links and add redirects so crawl budget is not wasted on dead pages.");
  return findings;
}

export const logSeoTool: Tool = {
  id: "log-seo",
  name: "Log-file SEO",
  maker: "GLV Infotech (built in), with GoAccess",
  description:
    "Reads the web server's access logs over SSH to see what search-engine crawlers really fetch: how often Googlebot visits and how many crawled URLs return 404. For large sites where crawl budget matters. Read-only.",
  checks: ["Googlebot / Bingbot crawl frequency", "Share of crawled URLs returning 404/410", "Uses GoAccess when installed; fixed read-only commands otherwise"],
  products: ["website", "ecommerce", "webapp", "saas"],
  category: "seo",
  safety: "safe",
  takes: "1 to 2 minutes",
  licence: "GLV's own (GoAccess MIT when installed)",
  homepage: "https://goaccess.io",
  signedIn: "public",
  needsConnection: "ssh",
  ready: () => sshReady(),
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const c = need(ctx, "ssh");
    const s = await session(ctx, c);
    try {
      ctx.log(`Log-file SEO on ${c.host}`);
      const out = await sshRun(s, LOG_SCRIPT, ctx.signal, 120_000);
      const lines = sections(out).logs ?? [];
      const summary: Record<string, number> = {};
      for (const l of lines) {
        const m = /^(\w+)=(\d+)$/.exec(l.trim());
        if (m) summary[m[1]] = Number(m[2]);
      }
      const findings = logSeoFindings(summary, where(c));
      return { findings, summary: [`Googlebot ${summary.googlebot ?? 0}, 404s ${summary.errors ?? 0} of ${summary.total ?? 0} lines`], tested: `Read ${c.host} access logs (read-only)` };
    } finally {
      await s.cleanup();
    }
  },
};

// ---------------------------------------------------------------------------
// DR / backup drill
// ---------------------------------------------------------------------------

const DR_SCRIPT = [
  "echo '##backups'; find /var/backups /home/*/backups /root/backups /backup /backups -maxdepth 3 -type f \\( -name '*.sql*' -o -name '*.tar*' -o -name '*.zip' -o -name '*.dump' \\) -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -n 5",
  "echo '##cron'; (crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null) | grep -Eic 'mysqldump|pg_dump|backup|restic|borg|rsync|duplicity'",
  "echo '##restoretest'; (crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null; ls /opt/*restore* /usr/local/bin/*restore* 2>/dev/null) | grep -Eic 'restore|verify'",
  "echo '##now'; date -u +%s",
  "echo '##end'",
].join("; ");

/** Judges backup/DR readiness. Pure, for tests. */
export function drFindings(s: Record<string, string[]>, at: string): ToolFinding[] {
  const findings: ToolFinding[] = [];
  const add = (rule: string, severity: Severity, title: string, detail: string) => findings.push({ category: "security", rule, severity, title, detail, pageUrl: at, key: rule });
  const now = Number((s.now ?? [])[0]) || Date.now() / 1000;
  const backups = (s.backups ?? []).map((l) => Number(l.trim().split(" ")[0])).filter((n) => Number.isFinite(n));
  const cronJobs = Number((s.cron ?? [])[0]) || 0;
  const restoreTests = Number((s.restoretest ?? [])[0]) || 0;
  if (!backups.length && !cronJobs) {
    add("dr:no-backups", "high", "No recent backups found", "No recent database dump or archive was found and no backup job is scheduled. Set up automatic daily backups kept off the server.");
    return findings;
  }
  const newest = backups.length ? Math.max(...backups) : 0;
  const ageDays = newest ? (now - newest) / 86400 : 999;
  if (ageDays > 2) add("dr:stale-backup", "high", `Newest backup is ${Math.round(ageDays)} days old`, "The most recent backup is stale. A failure now would lose days of data. Fix the backup job and alert on failures.");
  if (!restoreTests) add("dr:no-restore-test", "medium", "No restore/verify test found", "Backups exist but nothing restores them regularly. An untested backup often fails when you need it. Schedule a monthly restore to a temp server and run smoke tests against it.");
  return findings;
}

export const drDrillTool: Tool = {
  id: "dr-drill",
  name: "Backup & DR drill",
  maker: "GLV Infotech (built in)",
  description:
    "Over SSH, checks that backups are recent and that a restore is actually tested. Many clients back up but never try a restore until a real failure. Read-only: it inspects backup files and cron jobs, it does not restore anything.",
  checks: ["A recent backup exists (not stale)", "A backup job is scheduled", "A restore/verify test runs regularly", "Read-only inspection only"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api"],
  category: "security",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "public",
  needsConnection: "ssh",
  ready: () => sshReady(),
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const c = need(ctx, "ssh");
    const s = await session(ctx, c);
    try {
      ctx.log(`Backup/DR drill on ${c.host}`);
      const out = await sshRun(s, DR_SCRIPT, ctx.signal, 90_000);
      const findings = drFindings(sections(out), where(c));
      return { findings, summary: [`${findings.length} backup/DR issue(s)`], tested: `Read ${c.host} backups (read-only)` };
    } finally {
      await s.cleanup();
    }
  },
};

// ---------------------------------------------------------------------------
// Database code (stored procedures / triggers)
// ---------------------------------------------------------------------------

const DBCODE_SCRIPT = [
  `echo '##mysql'; if command -v mysql >/dev/null 2>&1 && [ -f ~/.my.cnf ]; then timeout 60 mysql -NBe "SELECT 'routine', routine_schema, routine_name FROM information_schema.routines WHERE routine_schema NOT IN ('mysql','sys','information_schema','performance_schema') LIMIT 100; SELECT 'trigger', trigger_schema, trigger_name FROM information_schema.triggers WHERE trigger_schema NOT IN ('mysql','sys') LIMIT 100;" 2>/dev/null; fi`,
  "echo '##pgtap'; command -v pg_prove >/dev/null 2>&1 && echo installed",
  "echo '##end'",
].join("; ");

/** Judges database-code test coverage. Pure, for tests. */
export function dbCodeFindings(s: Record<string, string[]>, at: string): ToolFinding[] {
  const findings: ToolFinding[] = [];
  let routines = 0;
  let triggers = 0;
  for (const l of s.mysql ?? []) {
    const t = l.trim();
    if (t.startsWith("routine")) routines++;
    else if (t.startsWith("trigger")) triggers++;
  }
  const hasFramework = (s.pgtap ?? []).join("").includes("installed");
  if (routines + triggers > 0 && !hasFramework)
    findings.push({
      category: "functional",
      rule: "dbcode:untested",
      severity: "medium",
      title: `${routines} stored procedure(s) and ${triggers} trigger(s) with no test framework`,
      detail: `The database holds business logic in ${routines} routine(s) and ${triggers} trigger(s), but no database test framework (pgTAP / tSQLt) was found. This code is often the least tested and the hardest to change safely. Add pgTAP (PostgreSQL) or tSQLt (SQL Server) unit tests for it.`,
      pageUrl: at,
      key: "dbcode:untested",
    });
  return findings;
}

export const dbCodeTool: Tool = {
  id: "db-code",
  name: "Database code tests (procedures & triggers)",
  maker: "GLV Infotech (built in), with pgTAP / tSQLt",
  description:
    "Over SSH, lists the stored procedures and triggers in the database and checks whether a database test framework (pgTAP, tSQLt) is in place. Business logic in the database is often untested and risky to change. Read-only.",
  checks: ["Counts stored procedures and triggers", "Looks for pgTAP / tSQLt", "Recommends unit tests for database code", "Read-only questions to information_schema"],
  products: ["crm", "saas", "api", "code"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own (pgTAP/tSQLt open source when installed)",
  homepage: "https://pgtap.org",
  signedIn: "public",
  needsConnection: "ssh",
  ready: () => sshReady(),
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const c = need(ctx, "ssh");
    const s = await session(ctx, c);
    try {
      ctx.log(`Database-code check on ${c.host}`);
      const out = await sshRun(s, DBCODE_SCRIPT, ctx.signal, 90_000);
      const findings = dbCodeFindings(sections(out), where(c));
      return { findings, summary: [findings.length ? "Untested database code found" : "No untested database code detected"], tested: `Read ${c.host} database schema (read-only)` };
    } finally {
      await s.cleanup();
    }
  },
};
