import { rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { testHostinger } from "./connections/hostinger.js";
import { testMcp } from "./connections/mcp.js";
import { testSsh } from "./connections/ssh.js";
import { ConnectionError, type ConnectionInput } from "./connections/store.js";
import { CONNECTION_KINDS, KIND_LABEL, type ConnectionTest } from "./connections/types.js";
import type { ScanQueue } from "./queue.js";
import type { Stores } from "./store.js";
import { defaultChoices, toolById } from "./tools/index.js";
import type { Project, Severity } from "./types.js";
import { redact } from "./vault.js";

interface Deps {
  stores: Stores;
  queue: ScanQueue;
  dataDir: string;
  getProject: (id: string) => Project;
  ownerOnly: (req: FastifyRequest) => void;
  fail: (status: number, message: string) => Error;
  userName: (req: FastifyRequest) => string;
}

/** The address of GLV's own MCP server, for the client's AI assistant. */
export const glvMcpUrl = () => `${(process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "")}/api/mcp`;

export function registerConnectionRoutes(app: FastifyInstance, { stores, queue, dataDir, getProject, ownerOnly, fail, userName }: Deps): void {
  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof ConnectionError) throw fail(400, err.message);
      throw err;
    }
  };
  const list = (projectId: string) => ({
    connections: stores.connections.views(projectId),
    mcpTokens: stores.connections.mcpTokens(projectId),
    glvMcpUrl: glvMcpUrl(),
    kinds: CONNECTION_KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })),
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/connections", async (req) => list(getProject(req.params.id).id));

  // Adding or changing a connection hands GLV a way into a client's system: the owner does it.
  app.post<{ Params: { id: string } }>("/api/projects/:id/connections", async (req, reply) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    const c = wrap(() => stores.connections.save(p.id, (req.body ?? {}) as ConnectionInput, userName(req)));
    return reply.code(201).send({ ...list(p.id), id: c.id });
  });

  app.patch<{ Params: { id: string; cid: string } }>("/api/projects/:id/connections/:cid", async (req) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    if (!stores.connections.get(p.id, req.params.cid)) throw fail(404, "Connection not found.");
    wrap(() => stores.connections.save(p.id, (req.body ?? {}) as ConnectionInput, userName(req), req.params.cid));
    return list(p.id);
  });

  app.delete<{ Params: { id: string; cid: string } }>("/api/projects/:id/connections/:cid", async (req) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    if (!stores.connections.delete(p.id, req.params.cid)) throw fail(404, "Connection not found.");
    await rm(path.join(dataDir, "connections", "known_hosts", req.params.cid.replace(/[^\w-]/g, "")), { force: true });
    return list(p.id);
  });

  /** Tries the connection once (read-only) and keeps what it saw. */
  app.post<{ Params: { id: string; cid: string } }>("/api/projects/:id/connections/:cid/test", async (req) => {
    const p = getProject(req.params.id);
    const c = wrap(() => stores.connections.resolve(p.id, req.params.cid));
    const secrets = [c.secret.key, c.secret.password, c.secret.token].filter((s): s is string => Boolean(s && s.length >= 6));
    let test: ConnectionTest;
    let hostKey: string | undefined;
    const workDir = path.join(dataDir, "work", `conn-${c.id}`);
    try {
      if (c.kind === "ssh") {
        const r = await testSsh(c, { workDir, dataDir });
        hostKey = r.hostKey;
        test = { at: new Date().toISOString(), ok: true, message: r.message, details: r.details };
      } else if (c.kind === "hostinger") {
        const r = await testHostinger(c);
        test = { at: new Date().toISOString(), ok: true, message: r.message, details: r.details, sites: r.sites, servers: r.servers };
      } else {
        const r = await testMcp(c);
        test = { at: new Date().toISOString(), ok: true, message: r.message, details: r.details };
      }
    } catch (err) {
      test = { at: new Date().toISOString(), ok: false, message: (err as Error).message.split("\n")[0].slice(0, 400) };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
    stores.connections.update(p.id, c.id, { lastTest: redact(test, secrets), ...(hostKey ? { hostKey } : {}) });
    return { ...list(p.id), test: redact(test, secrets) };
  });

  // ---- Tokens for the client's AI assistant to use GLV's MCP server, for this project only ----

  app.post<{ Params: { id: string } }>("/api/projects/:id/mcp-tokens", async (req, reply) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    if (stores.connections.mcpTokens(p.id).length >= 10) throw fail(400, "A project keeps at most 10 MCP tokens. Remove one first.");
    const name = String((req.body as { name?: unknown } | undefined)?.name ?? "").trim();
    const made = stores.connections.createMcpToken(p.id, name, userName(req));
    // Shown once: only its hash is kept.
    return reply.code(201).send({ ...list(p.id), token: made.token });
  });

  app.delete<{ Params: { id: string; tid: string } }>("/api/projects/:id/mcp-tokens/:tid", async (req) => {
    ownerOnly(req);
    const p = getProject(req.params.id);
    if (!stores.connections.deleteMcpToken(p.id, req.params.tid)) throw fail(404, "Token not found.");
    return list(p.id);
  });

  registerGlvMcp(app, { stores, queue });
}

// ---- GLV's own MCP server: the client's AI assistant asks for test results of their project ----

const MCP_TOOLS = [
  {
    name: "project_status",
    description: "The project's name, address, last test score and open issues by severity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "Project status" },
  },
  {
    name: "list_issues",
    description: "Open issues of the project, most severe first (at most 50).",
    inputSchema: {
      type: "object",
      properties: { severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"], description: "Only this severity." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: "Open issues" },
  },
  {
    name: "latest_report",
    description: "The last finished test: scores by area and its findings (at most 40).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "Latest report" },
  },
  {
    name: "start_test",
    description: "Starts a normal test of the project (safe checks only: never load or attack tools). One at a time.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, title: "Start a test" },
  },
];

const OPEN = new Set(["open", "in_progress", "reopened"]);
const ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function registerGlvMcp(app: FastifyInstance, { stores, queue }: { stores: Stores; queue: ScanQueue }): void {
  const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

  const callTool = async (p: Project, name: string, args: Record<string, unknown>) => {
    if (name === "project_status") {
      const open = stores.issues.list(p.id).filter((i) => OPEN.has(i.status));
      return text({
        name: p.name,
        type: p.type,
        address: p.target.url ?? p.target.specUrl ?? p.target.repoUrl ?? p.target.fileName,
        lastTestAt: p.lastRunAt,
        lastScore: p.lastScore,
        testRunning: queue.busy(p.id),
        openIssues: Object.fromEntries(ORDER.map((s) => [s, open.filter((i) => i.severity === s).length])),
      });
    }
    if (name === "list_issues") {
      const sev = typeof args.severity === "string" ? args.severity : undefined;
      const open = stores.issues
        .list(p.id)
        .filter((i) => OPEN.has(i.status) && (!sev || i.severity === sev))
        .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
        .slice(0, 50);
      return text(open.map((i) => ({ key: i.key, severity: i.severity, status: i.status, title: i.title, where: i.occurrences[0]?.pageUrl, category: i.category })));
    }
    if (name === "latest_report") {
      const run = stores.runs.list(20, p.id).find((r) => r.status === "done" && r.result);
      if (!run?.result) return text("No finished test yet.");
      const r = run.result;
      return text({
        at: run.finishedAt,
        overallScore: r.overallScore,
        scores: r.scores,
        findings: [...r.findings]
          .sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity))
          .slice(0, 40)
          .map((f) => ({ severity: f.severity, title: f.title, where: f.pageUrl, detail: f.detail.slice(0, 400) })),
      });
    }
    if (name === "start_test") {
      if (queue.busy(p.id)) return { ...text("A test of this project is already queued or running."), isError: true };
      // Safe tools only: load and attack tools always need a person at GLV to start them.
      const tools = (p.tools ?? (await defaultChoices(p.type))).filter((c) => toolById(c.id)?.safety === "safe");
      const run = queue.enqueue(p, "manual", { by: "Client AI (MCP)", control: { tools } });
      return text({ started: true, runId: run.id, note: "Ask latest_report once it has finished (usually a few minutes)." });
    }
    return undefined;
  };

  const answer = (reply: FastifyReply, id: unknown, result?: unknown, error?: { code: number; message: string }) =>
    reply.code(200).header("content-type", "application/json").send({ jsonrpc: "2.0", id: id ?? null, ...(error ? { error } : { result }) });

  app.get("/api/mcp", async (_req, reply) => reply.code(405).header("allow", "POST").send({ error: "Use POST (MCP Streamable HTTP)." }));
  app.delete("/api/mcp", async (_req, reply) => reply.code(200).send());

  app.post("/api/mcp", { bodyLimit: 100_000 }, async (req, reply) => {
    const projectId = req.mcpProject;
    const p = projectId ? stores.projects.get(projectId) : undefined;
    if (!p) return reply.code(401).header("www-authenticate", "Bearer").send({ error: "Unknown or removed MCP token." });
    const msg = (req.body ?? {}) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    if (typeof msg.method !== "string") return answer(reply, msg.id, undefined, { code: -32600, message: "Invalid request" });
    // Notifications get no answer.
    if (msg.id === undefined) return reply.code(202).send();
    switch (msg.method) {
      case "initialize":
        return answer(reply, msg.id, {
          protocolVersion: typeof msg.params?.protocolVersion === "string" && msg.params.protocolVersion <= "2025-06-18" ? msg.params.protocolVersion : "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "glv-testing-agent", version: "0.2" },
          instructions: `Test results of the project "${p.name}" from GLV's testing agent. Read-only, except start_test, which starts a normal (safe) test.`,
        });
      case "ping":
        return answer(reply, msg.id, {});
      case "tools/list":
        return answer(reply, msg.id, { tools: MCP_TOOLS });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        const out = await callTool(p, name, args);
        if (!out) return answer(reply, msg.id, undefined, { code: -32602, message: `Unknown tool: ${name}` });
        return answer(reply, msg.id, out);
      }
      default:
        return answer(reply, msg.id, undefined, { code: -32601, message: `Method not found: ${msg.method}` });
    }
  });
}
