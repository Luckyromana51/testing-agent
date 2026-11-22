import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, PageContext } from "../types.js";

/**
 * Layout-aware visual check for phones: instead of comparing pixels (which flags harmless colour and
 * text shifts), it reads the box geometry after the window is a phone and catches real layout breaks —
 * the page scrolling sideways, and blocks of content pushed off the side of the screen. A small shift
 * is ignored; only a break wide enough for a person to notice is reported.
 */

export interface BoxInfo {
  tag: string;
  left: number;
  right: number;
  width: number;
}

/** Real layout breaks at a phone width. Pure, for tests. */
export function layoutBreaks(viewport: number, scrollWidth: number, boxes: BoxInfo[]): { sideScroll: number; offCanvas: BoxInfo[] } {
  const sideScroll = Math.max(0, scrollWidth - viewport);
  // Blocks that start well off the right edge, or whose own width is wider than the screen.
  const offCanvas = boxes.filter((b) => (b.left > viewport + 8 || b.right > viewport + 24) && b.width >= 80 && b.width <= viewport * 4).slice(0, 10);
  return { sideScroll: sideScroll > 8 ? sideScroll : 0, offCanvas };
}

const MEASURE = `(() => {
  const vw = innerWidth;
  const boxes = [];
  const els = Array.from(document.querySelectorAll("section, div, header, footer, nav, table, img, article, aside"));
  for (const el of els.slice(0, 1500)) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 10) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
    boxes.push({ tag: (el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.className && typeof el.className === "string" ? "." + el.className.split(/\\s+/)[0] : "")).slice(0, 50), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
  }
  return { vw, scrollWidth: document.documentElement.scrollWidth, boxes };
})()`;

async function visualLayoutFindings(ctx: PageContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const data = (await ctx.page.evaluate(MEASURE).catch(() => null)) as { vw: number; scrollWidth: number; boxes: BoxInfo[] } | null;
  if (!data) return out;
  const breaks = layoutBreaks(data.vw, data.scrollWidth, data.boxes);
  if (breaks.sideScroll)
    out.push(
      finding({
        category: "mobile",
        rule: "layout:phone-side-scroll",
        severity: "medium",
        title: `The page scrolls sideways on a phone (${breaks.sideScroll}px too wide)`,
        detail: "At phone width something is wider than the screen, so the whole page scrolls sideways — a real layout break visitors notice. Usually a fixed-width container, a wide table or an oversized image. Use max-width: 100%, let tables scroll inside their own box, and let rows wrap.",
        pageUrl: ctx.url,
        evidence: `viewport ${data.vw}px, content ${data.scrollWidth}px${breaks.offCanvas.length ? `\nwidest off-screen: ${breaks.offCanvas.slice(0, 4).map((b) => `${b.tag} (${b.width}px)`).join(", ")}` : ""}`,
      }),
    );
  else if (breaks.offCanvas.length >= 2)
    out.push(
      finding({
        category: "mobile",
        rule: "layout:off-canvas",
        severity: "low",
        title: `${breaks.offCanvas.length} blocks sit off the side of the phone screen`,
        detail: "Some blocks are positioned past the right edge of a phone screen. If they are not an intentional hidden drawer, part of the content is unreachable. Check absolute positioning and negative margins at small widths.",
        pageUrl: ctx.url,
        evidence: breaks.offCanvas.map((b) => `${b.tag}: left ${b.left}, right ${b.right}`).join("\n"),
      }),
    );
  return out;
}

export const visualLayoutAgent: PageAgent = {
  id: "ui.visual-layout",
  name: "Phone layout breaks",
  description: "A layout-aware check at phone width: catches the page scrolling sideways and content pushed off the screen (real breaks), while ignoring the harmless colour and text shifts a pixel compare would flag.",
  category: "mobile",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "mobile",
  skipErrorPages: true,
  run: visualLayoutFindings,
};
