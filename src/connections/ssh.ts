import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import path from "node:path";
import type { ToolFinding } from "../tools/types.js";
import type { ResolvedConnection } from "./types.js";

/**
 * SSH to a client's server with OpenSSH's own client (bundled in the Docker image). GLV never types
 * a command the tester wrote: the only things that run on the client's server are the fixed,
 * read-only commands below, and the tunnel, which only carries the browser's requests.
 */

export const sshPath = (env: NodeJS.ProcessEnv = process.env) => env.SSH_PATH || "ssh";

export async function sshReady(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(sshPath(env), ["-V"], { timeout: 5000 }, (err) =>
      resolve(err && (err as NodeJS.ErrnoException).code === "ENOENT" ? "The SSH client is not installed (it comes with the Docker image)." : null),
    );
  });
}

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/;

/** A client's server is on the internet: the GLV server's own network is off limits unless ALLOW_PRIVATE_TARGETS=1. */
export function checkSshHost(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (PRIVATE.test(host) && env.ALLOW_PRIVATE_TARGETS !== "1") {
    throw new Error("Private and local addresses are blocked. Set ALLOW_PRIVATE_TARGETS=1 to reach servers on this network.");
  }
}

/** The OpenSSH fingerprint (SHA256:...) of each key in a known_hosts file. */
export function fingerprints(knownHosts: string): string[] {
  const out: string[] = [];
  for (const line of knownHosts.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || line.startsWith("#")) continue;
    const blob = Buffer.from(parts[2], "base64");
    if (!blob.length) continue;
    out.push(`SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`);
  }
  return out;
}

export interface SshSession {
  args: string[];
  env: NodeJS.ProcessEnv;
  knownHosts: string;
  cleanup: () => Promise<void>;
}

/**
 * The ssh arguments and environment for a connection. The key goes in a file only the server can
 * read, inside the run's scratch folder, removed afterwards. A password or key passphrase is handed
 * over by a tiny askpass script that reads it from ssh's own environment, never from the command line.
 */
export async function sshSession(c: ResolvedConnection, opts: { workDir: string; dataDir: string; env?: NodeJS.ProcessEnv }): Promise<SshSession> {
  const env = opts.env ?? process.env;
  if (!c.host || !c.username) throw new Error("This SSH connection has no server address or user.");
  checkSshHost(c.host, env);
  const dir = path.join(opts.workDir, `ssh-${c.id.slice(0, 8)}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const knownDir = path.join(opts.dataDir, "connections", "known_hosts");
  await mkdir(knownDir, { recursive: true, mode: 0o700 });
  const knownHosts = path.join(knownDir, c.id.replace(/[^\w-]/g, ""));
  const args = [
    "-p",
    String(c.port ?? 22),
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    // The server's key is learned on the first test, then must stay the same.
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "NumberOfPasswordPrompts=1",
    "-o", "LogLevel=ERROR",
    "-F", "/dev/null",
  ];
  const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH, HOME: dir, LANG: "C" };
  let askpass = false;
  if (c.auth === "password") {
    args.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no");
    askpass = Boolean(c.secret.password);
  } else {
    if (!c.secret.key) throw new Error("This SSH connection has no private key saved.");
    const keyFile = path.join(dir, "id");
    await writeFile(keyFile, c.secret.key, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    args.push("-i", keyFile, "-o", "IdentitiesOnly=yes", "-o", "PreferredAuthentications=publickey");
    askpass = Boolean(c.secret.password);
  }
  if (askpass) {
    const script = path.join(dir, "askpass.sh");
    await writeFile(script, '#!/bin/sh\nprintf \'%s\\n\' "$GLV_SSH_SECRET"\n', { mode: 0o700 });
    Object.assign(childEnv, { SSH_ASKPASS: script, SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0", GLV_SSH_SECRET: c.secret.password });
  } else {
    args.push("-o", "BatchMode=yes");
  }
  // -- keeps a strange user or host from being read as an option.
  args.push("--", `${c.username}@${c.host.replace(/^\[|\]$/g, "")}`);
  return { args, env: childEnv, knownHosts, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** ssh's error in plain words. */
export function sshError(stderr: string, code: number | string | null): string {
  const s = stderr.trim();
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)) {
    return "The server's key is not the one seen before. Someone may be in the middle, or the server was rebuilt: check with the client, then remove and add the connection again.";
  }
  if (/Permission denied/i.test(s)) return "The server refused the sign-in: check the user and the key or password.";
  if (/Connection refused/i.test(s)) return "The server refused the connection: check the address and SSH port.";
  if (/timed out|No route to host|Network is unreachable/i.test(s)) return "The server did not answer: check the address, the port and the client's firewall (it must let GLV's server in).";
  if (/Could not resolve hostname/i.test(s)) return "That server name does not exist.";
  if (/load pubkey|invalid format|incorrect passphrase|bad passphrase/i.test(s)) return "The private key could not be read: check the key and its passphrase.";
  return s.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) || `ssh stopped (${code}).`;
}

/** Runs one fixed command on the server and returns what it printed. */
export async function sshRun(session: SshSession, command: string, signal?: AbortSignal, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(sshPath(), [...session.args, command], { env: session.env, timeout: timeoutMs, maxBuffer: 4_000_000, signal }, (err, stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new Error("The SSH client is not installed (it comes with the Docker image)."));
        if (signal?.aborted) return reject(signal.reason);
        // A non-zero exit from our script still printed its sections; ssh itself fails with 255.
        if ((err as { code?: number }).code !== 255 && stdout.includes("##end")) return resolve(stdout);
        return reject(new Error(sshError(stderr, (err as { code?: number }).code ?? null)));
      }
      resolve(stdout);
    });
  });
}

/** The fixed, read-only commands of the server checks, with a marker before each answer. */
/**
 * What web shells and injected PHP look like (WSO, c99, r57, b374k, FilesMan, eval of decoded text,
 * commands run from request data). Kept to a grep pattern so the server needs nothing installed.
 */
export const WEBSHELL_GREP =
  "eval[[:space:]]*\\([[:space:]]*(base64_decode|gzinflate|gzuncompress|str_rot13)[[:space:]]*\\(|assert[[:space:]]*\\([[:space:]]*[$]_(POST|GET|REQUEST)|(system|shell_exec|passthru|popen|proc_open)[[:space:]]*\\([[:space:]]*[$]_(GET|POST|REQUEST|COOKIE)|FilesMan|WSO [0-9]|c99shell|r57shell|b374k|[$]_(POST|REQUEST)\\[[^]]+\\][[:space:]]*\\([[:space:]]*[$]_(POST|REQUEST)";

export const SERVER_SCRIPT = [
  "echo '##os'; cat /etc/os-release 2>/dev/null",
  "echo '##uname'; uname -srm 2>/dev/null",
  "echo '##uptime'; uptime 2>/dev/null",
  "echo '##time'; date -u +%s",
  "echo '##df'; df -P 2>/dev/null",
  "echo '##mem'; free -m 2>/dev/null",
  "echo '##listen'; (ss -Hltn 2>/dev/null || netstat -ltn 2>/dev/null)",
  "echo '##sshd'; grep -hEi '^[[:space:]]*(PermitRootLogin|PasswordAuthentication|PermitEmptyPasswords)[[:space:]]' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null",
  "echo '##updates'; if command -v apt >/dev/null 2>&1; then apt list --upgradable 2>/dev/null | grep -ci -- '-security'; elif command -v dnf >/dev/null 2>&1; then dnf -q updateinfo list --security 2>/dev/null | wc -l; else echo unknown; fi",
  "echo '##reboot'; test -f /var/run/reboot-required && echo yes || echo no",
  "echo '##web'; (nginx -v 2>&1; apache2 -v 2>/dev/null | head -1; httpd -v 2>/dev/null | head -1; php -v 2>/dev/null | head -1; node -v 2>/dev/null) | grep -v 'not found'",
  // Web shells and injected PHP in the usual web roots (Hostinger, cPanel, plain Linux): file names only, read-only.
  `echo '##webshells'; for d in /var/www /home/*/public_html /home/*/domains/*/public_html /usr/share/nginx/html; do [ -d "$d" ] && timeout 60 grep -rlEI --include='*.php' --include='*.phtml' --include='*.php5' --include='*.phar' -m1 ${JSON.stringify(WEBSHELL_GREP)} "$d" 2>/dev/null | head -n 20; done`,
  // Hardening (CIS-style, read-only): firewall, brute-force guard, automatic updates, kernel settings, audit log.
  "echo '##hardening'; (command -v ufw >/dev/null && (ufw status 2>/dev/null | head -1 | sed 's/^/ufw=/')); (systemctl is-active firewalld 2>/dev/null | sed 's/^/firewalld=/'); (command -v nft >/dev/null && echo nft_rules=$(nft list ruleset 2>/dev/null | grep -c rule)); (command -v iptables >/dev/null && echo iptables_rules=$(iptables -S 2>/dev/null | grep -vc '^-P')); echo fail2ban=$(systemctl is-active fail2ban 2>/dev/null || echo none); echo autoupdates=$( (systemctl is-enabled unattended-upgrades 2>/dev/null || systemctl is-enabled dnf-automatic.timer 2>/dev/null) | head -1); echo auditd=$(systemctl is-active auditd 2>/dev/null || echo none); for k in kernel.randomize_va_space net.ipv4.tcp_syncookies net.ipv4.conf.all.accept_redirects net.ipv4.ip_forward fs.suid_dumpable; do echo \"$k=$(sysctl -n $k 2>/dev/null)\"; done; echo pass_max_days=$(awk '/^PASS_MAX_DAYS/{print $2}' /etc/login.defs 2>/dev/null); echo tmp_noexec=$(findmnt -no OPTIONS /tmp 2>/dev/null | grep -c noexec); echo sshd_x11=$(grep -hEi '^[[:space:]]*X11Forwarding' /etc/ssh/sshd_config 2>/dev/null | awk '{print tolower($2)}' | tail -1); echo sshd_maxauth=$(grep -hEi '^[[:space:]]*MaxAuthTries' /etc/ssh/sshd_config 2>/dev/null | awk '{print $2}' | tail -1); echo uid0=$(awk -F: '$3==0{print $1}' /etc/passwd 2>/dev/null | tr '\\n' ,)",
  // Lynis, when the client has it installed: its hardening index only (it does not change anything).
  "echo '##lynis'; command -v lynis >/dev/null 2>&1 && timeout 300 lynis audit system --quick --no-colors --quiet 2>/dev/null | grep -Ei 'hardening index|warning' | head -n 15",
  // CERT-In (April 2022 directions): clocks synced to NTP, logs kept 180 days.
  "echo '##ntp'; timedatectl show -p NTPSynchronized -p NTP 2>/dev/null; (chronyc sources 2>/dev/null || ntpq -pn 2>/dev/null) | head -n 6",
  "echo '##logs'; for f in /etc/logrotate.d/rsyslog /etc/logrotate.d/syslog /etc/logrotate.conf; do [ -f \"$f\" ] && echo \"$f $(grep -E '^[[:space:]]*(rotate|daily|weekly|monthly)' \"$f\" | tr -s ' ' | tr '\\n' ' ')\"; done; echo journal_max=$(grep -hE '^MaxRetentionSec' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf 2>/dev/null | tail -1); echo oldest_auth=$(ls -1tr /var/log/auth.log* /var/log/secure* 2>/dev/null | head -1 | xargs -r stat -c %Y 2>/dev/null)",
  // Backups: a recent dump or archive in the usual places, or a backup job in cron.
  "echo '##backups'; find /var/backups /home/*/backups /root/backups /backup /backups -maxdepth 3 -type f \\( -name '*.sql*' -o -name '*.tar*' -o -name '*.zip' -o -name '*.dump' \\) -mtime -8 2>/dev/null | head -n 5; (crontab -l 2>/dev/null; cat /etc/cron.d/* 2>/dev/null) | grep -Eic 'mysqldump|pg_dump|backup|restic|borg|rsync|duplicity' | sed 's/^/cron_jobs=/'",
  // MySQL / MariaDB, only when the server's own ~/.my.cnf lets this user in: read-only questions to information_schema.
  `echo '##mysql'; if command -v mysql >/dev/null 2>&1 && [ -f ~/.my.cnf ]; then timeout 60 mysql -NBe "SELECT 'nopk', t.table_schema, t.table_name, t.table_rows FROM information_schema.tables t LEFT JOIN information_schema.table_constraints c ON c.table_schema=t.table_schema AND c.table_name=t.table_name AND c.constraint_type='PRIMARY KEY' WHERE t.table_type='BASE TABLE' AND c.constraint_name IS NULL AND t.table_schema NOT IN ('mysql','sys','information_schema','performance_schema') LIMIT 20; SELECT 'big', table_schema, table_name, ROUND((data_length+index_length)/1048576) FROM information_schema.tables WHERE (data_length+index_length) > 2147483648 LIMIT 10; SELECT 'myisam', table_schema, table_name, engine FROM information_schema.tables WHERE engine='MyISAM' AND table_schema NOT IN ('mysql','sys') LIMIT 10; SELECT 'noindex', t.table_schema, t.table_name, t.table_rows FROM information_schema.tables t WHERE t.table_rows > 100000 AND t.table_schema NOT IN ('mysql','sys','information_schema','performance_schema') AND (SELECT COUNT(DISTINCT s.index_name) FROM information_schema.statistics s WHERE s.table_schema=t.table_schema AND s.table_name=t.table_name) < 2 LIMIT 10; SELECT 'nofk', table_schema, COUNT(*), 0 FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','information_schema','performance_schema') AND table_type='BASE TABLE' AND table_schema NOT IN (SELECT DISTINCT constraint_schema FROM information_schema.referential_constraints) GROUP BY table_schema HAVING COUNT(*) > 5; SELECT 'passcol', table_schema, CONCAT(table_name,'.',column_name), character_maximum_length FROM information_schema.columns WHERE column_name REGEXP 'pass(word|wd)?$' AND character_maximum_length < 40 AND table_schema NOT IN ('mysql','sys') LIMIT 10; SHOW GLOBAL VARIABLES WHERE Variable_name IN ('slow_query_log','long_query_time','slow_query_log_file','version');" 2>/dev/null; fi`,
  "echo '##slowlog'; f=$(mysql -NBe \"SELECT @@slow_query_log_file\" 2>/dev/null); [ -n \"$f\" ] && [ -r \"$f\" ] && (command -v mysqldumpslow >/dev/null && timeout 60 mysqldumpslow -s t -t 5 \"$f\" 2>/dev/null | grep -E '^(Count|  )' | head -n 20)",
  "echo '##end'",
].join("; ");

/** Splits the script's answer into its sections. */
export function sections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {};
  let cur = "";
  for (const line of out.split("\n")) {
    const m = /^##(\w+)$/.exec(line.trim());
    if (m) {
      cur = m[1];
      res[cur] = [];
    } else if (cur) res[cur].push(line);
  }
  return res;
}

const DB_PORTS: Record<number, string> = {
  3306: "MySQL",
  5432: "PostgreSQL",
  27017: "MongoDB",
  6379: "Redis",
  11211: "Memcached",
  9200: "Elasticsearch",
  5984: "CouchDB",
  1433: "SQL Server",
};

/** Systems that no longer get security updates (as of late 2026). */
function endOfLife(id: string, version: string): boolean {
  const v = Number.parseFloat(version);
  if (!Number.isFinite(v) && id !== "centos") return false;
  if (id === "ubuntu") return v < 22.04;
  if (id === "debian") return v < 12;
  if (id === "centos") return true;
  if (id === "rhel" || id === "almalinux" || id === "rocky") return v < 8;
  if (id === "fedora") return v < 41;
  return false;
}

export interface ServerFacts {
  system?: string;
  kernel?: string;
  uptime?: string;
  web: string[];
}

/** Turns the server's answers into findings, in plain words, each with what to do. */
export function serverFindings(out: string, where: string, now = Date.now()): { findings: ToolFinding[]; facts: ServerFacts } {
  const s = sections(out);
  const findings: ToolFinding[] = [];
  const add = (f: Omit<ToolFinding, "pageUrl">) => findings.push({ ...f, pageUrl: where });
  const osLines = s.os ?? [];
  const field = (k: string) => osLines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).replace(/^"|"$/g, "");
  const system = field("PRETTY_NAME");
  const facts: ServerFacts = { system, kernel: s.uname?.[0]?.trim(), uptime: s.uptime?.[0]?.trim(), web: (s.web ?? []).map((l) => l.trim()).filter(Boolean) };

  const id = (field("ID") ?? "").toLowerCase();
  if (system && endOfLife(id, field("VERSION_ID") ?? "")) {
    add({
      category: "security",
      severity: "high",
      rule: "server:os-end-of-life",
      title: "The server's system no longer gets security updates",
      detail: `${system} is past its end of support, so new holes in it are never fixed. Move the site to a supported release (Ubuntu 24.04 LTS, Debian 12 or newer).`,
      evidence: system,
    });
  }

  for (const line of s.df ?? []) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6 || parts[0] === "Filesystem" || /^(tmpfs|devtmpfs|overlay|squashfs|udev|none)$/.test(parts[0])) continue;
    const pct = Number(parts[4].replace("%", ""));
    const mount = parts.slice(5).join(" ");
    if (pct >= 90) {
      add({ category: "performance", severity: "high", rule: "server:disk-full", title: `The server's disk is ${pct}% full (${mount})`, detail: "When the disk fills up, the site, its database and its logs stop writing and the site goes down. Clear old logs and backups, or add space.", evidence: line.trim() });
    } else if (pct >= 80) {
      add({ category: "performance", severity: "medium", rule: "server:disk-full", title: `The server's disk is ${pct}% full (${mount})`, detail: "Plan more space or a clean-up before it reaches 90%.", evidence: line.trim() });
    }
  }

  const mem = (s.mem ?? []).find((l) => /^Mem:/.test(l.trim()));
  if (mem) {
    const n = mem.trim().split(/\s+/).slice(1).map(Number);
    const total = n[0];
    const available = n[5] ?? n[2];
    if (total > 0 && Number.isFinite(available) && available / total < 0.1) {
      add({ category: "performance", severity: "medium", rule: "server:low-memory", title: `The server has only ${available} MB of ${total} MB memory free`, detail: "With memory this low the server starts swapping or stops programs, and pages get slow or fail. Find what uses it, or add memory.", evidence: mem.trim() });
    }
  }

  const seen = new Set<number>();
  for (const line of s.listen ?? []) {
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c) => /[:.]\d+$/.test(c) && /^(0\.0\.0\.0|\*|\[::\]|::|:::)/.test(c));
    if (!local) continue;
    const port = Number(/(\d+)$/.exec(local)?.[1]);
    const name = DB_PORTS[port];
    if (!name || seen.has(port)) continue;
    seen.add(port);
    add({
      category: "security",
      severity: "high",
      rule: "server:database-open",
      title: `${name} listens on every network (port ${port})`,
      detail: `${name} accepts connections from any address, not only from this server. Unless a firewall blocks port ${port}, anyone on the internet can try to sign in to the database. Make it listen on 127.0.0.1 only (bind-address), or allow only the app's server in the firewall.`,
      evidence: line.trim(),
    });
  }

  const sshd = (s.sshd ?? []).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const setting = (k: string) => sshd.find((l) => l.toLowerCase().startsWith(k.toLowerCase()))?.split(/\s+/)[1]?.toLowerCase();
  if (setting("PermitRootLogin") === "yes") {
    add({ category: "security", severity: "high", rule: "server:ssh-root-login", title: "Anyone can try to sign in to the server as root", detail: "SSH allows signing in as root with a password. Bots try this all day. Set PermitRootLogin to no (or prohibit-password) and sign in as a normal user.", evidence: "PermitRootLogin yes" });
  }
  if (setting("PasswordAuthentication") === "yes") {
    add({ category: "security", severity: "medium", rule: "server:ssh-passwords", title: "The server allows SSH sign-in with passwords", detail: "Passwords can be guessed; keys cannot. Set PasswordAuthentication to no once everyone signs in with a key.", evidence: "PasswordAuthentication yes" });
  }
  if (setting("PermitEmptyPasswords") === "yes") {
    add({ category: "security", severity: "critical", rule: "server:ssh-empty-passwords", title: "The server allows SSH accounts with no password", detail: "Set PermitEmptyPasswords to no at once.", evidence: "PermitEmptyPasswords yes" });
  }

  const updates = Number((s.updates ?? [])[0]?.trim());
  if (Number.isFinite(updates) && updates > 0) {
    add({ category: "security", severity: updates >= 10 ? "high" : "medium", rule: "server:security-updates", title: `${updates} security update${updates === 1 ? " is" : "s are"} waiting on the server`, detail: "Fixes for known holes are out but not installed. Install them (apt upgrade, or dnf upgrade --security) in a quiet hour.", evidence: `${updates} security packages can be upgraded` });
  }
  if ((s.reboot ?? [])[0]?.trim() === "yes") {
    add({ category: "security", severity: "low", rule: "server:reboot-required", title: "The server needs a restart to finish its updates", detail: "Updates were installed but the old programs (often the kernel) still run until the server restarts.", evidence: "/var/run/reboot-required" });
  }

  const remote = Number((s.time ?? [])[0]?.trim());
  if (Number.isFinite(remote) && remote > 0 && Math.abs(remote - now / 1000) > 120) {
    add({ category: "functional", severity: "low", rule: "server:clock", title: `The server's clock is ${Math.round(Math.abs(remote - now / 1000) / 60)} minutes off`, detail: "A wrong clock breaks sign-in codes, certificates and the order of records. Turn on time sync (timedatectl set-ntp true).", evidence: new Date(remote * 1000).toISOString() });
  }

  const shells = (s.webshells ?? []).map((l) => l.trim()).filter((l) => l.startsWith("/"));
  if (shells.length) {
    add({
      category: "security",
      severity: "critical",
      rule: "server:webshell",
      title: `${shells.length} PHP file${shells.length === 1 ? " looks" : "s look"} like a web shell or injected code`,
      detail: "These files hold code attackers plant to control a hacked site (eval of hidden code, running commands sent in a request, known web shells such as WSO or c99). Compare them with a clean copy of the site or plugin, remove what was planted, change every password (hosting, FTP, database, admin), and update the CMS and plugins.",
      evidence: shells.slice(0, 20).join("\n"),
    });
  }

  findings.push(...hardeningFindings(s, where, now));

  const php = facts.web.find((l) => /^PHP \d/.test(l));
  const phpVersion = php ? Number.parseFloat(php.split(" ")[1]) : NaN;
  if (Number.isFinite(phpVersion) && phpVersion < 8.2) {
    add({ category: "security", severity: "medium", rule: "server:php-end-of-life", title: `PHP ${php!.split(" ")[1]} no longer gets security fixes`, detail: "Move the site to PHP 8.3 or newer (test the site on it first).", evidence: php! });
  }
  return { findings, facts };
}

/** A free port on this computer's loopback. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

const canConnect = (port: number) =>
  new Promise<boolean>((resolve) => {
    const sock = connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => resolve(false));
  });

export interface Tunnel {
  /** The browser's proxy: socks5://127.0.0.1:<port>. */
  proxy: string;
  close: () => Promise<void>;
}

/**
 * Opens a SOCKS tunnel through the client's server (ssh -D), so the test's browser reaches the
 * client's private test site by its own name, as the server sees it. Only on this computer's loopback.
 */
export async function openTunnel(session: SshSession, signal?: AbortSignal): Promise<Tunnel> {
  const port = await freePort();
  const child: ChildProcess = spawn(sshPath(), ["-N", "-D", `127.0.0.1:${port}`, "-o", "ExitOnForwardFailure=yes", ...session.args], {
    env: session.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-4000)));
  let exited: number | null | undefined;
  child.once("exit", (code) => (exited = code));
  const close = async () => {
    if (exited === undefined) {
      child.kill("SIGTERM");
      await new Promise((r) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          r(null);
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          r(null);
        });
      });
    }
  };
  signal?.addEventListener("abort", () => void close(), { once: true });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (exited !== undefined) throw new Error(sshError(stderr, exited));
    if (await canConnect(port)) return { proxy: `socks5://127.0.0.1:${port}`, close };
    await new Promise((r) => setTimeout(r, 200));
  }
  await close();
  throw new Error("The tunnel through the client's server did not open in 25 seconds.");
}

/** Signs in once and reads what the server is, for the connection's Test button. Learns the server key. */
export async function testSsh(c: ResolvedConnection, opts: { workDir: string; dataDir: string; signal?: AbortSignal }): Promise<{ message: string; details: string[]; hostKey?: string }> {
  const session = await sshSession(c, opts);
  try {
    const out = await sshRun(session, "echo '##os'; cat /etc/os-release 2>/dev/null; echo '##uname'; uname -srm; echo '##whoami'; id -un; echo '##end'", opts.signal, 30_000);
    const s = sections(out);
    const pretty = (s.os ?? []).find((l) => l.startsWith("PRETTY_NAME="))?.slice(12).replace(/^"|"$/g, "");
    const known = existsSync(session.knownHosts) ? fingerprints(await readFile(session.knownHosts, "utf8")) : [];
    const details = [
      `Signed in as ${s.whoami?.[0]?.trim() || c.username}`,
      ...(pretty ? [`System: ${pretty}`] : []),
      ...(s.uname?.[0] ? [`Kernel: ${s.uname[0].trim()}`] : []),
      ...(known[0] ? [`Server key: ${known[0]}`] : []),
    ];
    return { message: `Connected to ${c.host}`, details, ...(known[0] ? { hostKey: known[0] } : {}) };
  } finally {
    await session.cleanup();
  }
}

const kv = (lines: string[] | undefined) => Object.fromEntries((lines ?? []).map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

/** Hardening, CERT-In, backups and database health from the extra sections. Pure, for tests. */
export function hardeningFindings(s: Record<string, string[]>, where: string, now = Date.now()): ToolFinding[] {
  const out: ToolFinding[] = [];
  const add = (f: Omit<ToolFinding, "pageUrl" | "category"> & { category?: ToolFinding["category"] }) => out.push({ category: "security", ...f, pageUrl: where });
  if (s.hardening) {
    const h = kv(s.hardening);
    const fw = /active/i.test(h.ufw ?? "") && !/inactive/i.test(h.ufw ?? "") || h.firewalld === "active" || Number(h.nft_rules) > 0 || Number(h.iptables_rules) > 0;
    if (!fw) add({ severity: "high", rule: "server:no-firewall", title: "The server has no firewall on", detail: "Every service that listens can be reached from the internet. Turn on a firewall that allows only SSH, HTTP and HTTPS (ufw allow 22,80,443/tcp; ufw enable), and the database only from the app.", evidence: `ufw: ${h.ufw ?? "none"}; firewalld: ${h.firewalld ?? "none"}; nft rules: ${h.nft_rules ?? "?"}; iptables rules: ${h.iptables_rules ?? "?"}` });
    if (h.fail2ban !== "active") add({ severity: "medium", rule: "server:no-fail2ban", title: "Nothing blocks password guessing on the server", detail: "Install fail2ban (or CrowdSec) so addresses that keep failing SSH and admin sign-ins are blocked.", evidence: `fail2ban: ${h.fail2ban}` });
    if (!/enabled/.test(h.autoupdates ?? "")) add({ severity: "medium", rule: "server:no-auto-updates", title: "Security updates are not installed automatically", detail: "Turn on unattended-upgrades (Ubuntu/Debian) or dnf-automatic (RHEL family) for security updates.", evidence: `automatic updates: ${h.autoupdates || "off"}` });
    if (h.auditd !== "active") add({ severity: "low", rule: "server:no-auditd", title: "The system audit log (auditd) is off", detail: "auditd records who changed what (sign-ins, sudo, file changes); CERT-In and ISO 27001 audits expect it. apt install auditd && systemctl enable --now auditd.", evidence: `auditd: ${h.auditd}` });
    if (h["kernel.randomize_va_space"] && h["kernel.randomize_va_space"] !== "2") add({ severity: "medium", rule: "server:aslr-off", title: "Memory address randomisation (ASLR) is weakened", detail: "Set kernel.randomize_va_space = 2 in /etc/sysctl.d/.", evidence: `kernel.randomize_va_space = ${h["kernel.randomize_va_space"]}` });
    if (h["net.ipv4.tcp_syncookies"] === "0") add({ severity: "low", rule: "server:syncookies-off", title: "SYN cookies are off", detail: "Set net.ipv4.tcp_syncookies = 1 to survive SYN floods.", evidence: "net.ipv4.tcp_syncookies = 0" });
    if (h["net.ipv4.conf.all.accept_redirects"] === "1") add({ severity: "low", rule: "server:icmp-redirects", title: "The server accepts ICMP redirects", detail: "Set net.ipv4.conf.all.accept_redirects = 0.", evidence: "accept_redirects = 1" });
    if (h["fs.suid_dumpable"] && h["fs.suid_dumpable"] !== "0") add({ severity: "low", rule: "server:core-dumps", title: "Programs with raised rights can write memory dumps", detail: "Set fs.suid_dumpable = 0 so passwords in memory do not end up in dump files.", evidence: `fs.suid_dumpable = ${h["fs.suid_dumpable"]}` });
    if (h.sshd_x11 === "yes") add({ severity: "low", rule: "server:ssh-x11", title: "SSH allows X11 forwarding", detail: "Set X11Forwarding no in sshd_config unless someone needs it.", evidence: "X11Forwarding yes" });
    if (Number(h.sshd_maxauth) > 4) add({ severity: "low", rule: "server:ssh-maxauth", title: `SSH allows ${h.sshd_maxauth} password tries per connection`, detail: "Set MaxAuthTries 4 or lower.", evidence: `MaxAuthTries ${h.sshd_maxauth}` });
    const root = (h.uid0 ?? "").split(",").filter(Boolean);
    if (root.length > 1) add({ severity: "high", rule: "server:extra-root", title: `More than one account has root rights (${root.join(", ")})`, detail: "Only root should have user id 0. An extra one is a classic backdoor: check who made it.", evidence: `uid 0: ${root.join(", ")}` });
  }
  const lynis = (s.lynis ?? []).join("\n");
  const index = Number(lynis.match(/Hardening index\s*:\s*(\d+)/i)?.[1]);
  if (Number.isFinite(index) && index < 65) add({ severity: index < 50 ? "high" : "medium", rule: "server:lynis-low", title: `Lynis hardening index is ${index} of 100`, detail: "Lynis (installed on the server) rates its hardening low. Run lynis audit system on the server and work through its suggestions.", evidence: lynis.slice(0, 600) });
  if (s.ntp) {
    const t = kv(s.ntp);
    if (t.NTPSynchronized === "no" || t.NTP === "no") add({ category: "functional", severity: "medium", rule: "certin:no-ntp", title: "The server's clock is not synced to NTP", detail: "CERT-In's directions (April 2022) require every system to sync its clock to NTP (the NIC or NPL servers, or ones synced to them), so logs line up in an incident. timedatectl set-ntp true, and point chrony at time.nplindia.org / samay1.nic.in.", evidence: s.ntp.join("\n").slice(0, 300) });
  }
  if (s.logs) {
    const text = s.logs.join("\n");
    const rot = text.match(/\/etc\/logrotate\.d\/r?syslog[^\n]*rotate (\d+)[^\n]*(daily|weekly|monthly)|\/etc\/logrotate\.d\/r?syslog[^\n]*(daily|weekly|monthly)[^\n]*rotate (\d+)/);
    const count = Number(rot?.[1] ?? rot?.[4]);
    const per = (rot?.[2] ?? rot?.[3]) as string | undefined;
    const days = Number.isFinite(count) && per ? count * (per === "daily" ? 1 : per === "weekly" ? 7 : 30) : NaN;
    if (Number.isFinite(days) && days < 180) add({ category: "functional", severity: "medium", rule: "certin:log-retention", title: `System logs are kept about ${days} days, not 180`, detail: "CERT-In requires logs of all systems to be kept for 180 days, inside India. Raise logrotate's rotate count (rotate 26 with weekly = 182 days), or ship logs to a central store kept 180 days.", evidence: text.slice(0, 400) });
  }
  if (s.backups) {
    const files = s.backups.filter((l) => l.startsWith("/"));
    const jobs = Number(kv(s.backups).cron_jobs ?? 0);
    if (!files.length && !jobs) add({ category: "functional", severity: "high", rule: "server:no-backups", title: "No recent backup was found on the server", detail: "No database dump or archive from the last 8 days in the usual folders, and no backup job in cron. If backups go elsewhere (the host's panel, a bucket), check one restores; if not, set up a daily database dump and an off-server copy.", evidence: "Looked in /var/backups, ~/backups, /backup(s); cron for mysqldump, pg_dump, restic, borg, rsync" });
  }
  for (const line of s.mysql ?? []) {
    const [kind, schema, name, n] = line.split("\t");
    if (kind === "nopk") add({ category: "performance", severity: "medium", rule: "db:no-primary-key", title: `Table ${schema}.${name} has no primary key`, detail: "Without a primary key, updates and replication are slow and rows can be duplicated. Add an id primary key.", evidence: `${schema}.${name}: about ${n} rows` });
    else if (kind === "big") add({ category: "performance", severity: "low", rule: "db:huge-table", title: `Table ${schema}.${name} is ${n} MB`, detail: "Very large tables slow backups and queries. Archive old rows (logs, sessions) or partition the table.", evidence: `${schema}.${name}: ${n} MB` });
    else if (kind === "myisam") add({ category: "performance", severity: "low", rule: "db:myisam", title: `Table ${schema}.${name} uses MyISAM`, detail: "MyISAM has no transactions or crash recovery and locks the whole table on writes. Convert it: ALTER TABLE ... ENGINE=InnoDB.", evidence: `${schema}.${name}` });
    else if (kind === "noindex") add({ category: "performance", severity: "medium", rule: "db:missing-index", title: `Table ${schema}.${name} has ${n} rows and no index besides its key`, detail: "Searches on this table read every row. Add indexes for the columns used in WHERE and JOIN (EXPLAIN the slow queries).", evidence: `${schema}.${name}: about ${n} rows` });
    else if (kind === "nofk") add({ category: "functional", severity: "low", rule: "db:no-foreign-keys", title: `Database ${schema} has no foreign keys (${name} tables)`, detail: "Nothing stops orphan rows (an order whose customer was deleted). Add foreign keys for the main relations.", evidence: `${schema}: ${name} tables, no foreign keys` });
    else if (kind === "passcol") add({ severity: "high", rule: "db:plain-passwords", title: `Column ${schema}.${name} looks too short for hashed passwords`, detail: `It holds at most ${n} characters; a bcrypt or Argon2 hash needs 60 or more, so passwords are probably stored in plain text or with a weak hash. Store password_hash() / bcrypt hashes in a VARCHAR(255).`, evidence: `${schema}.${name}: max ${n} characters` });
  }
  const vars = Object.fromEntries((s.mysql ?? []).map((l) => l.split("\t")).filter((p) => p.length === 2));
  if (vars.slow_query_log === "OFF") add({ category: "performance", severity: "low", rule: "db:slow-log-off", title: "MySQL's slow query log is off", detail: "Turn on slow_query_log with long_query_time = 1, so slow queries during a load test can be found.", evidence: "slow_query_log = OFF" });
  const slow = (s.slowlog ?? []).join("\n").trim();
  if (slow) add({ category: "performance", severity: "medium", rule: "db:slow-queries", title: "The slowest database queries on the server", detail: "These queries took the most total time (from MySQL's slow log). EXPLAIN each one and add the index it needs, or cache its result.", evidence: slow.slice(0, 1500) });
  void now;
  return out;
}
