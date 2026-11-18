import { finding } from "../../runner/finding.js";
import { sameSite, siteOf } from "../../runner/urls.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { PageAgent, SiteState } from "../types.js";
import { DESCRIBE_JS } from "./guard.js";
import { sharedFinding, type SharedItem } from "./once.js";

/**
 * Passive security checks: they read what the site already sends to every visitor (comments in
 * the HTML, error messages, scripts and their versions, the sign-in form) and never send it
 * anything it would not get from a normal visit.
 */

const list = (items: string[], max = 6) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---------------------------------------------------------------------------------------------

/** Comments that give away secrets or the inside of the system. */
const COMMENT_RULES: { what: string; severity: Severity; re: RegExp }[] = [
  { what: "a private key", severity: "critical", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // A value with a digit or symbol: "Password: at least 8 characters" is advice, not a password.
  { what: "a password", severity: "high", re: /\b(password|passwd|pwd)\s*[:=]\s*['"]?(?=[^\s'"<>]*[\d!@#$%^&*])[^\s'"<>]{4,}/i },
  { what: "a key or token", severity: "high", re: /\b(api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?(?=[\w-]*\d)[\w-]{12,}/i },
  { what: "a database query", severity: "low", re: /\bselect\s+(\*|\w+(\s*,\s*\w+)+)\s+from\s+[`"\w.]+/i },
  { what: "an internal network address", severity: "low", re: /\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/ },
  { what: "a test or staging server", severity: "low", re: /\/\/(localhost|127\.0\.0\.1|((staging|stage|dev|uat|qa)\d*[.-][\w.-]+))(:\d+)?/i },
  { what: "a developer note about security", severity: "low", re: /\b(todo|fixme|hack)\b.{0,80}\b(password|security|auth|bypass|remove before|temporary)\b/i },
];

/** Error messages that show the server's code, files or database. */
const ERROR_RULES: { what: string; severity: Severity; re: RegExp }[] = [
  {
    what: "a database error",
    severity: "high",
    re: /SQLSTATE\[\w+\]|You have an error in your SQL syntax|\bORA-\d{5}\b|Microsoft OLE DB Provider for|PG::\w+Error|Unclosed quotation mark after the character string|\bmysql_fetch_\w+\(|SQLite3?::\w*Exception/,
  },
  { what: "a PHP error with the server's file path", severity: "medium", re: /\b(Fatal error|Parse error|Warning|Notice|Deprecated): .{0,200}? in \/?[\w/.\\:-]+\.php on line \d+/ },
  { what: "a Python stack trace", severity: "medium", re: /Traceback \(most recent call last\)/ },
  { what: "Django's debug page", severity: "high", re: /you have DEBUG = True in your Django settings/ },
  { what: "a Java stack trace", severity: "medium", re: /\bat [a-z][\w$]*(\.[\w$]+)+\([\w$]+\.java:\d+\)|java\.lang\.\w+(Exception|Error)\b/ },
  { what: "an ASP.NET error page", severity: "medium", re: /Server Error in '[^']*' Application|System\.\w+Exception:|\bStack Trace:/ },
  { what: "a Node.js stack trace", severity: "medium", re: /\bat [\w.<>]+ \((\/[\w./-]+|node:internal\/[\w/]+):\d+:\d+\)/ },
  { what: "a Laravel or Symfony error page", severity: "medium", re: /Whoops, looks like something went wrong|Illuminate\\[A-Z]\w+|Symfony\\Component\\/ },
  { what: "a Ruby on Rails error page", severity: "medium", re: /ActiveRecord::\w+Error|ActionController::RoutingError|ActionView::Template::Error/ },
];

const LEAK_JS = `(function () {
  var comments = [];
  var walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
  var c, n = 0;
  while ((c = walker.nextNode()) && n++ < 3000) {
    var t = c.nodeValue.replace(/\\s+/g, " ").trim();
    if (t.length >= 8) comments.push(t.slice(0, 600));
  }
  var text = document.body ? document.body.innerText.slice(0, 300000) : "";
  return { comments: comments, text: text };
})()`;

/** Library files whose source maps are public code anyway. */
const LIBRARY_FILE =
  /(jquery|bootstrap|popper|swiper|slick|lodash|underscore|moment|chart|select2|owl|aos|gsap|three|vue|react|angular|alpine|htmx|fontawesome|font-awesome|tinymce|ckeditor|leaflet|mapbox|recaptcha|gtag|analytics)[\w.-]*\.js/i;

/** Each script's source map is checked once per test, whichever page loads it first. */
const mapChecks = new WeakMap<SiteState, Map<string, Promise<string | null>>>();

export const infoLeakAgent: PageAgent = {
  id: "sec.info-leak",
  name: "Information leaks",
  description:
    "Reads what the site gives every visitor: HTML comments with passwords, keys, internal addresses or queries, error messages that show the server's code or database, and source maps that publish the original source code of the site's own scripts.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  async run({ page, url, signals, browser, site }) {
    const r = (await page.evaluate(LEAK_JS)) as { comments: string[]; text: string };
    const out: Finding[] = [];

    const byLevel = new Map<Severity, SharedItem[]>();
    for (const comment of r.comments) {
      const hit = COMMENT_RULES.find((rule) => rule.re.test(comment));
      if (!hit) continue;
      const items = byLevel.get(hit.severity) ?? [];
      items.push({ key: comment, line: `${hit.what}: <!-- ${clip(comment)} -->` });
      byLevel.set(hit.severity, items);
    }
    for (const [severity, items] of byLevel) {
      out.push(
        ...sharedFinding(`sec:html-comment:${severity}`, items, (fresh) =>
          finding({
            category: "security",
            rule: "sec:html-comment",
            severity,
            title: `${fresh.length} HTML comment${fresh.length === 1 ? " gives" : "s give"} away ${fresh.length === 1 ? fresh[0].line.split(":")[0] : "inside information"}`,
            detail:
              "Every visitor can read HTML comments with View source. Remove them from the templates (or strip comments when building the site), and change any password or key that was in one: it has been public.",
            pageUrl: url,
            evidence: list(fresh.map((i) => i.line)),
            count: fresh.length,
          }),
        ),
      );
    }

    const errors: SharedItem[] = [];
    for (const rule of ERROR_RULES) {
      const m = rule.re.exec(r.text);
      if (m) errors.push({ key: `${rule.severity}|${rule.what}|${m[0].slice(0, 80)}`, line: `${rule.what}: ${clip(m[0])}` });
    }
    out.push(
      ...sharedFinding("sec:error-details", errors, (fresh) =>
        finding({
          category: "security",
          rule: "sec:error-details",
          severity: fresh.some((i) => i.key.startsWith("high|")) ? "high" : "medium",
          title: `The page shows ${fresh.length === 1 ? fresh[0].line.split(":")[0] : "error details from the server"}`,
          detail:
            "Error details tell attackers which software, files and database queries the site uses, and a database error often means the input reaches the query unchecked. Turn off error display on the live site (display_errors=Off, DEBUG=False, customErrors On), log errors instead, and fix the error itself.",
          pageUrl: url,
          evidence: list(fresh.map((i) => i.line)),
          count: fresh.length,
        }),
      ),
    );

    // Source maps of the site's own scripts (not libraries, whose code is public anyway).
    const host = new URL(url).hostname;
    const scripts = signals.responses
      .filter((x) => x.type === "script" && x.status === 200 && sameSite(x.url, host) && !LIBRARY_FILE.test(new URL(x.url).pathname))
      .slice(0, 4);
    const cache = mapChecks.get(site) ?? new Map<string, Promise<string | null>>();
    mapChecks.set(site, cache);
    const maps: SharedItem[] = [];
    for (const s of scripts) {
      if (!cache.has(s.url)) {
        cache.set(
          s.url,
          (async () => {
            let ref: string | undefined = s.headers["sourcemap"] ?? s.headers["x-sourcemap"];
            if (!ref) {
              const res = await browser.request.get(s.url, { timeout: 15_000, failOnStatusCode: false });
              if (!res.ok()) return null;
              const body = await res.text();
              ref = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(body.slice(-400))?.[1];
            }
            if (!ref || ref.startsWith("data:")) return null;
            const mapUrl = new URL(ref, s.url).toString();
            if (!sameSite(mapUrl, host)) return null;
            const map = await browser.request.get(mapUrl, { timeout: 15_000, failOnStatusCode: false });
            if (!map.ok()) return null;
            const text = await map.text();
            return /"mappings"/.test(text) && /"sourcesContent"\s*:\s*\[\s*"/.test(text) ? mapUrl : null;
          })().catch(() => null),
        );
      }
      const mapUrl = await cache.get(s.url)!;
      if (mapUrl) maps.push({ key: mapUrl, line: mapUrl });
    }
    out.push(
      ...sharedFinding("sec:source-map", maps, (fresh) =>
        finding({
          category: "security",
          rule: "sec:source-map",
          severity: "low",
          title: `The original source code of ${fresh.length} script${fresh.length === 1 ? " is" : "s are"} public (source maps)`,
          detail:
            "Source maps let anyone read the site's scripts as the developers wrote them, with comments and file names, which makes hidden routes, keys and logic easy to find. Do not upload .map files to the live server, or keep them behind a login for your error tracker.",
          pageUrl: url,
          evidence: list(fresh.map((i) => i.line)),
          count: fresh.length,
        }),
      ),
    );
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

interface Advisory {
  /** Affected from this version (inclusive), when not from the first. */
  from?: string;
  /** Fixed in this version. */
  below: string;
  ids: string;
  what: string;
  severity: Severity;
}

/**
 * GLV's own table of known problems in browser libraries, from the public CVE records. The
 * version is read from the library itself in the page (or from its file name), never guessed.
 */
export const JS_ADVISORIES: Record<string, { name: string; upgrade: string; advisories: Advisory[] }> = {
  jquery: {
    name: "jQuery",
    upgrade: "Upgrade to jQuery 3.7 or later (add jQuery Migrate while old plugins are fixed).",
    advisories: [
      { below: "1.9.0", ids: "CVE-2012-6708", what: "cross-site scripting through selectors that contain HTML", severity: "medium" },
      { below: "3.0.0", ids: "CVE-2015-9251", what: "cross-site scripting when it loads scripts from other sites", severity: "medium" },
      { below: "3.4.0", ids: "CVE-2019-11358", what: "prototype pollution in jQuery.extend", severity: "medium" },
      { below: "3.5.0", ids: "CVE-2020-11022, CVE-2020-11023", what: "cross-site scripting when HTML from outside is inserted", severity: "medium" },
    ],
  },
  "jquery-ui": {
    name: "jQuery UI",
    upgrade: "Upgrade to jQuery UI 1.13.2 or later.",
    advisories: [
      { below: "1.12.0", ids: "CVE-2016-7103", what: "cross-site scripting in the dialog's closeText", severity: "medium" },
      { below: "1.13.0", ids: "CVE-2021-41182, CVE-2021-41183, CVE-2021-41184", what: "cross-site scripting in datepicker and position options", severity: "medium" },
      { below: "1.13.2", ids: "CVE-2022-31160", what: "cross-site scripting in checkboxradio labels", severity: "medium" },
    ],
  },
  bootstrap: {
    name: "Bootstrap",
    upgrade: "Upgrade to Bootstrap 3.4.1, 4.3.1 or later (Bootstrap 5 is the supported line).",
    advisories: [
      { below: "3.4.0", ids: "CVE-2018-14040, CVE-2018-14041, CVE-2018-14042, CVE-2018-20676, CVE-2018-20677", what: "cross-site scripting through data attributes of collapse, scrollspy, tooltip and affix", severity: "medium" },
      { from: "3.4.0", below: "3.4.1", ids: "CVE-2019-8331", what: "cross-site scripting through tooltip and popover templates", severity: "medium" },
      { from: "4.0.0", below: "4.1.2", ids: "CVE-2018-14040, CVE-2018-14041, CVE-2018-14042", what: "cross-site scripting through data attributes of collapse, scrollspy and tooltip", severity: "medium" },
      { from: "4.1.2", below: "4.3.1", ids: "CVE-2019-8331", what: "cross-site scripting through tooltip and popover templates", severity: "medium" },
    ],
  },
  angularjs: {
    name: "AngularJS",
    upgrade: "AngularJS (1.x) has had no updates since 31 December 2021: move to a maintained framework, or to a vendor that sells long-term support for it.",
    advisories: [{ below: "2.0.0", ids: "end of life", what: "no security fixes since 31 December 2021", severity: "medium" }],
  },
  lodash: {
    name: "Lodash",
    upgrade: "Upgrade to Lodash 4.17.21 or later.",
    advisories: [
      { below: "4.17.12", ids: "CVE-2019-10744", what: "prototype pollution in defaultsDeep", severity: "medium" },
      { below: "4.17.21", ids: "CVE-2021-23337, CVE-2020-28500", what: "code injection through template, and slow regular expressions", severity: "low" },
    ],
  },
  moment: {
    name: "Moment.js",
    upgrade: "Upgrade to Moment 2.29.4 or later (Moment is in maintenance only: Luxon, Day.js or the browser's own Intl are its successors).",
    advisories: [{ from: "2.18.0", below: "2.29.4", ids: "CVE-2022-31129", what: "a slow regular expression when parsing dates (the page can freeze)", severity: "low" }],
  },
};

/** True when version a comes before version b ("3.4.1" < "3.5.0"; "1.12.4-wp" counts as 1.12.4). */
export function versionBefore(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  }
  return false;
}

/** The known problems of one library version. */
export function advisoriesFor(lib: string, version: string): Advisory[] {
  const entry = JS_ADVISORIES[lib];
  if (!entry || !/^\d+\.\d+/.test(version)) return [];
  return entry.advisories.filter((a) => versionBefore(version, a.below) && (!a.from || !versionBefore(version, a.from)));
}

const LIBS_JS = `(function () {
  var out = [];
  var add = function (lib, v) { if (v && /^\\d+\\.\\d+/.test(String(v))) out.push([lib, String(v)]); };
  try { if (window.jQuery && jQuery.fn) add("jquery", jQuery.fn.jquery); } catch (e) {}
  try { if (window.jQuery && jQuery.ui) add("jquery-ui", jQuery.ui.version); } catch (e) {}
  try { add("bootstrap", window.bootstrap && bootstrap.Tooltip && bootstrap.Tooltip.VERSION); } catch (e) {}
  try { if (window.jQuery && jQuery.fn.tooltip && jQuery.fn.tooltip.Constructor) add("bootstrap", jQuery.fn.tooltip.Constructor.VERSION); } catch (e) {}
  try { if (window.angular && angular.version) add("angularjs", angular.version.full); } catch (e) {}
  try { if (window._ && typeof _.runInContext === "function") add("lodash", _.VERSION); } catch (e) {}
  try { if (window.moment) add("moment", moment.version); } catch (e) {}
  return out;
})()`;

/** Versions written in library file names, for copies the page does not expose as a global. */
const FILE_VERSIONS: [string, RegExp][] = [
  ["jquery-ui", /jquery-?ui[./@-]+(\d+\.\d+\.\d+)|jqueryui\/(\d+\.\d+\.\d+)\//i],
  ["jquery", /\/jquery[.@-](\d+\.\d+\.\d+)(\.min|\.slim)*\.js|\/jquery\/(\d+\.\d+\.\d+)\/jquery|\/jquery(\.min)?\.js\?ver=(\d+\.\d+\.\d+)/i],
  ["bootstrap", /bootstrap[@/-](\d+\.\d+\.\d+)\/.*\.js|\/bootstrap\/(\d+\.\d+\.\d+)\/js\//i],
  ["angularjs", /angular(js)?(\.js)?[/@-](1\.\d+\.\d+)\/.*angular[\w.]*\.js/i],
  ["lodash", /lodash(\.js)?[/@-](\d+\.\d+\.\d+)/i],
  ["moment", /moment(\.js)?[/@-](\d+\.\d+\.\d+)/i],
];

export function versionsFromFiles(urls: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (const u of urls) {
    if (!/\.js(\?|$)/i.test(u)) continue;
    for (const [lib, re] of FILE_VERSIONS) {
      const m = re.exec(u);
      const v = m?.slice(1).find((g) => g && /^\d+\.\d+\.\d+$/.test(g));
      if (v) {
        out.push([lib, v]);
        break;
      }
    }
  }
  return out;
}

export const jsLibrariesAgent: PageAgent = {
  id: "sec.js-libraries",
  name: "Outdated JavaScript libraries",
  description:
    "Reads the versions of jQuery, jQuery UI, Bootstrap, AngularJS, Lodash and Moment the page really runs, and checks them against GLV's own table of known vulnerabilities (CVEs). Each library is reported once for the whole site.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  async run({ page, url, signals }) {
    const found = [...((await page.evaluate(LIBS_JS)) as [string, string][]), ...versionsFromFiles(signals.responses.filter((r) => r.type === "script").map((r) => r.url))];
    const out: Finding[] = [];
    for (const [lib, version] of new Map(found.map(([l, v]) => [`${l}@${v.split(/[+-]/)[0]}`, [l, v] as const])).values()) {
      const hits = advisoriesFor(lib, version);
      if (!hits.length) continue;
      const entry = JS_ADVISORIES[lib];
      const severity: Severity = hits.some((h) => h.severity === "high") ? "high" : hits.some((h) => h.severity === "medium") ? "medium" : "low";
      out.push(
        ...sharedFinding(
          "sec:vulnerable-js",
          [{ key: `${lib}@${version}`, line: hits.map((h) => `${h.ids}: ${h.what}`).join("\n") }],
          (items) =>
            finding({
              category: "security",
              rule: "sec:vulnerable-js",
              severity,
              title: `${entry.name} ${version} has known security problems`,
              detail: `${entry.upgrade} Test the pages that use it after upgrading. If your vendor patched this copy itself, mark the issue as not a problem.`,
              pageUrl: url,
              evidence: items[0].line,
            }),
        ),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Public CDNs that serve fixed versions of files: a changed file there would run on the site. */
const CDN = /^(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|(stackpath|maxcdn|netdna)\.bootstrapcdn\.com|ajax\.googleapis\.com|ajax\.aspnetcdn\.com|cdn\.datatables\.net)$/i;

export const sriAgent: PageAgent = {
  id: "sec.sri",
  name: "Subresource Integrity",
  description:
    "Finds scripts and styles loaded from public CDNs (cdnjs, jsDelivr, unpkg, code.jquery.com, BootstrapCDN...) without an integrity check, so a changed file on the CDN would run on the site.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  async run({ page, url }) {
    const files = (await page.evaluate(`(function () {
      var out = [];
      var els = document.querySelectorAll("script[src], link[rel~=stylesheet][href]");
      for (var i = 0; i < els.length; i++) {
        if (els[i].integrity) continue;
        out.push(els[i].src || els[i].href);
      }
      return out;
    })()`)) as string[];
    const items: SharedItem[] = [];
    for (const f of files) {
      try {
        const u = new URL(f);
        if (CDN.test(u.hostname) && /\d+\.\d+/.test(u.pathname)) items.push({ key: f, line: f });
      } catch {
        // Not an address.
      }
    }
    return sharedFinding("sec:no-sri", items, (fresh) =>
      finding({
        category: "security",
        rule: "sec:no-sri",
        severity: "low",
        title: `${fresh.length} file${fresh.length === 1 ? "" : "s"} from a public CDN load${fresh.length === 1 ? "s" : ""} without an integrity check`,
        detail:
          'If the CDN or the file were tampered with, the changed code would run on your site with full access to visitors\' data. Add integrity="sha384-…" and crossorigin="anonymous" to each tag (cdnjs and jsDelivr show the value next to each file), or serve the files from your own server.',
        pageUrl: url,
        evidence: list(fresh.map((i) => i.line)),
        count: fresh.length,
      }),
    );
  },
};

// ---------------------------------------------------------------------------------------------

export const authFormsAgent: PageAgent = {
  id: "sec.auth-forms",
  name: "Sign-in forms",
  description:
    "Checks every form with a password field, without typing or sending anything: a password sent in the page address (method GET), a password sent to another company's server, and password managers or pasting blocked.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  // It sends a pretend paste event to the password field (nothing is pasted), so it runs after the others.
  interacts: true,
  async run({ page, url }) {
    const r = (await page.evaluate(`(function () {
      var describe = ${DESCRIBE_JS};
      var out = { get: [], actions: [], paste: [], off: [] };
      var pws = document.querySelectorAll("input[type=password]");
      for (var i = 0; i < pws.length && i < 20; i++) {
        var pw = pws[i], f = pw.form;
        if (f) {
          var act = f.getAttribute("action");
          if ((f.getAttribute("method") || "").toLowerCase() === "get" && !/^javascript:/i.test(act || "")) out.get.push(describe(f) + " → " + (act || "this page"));
          if (act && !/^(javascript:|#)/i.test(act)) { try { out.actions.push([describe(f), new URL(act, location.href).href]); } catch (e) {} }
        }
        var onpaste = pw.getAttribute("onpaste") || "";
        var blocked = /return\\s+false|preventDefault/.test(onpaste);
        if (!blocked) {
          try { blocked = !pw.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() })); } catch (e) {}
        }
        if (blocked) out.paste.push(describe(pw));
        var ac = (pw.getAttribute("autocomplete") || (f && f.getAttribute("autocomplete")) || "").toLowerCase();
        if (ac === "off") out.off.push(describe(pw));
      }
      return out;
    })()`)) as { get: string[]; actions: [string, string][]; paste: string[]; off: string[] };
    const out: Finding[] = [];
    const host = new URL(url).hostname;
    if (r.get.length) {
      out.push(
        finding({
          category: "security",
          rule: "sec:password-in-url",
          severity: "high",
          title: "A sign-in form sends the password in the page address",
          detail:
            'The form uses method="get", so the password ends up in the address bar, the browser history, server logs and the Referer sent to other sites. Use method="post".',
          pageUrl: url,
          evidence: list(r.get),
        }),
      );
    }
    const away = r.actions.filter(([, a]) => /^https?:/.test(a) && siteOf(new URL(a).hostname) !== siteOf(host));
    if (away.length) {
      out.push(
        finding({
          category: "security",
          rule: "sec:password-other-site",
          severity: "medium",
          title: "A form sends a password to another site",
          detail:
            "The password goes to a server outside this site. If that is your own sign-in service, fine; if not, the form may have been changed by an attacker. Check the form's action address.",
          pageUrl: url,
          evidence: list(away.map(([f, a]) => `${f} → ${a}`)),
        }),
      );
    }
    if (r.paste.length || r.off.length) {
      out.push(
        finding({
          category: "security",
          rule: "sec:password-manager-blocked",
          severity: "low",
          title: r.paste.length ? "Pasting into the password field is blocked" : 'The password field turns off autofill (autocomplete="off")',
          detail:
            'Blocking paste and autofill stops password managers, which pushes people to short, reused passwords (NIST SP 800-63B and the UK NCSC both say to allow pasting). Remove the paste blocker and use autocomplete="current-password" or "new-password".',
          pageUrl: url,
          evidence: list([...r.paste.map((p) => `paste blocked: ${p}`), ...r.off.map((p) => `autocomplete off: ${p}`)]),
        }),
      );
    }
    return out;
  },
};
