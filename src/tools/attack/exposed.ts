import { withParam } from "../probes.js";
import type { AttackFinding, Family, FamilyContext } from "./types.js";
import { pathOf, where } from "./types.js";

/** Files that should never be reachable over the web, and the text that proves each one is. */
const SENSITIVE: { path: string; what: string; sign: RegExp; severity: "critical" | "high" }[] = [
  { path: "/.git/config", what: "the project's Git repository config", sign: /\[core\]|repositoryformatversion|\[remote /i, severity: "high" },
  { path: "/.git/HEAD", what: "the project's Git repository", sign: /^ref:\s+refs\//i, severity: "high" },
  { path: "/.env", what: "the server's environment file (keys and passwords)", sign: /^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S/m, severity: "critical" },
  { path: "/.env.local", what: "the server's environment file (keys and passwords)", sign: /^\s*[A-Z][A-Z0-9_]{2,}\s*=\s*\S/m, severity: "critical" },
  { path: "/.aws/credentials", what: "AWS access keys", sign: /aws_access_key_id|aws_secret_access_key/i, severity: "critical" },
  { path: "/.svn/entries", what: "the project's Subversion repository", sign: /^\d+\s*$|svn:|dir\n/i, severity: "high" },
  { path: "/.DS_Store", what: "a macOS folder listing (reveals file names)", sign: /Bud1|\x00\x00\x00\x01Bud1/, severity: "high" },
  { path: "/config.php.bak", what: "a PHP config backup (database passwords)", sign: /<\?php|DB_PASSWORD|define\(/i, severity: "critical" },
  { path: "/wp-config.php.bak", what: "a WordPress config backup (database passwords)", sign: /DB_PASSWORD|AUTH_KEY|<\?php/i, severity: "critical" },
  { path: "/backup.sql", what: "a database dump", sign: /CREATE TABLE|INSERT INTO|-- MySQL dump|PostgreSQL database dump/i, severity: "critical" },
  { path: "/phpinfo.php", what: "PHP's settings page (paths, versions, modules)", sign: /phpinfo\(\)|PHP Version \d/i, severity: "high" },
  { path: "/actuator/env", what: "Spring Boot's settings and secrets", sign: /"(activeProfiles|propertySources)"/, severity: "critical" },
];

/** Serialized-object markers: when one of these arrives in a cookie or value, the app may rebuild objects from it. */
const DESERIALIZE: { sign: RegExp; stack: string }[] = [
  { sign: /^rO0AB|^rO0AB[A-Za-z0-9+/=]/, stack: "Java (base64 of a serialized object)" },
  { sign: /\bO:\d+:"[^"]+":\d+:\{/, stack: "PHP (serialized object)" },
  { sign: /^(gAN|gAJ|gAR|gASV)[A-Za-z0-9+/=]/, stack: "Python (base64 pickle)" },
  { sign: /^BAh[A-Za-z0-9+/=]/, stack: "Ruby (base64 Marshal)" },
  { sign: /^AAEAAAD\/\/\/\//, stack: ".NET (BinaryFormatter)" },
];

/** The stack whose serialized data a value looks like, or undefined. */
export function deserializeMarker(value: string): string | undefined {
  const v = value.trim();
  if (v.length < 8) return undefined;
  return DESERIALIZE.find((d) => d.sign.test(v))?.stack;
}

export const exposedFamily: Family = {
  id: "exposed",
  label: "Exposed files & deserialization",
  hint: "Checks a short list of files that should never be public (.git, .env, backups), and flags serialized-object data in cookies or parameters.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, ctx, log } = fc;
    const found: AttackFinding[] = [];
    let origin = "";
    try {
      origin = new URL(surface.pages[0] ?? ctx.startUrl).origin;
    } catch {
      return [];
    }

    for (const s of SENSITIVE) {
      if (http.left() < 2500) break;
      try {
        const res = await http.get(origin + s.path, { follow: false });
        if (res.status !== 200 || !s.sign.test(res.body)) continue;
        found.push({
          rule: "attack:exposed-file",
          severity: s.severity,
          tag: "injection",
          title: `Exposed: ${s.what} is reachable over the web`,
          detail:
            `${origin}${s.path} returned ${s.what}, which should never be served to visitors. It can hand an attacker the source code, keys or passwords they need for a deeper attack (OWASP A05, CWE-538/CWE-540). ` +
            `How to reproduce: open ${origin}${s.path}. ` +
            `How to fix: remove the file from the web root (keep repositories, backups and .env files out of the served folder), and have the web server refuse hidden files and backup extensions.`,
          pageUrl: origin + s.path,
          evidence: `${origin}${s.path} → 200 with ${s.what}`,
          key: `exposed:${s.path}`,
        });
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }

    // Serialized-object data in cookies or parameter values: a surface for insecure deserialization.
    const seen = new Set<string>();
    const candidates = [
      ...surface.cookies.map((c) => ({ place: `cookie "${c.name}"`, value: c.value, pageUrl: surface.pages[0] ?? ctx.startUrl, keyPart: `cookie:${c.name}` })),
      ...surface.params.map((t) => ({ place: where(t), value: t.value, pageUrl: t.url.split("?")[0], keyPart: `param:${pathOf(t.url)}:${t.param}` })),
    ];
    for (const c of candidates) {
      const stack = deserializeMarker(c.value);
      if (!stack || seen.has(c.keyPart)) continue;
      seen.add(c.keyPart);
      found.push({
        rule: "attack:deserialization-surface",
        severity: "medium",
        tag: "deserialize",
        title: `Serialized object in ${c.place}: review for insecure deserialization`,
        detail:
          `The ${c.place} carries ${stack} data. If the app rebuilds objects from it without checking, a crafted value can run code on the server (OWASP A08, CWE-502). This is a surface to review by hand, not a confirmed break-in. ` +
          `How to reproduce: note the serialized value in ${c.place} and test whether the app accepts a modified one. ` +
          `How to fix: do not accept serialized objects from the client; use a plain data format (JSON) and rebuild objects yourself, or sign the data and verify the signature before use.`,
        pageUrl: c.pageUrl,
        evidence: `${c.place}: ${c.value.slice(0, 48)}… (${stack})`,
        key: `deserialize:${c.keyPart}`,
      });
    }

    if (found.length) log(`Exposed files & deserialization: ${found.length}`);
    return found;
  },
};
