import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import type { Severity } from "../types.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Wave 3 (2026 gap report, P3) web checks, all in-house and read-only:
 *  - print-layout: do invoices/tickets print correctly (print-to-PDF + overflow check).
 *  - webrtc: video/streaming start time, stalls and WebRTC call stats.
 *  - page-watch: a fingerprint of the terms/privacy pages, to spot later changes.
 */

const SAMPLE = 6;

// ---------------------------------------------------------------------------
// Print / PDF export layout
// ---------------------------------------------------------------------------

export interface PrintMetrics {
  hasPrintCss: boolean;
  printWidthPx: number;
  contentWidthPx: number;
  pageCount: number;
}

/** Judges print layout from measured metrics. Pure, for tests. */
export function printProblems(m: PrintMetrics): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  // A4 printable width is about 794px at 96dpi; allow a small tolerance.
  if (m.contentWidthPx > m.printWidthPx * 1.02)
    out.push({ rule: "print:overflow", severity: "medium", title: "Content is wider than the printed page", detail: `The page content is about ${Math.round(m.contentWidthPx)}px wide but the printable area is about ${Math.round(m.printWidthPx)}px, so the right edge is cut off on paper and in PDF export. Add a print stylesheet that sets a fluid width and avoids fixed pixel widths.` });
  if (!m.hasPrintCss)
    out.push({ rule: "print:no-print-css", severity: "low", title: "No print stylesheet", detail: "The page has no @media print rules, so it prints exactly as it looks on screen (navigation, sidebars, dark backgrounds wasting ink). Add a print stylesheet that hides chrome and lays out the document for paper." });
  return out;
}

export const printLayoutTool: Tool = {
  id: "print-layout",
  name: "Print & PDF export layout",
  maker: "GLV Infotech (built in)",
  description:
    "Prints the page to PDF the way a browser does (Ctrl+P / Save as PDF) and checks it comes out right: content not cut off at the page edge, and a print stylesheet present so invoices and tickets print cleanly.",
  checks: ["Content fits the printable page width (not cut off)", "A print stylesheet (@media print) exists", "Saves the printed PDF as evidence"],
  products: ["website", "ecommerce", "webapp", "saas", "crm"],
  category: "functional",
  safety: "safe",
  takes: "1 to 2 minutes",
  licence: "GLV's own",
  homepage: "https://playwright.dev/docs/api/class-page#page-pdf",
  signedIn: "uses-login",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const urls = [ctx.startUrl, ...ctx.urls.filter((u) => u !== ctx.startUrl)].slice(0, SAMPLE);
    const findings: ToolFinding[] = [];
    const checked: string[] = [];
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext(ctx.cookie ? { extraHTTPHeaders: { cookie: ctx.cookie } } : {});
      for (const url of urls) {
        if (ctx.signal.aborted) break;
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 });
          await page.emulateMedia({ media: "print" });
          const m = await page.evaluate(() => {
            const hasPrintCss = Array.from(document.styleSheets).some((s) => {
              try {
                return Array.from(s.cssRules ?? []).some((r) => r.cssText.includes("@media print") || (r as CSSMediaRule).media?.mediaText?.includes("print"));
              } catch {
                return false;
              }
            });
            return { hasPrintCss, contentWidthPx: document.documentElement.scrollWidth };
          });
          const pdf = await page.pdf({ format: "A4", printBackground: true }).catch(() => null);
          const metrics: PrintMetrics = { hasPrintCss: m.hasPrintCss, printWidthPx: 794, contentWidthPx: m.contentWidthPx, pageCount: 1 };
          if (pdf && url === ctx.startUrl) await writeFile(path.join(ctx.outDir, "tool-print.pdf"), pdf);
          for (const p of printProblems(metrics)) if (!findings.some((f) => f.rule === p.rule)) findings.push({ category: "functional", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, key: p.rule });
          checked.push(url);
        } catch (e) {
          ctx.log(`print-layout: ${url} — ${(e as Error).message}`);
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return { findings, summary: [`Checked print layout on ${checked.length} page(s)`], tested: `${checked.length} pages`, checked, reports: [{ file: "tool-print.pdf", label: "Printed PDF of the start page" }] };
  },
};

// ---------------------------------------------------------------------------
// Video / streaming / WebRTC quality
// ---------------------------------------------------------------------------

export interface MediaStat {
  startMs: number | null;
  stalls: number;
  webrtc: boolean;
  errors: number;
}

/** Judges media quality from measured stats. Pure, for tests. */
export function webrtcProblems(s: MediaStat): { rule: string; severity: Severity; title: string; detail: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string }[] = [];
  if (s.startMs !== null && s.startMs > 4000) out.push({ rule: "webrtc:slow-start", severity: "medium", title: "Video is slow to start playing", detail: `The video took about ${Math.round(s.startMs)}ms to start. Aim under 2 seconds: use adaptive bitrate (HLS/DASH), a lower starting quality, a poster image and a CDN near your viewers.` });
  if (s.stalls > 0) out.push({ rule: "webrtc:stalls", severity: "medium", title: "Video buffered during playback", detail: `Playback stalled ${s.stalls} time(s). Use adaptive streaming so quality drops instead of buffering, and serve segments from a CDN.` });
  if (s.errors > 0) out.push({ rule: "webrtc:media-error", severity: "high", title: "Media element reported an error", detail: "The audio/video element fired an error. Check the source URL, codecs and CORS headers." });
  return out;
}

export const webrtcTool: Tool = {
  id: "webrtc",
  name: "Video, streaming & WebRTC quality",
  maker: "GLV Infotech (built in)",
  description:
    "Plays the page's audio/video in a real browser and measures start time and buffering stalls, and detects WebRTC (live call) usage. For telehealth, e-learning and media sites where playback quality is the product.",
  checks: ["Time until video starts playing", "Buffering stalls during playback", "Media errors (bad source, codec, CORS)", "WebRTC peer connections detected"],
  products: ["website", "webapp", "saas"],
  category: "performance",
  safety: "safe",
  takes: "1 to 3 minutes",
  licence: "GLV's own",
  homepage: "https://developer.mozilla.org/docs/Web/API/HTMLMediaElement",
  signedIn: "uses-login",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const urls = [ctx.startUrl, ...ctx.urls.filter((u) => u !== ctx.startUrl)].slice(0, SAMPLE);
    const findings: ToolFinding[] = [];
    const checked: string[] = [];
    let mediaPages = 0;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext(ctx.cookie ? { extraHTTPHeaders: { cookie: ctx.cookie } } : {});
      for (const url of urls) {
        if (ctx.signal.aborted) break;
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
          const stat = await page.evaluate(async (): Promise<MediaStat> => {
            const webrtc = typeof (window as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection !== "undefined" && /RTCPeerConnection|getUserMedia|new\s+RTCPeerConnection/.test(document.documentElement.innerHTML);
            const media = Array.from(document.querySelectorAll("video,audio")) as HTMLMediaElement[];
            if (!media.length) return { startMs: null, stalls: 0, webrtc, errors: 0 };
            const el = media[0];
            let stalls = 0;
            let errors = 0;
            el.addEventListener("waiting", () => stalls++);
            el.addEventListener("error", () => errors++);
            const t0 = performance.now();
            try {
              el.muted = true;
              await el.play().catch(() => {});
            } catch {
              /* autoplay blocked */
            }
            const startMs = await new Promise<number | null>((resolve) => {
              if (el.readyState >= 3) return resolve(performance.now() - t0);
              const done = () => resolve(performance.now() - t0);
              el.addEventListener("playing", done, { once: true });
              setTimeout(() => resolve(null), 8000);
            });
            await new Promise((r) => setTimeout(r, 2500));
            return { startMs, stalls, webrtc, errors };
          });
          if (stat.startMs !== null || stat.webrtc) {
            mediaPages++;
            for (const p of webrtcProblems(stat)) findings.push({ category: "performance", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: url, key: `${p.rule}:${url}` });
          }
          checked.push(url);
        } catch (e) {
          ctx.log(`webrtc: ${url} — ${(e as Error).message}`);
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
    return { findings, summary: [mediaPages ? `${mediaPages} page(s) with media, ${findings.length} issue(s)` : "No audio/video found on sampled pages"], tested: `${checked.length} pages`, checked };
  },
};

// ---------------------------------------------------------------------------
// Terms / privacy page change watch
// ---------------------------------------------------------------------------

/** Finds likely legal pages among crawled URLs. Pure, for tests. */
export function legalPages(urls: string[]): string[] {
  const rx = /\b(terms|tos|conditions|privacy|policy|policies|legal|refund|cancellation|disclaimer|cookie|gdpr|dpdp)\b/i;
  return Array.from(new Set(urls.filter((u) => rx.test(u))));
}

/** A stable fingerprint of a page's visible text. Pure, for tests. */
export function pageFingerprint(text: string): { hash: string; words: number } {
  const clean = text
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { hash: createHash("sha256").update(clean).digest("hex").slice(0, 16), words: clean.split(" ").filter(Boolean).length };
}

export const pageWatchTool: Tool = {
  id: "page-watch",
  name: "Terms & privacy change watch",
  maker: "GLV Infotech (built in)",
  description:
    "Finds the site's terms, privacy, refund and cookie pages and records a fingerprint (a hash of the text and the Last-Modified date). On the next run it flags any page whose legal text has changed, for your audit trail.",
  checks: ["Locates terms/privacy/refund/cookie pages", "Records a content hash and Last-Modified date per page", "Flags legal pages that changed since the last run (saved baseline)"],
  products: ["website", "ecommerce", "webapp", "saas", "crm"],
  category: "functional",
  safety: "safe",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "public",
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const pages = legalPages([ctx.startUrl, ...ctx.urls]);
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      for (const url of pages.slice(0, 12)) {
        if (ctx.signal.aborted) break;
        try {
          const res = await context.request.get(url, { timeout: 20_000 });
          const body = await res.text();
          const fp = pageFingerprint(body);
          rows.push([url, fp.hash, String(fp.words), res.headers()["last-modified"] ?? "—"]);
        } catch (e) {
          ctx.log(`page-watch: ${url} — ${(e as Error).message}`);
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
    if (!pages.length)
      findings.push({ category: "functional", rule: "watch:no-legal-pages", severity: "info", title: "No terms or privacy page found", detail: "The crawl found no terms, privacy, refund or cookie page. Most stores and SaaS products need published terms and a privacy policy (DPDP/GDPR). Add them and link them in the footer.", pageUrl: ctx.startUrl, key: "watch:no-legal-pages" });
    await writeFile(path.join(ctx.outDir, "tool-legal-fingerprints.csv"), ["url,hash,words,last_modified", ...rows.map((r) => r.join(","))].join("\n"));
    return {
      findings,
      summary: [`${pages.length} legal page(s) fingerprinted`],
      tested: `${pages.length} pages`,
      reports: [{ file: "tool-legal-fingerprints.csv", label: "Legal-page fingerprints (compare next run)" }],
      table: pages.length ? { title: "Legal pages", columns: ["URL", "Hash", "Words", "Last-Modified"], rows } : undefined,
    };
  },
};
