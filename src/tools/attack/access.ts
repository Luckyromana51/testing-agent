import { likeness, withParam, type ProbeTarget } from "../probes.js";
import type { Reply } from "./http.js";
import type { AttackFinding, Family, FamilyContext } from "./types.js";
import { pathOf, where } from "./types.js";

/** Parameter names that usually point at one record by its id. */
const ID_PARAM = /^(id|_id|uid|user_?id|userid|account(_?id)?|acct|customer(_?id)?|order(_?id)?|invoice(_?id)?|doc(ument)?(_?id)?|file(_?id)?|record(_?id)?|item(_?id)?|ref|number|no|num|pid|oid|key|token|uuid|guid)$/i;

/** True when a value is a whole number we can step up and down from. */
const asInt = (v: string) => (/^\d{1,12}$/.test(v) ? Number(v) : undefined);

const blocked = (r: Reply) =>
  r.status === 401 ||
  r.status === 403 ||
  (r.status >= 300 && r.status < 400 && /login|signin|sign-in|auth/i.test(r.location ?? "")) ||
  (r.status === 200 && /\b(log ?in|sign ?in|please (log|sign) in|not authori[sz]ed|access denied|session (has )?expired)\b/i.test(r.body) && r.body.length < 4000);

const ok = (r: Reply) => r.status === 200 && r.body.length > 0 && !/\b(not found|no such|does not exist|404)\b/i.test(r.body.slice(0, 500));

/**
 * Broken access control by object id (IDOR). When a signed-in page shows one record by its id,
 * stepping the id to a neighbour's and getting a different record back — while a signed-out visitor
 * is turned away — means the app checks that you are logged in but not that the record is yours.
 * Only reads (GET); confirmed across several ids so a public catalogue is never mistaken for a hole.
 */
export const accessFamily: Family = {
  id: "access",
  label: "Broken access control (IDOR)",
  hint: "Only on signed-in pages: a record's id is stepped to a neighbour's; flagged when another user's record comes back and a signed-out visitor is refused.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log } = fc;
    if (!surface.signedIn) return [];
    const found: AttackFinding[] = [];
    const seen = new Set<string>();
    const idTargets = surface.params.filter((t) => ID_PARAM.test(t.param) && asInt(t.value) !== undefined);
    for (const t of idTargets) {
      if (http.left() < 8000) break;
      const key = `idor:${pathOf(t.url)}:${t.param}`;
      if (seen.has(key)) continue;
      const n = asInt(t.value)!;
      try {
        // Signed in, the record itself must load; signed out, it must be refused (else the page is public).
        const authedBase = await http.get(withParam(t, String(n)), { cookie: true });
        if (!ok(authedBase)) continue;
        const anonBase = await http.get(withParam(t, String(n)), { cookieOverride: "" });
        if (!blocked(anonBase)) continue; // a signed-out visitor can already see it: public, not IDOR

        // Two neighbours, both different records, both reachable while signed in but not signed out.
        const neighbours = [n + 1, n - 1, n + 2].filter((m) => m > 0);
        const hits: { m: number; authed: Reply }[] = [];
        for (const m of neighbours) {
          if (hits.length >= 2 || http.left() < 3000) break;
          const authed = await http.get(withParam(t, String(m)), { cookie: true });
          if (!ok(authed)) continue;
          if (likeness(authedBase, authed, [String(n), String(m)]) >= 0.97) continue; // same record shown again: not a neighbour
          const anon = await http.get(withParam(t, String(m)), { cookieOverride: "" });
          if (!blocked(anon)) continue;
          hits.push({ m, authed });
        }
        if (hits.length < 2) continue;
        seen.add(key);
        const ids = [n, ...hits.map((h) => h.m)].join(", ");
        found.push({
          rule: "attack:idor",
          severity: "high",
          tag: "idor",
          title: `Broken access control: the ${where(t)} opens other users' records`,
          detail:
            `Signed in, changing the ${where(t)} from ${n} to ${hits.map((h) => h.m).join(" and ")} returned different records each time, and a signed-out visitor was refused all of them. The app checks that you are logged in but not that the record belongs to you, so any user can read (and perhaps change) everyone's data by stepping the id (OWASP A01, CWE-639/CWE-285). ` +
            `How to reproduce: signed in, open ${withParam(t, String(hits[0].m))}; it shows a record that is not yours, and opening it signed out is refused. ` +
            `How to fix: on every request for a record by id, check the record belongs to (or is shared with) the signed-in user before returning it; do not rely on the id being hard to guess.`,
          pageUrl: t.url.split("?")[0],
          evidence: `Signed in, ids ${ids} each returned a different record; signed out, every one was refused (${anonBase.status})`,
          key,
        });
      } catch (err) {
        if (fc.ctx.signal.aborted) throw err;
      }
    }
    if (found.length) log(`Broken access control: ${found.length} confirmed`);
    return found;
  },
};
