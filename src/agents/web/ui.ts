import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent } from "../types.js";
import { DESCRIBE_JS } from "./guard.js";

/**
 * Layout checks that read the page as drawn: text drawn over other text, words cut off by their
 * box, bars that stay on screen and hide the page on phones, and lines too long to read easily.
 * They only read the page, so they run at the same time as the other agents.
 */

const list = (items: string[], max = 6) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");

/** Sliders, tickers and carousels stack or move their slides on purpose. */
const MOVING = `'[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="slick"], [class*="marquee"], [class*="ticker"], [aria-roledescription="carousel"], marquee'`;

/**
 * Pairs of text drawn on top of each other. Each piece of text is measured where it is really
 * drawn: cut to the boxes that hide what overflows them, and left out when it is invisible, faded
 * (opacity or colour under 0.3), hidden from screen readers as decoration, or much bigger than the
 * text it lies on (a large faint word behind a heading is decoration).
 */
export const OVERLAP_JS = `(function () {
  var describe = ${DESCRIBE_JS};
  var vw = innerWidth;
  var clipCache = new Map();
  var alpha = function (c) { var m = /rgba?\\(([^)]+)\\)/.exec(c); if (!m) return 1; var p = m[1].split(/[ ,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  var fadeCache = new Map();
  /** How opaque an element is drawn, with its ancestors; 0 when it is hidden as decoration or clipped away. */
  var opacityOf = function (el) {
    if (!el || el === document.documentElement) return 1;
    if (fadeCache.has(el)) return fadeCache.get(el);
    var cs = getComputedStyle(el);
    var o = el.getAttribute("aria-hidden") === "true" || cs.clipPath !== "none" || (cs.clip && cs.clip !== "auto") ? 0 : parseFloat(cs.opacity) * opacityOf(el.parentElement);
    fadeCache.set(el, o);
    return o;
  };
  var faded = function (el) { return opacityOf(el) < 0.3 || alpha(getComputedStyle(el).color) < 0.3; };
  /** The part of the page an element may draw on: its ancestors that hide overflow cut it. */
  var clipOf = function (el) {
    if (clipCache.has(el)) return clipCache.get(el);
    var box = { left: -1e6, top: -1e6, right: 1e6, bottom: 1e6 };
    var parent = el.parentElement;
    if (parent && parent !== document.body) {
      var up = clipOf(parent);
      box = { left: up.left, top: up.top, right: up.right, bottom: up.bottom };
      var cs = getComputedStyle(parent);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        var r = parent.getBoundingClientRect();
        if (cs.overflowX !== "visible") { box.left = Math.max(box.left, r.left); box.right = Math.min(box.right, r.right); }
        if (cs.overflowY !== "visible") { box.top = Math.max(box.top, r.top); box.bottom = Math.min(box.bottom, r.bottom); }
      }
    }
    clipCache.set(el, box);
    return box;
  };
  var pieces = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  var node, scanned = 0;
  while ((node = walker.nextNode()) && scanned < 4000) {
    var text = node.nodeValue.replace(/\\s+/g, " ").trim();
    if (text.length < 2) continue;
    var el = node.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|OPTION|TEXTAREA|TITLE)$/.test(el.tagName)) continue;
    scanned++;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (el.closest(${MOVING}) || faded(el)) continue;
    var clip = clipOf(el);
    var range = document.createRange();
    range.selectNodeContents(node);
    var rects = range.getClientRects();
    var size = parseFloat(getComputedStyle(el).fontSize) || 16;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var left = Math.max(r.left, clip.left), right = Math.min(r.right, clip.right);
      var top = Math.max(r.top, clip.top), bottom = Math.min(r.bottom, clip.bottom);
      if (right - left < 4 || bottom - top < 4 || right < 0 || left > vw) continue;
      pieces.push({ el: el, left: left, top: top, right: right, bottom: bottom, size: size });
    }
  }
  // Pieces are compared with their neighbours only, through a grid of 120 px cells.
  var cells = new Map();
  var key = function (x, y) { return x + ":" + y; };
  var pairs = new Map();
  for (var a = 0; a < pieces.length; a++) {
    var p = pieces[a];
    var x0 = Math.floor(p.left / 120), x1 = Math.floor(p.right / 120), y0 = Math.floor(p.top / 120), y1 = Math.floor(p.bottom / 120);
    var near = new Set();
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
      var list = cells.get(key(x, y));
      if (list) list.forEach(function (n) { near.add(n); });
    }
    near.forEach(function (b) {
      var q = pieces[b];
      if (q.el === p.el || q.el.contains(p.el) || p.el.contains(q.el)) return;
      var w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
      var h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
      if (w <= 0 || h <= 0) return;
      var smaller = Math.min((p.right - p.left) * (p.bottom - p.top), (q.right - q.left) * (q.bottom - q.top));
      if (w * h < 0.3 * smaller || w * h < 60) return;
      if (Math.max(p.size, q.size) > 2 * Math.min(p.size, q.size)) return;
      var name = describe(q.el) + "  overlaps  " + describe(p.el);
      if (!pairs.has(name)) pairs.set(name, true);
    });
    for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
      var k = key(x, y);
      if (!cells.has(k)) cells.set(k, []);
      cells.get(k).push(a);
    }
  }
  return Array.from(pairs.keys()).slice(0, 40);
})()`;

const overlapFinding = (pairs: string[], url: string, phone: boolean): Finding[] =>
  pairs.length
    ? [
        finding({
          category: phone ? "mobile" : "functional",
          rule: phone ? "ui:text-overlap-phone" : "ui:text-overlap",
          severity: "medium",
          title: `Text is drawn over other text in ${pairs.length} place${pairs.length === 1 ? "" : "s"}${phone ? " on a phone" : ""}`,
          detail: `Visitors cannot read text that lies on top of other text${phone ? " at a phone's width (390 px)" : ""}. Look for elements with position: absolute or negative margins, fixed heights that are too short for the text, and boxes that do not grow when the text wraps.`,
          pageUrl: url,
          evidence: list(pairs),
          count: pairs.length,
        }),
      ]
    : [];

export const overlapAgent: PageAgent = {
  id: "ui.overlap",
  name: "Overlapping text",
  description: "Finds text drawn on top of other text, the way it really appears on a desktop screen. Faded decoration, sliders and hidden menus are left out.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    return overlapFinding((await page.evaluate(OVERLAP_JS)) as string[], url, false);
  },
};

export const overlapPhoneAgent: PageAgent = {
  id: "ui.overlap-phone",
  name: "Overlapping text on phones",
  description: "The same check at a phone's width (390 px), where text that fitted side by side has to wrap and often runs into other text.",
  category: "mobile",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  async run({ page, url }) {
    return overlapFinding((await page.evaluate(OVERLAP_JS)) as string[], url, true);
  },
};

// ---------------------------------------------------------------------------------------------

/**
 * Short labels (buttons, links, headings, table cells, badges) whose words are cut off by their
 * own box. Text cut with "…" on purpose, and long blocks folded behind a "Read more", are left out.
 */
const CUT_JS = `(function () {
  var describe = ${DESCRIBE_JS};
  var out = [];
  var els = document.querySelectorAll("button, a, label, h1, h2, h3, h4, h5, h6, th, td, li, dt, dd, [role=button], [role=tab], [role=menuitem], span, div, p");
  var inline = /^(B|I|EM|STRONG|SMALL|SPAN|SVG|IMG|ABBR|CODE|SUB|SUP|MARK|BR|WBR)$/;
  for (var i = 0; i < els.length && out.length < 40 && i < 6000; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    var hides = function (v) { return v === "hidden" || v === "clip"; };
    if (!hides(cs.overflowX) && !hides(cs.overflowY)) continue;
    if (cs.textOverflow === "ellipsis" || (cs.webkitLineClamp && cs.webkitLineClamp !== "none")) continue;
    var plain = true;
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) if (!inline.test(c.tagName)) { plain = false; break; }
    if (!plain) continue;
    var text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (text.length < 2 || text.length > 120) continue;
    if (el.clientWidth <= 20 || el.clientHeight <= 8) continue; // hidden for screen readers, or an icon font
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    if (el.closest(${MOVING})) continue;
    var wide = hides(cs.overflowX) && el.scrollWidth > el.clientWidth + 3;
    var tall = hides(cs.overflowY) && el.scrollHeight > el.clientHeight + 3 && el.clientHeight < 2.2 * (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.3);
    if (wide || tall) out.push(describe(el) + (wide ? "  (cut at the side)" : "  (cut at the bottom)"));
  }
  return out;
})()`;

export const cutTextAgent: PageAgent = {
  id: "ui.cut-text",
  name: "Cut-off labels",
  description: "Finds buttons, links, headings and table cells whose words are cut off by their own box, with no \"…\" to show something is missing, at a phone's width.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  async run({ page, url }) {
    // The page agents ran at desktop size; this one runs at phone size, where most labels get cut.
    const cut = (await page.evaluate(CUT_JS)) as string[];
    if (!cut.length) return [];
    return [
      finding({
        category: "mobile",
        rule: "ui:text-cut-off",
        severity: "low",
        title: `${cut.length} label${cut.length === 1 ? " is" : "s are"} cut off on a phone`,
        detail:
          "Part of the words is hidden by the element's own box (overflow: hidden with a fixed width or height), so visitors read half a label. Let the box grow (min-height instead of height), let the text wrap, or shorten the label.",
        pageUrl: url,
        evidence: list(cut),
        count: cut.length,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------

/**
 * Bars that stay on screen (headers, footers, chat and cookie bars) and pop-ups shown on arrival,
 * measured at a phone's size. Only what really sits on top of the page counts: the browser is
 * asked which element is drawn at the bar's centre.
 */
const COVER_JS = `(function () {
  var describe = ${DESCRIBE_JS};
  var vw = innerWidth, vh = innerHeight;
  var bars = [], popups = [];
  var spans = [];
  var els = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < els.length && i < 8000; i++) {
    var el = els[i];
    var cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    // A bar inside another bar is measured with it.
    var inBar = false;
    for (var up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      var pos = getComputedStyle(up).position;
      if (pos === "fixed" || pos === "sticky") { inBar = true; break; }
    }
    if (inBar) continue;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    var r = el.getBoundingClientRect();
    var top = Math.max(0, r.top), bottom = Math.min(vh, r.bottom), left = Math.max(0, r.left), right = Math.min(vw, r.right);
    if (bottom - top < 10 || right - left < 0.6 * vw) continue;
    var hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
    if (!hit || (hit !== el && !el.contains(hit))) continue;
    var text = (el.innerText || "").toLowerCase();
    var dialog = el.matches("dialog, [role=dialog], [role=alertdialog], [aria-modal=true]") || !!el.querySelector("[role=dialog], [aria-modal=true]");
    var legal = /cookie|consent|gdpr|privacy|age verification|are you (over )?18|kuki/.test(text);
    if (bottom - top > 0.5 * vh) {
      if (!legal) popups.push(describe(el) + " covers " + Math.round(100 * (bottom - top) / vh) + "% of the screen");
      continue;
    }
    if (dialog) continue;
    spans.push([top, bottom]);
    bars.push(describe(el) + ": " + Math.round(bottom - top) + " px");
  }
  spans.sort(function (a, b) { return a[0] - b[0]; });
  var covered = 0, end = -1;
  spans.forEach(function (s) { if (s[1] <= end) return; covered += s[1] - Math.max(s[0], end); end = s[1]; });
  return { share: covered / vh, bars: bars, popups: popups };
})()`;

export const coverAgent: PageAgent = {
  id: "ui.cover",
  name: "Bars and pop-ups covering the phone screen",
  description:
    "At a phone's size, adds up the headers, footers and bars that stay on screen while scrolling, and finds pop-ups that cover the page as soon as it opens (Google lowers pages with such pop-ups). Cookie and age notices are allowed.",
  category: "mobile",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  async run({ page, url }) {
    const c = (await page.evaluate(COVER_JS)) as { share: number; bars: string[]; popups: string[] };
    const out: Finding[] = [];
    if (c.share > 0.3) {
      out.push(
        finding({
          category: "mobile",
          rule: "ui:sticky-cover",
          severity: c.share > 0.45 ? "medium" : "low",
          title: `Bars that stay on screen take ${Math.round(c.share * 100)}% of a phone screen`,
          detail:
            "Headers, footers and bars with position: fixed or sticky stay on screen while visitors scroll, leaving little room to read. Keep them under about a quarter of the screen: shrink the header on scroll, or let it scroll away and come back when the visitor scrolls up.",
          pageUrl: url,
          evidence: list(c.bars),
        }),
      );
    }
    if (c.popups.length) {
      out.push(
        finding({
          category: "mobile",
          rule: "ui:intrusive-popup",
          severity: "medium",
          title: "A pop-up covers the page on a phone as soon as it opens",
          detail:
            "Visitors must close it before they can read anything, and Google ranks pages with such pop-ups lower on phones. Show it later (after scrolling or on leaving), or use a small banner instead.",
          pageUrl: url,
          evidence: list(c.popups),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const READ_JS = `(function () {
  var describe = ${DESCRIBE_JS};
  var long = [], justified = [];
  var els = document.querySelectorAll("p, li, dd, blockquote, article > div");
  for (var i = 0; i < els.length && i < 3000; i++) {
    var el = els[i];
    var text = (el.innerText || "").replace(/\\s+/g, " ").trim();
    if (text.length < 200) continue;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) continue;
    var cs = getComputedStyle(el);
    if (cs.textAlign === "justify" && justified.length < 20) justified.push(describe(el));
    var lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    var lines = Math.round(el.getBoundingClientRect().height / lh);
    if (lines < 3) continue;
    var perLine = text.length / lines;
    // Scripts without spaces between words (Chinese, Japanese, Thai) carry more meaning per character.
    if (/[\\u0E00-\\u0E7F\\u3040-\\u30FF\\u4E00-\\u9FFF]/.test(text)) continue;
    if (perLine > 120 && long.length < 20) long.push(describe(el) + ": about " + Math.round(perLine) + " characters a line");
  }
  return { long: long, justified: justified };
})()`;

export const readabilityAgent: PageAgent = {
  id: "ui.readability",
  name: "Reading comfort",
  description: "Finds paragraphs with lines too long to read easily on a desktop screen (over 120 characters), and justified text, which leaves uneven gaps that make reading hard for people with dyslexia (WCAG 1.4.8).",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url }) {
    const r = (await page.evaluate(READ_JS)) as { long: string[]; justified: string[] };
    const out: Finding[] = [];
    if (r.long.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "ui:long-lines",
          severity: "low",
          title: `${r.long.length} paragraph${r.long.length === 1 ? " has" : "s have"} lines too long to read easily`,
          detail:
            "Readers lose their place when lines run past about 80 characters (WCAG 1.4.8 asks for 80 at most). Limit the text column, for example max-width: 70ch on paragraphs.",
          pageUrl: url,
          evidence: list(r.long),
          count: r.long.length,
        }),
      );
    }
    if (r.justified.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "ui:justified-text",
          severity: "low",
          title: `${r.justified.length} paragraph${r.justified.length === 1 ? " is" : "s are"} justified`,
          detail:
            "Justified text stretches the gaps between words unevenly, which makes reading harder for people with dyslexia (WCAG 1.4.8). Align text to the left (or to the right for Arabic and Urdu).",
          pageUrl: url,
          evidence: list(r.justified),
          count: r.justified.length,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Tablet size (820 x 1180, an iPad Air held upright): the width where desktop menus are often
// hidden and the phone menu button is not shown yet, so the menu disappears completely.

const TABLET_JS = `(function () {
  var out = { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, navLinks: 0, toggles: 0, hiddenNav: 0, small: [] };
  function shown(el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; }
  var navs = document.querySelectorAll("nav, header [role=navigation], [role=navigation]");
  navs.forEach(function (n) {
    var links = n.querySelectorAll("a[href]");
    var visible = 0; links.forEach(function (a) { if (shown(a)) visible++; });
    out.navLinks += visible;
    if (links.length >= 3 && visible === 0) out.hiddenNav++;
  });
  document.querySelectorAll("button, [role=button], [aria-controls], [aria-expanded], .navbar-toggler, .menu-toggle, .hamburger, [class*=burger], [class*=menu-toggle]").forEach(function (b) { if (shown(b)) out.toggles++; });
  var targets = document.querySelectorAll("a[href], button, input:not([type=hidden]), select, [role=button]");
  for (var i = 0; i < targets.length && out.small.length < 8; i++) {
    var el = targets[i]; if (!shown(el)) continue;
    var r = el.getBoundingClientRect();
    if ((r.width < 24 || r.height < 24) && (el.innerText || "").trim().length < 3 && r.top < innerHeight * 3) out.small.push((el.getAttribute("aria-label") || el.tagName.toLowerCase()) + " " + Math.round(r.width) + "x" + Math.round(r.height));
  }
  return out;
})()`;

export const tabletAgent: PageAgent = {
  id: "web.tablet",
  name: "Tablet layout",
  description:
    "Resizes to a tablet held upright (820 x 1180, like an iPad Air): sideways scrolling, a menu that vanishes because the desktop menu is hidden and the phone menu button is not shown yet, tap targets too small for a finger, and text drawn over other text.",
  category: "mobile",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "tablet",
  skipErrorPages: true,
  async run({ page, url }) {
    const out: Finding[] = [];
    const r = (await page.evaluate(TABLET_JS)) as { overflow: number; navLinks: number; toggles: number; hiddenNav: number; small: string[] };
    if (r.overflow > 5) {
      out.push(finding({ category: "mobile", rule: "tablet-overflow", severity: "medium", title: `Page scrolls sideways on tablets (${r.overflow}px too wide)`, detail: "At 820 px wide something is wider than the screen. Desktop layouts with fixed widths (a 960 px container, a wide table, a big image) break first on tablets. Use max-width: 100% and let rows wrap.", pageUrl: url, evidence: `scrollWidth - clientWidth = ${r.overflow}px at 820 x 1180` }));
    }
    if (r.hiddenNav > 0 && r.navLinks === 0 && r.toggles === 0) {
      out.push(finding({ category: "mobile", rule: "tablet-menu-missing", severity: "high", title: "The menu disappears on tablets", detail: "At 820 px wide the site's navigation links are hidden and no menu button is shown, so tablet visitors cannot reach other pages. The desktop menu is usually hidden below one breakpoint (say 992 px) and the phone button shown only below another (say 768 px): make the two breakpoints the same.", pageUrl: url, evidence: `${r.hiddenNav} navigation block(s) with links, none visible; no menu button visible` }));
    }
    if (r.small.length >= 3) {
      out.push(finding({ category: "mobile", rule: "tablet-small-targets", severity: "low", title: `${r.small.length} buttons or links are too small to tap on a tablet`, detail: "Fingers need targets of at least 24 x 24 px (WCAG 2.2, 2.5.8), better 44 x 44 px. Icons that work with a mouse are often too small to tap.", pageUrl: url, evidence: r.small.join("\n"), count: r.small.length }));
    }
    const pairs = (await page.evaluate(OVERLAP_JS)) as string[];
    if (pairs.length) {
      out.push(finding({ category: "mobile", rule: "ui:text-overlap-tablet", severity: "medium", title: `Text is drawn over other text in ${pairs.length} place${pairs.length === 1 ? "" : "s"} on a tablet`, detail: "At a tablet's width (820 px) text that fitted on a desktop wraps and runs into other text. Look for fixed heights and position: absolute.", pageUrl: url, evidence: list(pairs), count: pairs.length }));
    }
    return out;
  },
};
