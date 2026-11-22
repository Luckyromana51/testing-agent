import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { cleanChoices } from "../src/tools/index.ts";
import { attackTool, enabledFamilies } from "../src/tools/attack/index.ts";
import { chainFindings } from "../src/tools/attack/chain.ts";
import { deserializeMarker } from "../src/tools/attack/exposed.ts";
import { analyzeJwt, b64url, findJwts } from "../src/tools/attack/session.ts";
import { parseCookies } from "../src/tools/attack/surface.ts";
import type { AttackFinding } from "../src/tools/attack/types.ts";
import type { ToolContext, ToolOutput } from "../src/tools/types.ts";
import type { Permission } from "../src/permission.ts";
import { startAttackSite, type AttackSite } from "./fixtures/attack-site.ts";

process.env.ALLOW_PRIVATE_TARGETS = "1";

const ENDPOINTS = ["net/ping?host=8.8.8.8", "greet?name=Guest", "members?user=alice", "redir?to=/home", "profile?id=10", "fetch?url=https://example.com/logo.png", "account", "api/me"];

/** A JWT signed with a weak secret and no expiry, so the session check has something to find. */
function weakJwt(): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = b64url(Buffer.from(JSON.stringify({ sub: "10", name: "alice", role: "user" })));
  const sig = createHmac("sha256", "secret").update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

async function attack(site: AttackSite, dir: string, cookie: string | undefined, families?: string): Promise<ToolOutput> {
  const ctx: ToolContext = {
    product: "webapp",
    target: { url: site.url },
    startUrl: site.url,
    urls: ENDPOINTS.map((p) => site.url + p),
    ...(cookie ? { cookie } : {}),
    uploadsDir: dir,
    options: { minutes: "3", ...(families ? { families } : {}) },
    outDir: dir,
    workDir: dir,
    signal: new AbortController().signal,
    log: () => {},
    permit: { hosts: [site.host], maxUsers: 10, maxMinutes: 10, writes: false },
  };
  return attackTool.run(ctx);
}

describe("GLV attack agent", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glvattack-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("confirms every planted hole and chains them, GET only and nothing that changes data", { timeout: 180_000 }, async () => {
    const site = await startAttackSite("planted");
    try {
      const cookie = `sid=good; token=${weakJwt()}; data=rO0ABXNyAA1jb20uYWNtZS5Vc2Vy`;
      const out = await attack(site, dir, cookie);
      const rules = [...new Set(out.findings.map((f) => f.rule))].sort();
      assert.deepEqual(rules, [
        "attack:chain",
        "attack:command-injection",
        "attack:cors-misconfiguration",
        "attack:crlf-injection",
        "attack:deserialization-surface",
        "attack:exposed-file",
        "attack:host-header-injection",
        "attack:idor",
        "attack:jwt",
        "attack:nosql-injection",
        "attack:ssrf",
        "attack:template-injection",
      ]);

      const by = (rule: string) => out.findings.filter((f) => f.rule === rule);
      assert.equal(by("attack:command-injection")[0].severity, "critical");
      assert.equal(by("attack:template-injection")[0].severity, "critical");
      assert.equal(by("attack:ssrf")[0].severity, "critical");
      assert.equal(by("attack:idor")[0].severity, "high");
      assert.equal(by("attack:cors-misconfiguration")[0].severity, "high");
      assert.equal(by("attack:nosql-injection")[0].severity, "high");
      assert.equal(by("attack:crlf-injection")[0].severity, "high");
      assert.equal(by("attack:host-header-injection")[0].severity, "medium");
      // Exposed: both the .git config and the .env (critical) are found.
      assert.ok(by("attack:exposed-file").some((f) => f.pageUrl.endsWith("/.env") && f.severity === "critical"));
      assert.ok(by("attack:exposed-file").some((f) => f.pageUrl.endsWith("/.git/config")));
      // JWT: weak secret (critical) and no expiry (medium), read offline.
      assert.ok(by("attack:jwt").some((f) => f.severity === "critical" && /guessable secret/i.test(f.title)));
      assert.ok(by("attack:jwt").some((f) => f.severity === "medium" && /never expires/i.test(f.title)));
      assert.equal(by("attack:deserialization-surface")[0].severity, "medium");

      // Every finding carries evidence, a how-to-reproduce and a how-to-fix line.
      for (const f of out.findings) {
        assert.ok(f.evidence && f.evidence.length > 0, `${f.rule} has evidence`);
        if (f.rule !== "attack:chain") {
          assert.match(f.detail, /How to reproduce:/, `${f.rule} says how to reproduce`);
          assert.match(f.detail, /How to fix:/, `${f.rule} says how to fix`);
        }
      }
      // The chain finding joins them into one critical attack path.
      assert.equal(by("attack:chain")[0].severity, "critical");
      assert.match(by("attack:chain")[0].detail, /confirmed holes/);

      // Safety: only GET, and no payload that deletes or changes data.
      assert.ok(site.requests.every((r) => r.method === "GET" || r.method === "HEAD"), "only GET");
      const sent = site.requests.map((r) => decodeURIComponent(r.url.replace(/\+/g, " ")));
      assert.ok(!sent.some((u) => /\b(DROP|DELETE|UPDATE|INSERT|TRUNCATE|ALTER)\b/i.test(u)), "no data-changing SQL");
    } finally {
      await site.close();
    }
  });

  it("finds nothing on the same site built safely", { timeout: 120_000 }, async () => {
    const site = await startAttackSite("clean");
    try {
      const out = await attack(site, dir, "sid=good");
      assert.deepEqual(out.findings, [], out.findings.map((f) => f.rule).join(", "));
      assert.ok(site.requests.every((r) => r.method === "GET" || r.method === "HEAD"));
    } finally {
      await site.close();
    }
  });

  it("runs only the attacks left on", { timeout: 60_000 }, async () => {
    const site = await startAttackSite("planted");
    try {
      const out = await attack(site, dir, "sid=good", "ssrf,cors");
      const rules = new Set(out.findings.map((f) => f.rule));
      assert.ok(rules.has("attack:ssrf"));
      assert.ok(rules.has("attack:cors-misconfiguration"));
      assert.ok(!rules.has("attack:template-injection"), "SSTI was turned off");
      assert.ok(!rules.has("attack:idor"), "IDOR was turned off");
    } finally {
      await site.close();
    }
  });

  it("needs the client's permission", async () => {
    await assert.rejects(attackTool.run({ permit: undefined, options: {} } as unknown as ToolContext), /only with the client's written permission/);
  });

  it("reads JSON Web Tokens offline", () => {
    const none = `${b64url(Buffer.from('{"alg":"none"}'))}.${b64url(Buffer.from('{"sub":"1"}'))}.`;
    const noneReport = analyzeJwt(none);
    assert.ok(noneReport.some((r) => r.severity === "critical" && /not signed/i.test(r.title)));

    const weak = analyzeJwt(weakJwt());
    assert.ok(weak.some((r) => r.severity === "critical" && /guessable/i.test(r.title)), "guessable secret");
    assert.ok(weak.some((r) => /never expires/i.test(r.title)), "no expiry");

    // A strong random secret is not guessed, and a sensible expiry is not flagged.
    const h = b64url(Buffer.from('{"alg":"HS256","typ":"JWT"}'));
    const p = b64url(Buffer.from(JSON.stringify({ sub: "1", exp: Math.floor(Date.now() / 1000) + 3600 })));
    const strong = `${h}.${p}.${b64url(createHmac("sha256", "f8e2b1c9a7d4e6f0b3c5a9d2e4f6a8b0c1d3e5f7").update(`${h}.${p}`).digest())}`;
    assert.deepEqual(analyzeJwt(strong), []);

    assert.deepEqual(findJwts(`sid=good; auth=${weakJwt()}; other=1`), [weakJwt()]);
    assert.deepEqual(findJwts("sid=plainvalue; x=1"), []);
  });

  it("spots serialized-object data", () => {
    assert.match(deserializeMarker("rO0ABXNyAA1jb20uYWNtZS5Vc2Vy") ?? "", /Java/);
    assert.match(deserializeMarker('O:4:"User":1:{s:2:"id";i:1;}') ?? "", /PHP/);
    assert.match(deserializeMarker("gANjX19tYWluX18KVXNlcgpxAA==") ?? "", /Python/);
    assert.equal(deserializeMarker("just-a-normal-session-id-12345"), undefined);
    assert.equal(deserializeMarker("abc"), undefined);
  });

  it("parses cookies and the family toggle list", () => {
    assert.deepEqual(parseCookies("a=1; b=two; c="), [{ name: "a", value: "1" }, { name: "b", value: "two" }]);
    assert.deepEqual(parseCookies(undefined), []);
    assert.equal(enabledFamilies(undefined).length, 11);
    assert.deepEqual(enabledFamilies("ssrf,cors").map((f) => f.id), ["cors", "ssrf"]);
    assert.deepEqual(enabledFamilies("").map((f) => f.id), []);
  });

  it("chains two or more confirmed holes, never just one", () => {
    const make = (rule: string, tag: AttackFinding["tag"], severity: AttackFinding["severity"]): AttackFinding => ({ rule, tag, severity, title: rule, detail: "", pageUrl: "https://x/" + rule, evidence: "", key: rule });
    assert.deepEqual(chainFindings([make("attack:ssrf", "ssrf", "critical")]), []);
    const chained = chainFindings([make("attack:ssrf", "ssrf", "critical"), make("attack:exposed-file", "injection", "high")]);
    assert.equal(chained.length, 1);
    assert.equal(chained[0].severity, "critical");
    assert.match(chained[0].detail, /2 separate holes/);
  });

  it("accepts the family toggles through cleanChoices and rejects an unknown one", () => {
    const permission = { id: "p1", kinds: ["attack"], revokedAt: undefined, until: new Date(Date.now() + 86_400_000).toISOString(), maxUsers: 10, maxMinutes: 30 } as unknown as Permission;
    const ok = cleanChoices("webapp", [{ id: "glv-attack", options: { families: "ssrf, cors ,ssrf" } }], [permission]);
    assert.deepEqual(ok, [{ id: "glv-attack", options: { families: "ssrf,cors" } }]);
    assert.throws(() => cleanChoices("webapp", [{ id: "glv-attack", options: { families: "ssrf,made-up" } }], [permission]), /not a choice/);
  });
});
