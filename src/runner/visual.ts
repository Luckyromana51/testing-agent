import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext } from "playwright";
import type { Box, Finding, PageResult, VisualResult } from "../types.js";
import { finding } from "./finding.js";

/**
 * Visual compare: each project keeps an approved picture of every page, for the desktop and the
 * phone view. A new test compares its pictures with them in its own browser (a canvas reads both
 * JPEGs), so no image library or outside service is needed.
 *
 * The first test of a page has nothing to compare with: its pictures become the approved ones.
 *
 * Each picture is taken twice, a moment apart (see stillPicture): what changes between the two
 * (a slider run by a script, a video, a clock) moves by itself and is left out of the compare, for
 * the approved picture and the new one, so an unchanged page always compares the same.
 */

/**
 * Pictures approved before this version were taken after the agents had pressed keys and opened
 * menus, so they differ from run to run. They are replaced once, without a finding.
 */
export const PICTURE_VERSION = 2;

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
  [key: string]: { url: string; view: View; approvedAt: string; runId?: string; v?: number; moving?: Box[] };
}

const second = (file: string) => file.replace(/\.jpg$/, "-b.jpg");

async function copyPair(from: string, to: string): Promise<void> {
  await copyFile(from, to);
  // The second picture shows what moves by itself; an older run may not have one.
  await copyFile(second(from), second(to)).catch(() => rm(second(to), { force: true }));
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
export async function approve(
  baselineDir: string,
  artifactsDir: string,
  shot: string,
  url: string,
  view: View,
  runId?: string,
  moving?: Box[],
): Promise<void> {
  await mkdir(baselineDir, { recursive: true });
  const key = baselineKey(url, view);
  await copyPair(path.join(artifactsDir, path.basename(shot)), path.join(baselineDir, `${key}.jpg`));
  const index = await readIndex(baselineDir);
  index[key] = { url, view, approvedAt: new Date().toISOString(), runId, v: PICTURE_VERSION, ...(moving?.length ? { moving } : {}) };
  await writeIndex(baselineDir, index);
}

/** Runs in the browser: compares two pictures and draws the new one faded with the changes in red. */
const DIFF_JS = `async function (args) {
  function load(src) {
    return new Promise(function (ok, fail) { var i = new Image(); i.onload = function () { ok(i); }; i.onerror = fail; i.src = src; });
  }
  var a = await load(args.old), b = await load(args.now);
  var a2 = args.old2 ? await load(args.old2).catch(function () { return null; }) : null;
  var b2 = args.now2 ? await load(args.now2).catch(function () { return null; }) : null;
  var w = Math.max(a.width, b.width), h = Math.max(a.height, b.height);
  function pixels(img) {
    var c = document.createElement("canvas"); c.width = w; c.height = h;
    var x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0);
    return x.getImageData(0, 0, w, h);
  }
  var pa = pixels(a), pb = pixels(b);
  var pa2 = a2 ? pixels(a2) : null, pb2 = b2 ? pixels(b2) : null;
  function diff(p, q, i) { return Math.abs(p.data[i] - q.data[i]) + Math.abs(p.data[i + 1] - q.data[i + 1]) + Math.abs(p.data[i + 2] - q.data[i + 2]); }
  // Parts that moved between the two pictures of one run move by themselves: mark them, a little
  // wider, so they are left out.
  var moving = new Uint8Array(w * h), moved = 0;
  (args.boxes || []).forEach(function (b) {
    for (var by = Math.max(0, b.y - 4); by < Math.min(h, b.y + b.h + 4); by++) for (var bx = Math.max(0, b.x - 4); bx < Math.min(w, b.x + b.w + 4); bx++) {
      if (!moving[by * w + bx]) { moving[by * w + bx] = 1; moved++; }
    }
  });
  if (pa2 || pb2) {
    for (var y0 = 0; y0 < h; y0++) for (var x0 = 0; x0 < w; x0++) {
      var j = (y0 * w + x0) * 4;
      if ((pa2 && diff(pa, pa2, j) > args.threshold) || (pb2 && diff(pb, pb2, j) > args.threshold)) {
        for (var dy = -6; dy <= 6; dy++) for (var dx = -6; dx <= 6; dx++) {
          var yy = y0 + dy, xx = x0 + dx;
          if (yy >= 0 && yy < h && xx >= 0 && xx < w && !moving[yy * w + xx]) { moving[yy * w + xx] = 1; moved++; }
        }
      }
    }
  }
  var out = document.createElement("canvas"); out.width = w; out.height = h;
  var ox = out.getContext("2d"); var od = ox.createImageData(w, h);
  var changed = 0, minX = w, minY = h, maxX = -1, maxY = -1;
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var i = (y * w + x) * 4;
    var d = moving[y * w + x] ? 0 : diff(pa, pb, i);
    if (moving[y * w + x]) {
      od.data[i] = 120; od.data[i + 1] = 150; od.data[i + 2] = 230; od.data[i + 3] = 255;
    } else if (d > args.threshold) {
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
    ratio: changed / Math.max(1, w * h - moved),
    moving: moved / (w * h),
    sizeChanged: a.width !== b.width || a.height !== b.height,
    box: maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    png: out.toDataURL("image/png"),
  };
}`;

interface DiffAnswer {
  ratio: number;
  moving: number;
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
        let old: string | undefined;
        try {
          // A picture approved by a person stays; one saved on its own by an older version is replaced.
          if ((index[key]?.v ?? 0) >= PICTURE_VERSION || index[key]?.runId) old = await dataUrl(base);
        } catch {
          old = undefined;
        }
        if (!old) {
          // Nothing approved yet: this picture becomes the approved one.
          await copyPair(now, base);
          index[key] = { url: p.url, view, approvedAt: new Date().toISOString(), v: PICTURE_VERSION, ...(p.moving?.[view]?.length ? { moving: p.moving[view] } : {}) };
          fresh++;
          p.visual = { ...p.visual, [view]: { status: "new" } };
          continue;
        }
        const baseCopy = shot.replace(/\.jpg$/, "-base.jpg");
        await writeFile(path.join(artifactsDir, baseCopy), Buffer.from(old.split(",")[1], "base64"));
        const maybe = (file: string) => dataUrl(file).catch(() => undefined);
        const boxes = [...(index[key]?.moving ?? []), ...(p.moving?.[view] ?? [])];
        const args = { old, now: await dataUrl(now), old2: await maybe(second(base)), now2: await maybe(second(now)), boxes, threshold: PIXEL_THRESHOLD };
        const answer = (await page.evaluate(`(${DIFF_JS})(${JSON.stringify(args)})`)) as DiffAnswer;
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
              detail: `${pct}% of the ${view === "desktop" ? "desktop" : "phone"} picture changed since it was approved${result.approvedAt ? ` on ${result.approvedAt.slice(0, 10)}` : ""}.${answer.moving >= 0.01 ? ` Parts that move by themselves (sliders, videos), shown in blue, were left out.` : ""} Open the page in the report to see the old picture, the new one and the changes in red. If the change is wanted, press Approve so it becomes the new picture.`,
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
