import { isUnsafeLink } from "../../runner/urls.js";
import { addressParams, getForms, linkParams, type ProbeTarget } from "../probes.js";
import type { AttackHttp } from "./http.js";
import type { Cookie, Surface } from "./types.js";
import type { ToolContext } from "../types.js";

const MAX_PARAMS = 80;
const MAX_PAGES_FETCHED = 30;
const pathKey = (t: ProbeTarget) => {
  try {
    const u = new URL(t.url);
    return `${u.origin}${u.pathname}|${t.param}`;
  } catch {
    return `${t.url}|${t.param}`;
  }
};

/** The cookies of the signed-in session, so the session and access-control checks can read them. */
export function parseCookies(header: string | undefined): Cookie[] {
  if (!header) return [];
  const out: Cookie[] = [];
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const value = part.slice(eq + 1).trim();
    if (!value) continue;
    out.push({ name: part.slice(0, eq).trim(), value });
  }
  return out;
}

/**
 * Builds the attack surface once: the safe pages, every query parameter and GET form field on them
 * (one per path and name, so /product?id=1 and /product?id=2 are tested once), and the session's
 * cookies. Sign-out, delete and other data-changing links are never included, the same rule the
 * crawler follows.
 */
export async function buildSurface(ctx: ToolContext, http: AttackHttp): Promise<Surface> {
  const loggedIn = Boolean(ctx.cookie);
  const safe = (u: string) => /^https?:/.test(u) && !isUnsafeLink(u, loggedIn);
  const pages = [...new Set([ctx.startUrl, ...ctx.urls])].filter(safe);

  const all: ProbeTarget[] = [];
  for (const page of pages) all.push(...addressParams(page));
  for (const page of pages.slice(0, MAX_PAGES_FETCHED)) {
    if (http.left() <= 0) break;
    try {
      const res = await http.get(page, { cookie: loggedIn });
      if (/html/i.test(res.type)) all.push(...getForms(res.body, page), ...linkParams(res.body, page));
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
  }

  const byKey = new Map<string, ProbeTarget>();
  for (const t of all) {
    if (!safe(t.url)) continue;
    const k = pathKey(t);
    if (!byKey.has(k)) byKey.set(k, t);
  }

  return {
    pages,
    params: [...byKey.values()].slice(0, MAX_PARAMS),
    cookies: parseCookies(ctx.cookie),
    signedIn: loggedIn,
  };
}
