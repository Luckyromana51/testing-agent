import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { request as playwrightRequest } from "playwright";
import { CODE_AGENTS } from "../agents/code/index.js";
import type { CodeContext, SourceFile } from "../agents/code/context.js";
import { scoreFindings } from "../runner/score.js";
import { validateTarget } from "../runner/urls.js";
import type { Category, Login, PageResult, ScanResult } from "../types.js";
import { gitUser } from "../vault.js";
import { runEngineAgents } from "./agents.js";

const run = promisify(execFile);

export const CODE_CATEGORIES: Category[] = ["security", "functional"];
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 150_000_000;

/** Folders that hold installed or generated code, not the project's own. */
export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".idea",
  ".vscode",
  "Pods",
  ".gradle",
  ".terraform",
  ".cache",
]);

export interface CodeScanOptions {
  repoUrl?: string;
  branch?: string;
  /** Access token for a private repository, from the project's saved login. */
  gitLogin?: Login;
  /** An uploaded zip of the code, instead of a repository. */
  zipFile?: string;
  /** A folder on this machine (command line and CI use only, never from the dashboard). */
  folder?: string;
  workDir: string;
  agents?: string[];
  onProgress?: (message: string) => void;
  /** Stops the clone when the run is cancelled. */
  signal?: AbortSignal;
}

const isBinary = (buf: Uint8Array) => buf.subarray(0, 8000).includes(0);

/** Checks a repository address: https only, public hosts only, no user name or password in it. */
export function validateRepoUrl(raw: string): string {
  const url = validateTarget(raw.trim());
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("Use the https:// address of the repository.");
  if (u.username || u.password) throw new Error("Remove the user name and password from the repository address.");
  return url.replace(/\/$/, "");
}

/**
 * Sends the access token as an HTTP header for the repository's own host only. It never goes into
 * the address, the command line (visible to other processes) or the clone's .git/config.
 */
export function gitAuthEnv(repoUrl: string, login: Login | undefined, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!login?.token) return {};
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  const basic = Buffer.from(`${gitUser(login.username, repoUrl)}:${login.token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: `http.${new URL(repoUrl).origin}/.extraHeader`,
    [`GIT_CONFIG_VALUE_${n}`]: `Authorization: Basic ${basic}`,
  };
}

/**
 * The server's environment without anything that could hand git this server's own logins or
 * settings: credential helpers, askpass programs, SSH agents, and global or system git config
 * (which can hold saved tokens or rewrite addresses to SSH with the server's keys).
 */
export function isolatedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(GIT_CONFIG.*|GIT_ASKPASS|SSH_ASKPASS.*|GIT_SSH.*|SSH_AUTH_SOCK|GIT_CREDENTIAL.*)$/.test(k)) continue;
    out[k] = v;
  }
  return { ...out, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

export async function clone(repoUrl: string, branch: string | undefined, dir: string, login?: Login, signal?: AbortSignal): Promise<string> {
  const args = [
    // Never use this server's own saved Git logins for a client's repository.
    "-c",
    "credential.helper=",
    "-c",
    "core.askPass=true",
    // https only: no local paths, no SSH (which would use this server's keys).
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    ...(branch ? ["--branch", branch] : []),
    "--",
    repoUrl,
    dir,
  ];
  try {
    await run("git", args, {
      timeout: 180_000,
      env: { ...isolatedGitEnv(), ...gitAuthEnv(repoUrl, login, {}) },
      maxBuffer: 10_000_000,
      signal,
    });
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr || (err as Error).message);
    if (/Authentication failed|could not read Username|terminal prompts disabled|not found|403|401/i.test(msg)) {
      throw new Error(
        login?.token
          ? "Could not open the repository with the saved access token. Check the token can read this repository and has not expired, and that the address and branch are right."
          : "Could not open the repository. It may be private, or the address or branch may be wrong. For a private repository, add an access token in the project's login settings.",
      );
    }
    throw new Error(`Could not clone the repository: ${msg.trim().split("\n").pop()}`);
  }
  const { stdout } = await run("git", ["-C", dir, "rev-parse", "--short", "HEAD"]).catch(() => ({ stdout: "" }));
  return stdout.trim();
}

/** Reads a folder into memory, skipping installed packages, build output and binary files. */
async function readTree(root: string) {
  const files: SourceFile[] = [];
  const allPaths: string[] = [];
  const skippedDirs: string[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (allPaths.length >= MAX_FILES) return;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) {
          if (e.name !== ".git") skippedDirs.push(relPath);
          continue;
        }
        await walk(path.join(dir, e.name), relPath);
      } else if (e.isFile()) {
        allPaths.push(relPath);
        const full = path.join(dir, e.name);
        const { size } = await stat(full);
        if (size > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) continue;
        const buf = await readFile(full);
        if (isBinary(buf)) continue;
        total += size;
        files.push({ path: relPath, size, text: buf.toString("utf8") });
      }
    }
  };
  await walk(root, "");
  return { files, allPaths, skippedDirs };
}

/** Reads a zip of source code into memory, without writing any of it to disk. */
export function readZip(data: Uint8Array) {
  const files: SourceFile[] = [];
  const allPaths: string[] = [];
  const skipped = new Set<string>();
  let total = 0;
  const entries = unzipSync(data, {
    filter: (f) => {
      const parts = f.name.split("/");
      const skipAt = parts.slice(0, -1).findIndex((p) => SKIP_DIRS.has(p));
      if (skipAt >= 0) {
        if (parts[skipAt] !== ".git") skipped.add(parts.slice(0, skipAt + 1).join("/"));
        return false;
      }
      if (f.name.endsWith("/") || parts.includes("..") || f.name.startsWith("/")) return false;
      if (allPaths.length >= MAX_FILES) return false;
      allPaths.push(f.name);
      if (f.originalSize > MAX_FILE_BYTES || total + f.originalSize > MAX_TOTAL_BYTES) return false;
      total += f.originalSize;
      return true;
    },
  });
  for (const [name, buf] of Object.entries(entries)) {
    if (isBinary(buf)) continue;
    files.push({ path: name, size: buf.length, text: Buffer.from(buf).toString("utf8") });
  }
  // Most zips hold one top folder ("my-site/..."); drop it so paths start at the project.
  const tops = new Set(allPaths.map((p) => p.split("/")[0]));
  if (tops.size === 1 && allPaths.every((p) => p.includes("/"))) {
    const cut = [...tops][0].length + 1;
    for (const f of files) f.path = f.path.slice(cut);
    allPaths.forEach((p, i) => (allPaths[i] = p.slice(cut)));
    const skippedDirs = [...skipped].map((p) => p.slice(cut));
    return { files, allPaths, skippedDirs };
  }
  return { files, allPaths, skippedDirs: [...skipped] };
}

/** Tests source code offline: leaked secrets, vulnerable packages, risky code and project hygiene. */
export async function scanCode(opts: CodeScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  let tree: Awaited<ReturnType<typeof readTree>>;
  const notes: string[] = [];
  let source: CodeContext["source"];
  let label: string;

  if (opts.zipFile) {
    log("Unpacking the uploaded code");
    source = "zip";
    let data: Buffer;
    try {
      data = await readFile(opts.zipFile);
      tree = readZip(data);
    } catch (err) {
      throw new Error(`Could not open the zip file: ${(err as Error).message}`);
    }
    label = "the uploaded zip";
  } else if (opts.folder) {
    // A working folder: installed packages and a local .env are normal there, as in a zip.
    source = "zip";
    tree = await readTree(opts.folder);
    label = opts.folder;
  } else if (opts.repoUrl) {
    source = "git";
    const repoUrl = validateRepoUrl(opts.repoUrl);
    log(`Cloning ${repoUrl}${opts.branch ? ` (branch ${opts.branch})` : ""}`);
    const dir = path.join(opts.workDir, "repo");
    if (opts.gitLogin?.token) log("Using the saved access token for this repository");
    const commit = await clone(repoUrl, opts.branch, dir, opts.gitLogin, opts.signal);
    tree = await readTree(dir);
    label = `${repoUrl}${opts.branch ? `, branch ${opts.branch}` : ""}${commit ? `, commit ${commit}` : ""}`;
  } else {
    throw new Error("Add a Git repository address or upload a zip of the code.");
  }

  const bytes = tree.files.reduce((s, f) => s + f.size, 0);
  const size = bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
  log(`Read ${tree.files.length} text files (${size})`);
  notes.push(`Tested ${tree.files.length.toLocaleString("en-IN")} text files (${size}) from ${label}.`);
  if (tree.skippedDirs.length) {
    notes.push(`Skipped installed packages and build output: ${tree.skippedDirs.slice(0, 5).join(", ")}${tree.skippedDirs.length > 5 ? " and more" : ""}.`);
  }
  if (tree.allPaths.length >= MAX_FILES) notes.push(`Stopped at ${MAX_FILES.toLocaleString("en-IN")} files.`);

  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.3 (code test)",
  });
  try {
    const ctx: CodeContext = { source, ...tree, request, log, note: (m) => notes.push(m) };
    const selected = opts.agents ? CODE_AGENTS.filter((a) => opts.agents!.includes(a.id)) : CODE_AGENTS.filter((a) => !a.defaultOff);
    const { findings, stats } = await runEngineAgents(selected, ctx, "project", log);
    const real = findings;

    // List the files that have findings, worst first, so the report can show them.
    const byFile = new Map<string, number>();
    for (const f of real) byFile.set(f.pageUrl, (byFile.get(f.pageUrl) ?? 0) + 1);
    const pages: PageResult[] = [...byFile.keys()].map((p) => ({ url: p, status: null, title: p, loadMs: null }));

    // One hole is as bad as many: each distinct code issue takes its full penalty, however few files it is in.
    const score = scoreFindings(real, 1, CODE_CATEGORIES, stats);
    log(`Done: ${tree.files.length} files, ${real.length} findings`);
    return {
      startUrl: opts.repoUrl ?? opts.folder ?? "uploaded zip",
      startedAt,
      finishedAt: new Date().toISOString(),
      pages,
      findings: real,
      ...score,
      agentStats: stats,
      notes,
      label: { pages: "Files" },
      complete: true,
    };
  } finally {
    await request.dispose();
  }
}
