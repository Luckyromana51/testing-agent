import type { APIResponse, Page } from "playwright";
import { countCases } from "../../runner/cases.js";
import { finding } from "../../runner/finding.js";
import { isUnsafeLink, sameSite } from "../../runner/urls.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, PageResult } from "../../types.js";
import type { PageAgent, SiteAgent } from "../types.js";
import { readOnly } from "./guard.js";

/**
 * Website checks for the testing types of the testing handbook that the other agents did not
 * cover yet: browser back and forward, file downloads, caching, cookies, navigation, spelling and
 * content accuracy, and reliability (the same page asked for again and again, and at the same time).
 * Every check only reads: GET and HEAD requests, nothing typed or sent.
 */

const list = (items: string[], max = 8) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const goodPages = (pages: PageResult[], max: number) => pages.filter((p) => !p.error && (p.status ?? 0) < 400).slice(0, max);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pathOf = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};
const sameDoc = (a: string, b: string) => a.split("#")[0].replace(/\/$/, "") === b.split("#")[0].replace(/\/$/, "");

// ---------------------------------------------------------------------------------------------
// Browser back and forward

export const backForwardAgent: SiteAgent = {
  id: "func.back-forward",
  name: "Back and forward buttons",
  description:
    "Opens three pages one after another, then presses the browser's Back twice and Forward once: each press must show the right page with its title and no script errors, and the back/forward cache (instant Back) should not be blocked.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, site }) {
    const trail = goodPages(pages, 3).filter((p) => !isUnsafeLink(p.url, site.loggedIn));
    if (trail.length < 2) return [];
    const page: Page = await browser.newPage();
    const guard = await readOnly(page, { loggedIn: site.loggedIn, unsafe: site.unsafe });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));
    const out: Finding[] = [];
    const wrong: string[] = [];
    let tried = 0;
    try {
      // Errors a page already shows on a normal visit are reported by the console check, not here.
      const known = new Set<string>();
      for (const p of trail) {
        await page.goto(p.url, { waitUntil: "load", timeout: 30_000 });
        await sleep(300);
      }
      for (const e of errors) known.add(e);
      const steps: { press: "back" | "forward"; expect: PageResult }[] = [];
      for (let i = trail.length - 2; i >= 0; i--) steps.push({ press: "back", expect: trail[i] });
      steps.push({ press: "forward", expect: trail[1] });
      let blocked: string[] = [];
      for (const s of steps) {
        tried++;
        const before = errors.length;
        const res = s.press === "back" ? await page.goBack({ waitUntil: "load", timeout: 20_000 }).catch(() => null) : await page.goForward({ waitUntil: "load", timeout: 20_000 }).catch(() => null);
        await sleep(300);
        const now = page.url();
        const title = await page.title().catch(() => "");
        if (!sameDoc(now, s.expect.url)) wrong.push(`${s.press === "back" ? "Back" : "Forward"}: expected ${pathOf(s.expect.url)}, the browser showed ${pathOf(now)}`);
        else if (s.expect.title && title && title !== s.expect.title) wrong.push(`${s.press === "back" ? "Back" : "Forward"} to ${pathOf(now)}: the title is "${title.slice(0, 60)}", it was "${s.expect.title.slice(0, 60)}"`);
        else if (errors.slice(before).some((e) => !known.has(e))) wrong.push(`${s.press === "back" ? "Back" : "Forward"} to ${pathOf(now)}: ${errors.slice(before).filter((e) => !known.has(e)).slice(0, 2).join("; ")}`);
        else if (res && res.status() >= 400) wrong.push(`${s.press === "back" ? "Back" : "Forward"} to ${pathOf(now)}: HTTP ${res.status()}`);
        // Chrome says why a page could not come back from the back/forward cache.
        if (s.press === "back" && !blocked.length) {
          blocked = (await page
            .evaluate(`(function () {
              var n = performance.getEntriesByType("navigation")[0];
              if (!n || n.type !== "back_forward" || !n.notRestoredReasons) return [];
              var out = [];
              var walk = function (r) { if (!r) return; (r.reasons || []).forEach(function (x) { out.push(typeof x === "string" ? x : x.reason); }); (r.children || []).forEach(walk); };
              walk(n.notRestoredReasons);
              return out.filter(Boolean);
            })()`)
            .catch(() => [])) as string[];
        }
      }
      countCases(tried + 1, wrong.length + (blocked.length ? 1 : 0));
      if (wrong.length) {
        out.push(
          finding({
            category: "functional",
            rule: "nav:back-forward-broken",
            severity: "medium",
            title: "The Back or Forward button does not return to the right page",
            detail:
              "After visiting three pages, Back and Forward must show the pages in order. Here a press showed another page, changed the title or caused a script error. Single-page apps must push a history entry for each screen (history.pushState) and restore the screen on popstate.",
            pageUrl: trail[0].url,
            evidence: list(wrong),
            count: wrong.length,
          }),
        );
      }
      const reasons = [...new Set(blocked)].filter((r) => !/^(masked|NotMainFrame)$/i.test(r));
      if (reasons.length) {
        out.push(
          finding({
            category: "performance",
            rule: "perf:bfcache-blocked",
            severity: "low",
            title: "Going Back reloads the page instead of showing it at once",
            detail:
              "Browsers keep the last pages in a back/forward cache so Back is instant, but this page cannot use it. The usual causes are an unload handler, Cache-Control: no-store on public pages, or an open WebSocket or IndexedDB connection. Use pagehide instead of unload.",
            pageUrl: trail[0].url,
            evidence: reasons.slice(0, 6).join(", "),
          }),
        );
      }
    } finally {
      await guard.off();
      await page.close().catch(() => {});
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// File downloads

const FILE_LINK = /\.(pdf|zip|docx?|xlsx?|pptx?|csv|txt|apk|epub|odt|ods|rtf|gz|tgz|rar|7z|mp3|mp4|ics|vcf|json|xml)$/i;
/** The first bytes of each kind of file. */
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  pdf: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b,
  gz: (b) => b[0] === 0x1f && b[1] === 0x8b,
  rar: (b) => b.subarray(0, 4).toString("latin1") === "Rar!",
  "7z": (b) => b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc,
  ole: (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11,
  rtf: (b) => b.subarray(0, 5).toString("latin1") === "{\\rtf",
  mp4: (b) => b.subarray(4, 8).toString("latin1") === "ftyp",
  mp3: (b) => b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0),
};
const MAGIC_FOR: Record<string, string> = {
  pdf: "pdf",
  zip: "zip",
  docx: "zip",
  xlsx: "zip",
  pptx: "zip",
  apk: "zip",
  epub: "zip",
  odt: "zip",
  ods: "zip",
  doc: "ole",
  xls: "ole",
  ppt: "ole",
  gz: "gz",
  tgz: "gz",
  rar: "rar",
  "7z": "7z",
  rtf: "rtf",
  mp4: "mp4",
  mp3: "mp3",
};

export const downloadsAgent: SiteAgent = {
  id: "func.downloads",
  name: "File downloads",
  description:
    "Finds links to files (PDF brochures, price lists, Word and Excel files, CSV exports, APKs, zips) and fetches the start of each one: it must answer, not be empty, really be that kind of file (not a web page or an error page saved as .pdf), be sent over HTTPS, and be named sensibly when saved.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, linkSources, origin, site }) {
    const host = new URL(origin).hostname;
    const files = [...linkSources.keys()]
      .filter((u) => {
        try {
          const x = new URL(u);
          return /^https?:$/.test(x.protocol) && FILE_LINK.test(x.pathname) && !isUnsafeLink(u, site.loggedIn) && !site.unsafe?.test(u);
        } catch {
          return false;
        }
      })
      .sort((a, b) => Number(sameSite(b, host)) - Number(sameSite(a, host)) || a.localeCompare(b))
      .slice(0, 15);
    if (!files.length) return [];
    const problems: Record<string, string[]> = {};
    const add = (rule: string, line: string) => (problems[rule] ??= []).push(line);
    let tried = 0;
    let failed = 0;
    const secure = origin.startsWith("https:");
    for (const url of files) {
      const ext = new URL(url).pathname.split(".").pop()!.toLowerCase();
      const from = linkSources.get(url) ?? origin;
      let res: APIResponse | null = null;
      try {
        res = await browser.request.get(url, { headers: { Range: "bytes=0-4095" }, timeout: 20_000, maxRedirects: 5, failOnStatusCode: false });
      } catch {
        continue; // unreachable: the link checker reports it
      }
      const status = res.status();
      if (status >= 400) continue; // a broken link: the link checker reports it
      const body = await res.body().catch(() => Buffer.alloc(0));
      const type = (res.headers()["content-type"] ?? "").toLowerCase();
      const disposition = res.headers()["content-disposition"] ?? "";
      const total = Number(/\/(\d+)$/.exec(res.headers()["content-range"] ?? "")?.[1] ?? res.headers()["content-length"] ?? body.length);
      const line = `${pathOf(url)} (linked from ${pathOf(from)})`;
      // Case 1: not empty.
      tried++;
      if (!body.length || total === 0) {
        failed++;
        add("download:empty", line);
        continue;
      }
      // Case 2: not a web page in disguise.
      tried++;
      const looksHtml = /text\/html/.test(type) || /^\s*<(!doctype html|html|head|body)/i.test(body.subarray(0, 200).toString("latin1"));
      if (looksHtml && !["txt", "json", "xml", "csv"].includes(ext)) {
        failed++;
        add("download:html-instead", `${line}: a web page (${type || "text/html"})`);
        continue;
      }
      // Case 3: the file's first bytes match its kind.
      const magic = MAGIC_FOR[ext];
      if (magic) {
        tried++;
        if (!MAGIC[magic](body)) {
          failed++;
          add("download:corrupt", `${line}: does not start like a .${ext} file`);
        }
      }
      // Case 4: over HTTPS from an HTTPS site.
      if (secure) {
        tried++;
        if (res.url().startsWith("http:")) {
          failed++;
          add("download:plain-http", line);
        }
      }
      // Case 5: the saved name has the right extension.
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      if (named) {
        tried++;
        const savedExt = decodeURIComponent(named).split(".").pop()?.toLowerCase();
        if (savedExt && savedExt !== ext && !(ext === "tgz" && savedExt === "gz")) {
          failed++;
          add("download:wrong-name", `${line}: saved as "${decodeURIComponent(named).slice(0, 60)}"`);
        }
      }
      // Case 6: a type the browser understands.
      tried++;
      if (/application\/octet-stream/.test(type) && ext === "pdf") {
        failed++;
        add("download:generic-type", `${line}: sent as application/octet-stream`);
      }
    }
    countCases(tried, failed);
    const RULES: Record<string, { severity: Finding["severity"]; title: string; detail: string; category?: Finding["category"] }> = {
      "download:empty": { severity: "high", title: "Download links give an empty file", detail: "The file answers but has no content, so visitors save a 0-byte file. Upload the file again and check the server can read it." },
      "download:html-instead": { severity: "high", title: "Download links give a web page instead of the file", detail: "The link ends in a file name but the server sends a web page (often the home page, a login page or a missing-page screen with HTTP 200), so the saved file does not open. Put the file back at this address or fix the link." },
      "download:corrupt": { severity: "medium", title: "Downloaded files are not the kind of file their name says", detail: "The first bytes do not match the file type (a PDF must start with %PDF-, Word and Excel files with PK). The file is damaged or renamed, so it will not open. Export it again from the original program." },
      "download:plain-http": { severity: "medium", title: "Files download over plain HTTP from a secure site", detail: "Browsers warn about or block insecure downloads from HTTPS pages, and anyone on the network can swap the file. Serve the file over HTTPS.", category: "security" },
      "download:wrong-name": { severity: "low", title: "Downloaded files are saved with the wrong name", detail: "The server's Content-Disposition header names the file with a different extension from the link, so the computer may not know how to open it. Fix the file name in the header." },
      "download:generic-type": { severity: "low", title: "PDFs are sent as a generic file", detail: "The PDF is sent as application/octet-stream, so browsers save it instead of opening it and phones may not offer a viewer. Send PDFs as application/pdf." },
    };
    return Object.entries(problems).map(([rule, lines]) =>
      finding({ category: RULES[rule].category ?? "functional", rule, severity: RULES[rule].severity, title: RULES[rule].title, detail: RULES[rule].detail, pageUrl: linkSources.get(files[0]) ?? origin, evidence: list(lines), count: lines.length }),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// Caching

/** A file name with a content hash in it (app.3f9a1c2b.js): safe to cache for a year. */
const HASHED = /[.-][a-f0-9]{8,}\.|[.-][A-Za-z0-9_]{8,}\.(js|css|woff2?)$|[?&](v|ver|version|hash)=/;

export const cacheAgent: SiteAgent = {
  id: "web.cache",
  name: "Caching",
  description:
    "Asks again for the pages and their scripts, styles, fonts and images the way a browser does when it already has a copy (If-None-Match / If-Modified-Since): the server should answer 304 Not Modified. Also finds files marked immutable that are not versioned, web pages cached so long that visitors see old content, and cached answers that set cookies (a CDN could hand one visitor's cookie to others).",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, origin, site }) {
    const start = goodPages(pages, 1)[0];
    if (!start) return [];
    const host = new URL(origin).hostname;
    const page: Page = await browser.newPage();
    const seen = new Map<string, { type: string; headers: Record<string, string> }>();
    page.on("response", (r) => {
      const req = r.request();
      if (req.method() !== "GET" || r.status() !== 200 || seen.size >= 40) return;
      const type = req.resourceType();
      if (!["document", "script", "stylesheet", "image", "font"].includes(type) || !sameSite(r.url(), host)) return;
      // Only the address and kind: the browser may have answered from its own cache, and a
      // cached answer has no Set-Cookie, so the headers are read again below, fresh.
      if (!seen.has(r.url())) seen.set(r.url(), { type, headers: {} });
    });
    try {
      await page.goto(start.url, { waitUntil: "load", timeout: 30_000 });
    } catch {
      /* whatever loaded is enough */
    } finally {
      await page.close().catch(() => {});
    }
    for (const p of goodPages(pages, 4).slice(1)) {
      if (!seen.has(p.url)) seen.set(p.url, { type: "document", headers: {} });
    }
    const problems: Record<string, string[]> = {};
    const add = (rule: string, line: string) => (problems[rule] ??= []).push(line);
    let tried = 0;
    let failed = 0;
    const entries = [...seen].slice(0, 25);
    for (const [url, info] of entries) {
      if (isUnsafeLink(url, site.loggedIn)) continue;
      let headers = info.headers;
      if (!Object.keys(headers).length) {
        const r = await browser.request.get(url, { timeout: 20_000, failOnStatusCode: false }).catch(() => null);
        if (!r || r.status() !== 200) continue;
        headers = r.headers();
      }
      const cc = (headers["cache-control"] ?? "").toLowerCase();
      const maxAge = Number(/max-age=(\d+)/.exec(cc)?.[1] ?? /s-maxage=(\d+)/.exec(cc)?.[1] ?? 0);
      const etag = headers["etag"];
      const modified = headers["last-modified"];
      const name = `${pathOf(url)}${cc ? ` (Cache-Control: ${cc.slice(0, 60)})` : ""}`;
      // Case: revalidation answers 304.
      if ((etag || modified) && !/no-store/.test(cc)) {
        tried++;
        const cond: Record<string, string> = {};
        if (etag) cond["If-None-Match"] = etag;
        if (modified) cond["If-Modified-Since"] = modified;
        const again = await browser.request.get(url, { headers: cond, timeout: 20_000, failOnStatusCode: false, maxRedirects: 0 }).catch(() => null);
        if (again && again.status() === 200) {
          failed++;
          add("cache:no-304", `${pathOf(url)}: has ${etag ? "an ETag" : "Last-Modified"} but answers 200 with the whole file again`);
        }
      }
      // Case: immutable only on versioned names.
      if (info.type !== "document") {
        tried++;
        if (/immutable/.test(cc) && !HASHED.test(new URL(url).pathname + new URL(url).search)) {
          failed++;
          add("cache:immutable-unversioned", name);
        }
      }
      // Case: web pages not cached for days without a way to check for a newer copy.
      if (info.type === "document") {
        tried++;
        if (maxAge >= 86_400 && !etag && !modified && !/no-cache|must-revalidate/.test(cc)) {
          failed++;
          add("cache:html-stale", name);
        }
      }
      // Case: a cookie on an answer shared caches may keep.
      tried++;
      if (headers["set-cookie"] && /public|s-maxage/.test(cc) && !/private|no-store/.test(cc)) {
        failed++;
        add("cache:cookie-on-public", `${pathOf(url)}: Set-Cookie with ${cc.slice(0, 60)}`);
      }
    }
    countCases(tried, failed);
    const RULES: Record<string, { severity: Finding["severity"]; title: string; detail: string; category?: Finding["category"] }> = {
      "cache:no-304": { severity: "low", title: "The server sends whole files again instead of \"not changed\"", detail: "Browsers that already have the file ask whether it changed. The server answers with the whole file (200) instead of 304 Not Modified, so repeat visits download everything again. Turn on ETag or Last-Modified handling in the web server or CDN (it is often lost behind a proxy that changes the file, such as on-the-fly compression)." },
      "cache:immutable-unversioned": { severity: "medium", title: "Files are cached forever but their names never change", detail: "Cache-Control: immutable tells browsers never to check the file again, but its name has no version or hash, so when you change it visitors keep the old copy for up to a year. Use immutable only on names that change with the content (app.3f9a1c.js), or drop immutable." },
      "cache:html-stale": { severity: "low", title: "Pages are cached for a day or more with no way to check for updates", detail: "The page may be kept for a day or more and has no ETag or Last-Modified, so after you change it visitors and CDNs keep showing the old page. Cache web pages briefly (max-age=300) or with no-cache plus an ETag." },
      "cache:cookie-on-public": { severity: "medium", title: "Cached answers set cookies", detail: "The answer may be stored by shared caches (public or s-maxage) and also sets a cookie, so a CDN can hand one visitor's cookie, or session, to others. Never set cookies on public cached answers: mark them private, or move the cookie to an uncached call.", category: "security" },
    };
    return Object.entries(problems).map(([rule, lines]) =>
      finding({ category: RULES[rule].category ?? "performance", rule, severity: RULES[rule].severity, title: RULES[rule].title, detail: RULES[rule].detail, pageUrl: start.url, evidence: list(lines), count: lines.length }),
    );
  },
};

// ---------------------------------------------------------------------------------------------
// Cookies

/** Cookies of well-known analytics and advertising tools. */
const TRACKER_COOKIE = /^(_ga(_.*)?|_gid|_gat.*|_gcl_\w+|_fbp|_fbc|fr|IDE|test_cookie|_hj\w+|_clck|_clsk|MUID|_uetsid|_uetvid|_ttp|_pin_unauth|_scid|li_sugr|bcookie|lidc|AnalyticsSyncHistory|hubspotutk|__hstc|__hssc|_mkto_trk|ajs_anonymous_id|mp_\w+_mixpanel|amplitude_id\w*|_tt_enable_cookie|_rdt_uuid)$/;
const SESSIONISH = /sess|sid$|^sid|auth|token|login|jwt|remember/i;
const DAY = 86_400;

export const cookiesAgent: SiteAgent = {
  id: "web.cookies",
  name: "Cookies",
  description:
    "Reads every cookie set during the test, without its value: tracking cookies set although nobody accepted the consent banner, cookies kept longer than 13 months, cookies over 4 KB, so many cookies that requests get rejected, and login cookies shared with every subdomain.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, origin, pages }) {
    const all = await browser.cookies().catch(() => []);
    if (!all.length) return [];
    const host = new URL(origin).hostname;
    const now = Date.now() / 1000;
    const out: Finding[] = [];
    let tried = 0;
    let failed = 0;
    const where = goodPages(pages, 1)[0]?.url ?? origin;
    // The crawl never accepts a consent banner, so tracking cookies here were set before consent.
    const trackers = all.filter((c) => TRACKER_COOKIE.test(c.name));
    let banner = false;
    if (trackers.length) {
      const page: Page = await browser.newPage();
      try {
        await page.goto(where, { waitUntil: "load", timeout: 30_000 });
        banner = (await page.evaluate(`(function () {
          var els = document.querySelectorAll("[id*=cookie i], [class*=cookie i], [id*=consent i], [class*=consent i], [aria-label*=cookie i], [aria-label*=consent i]");
          for (var i = 0; i < els.length; i++) { var r = els[i].getBoundingClientRect(); if (r.width > 100 && r.height > 30 && /accept|allow|agree|ok|got it|reject|decline/i.test(els[i].innerText || "")) return true; }
          return false;
        })()`)) as boolean;
      } catch {
        banner = false;
      } finally {
        await page.close().catch(() => {});
      }
    }
    tried++;
    if (trackers.length && banner) {
      failed++;
      out.push(
        finding({
          category: "security",
          rule: "cookie:tracking-before-consent",
          severity: "high",
          title: "Tracking cookies are set before visitors accept the cookie banner",
          detail:
            "The site shows a consent banner, but analytics or advertising cookies were already set although nobody clicked Accept. Under GDPR and India's DPDP Act the banner must come first: load these tools only after consent (Google Consent Mode default 'denied', or your consent tool's script blocking).",
          pageUrl: where,
          evidence: list([...new Set(trackers.map((c) => `${c.name} (${c.domain})`))]),
        }),
      );
    }
    const long = all.filter((c) => c.expires > 0 && c.expires - now > 396 * DAY);
    tried += all.length;
    if (long.length) {
      failed += long.length;
      out.push(
        finding({
          category: "security",
          rule: "cookie:too-long",
          severity: "low",
          title: "Cookies are kept for more than 13 months",
          detail: "European regulators (CNIL, ICO) expect tracking cookies to last at most 13 months (Chrome already cuts every cookie to 400 days). Set a shorter Max-Age or Expires.",
          pageUrl: where,
          evidence: list(long.map((c) => `${c.name} (${c.domain}): ${Math.round((c.expires - now) / DAY / 30)} months`)),
          count: long.length,
        }),
      );
    }
    const big = all.filter((c) => c.name.length + c.value.length > 4096);
    tried += all.length;
    if (big.length) {
      failed += big.length;
      out.push(finding({ category: "functional", rule: "cookie:too-big", severity: "medium", title: "Cookies over 4 KB", detail: "Browsers drop cookies over 4,096 bytes, so whatever the site keeps in them (cart, settings, login) is silently lost. Keep a short id in the cookie and the data on the server.", pageUrl: where, evidence: list(big.map((c) => `${c.name}: ${c.name.length + c.value.length} bytes`)) }));
    }
    const mine = all.filter((c) => sameSite(`https://${c.domain.replace(/^\./, "")}/`, host));
    const header = mine.reduce((n, c) => n + c.name.length + c.value.length + 3, 0);
    tried++;
    if (mine.length > 50 || header > 7_000) {
      failed++;
      out.push(finding({ category: "functional", rule: "cookie:too-many", severity: header > 7_000 ? "medium" : "low", title: "So many cookies that requests may be refused", detail: `The site's own cookies add up to ${mine.length} cookies and about ${Math.round(header / 1024)} KB on every request. Many servers and CDNs refuse requests with headers over 8 KB (HTTP 400 or 431, "Request header too large"), which looks to the visitor like the site is down. Remove cookies the site no longer needs.`, pageUrl: where, evidence: `${mine.length} cookies, ${header.toLocaleString("en-IN")} bytes in the Cookie header` }));
    }
    const wide = mine.filter((c) => c.domain.startsWith(".") && SESSIONISH.test(c.name) && c.domain.replace(/^\./, "") !== host);
    tried += mine.filter((c) => SESSIONISH.test(c.name)).length;
    if (wide.length) {
      failed += wide.length;
      out.push(finding({ category: "security", rule: "cookie:shared-with-subdomains", severity: "low", title: "Login cookies are shared with every subdomain", detail: "The session cookie is set for the whole domain (Domain=.example.com), so every subdomain, including a forgotten test site or a blog run by another company, receives it and can steal it. Leave out the Domain attribute (or use the __Host- prefix) so only this site gets it.", pageUrl: where, evidence: list(wide.map((c) => `${c.name} (Domain=${c.domain})`)) }));
    }
    countCases(tried, failed);
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Navigation

interface NavFacts {
  menu: string[];
  hasNav: boolean;
  logoHome: boolean | null;
  current: boolean;
  breadcrumb: boolean;
}

const NAV_JS = `(function () {
  var norm = function (h) { try { var u = new URL(h, location.href); return u.origin === location.origin ? u.pathname.replace(/\\/$/, "") || "/" : ""; } catch (e) { return ""; } };
  var navs = document.querySelectorAll("header nav, nav, [role=navigation]");
  var menu = [];
  var current = false;
  for (var i = 0; i < navs.length && i < 3; i++) {
    var n = navs[i];
    if (/breadcrumb/i.test((n.getAttribute("aria-label") || "") + " " + n.className)) continue;
    var as = n.querySelectorAll("a[href]");
    for (var j = 0; j < as.length && menu.length < 60; j++) {
      var p = norm(as[j].getAttribute("href"));
      if (p && menu.indexOf(p) < 0) menu.push(p);
      if (p === (location.pathname.replace(/\\/$/, "") || "/") && (as[j].getAttribute("aria-current") || /\\b(active|current|selected)\\b/.test(as[j].className + " " + (as[j].parentElement ? as[j].parentElement.className : "")))) current = true;
    }
  }
  var logo = document.querySelector("header a img, header a svg, a.logo, .logo a, a[rel=home], .navbar-brand, .site-title a, .custom-logo-link");
  var link = logo ? (logo.tagName === "A" ? logo : logo.closest("a")) : null;
  var logoHome = link ? (norm(link.getAttribute("href")) === "/" || norm(link.getAttribute("href")) === "") && link.getAttribute("href") !== "#" : null;
  var breadcrumb = Boolean(document.querySelector("[aria-label*=breadcrumb i], .breadcrumb, .breadcrumbs, #breadcrumbs, .woocommerce-breadcrumb, [itemtype*=BreadcrumbList]")) || /BreadcrumbList/.test(Array.prototype.map.call(document.querySelectorAll('script[type="application/ld+json"]'), function (s) { return s.textContent; }).join(" "));
  return { menu: menu, hasNav: menu.length > 0, logoHome: logoHome, current: current, breadcrumb: breadcrumb };
})()`;

export const navigationAgent: SiteAgent = {
  id: "func.navigation",
  name: "Navigation and menus",
  description:
    "Opens up to 8 pages and compares their menus: the main menu should be the same everywhere and never vanish, the logo should lead home, the menu should show which page you are on, and pages two or more levels deep should have breadcrumbs.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, pages, site }) {
    const sample = goodPages(pages, 8).filter((p) => !isUnsafeLink(p.url, site.loggedIn));
    if (sample.length < 2) return [];
    const page: Page = await browser.newPage();
    const guard = await readOnly(page, { loggedIn: site.loggedIn, unsafe: site.unsafe });
    const facts: { url: string; f: NavFacts }[] = [];
    try {
      for (const p of sample) {
        try {
          await page.goto(p.url, { waitUntil: "load", timeout: 30_000 });
          facts.push({ url: p.url, f: (await page.evaluate(NAV_JS)) as NavFacts });
        } catch {
          /* a page that fails now was reported by the crawl */
        }
      }
    } finally {
      await guard.off();
      await page.close().catch(() => {});
    }
    if (facts.length < 2) return [];
    const home = facts[0];
    const out: Finding[] = [];
    let tried = 0;
    let failed = 0;
    const missingNav: string[] = [];
    const different: string[] = [];
    const notHome: string[] = [];
    const noCurrent: string[] = [];
    const noCrumbs: string[] = [];
    const homeMenu = new Set(home.f.menu);
    for (const { url, f } of facts) {
      if (home.f.hasNav) {
        tried++;
        if (!f.hasNav) missingNav.push(pathOf(url));
        else if (url !== home.url) {
          const shared = f.menu.filter((m) => homeMenu.has(m)).length;
          if (homeMenu.size >= 3 && shared / homeMenu.size < 0.5) different.push(`${pathOf(url)}: ${shared} of the home page's ${homeMenu.size} menu links`);
        }
      }
      if (f.logoHome !== null) {
        tried++;
        if (!f.logoHome) notHome.push(pathOf(url));
      }
      if (f.hasNav && url !== home.url && f.menu.includes(new URL(url).pathname.replace(/\/$/, "") || "/")) {
        tried++;
        if (!f.current) noCurrent.push(pathOf(url));
      }
      const depth = new URL(url).pathname.split("/").filter(Boolean).length;
      if (depth >= 2 && !site.loggedIn) {
        tried++;
        if (!f.breadcrumb) noCrumbs.push(pathOf(url));
      }
    }
    failed = missingNav.length + different.length + notHome.length + noCurrent.length + noCrumbs.length;
    countCases(tried, failed);
    const add = (items: string[], rule: string, severity: Finding["severity"], title: string, detail: string, category: Finding["category"] = "functional") => {
      if (items.length) out.push(finding({ category, rule, severity, title, detail, pageUrl: home.url, evidence: list(items), count: items.length }));
    };
    add(missingNav, "nav:menu-missing", "medium", "Some pages have no main menu", "The home page has a menu but these pages do not, so visitors who land on them from Google cannot reach the rest of the site. Use the same header on every page.");
    add(different, "nav:menu-inconsistent", "low", "The main menu changes from page to page", "These pages share less than half of the home page's menu links. A menu that moves around makes people lose their way (WCAG 3.2.3 Consistent navigation). Keep the main menu the same on every page.", "accessibility");
    add(notHome, "nav:logo-not-home", "low", "The logo does not lead to the home page", "Visitors expect a click on the logo to take them home. Link the logo to /.");
    add(noCurrent, "nav:no-current-page", "low", "The menu does not show which page you are on", 'Mark the menu link of the current page (a highlight, and aria-current="page" so screen readers say it), so visitors know where they are.', "accessibility");
    add(noCrumbs, "nav:no-breadcrumbs", "low", "Deep pages have no breadcrumbs", "Pages two or more levels down have no breadcrumb trail (Home › Category › Page). Breadcrumbs help visitors move up a level and, with BreadcrumbList markup, show in Google results.");
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Spelling and content accuracy

/** Common English misspellings (wrong → right), the ones that reach real sites most. */
const MISSPELT: Record<string, string> = {
  accomodate: "accommodate", accomodation: "accommodation", acheive: "achieve", acknowlege: "acknowledge", adress: "address", agressive: "aggressive",
  apparantly: "apparently", appearence: "appearance", arguement: "argument", assesment: "assessment", basicly: "basically", begining: "beginning",
  beleive: "believe", buisness: "business", busness: "business", calender: "calendar", catagory: "category", cemetary: "cemetery", collegue: "colleague",
  comming: "coming", commited: "committed", commitee: "committee", completly: "completely", concious: "conscious", definately: "definitely",
  definatly: "definitely", dissapoint: "disappoint", embarass: "embarrass", enviroment: "environment", existance: "existence", experiance: "experience",
  familar: "familiar", finaly: "finally", foriegn: "foreign", fourty: "forty", freind: "friend", goverment: "government", gaurantee: "guarantee",
  garantee: "guarantee", guarentee: "guarantee", harrass: "harass", immediatly: "immediately", independant: "independent", indispensible: "indispensable",
  knowlege: "knowledge", liason: "liaison", libary: "library", lisence: "licence", maintainance: "maintenance", maintenence: "maintenance",
  managment: "management", millenium: "millennium", mischievious: "mischievous", neccessary: "necessary", necesary: "necessary", noticable: "noticeable",
  occassion: "occasion", occured: "occurred", occurence: "occurrence", occuring: "occurring", oppurtunity: "opportunity", opportunites: "opportunities",
  persistant: "persistent", posession: "possession", prefered: "preferred", privelege: "privilege", priviledge: "privilege", proffesional: "professional",
  profesional: "professional", publically: "publicly", realy: "really", reccomend: "recommend", recomend: "recommend", recieve: "receive",
  recieved: "received", refered: "referred", relevent: "relevant", religous: "religious", repitition: "repetition", resturant: "restaurant",
  responsibilty: "responsibility", seperate: "separate", seperately: "separately", sucess: "success", succesful: "successful", successfull: "successful",
  supercede: "supersede", suprise: "surprise", tommorow: "tomorrow", tommorrow: "tomorrow", tounge: "tongue", truely: "truly", untill: "until",
  wierd: "weird", wich: "which", writting: "writing", servcies: "services", sevices: "services", serivces: "services", solutons: "solutions",
  techonology: "technology", tecnology: "technology", developement: "development", delivary: "delivery", recieving: "receiving", payement: "payment",
  enquriy: "enquiry", inquriy: "inquiry", cusotmer: "customer", custmer: "customer", costumer: "customer", quaility: "quality", qualtiy: "quality",
  avaliable: "available", availible: "available", accesible: "accessible", efficent: "efficient", experties: "expertise", proccess: "process",
  sucessful: "successful", contruction: "construction", shiping: "shipping", adddress: "address", priviacy: "privacy", privecy: "privacy",
};
const OK_DOUBLES = /^(that|had|is|do|bye|no|yes|ha|go|very|so|really|knock|tuk|chop|pom|bora|aye|cha|dum|tom|mau|kon|ho)$/i;
const MOJIBAKE = /â€[™œ\u009d“”˜¦¢]|Ã[©¨¢¡³±¼¶]|ðŸ|ï»¿|Â [A-Za-z]|�/;
const PLACEHOLDER_INFO = /\b(your company name|company name here|insert (text|title|content) here|click (here )?to edit|sample text|123 main st(reet)?|\(123\) 456-7890|123-456-7890|john@example\.com|info@yourdomain\.com|email@example\.com|your@email\.com|yourname@yourdomain|\[email protected\]|coming soon\.{0,3}$)\b/i;

export const spellingAgent: PageAgent = {
  id: "content.spelling",
  name: "Spelling and content accuracy",
  description:
    "Reads the text visitors see for common English misspellings (\"recieve\", \"seperate\", \"buisness\" and 130 more), doubled words (\"the the\"), broken characters from a wrong text encoding (â€™ instead of ’), and template contact details nobody replaced (123 Main Street, (123) 456-7890, your@email.com).",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const text = (await page.evaluate(`(function () {
      var root = document.querySelector("main") || document.body;
      if (!root) return "";
      var clone = root.cloneNode(true);
      clone.querySelectorAll("script, style, noscript, code, pre, textarea, [contenteditable], svg").forEach(function (n) { n.remove(); });
      return (clone.innerText || clone.textContent || "").replace(/[ \\t]+/g, " ").slice(0, 200000);
    })()`)) as string;
    if (!text.trim()) return [];
    const words = text.match(/[A-Za-z][A-Za-z']+/g) ?? [];
    const wrong = new Map<string, number>();
    for (const w of words) {
      const right = MISSPELT[w.toLowerCase()];
      if (right) wrong.set(`"${w}" → ${right}`, (wrong.get(`"${w}" → ${right}`) ?? 0) + 1);
    }
    const doubles = new Set<string>();
    for (const m of text.matchAll(/\b([A-Za-z]{2,})\s+\1\b/gi)) if (!OK_DOUBLES.test(m[1]) && m[0].split(/\s+/)[0] === m[0].split(/\s+/)[1]) doubles.add(m[0].replace(/\s+/g, " "));
    const moji = MOJIBAKE.exec(text);
    const placeholder = PLACEHOLDER_INFO.exec(text);
    countCases(4 + Math.min(words.length, 1) * 0, (wrong.size ? 1 : 0) + (doubles.size ? 1 : 0) + (moji ? 1 : 0) + (placeholder ? 1 : 0));
    const out: Finding[] = [];
    const around = (i: number, n: number) => text.slice(Math.max(0, i - 40), i + n + 40).replace(/\s+/g, " ").trim();
    if (wrong.size) out.push(finding({ category: "functional", rule: "content:misspelling", severity: "low", title: "Spelling mistakes on the page", detail: "Misspelt words make a business look careless and cost trust (and search ranking for the misspelt keyword). Correct them in the page or the CMS.", pageUrl: url, evidence: list([...wrong].map(([k, n]) => (n > 1 ? `${k} (${n} times)` : k))), count: wrong.size }));
    if (doubles.size) out.push(finding({ category: "functional", rule: "content:doubled-word", severity: "low", title: "A word is written twice in a row", detail: 'The same word appears twice ("the the"), usually after an edit. Remove one.', pageUrl: url, evidence: list([...doubles]), count: doubles.size }));
    if (moji) out.push(finding({ category: "functional", rule: "content:broken-characters", severity: "medium", title: "Broken characters from a wrong text encoding", detail: "Quotes, accents or emoji show as â€™, Ã© or �: the text was saved in one encoding and shown in another (often a database or CSV import in Latin-1 shown as UTF-8). Fix the text in the CMS or database and save everything as UTF-8 (utf8mb4 in MySQL).", pageUrl: url, evidence: around(moji.index, moji[0].length) }));
    if (placeholder) out.push(finding({ category: "functional", rule: "content:template-details", severity: "medium", title: "Template contact details or text nobody replaced", detail: "The page still shows the theme's sample details (a made-up address, phone number or email). Visitors who try them cannot reach you. Replace them with the real ones.", pageUrl: url, evidence: around(placeholder.index, placeholder[0].length) }));
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Reliability and concurrency

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
};

export const reliabilityAgent: SiteAgent = {
  id: "rel.repeat",
  name: "Reliability (asked again and at once)",
  description:
    "Asks for up to 3 pages 5 times one after another and then 5 times at the same moment (30 GET requests in all, like a few visitors arriving together): every answer should succeed, the same page should not sometimes fail, and 5 visitors at once should not make the page much slower than one.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  runsLast: true,
  async run({ browser, pages, site }) {
    const sample = goodPages(pages, 3).filter((p) => !isUnsafeLink(p.url, site.loggedIn));
    if (!sample.length) return [];
    const flaky: string[] = [];
    const unstable: string[] = [];
    const crowd: string[] = [];
    let tried = 0;
    const get = async (url: string) => {
      const t = Date.now();
      try {
        const r = await browser.request.get(url, { timeout: 30_000, failOnStatusCode: false });
        await r.body().catch(() => null);
        return { status: r.status(), ms: Date.now() - t };
      } catch (err) {
        return { status: 0, ms: Date.now() - t, error: (err as Error).message.split("\n")[0] };
      }
    };
    for (const p of sample) {
      if (site.signal?.aborted) break;
      const one: { status: number; ms: number }[] = [];
      for (let i = 0; i < 5; i++) one.push(await get(p.url));
      const many = await Promise.all(Array.from({ length: 5 }, () => get(p.url)));
      tried += 3;
      const all = [...one, ...many];
      const bad = all.filter((r) => r.status === 0 || r.status >= 500 || r.status === 429);
      if (bad.length) flaky.push(`${pathOf(p.url)}: ${bad.length} of 10 failed (${[...new Set(bad.map((b) => (b.status ? `HTTP ${b.status}` : "no answer")))].join(", ")})`);
      const ms = one.filter((r) => r.status && r.status < 400).map((r) => r.ms);
      const m = median(ms);
      const worst = Math.max(...ms, 0);
      if (ms.length >= 4 && worst > 1500 && worst > 4 * Math.max(m, 100)) unstable.push(`${pathOf(p.url)}: usually ${m} ms, once ${worst} ms`);
      const mm = median(many.filter((r) => r.status && r.status < 400).map((r) => r.ms));
      if (m && mm > 2000 && mm > 3 * Math.max(m, 150)) crowd.push(`${pathOf(p.url)}: ${m} ms alone, ${mm} ms with 5 at once`);
    }
    countCases(tried, flaky.length + unstable.length + crowd.length);
    const out: Finding[] = [];
    const where = sample[0].url;
    if (flaky.length) out.push(finding({ category: "functional", rule: "rel:intermittent-errors", severity: "high", title: "Pages sometimes fail when asked for again", detail: "The same page answered normally and then with an error (or not at all) a moment later. Visitors hit this at random, which is hard to reproduce: check the server's error log at these times, the PHP or Node worker limits, and the database connection pool.", pageUrl: where, evidence: list(flaky) }));
    if (unstable.length) out.push(finding({ category: "performance", rule: "rel:unstable-speed", severity: "low", title: "Page speed jumps from one request to the next", detail: "Most answers are quick, but one took four times longer or more. Uneven speed usually means a cache that expires, a slow database query now and then, or a server that is short of memory.", pageUrl: where, evidence: list(unstable) }));
    if (crowd.length) out.push(finding({ category: "performance", rule: "rel:slow-with-five", severity: "medium", title: "The site slows down with only 5 visitors at once", detail: "Five requests at the same moment took more than three times as long as one. The server handles one request at a time somewhere (too few PHP-FPM or Node workers, a lock in the database, or no page cache). A load test with the client's permission shows where it breaks.", pageUrl: where, evidence: list(crowd) }));
    return out;
  },
};

/** The website agents added for the testing handbook. */
export const HANDBOOK_WEB_AGENTS = [backForwardAgent, downloadsAgent, cacheAgent, cookiesAgent, navigationAgent, spellingAgent, reliabilityAgent];
