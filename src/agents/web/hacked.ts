import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, SiteAgent, SiteContext } from "../types.js";
import { getText } from "./geo.js";

/**
 * Signs that a site was hacked: the spam, scripts and hidden links attackers plant on WordPress and
 * shared-hosting sites (casino, pharma and "slot gacor" links, the Japanese keyword hack, injected
 * redirect scripts, web skimmers, defacements). All read-only: the page as a visitor gets it.
 */

/** Words of the SEO spam attackers hide in hacked pages. */
export const SPAM_WORDS =
  /\b(viagra|cialis|levitra|tadalafil|sildenafil|pharmacy online|buy (cheap )?pills|casino online|online casino|slot gacor|slot online|situs slot|judi (bola|online)|togel|sbobet|poker online|bandar|rtp slot|maxwin|scatter hitam|payday loans?|replica (watches|handbags)|escort service|porn|xxx|crypto doubler|cheap (nike|jordans|ugg|oakley)|essay writing service)\b/i;

/** Script patterns that obfuscated injected malware uses, with what each usually means. */
export const SCRIPT_SIGNS: [RegExp, string][] = [
  [/eval\s*\(\s*(atob|unescape|decodeURIComponent|String\.fromCharCode)\s*\(/i, "eval of decoded text (obfuscated code)"],
  [/document\.write\s*\(\s*unescape\s*\(/i, "document.write of escaped text"],
  [/String\.fromCharCode\s*\(\s*(\d+\s*,\s*){30,}/i, "a long String.fromCharCode chain (hidden code)"],
  [/\\x[0-9a-f]{2}(\\x[0-9a-f]{2}){40,}/i, "a long run of \\x escapes (hidden code)"],
  [/navigator\.userAgent[\s\S]{0,120}(googlebot|bing|yandex)[\s\S]{0,200}location/i, "different behaviour for search engine bots (cloaking)"],
  [/document\.referrer[\s\S]{0,120}(google|bing|yahoo)[\s\S]{0,200}(location|window\.open)/i, "redirect only for visitors coming from Google (a classic hack)"],
  [/(coinhive|cryptonight|coin-hive|cryptoloot|webminepool|minero\.cc)/i, "a crypto-mining script"],
  [/(?:cc_?number|cardnumber|card-number|cvv|cvc)[\s\S]{0,300}(?:btoa|atob|XMLHttpRequest|fetch|new Image\(\)\.src|sendBeacon)\s*\(/i, "card fields read and sent away (a web skimmer, Magecart)"],
];

/** Text that defacers leave. */
export const DEFACE = /\b(hacked by|h4ck3d|owned by|defaced by|greetz|was here\s*[-–]+\s*\w+|security is (just )?an illusion)\b/i;

/** Pure: which injected-script signs a script's text has. */
export function scriptSigns(code: string): string[] {
  return SCRIPT_SIGNS.filter(([re]) => re.test(code)).map(([, what]) => what);
}

interface DomFacts {
  hiddenLinks: { href: string; text: string; how: string }[];
  hiddenIframes: string[];
  inlineScripts: string[];
  externalScripts: string[];
  text: string;
  title: string;
}

const DOM_SCRIPT = `(function () {
  var host = location.hostname.replace(/^www\\./, "");
  function hiddenHow(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var s = getComputedStyle(n);
      if (s.display === "none") return "display:none";
      if (s.visibility === "hidden") return "visibility:hidden";
      if (parseFloat(s.opacity) === 0) return "opacity:0";
      if (parseFloat(s.fontSize) < 2) return "font-size near 0";
      var r = n.getBoundingClientRect();
      if (r.right < -500 || r.bottom < -500 || r.left > 20000) return "moved off the screen";
      if ((s.overflow === "hidden" || s.clip !== "auto") && (r.width <= 1 || r.height <= 1)) return "squeezed to 1 pixel";
    }
    return "";
  }
  var hiddenLinks = [];
  var links = document.querySelectorAll("a[href]");
  for (var i = 0; i < links.length && hiddenLinks.length < 40; i++) {
    var a = links[i];
    var h = a.href;
    if (!/^https?:/.test(h)) continue;
    var other = new URL(h).hostname.replace(/^www\\./, "") !== host;
    if (!other) continue;
    var how = hiddenHow(a);
    if (how) hiddenLinks.push({ href: h, text: (a.textContent || "").trim().slice(0, 80), how: how });
  }
  var hiddenIframes = [];
  var frames = document.querySelectorAll("iframe[src]");
  for (var j = 0; j < frames.length; j++) {
    var f = frames[j];
    var r = f.getBoundingClientRect();
    var fs = getComputedStyle(f);
    if ((r.width <= 2 && r.height <= 2) || fs.display === "none" || fs.visibility === "hidden") {
      try { if (new URL(f.src).hostname.replace(/^www\\./, "") !== host) hiddenIframes.push(f.src); } catch (e) {}
    }
  }
  var inline = [], external = [];
  var scripts = document.querySelectorAll("script");
  for (var k = 0; k < scripts.length; k++) {
    if (scripts[k].src) external.push(scripts[k].src);
    else if (scripts[k].textContent && !/json|template/i.test(scripts[k].type || "")) inline.push(scripts[k].textContent.slice(0, 20000));
  }
  return { hiddenLinks: hiddenLinks, hiddenIframes: hiddenIframes, inlineScripts: inline.slice(0, 40), externalScripts: external.slice(0, 80), text: (document.body ? document.body.innerText : "").slice(0, 20000), title: document.title };
})()`;

export const hackedAgent: PageAgent = {
  id: "sec.hacked",
  name: "Hacked site and SEO spam",
  description:
    "Looks for signs the site was hacked: hidden spam links (casino, pharma, slot), hidden iframes to other sites, obfuscated or redirecting scripts, crypto miners, card skimmers, and defacement text.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  async run({ page, url }) {
    const facts = (await page.evaluate(DOM_SCRIPT)) as DomFacts;
    const out: Finding[] = [];
    const spamLinks = facts.hiddenLinks.filter((l) => SPAM_WORDS.test(`${l.text} ${l.href}`));
    if (spamLinks.length) {
      out.push(
        finding({
          category: "security",
          rule: "hack:hidden-spam-links",
          severity: "critical",
          title: `${spamLinks.length} hidden spam link${spamLinks.length === 1 ? "" : "s"} on the page`,
          detail:
            "The page has links to casino, pharma or similar sites that visitors cannot see but Google can: the classic sign of a hacked site (SEO spam). Google can drop the site from results or mark it as hacked. Clean the infected files or database rows, change all passwords and update every plugin.",
          pageUrl: url,
          evidence: spamLinks.slice(0, 8).map((l) => `${l.how}: "${l.text}" → ${l.href}`).join("\n"),
        }),
      );
    } else if (facts.hiddenLinks.length >= 5) {
      out.push(
        finding({
          category: "security",
          rule: "hack:hidden-links",
          severity: "medium",
          title: `${facts.hiddenLinks.length} hidden links to other sites`,
          detail: "Links to other sites that visitors cannot see are a common sign of injected SEO spam (or a theme selling hidden links). Check where they come from and remove them.",
          pageUrl: url,
          evidence: facts.hiddenLinks.slice(0, 8).map((l) => `${l.how}: "${l.text}" → ${l.href}`).join("\n"),
        }),
      );
    }
    const visibleSpam = facts.text.match(new RegExp(SPAM_WORDS.source, "gi")) ?? [];
    if (!spamLinks.length && visibleSpam.length >= 3 && !SPAM_WORDS.test(facts.title)) {
      out.push(
        finding({
          category: "security",
          rule: "hack:spam-text",
          severity: "high",
          title: "Spam words on the page",
          detail: "The page text has several gambling, pharma or loan spam words that do not match the site. Check whether comments, a plugin or an injected database row added them.",
          pageUrl: url,
          evidence: [...new Set(visibleSpam.map((w) => w.toLowerCase()))].slice(0, 10).join(", "),
        }),
      );
    }
    if (facts.hiddenIframes.length) {
      out.push(
        finding({
          category: "security",
          rule: "hack:hidden-iframe",
          severity: "high",
          title: "Invisible frame loads another site",
          detail: "A 0-pixel or hidden iframe loads a page from another site. Attackers use these to load malware or fake ad clicks. Find and remove the code that adds it.",
          pageUrl: url,
          evidence: facts.hiddenIframes.slice(0, 5).join("\n"),
        }),
      );
    }
    const signs = new Map<string, string>();
    for (const code of facts.inlineScripts) for (const s of scriptSigns(code)) if (!signs.has(s)) signs.set(s, code.replace(/\s+/g, " ").slice(0, 160));
    for (const [what, sample] of signs) {
      const skimmer = /skimmer/.test(what);
      out.push(
        finding({
          category: "security",
          rule: skimmer ? "hack:skimmer" : /mining/.test(what) ? "hack:cryptominer" : "hack:suspicious-script",
          severity: skimmer || /mining|Google|bots/.test(what) ? "critical" : "high",
          title: `Suspicious script: ${what}`,
          detail:
            "Code like this is rarely written by developers; it is how injected malware hides. Compare the page's template and the site's files with a clean copy (or a backup), remove the injected code, then change passwords and update the CMS and plugins.",
          pageUrl: url,
          evidence: sample,
        }),
      );
    }
    const miners = facts.externalScripts.filter((s) => /(coinhive|cryptoloot|webminepool|coin-hive|minero)/i.test(s));
    if (miners.length && !signs.size) {
      out.push(finding({ category: "security", rule: "hack:cryptominer", severity: "critical", title: "A crypto-mining script runs on the page", detail: "The page loads a crypto miner, which uses visitors' processors to make money for an attacker. Remove it and find how it got in.", pageUrl: url, evidence: miners.join("\n") }));
    }
    const deface = facts.text.match(DEFACE) ?? facts.title.match(DEFACE);
    if (deface) {
      out.push(
        finding({
          category: "security",
          rule: "hack:defaced",
          severity: "critical",
          title: "The page looks defaced",
          detail: "The page shows text that defacers leave (\"hacked by …\"). Take the site offline, restore a clean backup, and find the hole before putting it back.",
          pageUrl: url,
          evidence: deface[0],
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Cloaking: a different page for Google than for people (the Japanese keyword and pharma hacks)

const GOOGLEBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.0.0 Safari/537.36";
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const words = (html: string) =>
  new Set(
    html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2),
  );
const titleOf = (html: string) => html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim() ?? "";
/** Japanese, Chinese and Korean characters, the usual language of keyword-hack spam on English sites. */
const CJK = /[぀-ヿ一-鿿가-힯]/g;

/** Compares what Google gets with what a person gets. Pure, for tests. */
export function cloakingSigns(forPeople: string, forGoogle: string): string[] {
  const out: string[] = [];
  const a = words(forPeople);
  const b = words(forGoogle);
  const extra = [...b].filter((w) => !a.has(w));
  const spam = extra.filter((w) => SPAM_WORDS.test(w) || /^(casino|slot|gacor|viagra|cialis|pharmacy|judi|togel|poker|loans?)$/.test(w));
  if (spam.length) out.push(`Google is shown spam words people never see: ${spam.slice(0, 8).join(", ")}`);
  const cjkPeople = (forPeople.match(CJK) ?? []).length;
  const cjkGoogle = (forGoogle.match(CJK) ?? []).length;
  if (cjkGoogle > 200 && cjkPeople < 20) out.push(`Google is shown ${cjkGoogle} Japanese or Chinese characters that people do not get (the "Japanese keyword hack")`);
  const ta = titleOf(forPeople);
  const tb = titleOf(forGoogle);
  if (ta && tb && ta !== tb && (SPAM_WORDS.test(tb) || /[\u3040-\u30ff\u4e00-\u9fff]/.test(tb))) out.push(`Google gets another title: "${tb.slice(0, 100)}" instead of "${ta.slice(0, 100)}"`);
  return out;
}

async function cloakingFindings({ browser, origin, pages }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const sample = [...new Set([`${origin}/`, ...pages.filter((p) => p.status !== null && p.status < 400).map((p) => p.url)])].slice(0, 5);
  let read = 0;
  for (const url of sample) {
    const people = await getText(browser.request, url, { "user-agent": BROWSER });
    const google = await getText(browser.request, url, { "user-agent": GOOGLEBOT });
    if (!people || !google) continue;
    read++;
    const signs = cloakingSigns(people.text, google.text);
    if (signs.length) {
      out.push(
        finding({
          category: "security",
          rule: "hack:cloaking",
          severity: "critical",
          title: "Google is shown a different, spammy page (cloaking)",
          detail:
            "The server answers Google's crawler with different content than people get: the sign of a hacked site (pharma, casino or Japanese keyword hack). People never see it, but Google indexes the spam and may mark the site as hacked. Look for code that checks the user agent in .htaccess, index.php, wp-config.php and the theme's functions.php.",
          pageUrl: url,
          evidence: signs.join("\n"),
        }),
      );
    }
    // Some hacks redirect only visitors who come from a Google search.
    try {
      const res = await browser.request.get(url, { headers: { "user-agent": BROWSER, referer: "https://www.google.com/" }, maxRedirects: 0, timeout: 15_000 });
      const loc = res.headers()["location"] ?? "";
      const plain = await browser.request.get(url, { headers: { "user-agent": BROWSER }, maxRedirects: 0, timeout: 15_000 });
      if (res.status() >= 300 && res.status() < 400 && loc && !plain.headers()["location"]) {
        const to = new URL(loc, url);
        if (to.hostname.replace(/^www\./, "") !== new URL(url).hostname.replace(/^www\./, "")) {
          out.push(
            finding({
              category: "security",
              rule: "hack:search-redirect",
              severity: "critical",
              title: "Visitors from Google are sent to another site",
              detail: "People who arrive from a Google search are redirected to another site, while direct visitors are not. This is a common hack that is hard to notice because the owner types the address directly. Check .htaccess and the PHP files for rules on HTTP_REFERER.",
              pageUrl: url,
              evidence: `Referer google.com → ${res.status()} ${to.href}`,
            }),
          );
        }
      }
    } catch {
      // Unreachable this way: nothing to compare.
    }
  }
  if (!read) throw new Error("No page could be read as Google and as a browser.");
  return out;
}

export const cloakingAgent: SiteAgent = {
  id: "sec.cloaking",
  name: "Cloaking and search redirects",
  description: "Fetches pages as Googlebot and as a browser, and with a Google referrer, to catch hacks that show spam only to Google or redirect only search visitors.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: cloakingFindings,
};
