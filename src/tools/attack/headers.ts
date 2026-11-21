import { withParam } from "../probes.js";
import type { Reply } from "./http.js";
import type { AttackFinding, Family, FamilyContext } from "./types.js";
import { pathOf, where } from "./types.js";

const id = () => Math.random().toString(36).slice(2, 8);

/**
 * A handful of pages to try the per-request header checks on (they do not depend on a parameter).
 * One per path, so a page with no parameter (an /account or /api/me endpoint) is covered too.
 */
function samplePages(fc: FamilyContext): string[] {
  const { surface } = fc;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of [...surface.pages, ...surface.params.map((t) => t.url)]) {
    if (!url) continue;
    const p = pathOf(url);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(url);
    if (out.length >= 10) break;
  }
  return out;
}

/**
 * CRLF (header) injection: a line break in a value that the site copies into a response header lets
 * an attacker add headers of their own (set cookies, poison the cache, split the response). Confirmed
 * by injecting a uniquely named header and finding it in the answer.
 */
export const crlfFamily: Family = {
  id: "crlf",
  label: "CRLF / header injection",
  hint: "A line break and a uniquely named header are placed in each parameter; flagged only when that header comes back in the response.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log } = fc;
    const found: AttackFinding[] = [];
    const seen = new Set<string>();
    for (const t of surface.params) {
      if (http.left() < 3000) break;
      const key = `crlf:${pathOf(t.url)}:${t.param}`;
      if (seen.has(key)) continue;
      const marker = `glv-inject-${id()}`;
      // searchParams encodes the raw CR LF to %0D%0A; the server decodes it and, if unsafe, writes the header.
      const payload = `${t.value}\r\n${marker}: 1`;
      try {
        const res = await http.get(withParam(t, payload), { follow: false });
        const injected = res.headers[marker] !== undefined || res.setCookie.some((c) => c.toLowerCase().includes(`\n${marker}`));
        if (!injected) continue;
        seen.add(key);
        found.push({
          rule: "attack:crlf-injection",
          severity: "high",
          tag: "header",
          title: `Response header injection: the ${where(t)} adds headers to the answer`,
          detail:
            `A line break in the ${where(t)} let a new header ("${marker}: 1") into the server's response. An attacker can set cookies, poison a shared cache, or split the response to inject content (CWE-113, CWE-93). ` +
            `How to reproduce: open ${withParam(t, payload)} and the response carries the header "${marker}". ` +
            `How to fix: strip carriage-return and line-feed characters from any value used in a header (most frameworks do this now; upgrade or filter the value).`,
          pageUrl: t.url.split("?")[0],
          evidence: `${withParam(t, payload)} returned the injected header "${marker}"`,
          key,
        });
      } catch (err) {
        if (fc.ctx.signal.aborted) throw err;
      }
    }
    if (found.length) log(`CRLF injection: ${found.length} confirmed`);
    return found;
  },
};

/**
 * Host-header injection: the site builds links (password-reset links, absolute URLs) from the Host
 * the request claims. An attacker who sets it to their own domain can send a victim a reset link that
 * points at the attacker's site. Confirmed by setting a made-up host and finding it reflected.
 */
export const hostHeaderFamily: Family = {
  id: "host-header",
  label: "Host header injection",
  hint: "A made-up host is sent in Host and X-Forwarded-Host; flagged only when the site reflects it into a link or redirect.",
  async run(fc): Promise<AttackFinding[]> {
    const { http, log } = fc;
    const found: AttackFinding[] = [];
    const seen = new Set<string>();
    for (const page of samplePages(fc)) {
      if (http.left() < 3000) break;
      const path = pathOf(page);
      if (seen.has(path)) continue;
      const marker = `glv-host-${id()}.invalid`;
      for (const header of ["x-forwarded-host", "x-forwarded-server", "forwarded", "host"]) {
        if (http.left() < 2000) break;
        const value = header === "forwarded" ? `host=${marker}` : marker;
        try {
          const res = await http.get(page, { follow: false, headers: { [header]: value } });
          const inLocation = (res.location ?? "").includes(marker);
          const inBody = res.body.includes(marker);
          if (!inLocation && !inBody) continue;
          seen.add(path);
          found.push({
            rule: "attack:host-header-injection",
            severity: "medium",
            tag: "header",
            title: `Host header injection: the page trusts the Host the request claims`,
            detail:
              `The page copied a made-up host sent in the "${header}" header into ${inLocation ? "its redirect" : "a link on the page"}. If password-reset or other links are built this way, an attacker can make them point at their own site and steal the tokens (CWE-644). It can also poison a shared cache. ` +
              `How to reproduce: request ${page} with the header "${header}: ${value}" and the made-up host "${marker}" comes back in the ${inLocation ? "Location" : "page"}. ` +
              `How to fix: build absolute links from a fixed, configured site address, not from the request's Host or X-Forwarded-Host; set an allow-list of expected hosts.`,
            pageUrl: path,
            evidence: `"${header}: ${value}" → ${marker} reflected in the ${inLocation ? "Location header" : "page body"}`,
            key: `host-header:${path}`,
          });
          break;
        } catch (err) {
          if (fc.ctx.signal.aborted) throw err;
        }
      }
    }
    if (found.length) log(`Host-header injection: ${found.length} confirmed`);
    return found;
  },
};

const aceqOrigin = (res: Reply, origin: string) => (res.headers["access-control-allow-origin"] ?? "").trim();
const credsTrue = (res: Reply) => (res.headers["access-control-allow-credentials"] ?? "").trim().toLowerCase() === "true";

/**
 * CORS misconfiguration: the site tells browsers that any website may read its answers while signed
 * in. Confirmed by sending a made-up Origin and seeing it echoed back with credentials allowed.
 */
export const corsFamily: Family = {
  id: "cors",
  label: "CORS misconfiguration",
  hint: "A made-up Origin is sent; flagged when the site echoes it back and allows credentials, so any site could read a signed-in user's data.",
  async run(fc): Promise<AttackFinding[]> {
    const { http, log } = fc;
    const found: AttackFinding[] = [];
    const seen = new Set<string>();
    for (const page of samplePages(fc)) {
      if (http.left() < 3000) break;
      const path = pathOf(page);
      if (seen.has(path)) continue;
      const evil = `https://glv-cors-${id()}.evil.example`;
      try {
        const res = await http.get(page, { headers: { origin: evil }, cookie: fc.surface.signedIn });
        const acao = aceqOrigin(res, evil);
        const creds = credsTrue(res);
        let hit: { why: string; severity: "high" | "medium" } | undefined;
        if (acao === evil && creds) hit = { why: `echoes any Origin back (${acao}) and allows credentials`, severity: "high" };
        else if (acao === "*" && creds) hit = { why: `allows all origins (*) together with credentials (an invalid, unsafe combination)`, severity: "high" };
        else if (acao === evil) hit = { why: `echoes any Origin back (${acao})`, severity: "medium" };
        if (!hit) continue;
        seen.add(path);
        found.push({
          rule: "attack:cors-misconfiguration",
          severity: hit.severity,
          tag: "cors",
          title: `CORS lets other websites read this page's answers`,
          detail:
            `The page ${hit.why}: the server answered our made-up Origin "${evil}" with Access-Control-Allow-Origin "${acao}"${creds ? " and Access-Control-Allow-Credentials true" : ""}. ${hit.severity === "high" ? "Any website a signed-in user visits can read this page's data as that user (CWE-942)." : "Any website can read this page's public answers, which widens what an attacker can script (CWE-942)."} ` +
            `How to reproduce: request ${page} with the header "Origin: ${evil}" and the same Origin is allowed back. ` +
            `How to fix: allow only a fixed list of trusted origins, and never return Access-Control-Allow-Credentials true together with a reflected or "*" origin.`,
          pageUrl: path,
          evidence: `Origin: ${evil} → Access-Control-Allow-Origin: ${acao}${creds ? "; Access-Control-Allow-Credentials: true" : ""}`,
          key: `cors:${path}`,
        });
      } catch (err) {
        if (fc.ctx.signal.aborted) throw err;
      }
    }
    if (found.length) log(`CORS: ${found.length} confirmed`);
    return found;
  },
};
