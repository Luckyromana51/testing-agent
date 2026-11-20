import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";
import { auraGetItems, auraRecords, stuckFields, withExtraFields } from "../src/app/changes.js";
import { fillerValue } from "../src/app/forms.js";
import { writeConsent } from "../src/permission.js";
import { signIn } from "../src/runner/login.js";
import { scanSite } from "../src/runner/scan.js";
import type { ScanResult } from "../src/types.js";
import { CRM2_SPARE, CRM2_USER, startDemoCrm2, type DemoCrm2 } from "./fixtures/demo-crm2.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.DEFAULT_TOOLS = "none";
delete process.env.ANTHROPIC_API_KEY;

const CHANGE_AGENTS = ["app.lockout", "app.file-upload", "app.mass-assignment", "app.forgot-password", "app.form-fill"];

describe("consent for checks that change data", () => {
  it("allows a test copy or an active written permission, never a scheduled run", () => {
    assert.equal(writeConsent({ url: "https://x.test", testServer: true }, [], "manual").allowed, true);
    assert.equal(writeConsent({ url: "https://x.test", testServer: true }, [], "manual").testCopy, true);
    assert.equal(writeConsent({ url: "https://x.test" }, [], "manual").allowed, false);
    assert.equal(writeConsent({ url: "https://x.test", testServer: true }, [], "schedule").allowed, false);
  });

  it("adds privilege fields in the body's own format and spots the ones that stuck", () => {
    assert.deepEqual(JSON.parse(withExtraFields('{"name":"A"}', "application/json", { role: "admin" })!), { name: "A", role: "admin" });
    assert.equal(withExtraFields("name=A", "application/x-www-form-urlencoded", { is_admin: true }), "name=A&is_admin=1");
    assert.equal(withExtraFields("[1]", "application/json", { a: 1 }), undefined);
    assert.deepEqual(stuckFields({ data: { role: "admin", is_admin: 1, admin: false } }, { role: "admin", is_admin: true, admin: true }), ["role", "is_admin"]);
  });

  it("reads Aura answers", () => {
    assert.match(auraGetItems("Contact"), /"entityNameOrId":"Contact"/);
    assert.deepEqual(auraRecords('while(1);{"actions":[{"state":"SUCCESS","returnValue":{"totalCount":3,"result":[{"record":{"Id":"1","Name":"x"}}]}}]}'), { count: 3, sample: ["Id, Name"] });
    assert.equal(auraRecords('{"actions":[{"state":"ERROR"}]}'), undefined);
  });

  it("fills test values that are easy to find and delete", () => {
    assert.match(fillerValue({ name: "name", type: "text", label: "Name", required: true } as never, 0), /^GLV test/);
    assert.match(fillerValue({ name: "email", type: "email", label: "Email", required: true } as never, 0), /@/);
  });
});

describe("signed-in app checks that change data (demo CRM 2)", () => {
  let crm: DemoCrm2;
  let dir: string;
  let result: ScanResult;
  const login = () => ({ kind: "web" as const, loginUrl: `${crm.base}/login`, username: CRM2_USER.email, password: CRM2_USER.password });

  before(async () => {
    crm = await startDemoCrm2();
    dir = await mkdtemp(path.join(tmpdir(), "glv-crm2-"));
    result = await scanSite({
      url: `${crm.base}/home`,
      maxPages: 10,
      product: "crm",
      artifactsDir: dir,
      agents: CHANGE_AGENTS,
      login: login(),
      roles: [{ id: "spare", name: "Spare", lockoutTest: true, login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM2_SPARE.email, password: CRM2_SPARE.password } }],
      journeys: [{ id: "p", name: "Edit my profile", allowWrites: true, steps: "open /profile\nfill Name = Asha V\nclick Save\nsee Saved" }],
      writes: { allowed: true, testCopy: true, why: "The project is marked as a test copy." },
    });
  });
  after(async () => {
    await crm?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("signs in through a form inside a frame, and notices a wrong password there", async () => {
    const b = await chromium.launch();
    try {
      const ctx = await b.newContext();
      await signIn(ctx, login());
      await assert.rejects(signIn(await b.newContext(), { ...login(), password: "nope-nope" }), /still showing.*Wrong email or password/);
    } finally {
      await b.close();
    }
  });

  it("explores menus in shadow roots and screens in frames", () => {
    const urls = (result.screens ?? []).map((s) => new URL(s.url).pathname);
    for (const p of ["/contacts", "/files", "/profile", "/panel", "/reports"]) assert.ok(urls.includes(p), `${p} in ${urls}`);
  });

  it("finds the problems", () => {
    const rules = new Set(result.findings.map((f) => f.rule));
    for (const r of ["app:no-lockout", "app:reset-user-enum", "app:upload-runs-on-site", "app:mass-assignment", "app:form-server-error"]) assert.ok(rules.has(r), `${r} in ${[...rules]}`);
    assert.ok(crm.wrongPasswords >= 10);
  });

  it("puts back or lists what it changed", () => {
    const c = result.changes!;
    assert.equal(c.allowed, true);
    for (const n of ["Account lockout", "File upload safety", "Mass assignment", "Forgot password", "Claude filling forms"]) assert.ok(c.ran.includes(n), `${n} in ${c.ran}`);
    assert.equal(crm.files.size, 0, "the test files were deleted");
    assert.ok(c.cleanedUp.some((x) => x.includes("glv-upload-check")));
    assert.equal(crm.profile.role, "staff", "the role was put back");
    assert.ok(c.leftOver.some((x) => /is_admin/.test(x)), "fields that were not there before are listed");
    assert.ok((result.forms ?? []).some((f) => f.outcome === "saved" && f.fields.some((x) => x.value.startsWith("GLV test"))));
    assert.ok((result.forms ?? []).some((f) => f.outcome === "server-error"));
  });

  it("skips them all without consent, and says why", async () => {
    crm.log.length = 0;
    const r = await scanSite({ url: `${crm.base}/home`, maxPages: 3, product: "crm", artifactsDir: dir, agents: CHANGE_AGENTS, login: login(), explore: false, writes: { allowed: false, why: "No permission." } });
    assert.equal(r.changes?.allowed, false);
    assert.equal(r.changes?.ran.length, 0);
    assert.ok((r.changes?.skipped.length ?? 0) >= 4);
    assert.ok(!crm.log.some((l) => /^(upload|reset|profile|contact)/.test(l)), crm.log.join(", "));
  });

  it("Salesforce guest check: reads records a guest must not see", async () => {
    const r = await scanSite({ url: `${crm.base}/s/`, maxPages: 1, product: "crm", artifactsDir: dir, agents: ["app.salesforce-guest"], explore: false, writes: { allowed: true, why: "Permission given." } });
    const f = r.findings.find((x) => x.rule === "app:sf-guest-records");
    assert.ok(f, JSON.stringify(r.changes));
    assert.match(f!.title, /Contact/);
    assert.ok(crm.log.includes("aura Account"));
  });
});
