import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { atsPolicy, declaredReasons, PURPOSES, vaguePurpose } from "../src/agents/mobile/ios.ts";
import { scanIpa } from "../src/engines/ipa.ts";
import { dylibName, parseMachO } from "../src/engines/macho.ts";
import { parseBinaryPlist, parsePlist, parseXmlPlist } from "../src/engines/plist.ts";
import { fixFor } from "../src/fixes.ts";
import type { ScanResult } from "../src/types.ts";
import { appStoreIpa, binaryPlist, cleanIpa, fatMachO, machO, plantedIpa, simulatorAppZip, xmlPlist, zipIpa } from "./fixtures/demo-ipa.ts";

describe("iOS file formats", () => {
  it("reads XML plists, with entities, data, dates and nesting", () => {
    const v = parseXmlPlist(`<?xml version="1.0"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- a comment -->
<plist version="1.0"><dict>
  <key>Name</key><string>Fish &amp; Chips &lt;3 &#x263A;</string>
  <key>Empty</key><string/>
  <key>On</key><true/><key>Off</key><false/>
  <key>Count</key><integer>42</integer><key>Ratio</key><real>1.5</real>
  <key>When</key><date>2026-11-18T10:00:00Z</date>
  <key>Blob</key><data>aGVs
  bG8=</data>
  <key>List</key><array><string>a</string><dict><key>x</key><integer>1</integer></dict><array/></array>
</dict></plist>`);
    assert.deepEqual(v, {
      Name: "Fish & Chips <3 ☺",
      Empty: "",
      On: true,
      Off: false,
      Count: 42,
      Ratio: 1.5,
      When: new Date("2026-11-18T10:00:00Z"),
      Blob: Buffer.from("hello"),
      List: ["a", { x: 1 }, []],
    });
    assert.throws(() => parseXmlPlist("<plist><dict><string>no key</string></dict></plist>"), /<key>/);
  });

  it("reads binary plists the way Xcode writes them, and refuses damaged ones", () => {
    const value = {
      CFBundleIdentifier: "in.glvshop.app",
      Long: "a string longer than fifteen characters",
      Hindi: "दुकान",
      Build: 41,
      Big: 5_000_000_000,
      On: true,
      When: new Date("2026-01-02T03:04:05Z"),
      Blob: Buffer.from([1, 2, 3]),
      Nested: [{ Key: ["x", "y"] }, false],
    };
    const bin = binaryPlist(value);
    assert.equal(bin.subarray(0, 8).toString(), "bplist00");
    assert.deepEqual(parsePlist(bin), value);
    assert.deepEqual(parsePlist(xmlPlist(value)), value);
    assert.throws(() => parseBinaryPlist(bin.subarray(0, bin.length - 10)), /Damaged|binary plist/);
    // A dictionary that contains itself.
    const loop = Buffer.from(bin);
    const t = loop.length - 32;
    const tableAt = Number(loop.readBigUInt64BE(t + 24));
    const firstObject = loop.readUInt32BE(tableAt);
    loop[firstObject + 1 + 2 * Object.keys(value).length] = 0;
    loop[firstObject + 2 + 2 * Object.keys(value).length] = 0;
    assert.throws(() => parseBinaryPlist(loop), /refers to itself|nests/);
  });

  it("reads the program's headers: processors, platform, encryption, PIE and libraries", () => {
    const thin = parseMachO(machO({ minOS: [16, 4], dylibs: ["/System/Library/Frameworks/CoreLocation.framework/CoreLocation", "@rpath/Alamofire.framework/Alamofire"] }));
    assert.deepEqual(thin.slices[0], {
      arch: "arm64",
      platform: "ios",
      minOS: "16.4",
      sdk: "18.0",
      pie: true,
      encrypted: false,
      signed: true,
      dylibs: ["/System/Library/Frameworks/CoreLocation.framework/CoreLocation", "@rpath/Alamofire.framework/Alamofire"],
    });
    const fat = parseMachO(fatMachO([machO({ encrypted: true }), machO({ arch: "x86_64", platform: 7, pie: false, signed: false })]));
    assert.deepEqual(
      fat.slices.map((s) => `${s.arch} ${s.platform} enc=${s.encrypted} pie=${s.pie} signed=${s.signed}`),
      ["arm64 ios enc=true pie=true signed=true", "x86_64 ios-simulator enc=false pie=false signed=false"],
    );
    assert.equal(dylibName("@rpath/Alamofire.framework/Alamofire"), "Alamofire");
    assert.equal(dylibName("/usr/lib/libz.1.dylib"), "libz.1");
    assert.throws(() => parseMachO(Buffer.alloc(64)), /not an iOS program/);
  });

  it("tells a purpose text that says why from one that does not", () => {
    for (const t of ["Camera access", "This app needs access to your camera.", "We need your location", "Allow camera", "TODO write this purpose text later"]) assert.ok(vaguePurpose(t), t);
    for (const t of ["Your camera is used to scan the bar code on your order.", "Your location is used to show the stores near you.", "This lets us show you offers from shops you like."]) assert.ok(!vaguePurpose(t), t);
  });

  it("follows iOS's App Transport Security rules", () => {
    assert.equal(atsPolicy({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } }).all, true);
    // From iOS 10, any of these makes iOS ignore NSAllowsArbitraryLoads.
    const ignored = atsPolicy({ NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsArbitraryLoadsInWebContent: true } });
    assert.equal(ignored.all, false);
    assert.equal(ignored.webContent, true);
    const ex = atsPolicy({ NSAppTransportSecurity: { NSExceptionDomains: { "a.example": { NSTemporaryExceptionAllowsInsecureHTTPLoads: true, NSIncludesSubdomains: true }, localhost: { NSExceptionAllowsInsecureHTTPLoads: true }, "b.example": { NSExceptionMinimumTLSVersion: "TLSv1.1" }, "c.example": { NSExceptionMinimumTLSVersion: "TLSv1.2" } } } });
    assert.deepEqual(ex.insecure, ["a.example (and its subdomains)"]);
    assert.deepEqual(ex.oldTls, ["b.example: TLSv1.1"]);
    assert.deepEqual([...declaredReasons({ NSPrivacyAccessedAPITypes: [{ NSPrivacyAccessedAPIType: "A", NSPrivacyAccessedAPITypeReasons: ["X1.1"] }, { NSPrivacyAccessedAPIType: "B", NSPrivacyAccessedAPITypeReasons: [] }] })], ["A"]);
  });
});

describe("iOS app tests", () => {
  let dir: string;
  const scan = async (name: string, buf: Buffer): Promise<ScanResult> => {
    const file = path.join(dir, name);
    await writeFile(file, buf);
    return scanIpa({ ipaFile: file, fileName: name });
  };
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glvios-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds every planted problem, and none of the traps", async () => {
    const r = await scan("GLV Shop.ipa", plantedIpa());
    const got = r.findings.map((f) => `${f.rule} ${f.severity}`).sort();
    assert.deepEqual(got, [
      "ios:ats-http-domains low",
      "ios:ats-off medium",
      "ios:ats-old-tls medium",
      "ios:debug-build high",
      "ios:export-compliance info",
      "ios:file-sharing low",
      "ios:http-backend medium",
      "ios:missing-purpose high",
      "ios:missing-purpose high",
      "ios:no-privacy-manifest high",
      "ios:profile-expiring medium",
      "ios:sdk-privacy-manifest medium",
      "ios:secret-aws-key critical",
      "ios:uiwebview high",
      "ios:url-schemes info",
      "ios:vague-purpose low",
    ]);
    const one = (rule: string) => r.findings.filter((f) => f.rule === rule);
    assert.deepEqual(one("ios:missing-purpose").map((f) => f.title).sort(), ["The app asks for location but has no purpose text for it", "The app asks for tracking across other companies' apps but has no purpose text for it"]);
    assert.match(one("ios:missing-purpose")[0].evidence!, /Called in GLVShop; missing NS/);
    // UserDefaults and the boot clock are used; "_status" is not the file-date function "_stat".
    assert.equal(one("ios:no-privacy-manifest")[0].evidence, "NSPrivacyAccessedAPICategoryUserDefaults (UserDefaults)\nNSPrivacyAccessedAPICategorySystemBootTime (time since the phone started)");
    assert.equal(one("ios:sdk-privacy-manifest")[0].evidence, "Alamofire");
    assert.equal(one("ios:ats-http-domains")[0].evidence, "legacy.glvshop.in (and its subdomains)");
    assert.equal(one("ios:ats-old-tls")[0].evidence, "pay.oldbank.example: TLSv1.0");
    assert.equal(one("ios:url-schemes")[0].evidence, "glvshop://");
    assert.equal(one("ios:vague-purpose")[0].evidence, 'NSCameraUsageDescription: "Camera access"');
    assert.equal(one("ios:secret-aws-key")[0].evidence, "AKIA***45");
    assert.equal(one("ios:secret-aws-key")[0].pageUrl, "Payload/GLV Shop.app/config.json");
    assert.equal(one("ios:http-backend")[0].evidence, "api.glvshop.in");
    assert.match(one("ios:profile-expiring")[0].title, /expires in 10 days/);
    assert.equal(r.incomplete, undefined);
    assert.equal(r.startUrl, "in.glvshop.app 2.3.0");
    assert.ok(r.notes?.some((n) => /GLV Shop: in\.glvshop\.app version 2\.3\.0 \(41\), minimum iOS 15\.0, arm64/.test(n)));
    assert.ok(r.notes?.some((n) => /1 app extension .*Widget/.test(n)));
    assert.ok(r.notes?.some((n) => /runs only on the 2 devices/.test(n)));
    // Every rule has a written fix, and the fix shows the key that is missing, in Swift for app keys.
    for (const f of r.findings) assert.notEqual(fixFor(f).steps, f.detail, f.rule);
    assert.deepEqual(one("ios:missing-purpose").map((f) => fixFor(f).code![0].snippet.match(/<key>(\w+)<\/key>/)![1]).sort(), ["NSLocationWhenInUseUsageDescription", "NSUserTrackingUsageDescription"]);
    assert.equal(fixFor(one("ios:secret-aws-key")[0]).code![0].label, "Swift");
  });

  it("gives an example purpose text for every key it asks for, and each one says why", () => {
    for (const p of PURPOSES) {
      const fix = fixFor({ rule: "ios:missing-purpose", detail: `Info.plist has no ${p.keys[0]}. iOS closes the app.` });
      const text = fix.code![0].snippet.match(/<string>(.*)<\/string>/)![1];
      assert.ok(fix.code![0].snippet.includes(`<key>${p.keys[0]}</key>`), p.keys[0]);
      assert.ok(!text.startsWith("Say here") && !vaguePurpose(text), `${p.keys[0]}: ${text}`);
    }
  });

  it("finds nothing in the same app done right", async () => {
    const r = await scan("clean.ipa", cleanIpa());
    assert.deepEqual(r.findings.map((f) => `${f.rule}: ${f.evidence}`), []);
    assert.equal(r.incomplete, undefined);
    assert.ok(r.agentStats?.every((s) => !s.untested));
  });

  it("says what it could not check in the App Store's encrypted copy", async () => {
    const r = await scan("from-store.ipa", appStoreIpa());
    assert.deepEqual(r.findings.map((f) => f.rule).sort(), ["ios:secret-aws-key", "ios:vague-purpose"]);
    assert.equal(r.incomplete?.length, 4);
    for (const line of r.incomplete!) assert.match(line, /encrypted \(this is the copy the App Store hands out\)/);
    assert.ok(r.notes?.some((n) => /No provisioning profile inside/.test(n)));
  });

  it("reads a zipped Simulator build, which a Mac can run", async () => {
    const r = await scan("GLV Shop.zip", simulatorAppZip());
    assert.deepEqual(r.findings, []);
    assert.ok(r.notes?.some((n) => /This is a Simulator build/.test(n)));
  });

  it("explains what to upload when the file is not an app", async () => {
    await assert.rejects(scan("notes.ipa", zipIpa({ "notes.txt": Buffer.from("hi") })), /not an iOS app/);
    await assert.rejects(scan("Shop.xcarchive.zip", zipIpa({ "Shop.xcarchive/Info.plist": xmlPlist({}) })), /Xcode archive/);
  });
});
