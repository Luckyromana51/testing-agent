import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { HANDBOOK, moduleOf } from "./handbook.js";
import type { ProductType, Project } from "./types.js";

/*
 * Manual testing: checklists a person works through by hand. Each case has steps and what should
 * happen; the tester marks it passed, failed or skipped, adds a note and screenshots, and a failed
 * case can go to the issue board. A "round" is one pass through the checklist (one build, one
 * tester), kept so results can be compared over time.
 *
 * The checklist is built from three places: written cases for the product type, the project's own
 * features (journeys, scenarios, sign-in, roles), and every testing type of the handbook for the
 * product. Every case is on unless the tester turns it off.
 */

export type ManualStatus = "pass" | "fail" | "skip";
export const MANUAL_STATUSES: ManualStatus[] = ["pass", "fail", "skip"];

export interface ManualCase {
  /** Stable, so results line up across rounds: lib.*, hb.*, journey.*, scenario.*, own.* ... */
  id: string;
  /** The group it is listed under. */
  section: string;
  title: string;
  steps: string[];
  /** What should happen when it works. */
  expected: string;
  /** Where the case came from. */
  source: "written" | "project" | "handbook" | "own";
  /** Do these first. */
  key?: boolean;
  /** The automatic checks that also cover it, when there are some. */
  alsoAuto?: string;
}

export interface ManualResult {
  status: ManualStatus;
  note?: string;
  /** Screenshot file names, inside the round's folder. */
  shots?: string[];
  at: string;
  by: string;
  /** Issue key, when the failure was sent to the issue board. */
  issue?: string;
}

export interface ManualRound {
  id: string;
  projectId: string;
  name: string;
  tester: string;
  /** Build, version or release being tested. */
  build?: string;
  /** Browser, device or environment. */
  env?: string;
  createdAt: string;
  finishedAt?: string;
  /** The cases as they were when the round started, so later edits do not change old rounds. */
  cases: ManualCase[];
  results: Record<string, ManualResult>;
}

export interface ManualSettings {
  /** Cases turned off. Everything else is on. */
  off?: string[];
  /** Cases the team wrote themselves. */
  own?: ManualCase[];
}

export interface RoundCounts {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  todo: number;
}

const PUBLIC: ProductType[] = ["website", "ecommerce"];
const APP: ProductType[] = ["webapp", "saas", "crm"];
const WEB: ProductType[] = [...PUBLIC, ...APP];
const MOBILE: ProductType[] = ["android", "ios"];

interface Written {
  slug: string;
  section: string;
  title: string;
  for: ProductType[];
  steps: string[];
  expected: string;
  key?: boolean;
  auto?: string;
}

const W: Written[] = [];
let sec = "";
const group = (name: string) => (sec = name);
const w = (slug: string, products: ProductType[], title: string, steps: string[], expected: string, o: { key?: boolean; auto?: string } = {}) =>
  W.push({ slug, section: sec, title, for: products, steps, expected, ...o });

group("First look");
w("smoke-open", WEB, "The start page opens", ["Open the address in a fresh browser window.", "Wait until the page stops loading."], "The page shows its real content within a few seconds, with no error message, blank area or broken picture.", { key: true, auto: "Page load and error checks" });
w("smoke-main-pages", WEB, "Every main menu page opens", ["Click each item in the main menu, one by one.", "Use the browser's Back button after each one."], "Each page opens with its own content and a title that matches the menu item.", { key: true, auto: "Link checks" });
w("smoke-footer", PUBLIC, "Footer links work", ["Scroll to the bottom of the start page.", "Open each footer link (contact, privacy, terms, social pages)."], "Every link opens the right page; social links open the company's own profiles.");
w("smoke-app-open", MOBILE, "The app opens", ["Install the build on a test phone.", "Open it from the home screen."], "The app opens to its first screen within a few seconds, without crashing or a blank screen.", { key: true });
w("smoke-app-tabs", MOBILE, "Every main screen opens", ["Tap each tab or menu item in turn.", "Go back after each one."], "Each screen shows its content; nothing freezes or closes the app.", { key: true });

group("Navigation and links");
w("nav-back", WEB, "Back and forward buttons behave", ["Open three pages in a row.", "Press Back twice, then Forward once."], "You land on the pages you visited, in order, with no lost form data warnings you did not expect.", { auto: "Back and forward check" });
w("nav-search", WEB, "Search finds things", ["Search for a word you know is on the site.", "Search for nonsense, like qzxv.", "Search with an empty box."], "Real words give matching results; nonsense says nothing was found; an empty search does not break the page.", { auto: "Search check" });
w("nav-404", WEB, "A wrong address shows a helpful page", ["Add /this-page-does-not-exist to the address and open it."], "A friendly 'page not found' page with a way back to the start page, not a server error.");
w("nav-new-tab", WEB, "Links to other sites open safely", ["Click a link to another website."], "It opens where expected; the site's own page stays usable.");

group("Forms");
w("form-happy", WEB, "Each form sends with good data", ["Fill every form (contact, sign-up, quote) with correct details.", "Send it."], "A clear thank-you or success message; the details arrive where they should (email or the system).", { key: true, auto: "Form checks" });
w("form-empty", WEB, "Required fields are checked", ["Send each form with every field empty."], "The form stays, with a clear message next to each required field. Nothing is sent.", { auto: "Form field checks" });
w("form-bad", WEB, "Wrong values are refused politely", ["Type an email without @, letters in a phone field, a date in the past where it must be future.", "Send."], "Each wrong field says what is wrong and how to fix it, in plain words.");
w("form-long", WEB, "Very long and odd text is handled", ["Paste 2,000 characters into a text box.", "Type a name like O'Brien-Søren 😀.", "Send."], "The form either accepts it or says the limit; the name shows correctly afterwards.");
w("form-double", WEB, "Pressing Send twice does not send twice", ["Fill a form and press Send twice quickly."], "Only one message, order or record is made.");

group("Sign in and accounts");
w("login-ok", [...APP, "ecommerce", ...MOBILE], "Sign in with a correct account", ["Open the sign-in page.", "Enter a correct email and password.", "Sign in."], "You land on your own home or dashboard, with your name shown.", { key: true, auto: "Signed-in app test" });
w("login-wrong", [...APP, "ecommerce", ...MOBILE], "Wrong password is refused", ["Enter a correct email and a wrong password."], "A message says the details are wrong, without saying which one. You stay signed out.", { auto: "Login checks" });
w("login-lockout", [...APP, "ecommerce", ...MOBILE], "Many wrong passwords are slowed down", ["Use a test account.", "Enter a wrong password 10 times."], "The account is slowed down or locked for a while, and the message says how to get back in.");
w("login-forgot", [...APP, "ecommerce", ...MOBILE], "Forgotten password works end to end", ["Press 'Forgot password' and enter your email.", "Open the email and follow the link.", "Set a new password and sign in with it."], "The email arrives within a few minutes, the link works once, and the new password works.");
w("login-logout", [...APP, "ecommerce", ...MOBILE], "Signing out really signs out", ["Sign in, then sign out.", "Press the browser's Back button.", "Reload the page."], "You see the sign-in page, not your account.", { key: true });
w("login-remember", [...APP, "ecommerce"], "Staying signed in works as described", ["Sign in with 'Remember me' ticked, close the browser, open it again.", "Repeat without ticking it."], "Ticked: still signed in. Not ticked: asked to sign in again.");
w("login-2fa", APP, "Two-step sign-in (if the app has it)", ["Turn on two-step sign-in in the settings.", "Sign out and sign in again with the code."], "The code is asked for; a wrong or old code is refused.");

group("Shop and checkout");
w("shop-browse", ["ecommerce"], "Find a product and open it", ["Open a category.", "Use a filter and sort by price.", "Open a product."], "Filters and sorting change the list correctly; the product page shows price, pictures and stock.", { key: true, auto: "Store checks" });
w("shop-cart", ["ecommerce"], "Add, change and remove items in the cart", ["Add two different products.", "Change the quantity of one.", "Remove the other."], "The cart count and total update correctly each time.", { key: true });
w("shop-checkout", ["ecommerce"], "Checkout with a test card", ["Go to checkout with items in the cart.", "Fill the address and pay with the payment provider's test card."], "The order confirmation shows the right items and total, and the confirmation email arrives.", { key: true });
w("shop-declined", ["ecommerce"], "A declined card is handled", ["Pay with the provider's 'declined' test card."], "A clear message; the cart keeps its items; no order is made.");
w("shop-coupon", ["ecommerce"], "Discount codes", ["Try a valid code, an expired code and a made-up code."], "Only the valid one changes the total; the others say why they do not work.");
w("shop-tax", ["ecommerce"], "Prices, tax and delivery add up", ["Check the total on the cart, checkout and receipt for two items with delivery."], "The same total everywhere, with tax and delivery shown as described.");

group("Records: add, change, delete");
w("crud-add", APP, "Add a record", ["Create a new record (a contact, lead, ticket or item) with every field filled."], "It saves, shows in the list, and every field reads back exactly as typed.", { key: true });
w("crud-edit", APP, "Change a record", ["Open the record you made, change two fields, save.", "Reload the page."], "The changes are kept after the reload.", { key: true });
w("crud-delete", APP, "Delete a record", ["Delete the record you made."], "You are asked to confirm; afterwards it is gone from the list and from search.");
w("crud-list", APP, "Lists, filters and paging", ["Open a list with more than one page of records.", "Sort, filter and go to page 2."], "Sorting and filters are correct; paging does not repeat or skip records.");
w("crud-import", APP, "Import and export (if the app has them)", ["Export a list to a file.", "Import a small file with three rows."], "The export opens in a spreadsheet with the right columns; the import adds exactly three records.");
w("crud-two-tabs", APP, "Two people changing the same record", ["Open the same record in two browser windows.", "Change it in both and save both."], "The app warns about the clash or keeps the last save on purpose; nothing is silently mixed.");

group("Roles and access");
w("role-each", APP, "Each role sees only its own things", ["Sign in as each role (admin, manager, staff, client...).", "Note which menus and records each one sees."], "Every role sees what it should and nothing more.", { key: true, auto: "Access grid" });
w("role-url", APP, "Copying an address does not get around access", ["As an admin, copy the address of an admin-only page.", "Sign in as a basic role and open that address."], "The basic role is refused or sent away, not shown the page.", { key: true, auto: "Access grid" });
w("role-other-client", APP, "One client cannot see another's data", ["As client A, open a record of yours and note its address.", "Sign in as client B and open that address."], "Client B is refused.");

group("Look and layout");
w("look-phone", WEB, "On a phone", ["Open the site on a real phone (or the browser's phone view).", "Go through the main pages and a form."], "Text is readable without zooming, nothing runs off the side, buttons are easy to tap.", { key: true, auto: "Phone and tablet screens" });
w("look-browsers", WEB, "In each browser", ["Open the main pages in Chrome, Safari, Firefox and Edge."], "They look and work the same in all four.", { auto: "Browser checks" });
w("look-rotate", MOBILE, "Turn the phone", ["Turn the phone sideways on each main screen, then back."], "The layout adjusts and nothing you typed is lost.");
w("look-dark", [...WEB, ...MOBILE], "Dark mode (if supported)", ["Turn on dark mode on the device.", "Open the main screens."], "Text stays readable; no white boxes or invisible icons.");
w("look-brand", PUBLIC, "Brand and pictures look right", ["Compare the logo, colours and fonts with the brand guide.", "Look for stretched, blurry or missing pictures."], "Matches the brand; every picture is sharp and in proportion.");

group("Accessibility by hand");
w("a11y-keyboard", [...WEB], "Use it with only the keyboard", ["Put the mouse away.", "Use Tab, Shift+Tab, Enter and Space to go through the menu and a form."], "You can reach and use everything, and you can always see where you are.", { key: true, auto: "Keyboard check" });
w("a11y-reader", [...WEB, ...MOBILE], "Use it with a screen reader", ["Turn on VoiceOver (Mac, iPhone), NVDA (Windows) or TalkBack (Android).", "Go through the start page and a form."], "Every button, picture and field is read out with a sensible name.", { auto: "Screen reader check" });
w("a11y-zoom", [...WEB, ...MOBILE], "Large text and zoom", ["Zoom the browser to 200%, or set the phone's text size to the largest."], "Everything still fits and can be read; nothing overlaps.", { auto: "Zoom check" });
w("a11y-colour", [...WEB, ...MOBILE], "Not only colour", ["Look at errors, required fields and charts."], "Each also uses words or icons, not colour alone.");
w("a11y-captions", PUBLIC, "Videos have captions", ["Play each video with the sound off."], "Captions are there and match what is said.");

group("Content and words");
w("content-spelling", [...WEB, ...MOBILE], "Spelling and grammar", ["Read the main pages slowly."], "No spelling mistakes, placeholder text (lorem ipsum) or half sentences.", { auto: "Spelling check" });
w("content-facts", PUBLIC, "Facts are current", ["Check phone numbers, addresses, prices, opening hours and the year in the footer."], "Everything is correct and up to date.");
w("content-legal", PUBLIC, "Privacy and cookie notices", ["Open the site in a private window.", "Read the cookie banner and the privacy page."], "A cookie choice appears before tracking starts, and the privacy page names the company and how to contact it.", { auto: "Privacy and cookie checks" });
w("content-languages", [...WEB, ...MOBILE], "Other languages (if the site has them)", ["Switch to each language."], "Every word changes, nothing is cut off, dates and money use the local format.");

group("Speed as a person feels it");
w("speed-slow-network", [...WEB, ...MOBILE], "On a slow connection", ["Turn on a slow 3G connection (browser tools, or a phone on weak signal).", "Open the main pages."], "Something useful shows within a few seconds; there is a loading sign while waiting.", { auto: "Speed checks" });
w("speed-busy", [...APP], "Big lists and reports", ["Open the biggest list or report in the app."], "It opens in a few seconds, or shows progress while it loads.");

group("Security by hand");
w("sec-https", WEB, "Always on https", ["Type the address with http:// instead of https://."], "You are moved to https:// and the browser shows the padlock.", { auto: "HTTPS check" });
w("sec-errors", WEB, "Errors do not show inside details", ["Put a quote mark ' into the search box and a form field.", "Send."], "A normal message, never a page full of code, database or server names.", { auto: "Security checks" });
w("sec-session", [...APP, "ecommerce"], "Sessions end", ["Sign in, leave the browser for the session time (or an hour).", "Click something."], "You are asked to sign in again.");
w("sec-files", APP, "File uploads are checked", ["Upload a file that is too big, and a .exe renamed to .pdf."], "Both are refused with a clear message.");

group("API by hand");
w("api-docs", ["api"], "The documentation matches the API", ["Pick three endpoints from the documentation.", "Call each one with the example from the docs (Postman or cURL)."], "Each answer matches what the docs describe: fields, types and status codes.", { key: true, auto: "API contract checks" });
w("api-no-key", ["api"], "Calls without a key are refused", ["Call a private endpoint without the key or token."], "401 or 403, with no data in the answer.", { key: true, auto: "API access checks" });
w("api-other-user", ["api"], "One user cannot read another's records", ["As user A, read one of A's records by its id.", "As user B, read the same id."], "User B gets 403 or 404.", { auto: "API access checks" });
w("api-bad-input", ["api"], "Bad input gets a clear error", ["Send a request with a missing field, a wrong type and an extra field."], "400 with a message that names the field; the extra field is ignored or refused.", { auto: "API input checks" });
w("api-limits", ["api"], "Rate limits", ["Send 100 requests in a minute (on a test server)."], "After the limit, 429 with a Retry-After header.");
w("api-versions", ["api"], "Older app versions still work", ["Call the API the way the previous app version does."], "It still works, or says clearly that an update is needed.");

group("Code review by hand");
w("code-readme", ["code"], "A new developer can start it", ["Follow only the README on a clean computer."], "The project builds and runs without asking anyone.", { key: true });
w("code-review", ["code"], "Review the riskiest parts", ["Read the sign-in, payment and file upload code."], "Inputs are checked, secrets come from settings, errors are handled.", { auto: "Code checks" });
w("code-tests", ["code"], "Tests run and pass", ["Run the project's own test command."], "All tests pass; the main features have tests.", { auto: "Test check" });
w("code-deps", ["code"], "Packages are kept up to date", ["Look at the package list and when each was last updated."], "No package is years out of date or no longer maintained.", { auto: "Package checks" });

group("Phone app by hand");
w("app-permissions", MOBILE, "Permission questions make sense", ["Install fresh.", "Use each feature that needs the camera, location, contacts or notifications."], "The app asks only when the feature is used, explains why, and still works when you say no.", { key: true, auto: "Permission checks" });
w("app-interrupt", MOBILE, "Calls and switching apps", ["While filling a form, take a call or switch to another app for a minute.", "Come back."], "The app is where you left it, with what you typed.", { auto: "Phone interruptions" });
w("app-offline", MOBILE, "No internet", ["Turn on airplane mode.", "Use the app, then turn the internet back on."], "A clear 'no connection' message; the app recovers when the internet is back.");
w("app-update", MOBILE, "Update from the last version", ["Install the version that is in the store now and sign in.", "Install this build over it."], "You stay signed in and your data is still there.");
w("app-push", MOBILE, "Notifications", ["Trigger a notification (a message, an order update)."], "It arrives, and tapping it opens the right screen.");
w("app-battery", MOBILE, "Battery and storage", ["Use the app for 15 minutes.", "Check battery use and storage in the phone's settings."], "Nothing unusual compared with similar apps.");
w("app-store", MOBILE, "Store listing", ["Read the store text, screenshots and privacy answers."], "They match what the app really does and asks for.");

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

/** Cases made from what this project has set up: journeys, scenarios, the sign-in and its roles. */
function projectCases(p: Project, roles: { id: string; name: string }[], hasLogin: boolean): ManualCase[] {
  const out: ManualCase[] = [];
  const section = "This project";
  for (const j of p.journeys ?? []) {
    out.push({ id: `journey.${j.id}`, section, title: `Journey by hand: ${j.name}`, steps: lines(j.steps), expected: "Every step works as written, and the last page shows what the journey expects.", source: "project", alsoAuto: j.off ? undefined : "This journey also runs on every test" });
  }
  for (const j of p.appJourneys ?? []) {
    out.push({ id: `appjourney.${j.id}`, section, title: `App journey by hand: ${j.name}`, steps: lines(j.steps), expected: "Every step works on a real phone as written.", source: "project", alsoAuto: j.off ? undefined : "This journey also runs on the test phone" });
  }
  for (const s of p.apiScenarios ?? []) {
    out.push({ id: `scenario.${s.id}`, section, title: `Scenario by hand: ${s.name}`, steps: lines(s.steps), expected: "Each request gets the answer the scenario checks for.", source: "project", alsoAuto: s.off ? undefined : "This scenario also runs on every test" });
  }
  if (hasLogin) {
    out.push({ id: "project.login", section, title: "Sign in with the saved test account", steps: ["Sign in with the account saved for this project.", "Open the main screens."], expected: "Sign-in works and the account sees its own data.", source: "project", key: true });
  }
  for (const r of roles) {
    out.push({ id: `role.${r.id}`, section, title: `Sign in as ${r.name}`, steps: [`Sign in with the ${r.name} account saved for this project.`, "Go through every menu.", "Try to open a page this role should not see."], expected: `${r.name} sees only what that role should, and is refused elsewhere.`, source: "project", alsoAuto: "Access grid" });
  }
  if (p.target.url && WEB.includes(p.type)) {
    out.push({ id: "project.address", section, title: `Open ${p.target.url}`, steps: [`Open ${p.target.url} on a computer and on a phone.`], expected: "It opens quickly on both, with no errors.", source: "project", key: true });
  }
  return out;
}

/** One case for each handbook testing type that applies to this product. */
function handbookCases(product: ProductType): ManualCase[] {
  const mod = moduleOf(product);
  return HANDBOOK.filter((h) => h.modules.includes(mod)).map((h) => {
    const auto = h.agents?.length || h.tools?.length ? "The automatic test covers part of this" : undefined;
    const steps = [`Goal: ${h.purpose}`];
    if (h.manual) steps.push(h.manual);
    else if (h.platform) steps.push(`Where the tool helps: ${h.platform}`);
    steps.push("Check it on this product by hand, and write what you saw in the note.");
    return {
      id: `hb.${slug(h.section)}.${slug(h.name)}`,
      section: `Handbook: ${h.section}`,
      title: h.name,
      steps,
      expected: `${h.purpose.replace(/\.$/, "")}: done, with nothing wrong found.`,
      source: "handbook" as const,
      alsoAuto: auto,
    };
  });
}

/** Every case for a project, in the order shown: key written cases first, then project, then handbook, then own. */
export function buildChecklist(p: Project, extras: { roles?: { id: string; name: string }[]; hasLogin?: boolean } = {}): ManualCase[] {
  const written: ManualCase[] = W.filter((c) => c.for.includes(p.type)).map((c) => ({
    id: `lib.${c.slug}`,
    section: c.section,
    title: c.title,
    steps: c.steps,
    expected: c.expected,
    source: "written",
    key: c.key,
    alsoAuto: c.auto,
  }));
  const own = (p.manual?.own ?? []).map((c) => ({ ...c, section: c.section || "Our own cases", source: "own" as const }));
  return [...written, ...projectCases(p, extras.roles ?? [], Boolean(extras.hasLogin)), ...own, ...handbookCases(p.type)];
}

export const isOn = (p: Project, id: string) => !(p.manual?.off ?? []).includes(id);

export function countRound(r: Pick<ManualRound, "cases" | "results">): RoundCounts {
  const c: RoundCounts = { total: r.cases.length, pass: 0, fail: 0, skip: 0, todo: 0 };
  for (const k of r.cases) {
    const s = r.results[k.id]?.status;
    if (s) c[s]++;
    else c.todo++;
  }
  return c;
}

export class ManualError extends Error {}

/** Tidies a case the team writes themselves. */
export function cleanOwnCase(input: unknown, id?: string): ManualCase {
  const b = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const title = str(b.title, 200);
  if (!title) throw new ManualError("Give the case a title.");
  const stepsIn = Array.isArray(b.steps) ? b.steps.join("\n") : str(b.steps, 5000);
  const steps = lines(String(stepsIn)).slice(0, 40).map((l) => l.slice(0, 500));
  if (!steps.length) throw new ManualError("Write at least one step.");
  return {
    id: id ?? `own.${randomUUID().slice(0, 8)}`,
    section: str(b.section, 80) || "Our own cases",
    title,
    steps,
    expected: str(b.expected, 1000) || "Works as described.",
    source: "own",
    key: b.key === true,
  };
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
// Cells that start with = + - @ would run as formulas in a spreadsheet.
const safeCell = (v: string) => csvCell(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

const LABEL: Record<ManualStatus | "todo", string> = { pass: "Passed", fail: "Failed", skip: "Skipped", todo: "Not tested" };

export function roundCsv(r: ManualRound): string {
  const head = ["Group", "Case", "Steps", "Should happen", "Result", "Note", "Tester", "When", "Issue", "Screenshots"];
  const rows = r.cases.map((c) => {
    const res = r.results[c.id];
    return [c.section, c.title, c.steps.join(" / "), c.expected, LABEL[res?.status ?? "todo"], res?.note ?? "", res?.by ?? "", res?.at ?? "", res?.issue ?? "", String(res?.shots?.length ?? 0)];
  });
  return [head, ...rows].map((row) => row.map(safeCell).join(",")).join("\r\n") + "\r\n";
}

export function roundMarkdown(r: ManualRound, projectName: string): string {
  const n = countRound(r);
  const out = [
    `# Manual test: ${r.name}`,
    "",
    `Project: ${projectName}  `,
    `Tester: ${r.tester}  `,
    ...(r.build ? [`Build: ${r.build}  `] : []),
    ...(r.env ? [`Where: ${r.env}  `] : []),
    `Started: ${r.createdAt}${r.finishedAt ? `, finished ${r.finishedAt}` : ""}`,
    "",
    `**${n.pass} passed, ${n.fail} failed, ${n.skip} skipped, ${n.todo} not tested** (of ${n.total})`,
    "",
  ];
  const failed = r.cases.filter((c) => r.results[c.id]?.status === "fail");
  if (failed.length) {
    out.push("## Failed", "");
    for (const c of failed) {
      const res = r.results[c.id]!;
      out.push(`- **${c.title}** (${c.section})${res.issue ? ` – issue ${res.issue}` : ""}${res.note ? `: ${res.note.replace(/\n/g, " ")}` : ""}`);
    }
    out.push("");
  }
  let section = "";
  for (const c of r.cases) {
    if (c.section !== section) {
      section = c.section;
      out.push(`## ${section}`, "");
    }
    const res = r.results[c.id];
    const mark = res?.status === "pass" ? "[x]" : res?.status === "fail" ? "[!]" : res?.status === "skip" ? "[-]" : "[ ]";
    out.push(`- ${mark} ${c.title} – ${LABEL[res?.status ?? "todo"]}${res?.note ? `: ${res.note.replace(/\n/g, " ")}` : ""}`);
  }
  return out.join("\n") + "\n";
}

/** Manual rounds, kept in the same SQLite file as the rest. */
export class ManualStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS manual_rounds (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS manual_rounds_project ON manual_rounds (project_id);
    `);
  }

  save(r: ManualRound): void {
    this.db
      .prepare("INSERT INTO manual_rounds (id, project_id, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(r.id, r.projectId, r.createdAt, JSON.stringify(r));
  }

  get(id: string): ManualRound | undefined {
    const row = this.db.prepare("SELECT data FROM manual_rounds WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ManualRound) : undefined;
  }

  list(projectId: string, limit = 200): ManualRound[] {
    const rows = this.db.prepare("SELECT data FROM manual_rounds WHERE project_id = ? ORDER BY created_at DESC LIMIT ?").all(projectId, limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as ManualRound);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM manual_rounds WHERE id = ?").run(id);
  }

  deleteForProject(projectId: string): string[] {
    const ids = (this.db.prepare("SELECT id FROM manual_rounds WHERE project_id = ?").all(projectId) as { id: string }[]).map((r) => r.id);
    this.db.prepare("DELETE FROM manual_rounds WHERE project_id = ?").run(projectId);
    return ids;
  }
}

/** The written cases, for tests and the handbook count. */
export const WRITTEN_CASES = W;
