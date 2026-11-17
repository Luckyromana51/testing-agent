import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { aiEnabled } from "./ai/triage.js";
import { ScanQueue, type ScanRequest } from "./queue.js";
import { RunStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR ?? "data");
const port = Number(process.env.PORT ?? 4000);

const store = new RunStore(dataDir);
const queue = new ScanQueue(store, dataDir, Number(process.env.SCAN_CONCURRENCY ?? 2));

export const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });

/** Only public http(s) URLs. Blocks localhost and private ranges unless ALLOW_PRIVATE_TARGETS=1. */
export function validateTarget(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("That does not look like a website address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new Error("Only http and https are supported.");
  const host = u.hostname;
  const isPrivate =
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]";
  if (isPrivate && process.env.ALLOW_PRIVATE_TARGETS !== "1") {
    throw new Error("Private and local addresses are blocked. Set ALLOW_PRIVATE_TARGETS=1 to test them.");
  }
  return u.toString();
}

app.get("/api/health", async () => ({ ok: true, ai: aiEnabled() }));

app.get("/api/runs", async () =>
  store.list().map(({ result, ai, progress, ...run }) => ({
    ...run,
    overallScore: result?.overallScore,
    pageCount: result?.pages.length,
    findingCount: result?.findings.length,
    lastProgress: progress.at(-1),
  })),
);

app.post<{ Body: ScanRequest }>("/api/runs", async (req, reply) => {
  const body = req.body ?? ({} as ScanRequest);
  let url: string;
  try {
    url = validateTarget(String(body.url ?? ""));
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  const maxPages = Math.min(Math.max(Number(body.maxPages) || 10, 1), 100);
  const run = queue.enqueue({
    url,
    maxPages,
    checkLinks: body.checkLinks !== false,
    accessibility: body.accessibility !== false,
  });
  return reply.code(201).send(run);
});

app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
  const run = store.get(req.params.id);
  return run ?? reply.code(404).send({ error: "Run not found" });
});

app.delete<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
  store.delete(req.params.id);
  return reply.code(204).send();
});

app.get<{ Params: { id: string; file: string } }>("/api/runs/:id/artifacts/:file", async (req, reply) => {
  const { id, file } = req.params;
  if (!/^[\w-]+$/.test(id) || !/^[\w.-]+\.(jpg|png)$/.test(file)) {
    return reply.code(400).send({ error: "Bad file name" });
  }
  return reply.sendFile(file, queue.artifactsDir(id));
});

// Serve the built dashboard (npm run build). In dev, Vite serves it on :5173 instead.
const webDist = path.resolve(here, "../web/dist");
await app.register(fastifyStatic, {
  root: existsSync(webDist) ? webDist : dataDir,
  serve: existsSync(webDist),
  wildcard: false,
});
if (existsSync(webDist)) {
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith("/api/")
      ? reply.code(404).send({ error: "Not found" })
      : reply.sendFile("index.html", webDist),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
}
