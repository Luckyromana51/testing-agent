import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { ToolContext } from "../src/tools/types.ts";
import { readZapActive, ZAP_ACTIVE_OFF, ZAP_EXCLUDE, zapActiveTool } from "../src/tools/zap.ts";

/**
 * A stand-in for ZAP's API (the real ZAP runs in its own container, which this test machine does
 * not have): it records every call and answers like ZAP 2.17 does.
 */
async function fakeZap() {
  const calls: { path: string; params: Record<string, string> }[] = [];
  let polls = 0;
  const state = { refuseDisable: false };
  const alerts: Record<string, unknown> = {
    "11": { pluginId: "40018", name: "SQL Injection", risk: "High", confidence: "Medium", url: "http://shop.test/product?id=1+AND+1%3D1", param: "id", evidence: "", method: "GET", cweid: "89" },
    "12": { pluginId: "40012", name: "Cross Site Scripting (Reflected)", risk: "High", confidence: "Medium", url: "http://shop.test/search?q=%3Cscript%3E", param: "q", evidence: "<script>alert(1);</script>", method: "GET", cweid: "79" },
    "13": { pluginId: "40012", name: "Cross Site Scripting (Reflected)", risk: "High", confidence: "Low", url: "http://shop.test/about?x=1", param: "x", method: "GET" },
    "14": { pluginId: "90020", name: "Remote OS Command Injection", risk: "High", confidence: "Medium", url: "http://shop.test/ping?host=a", param: "host", method: "GET", cweid: "78" },
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://zap");
    const params = Object.fromEntries(u.searchParams.entries());
    calls.push({ path: u.pathname, params });
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-zap-api-key"] !== "test-key") return json({ message: "bad key" }, 400);
    switch (u.pathname) {
      case "/JSON/core/view/version/":
        return json({ version: "2.17.0" });
      case "/JSON/ascan/action/disableScanners/":
        return state.refuseDisable ? json({ code: "does_not_exist", message: "No scanner" }, 400) : json({ Result: "OK" });
      case "/JSON/ascan/action/scan/":
        return json({ scan: "7" });
      case "/JSON/ascan/view/status/":
        polls++;
        return json({ status: polls >= 2 ? "100" : "40" });
      case "/JSON/ascan/view/alertsIds/":
        return json({ alertsIds: Object.keys(alerts) });
      case "/JSON/alert/view/alert/":
        return json({ alert: alerts[params.id] });
      default:
        return json({ Result: "OK" });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, calls, state, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("ZAP active scan", () => {
  let zap: Awaited<ReturnType<typeof fakeZap>>;
  let dir: string;
  const env = { ZAP_URL: process.env.ZAP_URL, ZAP_API_KEY: process.env.ZAP_API_KEY };
  before(async () => {
    zap = await fakeZap();
    dir = await mkdtemp(path.join(tmpdir(), "glvzapa-"));
    process.env.ZAP_URL = zap.url;
    process.env.ZAP_API_KEY = "test-key";
  });
  after(async () => {
    zap.server.close();
    await rm(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({
    product: "website",
    target: { url: "http://shop.test/" },
    startUrl: "http://shop.test/",
    urls: ["http://shop.test/search?q=kurta", "http://shop.test/logout", "http://shop.test/product?id=1", "http://shop.test/cart/delete?id=3"],
    cookie: "sid=s3cret",
    uploadsDir: dir,
    options: { strength: "HIGH", minutes: "30" },
    outDir: dir,
    workDir: dir,
    signal: new AbortController().signal,
    log: () => {},
    permit: { hosts: ["shop.test"], maxUsers: 10, maxMinutes: 15, writes: false },
    ...o,
  });

  it("scans only the opened pages with GET, in a bounded policy, and cleans up after itself", async () => {
    assert.equal(await zapActiveTool.ready(), null);
    const out = await zapActiveTool.run(ctx());
    const paths = zap.calls.map((c) => c.path);
    const find = (p: string) => zap.calls.find((c) => c.path === p)?.params;

    // The policy: the chosen strength, and the out-of-band and memory rules switched off.
    assert.deepEqual(find("/JSON/ascan/action/addScanPolicy/"), { scanPolicyName: "glv-attack", alertThreshold: "MEDIUM", attackStrength: "HIGH" });
    assert.equal(find("/JSON/ascan/action/disableScanners/")?.ids, ZAP_ACTIVE_OFF.join(","));
    // Bounded by the permission (15 minutes), not the 30 asked for.
    assert.equal(find("/JSON/ascan/action/setOptionMaxScanDurationInMins/")?.Integer, "15");
    assert.equal(find("/JSON/ascan/action/setOptionThreadPerHost/")?.Integer, "2");
    assert.equal(find("/JSON/ascan/action/excludeFromScan/")?.regex, ZAP_EXCLUDE);
    // The signed-in session goes along, and is removed at the end.
    assert.equal(find("/JSON/replacer/action/addRule/")?.replacement, "sid=s3cret");
    assert.ok(paths.includes("/JSON/replacer/action/removeRule/"));
    assert.equal(paths.filter((p) => p === "/JSON/core/action/newSession/").length, 2);
    assert.equal(paths.filter((p) => p === "/JSON/ascan/action/removeScanPolicy/").length, 2, "the old policy before, this one after");

    // Only the opened pages, never sign-out or delete links, and no spider.
    const opened = zap.calls.filter((c) => c.path === "/JSON/core/action/accessUrl/").map((c) => c.params.url);
    assert.deepEqual(opened, ["http://shop.test/", "http://shop.test/search?q=kurta", "http://shop.test/product?id=1"]);
    assert.ok(!paths.some((p) => p.includes("/spider/") || p.includes("/ajaxSpider/")));
    assert.deepEqual(find("/JSON/ascan/action/scan/"), { url: "http://shop.test/", recurse: "true", inScopeOnly: "false", scanPolicyName: "glv-attack", method: "GET" });

    // Only this scan's alerts, without the low-confidence one.
    assert.deepEqual(out.findings.map((f) => f.rule).sort(), ["zap:40012", "zap:40018", "zap:90020"]);
    const xss = out.findings.find((f) => f.rule === "zap:40012")!;
    assert.equal(xss.key, "xss:http://shop.test/search:q");
    assert.equal(xss.pageUrl, "http://shop.test/search");
    assert.equal(out.findings.find((f) => f.rule === "zap:90020")!.key, undefined);
    const saved = JSON.parse(await readFile(path.join(dir, "tool-zap-active.json"), "utf8")) as unknown[];
    assert.equal(saved.length, 4);
  });

  it("does not scan when ZAP will not switch the dangerous rules off", async () => {
    zap.calls.length = 0;
    zap.state.refuseDisable = true;
    try {
      await assert.rejects(zapActiveTool.run(ctx()));
      const paths = zap.calls.map((c) => c.path);
      assert.ok(!paths.includes("/JSON/ascan/action/scan/"), "no active scan started");
      assert.ok(!paths.includes("/JSON/core/action/accessUrl/"), "no page opened");
      // It still cleans up after itself.
      assert.ok(paths.includes("/JSON/replacer/action/removeRule/"));
      assert.equal(paths.at(-1), "/JSON/core/action/newSession/");
    } finally {
      zap.state.refuseDisable = false;
    }
  });

  it("runs only with the client's permission", async () => {
    await assert.rejects(zapActiveTool.run(ctx({ permit: undefined })), /only with the client's permission/);
  });

  it("keeps one finding per rule, page and parameter", () => {
    const a = { pluginId: "40018", name: "SQL Injection", risk: "High", confidence: "High", url: "http://x/p?id=1", param: "id" };
    const f = readZapActive([a, { ...a, url: "http://x/p?id=2" }, { ...a, param: "cat" }, { ...a, risk: "Informational" }]);
    assert.deepEqual(f.map((x) => `${x.title} ${x.key}`), ["SQL Injection (id) sqli:http://x/p:id", "SQL Injection (cat) sqli:http://x/p:cat"]);
  });
});
