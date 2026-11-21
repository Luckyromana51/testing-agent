import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Test cases an agent ran, counted while it runs. An agent calls `countCases` for each scenario it
 * tried (an empty required field, a value one past the limit, a call without a login...), and the
 * runner adds the totals to the agent's numbers, so the report can show how many test cases ran
 * and how many failed, not only the problems found.
 */
export interface CaseCount {
  tried: number;
  failed: number;
}

const store = new AsyncLocalStorage<CaseCount>();

/** Runs an agent with its own case counter. */
export function withCases<T>(counter: CaseCount, fn: () => T): T {
  return store.run(counter, fn);
}

/** Notes test cases the running agent tried, and how many of them failed. Does nothing outside an agent. */
export function countCases(tried: number, failed = 0): void {
  const c = store.getStore();
  if (!c) return;
  c.tried += Math.max(0, tried);
  c.failed += Math.max(0, Math.min(failed, tried));
}
