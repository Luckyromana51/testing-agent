import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { request } from "playwright";
import { WEB_PRODUCTS } from "../products.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

const require = createRequire(import.meta.url);

interface VnuMessage {
  type: "error" | "info" | "non-document-error";
  subType?: string;
  url?: string;
  message: string;
  extract?: string;
  lastLine?: number;
}

const MAX_PAGES = 20;
const RETRY = [429, 500, 502, 503, 504];

function jarPath(): string | null {
  try {
    return (require("vnu-jar") as string).toString();
  } catch {
    return null;
  }
}

/**
 * One message for every CSS rule of the same kind: 'Style rule ".a" not allowed outside...' and
 * 'Style rule ".b" not allowed outside...' are one problem with many places. Left apart, each
 * selector became its own issue, and which ones made it under the cap changed from run to run.
 */
function generalMessage(message: string): { message: string; part?: string } {
  const m = /^(Style rule|CSS: [^"]*?) "([^"]*)"(.*)$/.exec(message);
  return m ? { message: `${m[1]}${m[3]}`.replace(/\s+/g, " "), part: m[2] } : { message };
}

/** Groups the checker's errors into one finding per message per page, in page order. */
export function readVnu(
  messages: VnuMessage[],
  pageOf: (fileUrl: string) => string | undefined,
  pageOrder: string[] = [],
): ToolFinding[] {
  const groups = new Map<string, { page: string; message: string; lines: string[]; count: number }>();
  for (const m of messages) {
    if (m.type !== "error") continue;
    const page = m.url ? pageOf(m.url) : undefined;
    if (!page) continue;
    const { message, part } = generalMessage(m.message.replace(/[“”]/g, '"').replace(/\s+/g, " ").trim());
    const key = `${page}|${message}`;
    const g = groups.get(key) ?? { page, message, lines: [], count: 0 };
    g.count++;
    if (g.lines.length < 3) g.lines.push(`Line ${m.lastLine ?? "?"}: ${part ? `"${part.slice(0, 120)}" ` : ""}${(m.extract ?? "").replace(/\s+/g, " ").trim().slice(0, 160)}`);
    groups.set(key, g);
  }
  // Sorted before the cap, so the same pages always give the same findings.
  const rank = (p: string) => (pageOrder.includes(p) ? pageOrder.indexOf(p) : pageOrder.length);
  const sorted = [...groups.values()].sort((a, b) => rank(a.page) - rank(b.page) || a.page.localeCompare(b.page) || a.message.localeCompare(b.message));
  return sorted.slice(0, 300).map((g) => {
    const duplicateId = /^Duplicate ID/i.test(g.message);
    return {
      category: "functional",
      rule: "html:error",
      severity: duplicateId ? "medium" : "low",
      title: `HTML error: ${g.message}`,
      detail: duplicateId
        ? "Two elements share the same id, so form labels, screen readers and scripts can pick the wrong one. Give each element its own id. (W3C HTML checker)"
        : "The W3C HTML checker found markup that breaks the HTML standard. Browsers guess how to repair it, and different browsers can guess differently, so layouts and forms can break in some of them. (W3C HTML checker)",
      pageUrl: g.page,
      evidence: g.lines.join("\n"),
      ...(g.count > 1 ? { count: g.count } : {}),
    };
  });
}

export const vnuTool: Tool = {
  id: "vnu",
  name: "W3C HTML checker",
  maker: "W3C (Nu Html Checker)",
  description: "The checker behind validator.w3.org. Finds HTML that breaks the web standard, which browsers repair in different ways.",
  checks: [
    "Elements in the wrong place, unclosed or misspelled tags",
    "Duplicate ids, which break labels and scripts",
    "Attributes that do not exist or have bad values",
    "Each page the platform opened, up to 20",
  ],
  products: WEB_PRODUCTS,
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "MIT, free",
  homepage: "https://validator.github.io/validator/",
  signedIn: "uses-login",

  async ready() {
    if (!jarPath()) return "The W3C HTML checker is not installed on this server (npm install).";
    if (!(await which(process.env.JAVA_PATH || "java"))) return "The W3C HTML checker needs Java, which is not installed on this server.";
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const pages = [...new Set([ctx.startUrl, ...ctx.urls])].slice(0, MAX_PAGES);
    const dir = path.join(ctx.workDir, "vnu");
    await mkdir(dir, { recursive: true });
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const http = await request.newContext({
      ...(proxy ? { proxy: { server: proxy, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
      extraHTTPHeaders: { "user-agent": "GLVTestingAgent/0.3 (W3C HTML check)", ...(ctx.cookie ? { cookie: ctx.cookie } : {}) },
      ignoreHTTPSErrors: false,
    });
    const files = new Map<string, string>();
    try {
      for (const [i, url] of pages.entries()) {
        ctx.signal.throwIfAborted();
        // Tried twice: a page left out by a brief hiccup would make its errors look fixed.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await http.get(url, { timeout: 20_000, maxRedirects: 5 });
            if (RETRY.includes(res.status()) && attempt === 0) continue;
            if (!res.ok() || !/html/i.test(res.headers()["content-type"] ?? "")) break;
            const file = path.join(dir, `page-${i + 1}.html`);
            await writeFile(file, await res.body());
            files.set(file, url);
            break;
          } catch {
            // A page that cannot be fetched again is left out; the platform's own checks report it.
          }
        }
      }
    } finally {
      await http.dispose();
    }
    if (!files.size) throw new Error("None of the pages could be downloaded again for the HTML check.");
    ctx.log(`W3C HTML checker: ${files.size} pages`);
    const res = await runProcess(
      process.env.JAVA_PATH || "java",
      ["-Xss8m", "-jar", jarPath()!, "--format", "json", "--stdout", "--exit-zero-always", "--also-check-css", ...files.keys()],
      { signal: ctx.signal, timeoutMs: 180_000 },
    );
    let messages: VnuMessage[];
    try {
      messages = (JSON.parse(res.stdout) as { messages: VnuMessage[] }).messages;
    } catch {
      throw new Error(`The HTML checker did not finish: ${lastLine(res.stderr) || `exit code ${res.code}`}`);
    }
    const byName = new Map([...files].map(([file, url]) => [path.basename(file), url]));
    const findings = readVnu(messages, (u) => byName.get(path.basename(decodeURIComponent(u))), pages);
    const errors = messages.filter((m) => m.type === "error").length;
    const json = path.join(ctx.outDir, "tool-vnu.json");
    await writeFile(json, JSON.stringify({ pages: Object.fromEntries([...files].map(([f, u]) => [path.basename(f), u])), messages }, null, 2));
    return {
      findings,
      summary: [`${errors} HTML error${errors === 1 ? "" : "s"} on ${files.size} page${files.size === 1 ? "" : "s"}`],
      reports: [{ file: "tool-vnu.json", label: "HTML checker results (JSON)" }],
      tested: `Checked ${files.size} page${files.size === 1 ? "" : "s"}${ctx.cookie ? ", signed in" : ""}`,
      checked: [...files.values()],
    };
  },
};
