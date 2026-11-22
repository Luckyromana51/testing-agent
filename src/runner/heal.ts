import type { Locator, Page } from "playwright";

/**
 * Self-healing journey steps: when a step's button or field is not found the usual way (its words
 * changed a little, its id was renamed in a release), look for the closest match by everything a
 * person or the code can tell it by: visible text, aria-label, title, placeholder, label, value, alt,
 * name, id and test ids. The step goes on, and the report says what was used so the journey can be
 * updated. Only near-certain matches count; otherwise the step fails as before.
 */

/** Words of a target: "Add to cart", "#add-to-cart-btn" and "addToCart" all give add, to, cart. */
export function wordsOf(text: string): string[] {
  return text
    .replace(/^(css|xpath)=/i, "")
    .replace(/^[#.]/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9ऀ-ॿ]+/)
    .filter((w) => w && !["btn", "button", "link", "input", "field", "the", "a", "an", "js", "id"].includes(w));
}

/** How alike two word lists are (Dice coefficient over words, with near spellings counted). Pure, for tests. */
export function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const near = (x: string, y: string) => x === y || (x.length > 3 && y.length > 3 && (x.startsWith(y) || y.startsWith(x)));
  let hits = 0;
  const used = new Set<number>();
  for (const w of a) {
    const i = b.findIndex((v, j) => !used.has(j) && near(w, v));
    if (i >= 0) {
      used.add(i);
      hits++;
    }
  }
  return (2 * hits) / (a.length + b.length);
}

export interface Candidate {
  /** Index among the candidates the page returned. */
  i: number;
  /** Every name the element can be found by. */
  names: string[];
}

/** Picks the best candidate for the target, or none when no match is close enough. Pure, for tests. */
export function bestCandidate(target: string, candidates: Candidate[], min = 0.66): { i: number; by: string; score: number } | null {
  const want = wordsOf(target);
  let best: { i: number; by: string; score: number } | null = null;
  let second = 0;
  for (const c of candidates) {
    let top = 0;
    let by = "";
    for (const n of c.names) {
      const s = similarity(want, wordsOf(n));
      if (s > top) {
        top = s;
        by = n;
      }
    }
    if (!best || top > best.score) {
      second = best?.score ?? 0;
      best = { i: c.i, by, score: top };
    } else if (top > second) second = top;
  }
  // Two equally good matches are a guess, not a heal.
  if (!best || best.score < min || best.score - second < 0.01) return null;
  return best;
}

const COLLECT = (kind: "click" | "field") => `(function () {
  var sel = ${JSON.stringify(
    "button, a[href], [role=button], [role=link], [role=menuitem], [role=tab], input[type=submit], input[type=button], summary, label",
  )};
  var fsel = "input:not([type=hidden]), textarea, select, [contenteditable=true]";
  var els = document.querySelectorAll(${kind === "click" ? "sel" : "fsel"});
  var out = [];
  for (var i = 0; i < els.length && out.length < 400; i++) {
    var el = els[i];
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    var names = [];
    var push = function (v) { if (v && String(v).trim()) names.push(String(v).trim().slice(0, 120)); };
    push(el.innerText);
    ["aria-label", "title", "placeholder", "value", "alt", "name", "id", "data-testid", "data-test", "data-qa", "data-cy"].forEach(function (a) { push(el.getAttribute(a)); });
    if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) push(l.innerText); }
    if (el.closest("label")) push(el.closest("label").innerText);
    var img = el.querySelector && el.querySelector("img[alt]"); if (img) push(img.getAttribute("alt"));
    el.setAttribute("data-glv-heal", String(out.length));
    out.push({ i: out.length, names: names });
  }
  return out;
})()`;

/** Finds the closest element for a step whose target was not found. Returns its locator and how it was found. */
export async function healLocator(page: Page, target: string, kind: "click" | "field"): Promise<{ locator: Locator; how: string } | null> {
  const candidates = (await page.evaluate(COLLECT(kind)).catch(() => [])) as Candidate[];
  const best = bestCandidate(target, candidates);
  if (!best) return null;
  return { locator: page.locator(`[data-glv-heal="${best.i}"]`).first(), how: `"${best.by}" (${Math.round(best.score * 100)}% match)` };
}
