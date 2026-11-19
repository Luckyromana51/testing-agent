import { finding } from "../../runner/finding.js";
import type { ApiAccessRow, Finding, RoleLogin } from "../../types.js";
import type { ApiCall } from "./context.js";
import type { ApiAgent } from "./shared.js";

/*
 * Who can read what, like Akto, APIsec and Burp's Autorize for APIs: every endpoint the main login
 * read is called again with each other account's key, and with no key. Another company's account
 * reading the main account's records is broken object-level authorization (BOLA / IDOR, OWASP
 * API1); a lower role reaching admin endpoints, or ones in its "must never open" list, is broken
 * function-level authorization (BFLA, OWASP API5). Only GET.
 */

const good = (c: ApiCall) => c.status !== null && c.status >= 200 && c.status < 300;
const MAX = 40;
const ADMIN_PATH = /\/(admin|internal|manage(ment)?|staff|superuser|root|billing|audit|settings|config|system)(\/|$)/i;
const ADMIN_ROLE = /admin|owner|super|root|manager/i;

/** "/admin*", "/users/*" style patterns, one per line. */
export function matches(patterns: string | undefined, path: string): boolean {
  for (const raw of (patterns ?? "").split(/\r?\n/)) {
    const p = raw.trim();
    if (!p) continue;
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
    if (re.test(path)) return true;
  }
  return false;
}

/** Same data: the same JSON, ignoring key order, or the same text. */
function same(a: ApiCall, b: ApiCall): boolean {
  if (a.json !== undefined && b.json !== undefined) return JSON.stringify(sortKeys(a.json)) === JSON.stringify(sortKeys(b.json));
  return a.text === b.text;
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}

export const apiAccessAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.access",
  name: "Who can read what (other accounts)",
  description:
    "With other accounts saved (another company, a lower role): calls every endpoint the main login read with each account and with no login, and shows the grid. Another company reading the main account's records (BOLA/IDOR) and a lower role reaching admin or forbidden endpoints (BFLA) become issues.",
  category: "security",
  needsLogin: true,
  async run(ctx) {
    const { roles, calls, anonymous, send, log } = ctx;
    if (!roles.length) return [];
    const out: Finding[] = [];
    const base = calls.filter(good).slice(0, MAX);
    log(`Access grid: ${base.length} endpoints with ${roles.length} other account${roles.length === 1 ? "" : "s"}`);
    const rows: ApiAccessRow[] = [];
    const anonByOp = new Map(anonymous.map((c) => [c.op, c]));
    for (const main of base) {
      const url = main.url ?? main.op.url;
      const row: ApiAccessRow = { method: "GET", path: main.op.path, url, cells: { "Main login": { status: main.status } } };
      for (const role of roles) {
        const c = await send({ url, as: role }, main.op);
        const cell: ApiAccessRow["cells"][string] = { status: c.status, ...(good(c) ? { same: same(c, main) } : {}) };
        const bad = judge(role, main, c);
        if (bad) {
          cell.bad = bad.short;
          out.push(
            finding({
              category: "security",
              rule: bad.rule,
              severity: bad.severity,
              title: bad.title,
              detail: bad.detail,
              pageUrl: main.op.url,
              evidence: `${role.name}: GET ${main.op.path} -> HTTP ${c.status}${cell.same ? " with the main account's data" : ""}`,
            }),
          );
        }
        row.cells[role.name] = cell;
      }
      const anon = anonByOp.get(main.op);
      row.cells["No login"] = { status: anon && anon !== main ? anon.status : ctx.authenticated ? null : main.status };
      rows.push(row);
    }
    ctx.report.accessRows = rows;
    return out;
  },
};

function judge(role: RoleLogin, main: ApiCall, c: ApiCall): { rule: string; severity: Finding["severity"]; title: string; detail: string; short: string } | undefined {
  if (!good(c)) return undefined;
  const path = main.op.path;
  const record = path.includes("{");
  if (role.otherCompany && record && same(c, main)) {
    return {
      rule: "api:bola",
      severity: "critical",
      title: "Another company's account can read this company's records (BOLA / IDOR)",
      detail: `${role.name} (another company) called GET ${path} with the main account's record id and got the same record back. Any customer can read every other customer's data by changing the id. Check on every request that the record belongs to the caller's company, not only that the caller is logged in (OWASP API1).`,
      short: "Reads another company's record",
    };
  }
  if (matches(role.mustNotOpen, path) || matches(role.mustNotOpen, new URL(c.url ?? c.op.url).pathname)) {
    return {
      rule: "api:bfla",
      severity: "high",
      title: "An account reaches an endpoint it must never use",
      detail: `${role.name} called GET ${path}, which is in its "must never open" list, and got HTTP ${c.status}. Check the role on the server for this endpoint (OWASP API5).`,
      short: "Forbidden endpoint answers",
    };
  }
  if (ADMIN_PATH.test(path) && !ADMIN_ROLE.test(role.name) && same(c, main)) {
    return {
      rule: "api:bfla",
      severity: "medium",
      title: "A lower role can use an admin endpoint",
      detail: `${role.name} got the same answer as the main login from GET ${path}, an admin-looking endpoint. If this role should not see it, check the role on the server (OWASP API5). If it may, add the role's real limits to its "must never open" list so the test checks them.`,
      short: "Admin endpoint answers",
    };
  }
  return undefined;
}
