import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Cloud account posture with Prowler (open source, Apache-2.0): with the client's read-only keys,
 * it reads their AWS, Google Cloud or Azure settings and lists what is unsafe: public storage
 * buckets, security groups open to the world, no MFA on the root or admin users, logging off,
 * unencrypted disks and databases, old access keys. Read-only (the client gives a SecurityAudit /
 * Viewer / Reader role). The keys stay in .env (CONN_ names), never in the database.
 */

export interface CloudFinding {
  title: string;
  severity: Severity;
  resource: string;
  service: string;
  check: string;
  fix: string;
  region?: string;
}

const SEV: Record<string, Severity> = { critical: "critical", high: "high", medium: "medium", low: "low", informational: "info" };

/** Reads Prowler's OCSF JSON output: failed checks only. Pure, for tests. */
export function readProwler(json: string): CloudFinding[] {
  let rows: Record<string, unknown>[];
  try {
    const data = JSON.parse(json) as unknown;
    rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
  } catch {
    rows = json.split("\n").filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const get = (o: unknown, p: string): unknown => p.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
  return rows
    .filter((r) => String(r.status_code ?? r.status ?? "").toUpperCase() === "FAIL")
    .map((r) => ({
      title: String(get(r, "finding_info.title") ?? get(r, "message") ?? "Cloud setting"),
      severity: SEV[String(r.severity ?? "").toLowerCase()] ?? "medium",
      resource: String(get(r, "resources.0.uid") ?? get(r, "resources.0.name") ?? ""),
      service: String(get(r, "resources.0.group.name") ?? get(r, "metadata.event_code") ?? ""),
      check: String(get(r, "metadata.event_code") ?? get(r, "finding_info.uid") ?? ""),
      fix: String(get(r, "remediation.desc") ?? ""),
      region: (get(r, "cloud.region") as string | undefined) ?? undefined,
    }))
    .filter((f) => f.severity !== "info");
}

/** The environment Prowler needs for a provider, from CONN_<prefix>_… lines in .env. Pure, for tests. */
export function cloudEnv(provider: string, prefix: string, env: NodeJS.ProcessEnv): { env: Record<string, string>; args: string[]; missing: string[] } {
  const need: Record<string, string[]> = {
    aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    azure: ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET"],
    gcp: ["GOOGLE_APPLICATION_CREDENTIALS"],
  };
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of need[provider] ?? []) {
    const v = env[`${prefix}_${k}`];
    if (v) out[k] = v;
    else missing.push(`${prefix}_${k}`);
  }
  const token = env[`${prefix}_AWS_SESSION_TOKEN`];
  if (provider === "aws" && token) out.AWS_SESSION_TOKEN = token;
  const args = provider === "azure" ? ["azure", "--sp-env-auth"] : provider === "gcp" ? ["gcp"] : ["aws"];
  return { env: out, args, missing };
}

export const cloudTool: Tool = {
  id: "cloud",
  name: "Cloud account posture",
  maker: "Prowler (open source)",
  description:
    "With the client's read-only cloud keys, reads their AWS, Google Cloud or Azure account and lists what is unsafe: public buckets, firewalls open to the world, no MFA, logging off, unencrypted storage and databases, old keys. Nothing is changed.",
  checks: ["Public storage buckets and snapshots", "Security groups / firewall rules open to 0.0.0.0/0 (SSH, RDP, databases)", "Root and admin users without MFA, old access keys", "Logging (CloudTrail, audit logs) and encryption off", "Read-only keys from .env (CONN_ names), never stored in the database"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api", "code"],
  category: "security",
  safety: "safe",
  takes: "5 to 30 minutes",
  licence: "Apache-2.0",
  homepage: "https://github.com/prowler-cloud/prowler",
  signedIn: "public",
  options: [
    { id: "provider", label: "Cloud", choices: [{ value: "aws", label: "AWS" }, { value: "gcp", label: "Google Cloud" }, { value: "azure", label: "Azure" }], default: "aws" },
    { id: "keys", label: "Key names in .env", kind: "text", required: true, pattern: "^CONN_[A-Z0-9_]{2,60}$", placeholder: "CONN_ACME", hint: "AWS: CONN_ACME_AWS_ACCESS_KEY_ID and CONN_ACME_AWS_SECRET_ACCESS_KEY (a SecurityAudit user). GCP: CONN_ACME_GOOGLE_APPLICATION_CREDENTIALS (path to a Viewer key file). Azure: CONN_ACME_AZURE_CLIENT_ID, _TENANT_ID, _CLIENT_SECRET (Reader).", choices: [], default: "" },
    { id: "severity", label: "Lowest severity", choices: [{ value: "high", label: "High and critical" }, { value: "medium", label: "Medium and up" }, { value: "low", label: "Everything" }], default: "medium" },
  ],
  async ready() {
    return (await which(process.env.PROWLER_PATH || "prowler")) ? null : "Prowler is not installed on this server.";
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const provider = ctx.options.provider || "aws";
    const prefix = ctx.options.keys ?? "";
    const { env, args, missing } = cloudEnv(provider, prefix, process.env);
    if (missing.length) throw new Error(`Add ${missing.join(", ")} to .env and restart, then run again.`);
    const out = path.join(ctx.workDir, "prowler");
    const levels = { high: ["critical", "high"], medium: ["critical", "high", "medium"], low: ["critical", "high", "medium", "low"] }[ctx.options.severity as "high" | "medium" | "low"] ?? ["critical", "high", "medium"];
    ctx.log(`Prowler: reading the ${provider.toUpperCase()} account (read-only)`);
    const res = await runProcess(process.env.PROWLER_PATH || "prowler", [...args, "--output-formats", "json-ocsf", "--output-directory", out, "--severity", ...levels, "--no-banner", "--ignore-exit-code-3"], {
      signal: ctx.signal,
      timeoutMs: 45 * 60_000,
      cwd: ctx.workDir,
      env: { PATH: process.env.PATH, HOME: ctx.workDir, ...env },
    });
    const files = (await readdir(out).catch(() => [])).filter((f) => f.endsWith(".json"));
    if (!files.length) throw new Error(`Prowler did not finish: ${lastLine(res.stderr) || `exit code ${res.code}`}`);
    const raw = await readFile(path.join(out, files[0]), "utf8");
    const found = readProwler(raw);
    await writeFile(path.join(ctx.outDir, "tool-cloud.json"), raw);
    const findings: ToolFinding[] = found.slice(0, 500).map((f) => ({
      category: "security",
      rule: `cloud:${f.check || "setting"}`,
      severity: f.severity,
      title: f.title,
      detail: `${f.fix || "See Prowler's report for how to fix this setting."}${f.region ? ` (region ${f.region})` : ""}`,
      pageUrl: `${provider}://${f.resource || "account"}`,
      evidence: `${f.service ? `${f.service}: ` : ""}${f.resource}`,
      key: `cloud:${f.check}:${f.resource}`,
    }));
    const by = found.reduce<Record<string, number>>((m, f) => ((m[f.severity] = (m[f.severity] ?? 0) + 1), m), {});
    return {
      findings,
      summary: [`${found.length} failed ${provider.toUpperCase()} checks: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`],
      reports: [{ file: "tool-cloud.json", label: "Prowler results (OCSF JSON)" }],
      tested: `The ${provider.toUpperCase()} account behind ${prefix}`,
    };
  },
};
