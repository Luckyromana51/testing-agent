import type { Page } from "playwright";
import { readOnly } from "../agents/web/guard.js";
import type { PageAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import type { Finding } from "../types.js";
import { APPS } from "./calls.js";

/**
 * Data screens: the lists and tables a business system lives on (contacts, leads, invoices,
 * tickets). Like Mabl or Provar tests, it uses them: search, sort, the next page, the empty
 * screen, and the export. Everything is read-only: requests that would change data are stopped.
 */

const ROWS = `(function () {
  var t = document.querySelector("[data-glv-table]");
  if (!t) return [];
  var rows = t.querySelectorAll("tbody tr, [role=row]:not(:first-child)");
  var out = [];
  for (var i = 0; i < rows.length && i < 200; i++) out.push((rows[i].innerText || "").replace(/\\s+/g, " ").trim().slice(0, 200));
  return out.filter(Boolean);
})()`;

const rowsOf = (page: Page) => page.evaluate(ROWS).catch(() => []) as Promise<string[]>;

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: 8_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/** Cells that a spreadsheet would run as a formula (CSV injection), not plain negative numbers. */
export function formulaCells(csv: string): string[] {
  const out: string[] = [];
  for (const line of csv.split(/\r?\n/).slice(0, 5000)) {
    for (const raw of line.split(/[,;\t](?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const cell = raw.trim().replace(/^"(.*)"$/s, "$1");
      if (/^[=+@]/.test(cell) || (/^-/.test(cell) && !/^-[\d.,\s]+$/.test(cell)) || /^[\t\r]/.test(raw)) {
        if (cell.length > 1) out.push(cell.slice(0, 60));
      }
    }
    if (out.length >= 5) break;
  }
  return out;
}

export const tablesAgent: PageAgent = {
  id: "app.tables",
  name: "Lists and tables work",
  description:
    "On screens with a list of records it searches for a word from the list, sorts by a column, opens the next page and searches for a made-up word (the empty screen), and downloads the export to check it for spreadsheet formula injection. Read-only: nothing is saved.",
  category: "functional",
  engine: "web",
  products: APPS,
  stage: "page",
  skipErrorPages: true,
  interacts: true,
  async run({ page, url, site }) {
    const found = (await page.evaluate(`(function () {
      var cands = document.querySelectorAll("table, [role=grid], [role=table]");
      for (var i = 0; i < cands.length; i++) {
        var t = cands[i];
        var rows = t.querySelectorAll("tbody tr, [role=row]");
        if (rows.length >= 4 && t.getBoundingClientRect().width > 200) { t.setAttribute("data-glv-table", "1"); return true; }
      }
      return false;
    })()`)) as boolean;
    if (!found) return [];
    const out: Finding[] = [];
    const guard = await readOnly(page, { loggedIn: site.loggedIn, unsafe: site.unsafe });
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));
    try {
      const start = await rowsOf(page);
      if (start.length < 3) return [];

      // Export: a link that downloads the list (GET only).
      const exportHref = (await page.evaluate(`(function () {
        var as = document.querySelectorAll("a[href]");
        for (var i = 0; i < as.length; i++) {
          var a = as[i], t = (a.innerText || a.getAttribute("aria-label") || a.title || "").trim();
          if (/\\b(export|download|csv|excel|xlsx)\\b/i.test(t) || /\\.(csv)(\\?|$)|export/i.test(a.getAttribute("href"))) return a.href;
        }
        return "";
      })()`)) as string;
      if (exportHref && /^https?:/.test(exportHref)) {
        const r = await page.request.get(exportHref, { timeout: 20_000 }).catch(() => null);
        const type = r?.headers()["content-type"] ?? "";
        if (r && r.ok() && /csv|text\/plain|excel|octet-stream/.test(type)) {
          const text = (await r.text().catch(() => "")).slice(0, 2_000_000);
          const bad = formulaCells(text);
          if (bad.length) {
            out.push(
              finding({
                category: "security",
                rule: "app:csv-formula-injection",
                severity: "medium",
                title: "The export lets cells start with = (spreadsheet formula injection)",
                detail: `The exported file has cells that Excel or Google Sheets would run as formulas. A user who types =HYPERLINK(...) or =cmd|... into a name field can make the staff member who opens the export send data away or run commands. Put a ' in front of cells that start with =, +, -, @ or a tab when exporting.`,
                pageUrl: url,
                evidence: bad.slice(0, 4).join("\n"),
                agent: "app.tables",
              }),
            );
          }
        }
      }

      // Search: a word from the second row should keep that row and drop others.
      const search = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i], input[aria-label*="search" i], input[name*="search" i], input[name="q"]').first();
      if (await search.isVisible().catch(() => false)) {
        const word = (start[1].match(/[A-Za-z][A-Za-z0-9@.-]{3,}/g) ?? []).find((w) => !start.every((r) => r.includes(w)));
        if (word) {
          await search.fill(word).catch(() => {});
          await search.press("Enter").catch(() => {});
          await settle(page);
          const after = await rowsOf(page);
          if (after.length && after.join("|") === start.join("|")) {
            out.push(
              finding({
                category: "functional",
                rule: "app:table-search-does-nothing",
                severity: "medium",
                title: "Searching the list does not change it",
                detail: `Searching for "${word}" (a word from row 2) left all ${start.length} rows the same, including rows without it. Users cannot find records. Check the search box is wired to the list.`,
                pageUrl: url,
                evidence: `Search "${word}": ${start.length} rows before and after`,
                agent: "app.tables",
              }),
            );
          }
          // The empty screen.
          await search.fill("zzqxglvnothing").catch(() => {});
          await search.press("Enter").catch(() => {});
          await settle(page);
          const none = await rowsOf(page);
          const body = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
          if (none.length === 0 && !/no (results|records|data|matching|items|entries|.* found)|nothing (found|here|to show)|0 (results|records)|empty|not found/i.test(body)) {
            out.push(
              finding({
                category: "functional",
                rule: "app:table-no-empty-message",
                severity: "low",
                title: "An empty list shows no message",
                detail: "Searching for a made-up word leaves a blank list with no \"No results\" message, so users cannot tell whether it is still loading, broken, or simply empty.",
                pageUrl: url,
                evidence: 'Search "zzqxglvnothing": 0 rows, no message',
                agent: "app.tables",
              }),
            );
          }
          await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
          await settle(page);
          await page.evaluate(`(function(){var c=document.querySelectorAll("table, [role=grid], [role=table]");for(var i=0;i<c.length;i++){if(c[i].querySelectorAll("tbody tr, [role=row]").length>=4){c[i].setAttribute("data-glv-table","1");return;}}})()`).catch(() => {});
        }
      }

      // Sort: a header that says it sorts should change the order.
      const header = page.locator('[data-glv-table] th[aria-sort], [data-glv-table] th.sortable, [data-glv-table] th [class*="sort"], [data-glv-table] [role=columnheader][aria-sort]').first();
      if (await header.isVisible().catch(() => false)) {
        const before = await rowsOf(page);
        await header.click({ timeout: 3_000 }).catch(() => {});
        await settle(page);
        const after = await rowsOf(page);
        if (before.length > 2 && after.join("|") === before.join("|") && new Set(before).size > 1) {
          out.push(
            finding({
              category: "functional",
              rule: "app:table-sort-does-nothing",
              severity: "low",
              title: "Sorting the list does not change its order",
              detail: `The column "${((await header.innerText().catch(() => "")) || "header").trim().slice(0, 40)}" looks sortable, but clicking it keeps the same order.`,
              pageUrl: url,
              evidence: `${before.length} rows, same order after clicking the header`,
              agent: "app.tables",
            }),
          );
        }
      }

      // Next page: should show other rows.
      const next = page
        .locator('[aria-label*="pagination" i] a, [aria-label*="pagination" i] button, .pagination a, .pagination button, nav[role=navigation] a, a[rel=next]')
        .filter({ hasText: /^\s*(next|›|»|>|→)\s*$/i })
        .or(page.locator('a[rel="next"], [aria-label="Next page" i], [aria-label="Next" i]'))
        .first();
      if (await next.isVisible().catch(() => false)) {
        const before = await rowsOf(page);
        await next.click({ timeout: 3_000 }).catch(() => {});
        await settle(page);
        const after = await rowsOf(page);
        if (after.length && after.join("|") === before.join("|")) {
          out.push(
            finding({
              category: "functional",
              rule: "app:table-next-same-rows",
              severity: "medium",
              title: "The next page of the list shows the same records",
              detail: "Clicking Next shows the same rows again, so users can never reach the records after the first page. Check the page number or offset reaches the server.",
              pageUrl: url,
              evidence: `${before.length} rows, same after Next`,
              agent: "app.tables",
            }),
          );
        }
      }
    } finally {
      await guard.off();
      if (page.url() !== url) await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
    }
    return out;
  },
};
