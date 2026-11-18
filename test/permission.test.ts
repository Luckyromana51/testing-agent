import assert from "node:assert/strict";
import dns from "node:dns";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  buildPermission,
  checkProof,
  hasPermission,
  holdsToken,
  hostOf,
  permissionStatus,
  permitFor,
  type Permission,
  type PermissionInput,
} from "../src/permission.ts";
import { createApp } from "../src/server.ts";
import { cleanChoices } from "../src/tools/index.ts";
import { startVulnSite, type VulnSite } from "./fixtures/vuln-site.ts";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.DEFAULT_TOOLS = "none";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-18T06:00:00Z");

const input = (o: Partial<PermissionInput> = {}): PermissionInput => ({
  hosts: ["shop.example.com"],
  kinds: ["load", "attack"],
  grantedBy: "Ravi Kumar, CTO",
  reference: "Email of 18 Nov 2026",
  maxUsers: 100,
  maxMinutes: 30,
  from: new Date(NOW - DAY).toISOString(),
  until: new Date(NOW + 30 * DAY).toISOString(),
  confirm: true,
  ...o,
});

const active = (o: Partial<Permission> = {}): Permission => {
  const p = buildPermission(input(), "Lucky", NOW);
  return { ...p, proofs: Object.fromEntries(p.hosts.map((h) => [h, { method: "file" as const, at: new Date(NOW).toISOString() }])), ...o };
};

describe("the client's permission", () => {
  it("needs the owner's confirmation, exact hosts, a kind, a period and limits", () => {
    assert.throws(() => buildPermission(input({ confirm: false }), "Lucky", NOW), /in writing/);
    assert.throws(() => buildPermission(input({ hosts: [] }), "Lucky", NOW), /at least one/);
    assert.throws(() => buildPermission(input({ hosts: ["*.example.com"] }), "Lucky", NOW), /wildcards/);
    assert.throws(() => buildPermission(input({ hosts: ["intranet"] }), "Lucky", NOW), /full host name/);
    assert.throws(() => buildPermission(input({ kinds: ["ddos"] }), "Lucky", NOW), /load tests, attack tests or both/);
    assert.throws(() => buildPermission(input({ grantedBy: "" }), "Lucky", NOW), /Who gave permission/);
    assert.throws(() => buildPermission(input({ reference: " " }), "Lucky", NOW), /written permission is kept/);
    assert.throws(() => buildPermission(input({ until: new Date(NOW - 2 * DAY).toISOString(), from: new Date(NOW - 3 * DAY).toISOString() }), "Lucky", NOW), /already over/);
    assert.throws(() => buildPermission(input({ until: new Date(NOW + 200 * DAY).toISOString() }), "Lucky", NOW), /at most 90 days/);
    assert.throws(() => buildPermission(input({ maxUsers: 5000 }), "Lucky", NOW), /at most 1000/);
    assert.throws(() => buildPermission(input({ maxMinutes: 0 }), "Lucky", NOW), /above 0/);

    const p = buildPermission(input({ hosts: "https://Shop.Example.com/path, www.example.com:8443 shop.example.com" }), "Lucky", NOW);
    assert.deepEqual(p.hosts, ["shop.example.com", "www.example.com:8443"]);
    assert.match(p.token, /^glv-testing=[0-9a-f]{32}$/);
    assert.equal(p.writes, false);
    assert.equal(p.createdBy, "Lucky");
    assert.equal(permissionStatus(p, NOW), "waiting-proof");
  });

  it("refuses private addresses unless the server allows them", () => {
    const before = process.env.ALLOW_PRIVATE_TARGETS;
    delete process.env.ALLOW_PRIVATE_TARGETS;
    try {
      assert.throws(() => buildPermission(input({ hosts: ["192.168.1.10"] }), "Lucky", NOW), /Private and local addresses/);
    } finally {
      process.env.ALLOW_PRIVATE_TARGETS = before;
    }
    assert.equal(hostOf("http://127.0.0.1:4000/x"), "127.0.0.1:4000");
  });

  it("is active only with proof on every host, between its dates, until withdrawn", () => {
    const p = active();
    assert.equal(permissionStatus(p, NOW), "active");
    assert.equal(permissionStatus({ ...p, from: new Date(NOW + DAY).toISOString() }, NOW), "scheduled");
    assert.equal(permissionStatus(p, NOW + 40 * DAY), "expired");
    assert.equal(permissionStatus({ ...p, revokedAt: new Date(NOW).toISOString() }, NOW), "revoked");
    assert.equal(permissionStatus({ ...p, proofs: {} }, NOW), "waiting-proof");
  });

  it("covers only its own hosts and kinds, and says why not", () => {
    const p = active({ kinds: ["load"] });
    const urls = ["https://shop.example.com/", "https://shop.example.com/cart", "https://cdn.example.com/x"];
    const ok = permitFor([p], "load", urls, NOW);
    assert.ok(typeof ok !== "string");
    assert.deepEqual(ok.urls, urls.slice(0, 2));
    assert.deepEqual(ok.outside, ["cdn.example.com"]);
    assert.match(String(permitFor([p], "attack", urls, NOW)), /No permission from the client for attack tests/);
    assert.match(String(permitFor([p], "load", ["https://www.example.com/"], NOW)), /covers shop\.example\.com, but this test reached www\.example\.com/);
    assert.match(String(permitFor([{ ...p, revokedAt: "2026-11-17T00:00:00.000Z" }], "load", urls, NOW)), /withdrawn on 2026-11-17/);
    assert.match(String(permitFor([p], "load", urls, NOW + 40 * DAY)), /ended on/);
    assert.match(String(permitFor([{ ...p, proofs: {} }], "load", urls, NOW)), /waiting for its proof file on shop\.example\.com/);
    assert.match(String(permitFor(undefined, "load", urls, NOW)), /owner adds it on the project page/);
    // The newest of two covering permissions wins.
    const newer = { ...active({ kinds: ["load"], maxUsers: 20 }), createdAt: new Date(NOW + 1000).toISOString() };
    assert.equal((permitFor([p, newer], "load", urls, NOW) as { permission: Permission }).permission.maxUsers, 20);
  });

  it("lets a load or attack tool be chosen only within a permission", () => {
    assert.throws(() => cleanChoices("website", ["k6"]), /Create the project first/);
    assert.throws(() => cleanChoices("website", ["k6"], []), /owner adds it on the project page/);
    assert.throws(() => cleanChoices("website", ["glv-probes"], [active({ kinds: ["load"] })]), /attack tests/);
    const p = active({ maxUsers: 50, maxMinutes: 10 });
    assert.deepEqual(cleanChoices("website", [{ id: "k6", options: { users: "50", minutes: "10" } }], [p]), [{ id: "k6", options: { users: "50", minutes: "10" } }]);
    assert.throws(() => cleanChoices("website", [{ id: "k6", options: { users: "100" } }], [p]), /at most 50 users/);
    assert.throws(() => cleanChoices("website", [{ id: "k6", options: { minutes: "15" } }], [p]), /at most 10 minutes/);
    // The default of 20 minutes is over this permission's 10.
    assert.throws(() => cleanChoices("website", ["zap-active"], [p]), /at most 10 minutes/);
    assert.throws(() => cleanChoices("website", [{ id: "jmeter", options: { plan: "../../etc/passwd" } }], [p]), /upload the JMeter test plan again/);
    assert.deepEqual(cleanChoices("website", [{ id: "jmeter", options: { plan: "11111111-2222-3333-4444-555555555555.jmx" } }], [p]), [
      { id: "jmeter", options: { plan: "11111111-2222-3333-4444-555555555555.jmx" } },
    ]);
    assert.ok(hasPermission([p], "attack", NOW));
    assert.equal(hasPermission([{ ...p, revokedAt: "x" }], "attack", NOW), undefined);
  });
});

describe("proof on the client's site", () => {
  let site: VulnSite;
  let other: http.Server;
  let otherHost = "";
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glvperm-"));
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "intro.txt"), "Handmade clothes.");
    site = await startVulnSite("planted", path.join(dir, "docs"));
    // A site that sends the proof request somewhere else.
    other = http.createServer((_req, res) => {
      res.writeHead(302, { location: `${site.url}.well-known/glv-testing.txt` });
      res.end();
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    otherHost = `127.0.0.1:${(other.address() as { port: number }).port}`;
  });
  after(async () => {
    await site.close();
    other.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds the token line in the proof file, and nothing else counts", async () => {
    const token = "glv-testing=0123456789abcdef0123456789abcdef";
    site.setProof("");
    const none = await checkProof(site.host, token);
    assert.equal(none.ok, false);
    assert.match(none.error!, /was not found \(404\)/);
    site.setProof("glv-testing=ffffffffffffffffffffffffffffffff");
    assert.match((await checkProof(site.host, token)).error!, /does not hold this permission's line/);
    site.setProof(token);
    assert.deepEqual(await checkProof(site.host, token), { host: site.host, ok: true, method: "file" });
    // The file must be on the host itself, not one it redirects to.
    const moved = await checkProof(otherHost, token);
    assert.equal(moved.ok, false);
    assert.match(moved.error!, /another host/);
    assert.ok(holdsToken("# note\r\n  glv-testing=abc  \n", "glv-testing=abc"));
    assert.ok(!holdsToken("xglv-testing=abc", "glv-testing=abc"));
  });

  it("accepts the token in a DNS TXT record instead, and says what it found", async (t) => {
    const token = "glv-testing=0123456789abcdef0123456789abcdef";
    const host = "shop.glv-check.invalid";
    const asked: string[] = [];
    let answer: string[][] | Error = [["v=spf1 -all"], ["glv-testing=", "0123456789abcdef0123456789abcdef"]];
    t.mock.method(dns.promises, "resolveTxt", async (name: string) => {
      asked.push(name);
      if (answer instanceof Error) throw answer;
      return answer;
    });
    // A long record comes back in parts; they are joined before comparing.
    assert.deepEqual(await checkProof(host, token), { host, ok: true, method: "dns" });
    assert.deepEqual(asked, ["_glv-testing.shop.glv-check.invalid"]);
    answer = [["glv-testing=ffffffffffffffffffffffffffffffff"]];
    assert.match((await checkProof(host, token)).error!, /TXT record _glv-testing\.shop\.glv-check\.invalid does not hold this permission's line/);
    answer = Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
    assert.match((await checkProof(host, token)).error!, /No TXT record at _glv-testing\.shop\.glv-check\.invalid/);
    // An IP address has no DNS name to hold a record.
    assert.match((await checkProof(site.host, "glv-testing=nope")).error!, /IP address or localhost has no DNS record/);
  });
});

describe("permission in the dashboard", () => {
  let site: VulnSite;
  let dir: string;
  let app: Awaited<ReturnType<typeof createApp>>["app"];
  let stores: Awaited<ReturnType<typeof createApp>>["stores"];
  let queue: Awaited<ReturnType<typeof createApp>>["queue"];
  let owner = "";
  let member = "";
  const call = async (method: string, url: string, payload?: unknown, as = owner) => {
    const res = await app.inject({ method: method as "GET", url, payload: payload as object, headers: as ? { cookie: as } : {} });
    return { status: res.statusCode, body: res.body ? res.json() : null };
  };
  const waitForRun = async (id: string) => {
    for (let i = 0; i < 400; i++) {
      const { body } = await call("GET", `/api/runs/${id}`);
      if (["done", "failed", "cancelled"].includes(body.status)) return body;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("run did not finish");
  };

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glvpermapp-"));
    await mkdir(path.join(dir, "docs"));
    await writeFile(path.join(dir, "docs", "intro.txt"), "Handmade clothes.");
    site = await startVulnSite("planted", path.join(dir, "docs"));
    ({ app, stores, queue } = await createApp({ dataDir: path.join(dir, "data") }));
    const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { email: "owner@glv.test", name: "Lucky", password: "a-long-password" } });
    owner = String(setup.headers["set-cookie"]).split(";")[0];
    await call("POST", "/api/owner/users", { email: "dev@glv.test", name: "Dev", password: "another-long-one" });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "dev@glv.test", password: "another-long-one" } });
    member = String(login.headers["set-cookie"]).split(";")[0];
  });
  after(async () => {
    await app.close();
    await site.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("records the owner's permission, checks the proof, runs the probes under it and stops when the proof goes", async () => {
    const created = await call("POST", "/api/projects", { type: "website", url: site.url, maxPages: 3, checkLinks: false });
    assert.equal(created.status, 201);
    const project = created.body.project;
    await waitForRun(created.body.run.id);
    // No permission yet: the tools are refused.
    const refused = await call("PATCH", `/api/projects/${project.id}`, { tools: ["glv-probes"] });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /needs the client's written permission for attack tests/);

    const draft = {
      hosts: [site.host],
      kinds: ["attack"],
      grantedBy: "Ravi Kumar, CTO",
      reference: "Email of 18 Nov 2026",
      maxUsers: 50,
      maxMinutes: 10,
      from: new Date(Date.now() - DAY).toISOString(),
      until: new Date(Date.now() + 7 * DAY).toISOString(),
      confirm: true,
    };
    // Only the owner records a permission.
    assert.equal((await call("POST", `/api/projects/${project.id}/permissions`, draft, member)).status, 403);
    site.setProof("");
    const added = await call("POST", `/api/projects/${project.id}/permissions`, draft);
    assert.equal(added.status, 201);
    const permission = added.body.project.permissions[0];
    assert.equal(permission.status, "waiting-proof");
    assert.equal(added.body.checks[0].ok, false);

    // Waiting for proof still lets the tool be chosen (the test checks again when it starts).
    assert.equal((await call("PATCH", `/api/projects/${project.id}`, { tools: [{ id: "glv-probes", options: { minutes: "2" } }] })).status, 200);
    site.setProof(permission.token);
    const checked = await call("POST", `/api/projects/${project.id}/permissions/${permission.id}/check`, {}, member);
    assert.equal(checked.status, 200);
    assert.equal(checked.body.project.permissions[0].status, "active");

    const run = await waitForRun((await call("POST", `/api/projects/${project.id}/runs`, { trigger: "retest" })).body.id);
    assert.equal(run.status, "done", run.error);
    const probes = run.result.tools.find((t: { id: string }) => t.id === "glv-probes");
    assert.equal(probes.status, "done", probes.untested);
    assert.equal(probes.permit.grantedBy, "Ravi Kumar, CTO");
    assert.equal(probes.permit.recordedBy, "Lucky");
    const rules = run.result.findings.filter((f: { agent: string }) => f.agent === "tool.glv-probes").map((f: { rule: string; pageUrl: string }) => `${f.rule} ${new URL(f.pageUrl).pathname}`);
    assert.ok(rules.includes("probe:xss /search"), rules.join(", "));
    assert.ok(rules.includes("probe:sql-injection /product"), rules.join(", "));
    assert.ok(site.requests.every((r) => r.method === "GET" || r.method === "HEAD"), "only reading requests");

    // The client takes the proof file down: the next test does not attack, and says why.
    site.setProof("");
    const second = await waitForRun((await call("POST", `/api/projects/${project.id}/runs`, { trigger: "retest" })).body.id);
    const stopped = second.result.tools.find((t: { id: string }) => t.id === "glv-probes");
    assert.equal(stopped.status, "untested");
    assert.match(stopped.untested, /proof is no longer on/);
    assert.ok(second.result.incomplete?.length, "the run says it is incomplete");

    // A scheduled test never runs load or attack tools.
    site.setProof(permission.token);
    const scheduled = queue.enqueue(stores.projects.get(project.id)!, "schedule");
    const third = await waitForRun(scheduled.id);
    assert.ok(!(third.result.tools ?? []).some((t: { id: string }) => t.id === "glv-probes"));
    assert.ok(third.progress.some((l: string) => /left out of scheduled tests/.test(l)));

    // Withdrawn: the tool is turned off for the project, and only the owner can do it.
    assert.equal((await call("POST", `/api/projects/${project.id}/permissions/${permission.id}/revoke`, {}, member)).status, 403);
    const revoked = await call("POST", `/api/projects/${project.id}/permissions/${permission.id}/revoke`, {});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.permissions[0].status, "revoked");
    assert.equal(revoked.body.permissions[0].revokedBy, "Lucky");
    assert.deepEqual(revoked.body.tools, []);
  });
});
