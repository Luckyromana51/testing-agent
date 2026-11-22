import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taintPaths, IAST_HOOK } from "../src/tools/p4-security.ts";
import { findRank, parseSearxng, parseGoogleCse, mentionsBrand, visibilityScore } from "../src/tools/p4-seo.ts";
import { fontProblems, deviceProfiles, profileProblems, fpsProblem, gameProblems } from "../src/tools/p4-device.ts";
import { validatePush, fcmBody, findingsToCsv, jiraIssueBody, linearIssueBody, parseScenarios, scenarioPass } from "../src/tools/p4-integrate.ts";
import { fixFor } from "../src/fixes.ts";
import { P4_FIXES } from "../src/fixes-p4.ts";

describe("wave 4: IAST taint scan", () => {
  it("flags request input into dangerous sinks", () => {
    const code = [
      "app.get('/x', (req, res) => {",
      "  eval(req.query.code);",
      "  child_process.exec(req.body.cmd);",
      "  db.query('select * from u where id = ' + req.params.id);",
      "});",
    ].join("\n");
    const hits = taintPaths(code, "a.js");
    assert.ok(hits.some((h) => h.rule === "iast:taint-eval"));
    assert.ok(hits.some((h) => h.rule === "iast:taint-exec"));
    assert.ok(hits.some((h) => h.rule === "iast:taint-sql"));
  });
  it("ignores lines with no source or no sink", () => {
    assert.equal(taintPaths("const x = eval('1+1');", "a.js").length, 0); // sink but no source
    assert.equal(taintPaths("const y = req.query.q;", "a.js").length, 0); // source but no sink
  });
  it("ships a runtime hook", () => {
    assert.ok(IAST_HOOK.includes("child_process") && IAST_HOOK.includes("GLV-IAST"));
  });
});

describe("wave 4: rank tracking", () => {
  it("finds a domain's position", () => {
    const results = [{ url: "https://other.com/a" }, { url: "https://www.glv.com/x" }];
    assert.equal(findRank(results, "glv.com"), 2);
    assert.equal(findRank(results, "missing.com"), 0);
    assert.equal(findRank([{ url: "https://sub.glv.com/x" }], "glv.com"), 1);
  });
  it("parses SearXNG and Google results", () => {
    assert.equal(parseSearxng({ results: [{ url: "https://a.com", title: "A" }] }).length, 1);
    assert.equal(parseGoogleCse({ items: [{ link: "https://a.com", title: "A" }] })[0].url, "https://a.com");
    assert.equal(parseSearxng({}).length, 0);
  });
});

describe("wave 4: AI visibility", () => {
  it("detects brand/domain mentions and scores coverage", () => {
    assert.equal(mentionsBrand("We recommend GLV Infotech.", "GLV Infotech", "glv.com"), true);
    assert.equal(mentionsBrand("Visit glv.com today.", "GLV", "glv.com"), true);
    assert.equal(mentionsBrand("No match here.", "GLV Infotech", "glv.com"), false);
    assert.equal(visibilityScore([true, false, true, false]), 50);
    assert.equal(visibilityScore([]), 0);
  });
});

describe("wave 4: device profiles & games", () => {
  it("has the device profiles and flags overflow / focus", () => {
    const profs = deviceProfiles();
    assert.ok(profs.some((p) => p.key === "androidtv" && p.remote));
    const tv = profs.find((p) => p.key === "androidtv")!;
    const probs = profileProblems(tv, { scrollWidth: 2200, viewportWidth: 1920, smallTargets: 3, focusVisible: false });
    assert.ok(probs.some((x) => x.rule === "screen:overflow"));
    assert.ok(probs.some((x) => x.rule === "screen:tiny-target"));
    assert.ok(probs.some((x) => x.rule === "screen:no-focus"));
  });
  it("flags missing fonts and low fps / webgl loss", () => {
    assert.ok(fontProblems({ Inter: true, "Segoe UI": false }).some((x) => x.rule === "winfont:missing"));
    assert.equal(fontProblems({ Inter: true }).length, 0);
    assert.equal(fpsProblem(15)?.rule, "game:low-fps");
    assert.equal(fpsProblem(60), null);
    const g = gameProblems({ hasCanvas: true, fps: 12, webglLost: true, jsErrors: 2 });
    assert.ok(g.some((x) => x.rule === "game:low-fps"));
    assert.ok(g.some((x) => x.rule === "game:webgl-lost"));
    assert.ok(g.some((x) => x.rule === "game:js-errors"));
  });
});

describe("wave 4: push / tracker / voice", () => {
  it("validates a push payload and builds the FCM body", () => {
    const bad = validatePush({ provider: "fcm", deviceToken: "", title: "", body: "" });
    assert.ok(bad.some((x) => x.rule === "push:bad-payload"));
    const ok = validatePush({ provider: "fcm", deviceToken: "a".repeat(20), title: "T", body: "B", deepLink: "app://x" });
    assert.equal(ok.length, 0);
    const body = fcmBody({ provider: "fcm", deviceToken: "tok", title: "T", body: "B", deepLink: "app://x" }) as { message: { data?: { screen: string } } };
    assert.equal(body.message.data?.screen, "app://x");
  });
  it("builds CSV and tracker issue bodies", () => {
    const csv = findingsToCsv([{ title: "Hole, big", severity: "high", rule: "r", pageUrl: "p", detail: 'say "hi"' }]);
    assert.ok(csv.split("\n").length === 2 && csv.includes('""hi""'));
    assert.equal((jiraIssueBody({ title: "T" }, "GLV") as { fields: { project: { key: string } } }).fields.project.key, "GLV");
    assert.equal((linearIssueBody({ title: "T" }, "team1") as { teamId: string }).teamId, "team1");
  });
  it("parses voice scenarios and checks replies", () => {
    const sc = parseScenarios("what are your hours => open | 9am\n# comment\nbook => booked");
    assert.equal(sc.length, 2);
    assert.deepEqual(sc[0].expect, ["open", "9am"]);
    assert.equal(scenarioPass("We are open from 9am", ["open", "9am"]), true);
    assert.equal(scenarioPass("Sorry, closed", ["open", "9am"]), false);
  });
});

describe("wave 4: every rule has a written fix", () => {
  it("each P4 rule resolves through fixFor", () => {
    for (const rule of Object.keys(P4_FIXES)) {
      const fix = fixFor({ rule, detail: "" });
      assert.ok(fix && fix.steps, `no fix for ${rule}`);
    }
  });
});
