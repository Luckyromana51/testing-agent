import { existsSync } from "node:fs";
import { cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { lastLine, runProcess } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Runs the client's own test suite and reads its coverage: npm test / pytest / phpunit / flutter test
 * in a scratch copy of their code, then reads an lcov or Cobertura coverage file if one is produced.
 * Started by hand only (it runs the client's code) and never on GLV's own copy of their files. It
 * reports failing tests and low coverage, so the client sees their suite's real state.
 */

export interface Coverage {
  lines: number;
  covered: number;
  pct: number;
  files: { file: string; pct: number }[];
}

/** Reads an lcov.info file into coverage. Pure, for tests. */
export function readLcov(text: string): Coverage {
  let lines = 0;
  let covered = 0;
  const files: { file: string; pct: number }[] = [];
  let curFile = "";
  let fLines = 0;
  let fHit = 0;
  const flush = () => {
    if (curFile && fLines) files.push({ file: curFile, pct: Math.round((fHit / fLines) * 100) });
    fLines = 0;
    fHit = 0;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      flush();
      curFile = line.slice(3);
    } else if (line.startsWith("DA:")) {
      const [, hits] = line.slice(3).split(",");
      lines++;
      fLines++;
      if (Number(hits) > 0) {
        covered++;
        fHit++;
      }
    } else if (line === "end_of_record") {
      flush();
      curFile = "";
    }
  }
  flush();
  return { lines, covered, pct: lines ? Math.round((covered / lines) * 100) : 0, files };
}

/** Reads a Cobertura coverage.xml (line-rate). Pure, for tests. */
export function readCobertura(xml: string): Coverage {
  const files: { file: string; pct: number }[] = [];
  for (const m of xml.matchAll(/<class[^>]*filename="([^"]+)"[^>]*line-rate="([\d.]+)"/g)) files.push({ file: m[1], pct: Math.round(Number(m[2]) * 100) });
  const root = xml.match(/<coverage[^>]*line-rate="([\d.]+)"/);
  const pct = root ? Math.round(Number(root[1]) * 100) : files.length ? Math.round(files.reduce((n, f) => n + f.pct, 0) / files.length) : 0;
  return { lines: 0, covered: 0, pct, files };
}

/** Counts passed/failed tests from common runner output. Pure, for tests. */
export function countTests(out: string): { passed: number; failed: number } {
  const jest = out.match(/Tests:\s+(?:(\d+) failed,\s+)?(\d+) passed/);
  if (jest) return { failed: Number(jest[1] ?? 0), passed: Number(jest[2]) };
  const pytest = out.match(/(?:(\d+) failed[, ]+)?(\d+) passed/);
  if (pytest) return { failed: Number(pytest[1] ?? 0), passed: Number(pytest[2]) };
  const phpunit = out.match(/OK \((\d+) tests?/);
  if (phpunit) return { passed: Number(phpunit[1]), failed: 0 };
  const phpFail = out.match(/Tests:\s+(\d+),\s+Assertions:.*Failures:\s+(\d+)/);
  if (phpFail) return { passed: Number(phpFail[1]) - Number(phpFail[2]), failed: Number(phpFail[2]) };
  return { passed: 0, failed: /fail|error/i.test(out) ? 1 : 0 };
}

async function detect(root: string, typed?: string): Promise<{ cmd: string[]; coverageHint?: string } | null> {
  if (typed) return { cmd: typed.split(/\s+/) };
  if (existsSync(path.join(root, "pubspec.yaml"))) return { cmd: ["flutter", "test", "--coverage"], coverageHint: "coverage/lcov.info" };
  const pkg = path.join(root, "package.json");
  if (existsSync(pkg)) {
    const scripts = JSON.parse(await readFile(pkg, "utf8").catch(() => "{}")).scripts ?? {};
    if (scripts.test) return { cmd: ["npm", "test", "--", "--coverage"], coverageHint: "coverage/lcov.info" };
  }
  if (["pyproject.toml", "setup.py", "pytest.ini", "requirements.txt", "setup.cfg"].some((f) => existsSync(path.join(root, f))))
    return { cmd: ["python3", "-m", "pytest", "--cov", "--cov-report=xml", "-q"], coverageHint: "coverage.xml" };
  if (["phpunit.xml", "phpunit.xml.dist", "composer.json"].some((f) => existsSync(path.join(root, f))))
    return { cmd: ["vendor/bin/phpunit", "--coverage-clover", "coverage.xml"], coverageHint: "coverage.xml" };
  return null;
}

/** Finds the first coverage file under root. */
async function findCoverage(root: string, hint?: string): Promise<{ path: string; kind: "lcov" | "cobertura" } | null> {
  if (hint) {
    const full = path.join(root, hint);
    if (existsSync(full)) return { path: full, kind: hint.endsWith(".xml") ? "cobertura" : "lcov" };
  }
  const candidates = ["coverage/lcov.info", "lcov.info", "coverage.xml", "coverage/cobertura-coverage.xml"];
  for (const c of candidates) if (existsSync(path.join(root, c))) return { path: path.join(root, c), kind: c.endsWith(".xml") ? "cobertura" : "lcov" };
  return null;
}

export const unitTestsTool: Tool = {
  id: "unit-tests",
  name: "Run the client's tests and coverage",
  maker: "GLV Infotech (built in)",
  description:
    "Runs the client's own test suite (npm test, pytest, phpunit or flutter test) in a scratch copy of their code and reads the coverage it produces (lcov or Cobertura). Reports failing tests and the files with the least coverage, so the client sees the real state of their suite.",
  checks: ["Runs the project's own tests, not GLV's", "Reports failing tests", "Reads lcov / Cobertura coverage and the least-covered files", "On a scratch copy, started by hand only"],
  products: ["code"],
  category: "functional",
  safety: "safe",
  takes: "2 to 20 minutes",
  licence: "GLV's own",
  homepage: "https://example.com",
  signedIn: "public",
  manual: true,
  options: [
    { id: "command", label: "Test command (optional)", kind: "text", placeholder: "npm test", hint: "Leave empty to use the project's npm test, pytest, phpunit or flutter test.", choices: [], default: "" },
    { id: "minCoverage", label: "Warn below coverage", choices: ["50", "60", "70", "80"].map((v) => ({ value: v, label: `${v}%` })), default: "60" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    if (!ctx.sourceDir) throw new Error("No code was provided. Add a Git repository or upload a zip.");
    const copy = path.join(ctx.workDir, "src");
    await cp(ctx.sourceDir, copy, { recursive: true, filter: (s) => !/\/(node_modules|\.git|coverage)(\/|$)/.test(s) });
    const how = await detect(copy, ctx.options.command || undefined);
    if (!how) throw new Error("No test suite was recognised (looked for package.json test script, pytest, phpunit, flutter). Set the test command in the options.");
    ctx.log(`Running the client's tests: ${how.cmd.join(" ")}`);
    const res = await runProcess(how.cmd[0], how.cmd.slice(1), { signal: ctx.signal, timeoutMs: 20 * 60_000, cwd: copy, env: { ...process.env, CI: "1" } }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
    const out = `${res.stdout}\n${res.stderr}`;
    const counts = countTests(out);
    const cov = await findCoverage(copy, how.coverageHint);
    let coverage: Coverage | null = null;
    if (cov) {
      const text = await readFile(cov.path, "utf8").catch(() => "");
      if (text) coverage = cov.kind === "lcov" ? readLcov(text) : readCobertura(text);
    }
    const min = Number(ctx.options.minCoverage) || 60;
    const findings: ToolFinding[] = [];
    if (counts.failed > 0)
      findings.push({
        category: "functional",
        rule: "tests:failing",
        severity: "high",
        title: `${counts.failed} of the client's own test${counts.failed === 1 ? "" : "s"} failed`,
        detail: "The project's test suite does not pass as it stands. Fix the failing tests (or the code they test) before release. The run output is below.",
        pageUrl: "repository",
        evidence: lastLine(out) || out.slice(-1500),
        key: "tests:failing",
      });
    if (coverage && coverage.pct < min)
      findings.push({
        category: "functional",
        rule: "tests:low-coverage",
        severity: "medium",
        title: `Test coverage is ${coverage.pct}% (below ${min}%)`,
        detail: `Only ${coverage.pct}% of lines are exercised by tests, so most of the code could break without a test noticing. Add tests, starting with the least-covered files below.`,
        pageUrl: "repository",
        evidence: coverage.files.sort((a, b) => a.pct - b.pct).slice(0, 10).map((f) => `${f.pct}% ${f.file}`).join("\n"),
        key: "tests:low-coverage",
      });
    return {
      findings,
      summary: [`${counts.passed} passed, ${counts.failed} failed${coverage ? `; coverage ${coverage.pct}%` : "; no coverage file produced"}`],
      tested: `${how.cmd.join(" ")} on a scratch copy`,
    };
  },
};
