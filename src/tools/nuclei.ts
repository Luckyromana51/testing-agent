import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WEB_PRODUCTS } from "../products.js";
import type { Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface NucleiResult {
  "template-id": string;
  info: {
    name: string;
    severity: string;
    description?: string;
    remediation?: string;
    tags?: string[];
    classification?: { "cve-id"?: string[] | null };
  };
  "matcher-name"?: string;
  "matched-at"?: string;
  host?: string;
  "extracted-results"?: string[];
}

/**
 * Checks that attack the site, flood it, guess passwords, or call other services are never run.
 * Only checks that read pages like a visitor stay: exposed files, wrong settings, admin panels,
 * known-vulnerable versions, TLS and DNS.
 */
export const UNSAFE_TAGS = [
  "intrusive", "dos", "fuzz", "fuzzing", "bruteforce", "brute-force", "default-login", "sqli", "rce", "xss", "lfi", "rfi",
  "ssrf", "injection", "traversal", "oast", "xxe", "ssti", "crlf", "cmdi", "deserialization", "file-upload", "auth-bypass",
  "redirect", "headless", "osint", "token-spray",
];

/** Leaves out every check that sends POST, PUT, PATCH or DELETE (they could change the client's data). */
export const READ_ONLY = "!regex('POST|PUT|PATCH|DELETE', join(',', http_method))";

const SEVERITY: Record<string, Severity> = { critical: "critical", high: "high", medium: "medium", low: "low" };

/** The platform's own exposed-file rules, by path. */
const EXPOSED: [RegExp, string][] = [
  [/\/\.env$/, "sec:exposed-env"],
  [/\/\.git(\/|$)/, "sec:exposed-git"],
  [/wp-config\.php(\.bak|~)$/, "sec:exposed-backup"],
  [/\/(phpinfo|info)\.php$/, "sec:exposed-phpinfo"],
  [/debug\.log$/, "sec:exposed-log"],
  [/\/server-status$/, "sec:exposed-server-status"],
  [/\/\.DS_Store$/, "sec:exposed-ds-store"],
];

const isLocal = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);

/** Turns Nuclei's JSON lines into findings, and the technology it recognised into a list. */
export function readNuclei(lines: string, startUrl: string): { findings: ToolFinding[]; tech: string[] } {
  const findings: ToolFinding[] = [];
  const tech = new Set<string>();
  const seen = new Set<string>();
  for (const line of lines.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let r: NucleiResult;
    try {
      r = JSON.parse(line) as NucleiResult;
    } catch {
      continue;
    }
    const sev = r.info?.severity?.toLowerCase();
    const label = r["matcher-name"] ? `${r.info.name} (${r["matcher-name"]})` : r.info.name;
    if (!SEVERITY[sev]) {
      if ((r.info.tags ?? []).includes("tech")) tech.add(r["matcher-name"] || r.info.name);
      continue;
    }
    const at = r["matched-at"] ?? r.host ?? startUrl;
    const key = `${r["template-id"]}|${r["matcher-name"] ?? ""}|${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pageUrl = /^https?:\/\//.test(at) ? at : startUrl;
    const cves = r.info.classification?.["cve-id"]?.filter(Boolean) ?? [];
    const exposed = EXPOSED.find(([re]) => re.test(pageUrl.split(/[?#]/)[0]))?.[1];
    findings.push({
      category: "security",
      rule: `nuclei:${r["template-id"]}`,
      severity: SEVERITY[sev],
      title: label,
      detail: [
        r.info.description?.trim(),
        r.info.remediation ? `How to fix: ${r.info.remediation.trim()}` : "",
        cves.length ? `Known vulnerability: ${cves.join(", ").toUpperCase()}.` : "",
        `(Nuclei check ${r["template-id"]})`,
      ]
        .filter(Boolean)
        .join(" "),
      pageUrl,
      evidence: [at, ...(r["extracted-results"] ?? []).slice(0, 3)].join("\n"),
      ...(exposed ? { sameAs: [exposed] } : {}),
    });
  }
  return { findings, tech: [...tech] };
}

export const nucleiTool: Tool = {
  id: "nuclei",
  name: "Nuclei",
  maker: "ProjectDiscovery",
  description: "Thousands of community checks for known problems: exposed files and admin panels, wrong server settings, and software versions with known holes (CVEs).",
  checks: [
    "Known vulnerable versions of servers, plugins and frameworks (CVEs)",
    "Exposed config files, backups, logs and admin panels",
    "Wrong settings in servers, cloud storage and DNS",
    "Safe checks only: nothing that attacks, floods or sends data",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "safe",
  takes: "2 to 5 minutes",
  licence: "MIT, free",
  homepage: "https://github.com/projectdiscovery/nuclei",
  signedIn: "public",

  async ready() {
    return (await which(process.env.NUCLEI_PATH || "nuclei")) ? null : "Nuclei is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const url = new URL(ctx.startUrl);
    const env = { ...process.env };
    // Nuclei ignores NO_PROXY, so a proxy would swallow requests to a site on this server.
    if (isLocal(url.hostname)) for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) delete env[k];
    const templates = process.env.NUCLEI_TEMPLATES;
    ctx.log(`Nuclei: safe checks on ${url.origin}`);
    const res = await runProcess(
      process.env.NUCLEI_PATH || "nuclei",
      [
        "-u",
        ctx.startUrl,
        ...(templates ? ["-t", templates] : []),
        "-jsonl",
        "-silent",
        "-nc",
        "-duc",
        "-ni",
        "-or",
        "-ot",
        "-pt",
        "http,ssl,dns",
        "-etags",
        UNSAFE_TAGS.join(","),
        "-tc",
        READ_ONLY,
        "-rl",
        "10",
        "-c",
        "10",
        "-bs",
        "5",
        "-timeout",
        "10",
        "-retries",
        "1",
        "-mhe",
        "20",
      ],
      { signal: ctx.signal, timeoutMs: 900_000, env, cwd: ctx.workDir },
    );
    if (res.code !== 0 && !res.stdout.trim()) {
      const why = lastLine(res.stderr);
      if (/no templates|templates.*not.*(found|installed)/i.test(why)) {
        throw new Error("Nuclei's checks are not downloaded on this server. Run: nuclei -update-templates");
      }
      throw new Error(`Nuclei stopped: ${why || `exit code ${res.code}`}`);
    }
    const { findings, tech } = readNuclei(res.stdout, ctx.startUrl);
    const raw = res.stdout.split("\n").filter((l) => l.trim().startsWith("{"));
    await writeFile(path.join(ctx.outDir, "tool-nuclei.json"), `[${raw.join(",\n")}]`);
    return {
      findings,
      summary: [
        `${findings.length} problem${findings.length === 1 ? "" : "s"} found by the safe checks`,
        ...(tech.length ? [`Recognised: ${tech.slice(0, 12).join(", ")}`] : []),
      ],
      reports: [{ file: "tool-nuclei.json", label: "Nuclei results (JSON)" }],
      tested: `Safe checks on ${url.origin}`,
    };
  },
};
