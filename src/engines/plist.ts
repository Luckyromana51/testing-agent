/*
 * Property lists, the settings files of iOS apps (Info.plist, the privacy manifest, the provisioning
 * profile). Xcode writes them in binary ("bplist00") inside a built app; source projects and some
 * tools write XML. Both are read here, with limits, since the file comes from an uploaded app.
 */

export type PlistValue = string | number | boolean | Date | Buffer | null | PlistValue[] | PlistDict;
export interface PlistDict {
  [key: string]: PlistValue;
}

/** Reads a plist in either format. Throws on anything that is not one. */
export function parsePlist(buf: Buffer): PlistValue {
  if (buf.subarray(0, 6).toString("latin1") === "bplist") return parseBinaryPlist(buf);
  return parseXmlPlist(buf.toString("utf8"));
}

/** A plist that must be a dictionary at the top (Info.plist and most others). */
export function parsePlistDict(buf: Buffer): PlistDict {
  const v = parsePlist(buf);
  if (!isDict(v)) throw new Error("The plist is not a dictionary.");
  return v;
}

export const isDict = (v: unknown): v is PlistDict =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);

/* ---------------------------------------------------------------------------------------------- */
/* Binary plists                                                                                   */

const MAX_OBJECTS = 1_000_000;
const MAX_DEPTH = 64;
/** Seconds between 1970-01-01 and 2001-01-01, the start of Apple's clock. */
const APPLE_EPOCH = 978_307_200;

export function parseBinaryPlist(buf: Buffer): PlistValue {
  if (buf.length < 40 || buf.subarray(0, 8).toString("latin1") !== "bplist00") throw new Error("Not a binary plist.");
  const t = buf.length - 32;
  const offsetSize = buf[t + 6];
  const refSize = buf[t + 7];
  const count = Number(buf.readBigUInt64BE(t + 8));
  const top = Number(buf.readBigUInt64BE(t + 16));
  const tableAt = Number(buf.readBigUInt64BE(t + 24));
  if (!offsetSize || !refSize || offsetSize > 8 || refSize > 8 || count > MAX_OBJECTS || top >= count || tableAt + count * offsetSize > t) {
    throw new Error("Damaged binary plist.");
  }
  const uint = (at: number, size: number): number => {
    if (at < 0 || at + size > buf.length) throw new Error("Damaged binary plist.");
    let n = 0;
    for (let i = 0; i < size; i++) n = n * 256 + buf[at + i];
    return n;
  };
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) offsets.push(uint(tableAt + i * offsetSize, offsetSize));

  const read = (ref: number, depth: number, seen: Set<number>): PlistValue => {
    if (ref >= count) throw new Error("Damaged binary plist.");
    if (depth > MAX_DEPTH || seen.has(ref)) throw new Error("The plist nests too deep or refers to itself.");
    const at = offsets[ref];
    if (at >= t) throw new Error("Damaged binary plist.");
    const marker = buf[at];
    const kind = marker >> 4;
    const low = marker & 0x0f;
    // Lengths of 15 or more are written as an int object after the marker.
    const length = (): { n: number; start: number } => {
      if (low !== 0x0f) return { n: low, start: at + 1 };
      const intMarker = buf[at + 1];
      if (intMarker >> 4 !== 0x1) throw new Error("Damaged binary plist.");
      const size = 1 << (intMarker & 0x0f);
      return { n: uint(at + 2, size), start: at + 2 + size };
    };
    switch (kind) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        return null;
      case 0x1: {
        const size = 1 << low;
        if (size === 8) return Number(buf.readBigInt64BE(at + 1));
        if (size === 16) return Number(buf.readBigInt64BE(at + 9));
        return uint(at + 1, size);
      }
      case 0x2:
        return low === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
      case 0x3:
        return new Date((buf.readDoubleBE(at + 1) + APPLE_EPOCH) * 1000);
      case 0x4: {
        const { n, start } = length();
        if (start + n > t) throw new Error("Damaged binary plist.");
        return Buffer.from(buf.subarray(start, start + n));
      }
      case 0x5: {
        const { n, start } = length();
        if (start + n > t) throw new Error("Damaged binary plist.");
        return buf.toString("latin1", start, start + n);
      }
      case 0x6: {
        const { n, start } = length();
        if (start + n * 2 > t) throw new Error("Damaged binary plist.");
        const units = Buffer.from(buf.subarray(start, start + n * 2));
        units.swap16();
        return units.toString("utf16le");
      }
      case 0x8:
        return uint(at + 1, low + 1);
      case 0xa: {
        const { n, start } = length();
        const next = new Set(seen).add(ref);
        const out: PlistValue[] = [];
        for (let i = 0; i < n; i++) out.push(read(uint(start + i * refSize, refSize), depth + 1, next));
        return out;
      }
      case 0xd: {
        const { n, start } = length();
        const next = new Set(seen).add(ref);
        const out: PlistDict = {};
        for (let i = 0; i < n; i++) {
          const key = read(uint(start + i * refSize, refSize), depth + 1, next);
          const value = read(uint(start + (n + i) * refSize, refSize), depth + 1, next);
          if (typeof key === "string") out[key] = value;
        }
        return out;
      }
      default:
        throw new Error(`Unknown object type 0x${marker.toString(16)} in the binary plist.`);
    }
  };
  return read(top, 0, new Set());
}

/* ---------------------------------------------------------------------------------------------- */
/* XML plists                                                                                      */

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITY[e.toLowerCase()] ?? all;
  });

interface Tag {
  name: string;
  close: boolean;
  empty: boolean;
}

export function parseXmlPlist(xml: string): PlistValue {
  let i = 0;
  const skipJunk = () => {
    for (;;) {
      while (i < xml.length && /\s/.test(xml[i])) i++;
      if (xml.startsWith("<?", i)) i = end("?>");
      else if (xml.startsWith("<!--", i)) i = end("-->");
      else if (xml.startsWith("<!", i)) i = end(">");
      else return;
    }
  };
  const end = (marker: string) => {
    const at = xml.indexOf(marker, i);
    if (at < 0) throw new Error("Damaged XML plist.");
    return at + marker.length;
  };
  const tag = (): Tag => {
    skipJunk();
    if (xml[i] !== "<") throw new Error("Damaged XML plist.");
    const close = xml[i + 1] === "/";
    const stop = end(">");
    const inner = xml.slice(i + (close ? 2 : 1), stop - 1).trim();
    i = stop;
    const empty = inner.endsWith("/");
    return { name: inner.replace(/\/$/, "").split(/\s/)[0], close, empty };
  };
  const text = (name: string): string => {
    const stop = xml.indexOf(`</${name}>`, i);
    if (stop < 0) throw new Error(`Damaged XML plist: <${name}> is not closed.`);
    const raw = xml.slice(i, stop);
    i = stop + name.length + 3;
    return decode(raw);
  };
  const value = (t: Tag, depth: number): PlistValue => {
    if (depth > MAX_DEPTH) throw new Error("The plist nests too deep.");
    switch (t.name) {
      case "true":
      case "false": {
        if (!t.empty) text(t.name);
        return t.name === "true";
      }
      case "string":
        return t.empty ? "" : text("string");
      case "integer":
      case "real": {
        const n = Number(t.empty ? "0" : text(t.name).trim());
        return Number.isFinite(n) ? n : 0;
      }
      case "date":
        return new Date(t.empty ? 0 : text("date").trim());
      case "data":
        return Buffer.from(t.empty ? "" : text("data").replace(/\s+/g, ""), "base64");
      case "array": {
        const out: PlistValue[] = [];
        if (t.empty) return out;
        for (;;) {
          const next = tag();
          if (next.close) return out;
          out.push(value(next, depth + 1));
        }
      }
      case "dict": {
        const out: PlistDict = {};
        if (t.empty) return out;
        for (;;) {
          const k = tag();
          if (k.close) return out;
          if (k.name !== "key") throw new Error("Damaged XML plist: a dict needs a <key> before each value.");
          const key = k.empty ? "" : text("key");
          out[key] = value(tag(), depth + 1);
        }
      }
      default:
        throw new Error(`Unknown element <${t.name}> in the XML plist.`);
    }
  };
  const root = tag();
  if (root.name !== "plist") return value(root, 0);
  if (root.empty) return null;
  const first = tag();
  return first.close ? null : value(first, 0);
}

/* ---------------------------------------------------------------------------------------------- */
/* Small helpers for reading settings                                                              */

export const str = (v: PlistValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);
export const bool = (v: PlistValue | undefined): boolean | undefined =>
  typeof v === "boolean" ? v : typeof v === "string" ? /^(yes|true|1)$/i.test(v) || (/^(no|false|0)$/i.test(v) ? false : undefined) : typeof v === "number" ? v !== 0 : undefined;
export const dict = (v: PlistValue | undefined): PlistDict | undefined => (isDict(v) ? v : undefined);
export const arr = (v: PlistValue | undefined): PlistValue[] => (Array.isArray(v) ? v : []);
