import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { certFindings, robotsBlocksAll } from "../src/agents/web/site.js";
import { trackersIn } from "../src/agents/web/page.js";
import { isLocalAddress } from "../src/auth.js";
import { fixFor } from "../src/fixes.js";
import { projectKey, syncIssues } from "../src/issues.js";
import { createApp } from "../src/server.js";
import type { Finding, Issue, Project, Run } from "../src/types.js";
import { startDemoSite } from "./fixtures/demo-site.js";

const project: Project = {
  id: "p1",
  key: "DEMO",
  name: "Demo",
  type: "website",
  target: { url: "https://a.com/" },
  schedule: "off",
  createdAt: "2026-01-01T00:00:00Z",
  issueSeq: 0,
};

function runWith(id: string, findings: Partial<Finding>[], pages = ["https://a.com/"]): Run {
  return {
    id,
    url: "https://a.com/",
    status: "done",
    createdAt: "2026-01-01T00:00:00Z",
    progress: [],
    agents: ["web.seo", "web.links"],
    result: {
      startUrl: "https://a.com/",
      startedAt: "",
      finishedAt: "",
      pages: pages.map((url) => ({ url, status: 200, title: "", loadMs: 1 })),
      findings: findings.map((f, n) => ({
        id: `f${n}`,
        category: "seo",
        severity: "high",
        title: "No title",
        detail: "",
        pageUrl: "https://a.com/",
        rule: "seo:title-missing",
        agent: "web.seo",
        ...f,
      })),
      scores: { functional: 100, accessibility: 100, seo: 100, security: 100, performance: 100, mobile: 100 },
      overallScore: 100,
    },
  };
}

describe("issue tracker and regression", () => {
  it("creates issues with Jira-style keys and skips info findings", () => {
    const r = syncIssues(project, runWith("r1", [{}, { rule: "x", severity: "info", title: "fyi" }]), []);
    assert.equal(r.created.length, 1);
    assert.equal(r.created[0].key, "DEMO-1");
    assert.equal(r.project.issueSeq, 1);
    assert.deepEqual(r.diff, { new: 1, fixed: 0, reopened: 0, open: 1 });
  });

  it("verifies a fix when the re-test no longer finds it, and reopens it when it comes back", () => {
    const first = syncIssues(project, runWith("r1", [{}]), []);
    const issues: Issue[] = first.created;
    const second = syncIssues(first.project, runWith("r2", []), issues);
    assert.equal(second.changed[0].status, "verified");
    assert.equal(second.diff.fixed, 1);
    const third = syncIssues(second.project, runWith("r3", [{}]), second.changed);
    assert.equal(third.changed[0].status, "reopened");
    assert.equal(third.diff.reopened, 1);
    assert.equal(third.changed[0].key, "DEMO-1", "a regression keeps its key");
    assert.equal(third.changed[0].history.at(-1)?.type, "regression");
  });

  it("does not call an issue fixed when the re-test did not look at that page", () => {
    const first = syncIssues(project, runWith("r1", [{ pageUrl: "https://a.com/deep" }], ["https://a.com/", "https://a.com/deep"]), []);
    const second = syncIssues(first.project, runWith("r2", [], ["https://a.com/"]), first.created);
    assert.equal(second.changed.length, 0);
  });

  it("makes short project keys", () => {
    assert.equal(projectKey("GLV Infotech Solutions"), "GIS");
    assert.equal(projectKey("glvinfotechsolutions.com"), "GC");
    assert.equal(projectKey("Shop"), "SHOP");
    assert.equal(projectKey("Shop", ["SHOP"]), "SHOP2");
  });
});

describe("agent helpers", () => {
  it("reads robots.txt groups correctly", () => {
    assert.ok(robotsBlocksAll("User-agent: *\nDisallow: /"));
    assert.ok(!robotsBlocksAll("User-agent: *\nDisallow: /admin\n\nUser-agent: BadBot\nDisallow: /"));
    assert.ok(!robotsBlocksAll("User-agent: *\nDisallow:"));
  });
  it("rates certificates by days left", () => {
    const now = new Date("2026-11-17T00:00:00Z");
    const in10 = new Date("2026-11-27T00:00:00Z");
    assert.equal(certFindings("a.com", { validTo: in10, authorizationError: null }, now)[0].severity, "high");
    assert.equal(certFindings("a.com", { validTo: new Date("2027-06-01"), authorizationError: null }, now).length, 0);
    assert.equal(
      certFindings("a.com", { validTo: new Date("2026-11-01"), authorizationError: "CERT_HAS_EXPIRED" }, now)[0].rule,
      "sec:cert-expired",
    );
  });
  it("recognises trackers", () => {
    assert.deepEqual(trackersIn(["https://www.googletagmanager.com/gtag/js?id=G-1", "https://a.com/x.js"]), [
      "Google Analytics / Tag Manager",
    ]);
  });
});

describe("platform API", () => {
  let site: Server;
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let cookie = "";
  const port = 4197;
  const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
      payload: payload as object,
      headers: cookie ? { cookie } : {},
    });
    return { status: res.statusCode, body: res.body ? res.json() : null, headers: res.headers };
  };
  const waitForRun = async (id: string) => {
    for (let i = 0; i < 240; i++) {
      const { body } = await call("GET", `/api/runs/${id}`);
      if (body.status === "done" || body.status === "failed") return body;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("run did not finish");
  };

  before(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "1";
    site = await startDemoSite(port);
    dir = await mkdtemp(path.join(tmpdir(), "glvapi-"));
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    await app.close();
    site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("asks for an owner account first and blocks everything else", async () => {
    assert.equal((await call("GET", "/api/auth/state")).body.setupNeeded, true);
    assert.equal((await call("GET", "/api/projects")).status, 401);
    assert.equal((await call("POST", "/api/auth/setup", { email: "o@a.com", password: "short" })).status, 400);
    const res = await call("POST", "/api/auth/setup", { email: "owner@glv.test", name: "Lucky", password: "a-long-password" });
    assert.equal(res.status, 200);
    cookie = String(res.headers["set-cookie"]).split(";")[0];
    assert.equal((await call("GET", "/api/auth/state")).body.user.role, "owner");
    assert.equal((await call("POST", "/api/auth/setup", { email: "x@a.com", password: "a-long-password" })).status, 409);
  });

  it("refuses cross-site requests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { cookie, origin: "https://evil.example", host: "localhost:4000" },
    });
    assert.equal(res.statusCode, 403);
  });

  it("tests a project, tracks its issues, and catches a regression on re-test", async () => {
    const created = await call("POST", "/api/projects", {
      type: "ecommerce",
      url: `http://127.0.0.1:${port}/`,
      maxPages: 6,
      checkLinks: false,
    });
    assert.equal(created.status, 201);
    const { project, run } = created.body;
    assert.match(project.key, /^[A-Z0-9]+$/);
    const done = await waitForRun(run.id);
    assert.equal(done.status, "done", done.error);
    assert.ok(done.agents.length >= 15);
    assert.ok(!done.agents.includes("web.links"), "link check was turned off for this project");
    assert.ok(done.diff.new > 0);

    const issues = (await call("GET", `/api/issues?projectId=${project.id}`)).body;
    assert.equal(issues.length, done.diff.new);
    assert.ok(issues.every((i: Issue) => i.key.startsWith(`${project.key}-`)));

    // A developer marks an issue fixed without fixing it; the re-test reopens it.
    const target = issues.find((i: Issue) => i.rule === "sec:exposed-env");
    assert.ok(target, "exposed .env is tracked");
    assert.equal((await call("PATCH", `/api/issues/${target.id}`, { status: "fixed", comment: "Blocked it" })).status, 200);
    assert.equal((await call("PATCH", `/api/issues/${target.id}`, { status: "verified" })).status, 400);
    const retest = await call("POST", `/api/projects/${project.id}/runs`, { trigger: "retest" });
    assert.equal(retest.status, 201);
    const second = await waitForRun(retest.body.id);
    assert.equal(second.diff.reopened, 1);
    const after = (await call("GET", `/api/issues/${target.id}`)).body;
    assert.equal(after.status, "reopened");
    assert.deepEqual(
      after.history.map((h: { type: string }) => h.type),
      ["created", "status", "comment", "regression"],
    );

    const detail = (await call("GET", `/api/projects/${project.id}`)).body;
    assert.equal(detail.trend.length, 2);
  });

  it("lets the owner switch agents off and add team members", async () => {
    const meta = (await call("GET", "/api/meta")).body;
    assert.ok(meta.agents.length >= 15);
    const res = await call("PATCH", "/api/owner/settings", { agents: { "web.privacy": false } });
    assert.equal(res.body.agents["web.privacy"], false);
    assert.equal((await call("GET", "/api/meta")).body.agents.find((a: { id: string }) => a.id === "web.privacy").enabled, false);
    const member = await call("POST", "/api/owner/users", { email: "dev@glv.test", name: "Dev", password: "another-long-one" });
    assert.equal(member.status, 201);
    const overview = (await call("GET", "/api/owner/overview")).body;
    assert.equal(overview.users, 2);
    assert.ok(overview.runsTotal >= 2);
  });
});

describe("login switched off (AUTH_DISABLED=1)", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  type Opts = { payload?: object; remoteAddress?: string; headers?: Record<string, string> };
  const call = async (method: string, url: string, opts: Opts = {}) => {
    const res = await app.inject({ method: method as "GET", url, ...opts });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glvoff-"));
    ({ app } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("skips the owner account and sign-in on this computer and the local network", async () => {
    const state = (await call("GET", "/api/auth/state")).body;
    assert.equal(state.loginOff, true);
    assert.equal(state.setupNeeded, false);
    assert.equal(state.user.role, "owner");
    assert.equal((await call("GET", "/api/projects")).status, 200);
    assert.equal((await call("GET", "/api/owner/overview", { remoteAddress: "192.168.65.1" })).status, 200);
    const saved = await call("PATCH", "/api/owner/settings", { payload: { defaultMaxPages: 15 } });
    assert.equal(saved.status, 200);
    assert.equal((await call("POST", "/api/auth/password", { payload: { current: "x", password: "a-long-password" } })).status, 400);
  });

  it("refuses visits from the internet, directly or through a proxy", async () => {
    assert.equal((await call("GET", "/api/projects", { remoteAddress: "203.0.113.9" })).status, 403);
    assert.equal((await call("GET", "/api/projects", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" } })).status, 403);
    assert.equal((await call("GET", "/api/auth/state", { headers: { "x-real-ip": "2001:db8::1" } })).status, 403);
  });

  it("knows which addresses are local", () => {
    for (const ip of ["127.0.0.1", "::1", "::ffff:172.17.0.1", "10.1.2.3", "192.168.1.20", "fd00::1", "fe80::1"]) {
      assert.ok(isLocalAddress(ip), ip);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "203.0.113.9", "2001:db8::1", "", "localhost"]) assert.ok(!isLocalAddress(ip), ip);
  });

  it("asks for the owner account again once login is back on", async () => {
    delete process.env.AUTH_DISABLED;
    const { app: on } = await createApp({ dataDir: dir });
    try {
      const state = (await on.inject({ method: "GET", url: "/api/auth/state" })).json();
      assert.equal(state.loginOff, false);
      assert.equal(state.setupNeeded, true);
      assert.equal((await on.inject({ method: "GET", url: "/api/projects" })).statusCode, 401);
    } finally {
      await on.close();
    }
  });
});

describe("fix suggestions", () => {
  it("has a written fix for every rule the scanner can raise", () => {
    const rules = [
      "broken-link",
      "sri-blocked",
      "perf:lcp",
      "sec:exposed-env",
      "seo:robots-blocks-all",
      "content:broken-value",
      "small-tap-targets",
      "axe:color-contrast",
    ];
    for (const rule of rules) assert.notEqual(fixFor({ rule, detail: "x" }).steps, "x", rule);
    assert.match(fixFor({ rule: "axe:unknown-rule", detail: "Learn more: https://dequeuniversity.com/rules/axe/4.10/x" }).steps, /dequeuniversity/);
  });
});
