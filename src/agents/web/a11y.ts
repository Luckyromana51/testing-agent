import { writeFile } from "node:fs/promises";
import path from "node:path";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent } from "../types.js";
import { DESCRIBE_JS } from "./guard.js";

/**
 * Accessibility checks that need the page to be used, not only read: the keyboard, zoom, text
 * spacing and motion settings a visitor can choose, and what a screen reader announces. They add
 * to the axe rules (web.accessibility) and never repeat them.
 */

const list = (items: string[], max = 6) => items.slice(0, max).join("\n") + (items.length > max ? `\n…and ${items.length - max} more` : "");

// ---------------------------------------------------------------------------------------------

interface TabStop {
  key: number;
  desc: string;
  visible: boolean;
  obscuredBy: string;
  positive: boolean;
  inModal: boolean;
}

/** Presses Tab through the page like a keyboard user, and checks every stop. */
export const keyboardAgent: PageAgent = {
  id: "a11y.keyboard",
  name: "Keyboard use",
  description:
    "Presses Tab through the page like a keyboard user: finds focus that cannot be seen, focus stuck in one place, focused items hidden behind sticky bars, and clickable things the keyboard cannot reach.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  interacts: true,
  async run({ page, url }) {
    const out: Finding[] = [];
    // How every focusable element (and its parent and ::before/::after) looks before it has focus.
    const total = (await page.evaluate(`(function () {
      var describe = ${DESCRIBE_JS};
      var look = function (el) {
        var parts = [];
        var add = function (cs) {
          parts.push(cs.outlineStyle, cs.outlineWidth, cs.outlineColor, cs.boxShadow, cs.borderTopColor, cs.borderBottomColor,
            cs.borderBottomWidth, cs.backgroundColor, cs.color, cs.textDecorationLine, cs.transform, cs.opacity, cs.left, cs.top,
            cs.clip, cs.clipPath, cs.width, cs.height, cs.visibility, cs.fontWeight);
        };
        add(getComputedStyle(el));
        add(getComputedStyle(el, "::before"));
        add(getComputedStyle(el, "::after"));
        if (el.parentElement) add(getComputedStyle(el.parentElement));
        return parts.join("|");
      };
      var sel = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex], summary, iframe, [contenteditable=""], [contenteditable="true"]';
      var els = Array.prototype.slice.call(document.querySelectorAll(sel), 0, 600);
      window.__glvLook = look;
      window.__glvDescribe = describe;
      window.__glvFocus = els.map(function (el) { return { el: el, look: look(el) }; });
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      window.scrollTo(0, 0);
      return els.length;
    })()`)) as number;
    if (!total) return out;

    const stops: TabStop[] = [];
    let sameInARow = 0;
    let trapped = "";
    for (let i = 0; i < 70; i++) {
      await page.keyboard.press("Tab");
      const stop = (await page.evaluate(`(function () {
        var el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        var list = window.__glvFocus || [];
        var key = -1;
        for (var i = 0; i < list.length; i++) if (list[i].el === el) { key = i; break; }
        var r = el.getBoundingClientRect();
        var visible = el.tagName === "IFRAME" || key < 0 || list[key].look !== window.__glvLook(el);
        var obscuredBy = "";
        var cx = r.left + r.width / 2, cy = r.top + Math.min(r.height / 2, 10);
        if (r.width && r.height && cx >= 0 && cy >= 0 && cx < innerWidth && cy < innerHeight) {
          var top = document.elementFromPoint(cx, cy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) {
            for (var n = top; n && n !== document.body; n = n.parentElement) {
              var pos = getComputedStyle(n).position;
              if (pos === "fixed" || pos === "sticky") { obscuredBy = window.__glvDescribe(n); break; }
            }
          }
        }
        return {
          key: key,
          desc: window.__glvDescribe(el),
          visible: visible,
          obscuredBy: obscuredBy,
          positive: Number(el.getAttribute("tabindex")) > 0,
          inModal: Boolean(el.closest('[aria-modal="true"], dialog[open]')),
        };
      })()`)) as TabStop | null;
      if (!stop) {
        if (stops.length) break; // focus left the page after the last item: the walk is complete
        continue;
      }
      const last = stops.at(-1);
      if (last && last.key === stop.key && last.desc === stop.desc) {
        sameInARow++;
        if (sameInARow >= 3) {
          trapped = stop.desc;
          break;
        }
        continue;
      }
      sameInARow = 0;
      // Back at the first stop after going round a small group: a loop the keyboard cannot leave.
      if (stops.length >= 2 && stop.key === stops[0].key && stop.key >= 0 && !stop.inModal && stops.length + 5 < total) {
        trapped = `${stops.map((s) => s.desc).slice(0, 4).join(" → ")} → back to the start`;
        break;
      }
      stops.push(stop);
    }

    if (trapped && !stops.at(-1)?.inModal) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:keyboard-trap",
          severity: "high",
          title: "Keyboard focus gets stuck",
          detail:
            "Pressing Tab stops moving forward, so a keyboard user cannot reach the rest of the page (WCAG 2.1.2, level A). Let Tab and Shift+Tab leave every widget, or tell the user which key does.",
          pageUrl: url,
          evidence: trapped,
        }),
      );
    }
    const hidden = stops.filter((s) => !s.visible);
    if (hidden.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:focus-not-visible",
          severity: "medium",
          title: `${hidden.length} item${hidden.length === 1 ? " shows" : "s show"} no sign of keyboard focus`,
          detail:
            "When these get keyboard focus nothing on screen changes, so a keyboard user cannot see where they are (WCAG 2.4.7, level AA). Usually a style removes the outline (outline: none) without a replacement.",
          pageUrl: url,
          evidence: list(hidden.map((s) => s.desc)),
          count: hidden.length,
        }),
      );
    }
    const covered = stops.filter((s) => s.obscuredBy);
    if (covered.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:focus-obscured",
          severity: "medium",
          title: `${covered.length} focused item${covered.length === 1 ? " is" : "s are"} hidden behind a fixed bar`,
          detail: "A sticky header, footer or banner covers the item that has keyboard focus (WCAG 2.4.11, level AA).",
          pageUrl: url,
          evidence: list(covered.map((s) => `${s.desc} under ${s.obscuredBy}`)),
          count: covered.length,
        }),
      );
    }
    const positive = stops.filter((s) => s.positive);
    if (positive.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:positive-tabindex",
          severity: "low",
          title: "Tab order is forced with tabindex above 0",
          detail: "A tabindex above 0 makes the keyboard jump around the page out of reading order (WCAG 2.4.3). Use tabindex=\"0\" and order the HTML instead.",
          pageUrl: url,
          evidence: list(positive.map((s) => s.desc)),
        }),
      );
    }

    // Things that react to a mouse click but can never get keyboard focus.
    const candidates = (await page.evaluate(`(function () {
      var describe = ${DESCRIBE_JS};
      var out = [];
      var all = document.querySelectorAll("div, span, li, img, svg, p, td, i, section, article");
      for (var i = 0; i < all.length && out.length < 40; i++) {
        var el = all[i];
        if (el.closest("a[href], button, label, summary, select, input, textarea, [tabindex], [contenteditable]")) continue;
        var cs = getComputedStyle(el);
        if (cs.cursor !== "pointer" || cs.visibility === "hidden" || cs.display === "none") continue;
        var r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        // Only the outermost element with the pointer, not each child inside it.
        if (el.parentElement && getComputedStyle(el.parentElement).cursor === "pointer" && !el.parentElement.closest("a[href], button")) continue;
        el.setAttribute("data-glv-k", String(out.length));
        out.push(describe(el));
      }
      return out;
    })()`)) as string[];
    if (candidates.length) {
      const cdp = await page.context().newCDPSession(page);
      const unreachable: string[] = [];
      try {
        for (let i = 0; i < candidates.length; i++) {
          const { result } = await cdp.send("Runtime.evaluate", { expression: `document.querySelector('[data-glv-k="${i}"]')` });
          if (!result.objectId) continue;
          const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId, depth: 0 });
          if (listeners.some((l) => ["click", "mousedown", "mouseup", "pointerdown", "pointerup"].includes(l.type))) unreachable.push(candidates[i]);
        }
      } finally {
        await cdp.detach().catch(() => {});
      }
      if (unreachable.length) {
        out.push(
          finding({
            category: "accessibility",
            rule: "a11y:click-only",
            severity: "medium",
            title: `${unreachable.length} clickable item${unreachable.length === 1 ? "" : "s"} cannot be reached with the keyboard`,
            detail:
              "These react to a mouse click but are not links or buttons and cannot get keyboard focus, so keyboard and screen reader users cannot use them (WCAG 2.1.1, level A).",
            pageUrl: url,
            evidence: list(unreachable),
            count: unreachable.length,
          }),
        );
      }
    }

    await page.evaluate(`(function () {
      var marked = document.querySelectorAll("[data-glv-k]");
      for (var i = 0; i < marked.length; i++) marked[i].removeAttribute("data-glv-k");
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      delete window.__glvFocus; delete window.__glvLook; delete window.__glvDescribe;
      window.scrollTo(0, 0);
    })()`);
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const OVERFLOW_JS = "document.documentElement.scrollWidth - document.documentElement.clientWidth";

/** Browser zoom at 200% and 400%: the page must still fit without scrolling sideways. */
export const zoomAgent: PageAgent = {
  id: "a11y.zoom",
  name: "Zoom 200% and 400%",
  description:
    "Zooms the page like a visitor with low vision (200% and 400%, WCAG 1.4.4 and 1.4.10) and checks it still fits the screen without scrolling sideways.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  interacts: true,
  async run({ page, url }) {
    const before = page.viewportSize();
    if (!before) return [];
    const out: Finding[] = [];
    // At a phone's width the phone agent already reports sideways scrolling: report zoom only when the phone fits.
    if (Number(await page.evaluate(OVERFLOW_JS)) > 5) return out;
    const widths: [number, string, string, string][] = [
      [683, "a11y:zoom-200", "200%", "1.4.4, level AA"],
      [320, "a11y:reflow-400", "400%", "1.4.10, level AA"],
    ];
    try {
      for (const [width, rule, zoom, wcag] of widths) {
        await page.setViewportSize({ width, height: width === 320 ? 640 : 768 });
        // Layout follows at once; the pause lets resize handlers of the page's own scripts run.
        await page.waitForTimeout(120);
        const overflow = (await page.evaluate(OVERFLOW_JS)) as number;
        if (overflow > 5) {
          out.push(
            finding({
              category: "accessibility",
              rule,
              severity: "medium",
              title: `Page scrolls sideways at ${zoom} zoom`,
              detail: `At ${zoom} browser zoom (${width} px wide) the page is ${overflow} px too wide, so visitors who zoom in must scroll sideways on every line (WCAG ${wcag}). Check fixed widths and wide tables or images.`,
              pageUrl: url,
            }),
          );
        }
      }
    } finally {
      await page.setViewportSize(before);
      await page.waitForTimeout(60);
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const CLIPPED_JS = `(function () {
  var describe = ${DESCRIBE_JS};
  var out = [];
  var els = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < els.length && i < 4000; i++) {
    var el = els[i];
    if (!el.innerText || el.innerText.trim().length < 3) continue;
    var cs = getComputedStyle(el);
    var hides = function (v) { return v === "hidden" || v === "clip"; };
    if (!hides(cs.overflowX) && !hides(cs.overflowY)) continue;
    if (cs.display === "none" || cs.visibility === "hidden" || cs.textOverflow === "ellipsis" || cs.webkitLineClamp !== "none" && cs.webkitLineClamp) continue;
    if (el.clientWidth <= 2 || el.clientHeight <= 2) continue; // visually hidden text for screen readers
    var cut = (hides(cs.overflowY) && el.scrollHeight > el.clientHeight + 2) || (hides(cs.overflowX) && el.scrollWidth > el.clientWidth + 2);
    if (cut) out.push(describe(el));
  }
  return out;
})()`;

/** WCAG 1.4.12: visitors who widen line, letter and word spacing must not lose text. */
export const textSpacingAgent: PageAgent = {
  id: "a11y.text-spacing",
  name: "Text spacing",
  description:
    "Widens line, letter, word and paragraph spacing the way people with dyslexia set their browser (WCAG 1.4.12) and finds text that gets cut off.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  interacts: true,
  async run({ page, url }) {
    const before = new Set((await page.evaluate(CLIPPED_JS)) as string[]);
    await page.addStyleTag({
      content:
        "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }",
    });
    await page.waitForTimeout(150);
    const after = (await page.evaluate(CLIPPED_JS)) as string[];
    // Take the spacing away again: the next agents and the screenshot see the page as it was.
    await page.evaluate(`(function () {
      var tags = document.querySelectorAll("style");
      for (var i = tags.length - 1; i >= 0; i--) if (tags[i].textContent.indexOf("letter-spacing: 0.12em !important") >= 0) { tags[i].remove(); break; }
    })()`);
    const lost = [...new Set(after.filter((d) => !before.has(d)))];
    if (!lost.length) return [];
    return [
      finding({
        category: "accessibility",
        rule: "a11y:text-spacing",
        severity: "medium",
        title: `Text is cut off when spacing is widened (${lost.length} place${lost.length === 1 ? "" : "s"})`,
        detail:
          "With the wider line, letter and word spacing some visitors need (WCAG 1.4.12, level AA), this text no longer fits its box and part of it is hidden. Avoid fixed heights on text boxes; let them grow.",
        pageUrl: url,
        evidence: list(lost),
        count: lost.length,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------

const VAGUE = new Set(["click here", "here", "read more", "more", "learn more", "details", "more details", "link", "this", "continue", "go", "click", "know more", "view more", "see more"]);

/** What a screen reader announces: saved per page, and checked for structure problems axe leaves to best practice. */
export const screenReaderAgent: PageAgent = {
  id: "a11y.screen-reader",
  name: "Screen reader view",
  description:
    "Saves what a screen reader announces on each page (our own JAWS/NVDA view) and checks it: skipped heading levels, no main area, and links that all say \"Read more\" or share a name but go to different places.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  async run({ page, url, result, index, artifactsDir }) {
    const out: Finding[] = [];
    const tree = await page.locator("body").ariaSnapshot({ timeout: 8000 }).catch(() => "");
    if (tree) {
      const file = `page-${index}-screen-reader.txt`;
      await writeFile(path.join(artifactsDir, file), tree.slice(0, 300_000));
      result.files = [...(result.files ?? []), { label: "Screen reader view", file }];
    }
    const facts = (await page.evaluate(`(function () {
      var visible = function (el) { var r = el.getBoundingClientRect(); var cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true"; };
      var text = function (el) { return (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(); };
      var nameOf = function (el) {
        var by = el.getAttribute("aria-labelledby");
        if (by) { var t = by.split(/\\s+/).map(function (id) { var x = document.getElementById(id); return x ? text(x) : ""; }).join(" ").trim(); if (t) return t; }
        var label = el.getAttribute("aria-label");
        if (label && label.trim()) return label.trim();
        var own = text(el);
        if (own) return own;
        var img = el.querySelector("img[alt]");
        if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt").trim();
        return (el.getAttribute("title") || "").trim();
      };
      var headings = [];
      var hs = document.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]");
      for (var i = 0; i < hs.length; i++) {
        var h = hs[i];
        if (!visible(h)) continue;
        var level = h.getAttribute("aria-level") ? Number(h.getAttribute("aria-level")) : Number(h.tagName.charAt(1)) || 2;
        headings.push({ level: level, text: text(h).slice(0, 60) });
      }
      var links = [];
      var as = document.querySelectorAll("a[href]");
      for (var j = 0; j < as.length && links.length < 600; j++) {
        var a = as[j];
        if (!visible(a)) continue;
        var described = a.getAttribute("aria-describedby") || a.getAttribute("title");
        links.push({ name: nameOf(a).toLowerCase().slice(0, 80), href: a.href.split("#")[0], described: Boolean(described) });
      }
      return {
        headings: headings,
        links: links,
        main: Boolean(document.querySelector("main, [role=main]")),
        words: text(document.body).split(" ").length,
      };
    })()`)) as { headings: { level: number; text: string }[]; links: { name: string; href: string; described: boolean }[]; main: boolean; words: number };

    const skips: string[] = [];
    for (let i = 1; i < facts.headings.length; i++) {
      const [a, b] = [facts.headings[i - 1], facts.headings[i]];
      if (b.level > a.level + 1) skips.push(`h${a.level} "${a.text}" → h${b.level} "${b.text}"`);
    }
    if (skips.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:heading-skip",
          severity: "low",
          title: "Heading levels are skipped",
          detail:
            "Screen reader users move through a page by its headings. A jump from h2 to h4 makes them think part of the page is missing (WCAG 1.3.1). Use the next level down, and style it with CSS.",
          pageUrl: url,
          evidence: list(skips, 4),
        }),
      );
    }
    if (!facts.main && facts.words > 80) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:no-main",
          severity: "low",
          title: "No main content area is marked",
          detail: "Without a <main> element, screen reader users cannot jump straight past the menu to the content.",
          pageUrl: url,
        }),
      );
    }
    const vague = facts.links.filter((l) => VAGUE.has(l.name) && !l.described);
    if (vague.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:vague-link",
          severity: "low",
          title: `${vague.length} link${vague.length === 1 ? " says" : "s say"} only "${vague[0].name}"`,
          detail:
            "Screen reader users often list all the links on a page; \"Read more\" five times tells them nothing (WCAG 2.4.4). Name the target, e.g. \"Read more about pricing\", or add the words for screen readers with aria-label.",
          pageUrl: url,
          evidence: list([...new Set(vague.map((l) => `"${l.name}" → ${l.href}`))]),
          count: vague.length,
        }),
      );
    }
    const byName = new Map<string, Set<string>>();
    for (const l of facts.links) {
      if (!l.name || VAGUE.has(l.name) || l.described) continue;
      byName.set(l.name, (byName.get(l.name) ?? new Set()).add(l.href));
    }
    const clashes = [...byName].filter(([, hrefs]) => hrefs.size > 1);
    if (clashes.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:same-name-links",
          severity: "low",
          title: `${clashes.length} link name${clashes.length === 1 ? " is" : "s are"} used for different pages`,
          detail: "Links with the same words should go to the same place; otherwise screen reader users cannot tell them apart. Make each name say where it goes.",
          pageUrl: url,
          evidence: list(clashes.map(([name, hrefs]) => `"${name}" → ${[...hrefs].slice(0, 3).join(", ")}`)),
          count: clashes.length,
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

/** Visitors who get dizzy or distracted ask for less motion; video must not play sound on its own. */
export const motionAgent: PageAgent = {
  id: "a11y.motion",
  name: "Motion and sound",
  description:
    "Turns on the \"reduce motion\" setting and finds animations that keep running anyway, and finds video or audio that plays sound on its own (WCAG 1.4.2).",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "page",
  skipErrorPages: true,
  interacts: true,
  async run({ page, url }) {
    const out: Finding[] = [];
    await page.emulateMedia({ reducedMotion: "reduce" });
    let facts: { moving: string[]; sound: string[] };
    try {
      // Style updates at once (getAnimations reads it fresh); the pause lets matchMedia listeners run.
      await page.waitForTimeout(100);
      facts = (await page.evaluate(`(function () {
        var describe = ${DESCRIBE_JS};
        var moving = [];
        var seen = [];
        var anims = document.getAnimations ? document.getAnimations() : [];
        for (var i = 0; i < anims.length; i++) {
          var a = anims[i];
          if (a.playState !== "running" || !a.effect || !a.effect.target) continue;
          var t = a.effect.getTiming();
          if (t.iterations !== Infinity) continue;
          var el = a.effect.target;
          if (seen.indexOf(el) >= 0) continue;
          seen.push(el);
          if (el.closest('[role=progressbar], [aria-busy="true"]') || /spin|load|progress/i.test((el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) + " " + el.id)) continue;
          var r = el.getBoundingClientRect();
          if (r.width * r.height < 500 || r.bottom < 0 || r.top > innerHeight * 3) continue;
          var name = a.animationName ? "animation " + a.animationName : "an endless animation";
          moving.push((el.parentElement ? describe(el.parentElement) + " > " : "") + describe(el) + " (" + name + ", " + Math.round(r.width) + "×" + Math.round(r.height) + " px)");
        }
        var marquees = document.querySelectorAll("marquee");
        for (var m = 0; m < marquees.length; m++) moving.push(describe(marquees[m]));
        var sound = [];
        var media = document.querySelectorAll("video, audio");
        for (var k = 0; k < media.length; k++) if (media[k].autoplay && !media[k].muted) sound.push(describe(media[k]) + " " + (media[k].currentSrc || media[k].src || "").slice(0, 80));
        return { moving: moving, sound: sound };
      })()`)) as { moving: string[]; sound: string[] };
    } finally {
      await page.emulateMedia({ reducedMotion: null });
    }
    if (facts.moving.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:ignores-reduced-motion",
          severity: "low",
          title: `${facts.moving.length} animation${facts.moving.length === 1 ? " keeps" : "s keep"} running when the visitor asks for less motion`,
          detail:
            "Some visitors set \"reduce motion\" because movement makes them dizzy or distracts them. Stop or shorten these animations inside @media (prefers-reduced-motion: reduce), and give moving content that lasts more than 5 seconds a pause button (WCAG 2.2.2).",
          pageUrl: url,
          evidence: list(facts.moving),
          count: facts.moving.length,
        }),
      );
    }
    if (facts.sound.length) {
      out.push(
        finding({
          category: "accessibility",
          rule: "a11y:autoplay-sound",
          severity: "medium",
          title: "Video or audio plays sound on its own",
          detail:
            "Sound that starts by itself drowns out a screen reader (WCAG 1.4.2, level A). Start it muted, or only when the visitor presses play.",
          pageUrl: url,
          evidence: list(facts.sound),
        }),
      );
    }
    return out;
  },
};
