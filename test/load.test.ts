import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { csvFields, failureKind, jmeterTool, readResults } from "../src/tools/jmeter.ts";
import { checkPlan, parseXml } from "../src/tools/jmx.ts";
import { k6Script, k6Tool, labels, phases, readK6 } from "../src/tools/k6.ts";
import { breakingStep, loadFindings, loadSummary, loadTable, type LoadResult, type LoadStep } from "../src/tools/load.ts";
import { which } from "../src/tools/process.ts";
import type { ToolContext } from "../src/tools/types.ts";
import { jmxPlan } from "./fixtures/jmx.ts";

const n = (o: Partial<LoadStep> & Pick<LoadStep, "name" | "role" | "users">): LoadStep => ({
  seconds: 60,
  requests: 1000,
  failed: 0,
  rps: 16.7,
  avg: 200,
  p50: 180,
  p95: 400,
  max: 900,
  ...o,
});

const result = (o: Partial<LoadResult>): LoadResult => ({
  tool: "k6",
  profile: "load",
  users: 50,
  seconds: 300,
  steps: [],
  pages: [{ url: "https://shop.example.com/", requests: 1000, failed: 0, rps: 3, avg: 200, p50: 180, p95: 400, max: 900 }],
  total: { requests: 3000, failed: 0, rps: 10, avg: 200, p50: 180, p95: 400, max: 900 },
  failures: {},
  api: false,
  ...o,
});

const rules = (r: LoadResult) => loadFindings(r, "https://shop.example.com/").map((f) => `${f.rule}:${f.severity}`);

describe("load test shapes and verdicts", () => {
  it("plans each shape's phases to fill the time", () => {
    const load = phases("load", 50, 300);
    assert.deepEqual(load.map((p) => [p.key, p.users, p.seconds, p.start]), [
      ["rampup", 50, 60, 0],
      ["hold", 50, 180, 60],
      ["rampdown", 0, 60, 240],
    ]);
    assert.deepEqual(phases("stress", 100, 300).map((p) => p.users), [20, 40, 60, 80, 100]);
    assert.deepEqual(phases("stress", 3, 30).map((p) => p.users), [1, 2, 3]);
    assert.deepEqual(phases("spike", 200, 100).map((p) => [p.role, p.users, p.seconds]), [
      ["base", 20, 30],
      ["spike", 200, 20],
      ["recovery", 20, 50],
    ]);
    const soak = phases("soak", 30, 3600);
    assert.equal(soak.reduce((a, p) => a + p.seconds, 0), 3600);
    assert.ok(soak.every((p) => p.users === 30));
  });

  it("writes a k6 script that only reads, never follows redirects and reports each phase and page", () => {
    const urls = ["https://shop.example.com/", "https://shop.example.com/search?q=a,b c"];
    const names = labels(urls);
    assert.deepEqual([...names.values()], ["/", "/search?q=a_b%20c"]);
    const script = k6Script({ urls, phases: phases("stress", 10, 50), pause: 1, cookie: "sid=abc", summaryFile: "/tmp/s.json", stopAtFailRate: 0.5 });
    assert.match(script, /http\.get\(/);
    assert.doesNotMatch(script, /http\.(post|put|patch|del|request)\(/);
    assert.match(script, /maxRedirects: 0/);
    assert.match(script, /"Cookie":"sid=abc"/);
    assert.match(script, /"http_req_duration\{scenario:step3\}":\["max>=0"\]/);
    assert.match(script, /"http_req_failed\{scenario:step1\}":\[\{"threshold":"rate<0\.5","abortOnFail":true/);
    assert.match(script, /"http_req_duration\{name:\/search\?q=a_b%20c\}"/);
  });

  it("reads k6's summary into steps, pages and failures", () => {
    const plan = phases("stress", 10, 50);
    const m = (p95: number, failed: number, ok: number) => ({
      dur: { values: { avg: p95 / 2, med: p95 / 3, "p(95)": p95, max: p95 * 2 } },
      fail: { values: { passes: failed, fails: ok, rate: failed / (failed + ok) }, thresholds: { "rate<0.5": { ok: failed / (failed + ok) < 0.5 } } },
    });
    const metrics: Record<string, unknown> = {
      http_req_duration: m(500, 0, 0).dur,
      http_req_failed: { values: { passes: 100, fails: 300 } },
      glv_5xx: { values: { count: 100 } },
    };
    // Step 3: more than half failed, so k6 stopped the test there.
    const steps = [m(50, 0, 100), m(60, 0, 120), m(900, 100, 80)];
    plan.slice(0, 3).forEach((p, i) => {
      metrics[`http_req_duration{scenario:${p.key}}`] = steps[i].dur;
      metrics[`http_req_failed{scenario:${p.key}}`] = steps[i].fail;
    });
    const r = readK6({ metrics: metrics as never, state: { testRunDurationMs: 31_000 } }, { profile: "stress", phases: plan, urls: ["https://a.example/"], users: 10, api: false });
    assert.deepEqual(r.steps.map((s) => [s.users, s.requests, s.failed, s.seconds]), [
      [2, 100, 0, 10],
      [4, 120, 0, 10],
      [6, 180, 100, 10],
      [8, 0, 0, 1],
      [10, 0, 0, 0],
    ]);
    assert.equal(r.total.requests, 400);
    assert.equal(r.failures["5xx"], 100);
    assert.match(r.stoppedEarly ?? "", /Step 3/);
    assert.equal(breakingStep(r)?.step.users, 6);
    assert.deepEqual(loadTable(r).rows[4], ["Step 5", "10", "0", "–", "–", "–", "not reached"]);
  });

  it("judges errors, slowness, the breaking point, recovery and slow decline, and stays quiet on a healthy site", () => {
    const healthy = result({ steps: [n({ name: "Steady", role: "hold", users: 50 })] });
    assert.deepEqual(rules(healthy), []);
    assert.deepEqual(rules(result({ steps: [n({ name: "Steady", role: "hold", users: 50, failed: 20 })] })), ["load:errors:medium"]);
    assert.deepEqual(rules(result({ steps: [n({ name: "Steady", role: "hold", users: 50, failed: 80 })] })), ["load:errors:high"]);
    assert.deepEqual(rules(result({ steps: [n({ name: "Steady", role: "hold", users: 50, failed: 300 })] })), ["load:errors:critical"]);
    // Ramp steps do not count: only the steady part of a load test is judged.
    assert.deepEqual(rules(result({ steps: [n({ name: "Ramp up", role: "ramp", users: 50, failed: 500 }), n({ name: "Steady", role: "hold", users: 50 })] })), []);
    assert.deepEqual(rules(result({ steps: [n({ name: "Steady", role: "hold", users: 50, p95: 4200 })] })), ["load:slow:medium"]);
    assert.deepEqual(rules(result({ api: true, steps: [n({ name: "Steady", role: "hold", users: 50, p95: 1500 })] })), ["load:slow:medium"]);
    assert.deepEqual(rules(result({ steps: [n({ name: "Steady", role: "hold", users: 50, p95: 9000 })] })), ["load:slow:high"]);

    const stress = (steps: LoadStep[]) => result({ profile: "stress", steps });
    assert.deepEqual(rules(stress([n({ name: "Step 1", role: "step", users: 20 }), n({ name: "Step 2", role: "step", users: 40 })])), []);
    assert.deepEqual(rules(stress([n({ name: "Step 1", role: "step", users: 20 }), n({ name: "Step 2", role: "step", users: 40, failed: 60 })])), ["load:breaking-point:high"]);
    assert.deepEqual(rules(stress([n({ name: "Step 1", role: "step", users: 20 }), n({ name: "Step 2", role: "step", users: 40, p95: 5000 })])), ["load:breaking-point:medium"]);
    assert.deepEqual(rules(stress([n({ name: "Step 1", role: "step", users: 20, p95: 3500 }), n({ name: "Step 2", role: "step", users: 40, p95: 3600 })])), ["load:slow:medium"]);
    const broke = loadFindings(stress([n({ name: "Step 1", role: "step", users: 20 }), n({ name: "Step 2", role: "step", users: 40, failed: 60 })]), "https://x/")[0];
    assert.equal(broke.title, "The site starts failing at about 40 users");
    assert.match(loadSummary(stress([n({ name: "Step 1", role: "step", users: 20 }), n({ name: "Step 2", role: "step", users: 40 })])).join(" "), /Handled up to 40 users without breaking/);

    const spike = (after: Partial<LoadStep>, during: Partial<LoadStep> = {}) =>
      result({
        profile: "spike",
        steps: [n({ name: "Before", role: "base", users: 5 }), n({ name: "Rush", role: "spike", users: 50, ...during }), n({ name: "After", role: "recovery", users: 5, ...after })],
      });
    assert.deepEqual(rules(spike({})), []);
    assert.deepEqual(rules(spike({ p95: 1500 })), ["load:spike-recovery:medium"]);
    assert.deepEqual(rules(spike({}, { failed: 100 })), ["load:errors:high"]);

    const soak = (last: Partial<LoadStep>) =>
      result({ profile: "soak", steps: [n({ name: "First", role: "third", users: 30 }), n({ name: "Middle", role: "third", users: 30 }), n({ name: "Last", role: "third", users: 30, ...last })] });
    assert.deepEqual(rules(soak({ p95: 450 })), []);
    assert.deepEqual(rules(soak({ p95: 900 })), ["load:degrades:medium"]);

    const tooMany = loadFindings(result({ failures: { "429": 40, "5xx": 2 }, steps: [n({ name: "Steady", role: "hold", users: 50, failed: 42 })] }), "https://x/")[0];
    assert.match(tooMany.detail, /firewall or rate limit stopped the test/);
    assert.match(tooMany.evidence ?? "", /40 "too many requests" \(429\), 2 server errors/);
  });
});

describe("JMeter plan check", () => {
  const limits = { hosts: ["shop.example.com"], maxUsers: 20, maxMinutes: 10, writes: false };
  const plan = (o: Partial<Parameters<typeof jmxPlan>[0]> = {}) => jmxPlan({ host: "shop.example.com", port: 443, ...o }).replace(/<stringProp name="HTTPSampler.protocol">http</g, '<stringProp name="HTTPSampler.protocol">https<');
  const problems = (xml: string, l = limits) => checkPlan(xml, l).problems.join("\n");

  it("passes a plain plan and lists its requests", () => {
    const ok = checkPlan(plan({ threads: 5, requests: [["GET", "/"], ["GET", "/search?q=kurta"]] }), limits);
    assert.deepEqual(ok.problems, []);
    assert.equal(ok.users, 5);
    assert.deepEqual(ok.requests, ["GET https://shop.example.com/", "GET https://shop.example.com/search?q=kurta"]);
    assert.deepEqual(checkPlan(plan({ defaults: true }), limits).problems, []);
  });

  it("refuses code, files, other sites, writes and plans over the limits", () => {
    const script = `<JSR223Sampler guiclass="TestBeanGUI" testclass="JSR223Sampler" testname="Prepare"><stringProp name="script">new File('/etc/passwd').text</stringProp></JSR223Sampler>`;
    assert.match(problems(plan({ extra: [script] })), /"Prepare" \(JSR223Sampler\) runs Groovy or JavaScript on GLV's server/);
    // The tag decides what JMeter makes, whatever testclass says.
    assert.match(problems(plan({ extra: [script.replace('testclass="JSR223Sampler"', 'testclass="ConstantTimer"')] })), /says it is ConstantTimer but is JSR223Sampler/);
    assert.match(problems(plan({ extra: [`<org.apache.jmeter.protocol.java.sampler.JSR223Sampler testname="x"/>`] })), /is not one of the parts GLV allows/);
    assert.match(problems(plan({ requests: [["GET", "/?a=${__groovy(1+1)}"]] })), /function __groovy/);
    // An XML escape (&#36; is "$") does not hide a function.
    assert.match(problems(plan({ requests: [["GET", "/?a=HIDDEN"]] }).replace("HIDDEN", "&#36;{__javaScript(1)}")), /function __javaScript/);
    assert.deepEqual(checkPlan(plan({ requests: [["GET", "/?n=${__Random(1,9)}&t=${__time()}"]] }), limits).problems, []);
    assert.match(problems(plan({ extra: [`<CSVDataSet guiclass="TestBeanGUI" testclass="CSVDataSet" testname="Users"><stringProp name="filename">/data/users.csv</stringProp></CSVDataSet>`] })), /reads files on GLV's server/);
    assert.match(problems(plan({ extra: [`<BackendListener guiclass="BackendListenerGui" testclass="BackendListener" testname="Influx"/>`] })), /sends the results to another service/);
    assert.match(problems(plan({ host: "other.example.com" })), /sends to other\.example\.com, which the client's permission does not cover/);
    assert.match(problems(plan({ requests: [["GET", "https://evil.example.com/x"]] })), /sends to evil\.example\.com/);
    assert.match(problems(plan({ requests: [["POST", "/cart"]] })), /sends POST, which can create or change the client's data/);
    assert.deepEqual(checkPlan(plan({ requests: [["POST", "/cart"]] }), { ...limits, writes: true }).problems, []);
    assert.match(problems(plan({ inRequest: `<boolProp name="HTTPSampler.image_parser">true</boolProp>` })), /Retrieve All Embedded Resources/);
    assert.match(problems(plan({ inRequest: `<stringProp name="HTTPSampler.proxyHost">10.0.0.5</stringProp>` })), /goes through a proxy/);
    assert.match(
      problems(plan({ inRequest: `<elementProp name="HTTPsampler.Files" elementType="HTTPFileArgs"><collectionProp name="HTTPFileArgs.files"><elementProp name="/root/.ssh/id_rsa" elementType="HTTPFileArg"><stringProp name="File.path">/root/.ssh/id_rsa</stringProp></elementProp></collectionProp></elementProp>` })),
      /uploads a file from GLV's server/,
    );
    assert.match(problems(plan({ threads: 50 })), /runs 50 users at once; the client allows 20/);
    assert.match(problems(plan({ scheduler: { duration: 1200 } })), /runs for 20 minutes; the client allows 10/);
    assert.match(problems(plan({ extra: [`<IfController guiclass="IfControllerPanel" testclass="IfController" testname="If"><stringProp name="IfController.condition">true</stringProp></IfController>`] })), /runs its condition as JavaScript/);
    assert.match(problems(plan().replace('<stringProp name="filename"></stringProp>', '<stringProp name="filename">/app/dist/server.js</stringProp>')), /writes results to a file on GLV's server/);
    assert.match(problems(plan().replace('elementType="LoopController"', 'elementType="JSR223Sampler"')), /holds a JSR223Sampler value/);
    assert.match(problems(plan().replace('class="SampleSaveConfiguration"', 'class="java.lang.ProcessBuilder"')), /holds a java\.lang\.ProcessBuilder object/);
    assert.match(problems(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><jmeterTestPlan/>`), /DOCTYPE/);
    assert.match(problems("<html><body>not a plan</body></html>"), /not a JMeter test plan/);
  });

  it("follows User Defined Variables, but not names that change while the plan runs", () => {
    const withVars = (host: string, extra = "") =>
      plan({ host: "${server}", extra: extra ? [extra] : [] }).replace(
        '<collectionProp name="Arguments.arguments"/>',
        `<collectionProp name="Arguments.arguments"><elementProp name="server" elementType="Argument"><stringProp name="Argument.name">server</stringProp><stringProp name="Argument.value">${host}</stringProp></elementProp></collectionProp>`,
      );
    assert.deepEqual(checkPlan(withVars("shop.example.com"), limits).problems, []);
    assert.match(problems(withVars("evil.example.com")), /sends to evil\.example\.com/);
    const extractor = `<RegexExtractor guiclass="RegexExtractorGui" testclass="RegexExtractor" testname="Find"><stringProp name="RegexExtractor.refname">server</stringProp></RegexExtractor>`;
    assert.match(problems(withVars("shop.example.com", extractor)), /only known while the plan runs/);
    assert.deepEqual(checkPlan(plan({ threads: "${__P(users,5)}" as unknown as number }), limits).users, 5);
  });

  it("reads XML strictly", () => {
    const x = parseXml(`<?xml version="1.0"?><a k="1 &amp; 2"><!-- note --><b>x &lt; y</b><c><![CDATA[<raw>]]></c><d/></a>`);
    const a = x.children[0];
    assert.equal(a.attrs.k, "1 & 2");
    assert.deepEqual(a.children.map((c) => [c.tag, c.text]), [["b", "x < y"], ["c", "<raw>"], ["d", ""]]);
    assert.throws(() => parseXml("<a><b></a>"), /broken/);
    assert.throws(() => parseXml("<a>"), /cut off/);
  });
});

describe("JMeter results", () => {
  it("splits quoted CSV fields and sorts failures by kind", () => {
    assert.deepEqual(csvFields('1,"a, b","say ""hi""",,x'), ["1", "a, b", 'say "hi"', "", "x"]);
    assert.equal(failureKind("503", false), "5xx");
    assert.equal(failureKind("429", false), "429");
    assert.equal(failureKind("404", false), "4xx");
    assert.equal(failureKind("200", false), "assertion");
    assert.equal(failureKind("200", true), undefined);
    assert.equal(failureKind("Non HTTP response code: java.net.SocketTimeoutException", false), "timeout");
    assert.equal(failureKind("Non HTTP response code: org.apache.http.conn.HttpHostConnectException", false), "connection");
  });

  it("reads a results file into steps and pages, leaving out transaction summaries", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glvjtl-"));
    try {
      const head = "timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect";
      const rows: string[] = [];
      const t0 = 1_763_400_000_000;
      for (let i = 0; i < 100; i++) {
        const fail = i % 10 === 0;
        rows.push(`${t0 + i * 300},${fail ? 2000 : 100 + i},Home,${fail ? 500 : 200},"OK, fine",Users 1-1,text,${!fail},,500,100,4,4,https://shop.example.com/,50,0,10`);
      }
      rows.push(`${t0 + 100},900,Checkout journey,200,"Number of samples in transaction : 3, number of failing samples : 0",Users 1-1,,true,,0,0,4,4,null,0,0,0`);
      const file = path.join(dir, "r.csv");
      await writeFile(file, [head, ...rows].join("\n"));
      const r = await readResults(file, { api: false });
      assert.equal(r.total.requests, 100);
      assert.equal(r.total.failed, 10);
      assert.equal(r.failures["5xx"], 10);
      assert.equal(r.users, 4);
      assert.equal(r.pages.length, 1);
      assert.ok(r.steps.length >= 3 && r.steps.length <= 10, String(r.steps.length));
      assert.equal(r.steps.reduce((a, s) => a + s.requests, 0), 100);
      assert.deepEqual(rules(r), ["load:errors:high"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A site that slows down past 8 requests at once and fails its shop page past 12. */
async function busySite() {
  let active = 0;
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    active++;
    const busy = active;
    setTimeout(
      () => {
        active--;
        if (req.url?.startsWith("/fail") || (busy > 12 && req.url?.startsWith("/shop"))) {
          res.writeHead(503);
          return res.end("busy");
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<h1>ok</h1>");
      },
      busy > 8 ? 300 : 15,
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, seen, port, url: `http://127.0.0.1:${port}/`, host: `127.0.0.1:${port}` };
}

const context = (dir: string, site: { url: string; host: string }, options: Record<string, string>, urls: string[] = []): ToolContext => ({
  product: "website",
  target: { url: site.url },
  startUrl: site.url,
  urls,
  uploadsDir: dir,
  options,
  outDir: dir,
  workDir: dir,
  signal: new AbortController().signal,
  log: () => {},
  permit: { hosts: [site.host], maxUsers: 30, maxMinutes: 5, writes: false },
});

describe("load tools on a real server", () => {
  let site: Awaited<ReturnType<typeof busySite>>;
  let dir: string;
  before(async () => {
    site = await busySite();
    dir = await mkdtemp(path.join(tmpdir(), "glvload-"));
  });
  after(async () => {
    site.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("k6 finds the breaking point of a stress test, with GET only", async (t) => {
    if (!(await which(process.env.K6_PATH || "k6"))) return t.skip("k6 is not installed here");
    site.seen.length = 0;
    const out = await k6Tool.run(context(dir, site, { profile: "stress", users: "25", minutes: "0.5", pause: "0" }, [`${site.url}shop?page=2`, `${site.url}about`]));
    const broke = out.findings.find((f) => f.rule === "load:breaking-point");
    assert.ok(broke, JSON.stringify(out.summary));
    // The shop fails past 12 requests at once: steps of 5, 10, 15, 20 and 25 users break at 15.
    assert.match(broke.title, /starts failing at about 15 users/);
    assert.equal(out.table?.rows.length, 5);
    assert.ok(site.seen.length > 500);
    assert.ok(site.seen.every((s) => s.startsWith("GET ")), "k6 only reads");
    assert.ok(out.reports?.some((r) => r.file === "tool-k6-report.html"));
    const saved = JSON.parse(await readFile(path.join(dir, "tool-k6.json"), "utf8")) as LoadResult;
    assert.equal(saved.profile, "stress");
  });

  it("k6 keeps within the permission even when asked for more", async (t) => {
    if (!(await which(process.env.K6_PATH || "k6"))) return t.skip("k6 is not installed here");
    const ctx = context(dir, site, { profile: "load", users: "1000", minutes: "0.5", pause: "1" });
    ctx.permit = { ...ctx.permit!, maxUsers: 3 };
    const out = await k6Tool.run(ctx);
    assert.match(out.summary?.[0] ?? "", /up to 3 users/);
    await assert.rejects(k6Tool.run({ ...ctx, permit: undefined }), /only with the client's permission/);
  });

  it("JMeter runs a checked plan and reports its failures", async (t) => {
    if (!(await which(process.env.JMETER_PATH || "jmeter"))) return t.skip("JMeter is not installed here");
    site.seen.length = 0;
    const id = "11111111-2222-3333-4444-555555555555.jmx";
    await writeFile(path.join(dir, id), jmxPlan({ host: "127.0.0.1", port: site.port, threads: 3, loops: 10, requests: [["GET", "/"], ["GET", "/about"], ["GET", "/fail"]] }));
    const out = await jmeterTool.run(context(dir, site, { plan: id, "plan:name": "shop.jmx" }));
    assert.equal(site.seen.length, 90);
    assert.ok(site.seen.every((s) => s.startsWith("GET ")));
    const errors = out.findings.find((f) => f.rule === "load:errors");
    assert.ok(errors);
    assert.equal(errors.title, "33.3% of requests failed under load");
    assert.match(out.tested ?? "", /shop\.jmx: 3 requests in the plan, up to 3 users/);

    // A plan that sends elsewhere never starts.
    const bad = "22222222-2222-3333-4444-555555555555.jmx";
    await writeFile(path.join(dir, bad), jmxPlan({ host: "127.0.0.2", port: site.port }));
    site.seen.length = 0;
    await assert.rejects(jmeterTool.run(context(dir, site, { plan: bad })), /cannot run: .*127\.0\.0\.2/);
    assert.equal(site.seen.length, 0);
  });
});
