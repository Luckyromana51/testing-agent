import { readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_AGENTS, WEB_AGENTS } from "./agents/registry.js";
import type { PageAgent } from "./agents/types.js";
import { WEB_PRODUCTS } from "./products.js";
import { finding } from "./runner/finding.js";
import { CATEGORIES, type Category } from "./types.js";

/**
 * Optional modules: parts of the platform the owner switches on or off in the owner panel.
 * Each one is open source (our own code, or an open-source tool in our Docker image) and runs on
 * our server, so nothing goes to an outside service. A module that is off costs no time.
 */
export interface ModuleInfo {
  id: ModuleId;
  name: string;
  description: string;
  /** What it is built on, and that project's licence. */
  builtOn: string;
  license: string;
  defaultOn: boolean;
  /** Takes effect only after the server restarts. */
  needsRestart?: boolean;
}

export type ModuleId = "inspect" | "visual" | "journeys" | "own-checks";

export const MODULES: ModuleInfo[] = [
  {
    id: "inspect",
    name: "Inspect screen",
    description:
      "Records each page like a browser's developer tools: a step timeline, every request with its timing and headers (network waterfall), the console, the page's HTML, the tab order and headings drawn over the screenshot, and unused JavaScript and CSS. Adds a HAR download per page.",
    builtOn: "Playwright (Chromium's DevTools protocol), GLV code",
    license: "Apache-2.0",
    defaultOn: true,
  },
  {
    id: "visual",
    name: "Visual compare",
    description:
      "Keeps an approved picture of every page (desktop and phone) for each project. Each new test compares against it and shows the old picture, the new one and the changed parts in red. Approve a change to make it the new picture.",
    builtOn: "GLV code (the compare runs in the test's own browser)",
    license: "GLV",
    defaultOn: true,
  },
  {
    id: "journeys",
    name: "User journeys",
    description:
      "Steps written in plain words for each project (open the shop, click Add to cart, see the total) that run on every test, with a picture after each step. Read-only by default: forms are not sent unless the journey is allowed to.",
    builtOn: "Playwright, GLV code",
    license: "Apache-2.0",
    defaultOn: true,
  },
  {
    id: "own-checks",
    name: "Own checks folder",
    description:
      "Loads your own website checks from .mjs files in the modules folder (data/modules), and lists them with the other agents. For checks only your team needs. Owner only: the files run on this server.",
    builtOn: "GLV code",
    license: "GLV",
    defaultOn: false,
    needsRestart: true,
  },
];

export function moduleOn(modules: Record<string, boolean> | undefined, id: ModuleId): boolean {
  const m = MODULES.find((x) => x.id === id);
  return modules?.[id] ?? m?.defaultOn ?? false;
}

/** What an own check file exports (as its default export). */
export interface OwnCheck {
  id: string;
  name: string;
  description?: string;
  category?: Category;
  run: PageAgent["run"];
}

/**
 * Loads the own checks from `dir`. Each file is one page agent; its id gets an "own:" prefix so it
 * can never replace a GLV agent. Files with mistakes are skipped and reported, never fatal.
 */
export async function loadOwnChecks(dir: string, log: (m: string) => void = () => {}): Promise<string[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
  } catch {
    log(`Own checks: no folder at ${dir}`);
    return [];
  }
  const loaded: string[] = [];
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as { default?: Partial<OwnCheck> };
      const c = mod.default;
      if (!c || typeof c.run !== "function" || !c.id || !c.name) throw new Error("export default { id, name, run(ctx) } is missing");
      const id = `own:${String(c.id).replace(/[^\w-]/g, "-").slice(0, 40)}`;
      if (ALL_AGENTS.some((a) => a.id === id)) throw new Error(`${id} is already loaded`);
      const run = c.run;
      const agent: PageAgent = {
        id,
        name: String(c.name).slice(0, 60),
        description: String(c.description ?? "Your own check, loaded from the modules folder.").slice(0, 300),
        category: CATEGORIES.includes(c.category as Category) ? (c.category as Category) : "functional",
        engine: "web",
        products: [...WEB_PRODUCTS],
        stage: "page",
        // Findings always carry the agent's rule prefix, so they can be told apart in the report.
        run: async (ctx) => {
          const found = (await run(ctx)) ?? [];
          return found.slice(0, 100).map((f) => {
            const { id: _id, ...rest } = f;
            return finding({
              ...rest,
              category: CATEGORIES.includes(f.category) ? f.category : agent.category,
              severity: ["critical", "high", "medium", "low", "info"].includes(f.severity) ? f.severity : "low",
              title: String(f.title ?? "Own check").slice(0, 200),
              detail: String(f.detail ?? "").slice(0, 2000),
              rule: f.rule?.startsWith("own:") ? f.rule : `own:${f.rule ?? c.id}`,
              pageUrl: f.pageUrl || ctx.url,
            });
          });
        },
      };
      WEB_AGENTS.push(agent);
      ALL_AGENTS.push(agent);
      loaded.push(id);
    } catch (err) {
      log(`Own checks: skipped ${file}: ${(err as Error).message}`);
    }
  }
  if (loaded.length) log(`Own checks: loaded ${loaded.join(", ")}`);
  return loaded;
}
