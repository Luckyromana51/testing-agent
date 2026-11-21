import { existsSync } from "node:fs";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { uploadedPath } from "../engines/index.js";
import { WEB_PRODUCTS } from "../products.js";
import { lastLine, runProcess } from "./process.js";
import { unpackZip } from "./source.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Bring your own tests: runs a client's own Playwright tests (a zip of their tests folder) against
 * the project's address, with our Chromium and our copy of @playwright/test. Each failed test is an
 * issue, and a test that passed only on its second try is marked flaky.
 */

const require = createRequire(import.meta.url);

/** Our @playwright/test, and the node_modules folder it lives in (linked into the client's folder). */
function playwrightTest(): { cli: string; nodeModules: string } | null {
  try {
    const pkg = require.resolve("@playwright/test/package.json");
    const dir = path.dirname(pkg);
    return { cli: path.join(dir, "cli.js"), nodeModules: path.resolve(dir, "..", "..") };
  } catch {
    return null;
  }
}

const CONFIG_NAMES = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs", "playwright.config.mts", "playwright.config.cjs"];

/** The test folder's own config, if it has one (at the top, or one folder down). */
export async function findConfig(root: string): Promise<string | undefined> {
  for (const n of CONFIG_NAMES) if (existsSync(path.join(root, n))) return path.join(root, n);
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    for (const n of CONFIG_NAMES) if (existsSync(path.join(root, d.name, n))) return path.join(root, d.name, n);
  }
  return undefined;
}

/**
 * Our config, written next to theirs so their relative paths still work: theirs (if any) with the project's address as baseURL, Chromium projects only (the
 * browser we have), one retry so flaky tests show, no web server of theirs, and our JSON report.
 */
export function wrapperConfig(opts: { theirs?: string; outputFile: string; workers: number }): string {
  const j = JSON.stringify;
  return `import { defineConfig } from "@playwright/test";
${opts.theirs ? `import theirs from ${j(`./${path.basename(opts.theirs)}`)};` : "const theirs = {};"}
const base = theirs && theirs.default ? theirs.default : theirs;
const chromium = (p) => !p.use || !p.use.browserName || p.use.browserName === "chromium";
const projects = (base.projects || []).filter(chromium).map((p) => ({ ...p, use: { ...p.use, baseURL: process.env.BASE_URL } }));
export default defineConfig({
  ...base,
  testDir: base.testDir || ".",
  webServer: undefined,
  retries: Math.max(base.retries || 0, 1),
  workers: ${opts.workers},
  forbidOnly: false,
  timeout: Math.min(base.timeout || 30000, 120000),
  reporter: [["json", { outputFile: ${j(opts.outputFile)} }]],
  outputDir: ${j(path.join(path.dirname(opts.outputFile), "byo-results"))},
  use: { ...base.use, baseURL: process.env.BASE_URL, trace: "off", video: "off" },
  projects: projects.length ? projects : undefined,
});
`;
}

/* The parts of Playwright's JSON report we read. */
interface PwResult {
  status: string;
  error?: { message?: string };
  errors?: { message?: string }[];
}
interface PwTest {
  status: "expected" | "unexpected" | "flaky" | "skipped";
  projectName?: string;
  results: PwResult[];
}
interface PwSpec {
  title: string;
  file?: string;
  line?: number;
  tests: PwTest[];
}
interface PwSuite {
  title: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
export interface PwReport {
  suites?: PwSuite[];
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number; duration?: number };
  errors?: { message?: string }[];
}

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

/** Every test in the report, with the names of the groups it is in. */
function walk(s: PwSuite, names: string[], out: { name: string; spec: PwSpec; test: PwTest }[]) {
  const here = s.file && s.title === s.file ? names : [...names, s.title].filter(Boolean);
  for (const spec of s.specs ?? []) for (const test of spec.tests) out.push({ name: [...here, spec.title].join(" › "), spec, test });
  for (const c of s.suites ?? []) walk(c, here, out);
}

/** Turns the JSON report into issues and the summary lines. */
export function readReport(r: PwReport, startUrl: string): { findings: ToolFinding[]; summary: string[]; rows: string[][] } {
  const all: { name: string; spec: PwSpec; test: PwTest }[] = [];
  for (const s of r.suites ?? []) walk(s, [], all);
  const findings: ToolFinding[] = [];
  const rows: string[][] = [];
  for (const { name, spec, test } of all) {
    if (test.status !== "unexpected" && test.status !== "flaky") continue;
    const failed = test.results.find((x) => x.status !== "passed" && x.status !== "skipped");
    const msg = stripAnsi(failed?.error?.message ?? failed?.errors?.[0]?.message ?? "").trim();
    const where = spec.file ? `${spec.file}${spec.line ? `:${spec.line}` : ""}` : undefined;
    const flaky = test.status === "flaky";
    rows.push([flaky ? "Flaky" : "Failed", name, where ?? ""]);
    findings.push({
      category: "functional",
      rule: flaky ? "byo:test-flaky" : "byo:test-failed",
      severity: flaky ? "medium" : "high",
      title: flaky ? `Your test "${name}" is flaky (failed, then passed on the second try)` : `Your test "${name}" fails`,
      detail: `${msg.split("\n").slice(0, 8).join("\n").slice(0, 1200) || "The test failed."}${test.projectName ? `\n(Project: ${test.projectName})` : ""}`,
      pageUrl: startUrl,
      ...(where ? { evidence: where } : {}),
      key: `byo:${where ?? ""}:${name}`,
    });
  }
  for (const e of r.errors ?? []) {
    const msg = stripAnsi(e.message ?? "").trim();
    if (!msg) continue;
    findings.push({ category: "functional", rule: "byo:test-failed", severity: "high", title: "Your tests could not start", detail: msg.slice(0, 1200), pageUrl: startUrl });
  }
  const st = r.stats ?? {};
  const summary = [
    `${st.expected ?? 0} passed, ${st.unexpected ?? 0} failed, ${st.flaky ?? 0} flaky, ${st.skipped ?? 0} skipped`,
    ...(st.duration ? [`Took ${Math.round(st.duration / 1000)} seconds`] : []),
  ];
  return { findings, summary, rows };
}

export const byoTool: Tool = {
  id: "byo-playwright",
  name: "Your own tests (Playwright)",
  maker: "Microsoft (Playwright), run by GLV",
  description:
    "Runs the client's own Playwright tests against this project's address and shows each failed or flaky test as an issue. Upload a zip of the tests folder (with playwright.config if it has one; node_modules is not needed).",
  checks: [
    "The tests the developers already wrote, on every GLV test",
    "Their baseURL is set to this project's address",
    "Each test gets one retry, so flaky tests are marked as flaky",
  ],
  products: WEB_PRODUCTS,
  category: "functional",
  safety: "safe",
  takes: "depends on the tests, usually a few minutes",
  licence: "Apache-2.0",
  homepage: "https://playwright.dev",
  signedIn: "public",
  module: "byo-tests",
  options: [
    {
      id: "tests",
      label: "Zip of the tests folder",
      kind: "file",
      accept: ".zip",
      required: true,
      hint: "The tests are the client's code and run on this server: only for code you trust. Point them at a staging site, as tests may change data.",
      choices: [],
      default: "",
    },
    {
      id: "workers",
      label: "Tests at the same time",
      choices: [
        { value: "1", label: "One at a time" },
        { value: "2", label: "Two" },
        { value: "4", label: "Four" },
      ],
      default: "2",
    },
  ],

  async ready() {
    return playwrightTest() ? null : "@playwright/test is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const pw = playwrightTest();
    if (!pw) throw new Error("@playwright/test is not installed on this server.");
    const file = ctx.options.tests;
    if (!file) throw new Error("No tests zip was uploaded in the tab for your own tests.");
    const zip = uploadedPath(ctx.uploadsDir, file);
    if (!existsSync(zip)) throw new Error("The uploaded tests zip is gone. Upload it again.");
    const root = await unpackZip(zip, path.join(ctx.workDir, "byo"));
    // Their imports of @playwright/test find ours.
    await symlink(pw.nodeModules, path.join(root, "node_modules"), "dir").catch(() => {});
    const theirs = await findConfig(root);
    const outputFile = path.join(ctx.workDir, "byo-report.json");
    const config = path.join(theirs ? path.dirname(theirs) : root, "glv.playwright.config.mjs");
    const workers = [1, 2, 4].includes(Number(ctx.options.workers)) ? Number(ctx.options.workers) : 2;
    await writeFile(config, wrapperConfig({ theirs, outputFile, workers }));
    ctx.log(`Your own tests: running${theirs ? ` with ${path.relative(root, theirs)}` : ""} against ${ctx.startUrl}`);
    const res = await runProcess(process.execPath, [pw.cli, "test", "--config", config], {
      signal: ctx.signal,
      timeoutMs: 30 * 60_000,
      cwd: root,
      // A clean environment: their code sees none of this server's settings or keys.
      env: {
        PATH: process.env.PATH,
        HOME: ctx.workDir,
        CI: "1",
        BASE_URL: ctx.startUrl,
        PLAYWRIGHT_BASE_URL: ctx.startUrl,
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
      },
      maxOutput: 200_000,
    });
    let report: PwReport;
    try {
      report = JSON.parse(await readFile(outputFile, "utf8")) as PwReport;
    } catch {
      throw new Error(`Your tests did not run (exit ${res.code}): ${lastLine(res.stderr + res.stdout) || "no output"}`);
    }
    await writeFile(path.join(ctx.outDir, "tool-byo.json"), JSON.stringify(report));
    const r = readReport(report, ctx.startUrl);
    return {
      findings: r.findings,
      summary: r.summary,
      reports: [{ file: "tool-byo.json", label: "Playwright report (JSON)" }],
      ...(r.rows.length ? { table: { title: "Tests that failed or are flaky", columns: ["Result", "Test", "File"], rows: r.rows.slice(0, 100) } } : {}),
      tested: r.summary[0],
    };
  },
};
