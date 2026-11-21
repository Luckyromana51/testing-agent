import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { EngineAgent } from "../types.js";
import { TEST_PATH, type CodeContext } from "./context.js";

/** JSON files that allow comments, so a parse error there is not a bug. */
const JSONC = /(^|\/)(tsconfig[\w.-]*|jsconfig[\w.-]*|\.eslintrc[\w.-]*|\.babelrc|devcontainer|\.swcrc)\.json$|\.jsonc$/i;

export const codeHygieneAgent: EngineAgent<CodeContext> = {
  id: "code.hygiene",
  name: "Project health",
  description: "Checks for broken JSON, missing tests, a README and .gitignore, committed node_modules and leftover debug code.",
  category: "functional",
  engine: "code",
  products: ["code"],
  run({ files, allPaths, skippedDirs, source, note }) {
    const out: Finding[] = [];
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, pageUrl = "project", evidence?: string) =>
      out.push(finding({ category: "functional", rule, severity, title, detail, pageUrl, evidence }));

    for (const f of files) {
      if (!f.path.endsWith(".json") || JSONC.test(f.path) || f.size > 2_000_000) continue;
      try {
        JSON.parse(f.text);
      } catch (err) {
        add(
          "code:broken-json",
          /(^|\/)(package|composer|app|manifest)\.json$/.test(f.path) ? "high" : "medium",
          "Broken JSON file",
          `${f.path} does not parse, so anything that reads it (installs, builds, the app) fails.`,
          f.path,
          (err as Error).message.slice(0, 160),
        );
      }
    }

    const top = (name: RegExp) => allPaths.some((p) => !p.includes("/") && name.test(p));
    if (!top(/^readme(\.\w+)?$/i)) add("code:no-readme", "low", "No README", "Add a README.md that says what the project is, how to run it and how to deploy it, so a new developer can start in minutes.");
    if (source === "git" && !top(/^\.gitignore$/)) {
      add("code:no-gitignore", "low", "No .gitignore", "Add a .gitignore so build output, node_modules and .env files are never committed.");
    }
    const modules = skippedDirs.filter((d) => /(^|\/)node_modules$/.test(d));
    if (source === "git" && modules.length) {
      add(
        "code:node-modules-committed",
        "medium",
        "node_modules is saved in the repository",
        "Installed packages are committed, which bloats the repository and hides which versions really run. Remove the folder with git rm -r --cached node_modules and add it to .gitignore.",
        modules[0],
      );
    }

    const code = files.filter((f) => /\.(m?[jt]sx?|cjs|vue|svelte|php|py|java|kt|rb|go|cs)$/i.test(f.path));
    const tests = allPaths.filter((p) => TEST_PATH.test(p) && /\.(m?[jt]sx?|php|py|java|kt|rb|go|cs)$/i.test(p) && !/(^|\/)(examples?|samples?|demo)\//i.test(p));
    if (code.length >= 10 && !tests.length) {
      add(
        "code:no-tests",
        "low",
        "No automated tests found",
        `${code.length} code files and no test files. Start with tests for the money paths: sign-up, login, checkout and payments.`,
      );
    }

    let consoleLogs = 0;
    let firstLog = "";
    let todos = 0;
    for (const f of code) {
      if (TEST_PATH.test(f.path) || /\.min\.js$/.test(f.path)) continue;
      const logs = (f.text.match(/^\s*console\.log\(/gm) ?? []).length + (f.text.match(/^\s*(var_dump|print_r)\s*\(/gm) ?? []).length;
      if (logs && !firstLog) firstLog = f.path;
      consoleLogs += logs;
      todos += (f.text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
    }
    if (consoleLogs >= 20) {
      add(
        "code:debug-output",
        "low",
        "Leftover debug output",
        `${consoleLogs} console.log, var_dump or print_r calls in the app code. They slow pages down and can print private data to the browser console. Remove them or use a logger with levels.`,
        firstLog,
        `${consoleLogs} calls`,
      );
    }
    if (todos) note(`${todos} TODO or FIXME notes in the code.`);
    note(`${code.length.toLocaleString("en-IN")} code files, ${tests.length.toLocaleString("en-IN")} test files.`);
    return out;
  },
};
