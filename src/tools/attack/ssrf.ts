import { withParam } from "../probes.js";
import type { AttackFinding, Family, FamilyContext } from "./types.js";
import { pathOf, where } from "./types.js";

/** Parameter names that usually hold an address the server will fetch. */
const SSRF_PARAM = /^(url|uri|link|href|src|source|callback|callback_?url|webhook|webhook_?url|redirect(_?ur[il])?|return(_?url)?|next|dest(ination)?|target|feed|rss|image(_?url)?|img|avatar(_?url)?|photo|proxy|fetch|load|open|remote|host|domain|site|endpoint|api|path|file|document|doc|preview|thumbnail|render|import|out)$/i;

/** A value that looks like an address, so even a param with an odd name is worth trying. */
const looksLikeUrl = (v: string) => /^(https?:\/\/|\/\/|www\.|ftp:)/i.test(v);

/**
 * Removes the address we sent from the answer, so a page that merely echoes our address back (a
 * "PING http://169.254.169.254/…" message) is never mistaken for one that actually fetched it. Only
 * text the target really returns is left to match against.
 */
function stripEcho(body: string, value: string): string {
  let out = body;
  for (const form of new Set([value, encodeURI(value), encodeURIComponent(value), value.replace(/&/g, "&amp;")])) {
    if (form) out = out.split(form).join(" ");
  }
  return out;
}

interface Attempt {
  /** The address the parameter is pointed at. */
  value: string;
  /** How to know the server really fetched it. */
  sign: RegExp;
  what: string;
  severity: "critical" | "high";
}

/** Things only the server itself can reach, and the text that proves it fetched them. */
const ATTEMPTS: Attempt[] = [
  { value: "http://169.254.169.254/latest/meta-data/", sign: /ami-id|instance-id|iam\/|public-keys|reservation-id|placement\//, what: "the cloud server's metadata service (AWS)", severity: "critical" },
  { value: "http://169.254.169.254/latest/meta-data/iam/security-credentials/", sign: /"Code"\s*:\s*"Success"|AccessKeyId|SecretAccessKey|Token/, what: "the cloud server's temporary access keys (AWS IAM)", severity: "critical" },
  { value: "http://metadata.google.internal/computeMetadata/v1/instance/", sign: /computeMetadata|service-accounts|machine-type|zone\b/, what: "the cloud server's metadata service (Google Cloud)", severity: "critical" },
  { value: "file:///etc/passwd", sign: /root:[x*]?:0:0:/, what: "the server's own files (file:// URLs)", severity: "critical" },
];

/**
 * Server-side request forgery: a parameter that holds an address the server fetches. Pointed at the
 * cloud metadata service or a local file, it reveals whatever only the server can reach. Confirmed
 * only when the answer carries text that address really returns, and a normal value does not.
 */
export const ssrfFamily: Family = {
  id: "ssrf",
  label: "SSRF (server-side request forgery)",
  hint: "Address parameters are pointed at the cloud metadata service and local files; flagged only when the server fetches them and the proof text comes back.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log } = fc;
    const found: AttackFinding[] = [];
    const seen = new Set<string>();
    const targets = surface.params.filter((t) => SSRF_PARAM.test(t.param) || looksLikeUrl(t.value));
    for (const t of targets) {
      if (http.left() < 4000) break;
      const key = `ssrf:${pathOf(t.url)}:${t.param}`;
      if (seen.has(key)) continue;
      // A benign address first: whatever text proves a hit must not already be on the page.
      let base;
      try {
        base = await http.get(withParam(t, "https://example.com/"));
      } catch (err) {
        if (fc.ctx.signal.aborted) throw err;
        base = { body: "" };
      }
      for (const a of ATTEMPTS) {
        if (http.left() < 2500) break;
        if (a.sign.test(stripEcho(base.body, "https://example.com/"))) continue;
        try {
          const res = await http.get(withParam(t, a.value));
          // Match the proof text only in what the target really returned, not in our echoed address.
          if (!a.sign.test(stripEcho(res.body, a.value))) continue;
          seen.add(key);
          found.push({
            rule: "attack:ssrf",
            severity: a.severity,
            tag: "ssrf",
            title: `SSRF: the ${where(t)} makes the server fetch ${a.what}`,
            detail:
              `The server fetched the address in the ${where(t)} and returned ${a.what}. An attacker can reach internal services, read cloud credentials and pivot deeper into the network (OWASP A10, CWE-918). ` +
              `How to reproduce: open ${withParam(t, a.value)} and the answer carries text only ${a.what} returns. ` +
              `How to fix: do not fetch addresses supplied by the user; if you must, resolve the host and refuse private, link-local and metadata addresses (169.254.169.254, 127.0.0.1, ::1, 10/8, 192.168/16, 172.16/12), allow only http(s), and allow only a fixed list of hosts.`,
            pageUrl: t.url.split("?")[0],
            evidence: `${withParam(t, a.value)} returned text from ${a.what}`,
            key,
          });
          break;
        } catch (err) {
          if (fc.ctx.signal.aborted) throw err;
        }
      }
    }
    if (found.length) log(`SSRF: ${found.length} confirmed`);
    return found;
  },
};
