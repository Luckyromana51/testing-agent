import type { BrowserContext } from "playwright";
import { finding } from "../../runner/finding.js";
import { SKIP_EXT, UNSAFE_LINK } from "../../runner/urls.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { SiteAgent } from "../types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Social networks answer automated requests with 999, 403 or a login wall, so a check proves nothing. */
const BOT_BLOCKING_HOSTS =
  /(^|\.)(linkedin\.com|facebook\.com|fb\.com|instagram\.com|x\.com|twitter\.com|wa\.me|whatsapp\.com|t\.me|tiktok\.com|pinterest\.com|threads\.net)$/i;

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  410: "Gone",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};
const describeStatus = (s: number) => `HTTP ${s}${STATUS_TEXT[s] ? ` ${STATUS_TEXT[s]}` : ""}`;

/** One request with HEAD, then GET if HEAD fails or is refused (many servers mishandle HEAD). */
async function probe(context: BrowserContext, link: string): Promise<{ status: number; error: string }> {
  const opts = { timeout: 15_000, maxRedirects: 5 };
  try {
    const res = await context.request.head(link, opts);
    if (res.status() < 400) return { status: res.status(), error: "" };
  } catch {
    // fall through to GET
  }
  try {
    const res = await context.request.get(link, opts);
    return { status: res.status(), error: "" };
  } catch (e) {
    return { status: 0, error: (e as Error).message.split("\n")[0] };
  }
}

/** Loads the link in a real browser tab, which is what a visitor would get. */
async function browserStatus(context: BrowserContext, link: string): Promise<{ status: number; error: string }> {
  const page = await context.newPage();
  try {
    const res = await page.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return { status: res?.status() ?? 0, error: "" };
  } catch (e) {
    return { status: 0, error: (e as Error).message.split("\n")[0] };
  } finally {
    await page.close();
  }
}

/**
 * Checks every link that was not already opened as a page.
 * A link is only reported as broken after a second look: internal links are re-opened in a real
 * browser after a pause (so rate limiting or a brief outage is not reported as broken), and other
 * sites are retried once. At most 2 requests go to the same host at a time.
 */
export async function checkLinks(
  context: BrowserContext,
  origin: string,
  linkSources: Map<string, string>,
  onProgress?: (m: string) => void,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const all = [...linkSources.keys()];
  // Never open log-out or delete links, even to check them: that would end a logged-in session.
  const unsafe = all.filter((l) => UNSAFE_LINK.test(new URL(l).pathname + new URL(l).search));
  const skipped = all.filter((l) => BOT_BLOCKING_HOSTS.test(new URL(l).hostname) || unsafe.includes(l));
  const links = all.filter((l) => !skipped.includes(l)).slice(0, 200);
  onProgress?.(
    `Checking ${links.length} links${skipped.length ? ` (skipping ${skipped.length - unsafe.length} social media links, which block automated checks, and ${unsafe.length} log-out or delete links)` : ""}`,
  );

  const perHost = new Map<string, number>();
  const withHostSlot = async <T>(host: string, fn: () => Promise<T>): Promise<T> => {
    while ((perHost.get(host) ?? 0) >= 2) await sleep(50);
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      perHost.set(host, (perHost.get(host) ?? 1) - 1);
    }
  };

  let i = 0;
  const worker = async () => {
    while (i < links.length) {
      const link = links[i++];
      const host = new URL(link).host;
      const internal = new URL(link).origin === origin;
      const failed = (r: { status: number; error: string }) =>
        Boolean(r.error) || r.status === 0 || (r.status >= 400 && ![401, 403, 429].includes(r.status));

      let r = await withHostSlot(host, () => probe(context, link));
      if (!failed(r)) continue;
      // Second look before reporting anything.
      await sleep(2000);
      // Internal pages get a real browser; files (PDFs and so on) would only start a download there.
      const isPage = internal && !SKIP_EXT.test(new URL(link).pathname);
      r = await withHostSlot(host, () => (isPage ? browserStatus(context, link) : probe(context, link)));
      if (!failed(r)) continue;

      const source = linkSources.get(link) ?? link;
      const what = r.error ? r.error : describeStatus(r.status);
      if (internal) {
        out.push(
          finding({
            category: "functional",
            rule: "broken-link",
            severity: "high",
            title: "Broken link on your site",
            detail: `Visitors who click this link get an error (${what}). Checked twice, a few seconds apart, so this is not a brief outage.`,
            pageUrl: source,
            evidence: `${link}  (${r.error ? "could not be reached" : describeStatus(r.status)})`,
          }),
        );
      } else if (r.status === 404 || r.status === 410) {
        out.push(
          finding({
            category: "functional",
            rule: "broken-external-link",
            severity: "medium",
            title: "Link to another website is broken",
            detail: `The page this links to no longer exists (${what}). Update or remove the link.`,
            pageUrl: source,
            evidence: `${link}  (${describeStatus(r.status)})`,
          }),
        );
      } else {
        // Other sites often refuse automated checks (503, timeouts), so this is not proof of a broken link.
        out.push(
          finding({
            category: "functional",
            rule: "unverified-external-link",
            severity: "info",
            title: "Link to another website could not be checked",
            detail: `${what}. Many sites block automated checks, so open it by hand to confirm.`,
            pageUrl: source,
            evidence: `${link}  (${r.error ? "no answer" : describeStatus(r.status)})`,
          }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return out;
}

export const linksAgent: SiteAgent = {
  id: "web.links",
  name: "Link checker",
  description:
    "Checks every link on every page. A link is only called broken after a second look a few seconds later, in a real browser for your own pages.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run({ browser, origin, linkSources, pages, log }) {
    const toCheck = new Map(linkSources);
    // Pages we already visited were checked by loading them.
    for (const p of pages) {
      toCheck.delete(p.url);
      if (p.redirectedFrom) toCheck.delete(p.redirectedFrom);
    }
    return checkLinks(browser, origin, toCheck, log);
  },
};
