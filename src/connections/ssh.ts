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
