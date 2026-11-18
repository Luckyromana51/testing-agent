import { Inflate, inflateSync } from "fflate";

/* A small zip reader for APK and IPA files: lists entries from the central directory and unpacks one at a time. */

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  size: number;
  /** Where the entry's local header starts. */
  offset: number;
}

/** "4 KB" or "12.3 MB", for notes about file sizes. */
export function sizeText(bytes: number): string {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

export function listZip(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record is in the last 64 KB (after an optional comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a zip file (APK and IPA files are zips).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function rawData(buf: Buffer, e: ZipEntry): Buffer {
  if (buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error(`Bad zip entry ${e.name}`);
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  return buf.subarray(start, start + e.compressedSize);
}

/** Unpacks one entry. With `limit`, stops after about that many bytes (enough to read a file header). */
export function readEntry(buf: Buffer, e: ZipEntry, limit?: number): Buffer {
  const raw = rawData(buf, e);
  if (e.method === 0) return limit ? raw.subarray(0, limit) : raw;
  if (e.method !== 8) throw new Error(`Unsupported compression in ${e.name}`);
  if (!limit) return Buffer.from(inflateSync(raw));
  const chunks: Uint8Array[] = [];
  let got = 0;
  const inf = new Inflate((chunk) => {
    chunks.push(chunk);
    got += chunk.length;
  });
  for (let i = 0; i < raw.length && got < limit; i += 16_384) inf.push(raw.subarray(i, i + 16_384), i + 16_384 >= raw.length);
  return Buffer.concat(chunks).subarray(0, limit);
}
