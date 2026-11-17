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

