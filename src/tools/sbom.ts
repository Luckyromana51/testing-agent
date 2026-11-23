import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * SBOM and licence compliance: for any repository, GLV's own lockfile reader lists every dependency
 * (name, version, licence) and writes a CycloneDX SBOM the client can keep or hand to a customer.
 * It then flags copyleft licences (GPL, AGPL, LGPL, SSPL) pulled into a closed product, and packages
 * with no licence at all. When Syft (open source) is installed it is used instead for a fuller SBOM.
 * Read-only: it only reads the lockfiles already in the repository.
 */

export interface Dep {
  name: string;
  version: string;
  licence: string;
  ecosystem: string;
}

/** Licences that spread their terms to code that links them (a risk in a closed product). Pure, for tests. */
export const COPYLEFT: { id: RegExp; label: string; strong: boolean }[] = [
  { id: /\bA?GPL-?3/i, label: "AGPL-3.0", strong: true },
  { id: /\bAGPL/i, label: "AGPL", strong: true },
  { id: /\bGPL-?[23]/i, label: "GPL", strong: true },
  { id: /\bGPL\b/i, label: "GPL", strong: true },
  { id: /\bSSPL/i, label: "SSPL", strong: true },
  { id: /\bLGPL/i, label: "LGPL", strong: false },
  { id: /\bMPL-?2/i, label: "MPL-2.0", strong: false },
  { id: /\bEUPL/i, label: "EUPL", strong: false },
  { id: /\bCC-BY-SA/i, label: "CC-BY-SA", strong: false },
];

/** Classifies a licence string. Pure, for tests. */
export function classifyLicence(licence: string): { copyleft: boolean; strong: boolean; label: string } | null {
  for (const c of COPYLEFT) if (c.id.test(licence)) return { copyleft: true, strong: c.strong, label: c.label };
  return null;
}

/** Reads an npm package-lock.json (v2/v3) into deps. Pure, for tests. */
export function readNpmLock(json: string): Dep[] {
  const out: Dep[] = [];
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return out;
  }
  const packages = data.packages as Record<string, { version?: string; license?: string; dev?: boolean }> | undefined;
  if (packages) {
    for (const [key, info] of Object.entries(packages)) {
      if (!key.startsWith("node_modules/")) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      out.push({ name, version: info.version ?? "", licence: info.license ?? "", ecosystem: "npm" });
    }
    return out;
  }
  const deps = data.dependencies as Record<string, { version?: string }> | undefined;
  if (deps) for (const [name, info] of Object.entries(deps)) out.push({ name, version: info.version ?? "", licence: "", ecosystem: "npm" });
  return out;
}

/** Reads a yarn.lock into deps (name@range blocks with a version: line). Pure, for tests. */
export function readYarnLock(text: string): Dep[] {
  const out: Dep[] = [];
  for (const block of text.split(/\n\n+/)) {
    const head = block.match(/^"?((?:@[^/]+\/)?[^@\s"]+)@/m);
    const ver = block.match(/^\s+version:?\s+"?([^"\s]+)"?/m);
    if (head && ver) out.push({ name: head[1], version: ver[1], licence: "", ecosystem: "npm" });
  }
  return out;
}

/** Reads a Python requirements.txt / poetry.lock name==version lines. Pure, for tests. */
export function readPyLock(text: string, poetry = false): Dep[] {
  const out: Dep[] = [];
  if (poetry) {
    for (const block of text.split(/\n\n+/)) {
      const name = block.match(/^name\s*=\s*"([^"]+)"/m);
      const ver = block.match(/^version\s*=\s*"([^"]+)"/m);
      if (name && ver) out.push({ name: name[1], version: ver[1], licence: "", ecosystem: "pypi" });
    }
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z0-9._-]+)\s*==\s*([\w.+-]+)/);
    if (m) out.push({ name: m[1], version: m[2], licence: "", ecosystem: "pypi" });
  }
  return out;
}

/** Reads a composer.lock (PHP): packages[].name/version/license. Pure, for tests. */
export function readComposerLock(json: string): Dep[] {
  const out: Dep[] = [];
  try {
    const data = JSON.parse(json) as { packages?: { name?: string; version?: string; license?: string[] }[] };
    for (const p of data.packages ?? []) out.push({ name: p.name ?? "", version: p.version ?? "", licence: (p.license ?? []).join(" OR "), ecosystem: "composer" });
  } catch {
    // ignore
  }
  return out;
}

/** A minimal CycloneDX 1.5 SBOM for the deps. Pure, for tests. */
export function cycloneDx(deps: Dep[]): string {
  const purl = (d: Dep) => `pkg:${d.ecosystem === "composer" ? "composer" : d.ecosystem}/${d.name}@${d.version}`;
  return JSON.stringify(
    {
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      version: 1,
      metadata: { timestamp: new Date().toISOString(), tools: [{ vendor: "GLV Infotech", name: "testing-agent sbom" }] },
      components: deps.map((d) => ({
        type: "library",
        name: d.name,
        version: d.version,
        purl: purl(d),
        ...(d.licence ? { licenses: [{ license: { name: d.licence } }] } : {}),
      })),
    },
    null,
    2,
  );
}

const LOCKS: { file: string; read: (text: string) => Dep[] }[] = [
  { file: "package-lock.json", read: readNpmLock },
  { file: "npm-shrinkwrap.json", read: readNpmLock },
  { file: "yarn.lock", read: readYarnLock },
  { file: "pnpm-lock.yaml", read: (t) => readYarnLock(t) },
  { file: "composer.lock", read: readComposerLock },
  { file: "poetry.lock", read: (t) => readPyLock(t, true) },
  { file: "requirements.txt", read: (t) => readPyLock(t) },
];

export const sbomTool: Tool = {
  id: "sbom",
  name: "SBOM and licence check",
  maker: "GLV Infotech (built in), CycloneDX; Syft when installed",
  description:
    "Lists every dependency of a repository with its version and licence, writes a CycloneDX software bill of materials (SBOM) the client can keep or give a customer, and flags copyleft licences (GPL, AGPL, LGPL, SSPL) pulled into a closed product, and packages with no licence.",
  checks: ["A full CycloneDX SBOM for the repo", "Copyleft licences (GPL/AGPL/SSPL) in a closed product", "LGPL/MPL/EUPL weak-copyleft to review", "Packages with no licence stated"],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "Apache-2.0 (CycloneDX, Syft)",
  homepage: "https://github.com/anchore/syft",
  signedIn: "public",
  options: [
    { id: "product", label: "This product is", choices: [{ value: "closed", label: "Closed source (sold or internal)" }, { value: "open", label: "Open source" }], default: "closed" },
  ],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const dir = ctx.sourceDir;
    if (!dir) throw new Error("No code was provided. Add a Git repository or upload a zip.");
    const closed = (ctx.options.product || "closed") === "closed";
    let deps: Dep[] = [];
    let used = "GLV's lockfile reader";

    // Prefer Syft for a fuller SBOM when it is installed.
    const syft = await which(process.env.SYFT_PATH || "syft");
    if (syft) {
      const out = path.join(ctx.workDir, "syft.json");
      const res = await runProcess(syft, [`dir:${dir}`, "-o", `cyclonedx-json=${out}`, "-q"], { signal: ctx.signal, timeoutMs: 10 * 60_000, cwd: ctx.workDir }).catch(() => null);
      const raw = res && res.code === 0 ? await readFile(out, "utf8").catch(() => "") : "";
      if (raw) {
        try {
          const bom = JSON.parse(raw) as { components?: { name?: string; version?: string; purl?: string; licenses?: { license?: { id?: string; name?: string } }[] }[] };
          deps = (bom.components ?? []).map((c) => ({
            name: c.name ?? "",
            version: c.version ?? "",
            licence: (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? "").filter(Boolean).join(" OR "),
            ecosystem: (c.purl ?? "pkg:generic").split(":")[1]?.split("/")[0] ?? "generic",
          }));
          await writeFile(path.join(ctx.outDir, "sbom.cdx.json"), raw);
          used = "Syft";
        } catch {
          deps = [];
        }
      }
    }

    // Fall back to (or supplement with) our own lockfile reader.
    if (!deps.length) {
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const lock of LOCKS) {
        if (!files.includes(lock.file)) continue;
        const text = await readFile(path.join(dir, lock.file), "utf8").catch(() => "");
        if (text) deps.push(...lock.read(text));
      }
      const seen = new Set<string>();
      deps = deps.filter((d) => d.name && (seen.has(`${d.name}@${d.version}`) ? false : seen.add(`${d.name}@${d.version}`)));
      if (deps.length) await writeFile(path.join(ctx.outDir, "sbom.cdx.json"), cycloneDx(deps));
    }

    if (!deps.length) throw new Error("No lockfile was found to read dependencies (package-lock.json, yarn.lock, composer.lock, poetry.lock, requirements.txt).");
    ctx.log(`SBOM (${used}): ${deps.length} dependencies`);

    const findings: ToolFinding[] = [];
    const copyleft = deps.map((d) => ({ d, c: classifyLicence(d.licence) })).filter((x) => x.c);
    if (closed) {
      const strong = copyleft.filter((x) => x.c!.strong);
      if (strong.length)
        findings.push({
          category: "security",
          rule: "sbom:copyleft-strong",
          severity: "high",
          title: `${strong.length} strong-copyleft (GPL/AGPL/SSPL) package${strong.length === 1 ? "" : "s"} in a closed product`,
          detail:
            "AGPL, GPL and SSPL require you to release the source of the product that uses them (AGPL even over a network). In a product you sell or keep closed this is a legal and licence-compliance risk. Replace them with permissively licensed packages (MIT, Apache-2.0, BSD), or get a commercial licence, or open-source that component.",
          pageUrl: "repository",
          evidence: strong.map((x) => `${x.d.name}@${x.d.version} — ${x.c!.label} (${x.d.licence})`).slice(0, 20).join("\n"),
          key: "sbom:copyleft-strong",
        });
      const weak = copyleft.filter((x) => !x.c!.strong);
      if (weak.length)
        findings.push({
          category: "security",
          rule: "sbom:copyleft-weak",
          severity: "low",
          title: `${weak.length} weak-copyleft package${weak.length === 1 ? "" : "s"} to review (LGPL/MPL/EUPL)`,
          detail: "LGPL, MPL-2.0 and EUPL let you use the library in a closed product but have conditions (dynamic linking, sharing changes to the library's own files). Confirm you meet them, or keep these as separate, unmodified components.",
          pageUrl: "repository",
          evidence: weak.map((x) => `${x.d.name}@${x.d.version} — ${x.c!.label}`).slice(0, 20).join("\n"),
          key: "sbom:copyleft-weak",
        });
    }
    const noLicence = deps.filter((d) => !d.licence);
    if (noLicence.length)
      findings.push({
        category: "security",
        rule: "sbom:no-licence",
        severity: "info",
        title: `${noLicence.length} package${noLicence.length === 1 ? "" : "s"} with no licence stated`,
        detail: "Code with no licence is 'all rights reserved' by default: you may not have the right to use it. Check each one's repository for a licence, and prefer packages that state one. (Our lockfile reader cannot see every licence; Syft or an npm install fills these in.)",
        pageUrl: "repository",
        evidence: noLicence.map((d) => `${d.name}@${d.version}`).slice(0, 20).join("\n"),
        key: "sbom:no-licence",
      });

    const byLic = deps.reduce<Record<string, number>>((m, d) => ((m[d.licence || "unknown"] = (m[d.licence || "unknown"] ?? 0) + 1), m), {});
    const top = Object.entries(byLic).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return {
      findings,
      summary: [`${deps.length} dependencies; licences: ${top.map(([k, v]) => `${v}× ${k}`).join(", ")}`],
      reports: [{ file: "sbom.cdx.json", label: "Software bill of materials (CycloneDX JSON)" }],
      tested: `${deps.length} dependencies via ${used}`,
    };
  },
};
