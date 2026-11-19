import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { runJourneys } from "../runner/journeys.js";
import { signIn } from "../runner/login.js";
import type { HookInbox, JourneyWatchRun, Login, Project, RoleLogin } from "../types.js";
import { redact, secretsOf } from "../vault.js";

/**
 * Journey watch: the project's read-only journeys, run every few minutes between tests (like
 * Datadog or Checkly browser checks). Journeys allowed to send forms are left out: a watch that
 * runs every 15 minutes must not fill the client's app with test records.
 */
export async function watchJourneys(p: Project, opts: { login?: Login; roles?: RoleLogin[]; mailUrl?: string; hook?: HookInbox }): Promise<JourneyWatchRun> {
  const t0 = Date.now();
  const journeys = (p.journeys ?? []).filter((j) => !j.off && !j.allowWrites);
  const secrets = [...secretsOf(opts.login), ...(opts.roles ?? []).flatMap((r) => secretsOf(r.login))];
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {});
  const dir = await mkdtemp(path.join(tmpdir(), "glv-jwatch-"));
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const signedIn = opts.login?.kind === "web" ? await signIn(context, opts.login, () => {}, { mailUrl: opts.mailUrl }) : undefined;
    const { results } = await runJourneys(context, journeys, {
      startUrl: signedIn?.landedUrl ?? p.target.url ?? "",
      artifactsDir: dir,
      login: opts.login,
      loggedIn: Boolean(signedIn),
      mailUrl: opts.mailUrl,
      hook: opts.hook,
      roleSession: async (roleId) => {
        const role = opts.roles?.find((r) => r.id === roleId);
        if (!role) throw new Error("The journey's role was deleted.");
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
        await signIn(ctx, role.login, () => {}, { mailUrl: opts.mailUrl });
        return { context: ctx, login: role.login, name: role.name };
      },
    });
    return redact(
      {
        at: new Date().toISOString(),
        ok: results.every((r) => r.ok),
        ms: Date.now() - t0,
        results: results.map((r) => {
          const bad = r.steps.find((s) => !s.ok);
          return { id: r.id, name: r.name, ok: r.ok, ms: r.ms, ...(bad ? { failedStep: bad.text, error: bad.error } : {}) };
        }),
      },
      secrets,
    );
  } finally {
    await browser.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
