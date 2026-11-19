import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/server.js";
import { openDatabase } from "../src/store.js";
import { flakyIssues, trendPoints } from "../src/trends.js";
import type { Issue, Project, Run } from "../src/types.js";
import { checkOnce, cleanWatch, Watcher, WatchStore, type Alert, type WatchCheck } from "../src/watch.js";

process.env.DEFAULT_TOOLS = "none";

const run = (id: string, at: string, score: number, rules: string[], diff = { new: 0, fixed: 0, reopened: 0, open: 0 }): Run => ({
  id,
  url: "https://x/",
  status: "done",
  createdAt: at,
  startedAt: at,
  finishedAt: new Date(new Date(at).getTime() + 30_000).toISOString(),
  progress: [],
  diff,
  result: {
    startUrl: "https://x/",
    startedAt: at,
    finishedAt: at,
    pages: [],
    findings: rules.map((r, i) => ({ id: `${id}${i}`, rule: r, title: `Problem ${r}`, detail: "", pageUrl: "https://x/", severity: "medium", category: "functional" })),
    scores: { functional: score, seo: 100 - score / 2 },
    overallScore: score,
  },
});

describe("trends and flaky issues", () => {
  it("lists finished tests oldest first with new and fixed counts", () => {
    const pts = trendPoints([
      run("b", "2026-11-02T00:00:00Z", 80, [], { new: 1, fixed: 3, reopened: 1, open: 2 }),
      run("a", "2026-11-01T00:00:00Z", 60, []),
      { ...run("c", "2026-11-03T00:00:00Z", 0, []), status: "failed" },
    ]);
    assert.deepEqual(
      pts.map((p) => [p.runId, p.score, p.new, p.fixed, p.seconds]),
      [
        ["a", 60, 0, 0, 30],
        ["b", 80, 2, 3, 30],
      ],
    );
    assert.equal(pts[1].scores.functional, 80);
  });

  it("marks issues that come and go as flaky", () => {
    const runs = Array.from({ length: 10 }, (_, i) => run(`r${i}`, `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`, 90, i % 2 ? ["timer"] : ["steady"]));
    // "steady" in every even run and "timer" in every odd one: both 50%.
    const base = { projectId: "p", agent: undefined, detail: "", category: "functional" as const, severity: "medium" as const, status: "open" as const, occurrences: [], firstSeenRunId: "r0", lastSeenRunId: "r9", firstSeenAt: "", lastSeenAt: "", updatedAt: "" };
    const issues: Issue[] = [
      { ...base, id: "1", key: "P-1", fingerprint: "timer|Problem timer", rule: "timer", title: "Problem timer", history: [] },
      { ...base, id: "2", key: "P-2", fingerprint: "back|Problem back", rule: "back", title: "Problem back", history: [{ at: "", type: "regression", text: "" }, { at: "", type: "regression", text: "" }] },
      { ...base, id: "3", key: "P-3", fingerprint: "never|Problem never", rule: "never", title: "Problem never", history: [] },
    ];
    const flaky = flakyIssues(issues, runs);
    assert.deepEqual(
      flaky.map((f) => f.key),
      ["P-2", "P-1"],
    );
    assert.equal(flaky.find((f) => f.key === "P-1")!.seenIn, 5);
  });
});

describe("uptime watch", () => {
  let server: Server;
  let base: string;
  let answer = 200;
  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(answer, { "content-type": "text/html" });
      res.end(answer === 200 ? "<h1>Shop open</h1>" : "error");
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  after(() => server.close());

  it("checks a page, its status and expected words", async () => {
    answer = 200;
    const ok = await checkOnce(base, "shop open");
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 200);
    const missing = await checkOnce(base, "Closed for Diwali");
    assert.equal(missing.ok, false);
    assert.match(missing.error ?? "", /not on the page/);
    answer = 503;
    const bad = await checkOnce(base);
    assert.deepEqual([bad.ok, bad.status, bad.error], [false, 503, "HTTP 503"]);
    answer = 200;
    const refused = await checkOnce("http://127.0.0.1:1/");
    assert.equal(refused.ok, false);
    assert.equal(refused.status, null);
  });

  it("opens an outage after two failed checks, closes it on the next good one, and warns about the certificate once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-watch-"));
    try {
      const store = new WatchStore(openDatabase(dir));
      const project: Project = {
        id: "p1",
        key: "SHOP",
        name: "Shop",
        type: "website",
        target: { url: "https://shop.example/" },
        schedule: "off",
        createdAt: "",
        issueSeq: 0,
        watch: { on: true, everyMin: 1, webhook: "https://hooks.example/x", sslWarnDays: 21 },
      };
      const answers: boolean[] = [true, false, false, false, true];
      let n = 0;
      const sent: Alert[] = [];
      let days = 60;
      const fake = async (): Promise<WatchCheck> => {
        const ok = answers[n++];
        return { at: new Date(Date.UTC(2026, 10, 19, 0, n)).toISOString(), ok, status: ok ? 200 : 502, ms: 100 + n, ...(ok ? {} : { error: "HTTP 502" }) };
      };
      const cert = async () => ({ validTo: new Date(Date.now() + days * 86_400_000).toISOString(), issuer: "Let's Encrypt" });
      const w = new Watcher(store, () => [project], async (_h, a) => void sent.push(a), fake, cert);
      let now = Date.now();
      for (let i = 0; i < 5; i++) {
        if (i === 3) days = 10;
        await w.tick(now);
        now += 60_000 + (i === 2 ? 7 * 3_600_000 : 0);
      }
      assert.deepEqual(
        sent.map((a) => a.kind),
        ["down", "ssl", "up"],
      );
      assert.match(sent[0].text, /Shop is DOWN/);
      assert.match(sent[1].text, /ends in (9|10) days/);
      assert.match(sent[2].text, /back UP/);
      const s = store.summary(project, Date.UTC(2026, 10, 19, 0, 10));
      assert.equal(s.incidents.length, 1);
      assert.ok(s.incidents[0].endedAt);
      assert.equal(s.down, false);
      assert.equal(s.uptime.day, 40);
      assert.equal(s.ssl?.issuer, "Let's Encrypt");
      assert.equal(w.alerts.length, 3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cleans watch settings", () => {
    assert.deepEqual(cleanWatch({ on: true, everyMin: 7 }), { on: true, everyMin: 5, sslWarnDays: 21 });
    assert.throws(() => cleanWatch({ on: true, webhook: "http://10.0.0.1/hook" }), /Private/);
    assert.equal(cleanWatch(null), undefined);
  });
});

describe("API: trends and watch", () => {
  let dataDir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dataDir = await mkdtemp(path.join(tmpdir(), "glv-watch-api-"));
    ({ app, stores } = await createApp({ dataDir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("returns trends and the watch summary, and saves watch settings", async () => {
    stores.projects.save({ id: "p1", key: "SHOP", name: "Shop", type: "website", target: { url: "https://example.com/" }, schedule: "off", createdAt: "2026-11-01T00:00:00Z", issueSeq: 0 });
    stores.runs.save({ ...run("r1", "2026-11-01T00:00:00Z", 70, []), projectId: "p1" });
    stores.runs.save({ ...run("r2", "2026-11-02T00:00:00Z", 85, []), projectId: "p1" });
    const d = (await app.inject({ method: "GET", url: "/api/projects/p1" })).json();
    assert.deepEqual(
      d.trends.map((t: { score: number }) => t.score),
      [70, 85],
    );
    assert.equal(d.watch.on, false);
    const saved = await app.inject({ method: "PATCH", url: "/api/projects/p1", payload: { watch: { on: true, everyMin: 15, expectText: "Shop" } } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().watch, { on: true, everyMin: 15, expectText: "Shop", sslWarnDays: 21 });
    const bad = await app.inject({ method: "PATCH", url: "/api/projects/p1", payload: { watch: { on: true, webhook: "ftp://x" } } });
    assert.equal(bad.statusCode, 400);
    const overview = (await app.inject({ method: "GET", url: "/api/watch" })).json();
    assert.deepEqual(overview.down, []);
  });
});

describe("issue places", () => {
  it("keeps every place an issue was seen, not just the first 50", async () => {
    const { syncIssues } = await import("../src/issues.js");
    const project: Project = { id: "p", key: "GC", name: "Shop", type: "website", target: { url: "https://x/" }, schedule: "off", createdAt: "", issueSeq: 0 };
    const r = run("r1", "2026-11-19T00:00:00Z", 80, []);
    r.result!.pages = Array.from({ length: 120 }, (_, i) => ({ url: `https://x/p${i}`, status: 200, title: "", loadMs: 1 }));
    r.result!.findings = r.result!.pages.map((p, i) => ({ id: `f${i}`, rule: "axe:label-content-name-mismatch", title: "Visible text not in the name", detail: "", pageUrl: p.url, severity: "medium", category: "accessibility" }));
    const { created } = syncIssues(project, r, []);
    assert.equal(created.length, 1);
    assert.equal(created[0].occurrences.length, 120);
  });
});
