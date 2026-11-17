import { writeFile } from "node:fs/promises";
import path from "node:path";
import { WEB_PRODUCTS } from "../products.js";
import type { Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface ZapAlert {
  pluginId: string;
  name: string;
  alert?: string;
  risk: string;
  confidence: string;
  url: string;
  param?: string;
  evidence?: string;
  description?: string;
  solution?: string;
  reference?: string;
  cweid?: string;
  method?: string;
}

const RISK: Record<string, Severity> = { High: "high", Medium: "medium", Low: "low" };

/** ZAP's passive rules that the platform's own security checks also run. */
export const ZAP_SAME_AS: Record<string, string[]> = {
  "10038": ["sec:csp-missing"],
  "10020": ["sec:clickjacking"],
  "10021": ["sec:nosniff-missing"],
  "10035": ["sec:hsts-missing"],
  "10036": ["sec:version-disclosure"],
  "10037": ["sec:version-disclosure"],
  "10010": ["sec:cookie-flags"],
  "10011": ["sec:cookie-flags"],
  "10040": ["sec:mixed-content"],
  "10041": ["sec:form-over-http"],
};

const MAX_URLS = 60;

/** Turns ZAP alerts into findings: one per rule per page, without the low-confidence guesses. */
export function readZap(alerts: ZapAlert[]): ToolFinding[] {
  const groups = new Map<string, { a: ZapAlert; params: string[]; count: number }>();
  for (const a of alerts) {
    if (!RISK[a.risk] || a.confidence === "Low" || a.confidence === "False Positive") continue;
    const page = a.url.split("#")[0];
    const key = `${a.pluginId}|${page}`;
    const g = groups.get(key) ?? { a, params: [], count: 0 };
    g.count++;
    const p = [a.param, a.evidence].filter(Boolean).join(": ");
    if (p && g.params.length < 5 && !g.params.includes(p)) g.params.push(p);
    groups.set(key, g);
  }
  return [...groups.values()].map(({ a, params, count }) => ({
    category: "security",
    rule: `zap:${a.pluginId}`,
    severity: RISK[a.risk],
    title: a.name || a.alert || `ZAP rule ${a.pluginId}`,
    detail: [
      a.description?.trim(),
      a.solution ? `How to fix: ${a.solution.trim()}` : "",
      a.cweid && a.cweid !== "-1" && a.cweid !== "0" ? `(CWE-${a.cweid}, OWASP ZAP rule ${a.pluginId})` : `(OWASP ZAP rule ${a.pluginId})`,
    ]
      .filter(Boolean)
      .join(" "),
    pageUrl: a.url.split("#")[0],
    ...(params.length ? { evidence: params.join("\n").slice(0, 1000) } : {}),
    ...(count > 1 ? { count } : {}),
    ...(ZAP_SAME_AS[a.pluginId] ? { sameAs: ZAP_SAME_AS[a.pluginId] } : {}),
  }));
}

/** ZAP keeps one session, so two tests never use it at the same time. */
let turn: Promise<unknown> = Promise.resolve();

function zapUrl(): string | null {
  return process.env.ZAP_URL ? process.env.ZAP_URL.replace(/\/+$/, "") : null;
}

async function call<T>(pathname: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const url = new URL(`${zapUrl()}${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { "X-ZAP-API-Key": process.env.ZAP_API_KEY ?? "" },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let why = text.slice(0, 200);
    try {
      why = (JSON.parse(text) as { message?: string }).message ?? why;
    } catch {
      // not JSON
    }
    throw new Error(`ZAP answered ${res.status}: ${why}`);
  }
  return JSON.parse(text) as T;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export const zapTool: Tool = {
  id: "zap",
  name: "OWASP ZAP (passive)",
  maker: "OWASP / ZAP by Checkmarx",
  description: "The world's most used free security scanner. In passive mode it only looks at the pages and answers the site sends: it never attacks.",
  checks: [
    "Missing or weak security headers and cookie settings",
    "Information leaks: server versions, debug errors, private IPs",
    "Unsafe forms, mixed content and cross-domain scripts",
    "Over 60 passive rules, rated by OWASP risk",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "safe",
  takes: "about 1 minute",
  licence: "Apache-2.0, free",
  homepage: "https://www.zaproxy.org",
  signedIn: "uses-login",

  async ready() {
    if (!zapUrl()) return "ZAP is not set up on this server (start the zap service and set ZAP_URL).";
    try {
      await call("/JSON/core/view/version/");
      return null;
    } catch (err) {
      return `ZAP is set up at ${zapUrl()} but did not answer: ${(err as Error).message}`;
    }
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const mine = turn.then(() => scan(ctx));
    turn = mine.catch(() => {});
    return mine;
  },
};

async function scan(ctx: ToolContext): Promise<ToolOutput> {
  const { signal } = ctx;
  signal.throwIfAborted();
  const urls = [...new Set([ctx.startUrl, ...ctx.urls])].filter((u) => /^https?:/.test(u)).slice(0, MAX_URLS);
  const origins = [...new Set(urls.map((u) => new URL(u).origin))];
  const rule = `glv-session-${Date.now()}`;
  await call("/JSON/core/action/newSession/", { overwrite: "true" }, signal);
  try {
    if (ctx.cookie) {
      // The signed-in session goes along with every request ZAP makes, so it sees the private pages too.
      await call(
        "/JSON/replacer/action/addRule/",
        { description: rule, enabled: "true", matchType: "REQ_HEADER", matchRegex: "false", matchString: "Cookie", replacement: ctx.cookie, initiators: "" },
        signal,
      );
    }
    ctx.log(`OWASP ZAP: looking at ${urls.length} page${urls.length === 1 ? "" : "s"} (passive, no attacks)`);
    // Only GET requests to pages the platform already opened: no spider, no form posts, no active scan.
    for (const url of urls) {
      signal.throwIfAborted();
      try {
        await call("/JSON/core/action/accessUrl/", { url, followRedirects: "true" }, signal);
      } catch (err) {
        if (signal.aborted) throw err;
      }
    }
    const started = Date.now();
    for (;;) {
      const { recordsToScan } = await call<{ recordsToScan: string }>("/JSON/pscan/view/recordsToScan/", {}, signal);
      if (Number(recordsToScan) === 0) break;
      if (Date.now() - started > 180_000) throw new Error("ZAP's passive scan did not finish within 3 minutes.");
      await wait(1000, signal);
    }
    const alerts: ZapAlert[] = [];
    for (const origin of origins) {
      const res = await call<{ alerts: ZapAlert[] }>("/JSON/alert/view/alerts/", { baseurl: origin, start: "0", count: "5000" }, signal);
      alerts.push(...res.alerts);
    }
    const slim = alerts.map(({ pluginId, name, risk, confidence, url, param, evidence, cweid, method }) => ({ pluginId, name, risk, confidence, url, param, evidence, cweid, method }));
    await writeFile(path.join(ctx.outDir, "tool-zap.json"), JSON.stringify(slim, null, 2));
    const findings = readZap(alerts);
    const info = alerts.filter((a) => a.risk === "Informational").length;
    return {
      findings,
      summary: [
        `${findings.length} problem${findings.length === 1 ? "" : "s"} rated low or worse`,
        ...(info ? [`${info} informational note${info === 1 ? "" : "s"} in the raw results`] : []),
      ],
      reports: [{ file: "tool-zap.json", label: "ZAP alerts (JSON)" }],
      tested: `Passive scan of ${urls.length} page${urls.length === 1 ? "" : "s"}${ctx.cookie ? ", signed in" : ""}`,
    };
  } finally {
    // Leave nothing behind: not the session cookie, not the client's pages.
    if (ctx.cookie) await call("/JSON/replacer/action/removeRule/", { description: rule }).catch(() => {});
    await call("/JSON/core/action/newSession/", { overwrite: "true" }).catch(() => {});
  }
}
