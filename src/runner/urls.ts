/** URL rules shared by the crawler and the link checker. */

export const SKIP_EXT =
  /\.(pdf|zip|rar|7z|gz|jpe?g|png|gif|webp|svg|ico|mp4|mp3|webm|avi|mov|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;
/** Links a crawler must never follow: they log out or change data. */

export const UNSAFE_LINK =
  /\/(log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe)(\/|\?|$)|[?&](action|do)=(delete|remove|logout)/i;

/**
 * Normalises a URL for de-duplication: drops the #hash and trailing slash. A hash that is a screen
 * of a one-page app (#/contacts, #!/leads) is kept: it is a different screen, not a place on the page.
 */
export function normaliseUrl(raw: string): string {
  const u = new URL(raw);
  if (!/^#!?\/./.test(u.hash)) u.hash = "";
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

/**
 * Signed in, a plain link can still change data or the session (cancel an order, switch account,
 * mark everything read), so the crawler also stays away from links that look like actions.
 */
export const UNSAFE_LOGGED_IN =
  /\/(cancel|deactivate|disable|enable|archive|unarchive|approve|reject|revoke|reset|clear|empty|purge|mark[-_]?(as[-_]?)?(read|unread|all|done)|toggle|send|resend|impersonate|switch[-_]?\w*|leave|accept|decline|confirm|verify|install|uninstall|sync|restore|duplicate|clone|copy)(\/|\?|$)|[?&](action|do|op|task|cmd|delete|remove|toggle)=/i;

export function isUnsafeLink(link: string, loggedIn = false): boolean {
  const u = new URL(link);
  const where = u.pathname + u.search;
  return UNSAFE_LINK.test(where) || (loggedIn && UNSAFE_LOGGED_IN.test(where));
}

export function isCrawlable(link: string, origin: string, loggedIn = false): boolean {
  try {
    const u = new URL(link);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.origin === origin &&
      !SKIP_EXT.test(u.pathname) &&
      !isUnsafeLink(link, loggedIn)
    );
  } catch {
    return false;
  }
}

/** Only public http(s) URLs. Blocks localhost and private ranges unless ALLOW_PRIVATE_TARGETS=1. */
export function validateTarget(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("That does not look like a website address.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https are supported.");
  const host = u.hostname;
  const isPrivate =
    host === "localhost" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]";
  if (isPrivate && process.env.ALLOW_PRIVATE_TARGETS !== "1") {
    throw new Error("Private and local addresses are blocked. Set ALLOW_PRIVATE_TARGETS=1 to test them.");
  }
  return u.toString();
}

/** Second-level names under which each customer gets the third level (example.co.in, example.com.au). */
const SHARED_SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|nic|res|gen|firm|ind|ltd|plc|ne|or|go)$/;

/**
 * The site a host belongs to, for "is this file the site's own?": www.shop.example.co.in and
 * cdn.example.co.in both give example.co.in. An IP address or localhost is its own site.
 */
export function siteOf(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const parts = h.split(".");
  const take = parts.length >= 3 && parts.at(-1)!.length === 2 && SHARED_SECOND_LEVEL.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-take).join(".");
}

/** True when the address is on the same site as `host` (any subdomain). */
export function sameSite(url: string, host: string): boolean {
  try {
    return siteOf(new URL(url).hostname) === siteOf(host);
  } catch {
    return false;
  }
}
