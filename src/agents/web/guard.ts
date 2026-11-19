import type { Page, Route } from "playwright";
import { safeRead } from "../../app/reads.js";
import { isUnsafeLink } from "../../runner/urls.js";

const withoutHash = (u: string) => u.split("#")[0];

/**
 * Lets an agent click and type on a page without changing anything on the site: requests other
 * than GET and HEAD are stopped (except POST calls that only read, like GraphQL queries and Odoo's
 * search_read), so are addresses that look like actions (log out, delete...), and, with
 * `stayOnPage`, the page leaving its own address. New windows are closed at once.
 */
export async function readOnly(
  page: Page,
  opts: { loggedIn?: boolean; stayOnPage?: boolean; unsafe?: RegExp } = {},
): Promise<{ blocked: string[]; stayOn: (url: string) => void; off: () => Promise<void> }> {
  const blocked: string[] = [];
  let home = "";
  const handler = async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const url = req.url();
    let unsafe = false;
    try {
      unsafe = /^https?:/.test(url) && (isUnsafeLink(url, opts.loggedIn) || Boolean(opts.unsafe?.test(url)));
    } catch {
      unsafe = false;
    }
    const leaving =
      opts.stayOnPage && home !== "" && req.isNavigationRequest() && req.frame() === page.mainFrame() && withoutHash(url) !== withoutHash(home);
    const write = method !== "GET" && method !== "HEAD" && !safeRead(method, url, req.postData(), req.headers()["content-type"]);
    if (write || unsafe || leaving) {
      if (blocked.length < 50) blocked.push(`${method} ${url}`);
      return route.abort("blockedbyclient").catch(() => {});
    }
    return route.fallback().catch(() => {});
  };
  await page.route("**/*", handler);
  const popup = (p: Page) => void p.close().catch(() => {});
  page.on("popup", popup);
  return {
    blocked,
    stayOn: (url: string) => (home = url),
    off: async () => {
      page.off("popup", popup);
      await page.unroute("**/*", handler).catch(() => {});
    },
  };
}

/** A short description of an element for evidence: tag, id or class, and its text. */
export const DESCRIBE_JS = `function (el) {
  if (!el || !el.tagName) return "";
  var s = el.tagName.toLowerCase();
  if (el.id) s += "#" + el.id;
  else if (typeof el.className === "string" && el.className.trim()) s += "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".");
  var t = (el.getAttribute("aria-label") || el.innerText || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("name") || "").replace(/\\s+/g, " ").trim();
  if (t) s += ' "' + t.slice(0, 50) + '"';
  return s;
}`;
