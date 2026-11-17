import YAML from "yaml";
import { pool } from "../../engines/agents.js";
import { finding } from "../../runner/finding.js";
import type { Finding, Severity } from "../../types.js";
import type { EngineAgent } from "../types.js";
import type { CodeContext, SourceFile } from "./context.js";

export type Ecosystem = "npm" | "PyPI" | "Packagist" | "RubyGems" | "Go";

export interface Dependency {
  ecosystem: Ecosystem;
  name: string;
  version: string;
  /** The file it was read from. */
  file: string;
  /** Only used while developing (not shipped to users). */
  dev?: boolean;
}

const base = (p: string) => p.split("/").pop() ?? p;
const dir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const json = (f: SourceFile) => {
  try {
    return JSON.parse(f.text);
  } catch {
    return null;
  }
};

/** Reads the exact package versions from lockfiles (and pinned versions from files without one). */
export function readDependencies(files: SourceFile[]): { deps: Dependency[]; unpinned: string[] } {
  const deps: Dependency[] = [];
  const unpinned: string[] = [];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const has = (d: string, ...names: string[]) => names.some((n) => byPath.has(d + n));

  for (const f of files) {
    const name = base(f.path);
    const d = dir(f.path);
    if (name === "package-lock.json" || name === "npm-shrinkwrap.json") {
      const lock = json(f);
      if (!lock) continue;
      if (lock.packages) {
        for (const [key, info] of Object.entries<{ version?: string; dev?: boolean; link?: boolean }>(lock.packages)) {
          if (!key.includes("node_modules/") || info.link || !info.version) continue;
          const pkg = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
          deps.push({ ecosystem: "npm", name: pkg, version: info.version, file: f.path, dev: info.dev });
        }
      } else if (lock.dependencies) {
        const walk = (tree: Record<string, { version?: string; dev?: boolean; dependencies?: object }>) => {
          for (const [pkg, info] of Object.entries(tree)) {
            if (info.version && /^\d/.test(info.version)) deps.push({ ecosystem: "npm", name: pkg, version: info.version, file: f.path, dev: info.dev });
            if (info.dependencies) walk(info.dependencies as typeof tree);
          }
        };
        walk(lock.dependencies);
      }
    } else if (name === "yarn.lock") {
      // "name@^1.0.0", name@^1.1.0:\n  version "1.2.3"
      const re = /^"?((?:@[^/@\s]+\/)?[^@\s"]+)@[^\n]*:\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:? "?([^"\n]+)"?/gm;
      for (const m of f.text.matchAll(re)) deps.push({ ecosystem: "npm", name: m[1], version: m[2].trim(), file: f.path });
    } else if (name === "pnpm-lock.yaml") {
      try {
        const lock = YAML.parse(f.text);
        for (const key of Object.keys(lock?.packages ?? {})) {
          // "/name@1.2.3", "name@1.2.3(peer@x)" or "/@scope/name/1.2.3"
          const m = key.replace(/^\//, "").replace(/\(.*$/, "").match(/^((?:@[^/]+\/)?[^@/]+)[@/](\d[^/]*)$/);
          if (m) deps.push({ ecosystem: "npm", name: m[1], version: m[2], file: f.path, dev: lock.packages[key]?.dev });
        }
      } catch {
        /* unreadable lockfile: skipped */
      }
    } else if (name === "package.json" && !f.path.includes("node_modules/")) {
      if (has(d, "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json")) continue;
      const pkg = json(f);
      const all = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) } as Record<string, string>;
      if (!Object.keys(all).length) continue;
      unpinned.push(f.path);
      for (const [pkgName, v] of Object.entries(all)) {
        if (/^\d+\.\d+\.\d+$/.test(String(v))) deps.push({ ecosystem: "npm", name: pkgName, version: String(v), file: f.path });
      }
    } else if (/^requirements[\w.-]*\.txt$/i.test(name)) {
      for (const line of f.text.split("\n")) {
        const m = line.trim().match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([\w.!+-]+)/);
        if (m) deps.push({ ecosystem: "PyPI", name: m[1], version: m[2], file: f.path });
      }
    } else if (name === "Pipfile.lock") {
      const lock = json(f);
      for (const section of ["default", "develop"]) {
        for (const [pkg, info] of Object.entries<{ version?: string }>(lock?.[section] ?? {})) {
          if (info.version?.startsWith("==")) deps.push({ ecosystem: "PyPI", name: pkg, version: info.version.slice(2), file: f.path, dev: section === "develop" });
        }
      }
    } else if (name === "poetry.lock") {
      for (const m of f.text.matchAll(/\[\[package\]\]\s*\nname\s*=\s*"([^"]+)"\s*\nversion\s*=\s*"([^"]+)"/g)) {
        deps.push({ ecosystem: "PyPI", name: m[1], version: m[2], file: f.path });
      }
    } else if (name === "composer.lock") {
      const lock = json(f);
      for (const [section, dev] of [["packages", false], ["packages-dev", true]] as const) {
        for (const p of (lock?.[section] ?? []) as { name: string; version: string }[]) {
          if (p.name && p.version) deps.push({ ecosystem: "Packagist", name: p.name, version: p.version.replace(/^v/, ""), file: f.path, dev });
        }
      }
    } else if (name === "composer.json") {
      if (!has(d, "composer.lock")) {
        const pkg = json(f);
        if (Object.keys(pkg?.require ?? {}).some((k) => k.includes("/"))) unpinned.push(f.path);
      }
    } else if (name === "Gemfile.lock") {
      const specs = f.text.split(/^\s*specs:\s*$/m)[1] ?? "";
      for (const m of specs.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(([^)\s]+)\)/gm)) deps.push({ ecosystem: "RubyGems", name: m[1], version: m[2], file: f.path });
    } else if (name === "go.mod") {
      for (const m of f.text.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) {
        if (m[1] !== "module") deps.push({ ecosystem: "Go", name: m[1], version: m[2], file: f.path });
      }
    }
  }
  const seen = new Set<string>();
  return {
    deps: deps.filter((d) => {
      const k = `${d.ecosystem}|${d.name}|${d.version}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
    unpinned,
  };
}

/** Compares loose version strings: 1.2.10 > 1.2.9, v2 = 2.0.0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

interface OsvVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type: string; events: { introduced?: string; fixed?: string }[] }[];
  }[];
}

const OSV_SEVERITY: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };
const RANK: Severity[] = ["info", "low", "medium", "high", "critical"];
const worst = (a: Severity, b: Severity) => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

function severityOf(v: OsvVuln): Severity {
  if (v.id.startsWith("MAL-")) return "critical";
  return OSV_SEVERITY[(v.database_specific?.severity ?? "").toUpperCase()] ?? "medium";
}

/** The first version that fixes the hole for the version in use, when the database says. */
export function fixedVersion(v: OsvVuln, dep: Dependency): string | undefined {
  for (const a of v.affected ?? []) {
    if (a.package?.name && a.package.name.toLowerCase() !== dep.name.toLowerCase()) continue;
    for (const r of a.ranges ?? []) {
      if (r.type === "GIT") continue;
      let introduced = "0";
      for (const e of r.events) {
        if (e.introduced !== undefined) introduced = e.introduced;
        if (e.fixed !== undefined) {
          if ((introduced === "0" || compareVersions(dep.version, introduced) >= 0) && compareVersions(dep.version, e.fixed) < 0) return e.fixed;
        }
      }
    }
  }
  return undefined;
}

const OSV_URL = () => (process.env.OSV_URL ?? "https://api.osv.dev").replace(/\/$/, "");

export const codePackagesAgent: EngineAgent<CodeContext> = {
  id: "code.packages",
  name: "Vulnerable packages",
  description: "Reads lockfiles (npm, Composer, pip, Poetry, Ruby, Go) and looks up every package in the OSV vulnerability database.",
  category: "security",
  engine: "code",
  products: ["code"],
  async run({ files, request, log, note }) {
    const out: Finding[] = [];
    const { deps, unpinned } = readDependencies(files);
    for (const file of unpinned) {
      out.push(
        finding({
          category: "functional",
          rule: "code:no-lockfile",
          severity: "low",
          title: "No lockfile: each install can pull different package versions",
          detail: `${file} has no lockfile next to it, so the code that runs in production can differ from what was tested, and packages cannot be checked for known holes. Commit the lockfile (package-lock.json, composer.lock).`,
          pageUrl: file,
        }),
      );
    }
    if (!deps.length) {
      note("No package lockfiles found, so no packages were looked up.");
      return out;
    }
    log(`Looking up ${deps.length} packages in the OSV vulnerability database`);
    const capped = deps.slice(0, 3000);
    const hits: { dep: Dependency; ids: string[] }[] = [];
    try {
      for (let i = 0; i < capped.length; i += 500) {
        const batch = capped.slice(i, i + 500);
        const res = await request.post(`${OSV_URL()}/v1/querybatch`, {
          data: { queries: batch.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) },
          timeout: 60_000,
        });
        if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
        const body = (await res.json()) as { results: { vulns?: { id: string }[] }[] };
        body.results.forEach((r, j) => {
          if (r.vulns?.length) hits.push({ dep: batch[j], ids: r.vulns.map((v) => v.id) });
        });
      }
    } catch (err) {
      note(`Could not reach the OSV vulnerability database (${(err as Error).message.split("\n")[0]}), so ${deps.length} packages were not checked.`);
      return out;
    }

    const ids = [...new Set(hits.flatMap((h) => h.ids))].slice(0, 150);
    const details = new Map<string, OsvVuln>();
    await pool(ids, 6, async (id) => {
      try {
        const res = await request.get(`${OSV_URL()}/v1/vulns/${encodeURIComponent(id)}`, { timeout: 30_000 });
        if (res.ok()) details.set(id, (await res.json()) as OsvVuln);
      } catch {
        /* the id alone is still reported */
      }
    });

    for (const { dep, ids: vulnIds } of hits) {
      const vulns = vulnIds.map((id) => details.get(id) ?? ({ id } as OsvVuln));
      let severity = vulns.map(severityOf).reduce(worst, "low" as Severity);
      // Tools used only while developing do not reach users, so they matter less.
      if (dep.dev && severity !== "critical") severity = severity === "high" ? "medium" : "low";
      const fixes = vulns.map((v) => fixedVersion(v, dep)).filter((v): v is string => Boolean(v));
      const target = fixes.sort(compareVersions).pop();
      const listed = vulns
        .slice(0, 4)
        .map((v) => `${v.aliases?.find((a) => a.startsWith("CVE-")) ?? v.id}${v.summary ? ` (${v.summary.replace(/\.$/, "")})` : ""}`)
        .join("; ");
      out.push(
        finding({
          category: "security",
          rule: "code:vulnerable-package",
          severity,
          title: `Package with known security holes: ${dep.name}`,
          detail: `${dep.name} ${dep.version} (${dep.ecosystem}${dep.dev ? ", development only" : ""}) has ${vulns.length} published vulnerabilit${
            vulns.length === 1 ? "y" : "ies"
          }: ${listed}${vulns.length > 4 ? "; and more" : ""}. ${target ? `Upgrade to ${target} or newer.` : "Upgrade to the latest version, or replace the package."}`,
          pageUrl: dep.file,
          evidence: `${dep.name}@${dep.version}: ${vulnIds.slice(0, 6).join(", ")}`,
        }),
      );
    }
    note(`Looked up ${deps.length.toLocaleString("en-IN")} packages in the OSV database: ${hits.length} have known holes.`);
    return out;
  },
};
