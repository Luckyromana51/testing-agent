import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { groupFindings, issueKey } from "../src/group.js";
import { syncIssues } from "../src/issues.js";
import { scanSite } from "../src/runner/scan.js";
import { medianRun, readLighthouseRuns } from "../src/tools/lighthouse.js";
import { readVnu } from "../src/tools/vnu.js";
import type { Finding, Issue, Project, Run } from "../src/types.js";
import { CRM_ADMIN, CRM_OTHER, CRM_STAFF, startDemoCrm, type DemoCrm } from "./fixtures/demo-crm.js";

// The demo sites run on this computer, which real tests block.
process.env.ALLOW_PRIVATE_TARGETS = "1";

/**
 * Lucky tested glvinfotechsolutions.com twice, an hour apart, with nothing changed on the site,
 * and got 153 then 164 issues ("13 new, 2 fixed"). These tests pin down each cause.
 */

const f = (rule: string, title: string, pageUrl = "https://a.in/", agent = "web.x", severity: Finding["severity"] = "medium"): Finding => ({
  id: Math.random().toString(36),
  rule,
  title,
  detail: "",
  severity,
  category: "accessibility",
  pageUrl,
  agent,
});

describe("one problem keeps one issue key, whatever the numbers say", () => {
  it("ignores counts, plurals, is/are and measured units", () => {
    const same = (a: string, b: string, rule = "r") => assert.equal(issueKey({ rule, title: a }), issueKey({ rule, title: b }), `${a} / ${b}`);
    same("1 focused item is hidden behind a fixed bar", "8 focused items are hidden behind a fixed bar");
    same("Text is drawn over other text in 1 place on a phone", "Text is drawn over other text in 2 places on a phone");
    same("Main content takes 6.7 s to appear (LCP)", "Main content takes 4.8 s to appear (LCP)");
    same("Total Blocking Time is 20,480 ms (Lighthouse, phone)", "Total Blocking Time is 470 ms (Lighthouse, phone)");
    same("Reduce unused CSS (Est savings of 25 KiB)", "Reduce unused CSS (Est savings of 140 KiB)");
    same("Layout jumps while loading (CLS 0.18)", "Layout jumps while loading (CLS 0.3)");
    same("Text is cut off when spacing is widened (5 places)", "Text is cut off when spacing is widened (1 place)");
    assert.notEqual(issueKey({ rule: "r", title: "Images have no alt text" }), issueKey({ rule: "r", title: "Links have no text" }));
    assert.notEqual(issueKey({ rule: "a", title: "Same" }), issueKey({ rule: "b", title: "Same" }));
  });

  it("groups them as one issue in the report and the score", () => {
    const g = groupFindings([
      f("axe:focus", "1 focused item is hidden behind a fixed bar", "https://a.in/1"),
      f("axe:focus", "8 focused items are hidden behind a fixed bar", "https://a.in/2"),
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].pages.length, 2);
  });
});

describe("repeat runs of an unchanged site", () => {
  const project: Project = { id: "p", key: "GC", name: "GLV", type: "website", target: { url: "https://a.in/" }, schedule: "off", createdAt: "", issueSeq: 0 };
  const pages = ["https://a.in/", "https://a.in/b", "https://a.in/c"];
  const run = (id: string, findings: Finding[], extra: Partial<Run> = {}, result: Partial<NonNullable<Run["result"]>> = {}): Run => ({
    id,
    url: "https://a.in/",
    status: "done",
    createdAt: id,
    progress: [],
    agents: ["web.x", "web.speed"],
    ...extra,
    result: {
      startUrl: "https://a.in/",
      startedAt: "",
      finishedAt: "",
      pages: pages.map((url) => ({ url, status: 200, title: "", loadMs: 1000 })),
      scores: {},
      overallScore: 80,
      findings,
      ...result,
    },
  });
  const step = (state: { project: Project; issues: Issue[] }, r: Run, previous?: Run) => {
    const s = syncIssues(state.project, r, state.issues, undefined, previous);
    const byId = new Map(state.issues.map((i) => [i.id, i]));
    for (const i of [...s.created, ...s.changed]) byId.set(i.id, i);
    return { project: s.project, issues: [...byId.values()], diff: s.diff };
  };

  it("finds nothing new and nothing fixed when only the numbers moved", () => {
    const r1 = run("1", [f("web.focus", "8 focused items are hidden behind a fixed bar"), f("perf:lcp", "Main content takes 6.7 s to appear (LCP)", pages[1], "web.speed")]);
    const r2 = run("2", [f("web.focus", "1 focused item is hidden behind a fixed bar"), f("perf:lcp", "Main content takes 4.8 s to appear (LCP)", pages[1], "web.speed")]);
    let st = step({ project, issues: [] }, r1);
    assert.equal(st.diff.new, 2);
    st = step(st, r2, r1);
    assert.deepEqual({ new: st.diff.new, fixed: st.diff.fixed, reopened: st.diff.reopened, open: st.diff.open }, { new: 0, fixed: 0, reopened: 0, open: 2 });
  });

  it("merges issues saved under the old key into one, without calling anything fixed", () => {
    const old = (n: number, title: string): Issue => ({
      id: `i${n}`,
      key: `GC-${n}`,
      projectId: "p",
      fingerprint: `web.focus|${title.replace(/\d+(\.\d+)?/g, "#")}`,
      rule: "web.focus",
      agent: "web.x",
      title,
      detail: "",
      category: "accessibility",
      severity: "medium",
      status: "open",
      occurrences: [{ pageUrl: pages[0] }],
      firstSeenRunId: "0",
      lastSeenRunId: "0",
      firstSeenAt: "",
      lastSeenAt: "",
      updatedAt: "",
      history: [],
    });
    const issues = [old(5, "1 focused item is hidden behind a fixed bar"), old(6, "8 focused items are hidden behind a fixed bar")];
    const st = step({ project: { ...project, issueSeq: 6 }, issues }, run("3", [f("web.focus", "3 focused items are hidden behind a fixed bar")]));
    assert.equal(st.diff.new, 0);
    assert.equal(st.diff.fixed, 0);
    assert.equal(st.diff.open, 1);
    const kept = st.issues.find((i) => i.key === "GC-5")!;
    const merged = st.issues.find((i) => i.key === "GC-6")!;
    assert.equal(kept.status, "open");
    assert.equal(kept.fingerprint, issueKey(kept));
    assert.equal(merged.mergedInto, "GC-5");
    assert.equal(merged.status, "verified");
    assert.match(merged.history.at(-1)!.text, /Merged into GC-5/);
  });

  it("says when new issues come from a check that did not finish last time", () => {
    const tls = f("testssl:cbc", "The server offers obsolete CBC ciphers", pages[0], "tool.testssl", "low");
    const r1 = run("1", [], { tools: [{ id: "testssl" }] }, { agentStats: [{ id: "tool.testssl", name: "testssl.sh", category: "security", findings: 0, ms: 1, errors: 1, runs: 1, untested: "stopped after 7 minutes" }] });
    const r2 = run("2", [tls], { tools: [{ id: "testssl" }] });
    let st = step({ project, issues: [] }, r1);
    st = step(st, r2, r1);
    assert.equal(st.diff.new, 1);
    assert.equal(st.diff.firstChecked, 1);
  });

  it("does not call a tool's issue fixed on a page the tool did not check this time", () => {
    const html = f("html:error", "HTML error: Stray end tag div", pages[2], "tool.vnu", "low");
    const r1 = run("1", [html], { tools: [{ id: "vnu" }] });
    // The W3C checker could not download page c this time.
    const r2 = run("2", [], { tools: [{ id: "vnu" }] }, { tools: [{ id: "vnu", name: "W3C", status: "done", ms: 1, findings: 0, checked: [pages[0], pages[1]] }] });
    let st = step({ project, issues: [] }, r1);
    st = step(st, r2, r1);
    assert.equal(st.diff.fixed, 0);
    assert.equal(st.issues[0].status, "open");
    // When it did check the page and the error is gone, it is fixed.
    const r3 = run("3", [], { tools: [{ id: "vnu" }] }, { tools: [{ id: "vnu", name: "W3C", status: "done", ms: 1, findings: 0, checked: pages }] });
    st = step(st, r3, r2);
    assert.equal(st.diff.fixed, 1);
  });
});

describe("outside tools give the same answer on the same site", () => {
  it("W3C checker: one issue for every CSS rule of the same kind, in page order", () => {
    const msg = (page: number, sel: string) => ({
      type: "error" as const,
      url: `file:/x/page-${page}.html`,
      message: `Style rule “${sel}” not allowed outside an “@scope” rule in a “style” element in “body”.`,
      lastLine: 3,
      extract: "<style>",
    });
    const pageOf = (u: string) => ({ "page-1.html": "https://a.in/", "page-2.html": "https://a.in/b" })[u.split("/").pop()!];
    const a = readVnu([msg(2, ".x"), msg(1, ".glv-staff-link"), msg(1, ".glv-person-card")], pageOf, ["https://a.in/", "https://a.in/b"]);
    const b = readVnu([msg(1, ".glv-person-card"), msg(2, ".y"), msg(1, ".glv-staff-intro")], pageOf, ["https://a.in/", "https://a.in/b"]);
    assert.equal(a.length, 2);
    assert.deepEqual(
      a.map((x) => `${x.pageUrl} ${x.title}`),
      b.map((x) => `${x.pageUrl} ${x.title}`),
    );
    assert.equal(a[0].pageUrl, "https://a.in/");
    assert.equal(a[0].title, 'HTML error: Style rule not allowed outside an "@scope" rule in a "style" element in "body".');
    assert.match(a[0].evidence!, /glv-staff-link/);
  });

  it("Lighthouse: keeps the middle run, and only tips most runs agree on", () => {
    const lhr = (score: number, tbt: number, tip: boolean) => ({
      categories: { performance: { title: "Performance", score, auditRefs: [{ id: "total-blocking-time", weight: 30, group: "metrics" }, ...(tip ? [{ id: "unused-css-rules", weight: 0 }] : [])] } },
      audits: {
        "total-blocking-time": { id: "total-blocking-time", title: "Total Blocking Time", score: tbt > 600 ? 0.2 : 0.6, scoreDisplayMode: "numeric", displayValue: `${tbt} ms` },
        ...(tip ? { "unused-css-rules": { id: "unused-css-rules", title: "Reduce unused CSS", score: 0.5, scoreDisplayMode: "metricSavings", details: { overallSavingsMs: 150 } } } : {}),
      },
    });
    const runs = [lhr(0.3, 20480, false), lhr(0.7, 470, true), lhr(0.6, 520, false)];
    assert.equal(medianRun(runs).categories.performance.score, 0.6);
    const read = readLighthouseRuns(runs, "https://a.in/", "phone");
    assert.deepEqual(read.findings.map((x) => x.title), ["Total Blocking Time is 520 ms (Lighthouse, phone)"]);
  });
});

/** A page with things that move by themselves: a CSS animation, a ticker run by a script, a slider. */
const siteState = { redesigned: false };
function startMovingSite(): Promise<{ server: Server; base: string }> {
  const page = (title: string, links: string) => `<!doctype html><html lang="en"><head><title>${title}</title>
<style>
  body { font-family: sans-serif; margin: 0; }
  header { position: sticky; top: 0; background: #123; color: #fff; padding: 16px; }
  .spin { width: 60px; height: 60px; background: #c33; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .slide { width: 600px; height: 200px; font-size: 48px; color: #fff; display: flex; align-items: center; justify-content: center; }
  a:focus { outline: 4px solid orange; }
</style></head><body>
<header><nav>${links}</nav></header>
<main><h1>${title}</h1>
<div class="spin"></div>
<p>Visitors online: <b id="tick">0</b></p>
<div class="slide" id="slide" style="background:#264">Slide 1</div>
<p>Plain text that never moves.</p>
${siteState.redesigned ? '<div style="height:160px;background:#fc0;font-size:40px">New banner</div>' : ""}
<button onclick="document.getElementById('menu').hidden=false">Open menu</button><div id="menu" hidden>Menu items</div>
</main>
<script>
  var n = 0; setInterval(function () { document.getElementById('tick').textContent = String(++n * 7); }, 150);
  // Like a real slider seen at a random moment: which slide shows differs from run to run.
  var colours = ['#264', '#642', '#246'];
  function next() { var s = Math.floor(Math.random() * 3); var el = document.getElementById('slide'); el.style.background = colours[s]; el.textContent = 'Slide ' + (s + 1); setTimeout(next, 100 + Math.random() * 300); }
  next();
</script></body></html>`;
  const links = '<a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a>';
  const server = createServer((req, res) => {
    const name = req.url === "/about" ? "About" : req.url === "/contact" ? "Contact" : req.url === "/" ? "Home" : "";
    if (!name) {
      res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><title>Not found</title><p>Not found</p>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(page(name, links));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok({ server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

describe("scanning the same site twice gives the same issues and score", () => {
  let dir: string;
  let site: { server: Server; base: string };
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "repeat-"));
    site = await startMovingSite();
  });
  after(async () => {
    site.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("same issue keys, same score, and no picture differences on pages that move by themselves", { timeout: 240_000 }, async () => {
    const baselineDir = path.join(dir, "baselines");
    const scan = (n: number) =>
      scanSite({ url: `${site.base}/`, maxPages: 3, parallel: 3, artifactsDir: path.join(dir, `run${n}`), baselineDir });
    const keys = (r: Awaited<ReturnType<typeof scan>>) =>
      groupFindings(r.findings.filter((x) => x.severity !== "info" && !x.rule.startsWith("perf:") && x.rule !== "slow-page"))
        .map((g) => `${g.key} @${g.pages.length}`)
        .sort();
    const first = await scan(1);
    const second = await scan(2);
    assert.deepEqual(second.pages.map((p) => p.url), first.pages.map((p) => p.url), "the same pages, in the same order");
    assert.deepEqual(keys(second), keys(first));
    assert.equal(second.overallScore, first.overallScore);
    const visual = second.findings.filter((x) => x.rule === "visual:changed");
    assert.deepEqual(visual.map((x) => `${x.pageUrl} ${x.detail}`), [], "nothing on the page changed");
    for (const p of second.pages) assert.equal(p.visual?.desktop?.status, "same", p.url);

    // A real change is still seen.
    siteState.redesigned = true;
    const third = await scan(3);
    assert.equal(third.findings.filter((x) => x.rule === "visual:changed" && x.title.includes("desktop")).length, 3);
  });
});

describe("the CRM / SaaS test gives the same result twice", () => {
  let dir: string;
  let crm: DemoCrm;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "repeat-crm-"));
    crm = await startDemoCrm(4254);
  });
  after(async () => {
    crm.server.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("same issues, same score, same access grid, signed in with several screens at once", { timeout: 600_000 }, async () => {
    const scan = (n: number) =>
      scanSite({
        url: `${crm.base}/app`,
        maxPages: 20,
        parallel: 4,
        product: "crm",
        artifactsDir: path.join(dir, `run${n}`),
        baselineDir: path.join(dir, "baselines"),
        login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_ADMIN.email, password: CRM_ADMIN.password, roleName: "Admin" },
        roles: [
          { id: "staff", name: "Sales staff", login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_STAFF.email, password: CRM_STAFF.password }, mustNotOpen: "/api/admin/*" },
          { id: "globex", name: "Other company", otherCompany: true, login: { kind: "web", loginUrl: `${crm.base}/login`, username: CRM_OTHER.email, password: CRM_OTHER.password } },
        ],
      });
    const keys = (r: Awaited<ReturnType<typeof scan>>) =>
      groupFindings(r.findings.filter((x) => x.severity !== "info" && !x.rule.startsWith("perf:") && x.rule !== "slow-page" && x.rule !== "app:call-slow"))
        .map((g) => `${g.key} @${g.pages.length}`)
        .sort();
    const first = await scan(1);
    const second = await scan(2);
    assert.deepEqual(second.pages.map((p) => p.url), first.pages.map((p) => p.url), "the same screens, in the same order");
    assert.deepEqual(keys(second), keys(first));
    assert.equal(second.overallScore, first.overallScore);
    assert.deepEqual(second.access, first.access, "the same access grid");
    assert.deepEqual(second.calls?.map((c) => `${c.method} ${c.url}`), first.calls?.map((c) => `${c.method} ${c.url}`), "the same app calls, in the same order");
  });
});
