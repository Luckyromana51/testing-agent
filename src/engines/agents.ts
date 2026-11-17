import type { EngineAgent } from "../agents/types.js";
import { NotTestedError } from "../runner/coverage.js";
import { finding } from "../runner/finding.js";
import type { AgentStat, Finding } from "../types.js";

/**
 * Runs the agents of a non-web engine one after another and keeps per-agent numbers.
 * One agent failing never stops the others: it leaves an info note instead.
 */
export async function runEngineAgents<Ctx>(
  agents: EngineAgent<Ctx>[],
  ctx: Ctx,
  target: string,
  log: (m: string) => void,
): Promise<{ findings: Finding[]; stats: AgentStat[] }> {
  const findings: Finding[] = [];
  const stats: AgentStat[] = [];
  for (const agent of agents) {
    const stat: AgentStat = { id: agent.id, name: agent.name, findings: 0, ms: 0, errors: 0, category: agent.category, runs: 1 };
    stats.push(stat);
    log(`Agent: ${agent.name}`);
    const started = Date.now();
    try {
      const out = await agent.run(ctx);
      for (const f of out) f.agent ??= agent.id;
      stat.findings = out.length;
      findings.push(...out);
    } catch (err) {
      if (err instanceof NotTestedError) {
        // The check could not be done: report it as not tested, keeping what it did find.
        for (const f of err.partial) f.agent ??= agent.id;
        stat.findings = err.partial.length;
        stat.untested = err.message;
        findings.push(...err.partial);
        log(`${agent.name}: not tested (${err.message})`);
        continue;
      }
      stat.errors++;
      stat.untested = `Stopped with an error: ${(err as Error).message.split("\n")[0]}`;
      findings.push(
        finding({
          category: "functional",
          rule: "check-error",
          severity: "info",
          title: `The ${agent.name} agent could not finish`,
          detail: (err as Error).message.split("\n")[0],
          pageUrl: target,
          agent: agent.id,
        }),
      );
    } finally {
      stat.ms = Date.now() - started;
    }
  }
  return { findings, stats };
}

/** Runs `fn` over `items` with at most `limit` at a time, keeping the order of results. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
