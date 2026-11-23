import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import { walk, readSmall } from "./p3-code.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 4 (2026 gap report, previously-deferred P3 items) — all in-house / free, read-only.
 *
 * IAST (interactive application security testing) without a paid agent:
 *  - a light taint scan over the client's JS/TS source that finds where request input
 *    (req.query / req.body / req.params / process.argv) flows into a dangerous sink
 *    (eval, child_process exec, a raw SQL string, fs path, res write) on the same statement;
 *  - a small Node instrumentation hook written to the run's folder that the operator can load
 *    with `node --require` during the client's OWN test suite, so tainted calls are caught at
 *    runtime too. No third-party service, no licence.
 */

export interface TaintHit {
  rule: string;
  severity: Severity;
  file: string;
  line: number;
  title: string;
  detail: string;
}

const SOURCE = /\b(req\.(query|body|params|headers|cookies)|request\.(query|body|params)|process\.argv|process\.env|ctx\.request\.body|event\.(queryStringParameters|body)|location\.(search|hash|href)|window\.name|document\.referrer)\b/;

interface Sink {
  rule: string;
  severity: Severity;
  re: RegExp;
  what: string;
  fix: string;
}

// Severities are capped at "high": this is a single-line pattern scan, not a proven data-flow result,
// so it points a human at a line to check rather than asserting an exploit.
const SINKS: Sink[] = [
  { rule: "iast:taint-eval", severity: "high", re: /\b(eval|Function|vm\.runInNewContext|vm\.runInThisContext)\s*\(/, what: "may run the value as code", fix: "Never pass untrusted input to eval/Function/vm. Parse it as data; use a safe interpreter or a fixed set of actions." },
  { rule: "iast:taint-exec", severity: "high", re: /\bchild_process\b|\b(execSync|execFileSync|spawnSync|execFile|spawn)\s*\(/, what: "may run it as a shell command", fix: "Use execFile with a fixed command and an argument array (never a shell string), and allow-list the argument values." },
  { rule: "iast:taint-sql", severity: "medium", re: /\b(query|execute|raw)\s*\(\s*[`'"].*\$\{|\b(query|execute)\s*\(\s*['"].*\+/, what: "may build a SQL string by concatenation", fix: "Use parameterised queries / prepared statements ($1, ?) instead of string concatenation." },
  { rule: "iast:taint-fs", severity: "medium", re: /\bfs\.(readFile|readFileSync|writeFile|writeFileSync|createReadStream|unlink|readdir)\s*\(/, what: "may read/write a file path from it", fix: "Resolve the path against a fixed base dir and reject '..'." },
  { rule: "iast:taint-redirect", severity: "low", re: /\bres\.(redirect|writeHead)\s*\(|\.location\s*=/, what: "may send a redirect to it", fix: "Allow-list redirect targets or only allow same-origin relative paths." },
  { rule: "iast:taint-html", severity: "medium", re: /\.(innerHTML|outerHTML)\s*=|dangerouslySetInnerHTML/, what: "may write it into a page without escaping", fix: "Escape output or set text content; for HTML, sanitise with a library like DOMPurify." },
];

/** Finds source→sink taint on a single statement. Pure, for tests. */
export function taintPaths(code: string, file: string): TaintHit[] {
  const out: TaintHit[] = [];
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 600) continue;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (!SOURCE.test(line)) continue;
    for (const sink of SINKS) {
      if (sink.re.test(line)) {
        out.push({
          rule: sink.rule,
          severity: sink.severity,
          file,
          line: i + 1,
          title: `Untrusted input on a line that ${sink.what}`,
          detail: `At ${file}:${i + 1}, a value from an untrusted source (request input, argv, env, or the URL) appears on the same line as code that ${sink.what}. This is a single-line pattern match, not a proven data-flow path — confirm it, then: ${sink.fix}`,
        });
      }
    }
  }
  return out;
}

/** The Node instrumentation hook written for the operator to load during the client's tests. */
export const IAST_HOOK = `/* GLV runtime sink logger — load during your tests with:
     NODE_OPTIONS="--require ./glv-iast-hook.cjs" npm test
   It wraps the dangerous child_process sinks and prints the command each time one is called while your
   tests run, so you can review (by eye) whether any call is driven by untrusted input. It does NOT do
   taint tracking — it logs every call, tainted or not. No data leaves the process. */
'use strict';
const log = (sink, arg) => {
  try { process.stderr.write('[GLV-IAST] ' + sink + ' called: ' + String(arg).slice(0, 200) + '\\n'); } catch (_) {}
};
const cp = require('child_process');
for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile']) {
  const orig = cp[name];
  if (typeof orig === 'function') cp[name] = function (cmd, ...rest) { log('child_process.' + name, cmd); return orig.call(this, cmd, ...rest); };
}
`;

export const iastTool: Tool = {
  id: "iast",
  name: "Taint pattern scan (IAST-style)",
  maker: "GLV Infotech (built in)",
  description:
    "An in-house, IAST-style check: a single-line pattern scan over the client's JavaScript/TypeScript source that flags where an untrusted source (request input, argv, env, the URL) sits on the same line as a dangerous sink (code execution, shell, SQL, file path, HTML output), plus a small Node hook you load during the client's own tests to log shell-sink calls at runtime. It points a human at lines to check — it is not a proven data-flow engine. No paid agent.",
  checks: [
    "Flags untrusted sources (query/body/params/argv/env/URL) on a line with an eval, exec, SQL, fs or HTML sink",
    "Writes a runtime shell-sink logger you load with node --require during the client's tests",
    "Reads source only; nothing is sent anywhere",
  ],
  products: ["code"],
  category: "security",
  safety: "safe",
  manual: true,
  takes: "about a minute",
  licence: "GLV's own",
  homepage: "https://owasp.org/www-community/Vulnerability_Scanning_Tools",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const root = ctx.sourceDir;
    if (!root) throw new Error("No source folder to scan.");
    const files = (await walk(root, 4000)).filter((f) => /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(f) && !/node_modules|\.min\.js$|dist\/|build\//.test(f));
    const findings: ToolFinding[] = [];
    let scanned = 0;
    for (const rel of files.slice(0, 1500)) {
      const code = await readSmall(root, rel, 400_000);
      if (!code) continue;
      scanned++;
      for (const h of taintPaths(code, rel)) {
        findings.push({
          category: "security",
          rule: h.rule,
          severity: h.severity,
          title: h.title,
          detail: h.detail,
          pageUrl: rel,
          evidence: `${rel}:${h.line}`,
          key: `${h.rule}:${rel}:${h.line}`,
          sameScope: "file",
        });
      }
    }
    const hookPath = path.join(ctx.outDir, "glv-iast-hook.cjs");
    await writeFile(hookPath, IAST_HOOK).catch(() => {});
    ctx.log(`IAST: scanned ${scanned} files, ${findings.length} taint path(s)`);
    return {
      findings,
      summary: [
        `${scanned} source files scanned, ${findings.length} taint path(s)`,
        "Runtime hook written: load with NODE_OPTIONS=\"--require ./glv-iast-hook.cjs\" during the client's tests",
      ],
      reports: [{ file: "glv-iast-hook.cjs", label: "GLV IAST runtime hook" }],
      tested: `${scanned} source files`,
    };
  },
};
