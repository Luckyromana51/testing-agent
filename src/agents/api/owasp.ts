import { firstRecord } from "../../engines/api-ids.js";
import type { ApiOperation } from "../../engines/openapi.js";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { ApiCall } from "./context.js";
import type { ApiAgent } from "./shared.js";

/*
 * OWASP API Security Top 10 checks that only read: no rate limit (API4), lists with no size cap
 * (API4), hidden and debug endpoints and old versions still running (API9), address parameters an
 * attacker could point at internal servers (API7), and TRACE switched on. Like 42Crunch and Akto's
 * passive tests: nothing is changed and no attack payload is sent.
 */

const ok = (c: ApiCall) => c.status !== null && c.status >= 200 && c.status < 300;
const BURST = 20;

/** Places debug tools, metrics and config files are often left open. What gives each one away. */
export const HIDDEN: { path: string; what: string; sign: RegExp; severity: Finding["severity"] }[] = [
  { path: "/actuator/env", what: "Spring Boot's environment (settings and secrets)", sign: /"(activeProfiles|propertySources)"/, severity: "critical" },
  { path: "/actuator/heapdump", what: "Spring Boot's memory dump", sign: /JAVA PROFILE|^\x00/, severity: "critical" },
  { path: "/actuator", what: "Spring Boot's admin endpoints", sign: /"_links"\s*:/, severity: "medium" },
  { path: "/.env", what: "the server's .env file", sign: /^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S/m, severity: "critical" },
  { path: "/debug/vars", what: "Go's debug variables", sign: /"(cmdline|memstats)"/, severity: "high" },
  { path: "/debug/pprof/", what: "Go's profiler", sign: /Types of profiles available|pprof/i, severity: "high" },
  { path: "/metrics", what: "server metrics (Prometheus)", sign: /^# (HELP|TYPE) \w+/m, severity: "medium" },
  { path: "/server-status", what: "Apache's server status", sign: /Apache Server Status/i, severity: "medium" },
  { path: "/phpinfo.php", what: "PHP's settings page", sign: /phpinfo\(\)|PHP Version/i, severity: "high" },
  { path: "/_debugbar/open", what: "Laravel Debugbar", sign: /"(id|datetime|utime)"/, severity: "high" },
  { path: "/telescope/requests", what: "Laravel Telescope", sign: /telescope/i, severity: "high" },
  { path: "/console", what: "a web console (H2 or Werkzeug)", sign: /H2 Console|Werkzeug|interactive console/i, severity: "critical" },
  { path: "/admin/queues", what: "a job queue dashboard", sign: /bull|queue/i, severity: "medium" },
];

const PAGE_PARAMS = /^(limit|per_?page|page_?size|pagesize|size|count|top|take|max(_?results)?|first)$/i;
const SSRF_PARAMS = /^(url|uri|link|href|src|source|callback|callback_?url|webhook|webhook_?url|redirect(_?ur[il])?|return(_?url)?|next|dest(ination)?|target|feed|image(_?url)?|avatar(_?url)?|proxy|fetch|host|domain|endpoint)$/i;

/** How many records a list answer holds. */
function count(c: ApiCall): number {
  if (Array.isArray(c.json)) return c.json.length;
  const rec = c.json && firstRecord(c.json);
  if (!rec) return 0;
  const key = /^\$\.(\w+)/.exec(rec.at)?.[1];
  const v = key ? c.json[key] : undefined;
  return Array.isArray(v) ? v.length : 0;
}

export const apiOwaspAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.owasp",
  name: "OWASP API Top 10 (read-only)",
  description:
    "Sends a short burst of 20 calls to see a rate limit, asks lists for 10,000 records, looks for debug and admin endpoints and old API versions left running, flags address parameters open to SSRF, and checks TRACE is off. Only reads.",
  category: "security",
  async run({ calls, parsed, send, log }) {
    const out: Finding[] = [];
    const base = new URL(parsed.baseUrl);

    // API4: rate limit. One cheap endpoint that worked, called 20 times quickly.
    // A data endpoint, not a health check (those are often left out of limits on purpose).
    const plain = (c: ApiCall) => !/\/(health|healthz|status|ping|version|ready|readyz|live|livez)$/i.test(c.op.path);
    const target =
      calls.find((c) => ok(c) && plain(c) && !c.op.path.includes("{") && (c.bytes ?? c.text.length) < 50_000) ?? calls.find((c) => ok(c) && plain(c)) ?? calls.find(ok);
    if (target) {
      log(`Rate limit: ${BURST} quick calls to GET ${target.op.path}`);
      const burst: ApiCall[] = [];
      for (let i = 0; i < BURST; i += 5) {
        burst.push(...(await Promise.all(Array.from({ length: Math.min(5, BURST - i) }, () => send({ url: target.url ?? target.op.url }, target.op)))));
      }
      const limited = burst.some((c) => c.status === 429);
      const headers = [target, ...burst].some((c) => Object.keys(c.headers).some((h) => /^(x-)?rate-?limit|^retry-after$/i.test(h)));
      if (!limited && !headers) {
        out.push(
          finding({
            category: "security",
            rule: "api:no-rate-limit",
            severity: "medium",
            title: "No rate limit: one client can call the API as fast as it likes",
            detail: `GET ${target.op.path} answered all ${BURST} quick calls, with no 429 answer and no RateLimit headers. Without a limit, one script can scrape all the data, guess ids or slow the API for everyone (OWASP API4). Add a per-key and per-address limit (for example 100 calls a minute) and send RateLimit-Limit, RateLimit-Remaining and Retry-After.`,
            pageUrl: parsed.baseUrl,
            evidence: `${BURST} calls in a row: no 429, no RateLimit or Retry-After header`,
          }),
        );
      }
    }

    // API4: lists that hand out everything when asked.
    const lists = calls.filter((c) => ok(c) && !c.op.path.includes("{") && count(c) > 0).slice(0, 3);
    for (const c of lists) {
      const named = c.op.params?.find((p) => p.in === "query" && PAGE_PARAMS.test(p.name))?.name;
      const names = named ? [named] : ["limit", "per_page", "page_size"];
      for (const name of names) {
        const u = new URL(c.url ?? c.op.url);
        u.searchParams.set(name, "10000");
        const big = await send({ url: u.toString() }, c.op);
        const n = ok(big) ? count(big) : 0;
        if (n > 1000 || (n > count(c) && n > 500)) {
          out.push(
            finding({
              category: "performance",
              rule: "api:no-page-limit",
              severity: "medium",
              title: "A list endpoint returns as many records as it is asked for",
              detail: `GET ${c.op.path}?${name}=10000 returned ${n} records in one answer. A client (or an attacker) can pull the whole table at once and slow the database (OWASP API4). Cap the page size on the server, for example at 100.`,
              pageUrl: c.op.url,
              evidence: `?${name}=10000 gave more than 500 records`,
            }),
          );
          break;
        }
        if (named) break;
      }
    }

    // API9: debug tools and old versions still running.
    const roots = [...new Set([base.origin, `${base.origin}${base.pathname.replace(/\/+$/, "")}`])];
    const seen = new Set<string>();
    for (const h of HIDDEN) {
      if (seen.has(h.what)) continue;
      for (const root of roots) {
        const url = `${root}${h.path}`;
        const c = await send({ url, as: false });
        if (!ok(c) || !h.sign.test(c.text.slice(0, 20_000))) continue;
        seen.add(h.what);
        out.push(
          finding({
            category: "security",
            rule: "api:debug-endpoint",
            severity: h.severity,
            title: `Open to anyone: ${h.what}`,
            detail: `${url} answers anyone with ${h.what}. Attackers read settings, keys, users and internal addresses from these. Turn it off in production, or put it behind the firewall and a login (OWASP API9).`,
            pageUrl: url,
            evidence: `GET ${new URL(url).pathname} -> HTTP ${c.status}`,
          }),
        );
        break;
      }
    }
    const version = /\/v(\d+)(?=\/|$)/.exec(base.pathname);
    const sample = calls.find((c) => ok(c) && !c.op.path.includes("{"));
    if (version && Number(version[1]) > 1 && sample) {
      for (let v = Number(version[1]) - 1; v >= Math.max(0, Number(version[1]) - 2); v--) {
        const oldBase = `${base.origin}${base.pathname.replace(/\/v\d+(?=\/|$)/, `/v${v}`)}`.replace(/\/+$/, "");
        const c = await send({ url: `${oldBase}${sample.op.path}` }, sample.op);
        if (ok(c) && c.json !== undefined) {
          out.push(
            finding({
              category: "security",
              rule: "api:old-version-live",
              severity: "medium",
              title: `An older version of the API (v${v}) still answers`,
              detail: `${oldBase}${sample.op.path} still works next to v${version[1]}. Old versions often miss the security fixes and checks of the new one, and nobody watches them (OWASP API9). Turn it off, or keep it patched and listed.`,
              pageUrl: parsed.baseUrl,
              evidence: `GET /v${v}${sample.op.path} -> HTTP ${c.status}`,
            }),
          );
          break;
        }
      }
    }

    // API7: parameters that take an address, which the server may fetch.
    const ssrf: string[] = [];
    for (const op of [...parsed.operations, ...parsed.writes] as ApiOperation[]) {
      for (const p of op.params ?? []) if (SSRF_PARAMS.test(p.name)) ssrf.push(`${op.method} ${op.path} (${p.name})`);
      const props = Object.keys(((op.body?.schema && (op.body.schema.properties ?? {})) as object) ?? {});
      for (const k of props) if (SSRF_PARAMS.test(k)) ssrf.push(`${op.method} ${op.path} (body ${k})`);
    }
    if (ssrf.length) {
      out.push(
        finding({
          category: "security",
          rule: "api:ssrf-candidate",
          severity: "info",
          title: "Inputs that take a web address: check the server cannot be sent to internal addresses",
          detail: `${ssrf.length} inputs take an address the server may fetch (webhooks, images, callbacks). If the server fetches it without checks, an attacker can make it call internal services or the cloud metadata address 169.254.169.254 (SSRF, OWASP API7). Allow only https to public hosts, resolve the name and refuse private addresses. The attack probes test this with the client's permission.`,
          pageUrl: parsed.baseUrl,
          evidence: [...new Set(ssrf)].slice(0, 6).join("\n"),
        }),
      );
    }

    // TRACE echoes the request back, cookies and tokens included (cross-site tracing).
    const trace = await send({ method: "TRACE", url: parsed.baseUrl, as: false, headers: { "x-glv-trace": "glv" } });
    if (trace.status === 200 && /x-glv-trace/i.test(trace.text)) {
      out.push(
        finding({
          category: "security",
          rule: "api:trace-on",
          severity: "low",
          title: "TRACE is switched on",
          detail: "The server sends any request back as it got it, headers included. With another hole this can leak cookies and tokens. Turn TRACE off in the web server.",
          pageUrl: parsed.baseUrl,
          evidence: "TRACE -> HTTP 200 with the request echoed",
        }),
      );
    }
    return out;
  },
};
