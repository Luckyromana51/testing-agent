import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { HACK_TOOLS, hackTarget } from "../src/hack-routes.js";
import { buildPermission, OWN_DAYS, permissionStatus, type Permission } from "../src/permission.js";
import { createApp } from "../src/server.js";
import type { Project } from "../src/types.js";

const NOW = Date.parse("2026-11-21T08:00:00Z");

const project = (id: string, url: string | undefined, permissions: Permission[] = [], type: Project["type"] = "website"): Project => ({
  id,
  key: id.toUpperCase(),
  name: id,
  type,
  target: url ? { url, maxPages: 1 } : {},
  schedule: "off",
  createdAt: new Date(NOW).toISOString(),
  issueSeq: 0,
  tools: [],
  permissions,
});

const own = (host: string, proved = true): Permission => {
  const p = buildPermission({ own: true, hosts: [host], confirm: true }, "Lucky", NOW);
  return proved ? { ...p, proofs: { [host]: { method: "file", at: new Date(NOW).toISOString() } } } : p;
};

describe("own-system unlock", () => {
  it("needs only the owner's confirmation, fills the paperwork and lasts a year", () => {
    assert.throws(() => buildPermission({ own: true, hosts: ["glvinfotechsolutions.com"] }, "Lucky", NOW), /owns or runs/);
    const p = buildPermission({ own: true, hosts: ["glvinfotechsolutions.com"], confirm: true }, "Lucky", NOW);
    assert.equal(p.own, true);
    assert.deepEqual(p.kinds, ["load", "attack"]);
    assert.match(p.reference, /Own system, confirmed by Lucky/);
    assert.equal(p.maxUsers, 1000);
    assert.equal(Date.parse(p.until) - Date.parse(p.from), OWN_DAYS * 86_400_000);
    // The proof file is still needed: a site GLV does not run can never be unlocked.
    assert.equal(permissionStatus(p, NOW), "waiting-proof");
  });

  it("keeps the client's paperwork rules for client systems", () => {
    assert.throws(
      () => buildPermission({ hosts: ["shop.example.com"], kinds: ["attack"], confirm: true, from: new Date(NOW).toISOString(), until: new Date(NOW + 200 * 86_400_000).toISOString(), grantedBy: "Ravi, CTO", reference: "Email", maxUsers: 10, maxMinutes: 10 }, "Lucky", NOW),
      /at most 90 days/,
    );
  });
});

describe("hack agent targets", () => {
  it("only an unlocked address with its proof in place is ready", () => {
    assert.ok(HACK_TOOLS.includes("glv-attack") && HACK_TOOLS.includes("glv-probes") && HACK_TOOLS.includes("zap-active"));
    assert.ok(!HACK_TOOLS.includes("k6"), "load tools stay on the project page");

    const ready = hackTarget(project("a", "https://glvinfotechsolutions.com/", [own("glvinfotechsolutions.com")]), false, NOW);
    assert.equal(ready.state, "ready");
    assert.equal(ready.own, true);
    assert.ok(ready.tools.includes("glv-attack"));

    assert.equal(hackTarget(project("b", "https://glvinfotechsolutions.com/", [own("glvinfotechsolutions.com", false)]), false, NOW).state, "waiting-proof");
    // A third-party site with no permission: shown, never launchable.
    assert.equal(hackTarget(project("c", "https://www.flipkart.com/"), false, NOW).state, "not-unlocked");
    // A permission for another host does not cover this one.
    assert.equal(hackTarget(project("d", "https://www.myntra.com/", [own("glvinfotechsolutions.com")]), false, NOW).state, "not-unlocked");
    assert.equal(hackTarget(project("e", "https://glvinfotechsolutions.com/", [own("glvinfotechsolutions.com")]), true, NOW).state, "busy");
    assert.equal(hackTarget(project("f", undefined, [], "android"), false, NOW).state, "not-supported");
    const revoked = { ...own("glvinfotechsolutions.com"), revokedAt: new Date(NOW).toISOString(), revokedBy: "Lucky" };
    assert.equal(hackTarget(project("g", "https://glvinfotechsolutions.com/", [revoked]), false, NOW).state, "not-unlocked");
  });
});

describe("hack agent routes", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  const call = async (method: string, url: string, payload?: object) => {
    const res = await app.inject({ method: method as "GET", url, payload });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };

  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dir = await mkdtemp(path.join(tmpdir(), "glv-hack-"));
    ({ app, stores } = await createApp({ dataDir: dir }));
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("lists every project with its state and refuses to start locked ones", async () => {
    stores.projects.save(project("locked", "https://www.flipkart.com/"));
    stores.projects.save(project("proofless", "https://glvinfotechsolutions.com/", [own("glvinfotechsolutions.com", false)]));
    const list = await call("GET", "/api/hack");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.targets.map((t: { projectId: string; state: string }) => [t.projectId, t.state]).sort(), [
      ["locked", "not-unlocked"],
      ["proofless", "waiting-proof"],
    ]);

    const res = await call("POST", "/api/hack/runs", { projectIds: ["locked", "proofless"], tools: [{ id: "glv-attack" }] });
    assert.equal(res.status, 200);
    assert.equal(res.body.started.length, 0);
    assert.equal(res.body.skipped.length, 2);
    assert.equal(stores.runs.list(10).length, 0, "nothing was queued");

    assert.equal((await call("POST", "/api/hack/runs", { projectIds: ["locked"], tools: [{ id: "k6" }] })).status, 400, "load tools are not hack tools");
    assert.equal((await call("POST", "/api/hack/runs", { projectIds: [], tools: [{ id: "glv-attack" }] })).status, 400);
  });
});
