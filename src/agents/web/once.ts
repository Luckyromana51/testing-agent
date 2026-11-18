import type { Finding } from "../../types.js";

/** One thing a finding is about (a file, a library, a comment), with the line that shows it. */
export interface SharedItem {
  key: string;
  line: string;
}

interface Shared {
  group: string;
  items: SharedItem[];
  build: (items: SharedItem[]) => Finding;
}

const shared = new WeakMap<Finding, Shared>();

/**
 * A finding about things that many pages load (a script, an image, a comment in the footer). Every
 * page reports what it saw; the crawler then keeps each thing on the first page, in page order,
 * that has it. The report shows the problem once instead of on every page, and it lands on the
 * same page whatever order the pages finished in.
 */
export function sharedFinding(group: string, items: SharedItem[], build: (items: SharedItem[]) => Finding): Finding[] {
  const unique = [...new Map(items.map((i) => [i.key, i])).values()];
  if (!unique.length) return [];
  const f = build(unique);
  shared.set(f, { group, items: unique, build });
  return [f];
}

/**
 * Keeps each shared thing on the first page that saw it. `findings` must be in page order. Returns
 * how many findings each agent lost, so its numbers can be corrected.
 */
export function keepFirstSightings(findings: Finding[]): Map<string, number> {
  const seen = new Map<string, Set<string>>();
  const removed = new Map<string, number>();
  for (let i = 0; i < findings.length; i++) {
    const s = shared.get(findings[i]);
    if (!s) continue;
    const keys = seen.get(s.group) ?? new Set<string>();
    seen.set(s.group, keys);
    const fresh = s.items.filter((it) => !keys.has(it.key));
    for (const it of fresh) keys.add(it.key);
    if (fresh.length === s.items.length) continue;
    const agent = findings[i].agent;
    if (!fresh.length) {
      if (agent) removed.set(agent, (removed.get(agent) ?? 0) + 1);
      findings.splice(i--, 1);
      continue;
    }
    const f = s.build(fresh);
    f.agent = agent;
    findings[i] = f;
  }
  return removed;
}
