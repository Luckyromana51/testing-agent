import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { uploadedPath } from "../engines/index.js";
import { validateTarget } from "../runner/urls.js";
import type { Login } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/* Postman collection v2 shapes, as far as this file reads them. */
interface PmEvent {
  listen: string;
  script?: { exec?: string[] | string };
}
interface PmItem {
  name?: string;
  item?: PmItem[];
  request?: string | { method?: string; url?: string | { raw?: string } };
  event?: PmEvent[];
  [k: string]: unknown;
}
interface PmCollection extends PmItem {
  info?: { name?: string; schema?: string };
  variable?: { key: string; value?: unknown }[];
  auth?: unknown;
}

const READ_METHODS = ["GET", "HEAD"];
const methodOf = (it: PmItem) => (typeof it.request === "string" ? "GET" : (it.request?.method ?? "GET").toUpperCase());
const rawUrl = (it: PmItem) => (typeof it.request === "string" ? it.request : typeof it.request?.url === "string" ? it.request.url : (it.request?.url?.raw ?? ""));
const scriptText = (e: PmEvent) => (Array.isArray(e.script?.exec) ? e.script!.exec.join("\n") : (e.script?.exec ?? ""));

export interface ReadOnlyCollection {
  collection: PmCollection;
  kept: number;
  /** Requests left out, as "POST Create a user". */
  skipped: string[];
  /** Scripts left out because they send requests of their own. */
  scripts: number;
}

/**
 * The collection with only its GET and HEAD requests, so a run cannot change the client's data.
 * Scripts that send requests of their own (pm.sendRequest, which can use any method) are left
 * out too, and so are requests to an address the platform refuses (this server's own network).
 */
export function readOnlyCollection(col: PmCollection, vars: Record<string, string>): ReadOnlyCollection {
  const skipped: string[] = [];
  let scripts = 0;
  let kept = 0;
  const cleanEvents = (events?: PmEvent[]) => {
    if (!events) return undefined;
    const out = events.filter((e) => {
      const bad = /\bsendRequest\b/.test(scriptText(e));
      if (bad) scripts++;
      return !bad;
    });
    return out;
  };
  const resolve = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
  const walk = (items: PmItem[]): PmItem[] =>
    items.flatMap((it): PmItem[] => {
      if (Array.isArray(it.item)) {
        const inner = walk(it.item);
        return inner.length ? [{ ...it, item: inner, ...(it.event ? { event: cleanEvents(it.event) } : {}) }] : [];
      }
      const label = `${methodOf(it)} ${it.name ?? rawUrl(it)}`;
      if (!READ_METHODS.includes(methodOf(it))) {
        skipped.push(label);
        return [];
      }
      const url = resolve(rawUrl(it));
      if (!/\{\{/.test(url) && url) {
        try {
          validateTarget(url);
        } catch {
          skipped.push(`${label} (address not allowed)`);
          return [];
        }
      }
      kept++;
      return [{ ...it, ...(it.event ? { event: cleanEvents(it.event) } : {}) }];
    });
  const item = walk(col.item ?? []);
  return { collection: { ...col, item, ...(col.event ? { event: cleanEvents(col.event) } : {}) }, kept, skipped, scripts };
}

/** The saved API login as collection-level auth, used by every request set to "inherit". Values come from the environment file. */
function authFor(login: Login): { auth: unknown; values: Record<string, string> } | undefined {
  switch (login.authType) {
    case "basic":
      return {
        auth: { type: "basic", basic: [{ key: "username", value: "{{glvUser}}" }, { key: "password", value: "{{glvPassword}}" }] },
        values: { glvUser: login.username ?? "", glvPassword: login.password ?? "" },
      };
    case "header":
    case "query":
      return {
        auth: { type: "apikey", apikey: [{ key: "key", value: login.paramName ?? "" }, { key: "value", value: "{{glvToken}}" }, { key: "in", value: login.authType }] },
        values: { glvToken: login.token ?? "" },
      };
    default:
      return login.token ? { auth: { type: "bearer", bearer: [{ key: "token", value: "{{glvToken}}" }] }, values: { glvToken: login.token } } : undefined;
  }
}

interface NewmanReport {
  run: {
    stats?: { requests?: { total: number; failed: number }; assertions?: { total: number; failed: number } };
    executions?: {
      item: { name: string };
      request?: { method?: string; url?: { protocol?: string; host?: string[]; port?: string; path?: string[] } };
      response?: { code?: number; responseTime?: number };
      requestError?: { message?: string; code?: string };
      assertions?: { assertion: string; error?: { message?: string } }[];
    }[];
  };
}

const urlOf = (u?: { protocol?: string; host?: string[]; port?: string; path?: string[] }) =>
  u?.host ? `${u.protocol ?? "https"}://${u.host.join(".")}${u.port ? `:${u.port}` : ""}/${(u.path ?? []).join("/")}` : "";

/** One finding per failed test and request, and one per request that got no answer. */
export function readNewman(report: NewmanReport): ToolFinding[] {
  const out: ToolFinding[] = [];
  for (const ex of report.run.executions ?? []) {
    const url = urlOf(ex.request?.url) || ex.item.name;
    const method = ex.request?.method ?? "GET";
    if (ex.requestError) {
      out.push({
        category: "functional",
        severity: "high",
        rule: "newman:no-answer",
        title: `Postman request got no answer: ${ex.item.name}`,
        detail: `${method} ${url} failed: ${ex.requestError.message ?? ex.requestError.code ?? "no answer"}. Check the server and the address in the collection.`,
        pageUrl: url,
        evidence: `${method} ${url}`,
      });
      continue;
    }
    for (const a of ex.assertions ?? []) {
      if (!a.error) continue;
      out.push({
        category: "functional",
        severity: "medium",
        rule: "newman:test-failed",
        title: `Postman test failed: ${ex.item.name}: ${a.assertion}`,
        detail: `${method} ${url} answered HTTP ${ex.response?.code ?? "?"}${ex.response?.responseTime !== undefined ? ` in ${ex.response.responseTime} ms` : ""}, and the team's own test "${a.assertion}" failed: ${(a.error.message ?? "").slice(0, 300)}.`,
        pageUrl: url,
        evidence: `${method} ${url} -> HTTP ${ex.response?.code ?? "?"}: ${(a.error.message ?? "").slice(0, 160)}`,
      });
    }
  }
  return out;
}

/** Newman runs as its own program: from NEWMAN_PATH, or "newman" on the PATH. */
const newmanBin = () => process.env.NEWMAN_PATH || "newman";

export const newmanTool: Tool = {
  id: "newman",
  name: "Newman (Postman)",
  maker: "Postman",
  description: "Runs the team's own Postman collection and reports every test that fails. Only its GET requests are sent.",
  checks: [
    "The checks the developers already wrote in Postman, run on every test",
    "Requests that create, change or delete data are left out on live APIs",
    "Uses the project's saved API login for requests set to inherit auth",
  ],
  products: ["api"],
  category: "functional",
  safety: "safe",
  takes: "depends on the collection, usually under a minute",
  licence: "Apache-2.0",
  homepage: "https://github.com/postmanlabs/newman",
  signedIn: "uses-login",
  options: [
    {
      id: "collection",
      label: "Postman collection",
      kind: "file",
      accept: ".json",
      required: true,
      hint: "In Postman: the collection's ... menu, Export, Collection v2.1.",
      choices: [],
      default: "",
    },
  ],

  async ready() {
    return (await which(newmanBin())) ? null : "Newman is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const file = ctx.options.collection;
    if (!file) throw new Error("No Postman collection was uploaded in the Newman tab.");
    const full = uploadedPath(ctx.uploadsDir, file);
    if (!existsSync(full)) throw new Error("The uploaded Postman collection is gone. Upload it again in the Newman tab.");
    let col: PmCollection;
    try {
      col = JSON.parse(await readFile(full, "utf8")) as PmCollection;
    } catch {
      throw new Error("The Postman collection is not valid JSON.");
    }
    if (!col.info || !Array.isArray(col.item)) throw new Error("That file is not a Postman collection (export it as Collection v2.1).");

    // The project's API address wins over the collection's own, so the right server is tested.
    const env: Record<string, string> = {};
    if (ctx.target.url) for (const k of ["baseUrl", "base_url", "baseURL", "url", "host"]) if ((col.variable ?? []).some((v) => v.key === k)) env[k] = ctx.target.url;
    if (ctx.target.url && !Object.keys(env).length) env.baseUrl = ctx.target.url;
    const vars = { ...Object.fromEntries((col.variable ?? []).map((v) => [v.key, String(v.value ?? "")])), ...env };
    const ro = readOnlyCollection(col, vars);
    if (!ro.kept) throw new Error(`The collection has no GET requests to run${ro.skipped.length ? ` (${ro.skipped.length} left out because they change data)` : ""}.`);
    const auth = ctx.login?.kind === "api" && !col.auth ? authFor(ctx.login) : undefined;
    if (auth) ro.collection.auth = auth.auth;

    const colFile = path.join(ctx.workDir, "newman-collection.json");
    const envFile = path.join(ctx.workDir, "newman-env.json");
    const out = path.join(ctx.workDir, "newman.json");
    const junit = path.join(ctx.outDir, "tool-newman.xml");
    await writeFile(colFile, JSON.stringify(ro.collection));
    await writeFile(
      envFile,
      JSON.stringify({ name: "GLV", values: Object.entries({ ...env, ...(auth?.values ?? {}) }).map(([key, value]) => ({ key, value, enabled: true })) }),
    );
    const res = await runProcess(
      newmanBin(),
      [
        "run",
        colFile,
        "-e",
        envFile,
        "--reporters",
        "json,junit",
        "--reporter-json-export",
        out,
        "--reporter-junit-export",
        junit,
        "--timeout-request",
        "20000",
        "--timeout",
        "600000",
        "--delay-request",
        "100",
        // Requests may not read files on this server outside the work folder.
        "--working-dir",
        ctx.workDir,
        "--no-insecure-file-read",
        "--disable-unicode",
        "--color",
        "off",
        "--suppress-exit-code",
      ],
      { signal: ctx.signal, timeoutMs: 900_000, cwd: ctx.workDir },
    );
    if (!existsSync(out)) {
      // Newman 6 crashes while reporting a request that failed through an HTTPS proxy.
      if (/Unknown object type "asyncfunction"/.test(res.stderr)) {
        throw new Error("Newman stopped: a request failed while going through this server's HTTPS proxy, which Newman cannot report. Check that the API address is right, or add the API's host to NO_PROXY.");
      }
      throw new Error(`Newman stopped: ${lastLine(res.stderr) || lastLine(res.stdout) || `exit code ${res.code}`}`);
    }
    const report = JSON.parse(await readFile(out, "utf8")) as NewmanReport;
    const findings = readNewman(report);
    const stats = report.run.stats;
    return {
      findings,
      summary: [
        `${stats?.requests?.total ?? ro.kept} request${(stats?.requests?.total ?? ro.kept) === 1 ? "" : "s"} from "${col.info.name ?? "the collection"}", ${stats?.assertions?.failed ?? 0} of ${stats?.assertions?.total ?? 0} tests failed`,
        ...(ro.skipped.length ? [`Left out ${ro.skipped.length} request${ro.skipped.length === 1 ? "" : "s"} that change data or go elsewhere: ${ro.skipped.slice(0, 4).join(", ")}${ro.skipped.length > 4 ? " and more" : ""}`] : []),
        ...(ro.scripts ? [ro.scripts === 1 ? "Left out 1 script that sends requests of its own" : `Left out ${ro.scripts} scripts that send requests of their own`] : []),
      ],
      reports: existsSync(junit) ? [{ file: "tool-newman.xml", label: "Newman results (JUnit XML)" }] : [],
      tested: `${ro.kept} GET requests from the collection`,
    };
  },
};
