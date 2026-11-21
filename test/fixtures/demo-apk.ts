import { zipSync } from "fflate";

/**
 * Builds a small fake APK with known, deliberate problems, so the tests can check the
 * Android engine without the Android SDK. The manifest is written in Android's binary XML format.
 */
type Value = string | number | boolean;
export interface El {
  tag: string;
  attrs?: [string, Value][];
  children?: El[];
  text?: string;
}

/** Android attribute resource ids, written to the resource map the way aapt2 does. */
const IDS: Record<string, number> = {
  name: 0x01010003,
  permission: 0x01010006,
  protectionLevel: 0x01010009,
  debuggable: 0x0101000f,
  exported: 0x01010010,
  minSdkVersion: 0x0101020c,
  targetSdkVersion: 0x01010270,
  versionCode: 0x0101021b,
  versionName: 0x0101021c,
  allowBackup: 0x01010280,
  usesCleartextTraffic: 0x010104ec,
};

export function encodeAxml(root: El): Buffer {
  // Attribute names that have ids go first, so their index matches the resource map.
  const attrNames: string[] = [];
  const others: string[] = [];
  const walk = (e: El) => {
    for (const [k, v] of e.attrs ?? []) {
      if (IDS[k] !== undefined && !attrNames.includes(k)) attrNames.push(k);
      else if (IDS[k] === undefined && !others.includes(k)) others.push(k);
      if (typeof v === "string" && !others.includes(v)) others.push(v);
    }
    if (!others.includes(e.tag)) others.push(e.tag);
    if (e.text && !others.includes(e.text)) others.push(e.text);
    e.children?.forEach(walk);
  };
  walk(root);
  const strings = [...attrNames, ...others.filter((s) => !attrNames.includes(s))];
  const idx = (s: string) => strings.indexOf(s);

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

  // String pool (UTF-16).
  const data: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 0;
  for (const s of strings) {
    offsets.push(pos);
    const chunk = Buffer.concat([u16(s.length), Buffer.from(s, "utf16le"), u16(0)]);
    data.push(chunk);
    pos += chunk.length;
  }
  let body = Buffer.concat(data);
  if (body.length % 4) body = Buffer.concat([body, Buffer.alloc(4 - (body.length % 4))]);
  const poolHeader = 28;
  const stringsStart = poolHeader + offsets.length * 4;
  const pool = Buffer.concat([
    u16(0x0001),
    u16(poolHeader),
    u32(stringsStart + body.length),
    u32(strings.length),
    u32(0),
    u32(0),
    u32(stringsStart),
    u32(0),
    ...offsets.map(u32),
    body,
  ]);
  const resMap = Buffer.concat([u16(0x0180), u16(8), u32(8 + attrNames.length * 4), ...attrNames.map((n) => u32(IDS[n]))]);

  const chunks: Buffer[] = [];
  const emit = (e: El) => {
    const attrs = e.attrs ?? [];
    const attrBufs = attrs.map(([k, v]) => {
      let type = 0x03;
      let value = 0;
      let raw = 0xffffffff;
      if (typeof v === "string") {
        value = idx(v);
        raw = idx(v);
      } else if (typeof v === "boolean") {
        type = 0x12;
        value = v ? 0xffffffff : 0;
      } else {
        type = 0x10;
        value = v;
      }
      return Buffer.concat([u32(0xffffffff), u32(idx(k)), u32(raw), u16(8), Buffer.from([0, type]), u32(value)]);
    });
    chunks.push(
      Buffer.concat([
        u16(0x0102),
        u16(16),
        u32(16 + 20 + attrBufs.length * 20),
        u32(1),
        u32(0xffffffff),
        u32(0xffffffff),
        u32(idx(e.tag)),
        u16(20),
        u16(20),
        u16(attrBufs.length),
        u16(0),
        u16(0),
        u16(0),
        ...attrBufs,
      ]),
    );
    if (e.text) chunks.push(Buffer.concat([u16(0x0104), u16(16), u32(28), u32(1), u32(0xffffffff), u32(idx(e.text)), u16(8), Buffer.from([0, 0]), u32(0)]));
    e.children?.forEach(emit);
    chunks.push(Buffer.concat([u16(0x0103), u16(16), u32(24), u32(1), u32(0xffffffff), u32(0xffffffff), u32(idx(e.tag))]));
  };
  emit(root);
  const rest = Buffer.concat([pool, resMap, ...chunks]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + rest.length), rest]);
}

/** A 64-bit ELF header with one LOAD segment aligned to `align` bytes. */
export function elfWithAlign(align: number): Buffer {
  const b = Buffer.alloc(64 + 56);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2; // 64-bit
  b[5] = 1; // little-endian
  b.writeBigUInt64LE(64n, 0x20);
  b.writeUInt16LE(56, 0x36);
  b.writeUInt16LE(1, 0x38);
  b.writeUInt32LE(1, 64); // PT_LOAD
  b.writeBigUInt64LE(BigInt(align), 64 + 0x30);
  return b;
}

/** Fake secrets are assembled at run time so the repository never holds a key-shaped string. */
export const FAKE_AWS_KEY = ["AK", "IA", "QWERTYUIOPASDFGH"].join("");

/**
 * The deliberate problems: a debug build, plain HTTP on, a backup-able old target, an SMS permission,
 * an open content provider, an AWS key and a plain-HTTP IP server in the code, 32-bit-only native code,
 * a debug signing certificate, and a network config that trusts user certificates.
 */
export function buildDemoApk(): Buffer {
  const manifest = encodeAxml({
    tag: "manifest",
    attrs: [
      ["package", "in.glv.demoshop"],
      ["versionCode", 7],
      ["versionName", "1.4.0"],
    ],
    children: [
      { tag: "uses-sdk", attrs: [["minSdkVersion", 21], ["targetSdkVersion", 30]] },
      { tag: "uses-permission", attrs: [["name", "android.permission.INTERNET"]] },
      { tag: "uses-permission", attrs: [["name", "android.permission.READ_SMS"]] },
      { tag: "uses-permission", attrs: [["name", "android.permission.CAMERA"]] },
      {
        tag: "application",
        attrs: [
          ["debuggable", true],
          ["usesCleartextTraffic", true],
          ["networkSecurityConfig", "@xml/network_security_config"],
        ],
        children: [
          {
            tag: "activity",
            attrs: [["name", ".MainActivity"]],
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
          { tag: "provider", attrs: [["name", "in.glv.demoshop.OrdersProvider"], ["exported", true]] },
          { tag: "service", attrs: [["name", "com.google.firebase.MessagingService"], ["exported", true]] },
        ],
      },
    ],
  });
  const nsc = encodeAxml({
    tag: "network-security-config",
    children: [
      {
        tag: "base-config",
        attrs: [["cleartextTrafficPermitted", "true"]],
        children: [{ tag: "trust-anchors", children: [{ tag: "certificates", attrs: [["src", "user"]] }] }],
      },
    ],
  });
  const dex = Buffer.from(
    // Dex strings are a length byte, the text and a zero byte. The AES key is InsecureBank's.
    `dex\n035\0 ... Lin/glv/demoshop/Api; aws=${FAKE_AWS_KEY} http://192.168.1.50:8080/api/orders http://schemas.android.com/apk/res/android https://maps.googleapis.com/` +
      `\x00\x21Ljavax/crypto/spec/SecretKeySpec;\x00\x20This is the super secret key 123\x00\x10Invalid password\x00`,
    "latin1",
  );
  const cert = Buffer.concat([Buffer.from([0x30, 0x82]), Buffer.from("CN=Android Debug, O=Android, C=US", "latin1")]);
  return Buffer.from(
    zipSync({
      "AndroidManifest.xml": manifest,
      "classes.dex": dex,
      "res/xml/network_security_config.xml": [nsc, { level: 0 }],
      "lib/armeabi-v7a/libnative.so": elfWithAlign(0x1000),
      "META-INF/CERT.RSA": cert,
      "META-INF/MANIFEST.MF": Buffer.from("Manifest-Version: 1.0\n"),
    }),
  );
}
