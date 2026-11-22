import { finding } from "../../runner/finding.js";
import { PUBLIC_WEB_PRODUCTS, WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, PageContext } from "../types.js";

/**
 * Wave 3 (2026 gap report, P3) web agents, all in-house and read-only:
 *  - perf.carbon: grams of CO2 per page view, from the page weight (CO2.js / SWD model).
 *  - seo.image-video: image/video structured data and Discover-ready images.
 *  - a11y.media: captions on video, transcripts for audio.
 *  - a11y.engine2: a second rule set that catches issues axe can miss.
 *  - sec.hipaa: patient/health data leaking into URLs and to third-party trackers.
 */

// ---------------------------------------------------------------------------
// Carbon / sustainability
// ---------------------------------------------------------------------------

/** Sustainable Web Design model: grams of CO2 for a transfer of `bytes`. Pure, for tests. */
export function co2Grams(bytes: number): number {
  const kwhPerGb = 0.81; // SWD v3 operational+embodied, blended
  const gramsPerKwh = 442; // global grid average g CO2/kWh
  const gb = bytes / 1_000_000_000;
  return gb * kwhPerGb * gramsPerKwh;
}

/** Whether a page's weight is heavy enough to flag. Pure, for tests. */
export function carbonProblem(bytes: number): { heavy: boolean; grams: number } {
  const grams = co2Grams(bytes);
  // A median page is ~1g; only flag clearly heavy pages (~>5.5MB) to avoid noise.
  return { heavy: grams > 2.0, grams };
}

export const carbonAgent: PageAgent = {
  id: "perf.carbon",
  name: "Carbon / sustainability",
  description: "Estimates the CO2 produced per page view from the page's total download weight (the Sustainable Web Design model, as CO2.js uses). Flags heavy pages. Useful for EU clients and ESG reports.",
  category: "performance",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  run(ctx: PageContext): Finding[] {
    const bytes = ctx.signals.responses.reduce((n, r) => n + (r.bytes || 0), 0);
    if (!bytes) return [];
    const { heavy, grams } = carbonProblem(bytes);
    if (!heavy) return [];
    return [
      finding({
        category: "performance",
        rule: "carbon:heavy-page",
        severity: "low",
        title: `This page emits about ${grams.toFixed(2)}g CO2 per view`,
        detail: `The page downloads about ${(bytes / 1_000_000).toFixed(1)}MB, roughly ${grams.toFixed(2)}g CO2 per visit (Sustainable Web Design model). Lighter pages are cheaper, faster and greener: compress and lazy-load images, serve modern formats (AVIF/WebP), remove unused JavaScript, and cache at a CDN.`,
        pageUrl: ctx.url,
        evidence: `Transfer weight: ${(bytes / 1_000_000).toFixed(2)}MB`,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------
// Image / video / news SEO
// ---------------------------------------------------------------------------

export interface MediaSeoFacts {
  hasVideo: boolean;
  hasVideoSchema: boolean;
  ogImage: string | null;
  ogImageWide: boolean;
  imagesNoDimensions: number;
}

/** Judges image/video/Discover SEO. Pure, for tests. */
export function imageVideoSeoProblems(f: MediaSeoFacts): { rule: string; severity: "low" | "info" | "medium"; title: string; detail: string }[] {
  const out: { rule: string; severity: "low" | "info" | "medium"; title: string; detail: string }[] = [];
  if (f.hasVideo && !f.hasVideoSchema) out.push({ rule: "videoseo:no-schema", severity: "low", title: "Video has no VideoObject structured data", detail: "The page has a video but no VideoObject JSON-LD (name, description, thumbnailUrl, uploadDate). Add it so the video can appear in Google video results." });
  if (!f.ogImage) out.push({ rule: "news:no-og-image", severity: "low", title: "No social/Discover image (og:image)", detail: "Add an og:image at least 1200px wide so the page looks right when shared and can appear in Google Discover." });
  else if (!f.ogImageWide) out.push({ rule: "news:small-og-image", severity: "info", title: "Social image may be too small for Discover", detail: "Google Discover favours large images (1200px+ wide, and allowed via max-image-preview:large). Use a bigger og:image." });
  if (f.imagesNoDimensions > 3) out.push({ rule: "imgseo:no-dimensions", severity: "info", title: `${f.imagesNoDimensions} images have no width/height`, detail: "Images without width/height cause layout shift and are weaker for image SEO. Set explicit dimensions and descriptive file names/alt text." });
  return out;
}

export const imageVideoSeoAgent: PageAgent = {
  id: "seo.image-video",
  name: "Image, video & Discover SEO",
  description: "Checks images and video for search: VideoObject structured data, a large social image for Google Discover, and images with explicit dimensions. For media and news clients.",
  category: "seo",
  engine: "web",
  products: PUBLIC_WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  async run(ctx: PageContext): Promise<Finding[]> {
    const facts = await ctx.page
      .evaluate((): MediaSeoFacts => {
        const hasVideo = document.querySelector("video, iframe[src*='youtube'], iframe[src*='vimeo']") !== null;
        let hasVideoSchema = false;
        for (const s of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
          if (/"@type"\s*:\s*"?VideoObject/.test(s.textContent ?? "")) hasVideoSchema = true;
        }
        const og = document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null;
        const ogImage = og?.content ?? null;
        const w = document.querySelector('meta[property="og:image:width"]') as HTMLMetaElement | null;
        // Only judge width when it is declared; an undeclared width is unknown, not "too small".
        const ogImageWide = w ? Number(w.content) >= 1200 : true;
        let imagesNoDimensions = 0;
        for (const img of Array.from(document.querySelectorAll("img"))) {
          if (!img.getAttribute("width") && !img.getAttribute("height") && !(img as HTMLImageElement).style.width) imagesNoDimensions++;
        }
        return { hasVideo, hasVideoSchema, ogImage, ogImageWide, imagesNoDimensions };
      })
      .catch(() => null);
    if (!facts) return [];
    return imageVideoSeoProblems(facts).map((p) => finding({ category: "seo", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: ctx.url }));
  },
};

// ---------------------------------------------------------------------------
// Media accessibility (captions / transcripts)
// ---------------------------------------------------------------------------

export const mediaA11yAgent: PageAgent = {
  id: "a11y.media",
  name: "Video & audio accessibility",
  description: "Checks that videos have caption/subtitle tracks and audio has a transcript nearby, so deaf and hard-of-hearing users can follow. For media and e-learning clients.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  async run(ctx: PageContext): Promise<Finding[]> {
    const facts = await ctx.page
      .evaluate(() => {
        const videos = Array.from(document.querySelectorAll("video"));
        const videosNoCaptions = videos.filter((v) => !v.querySelector('track[kind="captions"],track[kind="subtitles"]')).length;
        const audios = Array.from(document.querySelectorAll("audio"));
        const bodyText = (document.body.textContent ?? "").toLowerCase();
        const transcriptNearby = /transcript/.test(bodyText);
        return { videos: videos.length, videosNoCaptions, audios: audios.length, transcriptNearby };
      })
      .catch(() => null);
    if (!facts) return [];
    const out: Finding[] = [];
    if (facts.videosNoCaptions > 0)
      out.push(finding({ category: "accessibility", rule: "mediaa11y:no-captions", severity: "medium", title: `${facts.videosNoCaptions} video(s) without captions`, detail: "A <video> has no <track kind=\"captions\"> (or subtitles). WCAG 1.2.2 requires captions for recorded video. Add a caption track (you can generate a first draft with Whisper and correct it).", pageUrl: ctx.url }));
    if (facts.audios > 0 && !facts.transcriptNearby)
      out.push(finding({ category: "accessibility", rule: "mediaa11y:no-transcript", severity: "medium", title: "Audio with no transcript", detail: "The page plays audio but has no visible transcript. WCAG 1.2.1 requires a text alternative for audio-only content. Publish a transcript next to the player.", pageUrl: ctx.url }));
    return out;
  },
};

// ---------------------------------------------------------------------------
// Second accessibility engine (catches what axe can miss)
// ---------------------------------------------------------------------------

export interface ExtraA11yFacts {
  positiveTabindex: number;
  duplicateIds: number;
  marquee: number;
  tinyFont: number;
  justified: number;
}

/** Extra accessibility rules (a second lens beside axe). Pure, for tests. */
export function extraA11y(f: ExtraA11yFacts): { rule: string; severity: "low" | "info"; title: string; detail: string }[] {
  const out: { rule: string; severity: "low" | "info"; title: string; detail: string }[] = [];
  if (f.positiveTabindex > 0) out.push({ rule: "a11y2:positive-tabindex", severity: "low", title: `${f.positiveTabindex} element(s) use a positive tabindex`, detail: "A positive tabindex forces an unnatural tab order that confuses keyboard and screen-reader users. Use tabindex=\"0\" or rely on DOM order." });
  if (f.duplicateIds > 0) out.push({ rule: "a11y2:duplicate-id", severity: "low", title: `${f.duplicateIds} duplicate id(s)`, detail: "Duplicate id attributes break label/aria associations for assistive tech. Make every id unique." });
  if (f.marquee > 0) out.push({ rule: "a11y2:moving-text", severity: "low", title: "Auto-moving text (marquee/blink)", detail: "Moving or blinking text fails WCAG 2.2.2. Remove it or give a pause control." });
  if (f.tinyFont > 0) out.push({ rule: "a11y2:tiny-font", severity: "info", title: `${f.tinyFont} block(s) of very small text (<10px)`, detail: "Text under about 10px is hard to read, especially on mobile. Use at least 12–16px for body text." });
  if (f.justified > 0) out.push({ rule: "a11y2:justified-text", severity: "info", title: "Fully justified text", detail: "Justified text creates uneven 'rivers' of space that hinder dyslexic readers (a WCAG AAA concern). Prefer left-aligned text." });
  return out;
}

export const a11yEngine2Agent: PageAgent = {
  id: "a11y.engine2",
  name: "Second accessibility engine",
  description: "A second set of accessibility rules beside axe (in the spirit of IBM Equal Access): positive tabindex, duplicate ids, auto-moving text, tiny fonts and justified text. Fewer misses from using two engines.",
  category: "accessibility",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  async run(ctx: PageContext): Promise<Finding[]> {
    const facts = await ctx.page
      .evaluate((): ExtraA11yFacts => {
        const positiveTabindex = Array.from(document.querySelectorAll("[tabindex]")).filter((e) => Number(e.getAttribute("tabindex")) > 0).length;
        const ids = Array.from(document.querySelectorAll("[id]")).map((e) => e.id);
        const seen = new Set<string>();
        let duplicateIds = 0;
        for (const id of ids) {
          if (seen.has(id)) duplicateIds++;
          else seen.add(id);
        }
        const marquee = document.querySelectorAll("marquee, blink").length;
        let tinyFont = 0;
        let justified = 0;
        for (const el of Array.from(document.querySelectorAll("p, span, li, div")).slice(0, 2000)) {
          const cs = getComputedStyle(el as Element);
          const size = Number.parseFloat(cs.fontSize);
          if (Number.isFinite(size) && size > 0 && size < 10 && (el.textContent ?? "").trim().length > 10) tinyFont++;
          if (cs.textAlign === "justify" && (el.textContent ?? "").trim().length > 80) justified++;
        }
        return { positiveTabindex, duplicateIds, marquee, tinyFont: Math.min(tinyFont, 99), justified: Math.min(justified, 99) };
      })
      .catch(() => null);
    if (!facts) return [];
    return extraA11y(facts).map((p) => finding({ category: "accessibility", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: ctx.url }));
  },
};

// ---------------------------------------------------------------------------
// HIPAA / health data leakage
// ---------------------------------------------------------------------------

const PHI_PARAM = /\b(ssn|dob|date_?of_?birth|mrn|patient|diagnosis|icd10?|npi|insurance|member_?id|health|prescription|rx)\b/i;

/** Whether a URL carries health/PHI-looking query parameters. Pure, for tests. */
export function phiInUrl(url: string): string[] {
  try {
    const u = new URL(url);
    const hits: string[] = [];
    for (const [k] of u.searchParams) if (PHI_PARAM.test(k)) hits.push(k);
    return hits;
  } catch {
    return [];
  }
}

/** Third-party requests whose QUERY PARAMETERS carry PHI-looking keys. Pure, for tests. */
export function phiToThirdParty(requests: string[], own: string): string[] {
  const out: string[] = [];
  for (const r of requests) {
    try {
      const u = new URL(r);
      if (u.host === own) continue;
      for (const [k] of u.searchParams) {
        if (PHI_PARAM.test(k)) {
          out.push(r);
          break;
        }
      }
    } catch {
      // ignore
    }
  }
  return out;
}

export const hipaaAgent: PageAgent = {
  id: "sec.hipaa",
  name: "HIPAA / health data leakage",
  description: "For health clients, flags patient/health data (PHI) sitting in page URLs and, worse, being sent to third-party analytics and ad trackers. Off by default — turn it on for health/healthcare projects.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  skipErrorPages: true,
  defaultOff: true,
  run(ctx: PageContext): Finding[] {
    const out: Finding[] = [];
    const own = (() => {
      try {
        return new URL(ctx.url).host;
      } catch {
        return "";
      }
    })();
    const inPage = phiInUrl(ctx.url);
    if (inPage.length)
      out.push(finding({ category: "security", rule: "hipaa:phi-in-url", severity: "high", title: `Possible health data in the page URL: ${inPage.join(", ")}`, detail: "Patient/health identifiers in the URL end up in server logs, browser history, the Referer header sent to third parties, and analytics. For HIPAA, keep PHI out of URLs — use POST bodies or opaque ids.", pageUrl: ctx.url, evidence: ctx.url }));
    // Match query-PARAMETER keys only (not the whole path), so an asset like /healthcare-widget.js is not flagged.
    const thirdPartyPhi = phiToThirdParty(ctx.signals.requests, own);
    if (thirdPartyPhi.length)
      out.push(finding({ category: "security", rule: "hipaa:phi-to-tracker", severity: "high", title: "Possible health data sent to a third-party tracker", detail: "A request to a third-party host carried a health/PHI-looking query parameter. Sending PHI to analytics/ad trackers (Meta Pixel, Google Analytics) without a BAA is a HIPAA violation and has drawn large fines. Confirm the parameter, then remove PHI from tracker calls or stop loading the tracker on health pages.", pageUrl: ctx.url, evidence: thirdPartyPhi.slice(0, 3).join("\n") }));
    return out;
  },
};
