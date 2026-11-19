import { readFile } from "node:fs/promises";
import type { JourneyWatchRun, Login, Project, RoleLogin } from "../types.js";
import { secretsOf, redact } from "../vault.js";
import { scanApi } from "./api.js";
import { uploadedPath } from "./index.js";

/**
 * API watch: the project's scenarios, run every few minutes between tests (like Postman monitors
 * and Checkly API checks), with the same alerts as the journey watch. Scenarios that change data
 * never run here, even on a test server: a watch must not fill the server with test records.
 */
export async function watchScenarios(p: Project, login: Login | undefined, roles: RoleLogin[], baselineFile: string, uploadsDir: string): Promise<JourneyWatchRun> {
  const t0 = Date.now();
  const scenarios = (p.apiScenarios ?? []).filter((s) => !s.off);
  const secrets = [...secretsOf(login), ...roles.flatMap((r) => secretsOf(r.login))];
  let specText: string | undefined;
  for (const f of [baselineFile, ...(p.target.file ? [uploadedPath(uploadsDir, p.target.file)] : [])]) {
    try {
      specText = await readFile(f, "utf8");
      break;
    } catch {
      /* next */
    }
  }
  const result = await scanApi({
    specUrl: specText ? undefined : p.target.specUrl,
    specText,
    baseUrl: p.target.url,
    auth: login?.kind === "api" ? login : undefined,
    roles,
    testServer: false,
    scenarios,
    scenariosOnly: true,
  });
  const runs = result.api?.scenarios ?? [];
  return redact(
    {
      at: new Date().toISOString(),
      ok: runs.every((r) => r.ok),
      ms: Date.now() - t0,
      results: runs.map((r) => {
        const bad = [...r.steps].reverse().find((s) => !s.ok);
        const check = bad?.checks?.find((c) => !c.ok);
        return { id: r.id, name: r.name, ok: r.ok, ms: r.ms, ...(bad ? { failedStep: check?.text ?? bad.text, error: check?.actual ?? bad.error ?? r.error } : r.error ? { error: r.error } : {}) };
      }),
    },
    secrets,
  );
}
