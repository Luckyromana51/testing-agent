import { McpClient, type McpTool } from "../connections/mcp.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Attack tests for the client's own MCP server, beyond the listing checks of the MCP connection:
 * GLV calls the tools that only read (marked read-only, or named get/list/search/read/find), with
 * attack values in their text inputs (path traversal, SQL, server-side requests to cloud metadata,
 * shell commands), and checks the answers for files, database errors, cloud keys and command output.
 * It also tries a tool call without the token. Tools that write or delete are never called. Only
 * with the client's written permission for attack tests, on the hosts it names.
 */

const READ_NAME = /^(get|list|search|read|find|fetch|lookup|query|show|describe|view|count|check)[_\-A-Z]/i;
const WRITE_NAME = /(create|update|delete|remove|send|write|post|put|set|add|insert|drop|exec|run|pay|refund|transfer|cancel|approve|upload|move|rename|kill|restart)/i;

/** Whether a tool only reads, so GLV may call it. Pure, for tests. */
export function readOnlyTool(t: McpTool): boolean {
  if (t.annotations?.destructiveHint === true) return false;
  if (t.annotations?.readOnlyHint === true) return true;
  return READ_NAME.test(t.name) && !WRITE_NAME.test(t.name.replace(READ_NAME, ""));
}

export const MCP_PAYLOADS: { id: string; value: string; sign: RegExp; what: string }[] = [
  { id: "path", value: "../../../../../../etc/passwd", sign: /root:x?:0:0:/, what: "reads files on the server (path traversal)" },
  { id: "path-win", value: "..\\..\\..\\..\\windows\\win.ini", sign: /\[(fonts|extensions)\]/i, what: "reads files on the server (path traversal)" },
  { id: "sql", value: "x' OR '1'='1' -- ", sign: /(SQL syntax|SQLSTATE|sqlite3?\.|ORA-\d{5}|PG::|psycopg2|unterminated quoted string|near ".*": syntax error)/i, what: "puts input into SQL (SQL injection)" },
  { id: "ssrf", value: "http://169.254.169.254/latest/meta-data/iam/security-credentials/", sign: /(AccessKeyId|ami-id|instance-id|SecretAccessKey|computeMetadata)/i, what: "fetches internal addresses (SSRF to cloud metadata)" },
  { id: "cmd", value: "test; id; echo glvcmd", sign: /uid=\d+\([\w-]+\)|glvcmd\s*$/m, what: "runs shell commands from input (command injection)" },
];

/** The text inputs of a tool, from its input schema. Pure, for tests. */
export function textInputs(t: McpTool): { name: string; required: boolean }[] {
  const schema = t.inputSchema as { properties?: Record<string, { type?: string | string[] }>; required?: string[] } | undefined;
  return Object.entries(schema?.properties ?? {})
    .filter(([, p]) => !p.type || p.type === "string" || (Array.isArray(p.type) && p.type.includes("string")))
    .map(([name]) => ({ name, required: Boolean(schema?.required?.includes(name)) }));
}

function resultText(r: unknown): string {
  const content = (r as { content?: { type?: string; text?: string }[] } | undefined)?.content;
  if (Array.isArray(content)) return content.map((c) => c.text ?? "").join("\n");
  return JSON.stringify(r ?? "");
}

export const mcpAttackTool: Tool = {
  id: "mcp-attack",
  name: "MCP server attack tests",
  maker: "GLV Infotech (built in)",
  description:
    "Calls the read-only tools of the client's MCP server with attack values (path traversal, SQL injection, cloud metadata requests, shell commands) and checks the answers, and tries a call without the token. Tools that write or delete are never called.",
  checks: ["Path traversal, SQL injection, SSRF and command injection through tool inputs", "Tool calls that work without the token", "Only read-only tools are called; never on hosts outside the permission"],
  products: ["website", "ecommerce", "webapp", "saas", "crm", "api"],
  category: "security",
  safety: "permission",
  permission: "attack",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://modelcontextprotocol.io/specification",
  signedIn: "public",
  needsConnection: "mcp",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const permit = ctx.permit;
    if (!permit) throw new Error("MCP attack tests run only with the client's written permission for attack tests.");
    const c = ctx.connections?.find((x) => x.kind === "mcp");
    if (!c?.url) throw new Error("This project has no MCP connection. Add one on the Connections tab.");
    const host = new URL(c.url).hostname.toLowerCase();
    if (!permit.hosts.map((h) => h.toLowerCase()).includes(host)) throw new Error(`${host} is not in the client's written permission, so its MCP server was not attacked.`);
    const client = new McpClient(c.url, c.secret.token, ctx.signal);
    const init = await client.initialize();
    if (init.status >= 300) throw new Error(`The MCP server did not start a session (${init.status}).`);
    const tools = await client.list<McpTool>("tools/list", "tools");
    const callable = tools.filter(readOnlyTool);
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    let calls = 0;
    for (const t of callable.slice(0, 25)) {
      const inputs = textInputs(t);
      if (!inputs.length) {
        rows.push([t.name, "no text inputs", "-"]);
        continue;
      }
      const hits: string[] = [];
      for (const input of inputs.slice(0, 3)) {
        for (const p of MCP_PAYLOADS) {
          ctx.signal.throwIfAborted();
          const args = Object.fromEntries(inputs.filter((i) => i.required || i.name === input.name).map((i) => [i.name, i.name === input.name ? p.value : "test"]));
          const a = await client.send("tools/call", { name: t.name, arguments: args }).catch(() => null);
          calls++;
          const text = a?.body?.result ? resultText(a.body.result) : (a?.body?.error?.message ?? "");
          if (p.sign.test(text)) {
            hits.push(`${input.name}: ${p.id}`);
            findings.push({ category: "security", rule: `mcp:${p.id === "path-win" ? "path" : p.id}`, severity: p.id === "sql" ? "high" : "critical", title: `MCP tool ${t.name} ${p.what}`, detail: `Calling ${t.name} with ${input.name} = ${p.value} returned ${p.id === "sql" ? "a database error" : "data it should never return"}. An AI assistant connected to this server can be tricked (by a prompt injection) into doing the same. Validate the input against an allow-list, and never pass it to the file system, SQL, a shell or a fetch.`, pageUrl: c.url, evidence: `${t.name}(${JSON.stringify(args)})\n${text.slice(0, 500)}`, key: `mcp:${p.id}:${t.name}:${input.name}` });
            break;
          }
          await new Promise((ok) => setTimeout(ok, 300));
        }
      }
      rows.push([t.name, inputs.map((i) => i.name).join(", "), hits.join("; ") || "held"]);
    }
    await client.close();
    // A call without the token, when the connection has one.
    if (c.secret.token && callable[0]) {
      const anon = new McpClient(c.url, undefined, ctx.signal);
      const i = await anon.initialize().catch(() => null);
      if (i && i.status < 300 && i.body?.result) {
        const a = await anon.send("tools/call", { name: callable[0].name, arguments: Object.fromEntries(textInputs(callable[0]).filter((x) => x.required).map((x) => [x.name, "test"])) }).catch(() => null);
        if (a && a.status < 300 && a.body?.result && !(a.body.result as { isError?: boolean }).isError)
          findings.push({ category: "security", rule: "mcp:call-without-token", severity: "critical", title: "MCP tools can be called without the token", detail: `${callable[0].name} answered a call with no Authorization header. Anyone who finds the address can use the server's tools. Check the token on every request, not only on initialize.`, pageUrl: c.url, evidence: `tools/call ${callable[0].name} without a token: ${a.status}`, key: "mcp:anon-call" });
        await anon.close();
      }
    }
    return {
      findings,
      summary: [`${callable.length} of ${tools.length} tools only read and were called (${calls} calls); ${tools.length - callable.length} that may change things were left alone`],
      tested: `${calls} calls to ${c.url}`,
      table: { title: "Tools called", columns: ["Tool", "Text inputs", "Result"], rows },
    };
  },
};
