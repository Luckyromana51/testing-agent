import { existsSync } from "node:fs";
import { cp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Mutation testing, in the way Stryker (JS/TS) and mutmut (Python) work, with GLV's own small engine:
 * the client's code is copied, one small change (a "mutant") is made at a time, such as > into >= or
 * && into ||, and their test suite is run. A good suite fails (the mutant is "killed"); when the tests
 * still pass, that line's behaviour is not really tested. Started by hand only, since it runs the
 * client's own tests many times, and never on GLV's copy of their files (it works on a scratch copy).
 */

export interface Mutant {
  file: string;
  line: number;
  /** What was changed, e.g. "> → >=". */
  change: string;
  /** The line after the change. */
  after: string;
}

/** Each operator: what to find on a line, what it becomes, and its label. */
const OPERATORS: { find: RegExp; to: string; label: string; langs: ("js" | "py")[] }[] = [
  { find: /===/, to: "!==", label: "=== → !==", langs: ["js"] },
  { find: /!==/, to: "===", label: "!== → ===", langs: ["js"] },
  { find: /(?<![=!<>])==(?!=)/, to: "!=", label: "== → !=", langs: ["py"] },
  { find: /!=(?!=)/, to: "==", label: "!= → ==", langs: ["py"] },
  { find: /(?<![=<>-])>=(?!=)/, to: ">", label: ">= → >", langs: ["js", "py"] },
  { find: /(?<![=<>-])<=(?!=)/, to: "<", label: "<= → <", langs: ["js", "py"] },
  { find: /(?<![=<>-])>(?![=>])/, to: ">=", label: "> → >=", langs: ["js", "py"] },
  { find: /(?<![=<-])<(?![=<])/, to: "<=", label: "< → <=", langs: ["js", "py"] },
  { find: /&&/, to: "||", label: "&& → ||", langs: ["js"] },
  { find: /\|\|/, to: "&&", label: "|| → &&", langs: ["js"] },
  { find: /\band\b/, to: "or", label: "and → or", langs: ["py"] },
  { find: /\bor\b/, to: "and", label: "or → and", langs: ["py"] },
  { find: /\btrue\b/, to: "false", label: "true → false", langs: ["js"] },
  { find: /\bfalse\b/, to: "true", label: "false → true", langs: ["js"] },
  { find: /\bTrue\b/, to: "False", label: "True → False", langs: ["py"] },
  { find: /\bFalse\b/, to: "True", label: "False → True", langs: ["py"] },
  { find: /(?<=\w\s?)\+(?=\s?[\w(])(?![+=])/, to: "-", label: "+ → -", langs: ["js", "py"] },
  { find: /(?<=\w\s?)-(?=\s?[\w(])(?![-=>])/, to: "+", label: "- → +", langs: ["js", "py"] },
  { find: /(?<=\w\s?)\*(?=\s?[\w(])(?![*=])/, to: "/", label: "* → /", langs: ["js", "py"] },
  { find: /\bif\s*\((.+)\)\s*\{\s*$/, to: "if (!($1)) {", label: "condition negated", langs: ["js"] },
  { find: /\breturn\s+(?!;)(.+?);?\s*$/, to: "return undefined;", label: "return value removed", langs: ["js"] },
  { find: /\breturn\s+(\S.*)$/, to: "return None", label: "return value removed", langs: ["py"] },
];

const SKIP_LINE = /^\s*(\/\/|\/\*|\*|#|import\b|from\s+\S+\s+import\b|export\s+(type|interface)\b|interface\b|type\s+\w+\s*=|console\.|logger?\.|print\(|"use strict")/;
const STRINGS = /(["'`])(?:\\.|(?!\1).)*\1/g;

/** The mutants for one file's text. Pure, for tests. Strings and comments are left alone. */
export function mutantsFor(file: string, text: string, lang: "js" | "py", max = 1000): Mutant[] {
  const out: Mutant[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const line = lines[i];
    if (SKIP_LINE.test(line) || line.length > 300 || !line.trim()) continue;
    // Operators inside strings would only change messages: mask them before looking.
    const masked = line.replace(STRINGS, (s) => s[0] + " ".repeat(s.length - 2) + s[0]).replace(/\s(\/\/|#).*$/, (s) => " ".repeat(s.length));
    // Arrows and generics in JS (=>, Array<string>) are not comparisons.
    const safe = lang === "js" ? masked.replace(/=>/g, "  ").replace(/<[A-Z][\w<>, [\]|]*>/g, (s) => " ".repeat(s.length)) : masked;
    for (const op of OPERATORS) {
      if (!op.langs.includes(lang)) continue;
      const m = safe.match(op.find);
      if (!m || m.index === undefined) continue;
      const after = line.slice(0, m.index) + line.slice(m.index).replace(new RegExp(op.find.source), op.to);
      if (after === line) continue;
      out.push({ file, line: i + 1, change: op.label, after });
      break; // one mutant a line keeps runs short and spread over the code
    }
  }
  return out;
}

/** Spreads the picks over the files (every Nth mutant), so one big file does not take them all. Pure, for tests. */
export function spread<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)]);
}

const SOURCE_DIRS_SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "vendor", "venv", ".venv", "__pycache__", "migrations", "public", "static"]);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?|__mocks__)\/|\.(test|spec)\.[jt]sx?$|(^|\/)test_[^/]+\.py$|_test\.py$|conftest\.py$|\.d\.ts$|\.config\.[jt]s$/;

async function sourceFiles(root: string, lang: "js" | "py"): Promise<string[]> {
  const ext = lang === "js" ? /\.(m?[jt]sx?|cjs)$/ : /\.py$/;
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 8 || found.length > 2000) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SOURCE_DIRS_SKIP.has(e.name)) await walk(full, depth + 1);
      } else if (ext.test(e.name)) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (!TEST_PATH.test(rel) && (await stat(full)).size < 300_000) found.push(rel);
      }
    }
  };
  await walk(root, 0);
  return found.sort();
}

/** Which language and test command the project uses. */
async function detect(root: string, typed?: string): Promise<{ lang: "js" | "py"; cmd: string[]; install?: string[] } | null> {
  const pkgFile = path.join(root, "package.json");
  if (existsSync(pkgFile)) {
    const pkg = JSON.parse(await readFile(pkgFile, "utf8").catch(() => "{}")) as { scripts?: Record<string, string> };
    const cmd = typed ? typed.split(/\s+/) : pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test) ? ["npm", "test", "--silent"] : null;
    if (!cmd) return null;
    const install = existsSync(path.join(root, "node_modules")) ? undefined : existsSync(path.join(root, "package-lock.json")) ? ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"] : ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"];
    return { lang: "js", cmd, ...(install ? { install } : {}) };
  }
  if (["pyproject.toml", "setup.py", "requirements.txt", "pytest.ini", "setup.cfg"].some((f) => existsSync(path.join(root, f)))) {
    return { lang: "py", cmd: typed ? typed.split(/\s+/) : ["python3", "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider"] };
  }
  return null;
}

export const mutationTool: Tool = {
  id: "mutation",
  name: "Mutation testing",
  maker: "GLV Infotech (built in), in the way of Stryker and mutmut",
  description:
    "Proves the client's own tests catch bugs: it makes small changes to a copy of their code (> into >=, && into ||, a return value removed), runs their test suite after each one, and lists the changes the tests did not notice. Started by hand, since it runs their tests many times.",
  checks: [
    "Mutation score: how many planted bugs the tests caught",
    "Each surviving change, with its file and line, as a missing test",
    "JavaScript and TypeScript (npm test) and Python (pytest)",
    "Works on a scratch copy, never the client's files",
  ],
  products: ["code"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "5 to 60 minutes (their test suite, once per change)",
  licence: "GLV's own",
  homepage: "https://stryker-mutator.io",
  signedIn: "public",
  options: [
    {
      id: "mutants",
      label: "How many changes to try",
      choices: [
        { value: "20", label: "20 (quick look)" },
        { value: "60", label: "60" },
        { value: "150", label: "150 (thorough)" },
      ],
      default: "60",
    },
    {
      id: "command",
      label: "Test command (when not npm test or pytest)",
      kind: "text",
      pattern: "^[A-Za-z0-9_./:= -]{0,200}$",
      placeholder: "npx vitest run",
      hint: "Leave empty to use the project's npm test, or pytest.",
      choices: [],
      default: "",
    },
    { id: "minutes", label: "Most minutes", choices: [{ value: "15", label: "15" }, { value: "30", label: "30" }, { value: "60", label: "60" }], default: "30" },
  ],

  async ready() {
    return (await which("npm")) || (await which("python3")) ? null : "Neither npm nor python3 is installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    if (!ctx.sourceDir) throw new Error("Mutation testing needs the project's code (a Git address or a zip).");
    const copy = path.join(ctx.workDir, "mutation");
    await cp(ctx.sourceDir, copy, { recursive: true, filter: (src) => !/[\\/]\.git([\\/]|$)/.test(src) });
    const typed = ctx.options.command?.trim();
    const how = await detect(copy, typed || undefined);
    if (!how) throw new Error("No test command found: the project has no npm test script and no Python project files. Type the test command in the tool's tab.");
    const deadline = Date.now() + Math.min(Number(ctx.options.minutes) || 30, 60) * 60_000;
    // The client's code may not be trusted: no secrets from GLV's server reach their tests.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: ctx.workDir, CI: "true", NODE_ENV: "test", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" };
    if (how.install) {
      ctx.log(`Installing the project's packages (${how.install.join(" ")})`);
      const r = await runProcess(how.install[0], how.install.slice(1), { cwd: copy, env, signal: ctx.signal, timeoutMs: 10 * 60_000 });
      if (r.code !== 0) throw new Error(`Installing the project's packages failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
    }
    const runTests = (timeoutMs: number) =>
      runProcess(how.cmd[0], how.cmd.slice(1), { cwd: copy, env, signal: ctx.signal, timeoutMs, maxOutput: 200_000 }).catch((err: Error) => ({ code: -1, stdout: "", stderr: err.message }));
    ctx.log(`Running the tests once as they are (${how.cmd.join(" ")})`);
    const t0 = Date.now();
    const base = await runTests(15 * 60_000);
    const baseMs = Date.now() - t0;
    if (base.code !== 0) throw new Error(`The project's tests fail before any change, so mutation testing cannot judge them. Make them pass first. Last lines: ${(base.stdout + base.stderr).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
    const files = await sourceFiles(copy, how.lang);
    const all: Mutant[] = [];
    for (const f of files) all.push(...mutantsFor(f, await readFile(path.join(copy, f), "utf8"), how.lang, 200));
    const picked = spread(all, Number(ctx.options.mutants) || 60);
    if (!picked.length) throw new Error("No code to change was found (only tests, or no JavaScript/Python files).");
    const perRun = Math.max(30_000, baseMs * 3 + 10_000);
    let killed = 0;
    let timedOut = 0;
    const survived: Mutant[] = [];
    let tried = 0;
    for (const m of picked) {
      ctx.signal.throwIfAborted();
      if (Date.now() + perRun > deadline) break;
      const file = path.join(copy, m.file);
      const original = await readFile(file, "utf8");
      const lines = original.split("\n");
      lines[m.line - 1] = m.after;
      await writeFile(file, lines.join("\n"));
      try {
        const r = await runTests(perRun);
        tried++;
        if (r.code === -1) timedOut++;
        if (r.code === 0) survived.push(m);
        else killed++;
      } finally {
        await writeFile(file, original);
      }
      ctx.log(`${tried}/${picked.length}: ${m.file}:${m.line} ${m.change}`);
    }
    const score = tried ? Math.round((killed / tried) * 100) : 0;
    const findings: ToolFinding[] = survived.map((m) => ({
      category: "functional",
      rule: "mutation:survived",
      severity: "low",
      title: `No test notices a change in ${m.file} line ${m.line}`,
      detail: `GLV changed this line (${m.change}) and every test still passed, so a real bug here would go unnoticed. Add a test that checks this line's result, including the edge (equal values, empty input, false).`,
      pageUrl: m.file,
      evidence: `${m.file}:${m.line}\n${m.after.trim().slice(0, 200)}`,
      key: `mutation:${m.file}:${m.line}`,
    }));
    if (tried >= 10 && score < 60)
      findings.unshift({
        category: "functional",
        rule: "mutation:low-score",
        severity: score < 40 ? "high" : "medium",
        title: `The tests caught only ${score}% of planted bugs`,
        detail: "Most small changes to the code went unnoticed by the test suite, so coverage numbers overstate how well it is tested. Start with the files listed below: each surviving change is a missing assertion.",
        pageUrl: ctx.target.url ?? "code",
        evidence: `${killed} of ${tried} changes caught`,
        key: "mutation:score",
      });
    return {
      findings,
      summary: [`Mutation score ${score}%: ${killed} of ${tried} changes caught by the tests`, `${survived.length} changes survived${timedOut ? `, ${timedOut} made the tests hang (counted as caught)` : ""}`, tried < picked.length ? `Stopped at the time limit after ${tried} of ${picked.length}` : `${files.length} source files, ${all.length} possible changes`],
      tested: `${tried} changes to ${files.length} files, test command ${how.cmd.join(" ")}`,
      table: { title: "Changes the tests did not catch", columns: ["File", "Line", "Change"], rows: survived.slice(0, 300).map((m) => [m.file, String(m.line), m.change]) },
    };
  },
};
