/** URL rules shared by the crawler and the link checker. */

export const SKIP_EXT =
  /\.(pdf|zip|rar|7z|gz|jpe?g|png|gif|webp|svg|ico|mp4|mp3|webm|avi|mov|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;
/** Links a crawler must never follow: they log out or change data. */

export const UNSAFE_LINK =
  /\/(log-?out|sign-?out|logoff|delete|remove|destroy|unsubscribe)(\/|\?|$)|[?&](action|do)=(delete|remove|logout)/i;

/** Normalises a URL for de-duplication: drops the #hash and trailing slash. */
export function normaliseUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function isCrawlable(link: string, origin: string): boolean {
  try {
    const u = new URL(link);
    return (
      (u.protocol === "http:" || u.protocol === "https:") &&
      u.origin === origin &&
      !SKIP_EXT.test(u.pathname) &&
      !UNSAFE_LINK.test(u.pathname + u.search)
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
