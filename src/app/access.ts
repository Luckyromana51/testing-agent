import type { Browser, BrowserContext, Page } from "playwright";
import { readOnly } from "../agents/web/guard.js";
import type { CapturedCall, SiteAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { LoginError, signIn } from "../runner/login.js";
import { normaliseUrl } from "../runner/urls.js";
import type { AccessCell, AccessGrid, AppScreen, Finding, RoleLogin } from "../types.js";
import { APPS, sameData } from "./calls.js";
import { exploreApp } from "./explore.js";
import { profileOf } from "./systems.js";

/**
 * Who can see what: every screen and app call the main account reached is opened again by each
 * other account of the project (a lower role, a user of another client company) and with no login,
 * like Burp Suite's Autorize. A lower role opening a screen its menu hides, a role opening an
 * address it must never open, or another company getting this company's records, is reported.
 */

const DENIED = /access denied|not authori[sz]ed|unauthori[sz]ed|forbidden|permission denied|no permission|don'?t have (access|permission)|do not have (access|permission)|not allowed|no access|insufficient (rights|privileges)|403\b|404\b|not found/i;
const MAX_SCREENS = 40;
const MAX_CALLS = 30;

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

async function callAs(ctx: BrowserContext, c: CapturedCall): Promise<{ cell: AccessCell; body: string }> {
  const r = await ctx.request.get(c.url, { timeout: 15_000, maxRedirects: 0 }).catch(() => null);
  if (!r) return { cell: "error", body: "" };
  const s = r.status();
  if (s === 401 || s === 403 || s === 404 || (s >= 300 && s < 400)) return { cell: "blocked", body: "" };
  if (s >= 500) return { cell: "error", body: "" };
  const body = await r.text().catch(() => "");
  return { cell: sameData(c.body, body) ? "same-data" : "opens", body };
}

export const accessAgent: SiteAgent = {
  id: "app.access",
  name: "Who can see what (roles and companies)",
  description:
    "Opens every screen and app call the main account reached again as each other saved account (a lower role, a user of another company) and with no login, and draws the access grid. Reports screens a role's menu hides but the role can open, addresses a role must never open, and another company's users getting this company's records.",
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
    const screens: AppScreen[] = [];
    const seen = new Set<string>();
    const byUrl = new Map((site.screens ?? []).map((s) => [s.url, s]));
    for (const s of [...(site.screens ?? []).filter((s) => s.inMenu), ...pages.filter((p) => !p.error && (p.status ?? 0) < 400).map((p) => byUrl.get(normaliseUrl(p.url)) ?? { url: normaliseUrl(p.url) })]) {
      if (seen.has(s.url) || screens.length >= MAX_SCREENS) continue;
      seen.add(s.url);
      screens.push(s);
    }
    const calls = (site.calls ?? []).filter((c) => c.method === "GET" && c.status >= 200 && c.status < 300 && c.body).slice(0, MAX_CALLS);
    const grid: AccessGrid = {
      roles: [main, ...roles.map((r) => ({ id: r.id, name: r.name, ...(r.otherCompany ? { otherCompany: true } : {}), signedIn: false })), { id: "anon", name: "No login", signedIn: false }],
      rows: [
        ...screens.map((s) => ({ kind: "screen" as const, url: s.url, ...(s.inMenu ? { inMenu: true } : {}), cells: { main: "opens" as AccessCell } })),
        ...calls.map((c) => ({ kind: "call" as const, url: c.url, cells: { main: "opens" as AccessCell } })),
      ],
    };
    site.access = grid;
    const real: Browser | null = browser.browser();
    if (!real || !screens.length) return out;
    const loginPaths = [site.login?.loginUrl, ...roles.map((r) => r.login.loginUrl)].filter((u): u is string => Boolean(u)).map((u) => new URL(u).pathname);
    const unsafe = site.unsafe;
    const mainTexts = new Map<string, string>();
    const mainText = async (url: string) => {
      if (mainTexts.has(url)) return mainTexts.get(url)!;
      const p = await browser.newPage();
      const g = await readOnly(p, { loggedIn: true, unsafe });
      try {
        const r = await openAs(p, url, loginPaths);
        mainTexts.set(url, r.text);
        return r.text;
      } finally {
        await g.off();
        await p.close().catch(() => {});
      }
    };

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
        log(`Access grid: opening ${screens.length} screens and ${calls.length} app calls as ${col.name}`);
        const page = await ctx.newPage();
        const guard = await readOnly(page, { loggedIn: true, unsafe });
        const records: string[] = [];
        try {
          for (const s of screens) {
            site.signal?.throwIfAborted();
            const row = grid.rows.find((r) => r.kind === "screen" && r.url === s.url)!;
            const got = await openAs(page, s.url, loginPaths);
            let cell = got.cell;
            if (cell === "opens" && role?.otherCompany && isRecordUrl(s.url)) {
              cell = sameData(await mainText(s.url), got.text) ? "same-data" : "other-data";
            }
            row.cells[col.id] = cell;
            if (!role || cell === "blocked" || cell === "error") continue;
            const path = new URL(s.url).pathname;
            const forbidden = role.mustNotOpen ? matchesPattern(s.url, role.mustNotOpen) : undefined;
            const flag = (f: "forbidden" | "hidden" | "other-company") => (row.flags = { ...(row.flags ?? {}), [col.id]: f });
            if (role.otherCompany && cell === "same-data") {
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
        let firstPage = "";
        for (const c of calls) {
          site.signal?.throwIfAborted();
          const row = grid.rows.find((r) => r.kind === "call" && r.url === c.url)!;
          const got = await callAs(ctx, c);
          row.cells[col.id] = got.cell;
          if (!role) continue;
          const forbidden = role.mustNotOpen ? matchesPattern(c.url, role.mustNotOpen) : undefined;
          const where = new URL(c.url).pathname + new URL(c.url).search;
          if (role.otherCompany && got.cell === "same-data" && isRecordUrl(c.url)) {
            row.flags = { ...(row.flags ?? {}), [col.id]: "other-company" };
            idor.push(`GET ${where} → same data`);
            firstPage ||= c.pageUrl || c.url;
          } else if (forbidden && (got.cell === "same-data" || got.cell === "opens")) {
            row.flags = { ...(row.flags ?? {}), [col.id]: "forbidden" };
            forbiddenCalls.push(`GET ${where} → answers (rule "${forbidden}")`);
            firstPage ||= c.pageUrl || c.url;
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
      } finally {
        await ctx.close().catch(() => {});
      }
    }
    return out;
  },
};
