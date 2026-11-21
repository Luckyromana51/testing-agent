import type { ProductType } from "../types.js";
import type { Tool, ToolContext, ToolOutput } from "../tools/types.js";
import { hostingerFindings } from "./hostinger.js";
import { mcpFindings } from "./mcp.js";
import { SERVER_SCRIPT, serverFindings, sshReady, sshRun, sshSession } from "./ssh.js";
import type { ConnectionKind } from "./types.js";

/**
 * The checks each client connection adds to a test. They only read, so they are safe tools; they
 * are never on by default for a project without that connection, and the queue turns them on for
 * every test of a project that has one (unless its "check on every test" switch is off).
 */

const SERVER_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm", "api", "code"];
const MCP_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm", "api"];

const need = (ctx: ToolContext, kind: ConnectionKind) => {
  const c = ctx.connections?.find((x) => x.kind === kind && x.checks);
  if (!c) {
    const what = { ssh: "an SSH connection", hostinger: "a Hostinger connection", mcp: "an MCP connection" }[kind];
    throw new Error(`This project has no ${what} with checks on. Add one on the project's Connections tab.`);
  }
  return c;
};

export const sshServerTool: Tool = {
  id: "conn-ssh",
  name: "Server checks over SSH",
  maker: "GLV",
  description: "Signs in to the client's server with the saved SSH key and reads its health and safety settings. Only fixed, read-only commands run.",
  checks: [
    "System past its end of support, waiting security updates, restart needed",
    "Databases (MySQL, PostgreSQL, Redis, MongoDB...) listening on every network",
    "SSH root login, password sign-in, empty passwords",
    "Disk almost full, memory low, clock wrong, old PHP",
  ],
  products: SERVER_PRODUCTS,
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV (OpenSSH client: BSD)",
  homepage: "https://www.openssh.com/",
  signedIn: "public",
  needsConnection: "ssh",
  ready: () => sshReady(),
  async run(ctx): Promise<ToolOutput> {
    const c = need(ctx, "ssh");
    const session = await sshSession(c, { workDir: ctx.workDir, dataDir: ctx.dataDir ?? ctx.workDir });
    try {
      ctx.log(`Server checks: signing in to ${c.host} as ${c.username}`);
      const out = await sshRun(session, SERVER_SCRIPT, ctx.signal, 120_000);
      const where = `ssh://${c.username}@${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ""}`;
      const { findings, facts } = serverFindings(out, where);
      return {
        findings,
        summary: [facts.system, facts.kernel && `Kernel ${facts.kernel}`, facts.uptime && `Up: ${facts.uptime}`, ...facts.web].filter((x): x is string => Boolean(x)),
        tested: `Read the server ${c.host} (read-only)`,
      };
    } finally {
      await session.cleanup();
    }
  },
};

export const hostingerTool: Tool = {
  id: "conn-hostinger",
  name: "Hostinger account checks",
  maker: "GLV",
  description: "Reads the client's Hostinger account through Hostinger's API with their token. Only GET requests: nothing on the account changes.",
  checks: ["Servers stopped, without a firewall or without backups", "Domains expired or ending within 60 days", "Domains without SPF or DMARC (fake email)"],
  products: SERVER_PRODUCTS,
  category: "security",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV",
  homepage: "https://developers.hostinger.com/",
  signedIn: "public",
  needsConnection: "hostinger",
  ready: async () => null,
  async run(ctx): Promise<ToolOutput> {
    const c = need(ctx, "hostinger");
    ctx.log("Hostinger: reading the account (read-only)");
    let host: string | undefined;
    try {
      host = new URL(ctx.startUrl).hostname.replace(/^www\./, "");
    } catch {
      host = undefined;
    }
    const out = await hostingerFindings(c, { signal: ctx.signal, ...(host ? { domains: [host] } : {}) });
    return { findings: out.findings, summary: out.summary, table: out.table, tested: "Read the Hostinger account" };
  },
};

export const mcpServerTool: Tool = {
  id: "conn-mcp",
  name: "MCP server checks",
  maker: "GLV",
  description: "Checks the client's own MCP server the way an attacker would look at it. It only lists the tools, never calls one.",
  checks: [
    "Works without its token, no HTTPS, Origin not checked (DNS rebinding), any website allowed (CORS)",
    "Tool poisoning: hidden characters or instructions in tool descriptions",
    "Tools that change things without safety hints, missing descriptions and input schemas, duplicate names",
  ],
  products: MCP_PRODUCTS,
  category: "security",
  safety: "safe",
  takes: "seconds",
  licence: "GLV",
  homepage: "https://modelcontextprotocol.io/",
  signedIn: "public",
  needsConnection: "mcp",
  ready: async () => null,
  async run(ctx): Promise<ToolOutput> {
    const c = need(ctx, "mcp");
    ctx.log(`MCP: checking ${c.url}`);
    const out = await mcpFindings(c, ctx.signal);
    return { findings: out.findings, summary: out.summary, table: out.table, tested: `Listed the MCP server ${c.url}` };
  },
};

export const CONNECTION_TOOLS: Tool[] = [sshServerTool, hostingerTool, mcpServerTool];

/** The check tool of each connection kind. */
export const toolForKind: Record<ConnectionKind, string> = { ssh: "conn-ssh", hostinger: "conn-hostinger", mcp: "conn-mcp" };
