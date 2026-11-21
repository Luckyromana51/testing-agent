import type { APIRequestContext } from "playwright";
import type { MachOInfo } from "../../engines/macho.js";
import type { PlistDict } from "../../engines/plist.js";
import type { ZipEntry } from "../../engines/zip.js";
import type { AppSummary } from "../../types.js";

export interface IosFacts {
  bundleId: string;
  name: string;
  version?: string;
  build?: string;
  minOS?: string;
  /** The app folder inside the zip, like "Payload/Shop.app/". */
  appDir: string;
  /** The main program's path inside the zip. */
  executable: string;
  /** An App Store or Xcode export (Payload/), or a zipped .app (usually a Simulator build). */
  packaging: "ipa" | "app";
  /** Built for the iOS Simulator rather than iPhones and iPads. */
  simulator: boolean;
  /** The App Store's encrypted copy: the code cannot be searched. */
  encrypted: boolean;
}

export interface IosFramework {
  /** "Alamofire", "FirebaseCore", "App" (Flutter) and so on. */
  name: string;
  /** Its folder inside the zip, ending in "/". */
  dir: string;
  hasPrivacyManifest: boolean;
  /** Its program file inside the zip. */
  binary?: string;
}

export interface IosContext {
  ipa: Buffer;
  entries: ZipEntry[];
  facts: IosFacts;
  /** The app's Info.plist. */
  info: PlistDict;
  /** The embedded provisioning profile (Xcode exports have one; App Store downloads and Simulator builds do not). */
  profile?: PlistDict;
  /** The app's own privacy manifest (PrivacyInfo.xcprivacy). */
  privacy?: PlistDict;
  /** Headers of the main program. */
  binary?: MachOInfo;
  /**
   * The text of every program file whose code can be read (the app and its frameworks), for symbol
   * and selector searches. Empty when the App Store encryption hides the code.
   */
  programs: { file: string; text: string }[];
  frameworks: IosFramework[];
  /** Text from the app's code and config files, for key and server searches. */
  strings: { file: string; text: string }[];
  request: APIRequestContext;
  log: (m: string) => void;
  note: (m: string) => void;
  /** The entitlements signed into the main program (associated domains, team), when they could be read. */
  entitlements?: PlistDict;
  /** What the app is made of; agents fill it in for the report and the next upload's compare. */
  summary: AppSummary;
}
