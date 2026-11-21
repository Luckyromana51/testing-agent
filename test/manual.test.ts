import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { syncIssues } from "../src/issues.js";
import { buildChecklist, cleanOwnCase, countRound, roundCsv, roundMarkdown, WRITTEN_CASES } from "../src/manual.js";
import { createApp } from "../src/server.js";
import type { Project, ProductType, Run } from "../src/types.js";

const project = (id: string, type: ProductType, extra: Partial<Project> = {}): Project => ({
  id,
  key: id.toUpperCase(),
  name: `Project ${id}`,
  type,
  target: { url: "https://example.com", maxPages: 1 },
  schedule: "off",
  createdAt: new Date().toISOString(),
  issueSeq: 0,
  tools: [],
  ...extra,
});

describe("manual checklist", () => {
  it("builds written, project and handbook cases for every product type, with unique ids", () => {
    for (const type of ["website", "ecommerce", "webapp", "saas", "crm", "api", "code", "android", "ios"] as ProductType[]) {
      const cases = buildChecklist(project("x", type));
      const ids = cases.map((c) => c.id);
      assert.equal(new Set(ids).size, ids.length, `${type}: ids are unique`);
      assert.ok(cases.some((c) => c.source === "written"), `${type}: has written cases`);
      assert.ok(cases.some((c) => c.source === "handbook"), `${type}: has handbook cases`);
      assert.ok(cases.every((c) => c.steps.length > 0 && c.expected), `${type}: every case has steps and what should happen`);
    }
    assert.ok(WRITTEN_CASES.length >= 70);
  });

  it("adds the project's journeys, scenarios, sign-in and roles", () => {
    const p = project("j", "crm", { journeys: [{ id: "j1", name: "Add a lead", steps: "open /leads\nclick New\nsee Saved" }] });
    const cases = buildChecklist(p, { roles: [{ id: "r1", name: "Sales rep" }], hasLogin: true });
    const j = cases.find((c) => c.id === "journey.j1")!;
    assert.deepEqual(j.steps, ["open /leads", "click New", "see Saved"]);
    assert.ok(cases.some((c) => c.id === "role.r1" && c.title.includes("Sales rep")));
    assert.ok(cases.some((c) => c.id === "project.login"));
    assert.ok(cases.some((c) => c.id.startsWith("lib.shop-")) === false, "no shop cases for a CRM");
    assert.ok(buildChecklist(project("s", "ecommerce")).some((c) => c.id === "lib.shop-checkout"));
  });

  it("checks the team's own cases", () => {
    assert.throws(() => cleanOwnCase({ title: "", steps: "a" }), /title/);
    assert.throws(() => cleanOwnCase({ title: "x", steps: "  " }), /step/);
    const c = cleanOwnCase({ title: "Print an invoice", steps: "Open an invoice\n\nPress Print" });
    assert.deepEqual(c.steps, ["Open an invoice", "Press Print"]);
    assert.equal(c.section, "Our own cases");
  });

  it("exports CSV without spreadsheet formulas, and Markdown with the failures first", () => {
    const cases = buildChecklist(project("e", "website")).slice(0, 3);
    cases[0] = { ...cases[0], title: "=HYPERLINK(\"x\")" };
    const r = { id: "r", projectId: "e", name: "Round 1", tester: "Asha", createdAt: "2026-11-21T00:00:00Z", cases, results: { [cases[1].id]: { status: "fail" as const, note: "Blank page, \"500\"", at: "", by: "Asha" } } };
    const csv = roundCsv(r);
    assert.ok(csv.includes("'=HYPERLINK"), "formula is made harmless");
    assert.ok(csv.includes('"Blank page, ""500"""'));
    const md = roundMarkdown(r, "Shop");
    assert.ok(md.indexOf("## Failed") < md.indexOf(`## ${cases[0].section}`));
    assert.deepEqual(countRound(r), { total: 3, pass: 0, fail: 1, skip: 0, todo: 2 });
  });

  it("never closes an issue found by a person when an automatic test does not find it", () => {
    const p = project("m", "website");
    const now = new Date().toISOString();
    const issue = { id: "i1", key: "M-1", projectId: "m", fingerprint: "manual:lib.form-happy:r1", rule: "manual:lib.form-happy", agent: "manual", title: "Manual test failed", detail: "", category: "functional" as const, severity: "medium" as const, status: "open" as const, occurrences: [{ pageUrl: "https://example.com" }], firstSeenRunId: "r1", lastSeenRunId: "r1", firstSeenAt: now, lastSeenAt: now, updatedAt: now, history: [] };
    const run = { id: "run1", url: "https://example.com", status: "done", createdAt: now, result: { findings: [], pages: [{ url: "https://example.com", status: 200 }], complete: true } } as unknown as Run;
    const { changed } = syncIssues(p, run, [issue]);
    assert.ok(!changed.some((c) => c.id === "i1" && c.status === "verified"));
  });
});

describe("manual test routes", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as "GET", url, payload });
    return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? res.json() : res.body, headers: res.headers };
  };
  const PNG = "data:image/png;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-manual-"));
    ({ app, stores } = await createApp({ dataDir: dir }));
    stores.projects.save(project("p1", "ecommerce"));
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("has every case on by default, and turns them off and on", async () => {
    const first = await call("GET", "/api/projects/p1/manual");
    assert.equal(first.status, 200);
    const cases = first.body.cases as { id: string; on: boolean }[];
    assert.ok(cases.length > 100);
    assert.ok(cases.every((c) => c.on), "every case starts on");

    const off = await call("PATCH", "/api/projects/p1/manual", { off: ["lib.shop-coupon", "not-a-case"] });
    assert.equal(off.body.on, cases.length - 1);
    assert.equal((await call("PATCH", "/api/projects/p1/manual", { all: false })).body.on, 0);
    assert.equal((await call("POST", "/api/projects/p1/manual/rounds", {})).status, 400, "nothing to test when all are off");
    assert.equal((await call("PATCH", "/api/projects/p1/manual", { all: true })).body.on, cases.length);
  });

  it("runs a round: results, notes, screenshots, issue, export, re-check", async () => {
    const own = await call("POST", "/api/projects/p1/manual/cases", { title: "Gift wrap option", steps: "Add an item\nTick gift wrap", expected: "Price adds 50" });
    assert.equal(own.status, 201);

    const round = await call("POST", "/api/projects/p1/manual/rounds", { build: "1.4.2", env: "Chrome on Windows" });
    assert.equal(round.status, 201);
    const rid = round.body.id;
    assert.ok(round.body.cases.some((c: { id: string }) => c.id === own.body.id), "own cases are in the round");
    const total = round.body.cases.length;

    const pass = await call("PUT", `/api/manual/rounds/${rid}/results/lib.shop-cart`, { status: "pass" });
    assert.equal(pass.body.counts.pass, 1);
    assert.equal((await call("PUT", `/api/manual/rounds/${rid}/results/lib.shop-cart`, { status: "maybe" })).status, 400);
    const failed = await call("PUT", `/api/manual/rounds/${rid}/results/lib.shop-checkout`, { status: "fail", note: "Total is 10 more than the cart" });
    assert.equal(failed.body.result.note, "Total is 10 more than the cart");

    assert.equal((await call("POST", `/api/manual/rounds/${rid}/results/lib.shop-checkout/shots`, { dataUrl: "data:image/png;base64,AAAA" })).status, 400, "not really a PNG");
    const shot = await call("POST", `/api/manual/rounds/${rid}/results/lib.shop-checkout/shots`, { dataUrl: PNG });
    assert.equal(shot.status, 201);
    const file = await app.inject({ method: "GET", url: `/api/manual/rounds/${rid}/files/${shot.body.file}` });
    assert.equal(file.statusCode, 200);
    assert.equal((await call("GET", `/api/manual/rounds/${rid}/files/..%2F..%2Fruns.db`)).status, 404);

    assert.equal((await call("POST", `/api/manual/rounds/${rid}/results/lib.shop-cart/issue`, {})).status, 400, "a passed case is not an issue");
    const issue = await call("POST", `/api/manual/rounds/${rid}/results/lib.shop-checkout/issue`, { severity: "high" });
    assert.equal(issue.status, 201);
    assert.equal(issue.body.key, "P1-1");
    assert.equal(stores.issues.get("P1-1")!.agent, "manual");
    assert.equal((await call("POST", `/api/manual/rounds/${rid}/results/lib.shop-checkout/issue`, {})).status, 409);

    const csv = await call("GET", `/api/manual/rounds/${rid}/export`);
    assert.ok(String(csv.body).includes("Total is 10 more than the cart"));
    assert.ok(String(csv.headers["content-disposition"]).includes(".csv"));
    const md = await call("GET", `/api/manual/rounds/${rid}/export?format=md`);
    assert.ok(String(md.body).includes("P1-1"));

    assert.equal((await call("PATCH", `/api/manual/rounds/${rid}`, { finished: true })).status, 200);
    assert.equal((await call("PUT", `/api/manual/rounds/${rid}/results/lib.shop-tax`, { status: "pass" })).status, 409, "a finished round is locked");

    const again = await call("POST", "/api/projects/p1/manual/rounds", { only: "failed" });
    assert.equal(again.status, 201);
    assert.equal(again.body.cases.length, total - 1, "everything but the passed case");

    const page = await call("GET", "/api/projects/p1/manual");
    assert.equal(page.body.rounds.length, 2);
    assert.deepEqual(page.body.history["lib.shop-checkout"], [null, "fail"]);
    const overview = await call("GET", "/api/manual");
    assert.equal(overview.body[0].last.name, "Re-check 2");
  });

  it("deletes rounds and screenshots with the project", async () => {
    assert.equal((await call("DELETE", "/api/projects/p1")).status, 204);
    assert.equal(stores.manual.list("p1").length, 0);
  });
});
