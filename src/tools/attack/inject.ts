import { likeness, withParam, type ProbeTarget } from "../probes.js";
import type { AttackFinding, Family, FamilyContext } from "./types.js";
import { pathOf, where } from "./types.js";

/** A param whose name hints a shell command runs behind it, tried first for command injection. */
const CMD_HINT = /^(cmd|command|exec|run|ping|host|hostname|ip|addr|address|domain|dns|lookup|query|q|action|do|func|function|system|process|proc|shell|bash|file|filename|path|url|target|name|input|arg|args|option|op|type|format|convert|download|fetch|load|tool|task|job)$/i;

/** A value that looks like a shell word (no odd characters) so a planted command does not break the normal page. */
const plain = (v: string) => (/^[\w.\-/ ]{0,40}$/.test(v) ? v : "1");

interface Timing {
  base: number;
  lo: number;
  hi: number;
}

/**
 * OS command injection, found by timing. When a value is pasted into a shell, a "sleep" in it makes
 * the server answer that much later. A command is confirmed only when the delay scales with the
 * number asked for (a short sleep and a longer one), so a site that is merely slow is never flagged.
 * Nothing is deleted or changed: "sleep" only waits.
 */
async function timingFor(t: ProbeTarget, shape: (n: number) => string, fc: FamilyContext): Promise<Timing | undefined> {
  const { http } = fc;
  const measure = async (value: string): Promise<number> => {
    const r = await http.get(withParam(t, value));
    return r.ms;
  };
  // A quiet baseline: the fastest of two normal requests.
  const base = Math.min(await measure(plain(t.value)), await measure(plain(t.value)));
  if (http.left() < 20_000) return undefined; // not enough time left to measure two sleeps safely
  const lo = await measure(shape(2));
  if (lo < base + 1200) return undefined; // the 2-second sleep did not land
  const hi = await measure(shape(7));
  return { base, lo, hi };
}

const CMD_SHAPES: ((v: string, n: number) => string)[] = [
  (v, n) => `${v};sleep ${n}`,
  (v, n) => `${v}|sleep ${n}`,
  (v, n) => `${v}\`sleep ${n}\``,
  (v, n) => `${v}$(sleep ${n})`,
  (v, n) => `${v}&&sleep ${n}`,
  (v, n) => `${v}\nsleep ${n}`,
];

export const commandFamily: Family = {
  id: "command",
  label: "Command injection (OS)",
  hint: "A short, harmless 'sleep' is timed; a command is confirmed only when the delay scales, never anything that changes data.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log } = fc;
    const found: AttackFinding[] = [];
    const seen = new Set<string>();
    // The likeliest parameters first, and only a handful, because each one costs several slow requests.
    const targets = [...surface.params].sort((a, b) => Number(CMD_HINT.test(b.param)) - Number(CMD_HINT.test(a.param))).slice(0, 10);
    for (const t of targets) {
      if (http.left() < 25_000) break;
      const key = `cmd:${pathOf(t.url)}:${t.param}`;
      if (seen.has(key)) continue;
      for (const shape of CMD_SHAPES) {
        if (http.left() < 25_000) break;
        let timing: Timing | undefined;
        try {
          timing = await timingFor(t, (n) => shape(plain(t.value), n), fc);
        } catch (err) {
          if (fc.ctx.signal.aborted) throw err;
          continue;
        }
        if (!timing) continue;
        const { base, lo, hi } = timing;
        // Confirmed: the 7-second sleep is clearly longer than the 2-second one, and both beat the baseline.
        if (hi - lo >= 3500 && lo >= base + 1200 && hi >= base + 5500) {
          seen.add(key);
          found.push({
            rule: "attack:command-injection",
            severity: "critical",
            tag: "rce",
            title: `Command injection: the ${where(t)} runs commands on the server`,
            detail:
              `A shell command placed in the ${where(t)} ran on the server: a "sleep" of 2 seconds delayed the answer by about 2 seconds, and a "sleep" of 7 seconds delayed it by about 7 (baseline ${Math.round(base)}ms, 2s → ${Math.round(lo)}ms, 7s → ${Math.round(hi)}ms). An attacker can run any command and take over the server (OWASP A03 Injection, CWE-78). ` +
              `How to reproduce: open ${withParam(t, shape(plain(t.value), 7))} and the page takes about 7 seconds; with "sleep 2" about 2. ` +
              `How to fix: never build a shell command from request values; call programs with an argument list (execFile, not a shell string), and validate the value against a strict allow-list.`,
            pageUrl: t.url.split("?")[0],
            evidence: `Baseline ${Math.round(base)}ms; "sleep 2" ${Math.round(lo)}ms; "sleep 7" ${Math.round(hi)}ms at ${withParam(t, shape(plain(t.value), 7))}`,
            key,
          });
          break;
        }
      }
    }
    if (found.length) log(`Command injection: ${found.length} confirmed`);
    return found;
  },
};

const SSTI_SHAPES: { wrap: (expr: string) => string; engines: string }[] = [
  { wrap: (e) => `{{${e}}}`, engines: "Jinja2, Twig, Nunjucks, Angular" },
  { wrap: (e) => `\${${e}}`, engines: "Freemarker, Thymeleaf, JSP EL" },
  { wrap: (e) => `#{${e}}`, engines: "Ruby ERB-ish, Thymeleaf" },
  { wrap: (e) => `<%= ${e} %>`, engines: "ERB, EJS" },
  { wrap: (e) => `\${{${e}}}`, engines: "Smarty, Handlebars-ish" },
  { wrap: (e) => `{${e}}`, engines: "Python str.format, Tornado" },
];

export const sstiFamily: Family = {
  id: "ssti",
  label: "Template injection (SSTI)",
  hint: "A tiny sum (71×71) is sent; flagged only when the server works it out and prints the answer, twice with different numbers.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log } = fc;
    const found: AttackFinding[] = [];
    for (const t of surface.params) {
      if (http.left() < 4000) break;
      // Cheap pre-check: does the value come back on the page at all?
      const canary = `glvt${Math.abs(hash(pathOf(t.url) + t.param)) % 9000 + 1000}`;
      let base;
      try {
        base = await http.get(withParam(t, canary));
      } catch (err) {
        if (fc.ctx.signal.aborted) throw err;
        continue;
      }
      if (!/html|text|json/i.test(base.type) || !base.body.includes(canary)) continue;
      for (const { wrap, engines } of SSTI_SHAPES) {
        if (http.left() < 3000) break;
        const a = 71;
        const b = 83;
        try {
          const first = await http.get(withParam(t, `${canary}${wrap(`${a}*${a}`)}`));
          if (!first.body.includes(String(a * a)) || base.body.includes(String(a * a))) continue;
          // Confirm with a different sum, so a page that just happens to show 5041 is not flagged.
          const second = await http.get(withParam(t, `${canary}${wrap(`${b}*${b}`)}`));
          if (!second.body.includes(String(b * b))) continue;
        } catch (err) {
          if (fc.ctx.signal.aborted) throw err;
          continue;
        }
        found.push({
          rule: "attack:template-injection",
          severity: "critical",
          tag: "rce",
          title: `Server-side template injection: the ${where(t)} runs template code`,
          detail:
            `The server worked out a sum placed in the ${where(t)} and printed the answer: "${wrap(`${a}*${a}`)}" came back as ${a * a}, and "${wrap(`${b}*${b}`)}" as ${b * b}. The value is run as a template (${engines}). Template injection usually leads to running any code on the server (OWASP A03 Injection, CWE-1336/CWE-94). ` +
            `How to reproduce: open ${withParam(t, `${canary}${wrap(`${a}*${a}`)}`)} and the page shows ${canary}${a * a}. ` +
            `How to fix: never put request values into a template string; pass them as data to a fixed template, and turn off expression evaluation on user input.`,
          pageUrl: t.url.split("?")[0],
          evidence: `${withParam(t, `${canary}${wrap(`${a}*${a}`)}`)} returned ${canary}${a * a}; the ${b}×${b} check returned ${b * b}`,
          key: `ssti:${pathOf(t.url)}:${t.param}`,
        });
        break;
      }
    }
    if (found.length) log(`Template injection: ${found.length} confirmed`);
    return found;
  },
};

/** A short, stable number from a string, so the SSTI canary is the same on a re-test. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

const NOSQL_HINT = /^(id|_id|user|username|user_id|userid|email|name|q|search|filter|order|product|item|account|role|type|status|page|category|cat)$/i;

/**
 * NoSQL (MongoDB-style) injection through query operators. A value that matches nothing gives an
 * "empty" page; the same name sent as `name[$ne]=…` (not equal to nothing, so everything) or
 * `name[$gt]=` (greater than nothing) gives the full page instead. Confirmed only when two different
 * operators both turn an empty page into a full one, and a matching-nothing operator stays empty.
 */
export const nosqlFamily: Family = {
  id: "nosql",
  label: "NoSQL injection (MongoDB)",
  hint: "Query operators like [$ne] and [$gt] are compared against a value that matches nothing; flagged only on a clear, repeated difference.",
  async run(fc): Promise<AttackFinding[]> {
    const { surface, http, log } = fc;
    const found: AttackFinding[] = [];
    const operatorUrl = (t: ProbeTarget, op: string, value: string): string => {
      const u = new URL(t.url);
      u.searchParams.delete(t.param);
      u.searchParams.set(`${t.param}[${op}]`, value);
      return u.toString();
    };
    const targets = surface.params.filter((t) => NOSQL_HINT.test(t.param)).slice(0, 20);
    for (const t of targets) {
      if (http.left() < 6000) break;
      try {
        // A value that should match nothing: the "empty" reference.
        const nomatch = `glvno${Math.abs(hash(t.param)) % 100000}zz`;
        const empty = await http.get(withParam(t, nomatch));
        // $ne nothing → everything; $gt nothing → everything; $in [nothing] → still empty (control).
        const ne = await http.get(operatorUrl(t, "$ne", nomatch));
        const gt = await http.get(operatorUrl(t, "$gt", ""));
        const control = await http.get(operatorUrl(t, "$in", nomatch));
        const differsFromEmpty = (r: typeof empty) => empty.status === r.status && likeness(empty, r, [nomatch]) < 0.85;
        // Both operators must open the page up, and the control (still matching nothing) must not.
        if (differsFromEmpty(ne) && differsFromEmpty(gt) && likeness(empty, control, [nomatch]) >= 0.9) {
          found.push({
            rule: "attack:nosql-injection",
            severity: "high",
            tag: "injection",
            title: `NoSQL injection: the ${where(t)} accepts query operators`,
            detail:
              `The ${where(t)} is passed straight into a MongoDB-style query: a value matching nothing gives an empty page, but "${t.param}[$ne]" and "${t.param}[$gt]" both return records, while "${t.param}[$in]" of the same nothing stays empty. An attacker can bypass filters and log-in checks, or read records they should not (OWASP A03 Injection, CWE-943). ` +
              `How to reproduce: open ${operatorUrl(t, "$ne", nomatch)} and it returns data that ${withParam(t, nomatch)} does not. ` +
              `How to fix: reject request keys that contain "$" or ".", and cast each value to the type you expect (a string, a number) before it reaches the query.`,
            pageUrl: t.url.split("?")[0],
            evidence: `${withParam(t, nomatch)} → ${empty.status}/${empty.body.length}b (empty); ${operatorUrl(t, "$ne", nomatch)} → ${ne.status}/${ne.body.length}b (records)`,
            key: `nosql:${pathOf(t.url)}:${t.param}`,
          });
        }
      } catch (err) {
        if (fc.ctx.signal.aborted) throw err;
      }
    }
    if (found.length) log(`NoSQL injection: ${found.length} confirmed`);
    return found;
  },
};
