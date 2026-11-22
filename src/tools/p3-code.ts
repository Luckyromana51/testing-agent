import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "../types.js";
import { runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 3 (2026 gap report, P3) code-engine checks, all in-house and read-only:
 *  - model-security: unsafe model files (pickles) in the repo, like ModelScan / fickling.
 *  - iac: Terraform / CloudFormation / Kubernetes / Dockerfile rules, like Checkov / KICS / Hadolint.
 *  - code-fuzz: is there property-based / fuzz testing, like fast-check / Hypothesis / Jazzer.
 *  - browser-ext: a browser extension's manifest permissions and content-script risks.
 *  - desktop-app: Electron / Tauri security settings.
 * Each prefers a bundled open-source scanner when installed, and falls back to GLV's own file rules.
 */

/** Walks a source tree, skipping vendor and VCS folders, returning relative file paths. Bounded. */
export async function walk(root: string, max = 20_000): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set(["node_modules", ".git", ".hg", ".svn", "vendor", "dist", "build", ".next", ".venv", "venv", "__pycache__"]);
  async function rec(dir: string): Promise<void> {
    if (out.length >= max) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith(".") && e.name !== ".github") {
        if (skip.has(e.name)) continue;
      }
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await rec(full);
      else if (e.isFile()) out.push(path.relative(root, full));
    }
  }
  await rec(root);
  return out;
}

export async function readSmall(root: string, rel: string, maxBytes = 2_000_000): Promise<string | null> {
  try {
    const full = path.join(root, rel);
    const info = await stat(full);
    if (info.size > maxBytes) return null;
    return await readFile(full, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Model file security
// ---------------------------------------------------------------------------

export interface ModelFileRisk {
  format: string;
  risky: boolean;
  reason: string;
}

/**
 * Classifies a model file by extension. Pickle-based formats run arbitrary Python code when loaded,
 * so a downloaded model can own the machine; safetensors/ONNX/GGUF are data-only. Pure, for tests.
 */
export function classifyModelFile(name: string): ModelFileRisk | null {
  const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const pickle: Record<string, string> = {
    ".pkl": "Python pickle",
    ".pickle": "Python pickle",
    ".pt": "PyTorch (pickle)",
    ".pth": "PyTorch (pickle)",
    ".ckpt": "checkpoint (pickle)",
    ".bin": "binary weights (often pickle)",
    ".joblib": "joblib (pickle)",
    ".npy": "NumPy (pickle when allow_pickle)",
    ".dill": "dill (pickle)",
    ".model": "model (often pickle)",
  };
  const safe: Record<string, string> = {
    ".safetensors": "safetensors (data only)",
    ".onnx": "ONNX (data only)",
    ".gguf": "GGUF (data only)",
    ".ggml": "GGML (data only)",
    ".tflite": "TFLite (data only)",
    ".pb": "TensorFlow SavedModel (review custom ops)",
    ".h5": "Keras HDF5 (review Lambda layers)",
  };
  if (pickle[ext]) return { format: pickle[ext], risky: true, reason: "loads with Python pickle, which can run arbitrary code" };
  if (safe[ext]) return { format: safe[ext], risky: false, reason: "data-only format" };
  return null;
}

/** Reads ModelScan JSON output. Pure, for tests. */
export function readModelScan(json: string): { path: string; severity: Severity; description: string }[] {
  try {
    const data = JSON.parse(json) as { issues?: Record<string, unknown>[] };
    const sev: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MEDIUM: "medium", LOW: "low" };
    return (data.issues ?? []).map((i) => ({
      path: String(i.source ?? i.path ?? ""),
      severity: sev[String(i.severity ?? "").toUpperCase()] ?? "high",
      description: String(i.description ?? i.operator ?? "unsafe operator in model"),
    }));
  } catch {
    return [];
  }
}

export const modelSecurityTool: Tool = {
  id: "model-security",
  name: "Model file security",
  maker: "GLV Infotech (built in), in the way of ModelScan and fickling",
  description:
    "Scans the repo for machine-learning model files that load with Python pickle (.pkl, .pt, .pth, .ckpt, .bin, .joblib). Those formats run arbitrary code when loaded, so a model downloaded from the internet can take over the machine. Flags them and recommends safetensors.",
  checks: ["Pickle-based model files (code execution on load)", "ModelScan's unsafe-operator scan when it is installed", "Suggests safetensors / ONNX / GGUF (data-only) instead"],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own (ModelScan Apache-2.0 when installed)",
  homepage: "https://github.com/protectai/modelscan",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const root = ctx.sourceDir;
    if (!root) throw new Error("No source folder: connect a repository or upload a zip.");
    const findings: ToolFinding[] = [];
    const scanner = await which("modelscan");
    let scanned = 0;
    if (scanner) {
      try {
        const r = await runProcess(scanner, ["-p", root, "-r", "json"], { signal: ctx.signal, timeoutMs: 180_000, cwd: root });
        for (const i of readModelScan(r.stdout)) {
          findings.push({
            category: "security",
            rule: "model:unsafe-operator",
            severity: i.severity,
            title: `Unsafe operator in model file: ${path.basename(i.path)}`,
            detail: `ModelScan flagged ${i.path}: ${i.description}. This model can run code when loaded. Do not load untrusted models; re-save as safetensors.`,
            pageUrl: i.path,
            key: `model:unsafe-operator:${i.path}`,
          });
        }
        ctx.log("ModelScan: scan complete");
      } catch (e) {
        ctx.log(`ModelScan not usable (${(e as Error).message}); using built-in rules`);
      }
    }
    const files = await walk(root);
    for (const rel of files) {
      const risk = classifyModelFile(rel);
      if (!risk) continue;
      scanned++;
      if (risk.risky && !findings.some((f) => f.pageUrl === rel))
        findings.push({
          category: "security",
          rule: "model:pickle-format",
          severity: "high",
          title: `Model file in a pickle format: ${path.basename(rel)}`,
          detail: `${rel} is a ${risk.format} file, which ${risk.reason}. If this model ever comes from the internet or a third party, loading it can run arbitrary code on your server. Convert to safetensors (torch: save_file / load_file) and load with weights_only where possible.`,
          pageUrl: rel,
          key: `model:pickle-format:${rel}`,
        });
    }
    ctx.log(`Model files: ${scanned} found`);
    return {
      findings,
      summary: [scanned ? `${scanned} model file(s), ${findings.length} risky` : "No model files found"],
      tested: `${files.length} files`,
    };
  },
};

// ---------------------------------------------------------------------------
// Infrastructure-as-code deep checks
// ---------------------------------------------------------------------------

export interface IacFile {
  path: string;
  kind: "terraform" | "cloudformation" | "kubernetes" | "dockerfile" | "helm";
  text: string;
}

/** Classifies an IaC file by name/content. Pure, for tests. */
export function iacKind(name: string, text: string): IacFile["kind"] | null {
  const base = path.basename(name).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (name.endsWith(".tf") || name.endsWith(".tf.json")) return "terraform";
  if (/\bresources:\s/.test(text) && /awstemplateformatversion/i.test(text)) return "cloudformation";
  if ((name.endsWith(".yaml") || name.endsWith(".yml")) && /\bkind:\s*(Deployment|Pod|Service|Ingress|DaemonSet|StatefulSet)\b/.test(text)) return "kubernetes";
  if (base === "chart.yaml") return "helm";
  return null;
}

/** GLV's own IaC rules, a fallback when Checkov/KICS are not installed. Pure, for tests. */
export function iacProblems(file: IacFile): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const t = file.text;
  const add = (rule: string, severity: Severity, title: string, detail: string) => out.push({ rule, severity, title, detail });
  if (file.kind === "dockerfile") {
    if (!/^\s*USER\s+(?!root\b)/im.test(t)) add("iac:docker-root", "medium", "Container runs as root", "No non-root USER is set, so the container runs as root. Add a USER line with an unprivileged user.");
    if (/^\s*FROM\s+\S+:latest\b/im.test(t) || /^\s*FROM\s+[^:\s]+\s*$/im.test(t)) add("iac:docker-latest", "low", "Base image is not pinned", "A :latest or untagged base image makes builds non-reproducible and can pull in changes silently. Pin a specific version/digest.");
    if (!/^\s*HEALTHCHECK\b/im.test(t)) add("iac:docker-no-healthcheck", "info", "No HEALTHCHECK", "Add a HEALTHCHECK so the orchestrator can tell when the container is unhealthy.");
    if (/\b(ADD)\s+https?:\/\//i.test(t)) add("iac:docker-add-url", "low", "ADD fetches a remote URL", "Use curl/wget with a checksum, or COPY a vendored file, instead of ADD <url>.");
  }
  if (file.kind === "terraform" || file.kind === "cloudformation") {
    if (/0\.0\.0\.0\/0/.test(t) && /\b(22|3389|3306|5432|6379|27017|ingress|SecurityGroupIngress)\b/i.test(t)) add("iac:open-ingress", "high", "Security group open to the world", "A rule allows 0.0.0.0/0 to a sensitive port (SSH/RDP/database). Restrict the CIDR to known addresses.");
    if (/acl\s*=\s*"public-read"|"PublicRead"/i.test(t)) add("iac:public-bucket", "high", "Storage bucket is public", "An object store is set public-read. Make it private and use signed URLs / CloudFront.");
    if (/encrypted\s*=\s*false|"Encrypted"\s*:\s*false/i.test(t)) add("iac:unencrypted", "medium", "Storage/volume encryption is off", "Turn on encryption at rest for disks, databases and buckets.");
    if (/(password|secret|access_key)\s*=\s*"[^"$]{6,}"/i.test(t)) add("iac:hardcoded-secret", "high", "Secret hard-coded in IaC", "Move the secret to a variable/secret manager; never commit it to the repo.");
  }
  if (file.kind === "kubernetes") {
    if (/privileged:\s*true/.test(t)) add("iac:k8s-privileged", "high", "Privileged container", "privileged: true gives the container full host access. Remove it and drop capabilities.");
    if (!/runAsNonRoot:\s*true/.test(t)) add("iac:k8s-root", "medium", "Pod may run as root", "Set securityContext.runAsNonRoot: true and a runAsUser.");
    if (/:\s*latest\b/.test(t)) add("iac:k8s-latest", "low", "Image tag is :latest", "Pin image tags/digests so rollouts are reproducible.");
    if (!/resources:\s/.test(t)) add("iac:k8s-no-limits", "info", "No resource limits", "Set CPU/memory requests and limits so one pod can't starve the node.");
  }
  return out;
}

export const iacTool: Tool = {
  id: "iac",
  name: "Infrastructure-as-code checks",
  maker: "GLV Infotech (built in), in the way of Checkov, KICS and Hadolint",
  description:
    "Reads Terraform, CloudFormation, Kubernetes manifests, Helm charts and Dockerfiles in the repo and flags unsafe settings: firewalls open to the world, public buckets, unencrypted storage, privileged or root containers, unpinned images and hard-coded secrets.",
  checks: ["Terraform / CloudFormation: open ingress, public buckets, no encryption, hard-coded secrets", "Kubernetes: privileged/root pods, :latest images, no resource limits", "Dockerfile: root user, unpinned base, no healthcheck", "Checkov when it is installed, GLV's rules otherwise"],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own (Checkov Apache-2.0 when installed)",
  homepage: "https://github.com/bridgecrewio/checkov",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const root = ctx.sourceDir;
    if (!root) throw new Error("No source folder: connect a repository or upload a zip.");
    const files = await walk(root);
    const iac: IacFile[] = [];
    for (const rel of files) {
      if (!/\.(tf|tf\.json|ya?ml)$/i.test(rel) && path.basename(rel).toLowerCase() !== "dockerfile" && !path.basename(rel).toLowerCase().startsWith("dockerfile.")) continue;
      const text = await readSmall(root, rel);
      if (!text) continue;
      const kind = iacKind(rel, text);
      if (kind) iac.push({ path: rel, kind, text });
    }
    const findings: ToolFinding[] = [];
    for (const f of iac)
      for (const p of iacProblems(f))
        findings.push({ category: "security", rule: p.rule, severity: p.severity, title: p.title, detail: `${f.path}: ${p.detail}`, pageUrl: f.path, key: `${p.rule}:${f.path}` });
    ctx.log(`IaC: ${iac.length} file(s) read`);
    return { findings, summary: [`${iac.length} IaC file(s), ${findings.length} issue(s)`], tested: `${iac.length} IaC files` };
  },
};

// ---------------------------------------------------------------------------
// Property-based / coverage-guided fuzzing readiness
// ---------------------------------------------------------------------------

/** Detects property-based/fuzz frameworks from dependency files. Pure, for tests. */
export function detectFuzzing(pkgJson: string | null, pyDeps: string | null, javaDeps: string | null): { has: boolean; tools: string[]; langs: string[] } {
  const tools: string[] = [];
  const langs: string[] = [];
  if (pkgJson) {
    langs.push("JavaScript/TypeScript");
    const j = (() => {
      try {
        return JSON.parse(pkgJson) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      } catch {
        return {};
      }
    })();
    const all = { ...j.dependencies, ...j.devDependencies };
    if (all["fast-check"]) tools.push("fast-check");
    if (all["@fast-check/jest"] || all["@fast-check/vitest"]) tools.push("fast-check (test runner)");
  }
  if (pyDeps) {
    langs.push("Python");
    if (/\bhypothesis\b/i.test(pyDeps)) tools.push("Hypothesis");
    if (/\batheris\b/i.test(pyDeps)) tools.push("Atheris");
  }
  if (javaDeps) {
    langs.push("Java/JVM");
    if (/jazzer|jqwik/i.test(javaDeps)) tools.push("Jazzer/jqwik");
  }
  return { has: tools.length > 0, tools, langs };
}

export const codeFuzzTool: Tool = {
  id: "code-fuzz",
  name: "Code fuzzing readiness",
  maker: "GLV Infotech (built in), in the way of fast-check, Hypothesis and Jazzer",
  description:
    "Checks whether the codebase has property-based or coverage-guided fuzz testing, which generates random inputs to crash parsers and core functions. Reports which frameworks are present and recommends one when none is found.",
  checks: ["fast-check (JS/TS), Hypothesis/Atheris (Python), Jazzer/jqwik (JVM)", "Recommends property-based tests for parsers and input-handling code", "Reads the repo's dependency files only"],
  products: ["code"],
  category: "functional",
  safety: "safe",
  manual: true,
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://github.com/dubzzz/fast-check",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const root = ctx.sourceDir;
    if (!root) throw new Error("No source folder: connect a repository or upload a zip.");
    const pkg = await readSmall(root, "package.json");
    const py = (await readSmall(root, "requirements.txt")) ?? (await readSmall(root, "pyproject.toml")) ?? (await readSmall(root, "Pipfile"));
    const java = (await readSmall(root, "pom.xml")) ?? (await readSmall(root, "build.gradle")) ?? (await readSmall(root, "build.gradle.kts"));
    const d = detectFuzzing(pkg, py, java);
    const findings: ToolFinding[] = [];
    if (!d.has && d.langs.length)
      findings.push({
        category: "functional",
        rule: "fuzz:none",
        severity: "info",
        title: "No property-based or fuzz testing found",
        detail: `This ${d.langs.join("/")} project has no fuzz/property testing. Add fast-check (JS/TS), Hypothesis (Python) or Jazzer (JVM) and target parsers, validators and anything that handles untrusted input — they find crash and edge-case bugs example-based tests miss.`,
        pageUrl: ctx.startUrl || root,
        key: "fuzz:none",
      });
    ctx.log(d.has ? `Fuzzing present: ${d.tools.join(", ")}` : "No fuzzing frameworks found");
    return { findings, summary: [d.has ? `Fuzzing: ${d.tools.join(", ")}` : "No fuzz testing"], tested: d.langs.join(", ") || "code" };
  },
};

// ---------------------------------------------------------------------------
// Browser extension static checks
// ---------------------------------------------------------------------------

/** Risks in a browser-extension manifest. Pure, for tests. */
export function extensionRisks(manifest: Record<string, unknown>): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const mv = manifest.manifest_version;
  const perms = ([] as string[]).concat((manifest.permissions as string[]) ?? [], (manifest.host_permissions as string[]) ?? []);
  const broad = perms.filter((p) => /<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\//.test(String(p)));
  const dangerous = perms.filter((p) => ["tabs", "cookies", "webRequest", "webRequestBlocking", "<all_urls>", "history", "downloads", "nativeMessaging", "debugger", "proxy", "scripting"].includes(String(p)));
  if (mv === 2) out.push({ rule: "ext:manifest-v2", severity: "medium", title: "Manifest V2 is deprecated", detail: "Chrome is removing Manifest V2. Migrate to V3 (service worker, declarativeNetRequest)." });
  if (broad.length) out.push({ rule: "ext:broad-host", severity: "high", title: "Extension can read every site", detail: `Host permission ${broad.join(", ")} lets the extension read and change every page the user visits — a large privacy and supply-chain risk. Narrow it to the sites it needs.` });
  if (dangerous.length) out.push({ rule: "ext:sensitive-perms", severity: "medium", title: `Sensitive permissions: ${dangerous.join(", ")}`, detail: "These permissions reach cookies, tabs, network or scripting. Keep only what the extension truly needs; each one widens the blast radius if the extension is compromised." });
  const cs = (manifest.content_scripts as { matches?: string[] }[]) ?? [];
  if (cs.some((c) => (c.matches ?? []).some((m) => /<all_urls>|\*:\/\/\*\/\*/.test(m)))) out.push({ rule: "ext:content-all-urls", severity: "medium", title: "Content script injected into all sites", detail: "A content script runs on every site. Restrict its matches to the pages it needs." });
  const csp = JSON.stringify(manifest.content_security_policy ?? "");
  if (/unsafe-eval|unsafe-inline/.test(csp)) out.push({ rule: "ext:unsafe-csp", severity: "high", title: "Extension CSP allows unsafe-eval/inline", detail: "unsafe-eval or unsafe-inline in the extension CSP lets injected code run. Remove them." });
  if (manifest.externally_connectable && /\*/.test(JSON.stringify(manifest.externally_connectable))) out.push({ rule: "ext:externally-connectable", severity: "medium", title: "Any site can message the extension", detail: "externally_connectable uses a wildcard, so any web page can talk to the extension. Restrict the matches." });
  return out;
}

export const browserExtTool: Tool = {
  id: "browser-ext",
  name: "Browser extension checks",
  maker: "GLV Infotech (built in)",
  description:
    "Reads a browser extension's manifest.json and flags over-broad permissions (reads every site), sensitive permissions (cookies, tabs, network), content scripts injected everywhere, unsafe CSP and wide external messaging.",
  checks: ["Host permissions that read every site (<all_urls>)", "Sensitive permissions (cookies, webRequest, scripting, debugger)", "Content scripts on all URLs, unsafe-eval CSP, wildcard externally_connectable", "Manifest V2 (deprecated)"],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://developer.chrome.com/docs/extensions/mv3/intro/",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const root = ctx.sourceDir;
    if (!root) throw new Error("No source folder: connect a repository or upload a zip.");
    const files = await walk(root);
    const manifests = files.filter((f) => path.basename(f) === "manifest.json");
    const findings: ToolFinding[] = [];
    let found = 0;
    for (const rel of manifests) {
      const text = await readSmall(root, rel);
      if (!text) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!("manifest_version" in m) || !("name" in m)) continue; // not an extension manifest
      found++;
      for (const r of extensionRisks(m))
        findings.push({ category: "security", rule: r.rule, severity: r.severity, title: r.title, detail: `${rel}: ${r.detail}`, pageUrl: rel, key: `${r.rule}:${rel}` });
    }
    ctx.log(`Browser extension manifests: ${found}`);
    return { findings, summary: [found ? `${found} extension manifest(s), ${findings.length} issue(s)` : "No browser-extension manifest found"], tested: `${found} manifests` };
  },
};

// ---------------------------------------------------------------------------
// Desktop app (Electron / Tauri) static checks
// ---------------------------------------------------------------------------

/** Electron webPreferences risks from source text. Pure, for tests. */
export function electronRisks(src: string): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (/nodeIntegration\s*:\s*true/.test(src)) out.push({ rule: "desktop:node-integration", severity: "high", title: "Electron nodeIntegration is on", detail: "nodeIntegration: true lets web content run Node.js — any XSS becomes full machine access. Turn it off and use a preload script with contextBridge." });
  if (/contextIsolation\s*:\s*false/.test(src)) out.push({ rule: "desktop:no-context-isolation", severity: "high", title: "Electron contextIsolation is off", detail: "contextIsolation: false lets page scripts reach Electron internals. Set it to true (the default) and expose only what you need via contextBridge." });
  if (/webSecurity\s*:\s*false/.test(src)) out.push({ rule: "desktop:no-web-security", severity: "high", title: "Electron webSecurity is off", detail: "webSecurity: false disables same-origin protections. Remove it." });
  if (/enableRemoteModule\s*:\s*true|require\(['\"]@electron\/remote/.test(src)) out.push({ rule: "desktop:remote-module", severity: "medium", title: "Electron remote module in use", detail: "The remote module is a known security risk and is removed in recent Electron. Use IPC instead." });
  if (/allowRunningInsecureContent\s*:\s*true/.test(src)) out.push({ rule: "desktop:insecure-content", severity: "medium", title: "Electron allows insecure content", detail: "allowRunningInsecureContent lets http resources load on https pages. Remove it." });
  return out;
}

/** Tauri allowlist/CSP risks from tauri.conf.json content. Pure, for tests. */
export function tauriRisks(conf: Record<string, unknown>): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  const s = JSON.stringify(conf);
  if (/"all"\s*:\s*true/.test(s)) out.push({ rule: "desktop:tauri-allowlist-all", severity: "high", title: "Tauri allowlist enables everything", detail: '"all": true in the allowlist exposes every API (filesystem, shell, …) to the frontend. Enable only the specific APIs you use.' });
  if (/dangerousRemoteDomainIpcAccess/.test(s)) out.push({ rule: "desktop:tauri-remote-ipc", severity: "high", title: "Tauri allows remote IPC access", detail: "dangerousRemoteDomainIpcAccess lets remote pages call your Rust commands. Remove it unless absolutely required." });
  // Tauri v1: tauri.security.csp; Tauri v2: app.security.csp. Read .csp from whichever is present.
  const csp = (((conf.tauri as Record<string, unknown>)?.security as Record<string, unknown>)?.csp ?? ((conf.app as Record<string, unknown>)?.security as Record<string, unknown>)?.csp) as unknown;
  if (csp === null || csp === undefined || csp === "") out.push({ rule: "desktop:tauri-no-csp", severity: "medium", title: "Tauri has no Content-Security-Policy", detail: "Set tauri.security.csp so the webview blocks injected and remote scripts." });
  return out;
}

export const desktopAppTool: Tool = {
  id: "desktop-app",
  name: "Desktop app security (Electron / Tauri)",
  maker: "GLV Infotech (built in)",
  description:
    "For Electron and Tauri desktop apps, reads the security settings and flags the dangerous ones: nodeIntegration on, contextIsolation off, webSecurity off, the Tauri allowlist set to everything, remote IPC access and a missing CSP.",
  checks: ["Electron: nodeIntegration, contextIsolation, webSecurity, remote module", "Tauri: allowlist 'all', dangerousRemoteDomainIpcAccess, missing CSP", "Reads the repo only; no app is launched"],
  products: ["code"],
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://www.electronjs.org/docs/latest/tutorial/security",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const root = ctx.sourceDir;
    if (!root) throw new Error("No source folder: connect a repository or upload a zip.");
    const files = await walk(root);
    const findings: ToolFinding[] = [];
    let kind = "";
    // Electron: scan JS/TS for BrowserWindow webPreferences.
    const pkg = await readSmall(root, "package.json");
    const isElectron = pkg ? /"electron"\s*:/.test(pkg) : false;
    if (isElectron) {
      kind = "Electron";
      for (const rel of files.filter((f) => /\.(js|ts|mjs|cjs)$/.test(f)).slice(0, 2000)) {
        const text = await readSmall(root, rel);
        if (!text || !/webPreferences|BrowserWindow/.test(text)) continue;
        for (const r of electronRisks(text)) if (!findings.some((f) => f.rule === r.rule)) findings.push({ category: "security", rule: r.rule, severity: r.severity, title: r.title, detail: `${rel}: ${r.detail}`, pageUrl: rel, key: r.rule });
      }
    }
    // Tauri.
    const tauriConf = files.find((f) => path.basename(f) === "tauri.conf.json");
    if (tauriConf) {
      kind = kind ? `${kind} + Tauri` : "Tauri";
      const text = await readSmall(root, tauriConf);
      if (text) {
        try {
          const conf = JSON.parse(text) as Record<string, unknown>;
          for (const r of tauriRisks(conf)) findings.push({ category: "security", rule: r.rule, severity: r.severity, title: r.title, detail: `${tauriConf}: ${r.detail}`, pageUrl: tauriConf, key: r.rule });
        } catch {
          /* ignore */
        }
      }
    }
    if (!kind) return { findings: [], summary: ["No Electron or Tauri desktop app found"], tested: "code" };
    ctx.log(`Desktop app: ${kind}, ${findings.length} issue(s)`);
    return { findings, summary: [`${kind}: ${findings.length} issue(s)`], tested: kind };
  },
};
