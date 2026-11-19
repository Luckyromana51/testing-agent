import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { isRecordUrl, matchesPattern } from "../src/app/access.js";
import { sameData } from "../src/app/calls.js";
import { HookStore } from "../src/app/hooks.js";
import { idNumbers } from "../src/app/session.js";
import { chosenSystem, detectSystem, SYSTEMS } from "../src/app/systems.js";
import { formulaCells } from "../src/app/tables.js";
import { base32Decode, codeInEmail, hotp, totp } from "../src/app/totp.js";
import { runJourneys } from "../src/runner/journeys.js";
import { LoginError, signIn } from "../src/runner/login.js";
import { scanSite } from "../src/runner/scan.js";
import { normaliseUrl } from "../src/runner/urls.js";
import { buildLogin, buildRole, buildTarget } from "../src/targets.js";
import type { ScanResult } from "../src/types.js";
import { Vault } from "../src/vault.js";
import { CRM_2FA, CRM_ADMIN, CRM_OTHER, CRM_STAFF, startDemoCrm, type DemoCrm } from "./fixtures/demo-crm.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
process.env.DEFAULT_TOOLS = "none";

describe("two-step codes (TOTP) made in-house", () => {
  it("matches the RFC 6238 test numbers and reads base32 and otpauth addresses", () => {
    // RFC 6238 appendix B, SHA-1, secret "12345678901234567890".
    const secret = Buffer.from("12345678901234567890");
    assert.equal(hotp(secret, Math.floor(59 / 30), 8), "94287082");
    assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), "07081804");
    assert.equal(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString(), "12345678901234567890");
    assert.equal(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 59_000), "287082");
    assert.equal(totp("otpauth://totp/Acme:me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&digits=8", 59_000), "94287082");
    assert.throws(() => base32Decode("not base32!"), /not allowed/);
    assert.equal(codeInEmail("Your verification code is 482913. It ends in 10 minutes."), "482913");
  });
});

describe("business systems", () => {
  it("knows 40 systems and spots them by address, page or cookie", () => {
    assert.ok(SYSTEMS.length >= 40, `${SYSTEMS.length} systems`);
    assert.equal(detectSystem({ url: "https://acme.my.salesforce.com/lightning/page/home" })?.id, "salesforce");
    assert.equal(detectSystem({ url: "https://erp.acme.in/web", html: '<nav class="o_main_navbar"><a data-menu-xmlid="crm.menu">CRM</a></nav>' })?.id, "odoo");
    assert.equal(detectSystem({ url: "https://site.in/wp-login.php", html: "" })?.id, "wordpress");
    const perfex = detectSystem({ url: "https://crm.glv.in/admin", html: '<script src="/assets/perfex_crm.js"></script>', cookies: ["ci_session"] });
    assert.equal(perfex?.id, "perfex");
    assert.equal(perfex?.framework, "CodeIgniter / PHP app");
    assert.equal(detectSystem({ url: "https://app.acme.in", cookies: ["laravel_session", "XSRF-TOKEN"] })?.id, "laravel");
    // A word anyone could write is not enough on its own.
    assert.equal(detectSystem({ url: "https://blog.test", html: "<p>We compared Odoo and Zoho.</p>" }), undefined);
  });

  it("lets the project choose the system when the test cannot spot it", () => {
    assert.deepEqual(chosenSystem("odoo")?.by, ["project setting"]);
    assert.equal(chosenSystem("nope"), undefined);
    const t = buildTarget("crm", { url: "https://crm.acme.in", system: "zoho" }, "/tmp", 20);
    assert.equal(t.system, "zoho");
    assert.equal(buildTarget("crm", { system: "" }, "/tmp", 20, t).system, undefined);
    assert.equal(buildTarget("crm", {}, "/tmp", 20, t).system, "zoho");
    assert.throws(() => buildTarget("crm", { url: "https://crm.acme.in", system: "made-up" }, "/tmp", 20), /not on the list/);
  });
});

describe("helpers of the signed-in checks", () => {
  it("tells record addresses, address rules, same data, ID numbers and formula cells", () => {
    assert.ok(isRecordUrl("https://x.test/contacts/42"));
    assert.ok(isRecordUrl("https://x.test/app#/leads/9"));
    assert.ok(isRecordUrl("https://x.test/view?invoice_id=77"));
    assert.ok(!isRecordUrl("https://x.test/contacts"));
    assert.equal(matchesPattern("https://x.test/admin/users", "/admin"), "/admin");
    assert.equal(matchesPattern("https://x.test/settings/billing?x=1", "/settings/*"), "/settings/*");
    assert.equal(matchesPattern("https://x.test/administrator", "/admin"), undefined);
    assert.ok(sameData('{"id":1,"name":"Asha Verma","email":"asha@acme.in","phone":"98450"}', '{"id":1,"name":"Asha Verma","email":"asha@acme.in","phone":"98450"}'));
    assert.ok(!sameData('{"items":["alpha","bravo","charlie","delta","echo"]}', '{"items":["foxtrot","golf","hotel","india","juliet"]}'));
    assert.deepEqual(idNumbers("Aadhaar 2345 6789 0124").map((x) => x.kind), ["Aadhaar number"]);
    assert.deepEqual(idNumbers("Order 2345 6789 0123"), [], "a 12-digit number that fails the check digit is not an Aadhaar");
    assert.deepEqual(formulaCells('Name,Total\nAsha,-500\n=HYPERLINK("x"),1\n'), ['=HYPERLINK("x")']);
    assert.equal(normaliseUrl("https://x.test/app#/contacts/"), "https://x.test/app#/contacts/");
    assert.equal(normaliseUrl("https://x.test/page#top"), "https://x.test/page");
  });

  it("checks roles and two-step logins before saving them", () => {
    const main = { ...buildLogin("crm", { loginUrl: "https://crm.test/login", username: "a@b.in", password: "x".repeat(8) }), hasPassword: true, hasToken: false, updatedAt: "" };
    const role = buildRole("crm", { name: "Sales staff", login: { username: "s@b.in", password: "y".repeat(8), totpSecret: "JBSWY3DPEHPK3PXP" }, mustNotOpen: "/admin\n/settings/*" }, main);
    assert.equal(role.login.loginUrl, "https://crm.test/login", "the main sign-in page is used when none is given");
    assert.equal(role.login.roleName, "Sales staff");
    assert.throws(() => buildRole("crm", { name: "X", login: { username: "s@b.in", password: "y".repeat(8), totpSecret: "0189!" } }, main), /not allowed/);
    assert.throws(() => buildRole("website", { name: "X", login: {} }, main), /web apps, SaaS, CRMs and APIs/);
    assert.throws(() => buildLogin("crm", { loginUrl: "https://crm.test/login", username: "a", password: "pw123456", steps: "jump around" }), /sign-in steps/);
  });

  it("keeps role logins encrypted and hides their secrets from the dashboard", () => {
    const db = new DatabaseSync(":memory:");
    const vault = new Vault(db, tmpdir(), { SECRET_KEY: "a-long-test-secret-key-123456" });
    vault.saveRole("p1", { id: "staff", name: "Staff", login: { kind: "web", loginUrl: "https://crm.test/login", username: "s@b.in", password: "Pa55word!", totpSecret: "JBSWY3DPEHPK3PXP" } });
    const raw = JSON.stringify(db.prepare("SELECT * FROM role_logins").all());
    assert.ok(!raw.includes("Pa55word!") && !raw.includes("JBSWY3DPEHPK3PXP"), "secrets are sealed");
    const [summary] = vault.roleSummaries("p1");
    assert.equal(summary.login.hasPassword, true);
    assert.equal(summary.login.hasTotp, true);
    assert.ok(!JSON.stringify(summary).includes("Pa55word!"));
    // Saved again without the password: it keeps the saved one.
    vault.saveRole("p1", { id: "staff", name: "Sales staff", login: { kind: "web", loginUrl: "https://crm.test/login", username: "s@b.in" } });
    assert.equal(vault.roles("p1")[0].login.password, "Pa55word!");
    assert.equal(vault.roles("p1")[0].name, "Sales staff");
    vault.deleteRole("p1", "staff");
    assert.equal(vault.roles("p1").length, 0);
  });

  it("keeps webhooks per project without login headers", () => {
    const hooks = new HookStore(new DatabaseSync(":memory:"));
    const token = hooks.open("p1");
    assert.equal(hooks.projectFor(token), "p1");
    hooks.add("p1", { method: "POST", path: `/hooks/${token}`, headers: { "content-type": "application/json", authorization: "Bearer secret", cookie: "a=b" }, body: '{"event":"lead.created"}' });
    const [m] = hooks.list("p1");
    assert.equal(m.body, '{"event":"lead.created"}');
    assert.ok(!m.headers.authorization && !m.headers.cookie);
    assert.match(hooks.inboxFor("p1")!.address, /\/hooks\//);
    assert.notEqual(hooks.open("p1", true), token, "a fresh address replaces the old one");
    assert.equal(hooks.projectFor(token), undefined);
  });
});

describe("full system test of a signed-in CRM", () => {
  let crm: DemoCrm;
  let dir: string;
  let result: ScanResult;
  const rules = () => new Map(result.findings.map((f) => [f.rule, f]));
  before(async () => {
    crm = await startDemoCrm(4252);
    dir = await mkdtemp(path.join(tmpdir(), "glv-crm-"));
    result = await scanSite({
      url: `${crm.base}/app`,
      maxPages: 20,
      product: "crm",
      artifactsDir: dir,
      agents: ["app.calls", "app.tables", "app.id-numbers", "app.csrf", "app.tokens", "app.access", "app.session", "app.user-enum", "app.private-pages"],
      login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_ADMIN.email, password: CRM_ADMIN.password, roleName: "Admin" },
      roles: [
        { id: "staff", name: "Sales staff", login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_STAFF.email, password: CRM_STAFF.password }, mustNotOpen: "/api/admin/*" },
        { id: "globex", name: "Other company", otherCompany: true, login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_OTHER.email, password: CRM_OTHER.password } },
      ],
    });
  });
  after(async () => {
    crm.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("finds every screen by clicking the menus, dropdowns and tabs, and tests each one", () => {
    const via = new Map((result.screens ?? []).map((s) => [new URL(s.url).hash || new URL(s.url).pathname, s]));
    for (const h of ["#/dashboard", "#/contacts", "#/deals", "#/reports/sales", "#/reports/team", "#/admin/users"]) assert.ok(via.get(h)?.tested, `${h} found and tested`);
    assert.equal(via.get("#/reports/sales")?.via, "Reports > Sales report");
    assert.deepEqual(via.get("#/contacts")?.parts, ["List", "Notes"]);
    assert.ok(result.pages.some((p) => p.url.endsWith("#/contacts/1")), "record screens linked from a list are tested");
  });

  it("never changes data: no POST, no Delete all, no sign-out of the main session", () => {
    assert.deepEqual(crm.changes, []);
    assert.ok(!crm.requested.includes("POST /api/contacts/wipe"));
  });

  it("draws the access grid and finds what roles and other companies should not get", () => {
    const r = rules();
    assert.equal(r.get("app:role-hidden-screen")?.pageUrl, `${crm.base}/app#/admin/users`);
    assert.match(r.get("app:role-forbidden-call")?.evidence ?? "", /\/api\/admin\/users/);
    assert.equal(r.get("app:other-company-record")?.severity, "critical");
    assert.equal(r.get("app:other-company-call")?.severity, "critical");
    const grid = result.access!;
    assert.deepEqual(grid.roles.map((x) => x.name), ["Admin", "Sales staff", "Other company", "No login"]);
    const users = grid.rows.find((x) => x.url.endsWith("#/admin/users"))!;
    assert.equal(users.cells.staff, "opens");
    assert.ok(!users.menuOf?.includes("staff"), "staff's menu has no Users");
    assert.equal(grid.rows.find((x) => x.url.endsWith("#/contacts/1"))!.cells.globex, "same-data");
    assert.equal(grid.rows.find((x) => x.url.endsWith("/api/stats"))!.cells.anon, "same-data");
  });

  it("checks the app's calls, session, tokens, forms, lists and ID numbers", () => {
    const r = rules();
    for (const rule of [
      "app:call-sends-secrets",
      "app:call-public",
      "app:token-in-storage",
      "app:jwt-not-signed",
      "app:jwt-no-expiry",
      "app:session-fixation",
      "app:long-session",
      "app:logout-keeps-session",
      "app:user-enumeration",
      "app:csrf-missing",
      "app:table-search-does-nothing",
      "app:csv-formula-injection",
      "app:id-numbers-shown",
    ]) {
      assert.ok(r.has(rule), `${rule} found`);
    }
    assert.ok(!JSON.stringify(result).includes(CRM_ADMIN.password) && !JSON.stringify(result).includes(CRM_STAFF.password));
    assert.ok(!(r.get("app:id-numbers-shown")?.evidence ?? "").includes("2345 6789"), "ID numbers are masked in the report");
    assert.ok(result.calls?.some((c) => c.url.endsWith("/api/stats") && c.anon === "same"));
  });
});

describe("sign-in with a two-step code, sign-in steps and role journeys", () => {
  let crm: DemoCrm;
  let dir: string;
  before(async () => {
    crm = await startDemoCrm(4253);
    dir = await mkdtemp(path.join(tmpdir(), "glv-crm-j-"));
  });
  after(async () => {
    crm.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("types the code made from the saved secret, and says what to do without one", async () => {
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const s = await signIn(ctx, { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_2FA.email, password: CRM_2FA.password, totpSecret: CRM_2FA.secret });
      assert.match(s.landedUrl, /\/app$/);
      const ctx2 = await browser.newContext();
      await assert.rejects(signIn(ctx2, { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_2FA.email, password: CRM_2FA.password }), (e: Error) => e instanceof LoginError && /two-step secret/.test(e.message));
      const ctx3 = await browser.newContext();
      const steps = await signIn(ctx3, {
        kind: "web",
        loginUrl: `${crm.base}/login`,
        username: CRM_2FA.email,
        password: CRM_2FA.password,
        totpSecret: CRM_2FA.secret,
        steps: "fill Email = {{username}}\nfill Password = {{password}}\nclick Sign in\nfill Code = {{code}}\nclick Verify\nsee Signed in as",
      });
      assert.match(steps.landedUrl, /\/app$/);
    } finally {
      await browser.close();
    }
  });

  it("runs a journey as a role, with clean-up steps and the app's calls on each step", async () => {
    const browser = await chromium.launch();
    try {
      const main = await browser.newContext();
      await signIn(main, { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_ADMIN.email, password: CRM_ADMIN.password });
      const { results, findings } = await runJourneys(
        main,
        [
          { id: "j1", name: "Staff sees contacts", steps: "open /app#/contacts\nsee Asha Verma\nnot see Users\nfill Search contacts = {{random}}", role: "staff", cleanup: "open /app#/dashboard\nsee Dashboard" },
          { id: "j2", name: "Admin opens users", steps: "open /app\nclick Users\nsee staff@acme.test\nsee Nobody here" },
        ],
        {
          startUrl: `${crm.base}/app`,
          artifactsDir: dir,
          loggedIn: true,
          roleSession: async () => {
            const ctx = await browser.newContext();
            const login = { kind: "web" as const, loginUrl: `${crm.base}/login`, username: CRM_STAFF.email, password: CRM_STAFF.password };
            await signIn(ctx, login);
            return { context: ctx, login, name: "Sales staff" };
          },
        },
      );
      assert.equal(results[0].ok, true, JSON.stringify(results[0].steps));
      assert.equal(results[0].role, "Sales staff");
      assert.equal(results[0].steps.filter((s) => s.cleanup).length, 2);
      assert.ok(results[0].steps[0].calls?.some((c) => c.url.endsWith("/api/contacts")), "the step shows the app's calls");
      assert.match(results[0].steps[3].text, /^fill Search contacts = glv/);
      assert.equal(results[1].ok, false);
      assert.match(findings[0].title, /Admin opens users" fails at step 4/);
    } finally {
      await browser.close();
    }
  });
});

describe("API: roles, webhook inbox, recorder", () => {
  let app: Awaited<ReturnType<typeof import("../src/server.js").createApp>>["app"];
  let stores: Awaited<ReturnType<typeof import("../src/server.js").createApp>>["stores"];
  let dataDir: string;
  before(async () => {
    process.env.AUTH_DISABLED = "1";
    dataDir = await mkdtemp(path.join(tmpdir(), "glv-crm-api-"));
    const { createApp } = await import("../src/server.js");
    ({ app, stores } = await createApp({ dataDir }));
    stores.projects.save({ id: "c1", key: "CRM", name: "CRM", type: "crm", target: { url: "https://crm.example.com/app" }, schedule: "off", createdAt: new Date().toISOString(), issueSeq: 0 });
  });
  after(async () => {
    delete process.env.AUTH_DISABLED;
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("needs the main login before roles, then keeps role secrets on the server", async () => {
    const first = await app.inject({ method: "POST", url: "/api/projects/c1/roles", payload: { name: "Staff", login: { username: "s@x.in", password: "Staff-123456" } } });
    assert.equal(first.statusCode, 400);
    assert.match(first.json().error, /main login first/);
    const main = await app.inject({ method: "PATCH", url: "/api/projects/c1", payload: { login: { kind: "web", loginUrl: "https://crm.example.com/login", username: "a@x.in", password: "Admin-123456", codeFrom: "totp", totpSecret: "JBSWY3DPEHPK3PXP" } } });
    assert.equal(main.statusCode, 200);
    assert.equal(main.json().login.hasTotp, true);
    assert.ok(!main.body.includes("JBSWY3DPEHPK3PXP"));
    const role = await app.inject({ method: "POST", url: "/api/projects/c1/roles", payload: { name: "Staff", login: { username: "s@x.in", password: "Staff-123456" }, mustNotOpen: "/admin" } });
    assert.equal(role.statusCode, 201);
    assert.equal(role.json().login.loginUrl, "https://crm.example.com/login");
    assert.ok(!role.body.includes("Staff-123456"));
    const detail = (await app.inject({ method: "GET", url: "/api/projects/c1" })).json();
    assert.equal(detail.project.roles.length, 1);
    assert.equal(stores.vault.roles("c1")[0].login.password, "Staff-123456");
    const del = await app.inject({ method: "DELETE", url: `/api/projects/c1/roles/${role.json().id}` });
    assert.equal(del.statusCode, 204);
    assert.equal(stores.vault.roles("c1").length, 0);
  });

  it("catches webhooks at the project's own address, without login, and only there", async () => {
    const opened = (await app.inject({ method: "POST", url: "/api/projects/c1/hooks", payload: {} })).json();
    const token = opened.address.split("/hooks/")[1];
    const sent = await app.inject({ method: "POST", url: `/hooks/${token}`, headers: { "content-type": "application/x-www-form-urlencoded", authorization: "Bearer x" }, payload: "event=lead.created&phone=919845011111" });
    assert.equal(sent.statusCode, 200);
    const json = await app.inject({ method: "POST", url: `/hooks/${token}`, headers: { "content-type": "application/json" }, payload: '{"event":"message.received"}' });
    assert.equal(json.statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/hooks/wrong-token-wrong-token-1234", payload: "x" })).statusCode, 404);
    const list = (await app.inject({ method: "GET", url: "/api/projects/c1/hooks" })).json();
    assert.deepEqual(list.messages.map((m: { body: string }) => m.body), ['{"event":"message.received"}', "event=lead.created&phone=919845011111"]);
    assert.ok(!list.messages[1].headers.authorization);
  });

  it("serves the step recorder extension", async () => {
    const r = await app.inject({ method: "GET", url: "/api/recorder/download" });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["content-type"], "application/zip");
    const { unzipSync } = await import("fflate");
    const files = Object.keys(unzipSync(new Uint8Array(r.rawPayload)));
    assert.ok(files.includes("glv-recorder/manifest.json") && files.includes("glv-recorder/content.js"), files.join(", "));
  });
});
