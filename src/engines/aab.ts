/*
 * Android App Bundles (.aab) and split sets (.apks from bundletool, .xapk from app stores).
 *
 * An app bundle keeps its manifest and res/xml files in aapt2's protocol-buffer XML instead of
 * the binary XML of an APK, and keeps each part in its own folder (base/manifest, base/dex, ...).
 * The engine reads the bundle's entries under the names an APK would use, so every Android check
 * works on both.
 */
import { zipSync } from "fflate";
import { parseAxml, type XmlNode, type XmlValue } from "./axml.js";
import { listZip, readEntry, type ZipEntry } from "./zip.js";

/* ------------------------------------------------------------------------------------------------
 * A minimal protocol-buffer reader: enough for aapt2's XmlNode, XmlElement and XmlAttribute.
 * ---------------------------------------------------------------------------------------------- */

interface Field {
  no: number;
  /** 0 = varint, 2 = bytes (length-delimited), 1/5 = fixed 64/32. */
  wire: number;
  int?: number;
  bytes?: Buffer;
}

function varint(buf: Buffer, p: { i: number }): number {
  let out = 0;
  let mul = 1;
  for (let n = 0; n < 10; n++) {
    if (p.i >= buf.length) throw new Error("Cut-off protocol buffer.");
    const b = buf[p.i++];
    out += (b & 0x7f) * mul;
    if (!(b & 0x80)) return out;
    mul *= 128;
  }
  throw new Error("Bad varint.");
}

export function readFields(buf: Buffer): Field[] {
  const out: Field[] = [];
  const p = { i: 0 };
  while (p.i < buf.length) {
    const key = varint(buf, p);
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, int: varint(buf, p) });
    else if (wire === 2) {
      const len = varint(buf, p);
      if (p.i + len > buf.length) throw new Error("Cut-off protocol buffer.");
      out.push({ no, wire, bytes: buf.subarray(p.i, p.i + len) });
      p.i += len;
    } else if (wire === 5) {
      out.push({ no, wire, int: buf.readUInt32LE(p.i) });
      p.i += 4;
    } else if (wire === 1) {
      out.push({ no, wire, int: Number(buf.readBigUInt64LE(p.i)) });
      p.i += 8;
    } else throw new Error(`Unsupported protocol buffer field type ${wire}.`);
  }
  return out;
}

const text = (f?: Field) => (f?.bytes ? f.bytes.toString("utf8") : "");
const first = (fields: Field[], no: number) => fields.find((f) => f.no === no);

/** An attribute's value: the compiled one when aapt2 kept it (booleans, numbers, references), else its text. */
function attrValue(attr: Field[]): XmlValue {
  const raw = text(first(attr, 3));
  const item = first(attr, 6)?.bytes;
  if (item) {
    const it = readFields(item);
    const ref = first(it, 1)?.bytes;
    if (ref) {
      const id = first(readFields(ref), 2)?.int;
      if (id) return { ref: id };
    }
    const prim = first(it, 7)?.bytes;
    if (prim) {
      const pf = readFields(prim);
      const b = first(pf, 8);
      if (b) return b.int !== 0;
      const dec = first(pf, 6);
      if (dec) return dec.int! | 0;
      const hex = first(pf, 7);
      if (hex) return hex.int! >>> 0;
    }
    const s = first(it, 2)?.bytes ?? first(it, 3)?.bytes;
    if (s) return text(first(readFields(s), 1));
  }
  if (raw === "true" || raw === "false") return raw === "true";
  return raw;
}

function element(buf: Buffer): XmlNode {
  const f = readFields(buf);
  const node: XmlNode = { tag: text(first(f, 3)), attrs: {}, children: [] };
  for (const a of f.filter((x) => x.no === 4 && x.bytes)) {
    const af = readFields(a.bytes!);
    const name = text(first(af, 2));
    if (name) node.attrs[name] = attrValue(af);
  }
  for (const c of f.filter((x) => x.no === 5 && x.bytes)) {
    const cf = readFields(c.bytes!);
    const el = first(cf, 1)?.bytes;
    if (el) node.children.push(element(el));
    else {
      const t = text(first(cf, 2));
      if (t.trim()) node.text = (node.text ?? "") + t;
    }
  }
  return node;
}

/** Reads aapt2's protocol-buffer XML (manifest and res/xml files in an app bundle). */
export function parseProtoXml(buf: Buffer): XmlNode {
  const f = readFields(buf);
  const el = first(f, 1)?.bytes;
  if (!el) throw new Error("Not an app bundle XML file.");
  const node = element(el);
  if (!node.tag) throw new Error("Not an app bundle XML file.");
  return node;
}

/** Reads an Android XML file in either format: an APK's binary XML or an app bundle's protocol buffer. */
export function parseAndroidXml(buf: Buffer): XmlNode {
  if (buf.length >= 8 && buf.readUInt16LE(0) === 0x0003 && buf.readUInt16LE(2) === 0x0008) return parseAxml(buf);
  return parseProtoXml(buf);
}

/* ------------------------------------------------------------------------------------------------
 * Bundles and split sets.
 * ---------------------------------------------------------------------------------------------- */

export type AndroidPackaging = "apk" | "aab" | "apks";

/** Entry names in an app bundle as an APK would have them: base/manifest/AndroidManifest.xml is AndroidManifest.xml. */
export function bundleName(name: string): string | null {
  const m = name.match(/^base\/(manifest|dex|root|lib|res|assets)\/(.+)$/);
  if (!m) return null;
  if (m[1] === "manifest") return m[2];
  if (m[1] === "dex" || m[1] === "root") return m[2];
  return `${m[1]}/${m[2]}`;
}

export interface AndroidPackage {
  /** The file the checks read: the APK itself, the bundle, or the base APK of a split set (with the splits' libraries added). */
  buf: Buffer;
  entries: ZipEntry[];
  packaging: AndroidPackaging;
  /** For a split set: the APKs inside it. */
  splits: string[];
  notes: string[];
}

/**
 * Opens an APK, an app bundle or a split set. Bundle entries are renamed to APK paths (their data
 * stays where it is); a split set's base APK is used, with native libraries from its other splits
 * copied in so the 64-bit and 16 KB page checks see them.
 */
export function openAndroidPackage(buf: Buffer): AndroidPackage {
  const entries = listZip(buf);
  const names = new Set(entries.map((e) => e.name));
  if (names.has("AndroidManifest.xml")) return { buf, entries, packaging: "apk", splits: [], notes: [] };
  if (names.has("base/manifest/AndroidManifest.xml")) {
    const out: ZipEntry[] = [];
    for (const e of entries) {
      const n = bundleName(e.name);
      if (n) out.push({ ...e, name: n });
      else if (e.name.startsWith("META-INF/")) out.push(e);
    }
    const features = [...new Set(entries.map((e) => e.name.split("/")[0]).filter((d) => d !== "base" && d !== "META-INF" && d !== "BUNDLE-METADATA" && !d.includes(".")))];
    return {
      buf,
      entries: out,
      packaging: "aab",
      splits: [],
      notes: [
        `This is an Android App Bundle (.aab): the checks read its base module the way Google Play will build it into APKs.${features.length ? ` Feature modules not checked: ${features.slice(0, 6).join(", ")}.` : ""}`,
      ],
    };
  }
  const apks = entries.filter((e) => /\.apk$/i.test(e.name) && !e.name.startsWith("__MACOSX"));
  if (!apks.length) throw new Error("This file has no AndroidManifest.xml, so it is not an APK, an app bundle (.aab) or a split set (.apks, .xapk).");
  const pick =
    apks.find((e) => /(^|\/)universal\.apk$/i.test(e.name)) ??
    apks.find((e) => /(^|\/)(base-master|base)\.apk$/i.test(e.name)) ??
    apks.find((e) => !/config\.|split_config|-config/i.test(e.name)) ??
    apks.slice().sort((a, b) => b.size - a.size)[0];
  const base = readEntry(buf, pick);
  const baseEntries = listZip(base);
  const notes = [`This is a split set with ${apks.length} APK${apks.length === 1 ? "" : "s"}: the checks read ${pick.name}.`];
  // Native libraries live in the per-processor splits (config.arm64_v8a.apk): copy them in.
  if (!/universal\.apk$/i.test(pick.name)) {
    const have = new Set(baseEntries.map((e) => e.name));
    const libs: Record<string, [Uint8Array, { level: 0 }]> = {};
    let total = 0;
    for (const s of apks.filter((a) => a !== pick)) {
      let inner: Buffer;
      try {
        inner = readEntry(buf, s);
      } catch {
        continue;
      }
      for (const e of listZip(inner).filter((x) => x.name.startsWith("lib/") && x.name.endsWith(".so") && !have.has(x.name))) {
        if ((total += e.size) > 300_000_000) break;
        libs[e.name] = [readEntry(inner, e), { level: 0 }];
      }
    }
    if (Object.keys(libs).length) {
      const files: Record<string, [Uint8Array, { level: 0 }]> = {};
      for (const e of baseEntries) files[e.name] = [readEntry(base, e), { level: 0 }];
      Object.assign(files, libs);
      const merged = Buffer.from(zipSync(files));
      notes.push(`Native libraries from the processor splits were checked too (${Object.keys(libs).length} files).`);
      return { buf: merged, entries: listZip(merged), packaging: "apks", splits: apks.map((a) => a.name), notes };
    }
  }
  return { buf: base, entries: baseEntries, packaging: "apks", splits: apks.map((a) => a.name), notes };
}
