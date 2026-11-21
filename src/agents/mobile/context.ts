import type { APIRequestContext } from "playwright";
import type { XmlNode } from "../../engines/axml.js";
import type { ZipEntry } from "../../engines/zip.js";
import type { AppSummary } from "../../types.js";

export interface AndroidComponent {
  kind: "activity" | "activity-alias" | "service" | "receiver" | "provider";
  name: string;
  exported: boolean;
  /** Set explicitly in the manifest (not the old default). */
  exportedExplicit: boolean;
  permission?: string;
  readPermission?: string;
  writePermission?: string;
  actions: string[];
  categories: string[];
  schemes: string[];
  /** Web addresses (hosts) the component opens, from its intent filters. */
  hosts: string[];
  /** An intent filter asks Android to verify these links (App Links). */
  autoVerify: boolean;
}

export interface ApkFacts {
  packageName: string;
  versionName?: string;
  versionCode?: number;
  minSdk?: number;
  targetSdk?: number;
  debuggable: boolean;
  testOnly: boolean;
  /** undefined when the manifest does not say (the default applies). */
  allowBackup?: boolean;
  hasBackupRules: boolean;
  usesCleartextTraffic?: boolean;
  permissions: string[];
  /** Permissions the app defines itself, with their protection level number. */
  definedPermissions: Map<string, number>;
  components: AndroidComponent[];
  /** The parsed network security config, when the app has one. */
  networkConfig?: { node: XmlNode; file: string };
  /** An APK, an app bundle (.aab) or a split set (.apks, .xapk). */
  packaging?: "apk" | "aab" | "apks";
  /** The application element has an icon / a label. */
  hasIcon?: boolean;
  hasLabel?: boolean;
}

export interface ApkContext {
  /** The whole APK file. */
  apk: Buffer;
  entries: ZipEntry[];
  manifest: XmlNode;
  facts: ApkFacts;
  /** Text from the code (classes*.dex), the JavaScript bundle and app libraries, for string searches. */
  strings: { file: string; text: string }[];
  request: APIRequestContext;
  log: (m: string) => void;
  note: (m: string) => void;
  /** What the app is made of; agents fill it in for the report and the next upload's compare. */
  summary: AppSummary;
}
