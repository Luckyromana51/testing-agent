import { chromium } from "playwright";
const OUT = "/mnt/project-files/testing-agent/screenshots/v2";
const BASE = "http://localhost:4320";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
const shot = async (name, full = false) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log("shot", name);
};
const waitRun = async () => {
  await page.waitForSelector(".overall-num, .error.big", { timeout: 400_000 });
};

await page.goto(BASE);
await page.waitForSelector(".auth-card");
await shot("01-first-start-owner-account");
await page.fill('input[autocomplete="name"]', "Lucky");
await page.fill('input[type="email"]', "owner@glv.example");
await page.fill('input[type="password"]', "glv-demo-password");
await page.click("button.primary");
await page.waitForSelector(".product-grid");
await shot("02-pick-product-type");

// Real site: website test
await page.click(".product-card:has-text('Website')");
await page.waitForSelector("form.card");
await page.fill("form.card input >> nth=0", "https://glvinfotechsolutions.com/");
await page.fill("form.card input >> nth=1", "GLV Infotech website");
await page.fill('form.card input[type="number"]', "15");
await shot("03-new-website-test");
await page.click("form.card button.primary");
await page.waitForSelector(".progress-card");
await shot("04-test-running");
await waitRun();
await shot("05-report-major-issues-first", true);

// Demo store with deliberate bugs
await page.goto(`${BASE}/#/new/ecommerce`);
await page.waitForSelector("form.card");
await page.fill("form.card input >> nth=0", "http://127.0.0.1:4101/");
await page.fill("form.card input >> nth=1", "Demo shop (test site with bugs)");
await page.fill('form.card input[type="number"]', "8");
await page.click("form.card button.primary");
await waitRun();
await shot("06-demo-store-report", true);
const runUrl = page.url();
const projectId = await page.getAttribute("a.back", "href").then((h) => h.replace("#/project/", ""));

// Developer marks the exposed .env as fixed without fixing it, then re-tests.
await page.goto(`${BASE}/#/issues?project=${projectId}`);
await page.waitForSelector(".issue-card");
await page.click(".issue-card:has-text('.env')");
await page.waitForSelector(".drawer-title");
await page.click(".status-actions button:has-text('Mark fixed')");
await page.waitForSelector(".status-fixed");
await page.fill(".comment-form textarea", "Blocked .env in .htaccess, please re-test");
await page.click(".comment-form button");
await page.waitForTimeout(500);
await shot("07-issue-marked-fixed");
await page.click(".status-actions button:has-text('Re-test now')");
await waitRun();
await shot("08-retest-report-with-comparison");
await page.goto(`${BASE}/#/issues?project=${projectId}`);
await page.waitForSelector(".came-back");
await shot("09-issue-board-regression", true);
await page.click(".issue-card:has-text('.env')");
await page.waitForSelector(".timeline");
await shot("10-issue-history-came-back");

await page.goto(`${BASE}/#/project/${projectId}`);
await page.waitForSelector(".table");
await shot("11-project-page", true);
await page.goto(`${BASE}/#/projects`);
await page.waitForSelector(".project-card");
await shot("12-projects");
await page.goto(`${BASE}/#/owner`);
await page.waitForSelector(".tile");
await shot("13-owner-overview");
await page.goto(`${BASE}/#/owner/agents`);
await page.waitForSelector(".agent-row");
await shot("14-owner-agents", true);
await page.goto(`${BASE}/#/owner/team`);
await page.waitForSelector(".user-list li");
await shot("15-owner-team");

// Phone width check
const phone = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await phone.addCookies(await ctx.cookies());
const p2 = await phone.newPage();
await p2.goto(`${BASE}/#/`);
await p2.waitForSelector(".product-grid");
await p2.screenshot({ path: `${OUT}/16-phone-home.png` });
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("phone overflow", overflow);
await b.close();
