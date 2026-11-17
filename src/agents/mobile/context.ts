import type { APIRequestContext } from "playwright";
import type { XmlNode } from "../../engines/axml.js";
import type { ZipEntry } from "../../engines/zip.js";

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
}
