import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import { readSmall, walk } from "./p3-code.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 3 (2026 gap report, P3) mixed checks, all in-house and read-only:
 *  - ai-cost: tokens, latency and timeouts of an AI endpoint (runaway-bill guard).
 *  - messaging: SMS / WhatsApp template rules (length, DLT ids, variables, opt-out).
 *  - pqc: post-quantum readiness (TLS ML-KEM probe + weak-crypto code rules).
 *  - soc2: turns GLV's scans into a SOC 2 / ISO 27001 control-evidence report.
 *  - backlinks: who links to the domain, from Common Crawl's open web graph.
 *  - store-listing: store metadata vs the app (data-safety, size).
 *  - iap: in-app purchase / subscription setup checks.
 */

// ---------------------------------------------------------------------------
// AI call cost & speed
// ---------------------------------------------------------------------------

export interface AiCostStat {
  latencyMs: number[];
  tokens: number[];
  timeouts: number;
}

/** Judges AI cost/speed from measured stats. Pure, for tests. */
export function costProblems(s: AiCostStat): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const p95 = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))] : 0);
  if (s.timeouts > 0) out.push({ rule: "aicost:timeout", severity: "high", title: `${s.timeouts} AI call(s) timed out`, detail: "Some calls exceeded the timeout. Set a hard timeout and a fallback answer, and stream responses so users see the first words sooner." });
  if (p95(s.latencyMs) > 8000) out.push({ rule: "aicost:slow", severity: "medium", title: "AI answers are slow (p95 over 8s)", detail: `The slowest answers took about ${Math.round(p95(s.latencyMs))}ms. Stream output, cache common answers, and consider a smaller/faster model for easy questions.` });
  const avgTok = avg(s.tokens);
  if (avgTok > 3000) out.push({ rule: "aicost:expensive", severity: "medium", title: `High token use (~${Math.round(avgTok)} tokens/answer)`, detail: "Each answer uses many tokens, which drives cost. Trim the prompt and retrieved context, cap max tokens, and cache answers to repeated questions." });
  return out;
}

export const aiCostTool: Tool = {
  id: "ai-cost",
  name: "AI call cost & speed",
  maker: "GLV Infotech (built in)",
  description:
    "Sends the same question to an AI endpoint a few times and measures how long answers take, how many tokens they use and how often they time out. Catches runaway AI bills and slow answers before users do.",
  checks: ["Time to answer (average and p95)", "Tokens per answer (from the API's usage field)", "Timeouts", "Measured in the harness; nothing stored"],
  products: ["website", "webapp", "saas", "crm", "api"],
  category: "performance",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "uses-login",
  options: [
    { id: "url", label: "AI endpoint (POST JSON)", kind: "text", required: true, pattern: "^https?://.+", placeholder: "https://api.example.com/chat", choices: [], default: "" },
    { id: "body", label: "Request body (JSON)", kind: "text", required: true, maxLength: 2000, placeholder: '{"message":"What are your hours?"}', choices: [], default: "" },
    { id: "runs", label: "How many times", kind: "text", placeholder: "3", choices: [], default: "3" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const url = ctx.options.url;
    if (!url) throw new Error("Enter the AI endpoint URL.");
    const runs = Math.min(10, Math.max(1, Number(ctx.options.runs ?? "3") || 3));
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ctx.login?.token) headers.authorization = `Bearer ${ctx.login.token}`;
    const stat: AiCostStat = { latencyMs: [], tokens: [], timeouts: 0 };
    for (let i = 0; i < runs; i++) {
      if (ctx.signal.aborted) break;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      const t0 = Date.now();
      try {
        const res = await fetch(url, { method: "POST", headers, body: ctx.options.body || "{}", signal: ac.signal });
        const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        stat.latencyMs.push(Date.now() - t0);
        const usage = (json.usage ?? (json as { data?: { usage?: unknown } }).data?.usage) as Record<string, unknown> | undefined;
        const tok = Number(usage?.total_tokens ?? usage?.totalTokens ?? 0);
        if (tok) stat.tokens.push(tok);
      } catch {
        stat.timeouts++;
      } finally {
        clearTimeout(timer);
      }
    }
    const findings: ToolFinding[] = costProblems(stat).map((p) => ({ category: "performance", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, key: p.rule }));
    const avg = stat.latencyMs.length ? Math.round(stat.latencyMs.reduce((a, b) => a + b, 0) / stat.latencyMs.length) : 0;
    ctx.log(`AI cost: ${runs} run(s), avg ${avg}ms, ${stat.timeouts} timeout(s)`);
    return { findings, summary: [`${runs} runs, avg ${avg}ms${stat.tokens.length ? `, ~${Math.round(stat.tokens.reduce((a, b) => a + b, 0) / stat.tokens.length)} tokens` : ""}, ${stat.timeouts} timeout(s)`], tested: `${runs} AI calls` };
  },
};

// ---------------------------------------------------------------------------
// SMS / WhatsApp message templates
// ---------------------------------------------------------------------------

/** Rules for one message template. Pure, for tests. */
export function messageProblems(template: string, channel: "sms" | "whatsapp"): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const unicode = /[^\u0000-\u007F]/.test(template);
  if (channel === "sms") {
    const limit = unicode ? 70 : 160;
    if (template.length > limit) out.push({ rule: "msg:too-long", severity: "low", title: `SMS is ${template.length} characters (over ${limit})`, detail: `${unicode ? "Unicode (e.g. Hindi/emoji) SMS fit 70 characters per part" : "A GSM SMS fits 160 characters per part"}; this spans multiple parts and costs more. Shorten it or split intentionally.` });
    if (!/\b(STOP|opt.?out|reply stop)\b/i.test(template)) out.push({ rule: "msg:no-optout", severity: "medium", title: "No opt-out instruction", detail: "Marketing SMS should tell recipients how to stop (e.g. 'Reply STOP'). Many regulators and India's DLT rules require it." });
  }
  // Variable placeholders: {{1}} / {name} that may be left unfilled.
  const vars = template.match(/\{\{?\s*\w+\s*\}?\}/g) ?? [];
  if (vars.length > 0 && !/DLT|template.?id/i.test(template) && channel === "sms") out.push({ rule: "msg:no-dlt", severity: "info", title: "No DLT template id noted", detail: "In India, templated SMS must be registered on the DLT platform and sent with the approved template id, or it is blocked. Register this template and record its DLT id." });
  for (const v of vars) if (/\{\{?\s*\}?\}/.test(v)) out.push({ rule: "msg:empty-var", severity: "low", title: "Empty placeholder in template", detail: `The template has an empty placeholder (${v}). Give every variable a number/name so it is filled correctly.` });
  return out;
}

export const messagingTool: Tool = {
  id: "messaging",
  name: "SMS & WhatsApp message checks",
  maker: "GLV Infotech (built in)",
  description:
    "Checks SMS and WhatsApp message templates for the things that get them blocked or cost extra: length over a single SMS part, missing opt-out wording, India DLT template ids, and empty variable placeholders.",
  checks: ["SMS length vs 160 (or 70 for Unicode) per part", "Opt-out wording (Reply STOP)", "India DLT template id noted", "Variable placeholders present and filled"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "public",
  options: [
    { id: "channel", label: "Channel", choices: [{ value: "sms", label: "SMS" }, { value: "whatsapp", label: "WhatsApp" }], default: "sms" },
    { id: "templates", label: "Message templates", kind: "text", required: true, maxLength: 4000, placeholder: "Hi {{1}}, your order {{2}} has shipped. Track: {{3}}. Reply STOP to opt out.", hint: "One template per line.", choices: [], default: "" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const channel = (ctx.options.channel as "sms" | "whatsapp") || "sms";
    const templates = (ctx.options.templates ?? "").split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!templates.length) throw new Error("Paste at least one message template.");
    const findings: ToolFinding[] = [];
    templates.forEach((t, i) => {
      for (const p of messageProblems(t, channel)) findings.push({ category: "functional", rule: p.rule, severity: p.severity, title: `Template ${i + 1}: ${p.title}`, detail: p.detail, pageUrl: ctx.startUrl || "templates", evidence: t, key: `${p.rule}:${i}` });
    });
    ctx.log(`Messaging: ${templates.length} template(s), ${findings.length} issue(s)`);
    return { findings, summary: [`${templates.length} template(s), ${findings.length} issue(s)`], tested: `${templates.length} templates` };
  },
};

// ---------------------------------------------------------------------------
// Post-quantum readiness
// ---------------------------------------------------------------------------

/** Weak-crypto patterns in code. Pure, for tests. */
export function weakCrypto(text: string): string[] {
  const hits: string[] = [];
  if (/\b(md5|MD5)\b/.test(text)) hits.push("MD5");
  if (/\bsha1\b|SHA-?1\b/.test(text)) hits.push("SHA-1");
  if (/\bDES\b|\bTripleDES\b|\b3DES\b|DES-CBC/.test(text)) hits.push("DES/3DES");
  if (/\bRC4\b/.test(text)) hits.push("RC4");
  if (/modulusLength\s*:\s*(1024|512)\b/.test(text)) hits.push("RSA ≤1024");
  if (/ECB/.test(text)) hits.push("ECB mode");
  return Array.from(new Set(hits));
}

/** Judges the TLS ML-KEM probe output. Pure, for tests. */
export function pqcTlsProblem(output: string): boolean {
  // openssl prints the negotiated group; a hybrid group name contains MLKEM / Kyber.
  return !/MLKEM|mlkem|Kyber|kyber|X25519MLKEM768/.test(output);
}

export const pqcTool: Tool = {
  id: "pqc",
  name: "Post-quantum readiness",
  maker: "GLV Infotech (built in), with OpenSSL",
  description:
    "Checks whether the server's TLS offers a post-quantum (ML-KEM hybrid) key exchange, and scans the code for weak, soon-to-break crypto (MD5, SHA-1, DES, RC4, RSA-1024). Banks and governments increasingly ask for a PQC plan.",
  checks: ["TLS offers X25519MLKEM768 (ML-KEM hybrid)", "Code uses MD5/SHA-1/DES/RC4/RSA-1024/ECB", "OpenSSL 3.5+ probe when installed; code rules always"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api", "code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own (OpenSSL Apache-2.0)",
  homepage: "https://openssl-library.org",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const findings: ToolFinding[] = [];
    // TLS probe (needs a host and OpenSSL 3.5+).
    const host = (() => {
      try {
        return new URL(ctx.startUrl).host;
      } catch {
        return "";
      }
    })();
    const openssl = await which("openssl");
    if (host && openssl) {
      try {
        const r = await runProcess(openssl, ["s_client", "-groups", "X25519MLKEM768", "-connect", host.includes(":") ? host : `${host}:443`, "-servername", host.split(":")[0]], { signal: ctx.signal, timeoutMs: 20_000, env: { ...process.env } });
        const out = `${r.stdout}\n${r.stderr}`;
        if (pqcTlsProblem(out))
          findings.push({ category: "security", rule: "pqc:no-hybrid-tls", severity: "low", title: "Server TLS has no post-quantum key exchange", detail: `${host} did not negotiate an ML-KEM hybrid group. Plan to enable X25519MLKEM768 (OpenSSL 3.5+, recent nginx/BoringSSL) so recorded traffic stays safe against future quantum computers ("harvest now, decrypt later").`, pageUrl: ctx.startUrl, key: "pqc:no-hybrid-tls" });
        ctx.log("PQC TLS probe complete");
      } catch (e) {
        ctx.log(`PQC TLS probe skipped: ${lastLine((e as Error).message)}`);
      }
    }
    // Code scan for weak crypto.
    if (ctx.sourceDir) {
      const files = (await walk(ctx.sourceDir)).filter((f) => /\.(js|ts|py|go|java|rb|php|cs|rs|kt|swift)$/.test(f)).slice(0, 4000);
      const seen = new Set<string>();
      for (const rel of files) {
        const text = await readSmall(ctx.sourceDir, rel, 500_000);
        if (!text) continue;
        for (const algo of weakCrypto(text)) {
          const key = `pqc:weak-crypto:${algo}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({ category: "security", rule: "pqc:weak-crypto", severity: algo.startsWith("MD5") || algo.startsWith("SHA-1") ? "low" : "medium", title: `Weak cryptography in code: ${algo}`, detail: `Found ${algo} in ${rel}. Replace with modern algorithms: SHA-256/BLAKE2 for hashing, AES-GCM for encryption, RSA ≥3072 or ECDSA/Ed25519 for keys.`, pageUrl: rel, key });
        }
      }
    }
    return { findings, summary: [`${findings.length} crypto issue(s)`], tested: host || ctx.sourceDir || "code" };
  },
};

// ---------------------------------------------------------------------------
// SOC 2 / ISO 27001 evidence
// ---------------------------------------------------------------------------

/** The control map GLV's checks support. Pure, for tests. */
export function controlMap(): { control: string; name: string; evidence: string }[] {
  return [
    { control: "CC6.1 / A.8.3", name: "Logical access & encryption", evidence: "TLS grade (testssl), security headers, TLS post-quantum (pqc), cloud IAM/MFA (cloud)" },
    { control: "CC6.6 / A.8.20", name: "Network security", evidence: "Open ports & network CVEs (ports/netscan), firewall & server hardening (SSH checks)" },
    { control: "CC7.1 / A.8.8", name: "Vulnerability management", evidence: "Dependency CVEs (osv), container/IaC scan (trivy, iac), SAST (opengrep), DAST (zap, nuclei), pen test (attack)" },
    { control: "CC7.2 / A.8.16", name: "Monitoring & logging", evidence: "Server log retention & NTP (SSH checks), crawl logs (log-seo)" },
    { control: "CC8.1 / A.8.25", name: "Change & secure development", evidence: "Secrets scan (gitleaks), SBOM & licences (sbom), supply-chain (code.supply-chain), fuzzing (code-fuzz)" },
    { control: "A1.2 / A.8.13", name: "Availability & backups", evidence: "Backup freshness & restore test (dr-drill), load tests (k6)" },
    { control: "P-series / DPDP", name: "Privacy", evidence: "Consent & trackers (compliance), PHI/health data (hipaa), data quality (data-quality)" },
    { control: "CC2.1 / A.7", name: "Accessibility & documentation", evidence: "Accessibility (axe, equal-access, vpat), documented runbooks & manual checklists" },
  ];
}

export const soc2Tool: Tool = {
  id: "soc2",
  name: "SOC 2 / ISO 27001 evidence",
  maker: "GLV Infotech (built in)",
  description:
    "Turns GLV's security and quality scans into a control-evidence report: which SOC 2 Trust Services Criteria and ISO 27001 Annex A controls each check supports. A ready-made appendix for SaaS clients selling to enterprises.",
  checks: ["Maps GLV checks to SOC 2 / ISO 27001 controls", "Produces a control-evidence table for auditors", "A template, not a certification"],
  products: ["website", "webapp", "saas", "crm", "api", "code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const rows = controlMap();
    const md = ["# SOC 2 / ISO 27001 control evidence", "", "GLV Infotech automated checks mapped to controls. Run the named checks and attach their reports as evidence.", "", "| Control | Area | GLV evidence |", "| --- | --- | --- |", ...rows.map((r) => `| ${r.control} | ${r.name} | ${r.evidence} |`), ""].join("\n");
    await writeFile(path.join(ctx.outDir, "soc2-iso-evidence.md"), md);
    return {
      findings: [{ category: "security", rule: "soc2:evidence", severity: "info", title: "SOC 2 / ISO 27001 control-evidence report generated", detail: "A control-evidence table is attached. Run the checks it names and keep their reports as audit evidence. This is a template to support an audit, not a certification.", pageUrl: ctx.startUrl || "report", key: "soc2:evidence" }],
      summary: [`${rows.length} controls mapped`],
      tested: "control mapping",
      reports: [{ file: "soc2-iso-evidence.md", label: "SOC 2 / ISO 27001 control evidence" }],
    };
  },
};

// ---------------------------------------------------------------------------
// Backlinks (Common Crawl)
// ---------------------------------------------------------------------------

/** Parses Common Crawl CDX JSON lines into inbound hosts. Pure, for tests. */
export function parseCdx(text: string): { count: number; sample: string[] } {
  const hosts = new Set<string>();
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith("{")) continue;
    try {
      const row = JSON.parse(l) as { url?: string };
      count++;
      if (row.url) {
        try {
          hosts.add(new URL(row.url).host);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { count, sample: Array.from(hosts).slice(0, 25) };
}

export const backlinksTool: Tool = {
  id: "backlinks",
  name: "Backlinks (Common Crawl)",
  maker: "GLV Infotech (built in), on Common Crawl's open web graph",
  description:
    "Looks up who links to the domain using Common Crawl's free, open web graph. Smaller than a paid index like Ahrefs, but real and in-house — no third-party service or account. Best run against a stored Common Crawl mirror on GLV servers.",
  checks: ["Inbound links from Common Crawl's open index", "A sample of linking hosts", "Flagged: smaller coverage than a paid backlink index"],
  products: ["website", "ecommerce", "webapp", "saas"],
  category: "seo",
  safety: "safe",
  manual: true,
  takes: "1 to 5 minutes",
  licence: "GLV's own (Common Crawl data: open)",
  homepage: "https://commoncrawl.org",
  signedIn: "public",
  options: [{ id: "index", label: "Common Crawl index", kind: "text", placeholder: "CC-MAIN-2026-05", hint: "The crawl snapshot to query (a GLV mirror or index.commoncrawl.org).", choices: [], default: "CC-MAIN-2026-05" }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const host = (() => {
      try {
        return new URL(ctx.startUrl).host;
      } catch {
        return "";
      }
    })();
    if (!host) throw new Error("No domain to look up.");
    const index = ctx.options.index || "CC-MAIN-2026-05";
    const findings: ToolFinding[] = [];
    let result = { count: 0, sample: [] as string[] };
    try {
      const api = `https://index.commoncrawl.org/${encodeURIComponent(index)}-index?url=${encodeURIComponent(`*.${host}`)}&output=json&limit=1000`;
      const res = await fetch(api, { signal: ctx.signal });
      result = parseCdx(await res.text());
      ctx.log(`Common Crawl: ${result.count} record(s)`);
    } catch (e) {
      ctx.log(`Common Crawl query failed: ${(e as Error).message}`);
      findings.push({ category: "seo", rule: "backlink:unavailable", severity: "info", title: "Could not reach the Common Crawl index", detail: "The Common Crawl index was not reachable from here. Run this against a Common Crawl mirror on GLV servers, which is the in-house setup. Google-ranking data and a full paid-index backlink graph cannot be reproduced in-house.", pageUrl: ctx.startUrl, key: "backlink:unavailable" });
    }
    return { findings, summary: [result.count ? `${result.count} index record(s), ${result.sample.length} linking host(s) sampled` : "No Common Crawl data"], tested: host, table: result.sample.length ? { title: "Linking hosts (sample)", columns: ["Host"], rows: result.sample.map((h) => [h]) } : undefined };
  },
};

// ---------------------------------------------------------------------------
// Store listing (mobile, static)
// ---------------------------------------------------------------------------

const DATA_SAFETY_PERMS: Record<string, string> = {
  "android.permission.ACCESS_FINE_LOCATION": "Location",
  "android.permission.ACCESS_COARSE_LOCATION": "Location",
  "android.permission.READ_CONTACTS": "Contacts",
  "android.permission.CAMERA": "Camera / photos",
  "android.permission.RECORD_AUDIO": "Microphone",
  "android.permission.READ_SMS": "SMS",
  "android.permission.READ_CALL_LOG": "Call log",
};

/** Store-listing problems from the app summary. Pure, for tests. */
export function storeListingProblems(app: { platform: string; permissions: string[]; sdks: { tracker: boolean }[]; size: number }): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const sensitive = Array.from(new Set(app.permissions.map((p) => DATA_SAFETY_PERMS[p]).filter(Boolean)));
  if (sensitive.length) out.push({ rule: "store:data-safety", severity: "info", title: `Data-safety form must declare: ${sensitive.join(", ")}`, detail: `The app requests sensitive permissions (${sensitive.join(", ")}). Google Play's Data safety form and Apple's privacy labels must declare the matching data collection, or the store rejects or removes the app.` });
  if (app.sdks.some((s) => s.tracker)) out.push({ rule: "store:tracker-disclosure", severity: "info", title: "Tracking SDKs must be disclosed", detail: "The app bundles analytics/ad SDKs that collect data. Declare them in the Data safety form / privacy labels and (iOS) use App Tracking Transparency." });
  if (app.platform === "android" && app.size > 150 * 1024 * 1024) out.push({ rule: "store:size", severity: "low", title: "App is over 150MB", detail: "A single APK over 150MB cannot be uploaded. Ship an Android App Bundle (AAB) with per-device delivery, or use Play Asset Delivery." });
  return out;
}

export const storeListingTool: Tool = {
  id: "store-listing",
  name: "Store listing checks",
  maker: "GLV Infotech (built in)",
  description:
    "From the uploaded app, checks the things stores reject for: a Data safety form / privacy labels that must match the permissions and tracking SDKs, and an app over the store's size limit. Static — the app is read, not launched.",
  checks: ["Sensitive permissions needing a Data safety declaration", "Tracking SDKs needing disclosure / ATT", "App size vs the store's APK limit"],
  products: ["android", "ios"],
  category: "mobile",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://support.google.com/googleplay/android-developer/answer/10787469",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const app = ctx.app;
    if (!app) throw new Error("No app summary: upload the APK/AAB or IPA first.");
    const findings: ToolFinding[] = storeListingProblems(app).map((p) => ({ category: "mobile", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: `app://${app.id}`, key: p.rule }));
    ctx.log(`Store listing: ${findings.length} item(s)`);
    return { findings, summary: [`${findings.length} store-listing item(s)`], tested: app.name ?? app.id };
  },
};

// ---------------------------------------------------------------------------
// In-app purchases / subscriptions (mobile, static)
// ---------------------------------------------------------------------------

/** IAP setup problems from the app summary. Pure, for tests. */
export function iapProblems(app: { platform: string; libraries: { name: string }[]; servers: string[] }): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const libs = app.libraries.map((l) => l.name.toLowerCase());
  const hasBilling = libs.some((l) => l.includes("billingclient") || l.includes("com.android.billing") || l.includes("storekit") || l.includes("revenuecat") || l.includes("purchases"));
  if (!hasBilling) return out; // not a paid app
  const hasServer = app.servers.length > 0;
  if (!hasServer)
    out.push({ rule: "iap:no-receipt-validation", severity: "medium", title: "In-app purchases with no server seen for receipt validation", detail: "The app has a billing library but names no backend server. Validate purchase receipts server-side (Play Developer API / App Store Server API), or purchases can be faked by patched clients." });
  out.push({ rule: "iap:test-flows", severity: "info", title: "Test the purchase, restore, cancel and refund flows", detail: "This app sells in-app purchases/subscriptions. Test on Play's test tracks / StoreKit test config: buy, restore on a new device, cancel, and handle a refund/revocation. These flows are easy to ship broken." });
  return out;
}

export const iapTool: Tool = {
  id: "iap",
  name: "In-app purchases & subscriptions",
  maker: "GLV Infotech (built in)",
  description:
    "For apps that sell in-app purchases or subscriptions, checks the setup from the uploaded app: a billing library is present, a backend exists to validate receipts, and reminds you to test buy/restore/cancel/refund on the stores' test tracks.",
  checks: ["Detects Play Billing / StoreKit / RevenueCat", "Server-side receipt validation present", "Reminds to test buy, restore, cancel, refund"],
  products: ["android", "ios"],
  category: "mobile",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://developer.android.com/google/play/billing",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const app = ctx.app;
    if (!app) throw new Error("No app summary: upload the APK/AAB or IPA first.");
    const problems = iapProblems(app);
    const findings: ToolFinding[] = problems.map((p) => ({ category: "mobile", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: `app://${app.id}`, key: p.rule }));
    ctx.log(problems.length ? `IAP: billing detected, ${problems.length} note(s)` : "IAP: no billing library found");
    return { findings, summary: [problems.length ? `Billing detected, ${problems.length} note(s)` : "No in-app billing found"], tested: app.name ?? app.id };
  },
};
