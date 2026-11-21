/*
 * Apps for the mobile module's tests, built byte by byte: an Android App Bundle (protocol-buffer
 * manifest), a split set, an APK with every new planted problem, the same APK done right, and an
 * iOS app with the new iOS problems.
 */
import { zipSync } from "fflate";
import { buildDemoApk, elfWithAlign, encodeAxml, type El } from "./demo-apk.js";
import { binaryPlist, machO, xmlPlist, zipIpa } from "./demo-ipa.js";

/* ---------------------------------------------------------------------------------------------- */
/* Protocol buffers (aapt2's XML in app bundles)                                                   */

const varint = (n: number) => {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
};
const field = (no: number, data: Buffer | string) => {
  const b = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return Buffer.concat([varint(no * 8 + 2), varint(b.length), b]);
};
const intField = (no: number, n: number) => Buffer.concat([varint(no * 8), varint(n)]);

function protoAttr(name: string, v: string | number | boolean): Buffer {
  const parts = [field(1, "http://schemas.android.com/apk/res/android"), field(2, name), field(3, String(v))];
  if (typeof v === "boolean") parts.push(field(6, field(7, intField(8, v ? 1 : 0))));
  else if (typeof v === "number") parts.push(field(6, field(7, intField(6, v))));
  return Buffer.concat(parts);
}
function protoElement(e: El): Buffer {
  const parts = [field(3, e.tag)];
  for (const [k, v] of e.attrs ?? []) parts.push(field(4, protoAttr(k, v)));
  for (const c of e.children ?? []) parts.push(field(5, field(1, protoElement(c))));
  if (e.text) parts.push(field(5, field(2, e.text)));
  return Buffer.concat(parts);
}
/** aapt2's protocol-buffer XML for an element tree. */
export const protoXml = (root: El) => field(1, protoElement(root));

/** The demo APK as an app bundle: the same manifest and code, in base/ folders, signed with jarsigner (v1). */
export function buildDemoAab(): Buffer {
  const manifest: El = {
    tag: "manifest",
    attrs: [
      ["package", "in.glv.demoshop"],
      ["versionCode", 7],
      ["versionName", "1.4.0"],
    ],
    children: [
      { tag: "uses-sdk", attrs: [["minSdkVersion", 24], ["targetSdkVersion", 30]] },
      { tag: "uses-permission", attrs: [["name", "android.permission.READ_SMS"]] },
      {
        tag: "application",
        attrs: [
          ["debuggable", true],
          ["usesCleartextTraffic", true],
        ],
        children: [{ tag: "provider", attrs: [["name", "in.glv.demoshop.OrdersProvider"], ["exported", true]] }],
      },
    ],
  };
  return Buffer.from(
    zipSync({
      "base/manifest/AndroidManifest.xml": protoXml(manifest),
      "base/dex/classes.dex": Buffer.from("dex\n035\0 Lin/glv/demoshop/Api; http://192.168.1.50:8080/api/orders", "latin1"),
      "base/lib/arm64-v8a/libnative.so": elfWithAlign(0x1000),
      "base/resources.pb": Buffer.alloc(16),
      "BundleConfig.pb": Buffer.alloc(4),
      "dynamic_feature/manifest/AndroidManifest.xml": protoXml({ tag: "manifest" }),
      "META-INF/UPLOAD.RSA": Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from("CN=Android Debug, O=Android, C=US", "latin1")]),
    }),
  );
}

/** A bundletool split set: the base APK without native code, and an arm64 split with a 4 KB-aligned library. */
export function buildSplitSet(): Buffer {
  const base = buildDemoApk();
  const arm = Buffer.from(zipSync({ "AndroidManifest.xml": encodeAxml({ tag: "manifest", attrs: [["package", "in.glv.demoshop"]] }), "lib/arm64-v8a/libpay.so": elfWithAlign(0x1000) }));
  return Buffer.from(zipSync({ "splits/base-master.apk": [base, { level: 0 }], "splits/base-arm64_v8a.apk": [arm, { level: 0 }], "toc.pb": Buffer.alloc(4) }));
}

/* ---------------------------------------------------------------------------------------------- */
/* resources.arsc                                                                                  */

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

function pool(strings: string[]): Buffer {
  const data = strings.map((s) => Buffer.concat([Buffer.from([s.length, s.length]), Buffer.from(s, "utf8"), Buffer.from([0])]));
  const offsets: number[] = [];
  let pos = 0;
  for (const d of data) {
    offsets.push(pos);
    pos += d.length;
  }
  let body = Buffer.concat(data);
  if (body.length % 4) body = Buffer.concat([body, Buffer.alloc(4 - (body.length % 4))]);
  const start = 28 + strings.length * 4;
  return Buffer.concat([u16(0x0001), u16(28), u32(start + body.length), u32(strings.length), u32(0), u32(0x100), u32(start), u32(0), ...offsets.map(u32), body]);
}

/** A resources table with `entries` string entries per language ("" = the default). Only present entries get an offset. */
export function arsc(langs: Record<string, number>, total: number): Buffer {
  const typeStrings = pool(["string"]);
  const keyStrings = pool(Array.from({ length: total }, (_, i) => `text_${i}`));
  const types = Object.entries(langs).map(([lang, n]) => {
    const config = Buffer.alloc(64);
    config.writeUInt32LE(64, 0);
    if (lang) config.write(lang.slice(0, 2), 8, "latin1");
    const offsets = Array.from({ length: total }, (_, i) => (i < n ? i * 16 : 0xffffffff));
    const headerSize = 20 + 64;
    const entries = Buffer.alloc(n * 16);
    const size = headerSize + total * 4 + entries.length;
    return Buffer.concat([u16(0x0201), u16(headerSize), u32(size), Buffer.from([1, 0]), u16(0), u32(total), u32(headerSize + total * 4), config, ...offsets.map(u32), entries]);
  });
  const name = Buffer.alloc(256);
  name.write("in.glv.richshop", "utf16le");
  const pkgHeader = 288;
  const pkgBody = Buffer.concat([typeStrings, keyStrings, ...types]);
  const pkg = Buffer.concat([u16(0x0200), u16(pkgHeader), u32(pkgHeader + pkgBody.length), u32(0x7f), name, u32(pkgHeader), u32(1), u32(pkgHeader + typeStrings.length), u32(total), u32(0), pkgBody]);
  const global = pool([]);
  return Buffer.concat([u16(0x0002), u16(12), u32(12 + global.length + pkg.length), u32(1), global, pkg]);
}

/* ---------------------------------------------------------------------------------------------- */
/* An APK with the new problems                                                                    */

const PIC = 1_200_000;

/**
 * Planted: trust-all certificates, ECB encryption, code loaded at run time, a FileProvider sharing
 * everything, AppsFlyer and AdMob without the advertising ID permission, a Flutter debug build, a
 * staging server, a screen with an intent filter but no android:exported (API 34), App Links that
 * cannot verify, a 1.2 MB picture, the same video twice, Hindi half translated.
 */
export function buildRichApk(opts: { clean?: boolean; version?: string; extraPermission?: string } = {}): Buffer {
  const clean = opts.clean === true;
  const manifest = encodeAxml({
    tag: "manifest",
    attrs: [
      ["package", "in.glv.richshop"],
      ["versionCode", opts.version === "2.1.0" ? 21 : 20],
      ["versionName", opts.version ?? "2.0.0"],
    ],
    children: [
      { tag: "uses-sdk", attrs: [["minSdkVersion", 26], ["targetSdkVersion", 35]] },
      { tag: "uses-permission", attrs: [["name", "android.permission.INTERNET"]] },
      ...(opts.extraPermission ? [{ tag: "uses-permission", attrs: [["name", opts.extraPermission]] as [string, string][] }] : []),
      ...(clean ? [] : []),
      {
        tag: "application",
        attrs: [
          ["icon", "@mipmap/ic_launcher"],
          ["label", "Rich Shop"],
          ["allowBackup", false],
        ],
        children: [
          {
            tag: "activity",
            attrs: [
              ["name", ".MainActivity"],
              ["exported", true],
            ],
            children: [
              {
                tag: "intent-filter",
                children: [
                  { tag: "action", attrs: [["name", "android.intent.action.MAIN"]] },
                  { tag: "category", attrs: [["name", "android.intent.category.LAUNCHER"]] },
                ],
              },
            ],
          },
          ...(clean
            ? []
            : [
                {
                  tag: "activity",
                  attrs: [["name", ".ShareActivity"]] as [string, string][],
                  children: [{ tag: "intent-filter", children: [{ tag: "action", attrs: [["name", "android.intent.action.SEND"]] as [string, string][] }] }],
                },
                {
                  tag: "activity",
                  attrs: [
                    ["name", ".LinkActivity"],
                    ["exported", true],
                  ] as [string, string | boolean][],
                  children: [
                    {
                      tag: "intent-filter",
                      attrs: [["autoVerify", true]] as [string, boolean][],
                      children: [
                        { tag: "action", attrs: [["name", "android.intent.action.VIEW"]] as [string, string][] },
                        { tag: "category", attrs: [["name", "android.intent.category.BROWSABLE"]] as [string, string][] },
                        { tag: "data", attrs: [["scheme", "https"], ["host", "links.richshop.invalid"]] as [string, string][] },
                      ],
                    },
                  ],
                },
              ]),
        ],
      },
    ],
  });
  const dexText = clean
    ? "dex\n035\0 Lin/glv/richshop/MainActivity; Lin/glv/richshop/a; Lin/glv/richshop/b; Lkotlin/Unit; https://api.richshop.in/v2/ okhttp/4.12.0\0"
    : [
        "dex\n035\0",
        "Lin/glv/richshop/MainActivity;",
        "Lin/glv/richshop/net/TrustAllCerts;",
        "Lcom/appsflyer/AppsFlyerLib;",
        "Lcom/google/android/gms/ads/MobileAds;",
        "Ldalvik/system/DexClassLoader;",
        "\0AES/ECB/PKCS5Padding\0",
        "https://staging-api.richshop.in/v1/",
        "https://api.richshop.in/v2/",
        "okhttp/4.9.0",
      ].join(" ");
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    "AndroidManifest.xml": manifest,
    "classes.dex": Buffer.from(dexText, "latin1"),
    "META-INF/androidx.core_core.version": Buffer.from("1.12.0\n"),
    "META-INF/kotlinx_coroutines_core.version": Buffer.from("1.7.3\n"),
    "resources.arsc": arsc(clean ? { "": 20, hi: 20 } : { "": 20, hi: 12, ta: 20, fr: 3 }, 20),
    "META-INF/CERT.RSA": Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from("CN=GLV Release, O=GLV, C=IN", "latin1")]),
  };
  if (!clean) {
    files["res/xml/file_paths.xml"] = encodeAxml({ tag: "paths", children: [{ tag: "root-path", attrs: [["name", "all"], ["path", ""]] }] });
    files["lib/arm64-v8a/libflutter.so"] = elfWithAlign(0x4000);
    files["assets/flutter_assets/kernel_blob.bin"] = Buffer.alloc(100);
    files["res/drawable/banner.png"] = [Buffer.alloc(PIC, 7), { level: 0 }];
    files["assets/intro.mp4"] = [Buffer.alloc(600_000, 3), { level: 0 }];
    files["assets/intro_copy.mp4"] = [Buffer.alloc(600_000, 3), { level: 0 }];
  }
  return Buffer.from(zipSync(files));
}

/* ---------------------------------------------------------------------------------------------- */
/* An iOS app with the new problems                                                                */

const cls = (n: string) => `_OBJC_CLASS_$_${n}`;

/**
 * Planted: keychain items readable while locked, AppsFlyer without the tracking prompt text, a React
 * Native development bundle with its source map, Hindi half translated, Universal Links that do not
 * verify, a staging server, and no launch screen.
 */
export function buildRichIpa(): Buffer {
  const app = "Payload/RichShop.app/";
  const ent = xmlPlist({ "application-identifier": "ABCDE12345.in.glv.richshop", "com.apple.developer.team-identifier": "ABCDE12345", "com.apple.developer.associated-domains": ["applinks:links.richshop.invalid"] });
  const program = Buffer.concat([
    machO({ symbols: ["___stack_chk_guard", "_objc_release", "_kSecAttrAccessibleAlways", cls("NSURLSession")], text: "https://staging.richshop.in/api https://api.richshop.in/v2" }),
    Buffer.from("\0\0"),
    ent,
  ]);
  const strings = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => `"text_${i}" = "Text ${i}";`).join("\n"));
  return zipIpa({
    [`${app}Info.plist`]: binaryPlist({
      CFBundleIdentifier: "in.glv.richshop",
      CFBundleExecutable: "RichShop",
      CFBundleDisplayName: "Rich Shop",
      CFBundleShortVersionString: "3.0.0",
      CFBundleVersion: "30",
      CFBundleIconName: "AppIcon",
      CFBundleDevelopmentRegion: "en",
      MinimumOSVersion: "15.0",
      ITSAppUsesNonExemptEncryption: false,
    }),
    [`${app}RichShop`]: program,
    [`${app}main.jsbundle`]: Buffer.from("var __BUNDLE_START_TIME__=this.nativePerformanceNow?nativePerformanceNow():Date.now(),__DEV__=true,process=this.process||{};"),
    [`${app}main.jsbundle.map`]: Buffer.from('{"version":3}'),
    [`${app}Frameworks/React.framework/React`]: machO({ symbols: [cls("RCTBridge")] }),
    [`${app}Frameworks/React.framework/Info.plist`]: binaryPlist({ CFBundleExecutable: "React", CFBundleShortVersionString: "0.76.1" }),
    [`${app}Frameworks/AppsFlyerLib.framework/AppsFlyerLib`]: machO({ symbols: [cls("AppsFlyerLib")] }),
    [`${app}Frameworks/AppsFlyerLib.framework/Info.plist`]: binaryPlist({ CFBundleExecutable: "AppsFlyerLib", CFBundleShortVersionString: "6.15.0" }),
    [`${app}Frameworks/AppsFlyerLib.framework/PrivacyInfo.xcprivacy`]: xmlPlist({ NSPrivacyTracking: true }),
    [`${app}PrivacyInfo.xcprivacy`]: xmlPlist({ NSPrivacyTracking: true, NSPrivacyTrackingDomains: ["appsflyer.com"], NSPrivacyAccessedAPITypes: [] }),
    [`${app}_CodeSignature/CodeResources`]: xmlPlist({ files: {} }),
    [`${app}en.lproj/Localizable.strings`]: strings(20),
    [`${app}hi.lproj/Localizable.strings`]: strings(12),
    [`${app}Base.lproj/LaunchScreen.storyboardc/Info.plist`]: binaryPlist({}),
  });
}
