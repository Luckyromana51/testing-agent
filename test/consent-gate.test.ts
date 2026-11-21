import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { chromium, type Browser } from "playwright";
import { consentGateAgent } from "../src/agents/web/consent.js";
import type { PageContext } from "../src/agents/types.js";
import { exploreApp } from "../src/app/explore.js";
import { RunGate } from "../src/control.js";
import { normaliseUrl } from "../src/runner/urls.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";

/**
 * A team app like GLV Team: one page that switches screens with the word after the #
 * (#home, #work, #connect), a bottom menu that stays on screen on a phone, and a chat screen that
 * blocks until the policy is accepted. ?gate=covered puts the "I agree" button at the end of a long
 * policy, under the bottom menu; ?gate=none shows only "Try again".
 */
const APP = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Team</title>
<style>body{margin:0;font:16px sans-serif} nav.bottom{position:fixed;left:0;right:0;bottom:0;height:64px;background:#fff;border-top:1px solid #ccc;display:flex;z-index:5}
nav.bottom button{flex:1} main{padding:16px} .policy p{margin:0 0 24px}</style></head><body>
<main id="main"></main>
<nav class="bottom" aria-label="Main menu">
  <button class="nav-item" data-route="home">Home</button><button class="nav-item" data-route="work">Work</button>
  <button class="nav-item" data-route="time">My time</button><button class="nav-item" data-route="connect">Chat</button>
</nav>
<script>
var gate = new URLSearchParams(location.search).get("gate") || "covered";
function render() {
  var r = (location.hash.replace("#", "").split("?")[0]) || "home";
  var m = document.getElementById("main");
  if (r === "connect") {
    var policy = "";
    for (var i = 0; i < 30; i++) policy += "<p>Do not post harassment, threats or spam. Rule " + (i + 1) + ".</p>";
    m.innerHTML = '<h1>Chat &amp; calls</h1><section class="gate"><h2>Connecting to your team</h2><p>Read and accept the communication policy before posting or calling.</p><button id="retry">Try again</button>' +
      (gate === "none" ? "" : '<div class="policy">' + policy + '<button id="agree" style="position:relative;top:0">I agree to the communication policy</button></div>') + "</section>";
    if (gate === "covered") {
      // The last thing on the page sits exactly under the bottom menu, as with no padding at the bottom.
      document.body.style.paddingBottom = "0";
    }
  } else m.innerHTML = "<h1>" + r + "</h1><p>The " + r + " screen.</p>";
}
document.querySelectorAll("nav.bottom button").forEach(function (b) { b.onclick = function () { location.hash = b.dataset.route; }; });
addEventListener("hashchange", render);
render();
</script></body></html>`;

/** A page with #section anchors: those are places on the page, not screens. */
const ANCHORS = `<!doctype html><html><body><nav><button onclick="location.hash='pricing'">Pricing</button><button onclick="location.hash='faq'">FAQ</button></nav>
<h2 id="pricing">Pricing</h2><p>...</p><h2 id="faq">FAQ</h2><p>...</p></body></html>`;

let server: http.Server;
let base = "";
let browser: Browser;

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url?.startsWith("/anchors") ? ANCHORS : APP);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server.close(r));
});

async function gateFindings(query: string) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 664 } });
  const page = await ctx.newPage();
  const url = `${base}/${query}#connect`;
  await page.goto(url);
  const findings = await consentGateAgent.run({ page, url } as unknown as PageContext);
  await ctx.close();
  return findings;
}

describe("apps that switch screens by # and block on a policy", () => {
  it("the explorer tests each #screen of a hash-routed app as its own screen", async () => {
    const ctx = await browser.newContext();
    const logs: string[] = [];
    const screens = await exploreApp(ctx, `${base}/?gate=covered#home`, { log: (m) => logs.push(m), maxMs: 30_000 });
    await ctx.close();
    const hashes = screens.map((s) => new URL(s.url).hash).sort();
    for (const h of ["#connect", "#home", "#time", "#work"]) assert.ok(hashes.includes(h), `found ${h} (got ${hashes.join(", ")})`);
    assert.ok(logs.some((l) => /changes screens with the address after #/.test(l)));
    // Once known, the crawler keeps those addresses apart too.
    assert.notEqual(normaliseUrl(`${base}/#work`), normaliseUrl(`${base}/#home`));
  });

  it("a # that points at a place on the page stays one page", async () => {
    const ctx = await browser.newContext();
    const anchors = `http://localhost:${new URL(base).port}/anchors`;
    const screens = await exploreApp(ctx, anchors, { maxMs: 20_000 });
    await ctx.close();
    assert.equal(screens.length, 1, screens.map((s) => s.url).join(", "));
    assert.equal(normaliseUrl(`${anchors}#faq`), anchors);
  });

  it("reports an accept button hidden under the phone's bottom menu, without pressing it", async () => {
    const f = await gateFindings("?gate=covered");
    const covered = f.find((x) => x.rule === "ui:consent-button-covered");
    assert.ok(covered, f.map((x) => x.rule).join(", "));
    assert.match(covered.title, /I agree to the communication policy/);
    assert.match(covered.evidence ?? "", /nav/);
    assert.ok(f.some((x) => x.rule === "ui:consent-gate" && x.severity === "info"));
    assert.ok(!f.some((x) => x.rule === "ui:consent-no-button"));
  });

  it("reports a policy screen with no button to accept, only Try again", async () => {
    const f = await gateFindings("?gate=none");
    const none = f.find((x) => x.rule === "ui:consent-no-button");
    assert.ok(none, f.map((x) => x.rule).join(", "));
    assert.match(none.evidence ?? "", /Try again/);
  });

  it("says nothing on screens without a policy gate", async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 664 } });
    const page = await ctx.newPage();
    await page.goto(`${base}/#work`);
    assert.deepEqual(await consentGateAgent.run({ page, url: page.url() } as unknown as PageContext), []);
    await ctx.close();
  });

  it("Skip says there is nothing to skip once the pages are done", () => {
    const gate = new RunGate();
    gate.pageStarted(0);
    gate.pageEnded(0);
    assert.equal(gate.skip(), false);
  });
});
