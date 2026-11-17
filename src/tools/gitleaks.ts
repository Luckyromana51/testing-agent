import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gitAuthEnv, isolatedGitEnv } from "../engines/code.js";
import type { Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import { relPath } from "./source.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface Leak {
  RuleID: string;
  Description: string;
  StartLine: number;
  File: string;
  Commit?: string;
  Date?: string;
  Message?: string;
  Fingerprint?: string;
}

/** Gitleaks rule -> the platform's own secret check for the same kind of key. */
const SAME_AS: [RegExp, string][] = [
  [/^aws-/, "code:secret-aws-key"],
  [/^github-/, "code:secret-github-token"],
  [/^stripe-/, "code:secret-stripe-live"],
  [/^private-key$/, "code:secret-private-key"],
  [/^slack-webhook/, "code:secret-slack-webhook"],
  [/^slack-/, "code:secret-slack-token"],
  [/^sendgrid-/, "code:secret-sendgrid-key"],
  [/^twilio-/, "code:secret-twilio-key"],
  [/^gcp-api-key$/, "code:secret-google-api-key"],
  [/^anthropic-/, "code:secret-anthropic-key"],
  [/^openai-/, "code:secret-openai-key"],
  [/^generic-api-key$/, "code:secret-generic"],
];

/** Keys that open payments, clouds or code: a leak is critical. */
const CRITICAL = /^(aws-|gcp-|azure-|github-|gitlab-|stripe-|private-key|anthropic-|openai-|digitalocean-|heroku-|shopify-|razorpay-|paypal-)/;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|fixtures?|examples?|samples?|docs?)\//i;

const NAMES: Record<string, string> = {
  "generic-api-key": "a possible API key or password",
  "aws-access-token": "an AWS access key",
  "github-pat": "a GitHub personal access token",
  "github-fine-grained-pat": "a GitHub access token",
  "private-key": "a private key",
  "gcp-api-key": "a Google API key",
  "jwt": "a login token (JWT)",
  "stripe-access-token": "a Stripe secret key",
  "slack-bot-token": "a Slack bot token",
  "slack-webhook-url": "a Slack webhook address",
  "npm-access-token": "an npm access token",
};
const WORDS: Record<string, string> = { aws: "AWS", api: "API", gcp: "Google Cloud", pat: "access token", jwt: "JWT", npm: "npm", url: "address", ssh: "SSH", oauth: "OAuth", id: "ID" };
/** "an AWS access key", or from the rule id: "twilio-api-key" -> "a Twilio API key". */
export function secretName(ruleId: string): string {
  if (NAMES[ruleId]) return NAMES[ruleId];
  const words = ruleId.split("-").map((w, i) => WORDS[w] ?? (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  return `${/^[AEIOU]/i.test(words) ? "an" : "a"} ${words}`;
}

/**
 * Turns Gitleaks' report into findings: one per rule and file, with the line, never the secret
 * (Gitleaks runs with --redact). A secret found only in an old commit is reported as in the Git
 * history: deleting the file does not remove it, the key has to be changed.
 */
export function readGitleaks(leaks: Leak[], sourceDir: string, currentFiles?: Set<string>): ToolFinding[] {
  const groups = new Map<string, { leak: Leak; file: string; lines: number[]; old: boolean }>();
  for (const l of leaks) {
    const file = relPath(sourceDir, l.File);
    const old = Boolean(currentFiles && l.Commit && !currentFiles.has(`${file}:${l.StartLine}:${l.RuleID}`));
    const k = `${l.RuleID}|${file}|${old}`;
    const g = groups.get(k);
    if (g) g.lines.push(l.StartLine);
    else groups.set(k, { leak: l, file, lines: [l.StartLine], old });
  }
  const out: ToolFinding[] = [];
  for (const { leak, file, lines, old } of groups.values()) {
    const what = secretName(leak.RuleID);
    const test = TEST_FILE.test(file);
    let severity: Severity = CRITICAL.test(leak.RuleID) ? "critical" : leak.RuleID === "generic-api-key" ? "medium" : "high";
    if (test) severity = severity === "critical" ? "high" : "low";
    const same = SAME_AS.find(([re]) => re.test(leak.RuleID))?.[1];
    const first = Math.min(...lines);
    const commit = leak.Commit ? leak.Commit.slice(0, 8) : "";
    out.push({
      category: "security",
      severity,
      rule: `gitleaks:${leak.RuleID}`,
      title: old ? `Git history still holds ${what}` : `Code contains ${what}`,
      detail: old
        ? `${file} line ${first} held ${what} in commit ${commit}${leak.Date ? ` (${leak.Date.slice(0, 10)})` : ""}. It is no longer in the files, but anyone who can read the repository can still read it in the history. Change (rotate) the key now; then remove it from the history if needed.`
        : `${file} line ${first}${lines.length > 1 ? ` (and ${lines.length - 1} more in this file)` : ""} holds ${what}. Change (rotate) the key, move it to an environment variable or a secret store, and remove it from the code.${
            test ? " It is in a test or example file, so it may be a dummy: check." : ""
          }`,
      pageUrl: file,
      evidence: `line ${first}: [hidden]${commit ? ` (commit ${commit})` : ""}`,
      count: lines.length,
      ...(same && !old ? { sameAs: [same], sameScope: "file" as const } : {}),
    });
  }
  return out;
}

async function gitleaks(args: string[], ctx: ToolContext, report: string, config: string): Promise<Leak[]> {
  const res = await runProcess(
    process.env.GITLEAKS_PATH || "gitleaks",
    [...args, "-c", config, "--report-format", "json", "--report-path", report, "--redact", "--no-banner", "--no-color", "--exit-code", "0", "--log-level", "error", "--max-target-megabytes", "5"],
    // The work folder holds no .gitleaksignore, so the project cannot hide its own leaks.
    { signal: ctx.signal, timeoutMs: 600_000, cwd: ctx.workDir, env: isolatedGitEnv() },
  );
  if (res.code !== 0) throw new Error(`Gitleaks stopped: ${lastLine(res.stderr) || `exit code ${res.code}`}`);
  return existsSync(report) ? (JSON.parse((await readFile(report, "utf8")) || "[]") as Leak[]) : [];
}

export const gitleaksTool: Tool = {
  id: "gitleaks",
  name: "Gitleaks",
  maker: "Gitleaks (open source)",
  description: "Finds passwords, API keys and tokens left in the code, and in the Git history if you turn it on.",
  checks: [
    "More than 150 kinds of keys and tokens (cloud, payments, chat, databases, npm, SSH keys)",
    "Old commits too: a key that was deleted still sits in the history",
    "Shows the file and line, never the secret itself",
  ],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "seconds; full history up to a few minutes",
  licence: "MIT",
  homepage: "https://github.com/gitleaks/gitleaks",
  signedIn: "uses-login",
  options: [
    {
      id: "history",
      label: "What to check",
      choices: [
        { value: "files", label: "Current files" },
        { value: "history", label: "Current files and the whole Git history" },
      ],
      default: "files",
      hint: "History needs a Git repository (not a zip) and downloads all of it.",
    },
  ],

  async ready() {
    return (await which(process.env.GITLEAKS_PATH || "gitleaks")) ? null : "Gitleaks is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const src = ctx.sourceDir;
    if (!src) throw new Error("The code was not on disk for the tools.");
    // Gitleaks' own rules, never the project's .gitleaks.toml (which could switch rules off).
    const config = path.join(ctx.workDir, "gitleaks.toml");
    await writeFile(config, 'title = "GLV"\n\n[extend]\nuseDefault = true\n');
    const files = await gitleaks(["dir", src], ctx, path.join(ctx.workDir, "gitleaks-files.json"), config);
    let leaks = files;
    let history: Set<string> | undefined;
    let tested = "Checked the current files";
    const summary: string[] = [];
    if (ctx.options.history === "history") {
      if (!ctx.target.repoUrl || !existsSync(path.join(src, ".git"))) {
        summary.push("History not checked: the code came as a zip, which has no Git history.");
      } else {
        ctx.log("Gitleaks: downloading the full Git history");
        // The clone is shallow; fetch the rest with the same rules as the clone (no server logins).
        const fetched = await runProcess(
          "git",
          ["-c", "credential.helper=", "-c", "core.askPass=true", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-C", src, "fetch", "--unshallow", "--quiet", "--no-tags"],
          {
            signal: ctx.signal,
            timeoutMs: 300_000,
            env: { ...isolatedGitEnv(), ...gitAuthEnv(ctx.target.repoUrl, ctx.login?.kind === "git" ? ctx.login : undefined, {}) },
          },
        );
        if (fetched.code !== 0 && !/not a shallow|complete repository/i.test(fetched.stderr)) {
          throw new Error(`Could not download the Git history: ${lastLine(fetched.stderr)}`);
        }
        const all = await gitleaks(["git", src], ctx, path.join(ctx.workDir, "gitleaks-history.json"), config);
        // A leak still in the files is reported once, as in the files.
        history = new Set(files.map((l) => `${relPath(src, l.File)}:${l.StartLine}:${l.RuleID}`));
        const now = new Set(history);
        leaks = [...files, ...all.filter((l) => !now.has(`${relPath(src, l.File)}:${l.StartLine}:${l.RuleID}`))];
        tested = "Checked the current files and every commit";
      }
    }
    const findings = readGitleaks(leaks, src, history);
    const slim = leaks.map(({ RuleID, Description, File, StartLine, Commit, Date }) => ({ RuleID, Description, File: relPath(src, File), StartLine, Commit, Date }));
    await writeFile(path.join(ctx.outDir, "tool-gitleaks.json"), JSON.stringify(slim, null, 1));
    const old = findings.filter((f) => f.title.startsWith("Git history")).length;
    return {
      findings,
      summary: [`${leaks.length} secret${leaks.length === 1 ? "" : "s"} found${old ? `, ${old} only in old commits` : ""}`, ...summary],
      reports: [{ file: "tool-gitleaks.json", label: "Gitleaks results (JSON, secrets hidden)" }],
      tested,
    };
  },
};
