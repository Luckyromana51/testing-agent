import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";
import { getText } from "./geo.js";

/**
 * Photos that still carry where they were taken: a JPEG's EXIF GPS position (from a phone camera)
 * shows a home, office or warehouse to anyone who downloads it. Also the camera owner's name and
 * serial where present. The site's own photos only, like a visitor.
 */

export interface ExifFacts {
  gps?: { lat: number; lon: number };
  /** Camera owner, artist or serial fields, when present. */
  people: string[];
  device?: string;
}

/** Reads the EXIF block of a JPEG (GPS position, device, owner fields). Pure, for tests. */
export function readExif(buf: Buffer): ExifFacts | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 4 < buf.length) {
    if (buf[off] !== 0xff) return null;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if (marker === 0xe1 && buf.toString("latin1", off + 4, off + 10) === "Exif\0\0") return readTiff(buf.subarray(off + 10, off + 2 + len));
    if (marker === 0xda) return null;
    off += 2 + len;
  }
  return null;
}

function readTiff(t: Buffer): ExifFacts {
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  const facts: ExifFacts = { people: [] };
  const entries = (ifd: number) => {
    const out: { tag: number; type: number; count: number; at: number }[] = [];
    if (ifd + 2 > t.length) return out;
    const n = u16(ifd);
    for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= t.length; i++) {
      const e = ifd + 2 + i * 12;
      out.push({ tag: u16(e), type: u16(e + 2), count: u32(e + 4), at: e + 8 });
    }
    return out;
  };
  const ascii = (e: { count: number; at: number }) => {
    const start = e.count > 4 ? u32(e.at) : e.at;
    return t.toString("latin1", start, Math.min(t.length, start + e.count)).replace(/\0+$/, "").trim();
  };
  const rational3 = (e: { at: number }) => {
    const o = u32(e.at);
    if (o + 24 > t.length) return NaN;
    const r = (k: number) => u32(o + k * 8) / (u32(o + k * 8 + 4) || 1);
    return r(0) + r(1) / 60 + r(2) / 3600;
  };
  try {
    const ifd0 = entries(u32(4));
    let gpsAt = 0;
    for (const e of ifd0) {
      if (e.tag === 0x8825) gpsAt = u32(e.at);
      if (e.tag === 0x013b || e.tag === 0x8298) {
        const v = ascii(e);
        if (v) facts.people.push(v);
      }
      if (e.tag === 0x0110) facts.device = ascii(e) || undefined;
    }
    if (gpsAt) {
      const g = entries(gpsAt);
      const ref = (tag: number) => {
        const e = g.find((x) => x.tag === tag);
        return e ? t.toString("latin1", e.at, e.at + 1) : "";
      };
      const lat = g.find((x) => x.tag === 2);
      const lon = g.find((x) => x.tag === 4);
      if (lat && lon) {
        const la = rational3(lat) * (ref(1) === "S" ? -1 : 1);
        const lo = rational3(lon) * (ref(3) === "W" ? -1 : 1);
        if (Number.isFinite(la) && Number.isFinite(lo) && (la !== 0 || lo !== 0)) facts.gps = { lat: Math.round(la * 1e5) / 1e5, lon: Math.round(lo * 1e5) / 1e5 };
      }
    }
  } catch {
    // a broken EXIF block: what was read so far stands
  }
  return facts;
}

async function exifFindings({ browser, origin, pages, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const images = new Map<string, string>();
  for (const p of pages.filter((x) => (x.status ?? 0) < 400).slice(0, 12)) {
    const got = await getText(browser.request, p.url, {}, 1_500_000);
    if (!got) continue;
    for (const m of got.text.matchAll(/<(?:img|source)[^>]+(?:src|srcset|data-src)=["']([^"' ]+\.jpe?g)(?:[?"' ])/gi)) {
      try {
        const u = new URL(m[1], p.url);
        if (u.origin === origin && !images.has(u.href)) images.set(u.href, p.url);
      } catch {
        // not an address
      }
    }
    if (images.size >= 40) break;
  }
  let read = 0;
  for (const [img, page] of [...images].slice(0, 40)) {
    try {
      const res = await browser.request.get(img, { timeout: 15_000, headers: { range: "bytes=0-131071" } });
      const buf = Buffer.from(await res.body());
      read++;
      const ex = readExif(buf);
      if (ex?.gps)
        out.push(finding({ category: "security", rule: "privacy:photo-location", severity: "medium", title: "A photo on the site shows where it was taken", detail: `The photo still has its GPS position (${ex.gps.lat}, ${ex.gps.lon}) from the phone that took it, which can show a home, office or warehouse address. Remove EXIF data when photos are uploaded (WordPress: a plugin like "EXIF Remover", or strip it in the upload code), and re-export these photos without location.`, pageUrl: page, evidence: `${img}\nGPS ${ex.gps.lat}, ${ex.gps.lon}${ex.device ? `\nCamera: ${ex.device}` : ""}`, agent: "privacy.photo-exif" }));
      else if (ex?.people.length)
        out.push(finding({ category: "security", rule: "privacy:photo-owner", severity: "low", title: "A photo on the site names the camera's owner", detail: "The photo's EXIF data has an owner, artist or copyright name. Strip EXIF on upload unless the name is meant to be public.", pageUrl: page, evidence: `${img}\n${ex.people.join(", ")}`, agent: "privacy.photo-exif" }));
    } catch {
      // the image could not be read
    }
  }
  if (read) log(`Photo EXIF: read ${read} photos`);
  return out;
}

export const exifAgent: SiteAgent = {
  id: "privacy.photo-exif",
  name: "Photo location (EXIF)",
  description: "Reads the site's own JPEG photos for a GPS position or owner name left in by the camera or phone.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: exifFindings,
};
