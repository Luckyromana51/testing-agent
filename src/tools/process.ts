import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Thrown when a tool runs past its time limit. */
export class ToolTimeout extends Error {}

/**
 * Runs a tool as its own process group, so a time limit or a cancelled run stops the tool and
 * everything it started (testssl.sh runs hundreds of openssl processes, Lighthouse its browser).
 * Output is capped, so a chatty tool cannot fill the server's memory.
 */
export function runProcess(
  cmd: string,
  args: string[],
  opts: { signal: AbortSignal; timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv; maxOutput?: number },
): Promise<ProcessResult> {
  const max = opts.maxOutput ?? 50_000_000;
  return new Promise((resolve, reject) => {
    opts.signal.throwIfAborted();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const kill = (err: Error) => {
      failure ??= err;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < max) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 200_000) stderr += d.toString();
    });
    const timer = setTimeout(
      () => kill(new ToolTimeout(`stopped after ${Math.round(opts.timeoutMs / 60000) || 1} minutes, its time limit`)),
      opts.timeoutMs,
    );
    const onAbort = () => kill(opts.signal.reason instanceof Error ? opts.signal.reason : new Error("Cancelled"));
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (code) => {
      done();
      if (failure) reject(failure);
      else resolve({ code, stdout, stderr });
    });
  });
}

/** Full path of a program on PATH, or null when it is not installed. */
export async function which(name: string): Promise<string | null> {
  if (name.includes("/")) return (await executable(name)) ? name : null;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (await executable(full)) return full;
  }
  return null;
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The last useful line of a tool's error output, for the report. */
export function lastLine(text: string): string {
  const lines = text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.reverse().find((l) => /error|fail|cannot|could not|unable|refused|denied/i.test(l)) ?? lines[0] ?? "";
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}
