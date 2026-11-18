/*
 * The headers of an iOS app's program file (Mach-O): which processors it is built for, whether it is
 * the encrypted copy the App Store hands out, whether it is a Simulator build, and the libraries it
 * loads. Only headers and load commands are read; the code itself is never run.
 */

export interface MachOSlice {
  arch: string;
  /** "ios", "ios-simulator", "macos", "mac-catalyst" and so on, when the file says. */
  platform?: string;
  /** Lowest iOS (or other) version the slice runs on, like "15.0". */
  minOS?: string;
  sdk?: string;
  /** Position-independent (needed for address randomisation). */
  pie: boolean;
  /** App Store encryption is on (cryptid 1): the code cannot be read until a device decrypts it. */
  encrypted: boolean;
  signed: boolean;
  /** Libraries and frameworks it loads, like "/System/Library/Frameworks/UIKit.framework/UIKit". */
  dylibs: string[];
}

export interface MachOInfo {
  /** One per processor in a universal ("fat") file, else one. */
  slices: MachOSlice[];
}

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const MH_PIE = 0x200000;

const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const LC_REEXPORT_DYLIB = 0x8000001f;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_CODE_SIGNATURE = 0x1d;
const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;
const LC_VERSION_MIN_IPHONEOS = 0x25;
const LC_BUILD_VERSION = 0x32;

const PLATFORMS: Record<number, string> = {
  1: "macos",
  2: "ios",
  3: "tvos",
  4: "watchos",
  6: "mac-catalyst",
  7: "ios-simulator",
  8: "tvos-simulator",
  9: "watchos-simulator",
  11: "visionos",
  12: "visionos-simulator",
};

function archName(cpu: number, sub: number): string {
  const s = sub & 0x00ffffff;
  switch (cpu) {
    case 0x0100000c:
      return s === 2 ? "arm64e" : "arm64";
    case 0x0200000c:
      return "arm64_32";
    case 12:
      return s === 11 ? "armv7s" : s === 9 ? "armv7" : "arm";
    case 0x01000007:
      return "x86_64";
    case 7:
      return "i386";
    default:
      return `cpu ${cpu}`;
  }
}

const version = (v: number) => {
  const parts = [v >>> 16, (v >>> 8) & 0xff, v & 0xff];
  return parts[2] ? parts.join(".") : `${parts[0]}.${parts[1]}`;
};

/** Is this the start of a Mach-O or universal file? */
export function isMachO(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  const be = buf.readUInt32BE(0);
  const le = buf.readUInt32LE(0);
  return be === FAT_MAGIC || be === FAT_MAGIC_64 || le === MH_MAGIC || le === MH_MAGIC_64;
}

export function parseMachO(buf: Buffer): MachOInfo {
  if (buf.length < 32) throw new Error("The app's program file is too short.");
  const magic = buf.readUInt32BE(0);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    const n = buf.readUInt32BE(4);
    if (n > 16) throw new Error("Damaged universal program file.");
    const slices: MachOSlice[] = [];
    for (let i = 0; i < n; i++) {
      const at = 8 + i * (magic === FAT_MAGIC_64 ? 32 : 20);
      const offset = magic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 8)) : buf.readUInt32BE(at + 8);
      const size = magic === FAT_MAGIC_64 ? Number(buf.readBigUInt64BE(at + 16)) : buf.readUInt32BE(at + 12);
      if (offset + Math.min(size, 32) > buf.length) continue;
      slices.push(parseThin(buf.subarray(offset, Math.min(buf.length, offset + size))));
    }
    if (!slices.length) throw new Error("Damaged universal program file.");
    return { slices };
  }
  return { slices: [parseThin(buf)] };
}

function parseThin(buf: Buffer): MachOSlice {
  const magic = buf.readUInt32LE(0);
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) throw new Error("This is not an iOS program file (Mach-O).");
  const is64 = magic === MH_MAGIC_64;
  const cpu = buf.readInt32LE(4) >>> 0;
  const sub = buf.readInt32LE(8) >>> 0;
  const ncmds = buf.readUInt32LE(16);
  const flags = buf.readUInt32LE(24);
  const slice: MachOSlice = { arch: archName(cpu, sub), pie: (flags & MH_PIE) !== 0, encrypted: false, signed: false, dylibs: [] };
  let p = is64 ? 32 : 28;
  for (let i = 0; i < Math.min(ncmds, 4096) && p + 8 <= buf.length; i++) {
    const cmd = buf.readUInt32LE(p);
    const size = buf.readUInt32LE(p + 4);
    if (size < 8 || p + size > buf.length) break;
    switch (cmd) {
      case LC_LOAD_DYLIB:
      case LC_LOAD_WEAK_DYLIB:
      case LC_REEXPORT_DYLIB:
      case LC_LAZY_LOAD_DYLIB: {
        const nameAt = buf.readUInt32LE(p + 8);
        if (nameAt < size) {
          const raw = buf.subarray(p + nameAt, p + size);
          const zero = raw.indexOf(0);
          slice.dylibs.push(raw.toString("utf8", 0, zero < 0 ? raw.length : zero));
        }
        break;
      }
      case LC_CODE_SIGNATURE:
        slice.signed = true;
        break;
      case LC_ENCRYPTION_INFO:
      case LC_ENCRYPTION_INFO_64:
        if (size >= 20) slice.encrypted = buf.readUInt32LE(p + 16) !== 0;
        break;
      case LC_VERSION_MIN_IPHONEOS:
        if (size >= 16) {
          slice.platform ??= "ios";
          slice.minOS = version(buf.readUInt32LE(p + 8));
          slice.sdk = version(buf.readUInt32LE(p + 12));
        }
        break;
      case LC_BUILD_VERSION:
        if (size >= 24) {
          const platform = buf.readUInt32LE(p + 8);
          slice.platform = PLATFORMS[platform] ?? `platform ${platform}`;
          slice.minOS = version(buf.readUInt32LE(p + 12));
          slice.sdk = version(buf.readUInt32LE(p + 16));
        }
        break;
    }
    p += size;
  }
  return slice;
}

/** The framework or library name from a load path: "/System/Library/Frameworks/UIKit.framework/UIKit" -> "UIKit". */
export const dylibName = (p: string) => (p.match(/([^/]+)\.framework\//)?.[1] ?? p.split("/").pop() ?? p).replace(/\.dylib$/, "");
