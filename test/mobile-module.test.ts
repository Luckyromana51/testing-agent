import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { arscStringCounts, assetLinksProblem, cycloneDx } from "../src/agents/mobile/android-extra.ts";
import { aasaProblem, stringsCount } from "../src/agents/mobile/ios-extra.ts";
import { androidSdks } from "../src/agents/mobile/sdks.ts";
import { compareApps, ownServers } from "../src/agents/mobile/shared.ts";
import { parseAndroidXml, parseProtoXml } from "../src/engines/aab.ts";
import { scanApk } from "../src/engines/apk.ts";
import { scanIpa } from "../src/engines/ipa.ts";
import { fixFor } from "../src/fixes.ts";
import type { ScanResult } from "../src/types.ts";
import { buildDemoApk, encodeAxml } from "./fixtures/demo-apk.ts";
import { arsc, buildDemoAab, buildRichApk, buildRichIpa, buildSplitSet, protoXml } from "./fixtures/demo-mobile.ts";

const rules = (r: ScanResult) => new Set(r.findings.map((f) => f.rule));

describe("mobile module: app bundles and split sets", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-mobile-"));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("reads aapt2's protocol-buffer XML like binary XML", () => {
    const tree = { tag: "manifest", attrs: [["package", "a.b"], ["versionCode", 3], ["debuggable", true]] as [string, string | number | boolean][], children: [{ tag: "x", text: "hi" }] };
    const node = parseProtoXml(protoXml(tree));
    assert.equal(node.attrs.package, "a.b");
    assert.equal(node.attrs.versionCode, 3);
    assert.equal(node.attrs.debuggable, true);
    assert.equal(node.children[0].text, "hi");
    assert.deepEqual(parseAndroidXml(encodeAxml(tree)).attrs.package, "a.b", "binary XML still works");
  });

  it("tests an .aab bundle with the Android checks, and does not ask a bundle for v2 signing", async () => {
    await writeFile(path.join(dir, "app.aab"), buildDemoAab());
    const r = await scanApk({ apkFile: path.join(dir, "app.aab"), fileName: "app.aab" });
    const found = rules(r);
    for (const rule of ["android:debuggable", "android:debug-signed", "android:cleartext", "android:open-provider", "android:16kb-pages", "android:http-backend"]) assert.ok(found.has(rule), `expected ${rule}`);
    assert.ok(!found.has("android:v1-only"), "a bundle is signed with the upload key only");
    assert.ok(r.notes?.some((n) => /Android App Bundle/.test(n) && /dynamic_feature/.test(n)));
    assert.equal(r.app?.packaging, "aab");
  });

  it("tests a split set's base APK with the libraries from its processor splits", async () => {
    await writeFile(path.join(dir, "app.apks"), buildSplitSet());
    const r = await scanApk({ apkFile: path.join(dir, "app.apks") });
    const found = rules(r);
    assert.ok(found.has("android:debuggable"));
    assert.ok(found.has("android:16kb-pages"), "the arm64 split's library is checked");
    assert.ok(r.notes?.some((n) => /split set with 2 APKs/.test(n)));
  });
});

describe("mobile module: new Android checks", () => {
  let dir: string;
  let planted: ScanResult;
  let clean: ScanResult;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-mobile-"));
    await writeFile(path.join(dir, "rich.apk"), buildRichApk());
    await writeFile(path.join(dir, "clean.apk"), buildRichApk({ clean: true }));
    planted = await scanApk({ apkFile: path.join(dir, "rich.apk"), artifactsDir: path.join(dir, "art") });
    clean = await scanApk({ apkFile: path.join(dir, "clean.apk") });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("finds every planted problem", () => {
    const found = rules(planted);
    for (const rule of [
      "android:trust-all-certs",
      "android:weak-cipher",
      "android:dynamic-code",
      "android:fileprovider-wide",
      "android:trackers",
      "android:ad-id-missing",
      "app:flutter-debug",
      "app:test-servers",
      "android:exported-missing",
      "android:app-links-broken",
      "app:big-pictures",
      "app:duplicate-files",
      "app:partial-translation",
    ]) assert.ok(found.has(rule), `expected ${rule}`);
    const links = planted.findings.find((f) => f.rule === "android:app-links-broken")!;
    assert.match(links.evidence ?? "", /links\.richshop\.invalid: not a real web address/);
    assert.match(planted.findings.find((f) => f.rule === "app:partial-translation")!.evidence ?? "", /Hindi: 12 of 20 texts/);
    assert.doesNotMatch(planted.findings.find((f) => f.rule === "app:partial-translation")!.evidence ?? "", /French/, "a library's 3 French texts are not the app's");
    for (const f of planted.findings) assert.notEqual(fixFor(f).steps, f.detail, `${f.rule} has a written fix`);
  });

  it("finds none of them in the same app done right", () => {
    const newRules = [...rules(clean)].filter((r) => /^(app:|android:(trust|weak|dynamic|fileprovider|trackers|ad-id|exported-missing|app-links|links|not-shrunk|no-icon|no-label))/.test(r));
    assert.deepEqual(newRules, []);
  });

  it("describes the app: framework, SDKs, libraries, servers, languages, and saves a CycloneDX list", async () => {
    const a = planted.app!;
    assert.equal(a.platform, "android");
    assert.equal(a.framework, "Flutter");
    assert.deepEqual(a.sdks.map((s) => s.id).sort(), ["admob", "appsflyer"]);
    assert.ok(a.libraries.some((l) => l.purl === "pkg:maven/androidx.core/core@1.12.0"));
    assert.ok(a.libraries.some((l) => l.purl === "pkg:maven/org.jetbrains.kotlinx/kotlinx-coroutines-core@1.7.3"));
    assert.ok(a.libraries.some((l) => l.purl === "pkg:maven/com.squareup.okhttp3/okhttp@4.9.0"));
    assert.deepEqual(a.servers, ["api.richshop.in", "staging-api.richshop.in"]);
    assert.deepEqual(a.languages, ["hi", "ta"]);
    assert.deepEqual(a.links, ["links.richshop.invalid"]);
    const bom = JSON.parse(await readFile(path.join(dir, "art", "app-sbom.cdx.json"), "utf8"));
    assert.equal(bom.bomFormat, "CycloneDX");
    assert.ok(bom.components.length >= 3);
  });

  it("lists what changed since the last upload", async () => {
    await writeFile(path.join(dir, "v2.apk"), buildRichApk({ version: "2.1.0", extraPermission: "android.permission.CAMERA" }));
    const r = await scanApk({ apkFile: path.join(dir, "v2.apk"), previous: { app: { ...planted.app!, sdks: planted.app!.sdks.filter((s) => s.id !== "appsflyer") }, at: "2026-11-01T10:00:00Z" } });
    const lines = r.app?.changes?.lines ?? [];
    assert.ok(lines.includes("Version 2.0.0 (20) → 2.1.0 (21)"), lines.join(" | "));
    assert.ok(lines.some((l) => l === "New permissions: CAMERA"));
    assert.ok(lines.some((l) => l === "New SDKs: AppsFlyer"));
    assert.ok(rules(r).has("app:new-permissions"));
    assert.ok(rules(r).has("app:new-trackers"));
  });
});

describe("mobile module: new iOS checks", () => {
  let dir: string;
  let r: ScanResult;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-mobile-"));
    await writeFile(path.join(dir, "rich.ipa"), buildRichIpa());
    r = await scanIpa({ ipaFile: path.join(dir, "rich.ipa"), artifactsDir: path.join(dir, "art") });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it("finds every planted problem", () => {
    const found = rules(r);
    for (const rule of ["ios:keychain-always", "ios:att-missing", "ios:trackers", "app:rn-dev-bundle", "app:source-maps", "app:partial-translation", "ios:universal-links-broken", "app:test-servers", "ios:no-launch-screen"]) assert.ok(found.has(rule), `expected ${rule}`);
    assert.ok(!found.has("ios:no-stack-canary"));
    assert.match(r.findings.find((f) => f.rule === "ios:universal-links-broken")!.evidence ?? "", /applinks|links\.richshop\.invalid/);
    for (const f of r.findings) assert.notEqual(fixFor(f).steps, f.detail, `${f.rule} has a written fix`);
  });

  it("describes the app", () => {
    const a = r.app!;
    assert.equal(a.framework, "React Native");
    assert.deepEqual(a.sdks.map((s) => s.id), ["appsflyer"]);
    assert.deepEqual(a.libraries.map((l) => `${l.name}@${l.version}`), ["AppsFlyerLib@6.15.0", "React@0.76.1"]);
    assert.deepEqual(a.languages, ["en", "hi"]);
    assert.deepEqual(a.links, ["links.richshop.invalid"]);
    assert.ok(existsSync(path.join(dir, "art", "app-sbom.cdx.json")));
  });
});

describe("mobile module: helpers", () => {
  it("checks assetlinks.json and apple-app-site-association files", () => {
    const fp = "AA:BB";
    const good = [{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "a.b", sha256_cert_fingerprints: ["aa:bb"] } }];
    assert.equal(assetLinksProblem(good, "a.b", fp), null);
    assert.match(assetLinksProblem(good, "x.y", fp)!, /does not list x\.y/);
    assert.match(assetLinksProblem(good, "a.b", "CC:DD")!, /fingerprint/);
    assert.match(assetLinksProblem({}, "a.b", fp)!, /not a JSON list/);
    assert.equal(aasaProblem({ applinks: { details: [{ appIDs: ["T1.a.b"] }] } }, "T1.a.b", "a.b"), null);
    assert.equal(aasaProblem({ applinks: { details: [{ appID: "T1.a.b", paths: ["*"] }] } }, "T1.a.b", "a.b"), null);
    assert.match(aasaProblem({ applinks: { details: [{ appIDs: ["T2.a.b"] }] } }, "T1.a.b", "a.b")!, /signed by team T1/);
  });

  it("counts translated texts in resources.arsc and .strings files", () => {
    const counts = arscStringCounts(arsc({ "": 10, hi: 4 }, 10));
    assert.equal(counts.get(""), 10);
    assert.equal(counts.get("hi"), 4);
    assert.equal(stringsCount(Buffer.from('"a" = "A";\n"b" = "B \\"x\\"";\n/* c */')), 2);
  });

  it("finds SDKs by package path, and the app's own servers", () => {
    assert.deepEqual(androidSdks(["Lcom/appsflyer/AppsFlyerLib; Lcom/razorpay/Checkout;"]).map((s) => s.id), ["appsflyer", "razorpay"]);
    assert.deepEqual(ownServers("in.glv.richshop", [{ file: "classes.dex", text: "https://api.richshop.in/x https://www.googleapis.com/y https://example.org", config: false }]), ["api.richshop.in"]);
    assert.deepEqual(ownServers("in.glv.richshop", [{ file: "assets/config.json", text: '"https://backend.acme.co/v1" "https://fonts.googleapis.com"', config: true }]), ["backend.acme.co"]);
  });

  it("writes a CycloneDX list and compares versions", () => {
    const bom = JSON.parse(cycloneDx({ id: "a.b", version: "1" }, [{ name: "g:a", version: "1.0", purl: "pkg:maven/g/a@1.0" }]));
    assert.equal(bom.components[0].purl, "pkg:maven/g/a@1.0");
    const base = { platform: "android" as const, id: "a.b", packaging: "apk", size: 1000, framework: "Native", permissions: [], sdks: [], libraries: [], servers: [], languages: [], links: [], version: "1", build: "1" };
    assert.deepEqual(compareApps(base, { ...base }, "today").lines, ["Same version and build number as last time: stores refuse an upload that does not raise the build number."]);
    assert.match(compareApps(base, { ...base, id: "c.d" }, "today").lines[0], /different app/);
  });

  it("still reads the demo APK the same way", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-mobile-"));
    try {
      await writeFile(path.join(dir, "demo.apk"), buildDemoApk());
      const r = await scanApk({ apkFile: path.join(dir, "demo.apk") });
      assert.equal(r.app?.id, "in.glv.demoshop");
      assert.equal(r.app?.packaging, "apk");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
