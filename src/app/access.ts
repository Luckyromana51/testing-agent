import type { Browser, BrowserContext, Page } from "playwright";
import { readOnly } from "../agents/web/guard.js";
import type { CapturedCall, SiteAgent, WriteCall } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { LoginError, signIn } from "../runner/login.js";
import { normaliseUrl } from "../runner/urls.js";
import type { AccessCell, AccessGrid, AppScreen, Finding, RoleLogin } from "../types.js";
import { APPS, sameData } from "./calls.js";
import { exploreApp } from "./explore.js";
import { adminScreensOf, ownAdminScreens, profileOf } from "./systems.js";

/**
 * Who can see what: every screen and app call the main account reached is opened again by each
 * other account of the project (a lower role, a user of another client company) and with no login,
 * like Burp Suite's Autorize. A lower role opening a screen its menu hides, a role opening an
 * address it must never open, or another company getting this company's records, is reported.
 */

const DENIED = /access denied|not authori[sz]ed|unauthori[sz]ed|forbidden|permission denied|no permission|don'?t have (access|permission)|do not have (access|permission)|not allowed|no access|insufficient (rights|privileges)|403\b|404\b|not found/i;
const MAX_SCREENS = 40;
const MAX_CALLS = 30;
const MAX_CHANGES = 10;
type Row = AccessGrid["rows"][number];
type Flag = NonNullable<Row["flags"]>[string];

/** A record's own address: a number, a UUID or a long hex id in the path, or an id parameter. */
export function isRecordUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const where = `${u.pathname}${u.hash.startsWith("#/") || u.hash.startsWith("#!/") ? u.hash.replace(/^#!?/, "") : ""}`;
    return (
      /\/\d{1,12}(\/|$)/.test(where) ||
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i.test(where) ||
      /\/[0-9a-f]{16,}(\/|$)/i.test(where) ||
      /[?&](id|record|recordId|record_id|uid|contact_id|lead_id|customer_id|invoice_id|order_id|user_id|ticket_id)=[\w-]+/i.test(u.search)
    );
  } catch {
    return false;
  }
}

/** "/admin", "/users/*", "billing" (anywhere in the address). */
export function matchesPattern(url: string, patterns: string): string | undefined {
  let where: string;
  try {
    const u = new URL(url);
    where = (u.pathname + u.search + u.hash).toLowerCase();
  } catch {
    return undefined;
  }
  for (const raw of patterns.split(/\r?\n|,/)) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    const re = new RegExp((p.startsWith("/") ? "^" : "") + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + (p.endsWith("*") ? "" : "(\\/|\\?|#|$)"));
    if (re.test(where)) return raw.trim();
  }
  return undefined;
}

interface Opened {
  cell: AccessCell;
  text: string;
}

/** Opens a screen as this account and decides whether it really opened. */
async function openAs(page: Page, url: string, loginPaths: string[]): Promise<Opened> {
  // A fresh load every time: going from #/a to #/b on a one-page app would only change the hash.
  await page.goto("about:blank").catch(() => {});
  const res = await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => null);
  if (!res) return { cell: "error", text: "" };
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  const status = res.status();
  if (status === 401 || status === 403 || status === 404 || status === 410) return { cell: "blocked", text: "" };
  if (status >= 500) return { cell: "error", text: "" };
  const now = new URL(page.url());
  if (loginPaths.includes(now.pathname) || (await page.locator('input[type="password"]').first().isVisible().catch(() => false))) return { cell: "blocked", text: "" };
  // The app sent the account somewhere else (its own home screen): not opened.
  if (normaliseUrl(page.url()) !== normaliseUrl(url) && new URL(url).pathname !== now.pathname) return { cell: "blocked", text: "" };
  const text = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 20_000)).catch(() => "");
  const head = text.slice(0, 1500);
  if (text.length < 3000 && DENIED.test(head)) return { cell: "blocked", text };
  return { cell: "opens", text };
}

/** Sends an app call again as this account: a GET, or a POST that only reads with the same question. */
async function callAs(ctx: BrowserContext, c: CapturedCall): Promise<{ cell: AccessCell; body: string }> {
  const r = await (c.request
    ? ctx.request.post(c.url, { data: c.request.body, headers: { "content-type": c.request.contentType }, timeout: 15_000, maxRedirects: 0 })
    : ctx.request.get(c.url, { timeout: 15_000, maxRedirects: 0 })
  ).catch(() => null);
  if (!r) return { cell: "error", body: "" };
  const s = r.status();
  if (s === 401 || s === 403 || s === 404 || (s >= 300 && s < 400)) return { cell: "blocked", body: "" };
  if (s >= 500) return { cell: "error", body: "" };
  const body = await r.text().catch(() => "");
  // GraphQL answers 200 with an error list when it refuses.
  if (c.read?.startsWith("GraphQL") && /"errors"\s*:/.test(body) && !/"data"\s*:\s*\{\s*"\w+"\s*:\s*[[{]/.test(body)) return { cell: "blocked", body: "" };
  return { cell: sameData(c.body, body) ? "same-data" : "opens", body };
}

/** Sends a save the main account made on the test server again as this account: did it work? */
async function changeAs(ctx: BrowserContext, w: WriteCall, loginPaths: string[]): Promise<AccessCell> {
  const r = await ctx.request
    .fetch(w.url, { method: w.method, ...(w.body !== undefined ? { data: w.body } : {}), headers: w.contentType ? { "content-type": w.contentType } : {}, timeout: 15_000, maxRedirects: 0 })
    .catch(() => null);
  if (!r) return "error";
  const s = r.status();
  if (s >= 200 && s < 300) return "opens";
  if (s >= 300 && s < 400) {
    // A form that saved sends the browser on (to the new record); a refused one sends it to sign in.
    const to = r.headers().location ?? "";
    let path = "";
    try {
      path = new URL(to, w.url).pathname;
    } catch {
      return "blocked";
    }
    return loginPaths.includes(path) || /log_?in|sign_?in|denied|forbidden|unauthori/i.test(to) ? "blocked" : "opens";
  }
  return s >= 500 ? "error" : "blocked";
}

export const accessAgent: SiteAgent = {
  id: "app.access",
  name: "Who can see what (roles and companies)",
  description:
    "Opens every screen and app call the main account reached again as each other saved account (a lower role, a user of another company) and with no login, and draws the access grid. Also tries the system's known admin screens directly, and on test servers the saves journeys made. Reports screens a role's menu hides but the role can open, addresses a role must never open, admin screens open to lower roles, saves that work for the wrong account, and another company's users getting this company's records.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, pages, site, log, startUrl }) {
    const roles = site.roles ?? [];
    const out: Finding[] = [];
    const main = { id: "main", name: site.login?.roleName || "Main account", signedIn: true };
    const screens: (AppScreen & { known?: "system" | "general" })[] = [];
    const seen = new Set<string>();
    const byUrl = new Map((site.screens ?? []).map((s) => [s.url, s]));
    for (const s of [...(site.screens ?? []).filter((s) => s.inMenu), ...pages.filter((p) => !p.error && (p.status ?? 0) < 400).map((p) => byUrl.get(normaliseUrl(p.url)) ?? { url: normaliseUrl(p.url) })]) {
      if (seen.has(s.url) || screens.length >= MAX_SCREENS) continue;
      seen.add(s.url);
      screens.push(s);
    }
    const calls = (site.calls ?? []).filter((c) => (c.method === "GET" || c.request) && c.status >= 200 && c.status < 300 && c.body).slice(0, MAX_CALLS);
    const changes = (site.writes ?? []).filter((w) => w.status >= 200 && w.status < 400).slice(0, MAX_CHANGES);
    const real: Browser | null = browser.browser();
    const loginPaths = [site.login?.loginUrl, ...roles.map((r) => r.login.loginUrl)].filter((u): u is string => Boolean(u)).map((u) => new URL(u).pathname);
    const unsafe = site.unsafe;
    const mainOpened = new Map<string, Opened>();
    const mainOpen = async (url: string): Promise<Opened> => {
      if (mainOpened.has(url)) return mainOpened.get(url)!;
      const p = await browser.newPage();
      const g = await readOnly(p, { loggedIn: true, unsafe });
      try {
        const r = await openAs(p, url, loginPaths);
        mainOpened.set(url, r);
        return r;
      } finally {
        await g.off();
        await p.close().catch(() => {});
      }
    };
    const mainText = async (url: string) => (await mainOpen(url)).text;

    // The system's admin screens (users, roles, settings), tried directly: no menu needs to lead there.
    const knownCalls: CapturedCall[] = [];
    if (real && screens.length) {
      const origin = new URL(startUrl).origin;
      const own = new Set(ownAdminScreens(site.system?.id));
      const startText = await mainText(normaliseUrl(startUrl));
      for (const path of adminScreensOf(site.system?.id)) {
        site.signal?.throwIfAborted();
        const url = new URL(path, origin).href;
        if (seen.has(url) || seen.has(normaliseUrl(url)) || unsafe?.test(url) || calls.some((c) => c.url === url)) continue;
        if (/\/api\//.test(path)) {
          const r = await browser.request.get(url, { timeout: 10_000, maxRedirects: 0 }).catch(() => null);
          const body = r && r.status() === 200 && /json/i.test(r.headers()["content-type"] ?? "") ? await r.text().catch(() => "") : "";
          if (body.length > 20) knownCalls.push({ method: "GET", url, status: 200, ms: 0, bytes: body.length, pageUrl: url, type: "fetch", contentType: "application/json", body, count: 1 });
          continue;
        }
        const got = await mainOpen(url);
        if (got.cell !== "opens" || got.text.length < 40 || sameData(got.text, startText)) continue;
        seen.add(url);
        screens.push({ url, via: "Admin screen, tried directly", known: own.has(path) ? "system" : "general" });
      }
      if (screens.some((s) => s.known) || knownCalls.length) log(`Access grid: ${screens.filter((s) => s.known).length + knownCalls.length} admin screens of the system open for the main account; trying them as the other accounts`);
    }
    const allCalls = [...calls, ...knownCalls];

    const grid: AccessGrid = {
      roles: [main, ...roles.map((r) => ({ id: r.id, name: r.name, ...(r.otherCompany ? { otherCompany: true } : {}), signedIn: false })), { id: "anon", name: "No login", signedIn: false }],
      rows: [],
    };
    const screenRows = screens.map((s): Row => ({ kind: "screen" as const, url: s.url, ...(s.inMenu ? { inMenu: true } : {}), ...(s.known ? { known: true } : {}), cells: { main: "opens" as AccessCell } }));
    const callRows = allCalls.map((c): Row => ({
      kind: "call" as const,
      url: c.url,
      ...(c.method !== "GET" ? { method: c.method } : {}),
      ...(c.read ? { what: c.read } : {}),
      ...(knownCalls.includes(c) ? { known: true } : {}),
      cells: { main: "opens" as AccessCell },
    }));
    const changeRows = changes.map((w): Row => ({ kind: "change" as const, url: w.url, method: w.method, what: w.journey, cells: { main: "opens" as AccessCell } }));
    grid.rows.push(...screenRows, ...callRows, ...changeRows);
    site.access = grid;
    if (!real || !screens.length) return out;
    if (changes.length) log(`Access grid: ${changes.length} saves from journeys on the test server will be tried as the other accounts`);

    const accounts: { col: (typeof grid.roles)[number]; role?: RoleLogin }[] = [...roles.map((r) => ({ col: grid.roles.find((g) => g.id === r.id)!, role: r })), { col: grid.roles.at(-1)! }];
    for (const { col, role } of accounts) {
      site.signal?.throwIfAborted();
      const ctx = await real.newContext({ viewport: { width: 1366, height: 900 } });
      try {
        let menu = new Set<string>();
        if (role) {
          try {
            await signIn(ctx, role.login, log, { mailUrl: site.mailUrl, signal: site.signal });
            col.signedIn = true;
          } catch (err) {
            if (site.signal?.aborted) throw err;
            col.error = err instanceof LoginError ? err.message : (err as Error).message.split("\n")[0];
            for (const row of grid.rows) row.cells[col.id] = "not-tried";
            out.push(
              finding({
                category: "functional",
                rule: "app:role-sign-in-failed",
                severity: "medium",
                title: `Could not sign in as ${role.name}`,
                detail: `${col.error} The access grid has no column for ${role.name} until its login works. Fix it on the project page under Roles.`,
                pageUrl: role.login.loginUrl ?? startUrl,
                evidence: `Role ${role.name}`,
                agent: "app.access",
              }),
            );
            continue;
          }
          log(`Access grid: signed in as ${role.name}; reading its menu`);
          const own = await exploreApp(ctx, startUrl, { system: profileOf(site.system?.id), unsafe, maxClicks: 30, deeper: 0, maxMs: 40_000, signal: site.signal }).catch(() => [] as AppScreen[]);
          menu = new Set(own.filter((s) => s.inMenu).map((s) => s.url));
          for (const row of grid.rows) if (menu.has(row.url)) row.menuOf = [...(row.menuOf ?? []), role.id];
        }
        log(`Access grid: opening ${screens.length} screens, ${allCalls.length} app calls${changes.length ? ` and ${changes.length} save${changes.length === 1 ? "" : "s"}` : ""} as ${col.name}`);
        const page = await ctx.newPage();
        const guard = await readOnly(page, { loggedIn: true, unsafe });
        const records: string[] = [];
        const adminOpen: string[] = [];
        let adminSystem = false;
        try {
          for (const [i, s] of screens.entries()) {
            site.signal?.throwIfAborted();
            const row = screenRows[i];
            const got = await openAs(page, s.url, loginPaths);
            let cell = got.cell;
            if (cell === "opens" && (role?.otherCompany ? isRecordUrl(s.url) : s.known)) {
              cell = sameData(await mainText(s.url), got.text) ? "same-data" : "other-data";
            }
            row.cells[col.id] = cell;
            if (cell === "blocked" || cell === "error") continue;
            const flag = (f: Flag) => (row.flags = { ...(row.flags ?? {}), [col.id]: f });
            if (!role) {
              // No login: an admin screen that opens with the admin's data.
              if (s.known && cell === "same-data") {
                flag("no-login");
                out.push(
                  finding({
                    category: "security",
                    rule: "app:admin-screen-public",
                    severity: "critical",
                    title: "An admin screen opens with no login",
                    detail: `${s.url} shows a visitor with no login the same admin screen the main account sees. Put the login check on this route.`,
                    pageUrl: s.url,
                    evidence: "No login → same admin screen",
                    agent: "app.access",
                  }),
                );
              }
              continue;
            }
            const path = new URL(s.url).pathname;
            const forbidden = role.mustNotOpen ? matchesPattern(s.url, role.mustNotOpen) : undefined;
            if (role.otherCompany && cell === "same-data" && !s.known) {
              records.push(s.url);
              flag("other-company");
            } else if (forbidden) {
              flag("forbidden");
              out.push(
                finding({
                  category: "security",
                  rule: "app:role-forbidden-screen",
                  severity: "high",
                  title: `${role.name} opens a screen they must never open`,
                  detail: `${s.url} matches "${forbidden}", which ${role.name} must never open, but it opens for them. Add the role check on the server for this route; hiding the menu item is not enough.`,
                  pageUrl: s.url,
                  evidence: `${role.name} → opens (rule "${forbidden}")`,
                  agent: "app.access",
                }),
              );
            } else if (!role.otherCompany && s.known && cell === "same-data" && !menu.has(s.url)) {
              flag("admin");
              adminOpen.push(s.url);
              adminSystem ||= s.known === "system";
            } else if (!role.otherCompany && s.inMenu && menu.size > 1 && !menu.has(s.url) && s.url !== normaliseUrl(startUrl) && !(path === new URL(startUrl).pathname && !new URL(s.url).hash)) {
              flag("hidden");
              out.push(
                finding({
                  category: "security",
                  rule: "app:role-hidden-screen",
                  severity: "medium",
                  title: `${role.name} can open a screen their menu does not show`,
                  detail: `${main.name}'s menu has ${s.url}${s.via ? ` (${s.via})` : ""}, ${role.name}'s menu does not, yet it opens for ${role.name} when they type the address. If ${role.name} should not use it, add a role check on the server; if they should, show it in their menu. Mark addresses a role must never open on the project page to make this a firm rule.`,
                  pageUrl: s.url,
                  evidence: `${role.name}: not in menu, opens`,
                  agent: "app.access",
                }),
              );
            }
          }
        } finally {
          await guard.off();
          await page.close().catch(() => {});
        }
        if (role && adminOpen.length) {
          out.push(
            finding({
              category: "security",
              rule: "app:role-admin-screen",
              severity: adminSystem ? "high" : "medium",
              title: `${role.name} opens admin screens by typing the address`,
              detail: `${role.name}'s menu has no link to ${adminOpen.length === 1 ? "this admin screen" : `these ${adminOpen.length} admin screens`}, but typing the address opens the same screen the main account sees${site.system ? ` (known admin screens of ${site.system.name})` : ""}. If ${role.name} should not manage users or settings, add the role check on the server for these routes.`,
              pageUrl: adminOpen[0],
              evidence: adminOpen.slice(0, 10).map((u) => `${role.name} → opens ${u}`).join("\n"),
              agent: "app.access",
            }),
          );
        }
        if (role && records.length) {
          out.push(
            finding({
              category: "security",
              rule: "app:other-company-record",
              severity: "critical",
              title: "A user of another company opens this company's records",
              detail: `${role.name} (a user of another client company) opened ${records.length} of this company's record screens and saw the same records as the main account. Anyone signed in can read other companies' data by changing the number in the address (IDOR, broken access control). Check on the server that each record belongs to the signed-in user's company before showing it.`,
              pageUrl: records[0],
              evidence: records.slice(0, 10).map((u) => `${role.name} → same record: ${u}`).join("\n"),
              agent: "app.access",
            }),
          );
        }
        const idor: string[] = [];
        const forbiddenCalls: string[] = [];
        const adminCalls: string[] = [];
        let firstPage = "";
        for (const [i, c] of allCalls.entries()) {
          site.signal?.throwIfAborted();
          const row = callRows[i];
          const got = await callAs(ctx, c);
          row.cells[col.id] = got.cell;
          if (!role) continue;
          const forbidden = role.mustNotOpen ? matchesPattern(c.url, role.mustNotOpen) : undefined;
          const where = `${c.method} ${new URL(c.url).pathname + new URL(c.url).search}${c.read ? ` (${c.read})` : ""}`;
          const setFlag = (f: Flag) => (row.flags = { ...(row.flags ?? {}), [col.id]: f });
          if (role.otherCompany && got.cell === "same-data" && (isRecordUrl(c.url) || (c.request && /\b(id|ids)\b"?\s*[:=]/.test(c.request.body)))) {
            setFlag("other-company");
            idor.push(`${where} → same data`);
            firstPage ||= c.pageUrl || c.url;
          } else if (forbidden && (got.cell === "same-data" || got.cell === "opens")) {
            setFlag("forbidden");
            forbiddenCalls.push(`${where} → answers (rule "${forbidden}")`);
            firstPage ||= c.pageUrl || c.url;
          } else if (!role.otherCompany && knownCalls.includes(c) && got.cell === "same-data") {
            setFlag("admin");
            adminCalls.push(`${where} → same data`);
            firstPage ||= c.url;
          }
        }
        if (role && idor.length) {
          out.push(
            finding({
              category: "security",
              rule: "app:other-company-call",
              severity: "critical",
              title: "A user of another company gets this company's data from the app's calls",
              detail: `${role.name} (another client company) called ${idor.length} of the app's record addresses and got the same data as the main account. The API hands out records by id without checking whose they are (IDOR). Check the record's company on the server for every call.`,
              pageUrl: firstPage,
              evidence: idor.slice(0, 10).join("\n"),
              agent: "app.access",
            }),
          );
        }
        if (role && forbiddenCalls.length) {
          out.push(
            finding({
              category: "security",
              rule: "app:role-forbidden-call",
              severity: "high",
              title: `${role.name} gets data from app calls they must never use`,
              detail: `${forbiddenCalls.length} call${forbiddenCalls.length === 1 ? "" : "s"} that ${role.name} must never use answer them. Hiding the screen is not enough: add the role check to these API routes.`,
              pageUrl: firstPage,
              evidence: forbiddenCalls.slice(0, 10).join("\n"),
              agent: "app.access",
            }),
          );
        }
        if (role && adminCalls.length) {
          out.push(
            finding({
              category: "security",
              rule: "app:role-admin-call",
              severity: "medium",
              title: `${role.name} gets the user list from the app's admin API`,
              detail: `${role.name} called the app's admin addresses directly and got the same answer as the main account. If ${role.name} should not see every user, add the role check to these API routes.`,
              pageUrl: firstPage,
              evidence: adminCalls.slice(0, 10).join("\n"),
              agent: "app.access",
            }),
          );
        }

        // Saves from the test server's journeys, sent again as this account.
        const bad: Record<"no-login" | "other-company" | "forbidden" | "hidden", string[]> = { "no-login": [], "other-company": [], forbidden: [], hidden: [] };
        for (const [i, w] of changes.entries()) {
          site.signal?.throwIfAborted();
          const row = changeRows[i];
          const cell = await changeAs(ctx, w, loginPaths);
          row.cells[col.id] = cell;
          if (cell !== "opens") continue;
          const where = `${w.method} ${new URL(w.url).pathname} (journey "${w.journey}")`;
          const forbidden = role?.mustNotOpen ? matchesPattern(w.url, role.mustNotOpen) || matchesPattern(w.pageUrl, role.mustNotOpen) : undefined;
          const kind = !role
            ? "no-login"
            : role.otherCompany
              ? isRecordUrl(w.url)
                ? "other-company"
                : undefined
              : forbidden
                ? "forbidden"
                : menu.size > 1 && !menu.has(normaliseUrl(w.pageUrl))
                  ? "hidden"
                  : undefined;
          if (!kind) continue;
          row.flags = { ...(row.flags ?? {}), [col.id]: kind };
          bad[kind].push(where);
        }
        const who = role?.name ?? "A visitor with no login";
        const changeFindings: [keyof typeof bad, string, Finding["severity"], string, string][] = [
          ["no-login", "app:change-without-login", "critical", "A save works with no login", "sends the same save without any login, and the server accepts it. Anyone on the internet can change data. Put the login check on these routes."],
          ["other-company", "app:other-company-change", "critical", "A user of another company can change this company's records", "a user of another client company, sends the same save to this company's record, and the server accepts it. Check on the server that the record belongs to the user's company before saving."],
          ["forbidden", "app:role-forbidden-change", "high", `${who} can make a save they must never make`, "sends a save on an address they must never use, and the server accepts it. Add the role check to the route that saves, not only to the screen."],
          ["hidden", "app:role-hidden-change", "high", `${who} can make a save from a screen their menu hides`, "has no menu link to the screen this save comes from, yet the server accepts the save from them. If they should not do it, add the role check to the route that saves."],
        ];
        for (const [k, rule, severity, title, text] of changeFindings) {
          if (!bad[k].length) continue;
          out.push(
            finding({
              category: "security",
              rule,
              severity,
              title,
              detail: `${who}${k === "other-company" ? ` (${role?.name})` : ""} ${text} Found by sending again the saves a journey made on the test server.`,
              pageUrl: changes[0].pageUrl || changes[0].url,
              evidence: bad[k].slice(0, 10).map((x) => `${role?.name ?? "No login"} → accepted: ${x}`).join("\n"),
              agent: "app.access",
            }),
          );
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    }
    return out;
  },
};
