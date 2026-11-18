import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, ProductType } from "../../types.js";
import type { SiteAgent } from "../types.js";
import { readOnly } from "./guard.js";

/**
 * The site as an app: its icon in browser tabs and bookmarks, the web app manifest that lets
 * phones install it, and, when it has a service worker, whether it really opens without a network.
 */

/** Products people may install like an app. A company website only needs its icon. */
const APP_PRODUCTS: ProductType[] = ["webapp", "saas", "ecommerce", "crm"];

interface Manifest {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  icons?: { src?: string; sizes?: string; purpose?: string }[];
}

/** What a manifest lacks for phones to offer "Install app" (Chrome's rules). */
export function manifestProblems(m: Manifest): string[] {
  const out: string[] = [];
  if (!m.name && !m.short_name) out.push("no name or short_name");
  if (!m.start_url) out.push("no start_url");
  if (!m.display || !["standalone", "fullscreen", "minimal-ui", "window-controls-overlay"].includes(m.display)) out.push(`display is "${m.display ?? "missing"}": use standalone`);
  const sizes = (m.icons ?? []).flatMap((i) => (i.sizes ?? "").split(/\s+/)).map((s) => Number(s.split("x")[0]) || 0);
  if (!sizes.some((s) => s >= 192)) out.push("no icon of 192×192 or larger");
  if (!sizes.some((s) => s >= 512)) out.push("no icon of 512×512 (used for the splash screen)");
  return out;
}

export const appInstallAgent: SiteAgent = {
  id: "func.app-install",
  name: "Site icon and app install",
  description:
    "Checks the site icon (favicon) shown in tabs and bookmarks, and for web apps, SaaS, CRMs and stores the web app manifest that lets phones install the site like an app. When the site has a service worker, it also checks the start page opens with the network off.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, product, origin }) {
    const first = pages.find((p) => !p.error && (p.status ?? 0) < 400);
    const own = browser.browser();
    if (!first || !own) return [];
    const out: Finding[] = [];
    // A clean window: a service worker and the offline switch must not touch the main test.
    const context = await own.newContext();
    try {
      const page = await context.newPage();
      const guard = await readOnly(page, { loggedIn: true });
      await page.goto(first.url, { waitUntil: "load", timeout: 30_000 });
      guard.stayOn(page.url());
      const facts = (await page.evaluate(`(function () {
        var icon = document.querySelector('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]');
        var manifest = document.querySelector('link[rel="manifest"]');
        return { icon: icon ? icon.href : "", manifest: manifest ? manifest.href : "", sw: "serviceWorker" in navigator };
      })()`)) as { icon: string; manifest: string; sw: boolean };

      const iconUrl = facts.icon || `${origin}/favicon.ico`;
      const icon = await context.request.get(iconUrl, { timeout: 15_000, failOnStatusCode: false }).catch(() => null);
      const iconType = icon?.headers()["content-type"] ?? "";
      if (!icon || !icon.ok() || /text\/html/.test(iconType)) {
        out.push(
          finding({
            category: "functional",
            rule: "app:no-favicon",
            severity: "low",
            title: facts.icon ? "The site icon (favicon) does not load" : "The site has no icon (favicon)",
            detail:
              'Browser tabs, bookmarks and Google\'s results show a blank or broken icon instead of your logo. Add <link rel="icon" href="/favicon.svg"> (or a 48×48 PNG) and an apple-touch-icon of 180×180.',
            pageUrl: first.url,
            evidence: `${iconUrl}: ${icon ? `HTTP ${icon.status()}${iconType ? `, ${iconType.split(";")[0]}` : ""}` : "no answer"}`,
          }),
        );
      }

      if (APP_PRODUCTS.includes(product)) {
        if (!facts.manifest) {
          out.push(
            finding({
              category: "functional",
              rule: "app:no-manifest",
              severity: "info",
              title: "The site cannot be installed like an app (no web app manifest)",
              detail:
                'With a manifest, phones and computers offer "Install app" and open the site in its own window with your icon. Add <link rel="manifest" href="/manifest.webmanifest"> with name, start_url, display: standalone and icons of 192 and 512 px.',
              pageUrl: first.url,
            }),
          );
        } else {
          const res = await context.request.get(facts.manifest, { timeout: 15_000, failOnStatusCode: false }).catch(() => null);
          let problems: string[];
          if (!res || !res.ok()) problems = [`the manifest does not load (${res ? `HTTP ${res.status()}` : "no answer"})`];
          else {
            try {
              problems = manifestProblems(JSON.parse(await res.text()) as Manifest);
            } catch {
              problems = ["the manifest is not valid JSON"];
            }
          }
          if (problems.length) {
            out.push(
              finding({
                category: "functional",
                rule: "app:manifest-incomplete",
                severity: "low",
                title: "The web app manifest is incomplete, so phones do not offer to install the site",
                detail: "Chrome and Edge offer \"Install app\" only when the manifest has a name, a start_url, display: standalone and icons of 192 and 512 px.",
                pageUrl: first.url,
                evidence: `${facts.manifest}\n${problems.join("\n")}`,
              }),
            );
          }
        }
      }

      if (facts.sw) {
        const ready = (await page
          .evaluate(`navigator.serviceWorker.getRegistration().then(function (r) {
            if (!r) return false;
            return Promise.race([navigator.serviceWorker.ready.then(function () { return true; }), new Promise(function (res) { setTimeout(function () { res(false); }, 8000); })]);
          })`)
          .catch(() => false)) as boolean;
        if (ready) {
          await context.setOffline(true);
          const offline = await page.reload({ waitUntil: "load", timeout: 15_000 }).then(
            () => page.evaluate("location.protocol !== 'chrome-error:' && !!document.body && document.body.innerText.trim().length > 20"),
            () => false,
          );
          if (!offline) {
            out.push(
              finding({
                category: "functional",
                rule: "app:offline-broken",
                severity: "low",
                title: "The site has a service worker but shows an error without a network",
                detail:
                  "A service worker usually means the site should open offline, or at least show its own \"You are offline\" page. Cache the start page and an offline page in the service worker's install step, and answer navigations from the cache when the network fails.",
                pageUrl: first.url,
              }),
            );
          }
        }
      }
      await guard.off();
    } catch {
      // The crawler already reports pages that cannot be opened.
    } finally {
      await context.close().catch(() => {});
    }
    return out;
  },
};
