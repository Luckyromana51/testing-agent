import { validateTarget } from "../runner/urls.js";
import type { ToolFinding } from "../tools/types.js";
import type { ResolvedConnection } from "./types.js";

/**
 * A client's MCP server (Streamable HTTP), seen the way an AI assistant or an attacker sees it.
 * GLV only starts a session and lists what the server offers (tools, resources, prompts). It never
 * calls a tool, so nothing on the client's system changes.
 */

export const MCP_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [k: string]: unknown };
}

interface Answer {
  status: number;
  headers: Headers;
  body?: { result?: Record<string, unknown>; error?: { code: number; message: string } };
}

/** Reads a JSON-RPC answer that came as JSON or as an event stream. */
async function readAnswer(res: Response, id: number): Promise<Answer["body"]> {
  const type = res.headers.get("content-type") ?? "";
  const text = (await res.text()).slice(0, 5_000_000);
  if (!text.trim()) return undefined;
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data) as { id?: number };
        if (msg.id === id) return msg as Answer["body"];
      } catch {
        // not JSON: skip
      }
    }
    return undefined;
  }
  try {
    const msg = JSON.parse(text) as Answer["body"] | Answer["body"][];
    return Array.isArray(msg) ? msg.find((m) => (m as { id?: number })?.id === id) : msg;
  } catch {
    return undefined;
  }
}

export class McpClient {
  private session?: string;
  private nextId = 1;
  protocol?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  lastHeaders?: Headers;

  constructor(
    readonly url: string,
    private token?: string,
    private signal?: AbortSignal,
    private extraHeaders: Record<string, string> = {},
  ) {}

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": "GLVTestingAgent/0.2",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...(this.session ? { "mcp-session-id": this.session } : {}),
      ...(this.protocol ? { "mcp-protocol-version": this.protocol } : {}),
      ...this.extraHeaders,
    };
  }

  async send(method: string, params?: unknown, notify = false): Promise<Answer> {
    const id = this.nextId++;
    const res = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...(notify ? {} : { id }), method, ...(params ? { params } : {}) }),
      redirect: "manual",
      signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    this.lastHeaders = res.headers;
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    return { status: res.status, headers: res.headers, body: notify ? (await res.text(), undefined) : await readAnswer(res, id) };
  }

  async initialize(): Promise<Answer> {
    const a = await this.send("initialize", { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: "glv-testing-agent", version: "0.2" } });
    const r = a.body?.result as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> } | undefined;
    if (a.status < 300 && r) {
      this.protocol = r.protocolVersion;
      this.serverInfo = r.serverInfo;
      this.capabilities = r.capabilities ?? {};
      await this.send("notifications/initialized", undefined, true).catch(() => undefined);
    }
    return a;
  }

  /** Every page of a list (tools/list, resources/list, prompts/list), at most 20 pages. */
  async list<T>(method: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const a = await this.send(method, cursor ? { cursor } : {});
      if (a.body?.error) throw new Error(`${method}: ${a.body.error.message}`);
      const r = a.body?.result ?? {};
      out.push(...((r[key] as T[] | undefined) ?? []));
      cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  async close(): Promise<void> {
    if (!this.session) return;
    await fetch(this.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000) }).catch(() => undefined);
  }
}

const failText = (a: Answer) =>
  a.status === 401 || a.status === 403
    ? "The MCP server refused the sign-in: check the token."
    : a.status === 404 || a.status === 405
      ? "No MCP server at that address (it answered " + a.status + "). The address usually ends in /mcp."
      : a.body?.error
        ? `The MCP server answered with an error: ${a.body.error.message}`
        : `The MCP server did not start a session (it answered ${a.status}).`;

/** Starts a session and lists what the server offers. */
export async function mcpInventory(c: ResolvedConnection, signal?: AbortSignal) {
  if (!c.url) throw new Error("This MCP connection has no address.");
  validateTarget(c.url);
  const client = new McpClient(c.url, c.secret.token, signal);
  let init: Answer;
  try {
    init = await client.initialize();
  } catch (err) {
    if (signal?.aborted) throw signal.reason;
    throw new Error(`The MCP server did not answer: ${(err as Error).message}`);
  }
  if (init.status >= 300 || !init.body?.result) throw new Error(failText(init));
  const caps = client.capabilities ?? {};
  const tools = caps.tools ? await client.list<McpTool>("tools/list", "tools") : [];
  const resources = caps.resources ? await client.list<{ uri: string; name?: string }>("resources/list", "resources").catch(() => []) : [];
  const prompts = caps.prompts ? await client.list<{ name: string; description?: string }>("prompts/list", "prompts").catch(() => []) : [];
  await client.close();
  return { client, init, tools, resources, prompts };
}

export async function testMcp(c: ResolvedConnection, signal?: AbortSignal) {
  const inv = await mcpInventory(c, signal);
  const name = [inv.client.serverInfo?.name, inv.client.serverInfo?.version].filter(Boolean).join(" ") || "MCP server";
  return {
    message: `Connected to ${name}: ${inv.tools.length} tool${inv.tools.length === 1 ? "" : "s"}`,
    details: [
      `Protocol ${inv.client.protocol ?? "unknown"}`,
      ...inv.tools.slice(0, 40).map((t) => `Tool ${t.name}${t.annotations?.readOnlyHint ? " (read-only)" : t.annotations?.destructiveHint ? " (changes things)" : ""}`),
      ...(inv.resources.length ? [`${inv.resources.length} resources`] : []),
      ...(inv.prompts.length ? [`${inv.prompts.length} prompts`] : []),
    ],
  };
}

/** Hidden characters that a person cannot see but a model reads. */
const HIDDEN = /[​-‏‪-‮⁠-⁤﻿]|[\u{E0000}-\u{E007F}]/u;
const POISON: [RegExp, string][] = [
  [/ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|prompts|rules)/i, "tells the assistant to ignore its instructions"],
  [/<\s*(important|system|secret|instructions?)\s*>/i, "has a hidden instruction block"],
  [/do not (tell|mention|inform|show|reveal)[^.]{0,30}(the )?user/i, "tells the assistant to hide something from the user"],
  [/(read|send|upload|include|pass)[^.]{0,60}(~\/\.ssh|id_rsa|\.env\b|private key|api[_ -]?key|password|credentials)/i, "asks for keys, passwords or files from the user's computer"],
  [/(before|instead of) (using|calling) (any|this|other) tools?/i, "tries to change how other tools are used"],
];
const CHANGES = /(delete|remove|drop|destroy|purge|update|write|create|insert|send|post|exec|execute|run|shell|command|transfer|pay|refund|deploy|upload|move|rename|kill)/i;

/** Checks the server and its tools. Read-only: the extra sessions it opens are closed again. */
export async function mcpFindings(c: ResolvedConnection, signal?: AbortSignal): Promise<{ findings: ToolFinding[]; summary: string[]; table: { title: string; columns: string[]; rows: string[][] } }> {
  const inv = await mcpInventory(c, signal);
  const url = c.url!;
  const findings: ToolFinding[] = [];
  const add = (f: Omit<ToolFinding, "pageUrl" | "category"> & { category?: ToolFinding["category"] }) => findings.push({ category: "security", ...f, pageUrl: url });
  const u = new URL(url);
  const local = /^(localhost|127\.|\[::1\])/.test(u.hostname);

  if (u.protocol === "http:" && !local) {
    add({ severity: "high", rule: "mcp:no-https", title: "The MCP server is reached without HTTPS", detail: "Its token and every tool answer cross the internet unencrypted. Put the server behind HTTPS.", evidence: url });
  }

  // Does it work without the token?
  try {
    const anon = new McpClient(url, undefined, signal);
    const a = await anon.initialize();
    if (a.status < 300 && a.body?.result) {
      if (c.secret.token) {
        add({ severity: "high", rule: "mcp:no-auth", title: "The MCP server works without its token", detail: "A session started without any token was accepted, so anyone who finds the address can use every tool. Make the server check the token on every request.", evidence: `initialize without Authorization: ${a.status}` });
      } else {
        add({ severity: "medium", rule: "mcp:no-auth", title: "The MCP server needs no sign-in", detail: "Anyone who finds the address can use its tools. If the tools reach private data or change anything, add a token (OAuth or a bearer token).", evidence: `initialize without Authorization: ${a.status}` });
      }
      await anon.close();
    }
  } catch {
    // refused: good
  }

  // DNS rebinding: a web page in someone's browser must not reach the server.
  try {
    const evil = new McpClient(url, c.secret.token, signal, { origin: "https://glv-origin-check.invalid" });
    const a = await evil.initialize();
    if (a.status < 300 && a.body?.result) {
      add({ severity: local ? "high" : "medium", rule: "mcp:origin-not-checked", title: "The MCP server does not check where requests come from", detail: "A request with the Origin of an unknown website was accepted. The MCP rules say servers must check the Origin header, or a web page can reach the server through the visitor's browser (DNS rebinding). Refuse unknown origins.", evidence: "Origin: https://glv-origin-check.invalid accepted" });
    }
    const cors = inv.init.headers.get("access-control-allow-origin");
    if (cors === "*") {
      add({ severity: "medium", rule: "mcp:cors-any", title: "The MCP server lets any website read its answers", detail: "It sends Access-Control-Allow-Origin: *, so any web page can call it from a visitor's browser. Allow only your own sites.", evidence: "Access-Control-Allow-Origin: *" });
    }
    await evil.close();
  } catch {
    // refused: good
  }

  if (inv.client.protocol && inv.client.protocol < "2025-03-26") {
    add({ category: "functional", severity: "low", rule: "mcp:old-protocol", title: `The MCP server speaks an old version (${inv.client.protocol})`, detail: `Newer assistants expect ${MCP_VERSION}. Update the server's MCP library.`, evidence: inv.client.protocol });
  }

  const names = new Map<string, number>();
  const rows: string[][] = [];
  for (const t of inv.tools) {
    names.set(t.name, (names.get(t.name) ?? 0) + 1);
    const text = `${t.name}\n${t.description ?? ""}\n${JSON.stringify(t.inputSchema ?? {})}`;
    const hints = t.annotations?.readOnlyHint ? "read-only" : t.annotations?.destructiveHint ? "changes things" : t.annotations?.destructiveHint === false ? "safe changes" : "none";
    rows.push([t.name, (t.description ?? "").slice(0, 120), hints]);
    if (HIDDEN.test(text)) {
      add({ severity: "high", rule: "mcp:hidden-text", title: `Tool "${t.name}" has hidden characters in its description`, detail: "Characters a person cannot see but an AI assistant reads were found. This is how tool poisoning hides instructions. Remove them.", evidence: JSON.stringify(text.match(HIDDEN)?.[0] ?? "") });
    }
    for (const [re, what] of POISON) {
      const m = re.exec(text);
      if (m) {
        add({ severity: "high", rule: "mcp:tool-poisoning", title: `Tool "${t.name}" ${what}`, detail: "Tool descriptions go straight to the AI assistant, which may follow them. Text like this is the sign of a poisoned tool, or a mistake that one prompt injection away becomes one. Remove it.", evidence: m[0].slice(0, 200) });
        break;
      }
    }
    if (!t.description?.trim()) {
      add({ category: "functional", severity: "low", rule: "mcp:no-description", title: `Tool "${t.name}" has no description`, detail: "The assistant has to guess what it does, and may call it at the wrong time. Say in one or two lines what it does.", evidence: t.name });
    }
    if (!t.inputSchema || typeof t.inputSchema !== "object") {
      add({ category: "functional", severity: "low", rule: "mcp:no-schema", title: `Tool "${t.name}" has no input schema`, detail: "MCP tools must describe their inputs, so assistants send the right fields.", evidence: t.name });
    }
    if (CHANGES.test(t.name) && t.annotations?.readOnlyHint === undefined && t.annotations?.destructiveHint === undefined) {
      add({ severity: "low", rule: "mcp:no-hints", title: `Tool "${t.name}" may change things but says nothing about it`, detail: "Add annotations (readOnlyHint, destructiveHint), so assistants ask the person before using it.", evidence: t.name });
    }
  }
  for (const [n, count] of names) {
    if (count > 1) add({ category: "functional", severity: "medium", rule: "mcp:duplicate-tool", title: `Two tools are both called "${n}"`, detail: "The assistant cannot tell them apart. Give each its own name.", evidence: `${count} tools named ${n}` });
  }
  return {
    findings,
    summary: [
      `${[inv.client.serverInfo?.name, inv.client.serverInfo?.version].filter(Boolean).join(" ") || "MCP server"}, protocol ${inv.client.protocol ?? "unknown"}`,
      `${inv.tools.length} tools, ${inv.resources.length} resources, ${inv.prompts.length} prompts listed (no tool was called)`,
    ],
    table: { title: "MCP tools", columns: ["Tool", "Description", "Safety hints"], rows: rows.slice(0, 200) },
  };
}
