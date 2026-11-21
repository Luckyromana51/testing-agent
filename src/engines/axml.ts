/* Reads Android's binary XML (AndroidManifest.xml and res/xml files inside an APK). */

export type XmlValue = string | number | boolean | { ref: number };

export interface XmlNode {
  tag: string;
  attrs: Record<string, XmlValue>;
  children: XmlNode[];
  text?: string;
}

/**
 * Android attribute resource ids. Shrinkers can blank the attribute names in the string pool,
 * but the ids stay, so these are trusted first.
 */
const ATTR_IDS: Record<number, string> = {
  0x01010001: "label",
  0x01010002: "icon",
  0x01010003: "name",
  0x01010006: "permission",
  0x01010007: "readPermission",
  0x01010008: "writePermission",
  0x01010009: "protectionLevel",
  0x0101000f: "debuggable",
  0x01010010: "exported",
  0x0101001b: "grantUriPermissions",
  0x01010027: "scheme",
  0x01010028: "host",
  0x0101020c: "minSdkVersion",
  0x01010270: "targetSdkVersion",
  0x0101021b: "versionCode",
  0x0101021c: "versionName",
  0x01010280: "allowBackup",
  0x010104ec: "usesCleartextTraffic",
  0x01010527: "networkSecurityConfig",
  0x010104ee: "autoVerify",
  0x0101002a: "path",
  0x0101002b: "pathPrefix",
  0x0101002c: "pathPattern",
};

function readStringPool(buf: Buffer, off: number): string[] {
  const headerSize = buf.readUInt16LE(off + 2);
  const count = buf.readUInt32LE(off + 8);
  const flags = buf.readUInt32LE(off + 16);
  const stringsStart = buf.readUInt32LE(off + 20);
  const utf8 = (flags & 0x100) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = off + stringsStart + buf.readUInt32LE(off + headerSize + i * 4);
    try {
      if (utf8) {
        // Character count, then byte count, each one or two bytes.
        p += buf[p] & 0x80 ? 2 : 1;
        let len = buf[p];
        if (len & 0x80) {
          len = ((len & 0x7f) << 8) | buf[p + 1];
          p += 2;
        } else p += 1;
        out.push(buf.toString("utf8", p, p + len));
      } else {
        let len = buf.readUInt16LE(p);
        if (len & 0x8000) {
          len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
          p += 4;
        } else p += 2;
        out.push(buf.toString("utf16le", p, p + len * 2));
      }
    } catch {
      out.push("");
    }
  }
  return out;
}

export function parseAxml(buf: Buffer): XmlNode {
  if (buf.length < 8 || buf.readUInt16LE(0) !== 0x0003) throw new Error("Not an Android binary XML file.");
  const end = Math.min(buf.readUInt32LE(4), buf.length);
  let off = buf.readUInt16LE(2);
  let strings: string[] = [];
  const resIds: number[] = [];
  const root: XmlNode = { tag: "#root", attrs: {}, children: [] };
  const stack: XmlNode[] = [root];

  while (off + 8 <= end) {
    const type = buf.readUInt16LE(off);
    const headerSize = buf.readUInt16LE(off + 2);
    const size = buf.readUInt32LE(off + 4);
    if (size < 8 || off + size > end) break;
    if (type === 0x0001) {
      strings = readStringPool(buf, off);
    } else if (type === 0x0180) {
      for (let i = off + headerSize; i + 4 <= off + size; i += 4) resIds.push(buf.readUInt32LE(i));
    } else if (type === 0x0102) {
      const ext = off + headerSize;
      const node: XmlNode = { tag: strings[buf.readUInt32LE(ext + 4)] ?? "", attrs: {}, children: [] };
      const attrStart = buf.readUInt16LE(ext + 8);
      const attrSize = buf.readUInt16LE(ext + 10) || 20;
      const attrCount = buf.readUInt16LE(ext + 12);
      for (let i = 0; i < attrCount; i++) {
        const a = ext + attrStart + i * attrSize;
        if (a + 20 > off + size) break;
        const nameIdx = buf.readUInt32LE(a + 4);
        const raw = buf.readUInt32LE(a + 8);
        const dataType = buf[a + 15];
        const data = buf.readUInt32LE(a + 16);
        const name = ATTR_IDS[resIds[nameIdx]] ?? strings[nameIdx];
        if (!name) continue;
        let value: XmlValue;
        if (dataType === 0x03) value = strings[data] ?? "";
        else if (dataType === 0x12) value = data !== 0;
        else if (dataType === 0x10) value = data | 0;
        else if (dataType === 0x11) value = data >>> 0;
        else if (dataType === 0x01) value = { ref: data };
        else value = raw !== 0xffffffff ? (strings[raw] ?? "") : data;
        node.attrs[name] = value;
      }
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else if (type === 0x0103) {
      if (stack.length > 1) stack.pop();
    } else if (type === 0x0104) {
      const text = strings[buf.readUInt32LE(off + headerSize)];
      if (text) {
        const top = stack[stack.length - 1];
        top.text = (top.text ?? "") + text;
      }
    }
    off += size;
  }
  if (!root.children[0]) throw new Error("The binary XML file is empty.");
  return root.children[0];
}

/** Every node below `node` (and itself) with the tag. */
export function findAll(node: XmlNode, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (node.tag === tag) out.push(node);
  for (const c of node.children) findAll(c, tag, out);
  return out;
}

export const attrNumber = (v: XmlValue | undefined): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
};

export const attrBool = (v: XmlValue | undefined): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};
