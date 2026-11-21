import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { aiEnabled } from "./ai/triage.js";
import { uploadedPath } from "./engines/index.js";
import { fixWithPullRequest } from "./fix/pr.js";
import { WEB_PRODUCTS } from "./products.js";
import type { ScanQueue } from "./queue.js";
import { readBeacon, rumScript } from "./rum.js";
import type { Stores } from "./store.js";
import type { FixPr, Project, SeoInput } from "./types.js";

/*
 * Routes for: the real-visitor speed snippet (its script and the beacons it sends, open to the
 * client's visitors), the SEO audit's input, the fix repository's token, and AI fix pull requests.
 */

interface Deps {
  stores: Stores;
  queue: ScanQueue;
  getProject: (id: string) => Project;
  projectSummary: (p: Project) => unknown;
  fail: (status: number, message: string) => Error;
  userName: (req: FastifyRequest) => string;
}

const base = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "");

/** The line the client pastes into their site's <head>. */
export function rumSnippet(token: string): string {
  return `<script async src="${base()}/rum/${token}.js"></script>`;
}

/** At most this many beacons per project per minute, so a busy site or a bad actor cannot flood the server. */
const PER_MINUTE = 600;

export async function registerMoreRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { stores, getProject, fail } = deps;

  // ---- Real-visitor speed ------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/projects/:id/rum", async (req) => {
    const p = getProject(req.params.id);
    return { on: Boolean(p.rumToken), snippet: p.rumToken ? rumSnippet(p.rumToken) : null, summary: p.rumToken ? (stores.rum.summary(p.id) ?? null) : null };
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/rum", async (req) => {
    const p = getProject(req.params.id);
    if (!WEB_PRODUCTS.includes(p.type)) throw fail(400, "Real-visitor speed is for websites and web apps.");
    const b = (req.body ?? {}) as { on?: boolean; clear?: boolean; fresh?: boolean };
    const next = { ...p };
    if (b.on === false) delete next.rumToken;
    else if (b.on === true && (!p.rumToken || b.fresh)) next.rumToken = randomBytes(12).toString("hex");
    if (b.clear) stores.rum.deleteForProject(p.id);
    stores.projects.save(next);
    return { on: Boolean(next.rumToken), snippet: next.rumToken ? rumSnippet(next.rumToken) : null, summary: next.rumToken ? (stores.rum.summary(p.id) ?? null) : null };
  });

  const byToken = (token: string) => stores.projects.list().find((p) => p.rumToken && p.rumToken === token);
  const counts = new Map<string, { minute: number; n: number }>();
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: 4096 }, (_req, b, done) => done(null, b));
    scope.get<{ Params: { file: string } }>("/rum/:file", async (req, reply) => {
      const token = req.params.file.replace(/\.js$/, "");
      const p = /^[0-9a-f]{24}$/.test(token) ? byToken(token) : undefined;
      if (!p) return reply.code(404).type("application/javascript").send("/* no such snippet */");
      return reply
        .header("cache-control", "public, max-age=3600")
        .header("access-control-allow-origin", "*")
        .header("x-content-type-options", "nosniff")
        .type("application/javascript; charset=utf-8")
        .send(rumScript(`${base()}/rum/${token}`));
    });
    scope.post<{ Params: { file: string } }>("/rum/:file", async (req, reply) => {
      reply.header("access-control-allow-origin", "*");
      const p = /^[0-9a-f]{24}$/.test(req.params.file) ? byToken(req.params.file) : undefined;
      if (!p) return reply.code(404).send();
      const minute = Math.floor(Date.now() / 60_000);
      const c = counts.get(p.id);
      if (c && c.minute === minute && c.n >= PER_MINUTE) return reply.code(429).send();
      counts.set(p.id, { minute, n: c && c.minute === minute ? c.n + 1 : 1 });
      let raw: unknown;
      try {
        raw = JSON.parse(typeof req.body === "string" ? req.body : "");
      } catch {
        return reply.code(400).send();
      }
      const beacon = readBeacon(raw);
      if (!beacon) return reply.code(400).send();
      stores.rum.add(p.id, beacon);
      return reply.code(204).send();
    });
  });

  // ---- SEO audit input ---------------------------------------------------------------------
  app.put<{ Params: { id: string } }>("/api/projects/:id/seo", async (req) => {
    const p = getProject(req.params.id);
    if (!WEB_PRODUCTS.includes(p.type)) throw fail(400, "The SEO audit is for websites.");
    const b = (req.body ?? {}) as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max).trim() : "");
    const seo: SeoInput = {};
    const keywords = text(b.keywords, 20_000);
    const backlinks = text(b.backlinks, 50_000);
    if (keywords) seo.keywords = keywords;
    if (backlinks) seo.backlinks = backlinks;
    const gsc = text(b.gscFile, 200);
    if (gsc) {
      if (!/\.csv$/i.test(gsc) || !existsSync(uploadedPath(deps.queue.uploadsDir(), gsc))) throw fail(400, "Upload the Search Console export as a .csv file.");
      seo.gscFile = gsc;
      seo.gscFileName = text(b.gscFileName, 200) || gsc;
    } else if (b.gscFile === undefined && p.seo?.gscFile) {
      seo.gscFile = p.seo.gscFile;
      seo.gscFileName = p.seo.gscFileName;
    }
    if (p.seo?.gscFile && p.seo.gscFile !== seo.gscFile) await rm(path.join(deps.queue.uploadsDir(), path.basename(p.seo.gscFile)), { force: true });
    const next = { ...p, seo: Object.keys(seo).length ? seo : undefined };
    stores.projects.save(next);
    return deps.projectSummary(next);
  });

  // ---- The fix repository's token ----------------------------------------------------------
  app.put<{ Params: { id: string } }>("/api/projects/:id/repo-token", async (req) => {
    const p = getProject(req.params.id);
    const b = (req.body ?? {}) as { username?: unknown; token?: unknown };
    const token = typeof b.token === "string" ? b.token.trim() : "";
    const username = typeof b.username === "string" ? b.username.trim() : "";
    if (token.length < 8 || /[\u0000-\u001f\s]/.test(token)) throw fail(400, "Paste the access token (it needs write access to make a branch and open a pull request).");
    if (username && !/^[\w.@-]{1,100}$/.test(username)) throw fail(400, "The user name has characters Git does not allow.");
    stores.vault.saveRepoToken(p.id, username || undefined, token);
    return deps.projectSummary(p);
  });
  app.delete<{ Params: { id: string } }>("/api/projects/:id/repo-token", async (req) => {
    const p = getProject(req.params.id);
    stores.vault.deleteRepoToken(p.id);
    return deps.projectSummary(p);
  });

  // ---- AI fix pull requests ----------------------------------------------------------------
  const working = new Set<string>();
  app.post<{ Params: { id: string } }>("/api/issues/:id/fix", async (req, reply) => {
    const issue = stores.issues.get(req.params.id);
    if (!issue) throw fail(404, "Issue not found");
    const p = getProject(issue.projectId);
    const repoUrl = p.target.fixRepoUrl ?? p.target.repoUrl;
    if (!repoUrl) throw fail(400, "Add the project's source repository first (project page, Settings: \"Repository for fixes\").");
    if (!aiEnabled()) throw fail(400, "Claude is off: set ANTHROPIC_API_KEY in the server's .env to let Claude write fixes.");
    const token = stores.vault.repoToken(p.id);
    if (!token) throw fail(400, "Save an access token for the repository first: it needs write access to make a branch and open a pull request.");
    if (working.has(issue.id)) throw fail(409, "Claude is already writing a fix for this issue.");
    working.add(issue.id);
    const occurrence = issue.occurrences[0];
    const workDir = path.join(path.dirname(deps.queue.uploadsDir()), "work");
    await mkdir(workDir, { recursive: true });
    const by = deps.userName(req);
    void fixWithPullRequest({
      finding: { rule: issue.rule, title: issue.title, detail: issue.detail, severity: issue.severity, pageUrl: occurrence?.pageUrl ?? p.target.url ?? "", evidence: occurrence?.evidence },
      issueKey: issue.key,
      repoUrl,
      base: p.target.fixRepoUrl ? p.target.fixBranch : p.target.branch,
      token,
      workDir,
      by,
    })
      .then((pr) => saveFix(issue.projectId, issue.id, pr))
      .finally(() => working.delete(issue.id));
    return reply.code(202).send({ started: true });
  });
  app.get<{ Params: { id: string } }>("/api/issues/:id/fix", async (req) => {
    const issue = stores.issues.get(req.params.id);
    if (!issue) throw fail(404, "Issue not found");
    const p = getProject(issue.projectId);
    return { working: working.has(issue.id), prs: (p.fixPrs ?? []).filter((x) => x.issue === issue.key) };
  });

  function saveFix(projectId: string, issueId: string, pr: FixPr): void {
    const latest = stores.projects.get(projectId);
    if (!latest) return;
    stores.projects.save({ ...latest, fixPrs: [pr, ...(latest.fixPrs ?? [])].slice(0, 100) });
    const issue = stores.issues.get(issueId);
    if (!issue) return;
    stores.issues.save({
      ...issue,
      updatedAt: new Date().toISOString(),
      history: [
        ...issue.history,
        pr.status === "opened"
          ? { at: pr.at, type: "comment", text: `Claude opened a fix: ${pr.url} (branch ${pr.branch}, ${pr.files.join(", ")})`, by: pr.by }
          : { at: pr.at, type: "comment", text: `Claude could not open a fix: ${pr.error}`, by: pr.by },
      ],
    });
  }
}
