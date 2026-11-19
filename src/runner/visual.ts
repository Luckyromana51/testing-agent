import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import type { Finding, PageResult, VisualResult } from "../types.js";
import { finding } from "./finding.js";

/**
 * Visual compare: each project keeps an approved picture of every page, for the desktop and the
 * phone view. A new test compares its pictures with them in its own browser (a canvas reads both
 * JPEGs), so no image library or outside service is needed.
 *
 * The first test of a page has nothing to compare with: its pictures become the approved ones.
 */

/** A pixel counts as changed when its colours differ by more than this (JPEG noise stays under it). */
const PIXEL_THRESHOLD = 64;
/** Less than this share of changed pixels is noise (a blinking cursor, a clock). */
export const CHANGE_THRESHOLD = 0.005;

export type View = "desktop" | "phone";

export function baselineKey(url: string, view: View): string {
  const u = new URL(url);
  u.hash = "";
  return createHash("sha1").update(`${u.origin}${u.pathname}${u.search}|${view}`).digest("hex").slice(0, 20);
}

interface BaselineIndex {
  [key: string]: { url: string; view: View; approvedAt: string; runId?: string };
}

async function readIndex(dir: string): Promise<BaselineIndex> {
  try {
    return JSON.parse(await readFile(path.join(dir, "index.json"), "utf8")) as BaselineIndex;
  } catch {
    return {};
  }
}

async function writeIndex(dir: string, index: BaselineIndex): Promise<void> {
  await writeFile(path.join(dir, "index.json"), JSON.stringify(index, null, 1));
}

/** Makes a run's picture of a page the approved one. */
export async function approve(baselineDir: string, artifactsDir: string, shot: string, url: string, view: View, runId?: string): Promise<void> {
  await mkdir(baselineDir, { recursive: true });
  const key = baselineKey(url, view);
  await copyFile(path.join(artifactsDir, path.basename(shot)), path.join(baselineDir, `${key}.jpg`));
  const index = await readIndex(baselineDir);
  index[key] = { url, view, approvedAt: new Date().toISOString(), runId };
  await writeIndex(baselineDir, index);
}

/** Runs in the browser: compares two pictures and draws the new one faded with the changes in red. */
const DIFF_JS = `async function (args) {
  function load(src) {
    return new Promise(function (ok, fail) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = fail; i.src = src; });
  }
  var a = await load(args.old), b = await load(args.now);
  var w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  function pixels(img) {
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, w, h);
  }
  var pa = pixels(a), pb = pixels(b);
  var out = document.createElement("canvas"); out.width = w; out.height = h;
  var ox = out.getContext("2d"); var od = ox.createImageData(w, h);
  var changed = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var i = (y * w + x) * 4;
    var d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
    if (d > args.threshold) {
      changed++;
      od.data[i] = 230; od.data[i + 1] = 30; od.data[i + 2] = 40; od.data[i + 3] = 255;
      if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    } else {
      var g = (pb.data[i] + pb.data[i + 1] + pb.data[i + 2]) / 3;
      var v = 255 - (255 - g) * 0.25;
      od.data[i] = v; od.data[i + 1] = v; od.data[i + 2] = v; od.data[i + 3] = 255;
    }
  }
  ox.putImageData(od, 0, 0);
  return {
    ratio: changed / (w * h),
    sizeChanged: a.width !== b.width || a.height !== b.height,
    box: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    png: out.toDataURL("image/png"),
  };
}`;

interface DiffAnswer {
  ratio: number;
  sizeChanged: boolean;
  box: { x: number; y: number; w: number; h: number } | null;
  png: string;
}

const dataUrl = async (file: string) => `data:image/jpeg;base64,${(await readFile(file)).toString("base64")}`;

/**
 * Compares every tested page's pictures with the approved ones and adds a finding for each page
 * that looks different. Sets `visual` on each page result.
 */
export async function compareVisuals(
  context: BrowserContext,
  pages: PageResult[],
  artifactsDir: string,
  baselineDir: string,
  log: (m: string) => void = () => {},
): Promise<Finding[]> {
  await mkdir(baselineDir, { recursive: true });
  const index = await readIndex(baselineDir);
  const findings: Finding[] = [];
  let fresh = 0;
  let changedPages = 0;
  const page = await context.newPage();
  try {
    for (const [i, p] of pages.entries()) {
      if (p.error || (p.status ?? 0) >= 400) continue;
      for (const view of ["desktop", "phone"] as const) {
        const shot = view === "desktop" ? p.screenshot : p.mobileScreenshot;
        if (!shot) continue;
        const key = baselineKey(p.url, view);
        const base = path.join(baselineDir, `${key}.jpg`);
        const now = path.join(artifactsDir, shot);
        let result: VisualResult;
        let old: string;
        try {
          old = await dataUrl(base);
        } catch {
          // Nothing approved yet: this picture becomes the approved one.
          await copyFile(now, base);
          index[key] = { url: p.url, view, approvedAt: new Date().toISOString() };
          fresh++;
          p.visual = { ...p.visual, [view]: { status: "new" } };
          continue;
        }
        const baseCopy = shot.replace(/\.jpg$/, "-base.jpg");
        await writeFile(path.join(artifactsDir, baseCopy), Buffer.from(old.split(",")[1], "base64"));
        const answer = (await page.evaluate(`(${DIFF_JS})(${JSON.stringify({ old, now: await dataUrl(now), threshold: PIXEL_THRESHOLD })})`)) as DiffAnswer;
        const changed = answer.sizeChanged || answer.ratio >= CHANGE_THRESHOLD;
        result = {
          status: changed ? "changed" : "same",
          changed: Math.round(answer.ratio * 10000) / 100,
          baseline: baseCopy,
          approvedAt: index[key]?.approvedAt,
          ...(answer.box ? { box: answer.box } : {}),
        };
        if (changed) {
          const diff = shot.replace(/\.jpg$/, "-diff.png");
          await writeFile(path.join(artifactsDir, diff), Buffer.from(answer.png.split(",")[1], "base64"));
          result.diff = diff;
          changedPages++;
          const pct = result.changed!;
          findings.push(
            finding({
              category: "functional",
              rule: "visual:changed",
              severity: pct >= 20 ? "high" : pct >= 3 ? "medium" : "low",
              title: `The page looks different from its approved picture (${view === "desktop" ? "desktop" : "phone"})`,
              detail: `${pct}% of the ${view === "desktop" ? "desktop" : "phone"} picture changed since it was approved${result.approvedAt ? ` on ${result.approvedAt.slice(0, 10)}` : ""}. Open the page in the report to see the old picture, the new one and the changes in red. If the change is wanted, press Approve so it becomes the new picture.`,
              pageUrl: p.url,
              evidence: `page ${i + 1}, ${view}`,
              agent: "visual",
            }),
          );
        }
        p.visual = { ...p.visual, [view]: result };
      }
    }
  } finally {
    await page.close().catch(() => {});
    await writeIndex(baselineDir, index);
  }
  if (fresh) log(`Visual compare: saved ${fresh} new approved picture${fresh === 1 ? "" : "s"}`);
  log(`Visual compare: ${changedPages ? `${changedPages} picture${changedPages === 1 ? "" : "s"} changed` : "no changes"}`);
  return findings;
}
