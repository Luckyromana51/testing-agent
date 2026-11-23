import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Maestro flows (open source, Apache-2.0): simpler app journeys than Appium, written as short readable
 * YAML (tapOn: "Login", inputText, assertVisible). The tester uploads a .yaml flow (or a zip of them)
 * and GLV runs it on a connected phone, reporting which steps passed. Started by hand on a phone.
 */

export interface FlowResult {
  flow: string;
  passed: boolean;
  failedStep?: string;
}

/** Reads Maestro's console output into per-flow results. Pure, for tests. */
export function parseMaestroOutput(out: string): FlowResult[] {
  const results: FlowResult[] = [];
  // Maestro prints each flow name then ✅/❌ per command; a flow fails if any command shows ❌ or "Failed".
  const blocks = out.split(/(?=^\s*(?:Running on|Flow:|> Flow))/m);
  for (const block of blocks) {
    const name = block.match(/Flow:\s*(.+)|Running flow\s+(.+)|([\w.-]+\.ya?ml)/)?.slice(1).find(Boolean)?.trim();
    if (!name) continue;
    const failed = /❌|FAILED|Assertion is false|Element not found/.test(block);
    const failedStep = block.match(/(?:❌|FAILED)\s*(.+)/)?.[1]?.trim();
    results.push({ flow: name, passed: !failed, ...(failedStep ? { failedStep } : {}) });
  }
  return results;
}

export const maestroTool: Tool = {
  id: "maestro",
  name: "Maestro app flows",
  maker: "Maestro (mobile.dev, open source)",
  description:
    "Runs Maestro flows — short, readable YAML app journeys (tapOn, inputText, assertVisible) — on a connected phone. Simpler than Appium for everyday journeys like sign-in, add-to-cart or checkout. The tester uploads the flow file; GLV reports which steps passed.",
  checks: ["Runs uploaded Maestro .yaml flows on the test phone", "Reports the step that failed", "Readable YAML the client can keep and edit"],
  products: ["android", "ios"],
  category: "functional",
  safety: "safe",
  takes: "1 to 5 minutes",
  licence: "Apache-2.0",
  homepage: "https://maestro.mobile.dev",
  signedIn: "public",
  needsDevice: true,
  manual: true,
  options: [{ id: "flow", label: "Maestro flow (.yaml or .zip)", kind: "file", accept: ".yaml,.yml,.zip", required: true, hint: "A Maestro flow file, or a zip of flows.", choices: [], default: "" }],
  async ready() {
    return (await which(process.env.MAESTRO_PATH || "maestro")) ? null : "Maestro is not installed on this server (curl -Ls https://get.maestro.mobile.dev | bash).";
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    if (!ctx.options.flow) throw new Error("Upload a Maestro flow (.yaml) or a zip of flows.");
    const maestro = process.env.MAESTRO_PATH || "maestro";
    const upload = path.join(ctx.uploadsDir, ctx.options.flow);
    const dir = path.join(ctx.workDir, "flows");
    await mkdir(dir, { recursive: true });
    let target = upload;
    if (ctx.options.flow.endsWith(".zip")) {
      await runProcess("unzip", ["-o", upload, "-d", dir], { signal: ctx.signal, timeoutMs: 30_000 }).catch(() => undefined);
      target = dir;
    } else {
      await writeFile(path.join(dir, path.basename(upload)), await readFile(upload));
      target = path.join(dir, path.basename(upload));
    }
    ctx.log(`Maestro: running ${ctx.options.flow}`);
    const res = await runProcess(maestro, ["test", "--format", "junit", target], { signal: ctx.signal, timeoutMs: 15 * 60_000, cwd: ctx.workDir }).catch((e: Error) => ({ code: 1, stdout: "", stderr: e.message }));
    const out = `${res.stdout}\n${res.stderr}`;
    const results = parseMaestroOutput(out);
    const failed = results.filter((r) => !r.passed);
    // Maestro writes a JUnit report; keep it as evidence.
    const reportDir = path.join(ctx.workDir);
    const junit = (await readdir(reportDir).catch(() => [])).find((f) => /report.*\.xml$/.test(f));
    if (junit) await writeFile(path.join(ctx.outDir, "maestro-report.xml"), await readFile(path.join(reportDir, junit)));
    const findings: ToolFinding[] = failed.map((f) => ({ category: "functional", rule: "maestro:flow-failed", severity: "high", title: `Maestro flow failed: ${f.flow}`, detail: `The journey did not complete${f.failedStep ? ` (failed at: ${f.failedStep})` : ""}. This is a broken user journey on the phone. Fix the step, or update the flow if the screen changed.`, pageUrl: f.flow, evidence: lastLine(out) || out.slice(-800), key: `maestro:${f.flow}` }));
    if (!results.length && res.code !== 0) throw new Error(`Maestro did not run: ${lastLine(out) || `exit ${res.code}`}`);
    return {
      findings,
      summary: [`${results.length} flow${results.length === 1 ? "" : "s"}: ${results.filter((r) => r.passed).length} passed, ${failed.length} failed`],
      reports: junit ? [{ file: "maestro-report.xml", label: "Maestro JUnit report" }] : [],
      tested: `${results.length} Maestro flow(s)`,
    };
  },
};
