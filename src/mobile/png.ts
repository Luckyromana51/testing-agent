/*
 * Reads (and writes) the PNG screenshots Appium sends, so the explorer can measure text contrast
 * on the real pixels. 8-bit RGB, RGBA, grey and palette images without interlacing: what phones and
 * simulators produce.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface Image {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  data: Buffer;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf: Buffer): Image {
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error("Not a PNG picture.");
  let p = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let color = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const idat: Buffer[] = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      color = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") alpha = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error("Only 8-bit, non-interlaced PNG pictures are read.");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color as 0 | 2 | 3 | 4 | 6];
  if (!channels) throw new Error("Unknown PNG colour type.");
  if (width * height > 40_000_000) throw new Error("The picture is too big.");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (color === 2 || color === 6) {
        out[o] = line[s];
        out[o + 1] = line[s + 1];
        out[o + 2] = line[s + 2];
        out[o + 3] = color === 6 ? line[s + 3] : 255;
      } else if (color === 0 || color === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[s];
        out[o + 3] = color === 4 ? line[s + 1] : 255;
      } else {
        const idx = line[s];
        out[o] = palette?.[idx * 3] ?? 0;
        out[o + 1] = palette?.[idx * 3 + 1] ?? 0;
        out[o + 2] = palette?.[idx * 3 + 2] ?? 0;
        out[o + 3] = alpha?.[idx] ?? 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

/** Writes RGBA pixels as a PNG (for the test phone, and to crop screenshots). */
export function encodePng(img: Image): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------------------------------------------------------------------------------------------- */
/* Contrast                                                                                        */

const lum = (r: number, g: number, b: number) => {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export const contrastRatio = (a: [number, number, number], b: [number, number, number]) => {
  const l1 = lum(...a);
  const l2 = lum(...b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/**
 * The contrast between the text and its background inside a box of the screenshot: the most common
 * colour is taken as the background and the most different common colour as the text. Returns null
 * when the box holds only one colour (no text drawn, or the picture is off).
 */
export function boxContrast(img: Image, box: { x: number; y: number; width: number; height: number }): { ratio: number; fg: string; bg: string } | null {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(img.width, Math.ceil(box.x + box.width));
  const y1 = Math.min(img.height, Math.ceil(box.y + box.height));
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  const counts = new Map<number, number>();
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20_000)));
  for (let y = y0; y < y1; y += step)
    for (let x = x0; x < x1; x += step) {
      const o = (y * img.width + x) * 4;
      // Colours rounded to 16 levels, so anti-aliased edges join their colour.
      const key = ((img.data[o] >> 4) << 8) | ((img.data[o + 1] >> 4) << 4) | (img.data[o + 2] >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  if (sorted.length < 2) return null;
  const rgb = (k: number): [number, number, number] => [((k >> 8) & 15) * 17, ((k >> 4) & 15) * 17, (k & 15) * 17];
  const bg = rgb(sorted[0][0]);
  const total = sorted.reduce((n, s) => n + s[1], 0);
  // The text colour: among colours covering at least 3% of the box, the one most unlike the background.
  let best: { ratio: number; c: [number, number, number] } | null = null;
  for (const [k, n] of sorted.slice(1, 8)) {
    if (n / total < 0.03) continue;
    const c = rgb(k);
    const ratio = contrastRatio(bg, c);
    if (!best || ratio > best.ratio) best = { ratio, c };
  }
  if (!best) return null;
  const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return { ratio: Math.round(best.ratio * 100) / 100, fg: hex(best.c), bg: hex(bg) };
}
