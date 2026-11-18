import { zipSync } from "fflate";

/*
 * Test iOS apps, built in memory in the real file formats: binary and XML plists, a Mach-O program
 * with load commands and symbol names, a provisioning profile inside a CMS-like wrapper, frameworks.
 */

type PV = string | number | boolean | Date | Buffer | PV[] | { [k: string]: PV };

/** Writes a binary plist (bplist00), the way Xcode stores Info.plist in a built app. */
export function binaryPlist(root: PV): Buffer {
  const objects: Buffer[] = [];
  const refSize = 2;
  const ref = (n: number) => {
    const b = Buffer.alloc(refSize);
    b.writeUInt16BE(n);
    return b;
  };
  const lenMarker = (kind: number, n: number) => (n < 15 ? Buffer.from([(kind << 4) | n]) : Buffer.concat([Buffer.from([(kind << 4) | 0xf, 0x12]), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; })()]));
  const add = (v: PV): number => {
    const index = objects.length;
    objects.push(Buffer.alloc(0));
    let out: Buffer;
    if (typeof v === "boolean") out = Buffer.from([v ? 0x09 : 0x08]);
    else if (typeof v === "number") {
      const b = Buffer.alloc(9);
      b[0] = 0x13;
      b.writeBigInt64BE(BigInt(Math.trunc(v)), 1);
      out = b;
    } else if (v instanceof Date) {
      const b = Buffer.alloc(9);
      b[0] = 0x33;
      b.writeDoubleBE(v.getTime() / 1000 - 978_307_200, 1);
      out = b;
    } else if (Buffer.isBuffer(v)) out = Buffer.concat([lenMarker(0x4, v.length), v]);
    else if (typeof v === "string") {
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(v)) out = Buffer.concat([lenMarker(0x5, v.length), Buffer.from(v, "latin1")]);
      else {
        const u = Buffer.from(v, "utf16le");
        u.swap16();
        out = Buffer.concat([lenMarker(0x6, u.length / 2), u]);
      }
    } else if (Array.isArray(v)) {
      const refs = v.map((x) => add(x));
      out = Buffer.concat([lenMarker(0xa, refs.length), ...refs.map(ref)]);
    } else {
      const keys = Object.keys(v);
      const kr = keys.map((k) => add(k));
      const vr = keys.map((k) => add(v[k]));
      out = Buffer.concat([lenMarker(0xd, keys.length), ...kr.map(ref), ...vr.map(ref)]);
    }
    objects[index] = out;
    return index;
  };
  add(root);
  const header = Buffer.from("bplist00", "latin1");
  const offsets: number[] = [];
  let at = header.length;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const table = Buffer.alloc(objects.length * 4);
  offsets.forEach((o, i) => table.writeUInt32BE(o, i * 4));
  const trailer = Buffer.alloc(32);
  trailer[6] = 4;
  trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([header, ...objects, table, trailer]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** Writes an XML plist. */
export function xmlPlist(root: PV): Buffer {
  const w = (v: PV): string => {
    if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
    if (typeof v === "number") return `<integer>${v}</integer>`;
    if (v instanceof Date) return `<date>${v.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`;
    if (Buffer.isBuffer(v)) return `<data>${v.toString("base64")}</data>`;
    if (typeof v === "string") return `<string>${esc(v)}</string>`;
    if (Array.isArray(v)) return `<array>${v.map(w).join("")}</array>`;
    return `<dict>${Object.entries(v).map(([k, x]) => `<key>${esc(k)}</key>${w(x)}`).join("")}</dict>`;
  };
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${w(root)}</plist>\n`);
}

export interface MachOSpec {
  arch?: "arm64" | "x86_64";
  /** 2 = iOS, 7 = iOS Simulator. */
  platform?: number;
  minOS?: [number, number];
  pie?: boolean;
  encrypted?: boolean;
  signed?: boolean;
  dylibs?: string[];
  /** Names put in the symbol and selector tables, each between zero bytes. */
  symbols?: string[];
  /** Other text in the program (strings the code uses). */
  text?: string;
}

/** A small but real Mach-O 64-bit program header with load commands, then its "tables". */
export function machO(spec: MachOSpec = {}): Buffer {
  const cmds: Buffer[] = [];
  const cmd = (id: number, body: Buffer) => {
    const size = Math.ceil((8 + body.length) / 8) * 8;
    const b = Buffer.alloc(size);
    b.writeUInt32LE(id, 0);
    b.writeUInt32LE(size, 4);
    body.copy(b, 8);
    cmds.push(b);
  };
  const [maj, min] = spec.minOS ?? [15, 0];
  const bv = Buffer.alloc(16);
  bv.writeUInt32LE(spec.platform ?? 2, 0);
  bv.writeUInt32LE((maj << 16) | (min << 8), 4);
  bv.writeUInt32LE((18 << 16) | (0 << 8), 8);
  cmd(0x32, bv);
  for (const d of spec.dylibs ?? ["/System/Library/Frameworks/UIKit.framework/UIKit", "/System/Library/Frameworks/Foundation.framework/Foundation"]) {
    const body = Buffer.alloc(16 + d.length + 1);
    body.writeUInt32LE(24, 0); // name offset from the command start
    body.write(d, 16, "utf8");
    cmd(0xc, body);
  }
  const enc = Buffer.alloc(16);
  enc.writeUInt32LE(0x4000, 0);
  enc.writeUInt32LE(0x1000, 4);
  enc.writeUInt32LE(spec.encrypted ? 1 : 0, 8);
  cmd(0x2c, enc);
  if (spec.signed ?? true) cmd(0x1d, Buffer.alloc(8));
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(spec.arch === "x86_64" ? 0x01000007 : 0x0100000c, 4);
  header.writeUInt32LE(spec.arch === "x86_64" ? 3 : 0, 8);
  header.writeUInt32LE(2, 12); // executable
  header.writeUInt32LE(cmds.length, 16);
  header.writeUInt32LE(cmds.reduce((n, c) => n + c.length, 0), 20);
  header.writeUInt32LE((spec.pie ?? true) ? 0x200085 : 0x85, 24);
  const tables = Buffer.from(`\0${(spec.symbols ?? []).join("\0")}\0${spec.text ?? ""}\0`, "latin1");
  return Buffer.concat([header, ...cmds, Buffer.alloc(64), tables]);
}

/** A universal ("fat") file holding several Mach-O slices. */
export function fatMachO(slices: Buffer[]): Buffer {
  const head = Buffer.alloc(8 + slices.length * 20);
  head.writeUInt32BE(0xcafebabe, 0);
  head.writeUInt32BE(slices.length, 4);
  let at = Math.ceil(head.length / 16) * 16;
  const parts: Buffer[] = [];
  slices.forEach((s, i) => {
    const cpu = s.readUInt32LE(4);
    head.writeUInt32BE(cpu, 8 + i * 20);
    head.writeUInt32BE(s.readUInt32LE(8), 12 + i * 20);
    head.writeUInt32BE(at, 16 + i * 20);
    head.writeUInt32BE(s.length, 20 + i * 20);
    head.writeUInt32BE(4, 24 + i * 20);
    parts.push(s);
    at += Math.ceil(s.length / 16) * 16;
  });
  const out = Buffer.alloc(at);
  head.copy(out, 0);
  let p = Math.ceil(head.length / 16) * 16;
  for (const s of parts) {
    s.copy(out, p);
    p += Math.ceil(s.length / 16) * 16;
  }
  return out;
}

/** A provisioning profile: the plist inside a (fake) signed wrapper, like the real CMS file. */
export function mobileProvision(p: { [k: string]: PV }): Buffer {
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x2f, 0x00, 0x06, 0x09, 0x2a, 0x86]), Buffer.alloc(40, 7), xmlPlist(p), Buffer.alloc(300, 3)]);
}

const DAY = 86_400_000;
const cls = (n: string) => `_OBJC_CLASS_$_${n}`;

export interface IpaFiles {
  [path: string]: Buffer;
}

export function zipIpa(files: IpaFiles): Buffer {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new Uint8Array(v)]))));
}

/**
 * The planted app: ATS off, plain-HTTP and TLS 1.0 exceptions, file sharing, a custom scheme, a vague
 * camera text, location and tracking without purpose texts, no privacy manifest though the code uses
 * UserDefaults and the boot clock, Alamofire without its manifest, UIWebView, an AWS key, a plain-HTTP
 * server, and a debug profile that expires in 10 days. Traps that must not fire: "_status" is not
 * "_stat", the contacts text is good, localhost is allowed over HTTP, fb123 is a login callback.
 */
export function plantedIpa(): Buffer {
  const app = "Payload/GLV Shop.app/";
  const info = {
    CFBundleIdentifier: "in.glvshop.app",
    CFBundleExecutable: "GLVShop",
    CFBundleDisplayName: "GLV Shop",
    CFBundleShortVersionString: "2.3.0",
    CFBundleVersion: "41",
    MinimumOSVersion: "15.0",
    UIFileSharingEnabled: true,
    NSCameraUsageDescription: "Camera access",
    NSContactsUsageDescription: "Your contacts are used to invite friends to the shop.",
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: true,
      NSExceptionDomains: {
        "legacy.glvshop.in": { NSExceptionAllowsInsecureHTTPLoads: true, NSIncludesSubdomains: true },
        "pay.oldbank.example": { NSExceptionMinimumTLSVersion: "TLSv1.0" },
        localhost: { NSExceptionAllowsInsecureHTTPLoads: true },
      },
    },
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["glvshop", "fb123456789"] }],
  };
  const program = machO({
    symbols: [
      cls("UIViewController"),
      cls("UIWebView"),
      cls("WKWebView"),
      cls("NSUserDefaults"),
      cls("ATTrackingManager"),
      "_mach_absolute_time",
      "_status",
      "_statistics",
      "requestWhenInUseAuthorization",
      "requestAccessForEntityType:completionHandler:",
      "requestAccessForMediaType:completionHandler:",
    ],
    text: "https://api.glvshop.in/v2/ http://api.glvshop.in/v1/orders http://localhost:8080/ http://www.apple.com/DTDs/",
  });
  return zipIpa({
    [`${app}Info.plist`]: binaryPlist(info),
    [`${app}GLVShop`]: program,
    [`${app}embedded.mobileprovision`]: mobileProvision({
      Name: "GLV Shop Development",
      TeamName: "GLV Infotech Solutions",
      ExpirationDate: new Date(Date.now() + 10 * DAY),
      ProvisionedDevices: ["00008110-000A1B2C3D4E5F60", "00008030-001122334455667"],
      Entitlements: { "get-task-allow": true, "aps-environment": "development", "application-identifier": "ABCDE12345.in.glvshop.app" },
    }),
    [`${app}config.json`]: Buffer.from(JSON.stringify({ region: "ap-south-1", accessKey: "AKIAQ4ZXDEMOKEY12345", api: "https://api.glvshop.in" })),
    [`${app}_CodeSignature/CodeResources`]: xmlPlist({ files: {} }),
    [`${app}Frameworks/Alamofire.framework/Alamofire`]: machO({ symbols: [cls("NSURLSession")] }),
    [`${app}Frameworks/Alamofire.framework/Info.plist`]: binaryPlist({ CFBundleExecutable: "Alamofire" }),
    [`${app}Frameworks/FirebaseCore.framework/FirebaseCore`]: machO({ symbols: [cls("NSUserDefaults")] }),
    [`${app}Frameworks/FirebaseCore.framework/PrivacyInfo.xcprivacy`]: xmlPlist({ NSPrivacyTracking: false }),
    [`${app}Frameworks/ShopHelpers.framework/ShopHelpers`]: machO({ symbols: ["_stat"] }),
    [`${app}PlugIns/Widget.appex/Info.plist`]: binaryPlist({ CFBundleIdentifier: "in.glvshop.app.widget" }),
  });
}

/** The same app done right: nothing should be found. Its Info.plist is XML, like a source project's. */
export function cleanIpa(): Buffer {
  const app = "Payload/GLV Shop.app/";
  const info = {
    CFBundleIdentifier: "in.glvshop.app",
    CFBundleExecutable: "GLVShop",
    CFBundleName: "GLV Shop",
    CFBundleShortVersionString: "2.3.0",
    CFBundleVersion: "42",
    MinimumOSVersion: "16.0",
    ITSAppUsesNonExemptEncryption: false,
    NSCameraUsageDescription: "Your camera is used to scan the bar code on your order.",
    NSLocationWhenInUseUsageDescription: "Your location is used to show the stores near you.",
    NSUserTrackingUsageDescription: "This lets us show you offers from shops you like on other apps.",
    NSContactsUsageDescription: "Your contacts are used to invite friends to the shop.",
    NSAppTransportSecurity: { NSExceptionDomains: { localhost: { NSExceptionAllowsInsecureHTTPLoads: true } } },
    CFBundleURLTypes: [{ CFBundleURLSchemes: ["in.glvshop.app", "fb123456789"] }],
  };
  const program = machO({
    symbols: [
      cls("UIViewController"),
      cls("WKWebView"),
      cls("NSUserDefaults"),
      cls("ATTrackingManager"),
      "_mach_absolute_time",
      "_status",
      "requestWhenInUseAuthorization",
      "requestAccessForEntityType:completionHandler:",
      "requestAccessForMediaType:completionHandler:",
    ],
    text: "https://api.glvshop.in/v2/ http://localhost:8080/",
  });
  return zipIpa({
    [`${app}Info.plist`]: xmlPlist(info),
    [`${app}GLVShop`]: fatMachO([program, machO({ arch: "x86_64", platform: 7, symbols: [cls("NSUserDefaults")] })]),
    [`${app}PrivacyInfo.xcprivacy`]: xmlPlist({
      NSPrivacyTracking: false,
      NSPrivacyAccessedAPITypes: [
        { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategoryUserDefaults", NSPrivacyAccessedAPITypeReasons: ["CA92.1"] },
        { NSPrivacyAccessedAPIType: "NSPrivacyAccessedAPICategorySystemBootTime", NSPrivacyAccessedAPITypeReasons: ["35F9.1"] },
      ],
    }),
    [`${app}embedded.mobileprovision`]: mobileProvision({
      Name: "GLV Shop Ad Hoc",
      TeamName: "GLV Infotech Solutions",
      ExpirationDate: new Date(Date.now() + 200 * DAY),
      ProvisionedDevices: ["00008110-000A1B2C3D4E5F60"],
      Entitlements: { "get-task-allow": false, "aps-environment": "production" },
    }),
    [`${app}config.json`]: Buffer.from(JSON.stringify({ region: "ap-south-1", api: "https://api.glvshop.in" })),
    [`${app}_CodeSignature/CodeResources`]: xmlPlist({ files: {} }),
    [`${app}Frameworks/Alamofire.framework/Alamofire`]: machO({ symbols: [cls("NSURLSession")] }),
    [`${app}Frameworks/Alamofire.framework/PrivacyInfo.xcprivacy`]: xmlPlist({ NSPrivacyTracking: false }),
    // CocoaPods puts a static SDK's manifest in a resource bundle in the app.
    [`${app}Frameworks/FirebaseCore.framework/FirebaseCore`]: machO({ symbols: [cls("NSUserDefaults")] }),
    [`${app}FirebaseCore_Privacy.bundle/PrivacyInfo.xcprivacy`]: xmlPlist({ NSPrivacyTracking: false }),
  });
}

/** The App Store's copy of the planted app: encrypted program, no provisioning profile. */
export function appStoreIpa(): Buffer {
  const app = "Payload/GLV Shop.app/";
  return zipIpa({
    [`${app}Info.plist`]: binaryPlist({
      CFBundleIdentifier: "in.glvshop.app",
      CFBundleExecutable: "GLVShop",
      CFBundleShortVersionString: "2.3.0",
      CFBundleVersion: "41",
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription: "Camera access",
    }),
    [`${app}GLVShop`]: machO({ encrypted: true, symbols: [cls("UIWebView")] }),
    [`${app}_CodeSignature/CodeResources`]: xmlPlist({ files: {} }),
    [`${app}config.json`]: Buffer.from(JSON.stringify({ accessKey: "AKIAQ4ZXDEMOKEY12345" })),
  });
}

/** A zipped Simulator build (GLV Shop.app at the top), as the Mac helper runs it. */
export function simulatorAppZip(): Buffer {
  const app = "GLV Shop.app/";
  return zipIpa({
    [`${app}Info.plist`]: binaryPlist({ CFBundleIdentifier: "in.glvshop.app", CFBundleExecutable: "GLVShop", CFBundleShortVersionString: "2.3.0", CFBundleVersion: "41" }),
    [`${app}GLVShop`]: machO({ arch: "arm64", platform: 7, signed: false, symbols: [cls("UIViewController")] }),
  });
}
