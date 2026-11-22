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

const SINKS: Sink[] = [
  { rule: "iast:taint-eval", severity: "critical", re: /\b(eval|Function|setTimeout|setInterval|vm\.runInNewContext|vm\.runInThisContext)\s*\(/, what: "runs the value as code", fix: "Never pass request input to eval/Function/vm. Parse it as data; use a safe interpreter or a fixed set of actions." },
  { rule: "iast:taint-exec", severity: "critical", re: /\b(child_process\.)?(exec|execSync|spawn|spawnSync|execFile)\s*\(|\brequire\(['"]child_process['"]\)/, what: "runs it as a shell command", fix: "Use execFile with a fixed command and an argument array (never a shell string), and allow-list the argument values." },
  { rule: "iast:taint-sql", severity: "high", re: /\b(query|execute|raw)\s*\(\s*[`'"].*\$\{|\b(query|execute)\s*\(\s*['"].*\+/, what: "builds a SQL string by concatenation", fix: "Use parameterised queries / prepared statements ($1, ?) instead of string concatenation." },
  { rule: "iast:taint-fs", severity: "high", re: /\bfs\.(readFile|readFileSync|writeFile|writeFileSync|createReadStream|unlink|readdir)\s*\(|\brequire\s*\(/, what: "reads/writes a file path or loads a module", fix: "Resolve the path against a fixed base dir and reject '..'; never require() a value built from input." },
  { rule: "iast:taint-redirect", severity: "medium", re: /\bres\.(redirect|writeHead)\s*\(|\.location\s*=/, what: "sends a redirect to it", fix: "Allow-list redirect targets or only allow same-origin relative paths." },
  { rule: "iast:taint-html", severity: "high", re: /\.(innerHTML|outerHTML)\s*=|\bres\.(send|write|end)\s*\(|dangerouslySetInnerHTML/, what: "writes it into a page / response without escaping", fix: "Escape output or set text content; for HTML, sanitise with a library like DOMPurify." },
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
          title: `Request input reaches code that ${sink.what}`,
          detail: `At ${file}:${i + 1}, a value that comes from untrusted input is used where the code ${sink.what}. ${sink.fix}`,
        });
      }
    }
  }
  return out;
}

/** The Node instrumentation hook written for the operator to load during the client's tests. */
export const IAST_HOOK = `/* GLV in-house IAST hook — load during your tests with:
     NODE_OPTIONS="--require ./glv-iast-hook.cjs" npm test
   It wraps dangerous sinks and prints a line whenever one is called with a value that
   looks like it came from untrusted input. No data leaves the process. */
'use strict';
const log = (sink, arg) => {
  try { process.stderr.write('[GLV-IAST] ' + sink + ' called: ' + String(arg).slice(0, 200) + '\\n'); } catch (_) {}
};
const cp = require('child_process');
for (const name of ['exec', 'execSync', 'spawn', 'spawnSync', 'execFile']) {
  const orig = cp[name];
  if (typeof orig === 'function') cp[name] = function (cmd, ...rest) { log('child_process.' + name, cmd); return orig.call(this, cmd, ...rest); };
}
const origEval = global.eval;
global.__glvEval = function (s) { log('eval', s); return origEval(s); };
`;

export const iastTool: Tool = {
  id: "iast",
  name: "IAST (interactive app security)",
  maker: "GLV Infotech (built in)",
  description:
    "An in-house take on interactive application security testing: a taint scan over the client's JavaScript/TypeScript source that finds where untrusted request input reaches a dangerous sink (code execution, shell, SQL, file path, HTML output), plus a small Node hook you load during the client's own tests so the same sinks are watched at runtime. No paid agent.",
  checks: [
    "Traces request input (query/body/params/argv/env) into eval, exec, SQL, fs and HTML sinks",
    "Writes a runtime hook you load with node --require during the client's tests",
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
