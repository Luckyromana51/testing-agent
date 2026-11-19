import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanSite } from "../runner/scan.js";
import type { LiveSink } from "../live.js";
import type { Journey, Login, ProductType, ProjectTarget, ScanResult } from "../types.js";
import { redact, secretsOf } from "../vault.js";
import { scanApi } from "./api.js";

export interface EngineInput {
  product: ProductType;
  target: ProjectTarget;
  /** The project's saved login, decrypted for this run only. */
  login?: Login;
  /** Agent ids to run. */
  agents?: string[];
  maxPages: number;
  /** Where screenshots and other evidence go. */
  artifactsDir: string;
  /** Where uploaded files (APK, IPA, source zip, API file) are kept. */
  uploadsDir: string;
  /** Scratch space for clones and unpacked files; removed after the run. */
  workDir: string;
  onProgress?: (message: string) => void;
  /** Aborted when the run is cancelled or the server stops. */
  signal?: AbortSignal;
  /** Web tests signed in: gets the session's Cookie header, for the outside tools. */
  onSession?: (cookie: string) => void;
  /** Web tests: how many pages to test at the same time. */
  parallel?: number;
  /** Web tests: where the live screens go. */
  live?: LiveSink;
  /** Web tests: record the inspect screen. */
  inspect?: boolean;
  /** Web tests: the project's approved pictures, for visual compare. */
  baselineDir?: string;
  /** Web tests: user journeys to follow. */
  journeys?: Journey[];
  /** Web tests: the test mailbox (Mailpit) address, when the mail module is on. */
  mailUrl?: string;
}

/** Full path of an uploaded file, refusing names that try to leave the uploads folder. */
export function uploadedPath(uploadsDir: string, file: string): string {
  const name = path.basename(file);
  if (!name || name !== file) throw new Error("Bad upload name.");
  return path.join(uploadsDir, name);
}

/**
 * Picks the test engine for the product and runs it. Any secret from the login that shows up in
 * the result or in an error (a page that prints a token, for example) is replaced with [hidden].
 */
export async function runEngine(input: EngineInput): Promise<ScanResult> {
  const secrets = secretsOf(input.login, input.target.repoUrl);
  const onProgress = input.onProgress && ((m: string) => input.onProgress!(redact(m, secrets)));
  try {
    return redact(await pickEngine({ ...input, onProgress }), secrets);
  } catch (err) {
    throw new Error(redact((err as Error).message, secrets));
  }
}

async function pickEngine(input: EngineInput): Promise<ScanResult> {
  const { product, target, agents, login, onProgress } = input;
  switch (product) {
    case "api":
      return scanApi({
        specUrl: target.specUrl,
        specText: target.file ? await readFile(uploadedPath(input.uploadsDir, target.file), "utf8") : undefined,
        baseUrl: target.url,
        auth: login?.kind === "api" ? login : undefined,
        agents,
        onProgress,
      });
    case "code": {
      const { scanCode } = await import("./code.js");
      return scanCode({
        repoUrl: target.repoUrl,
        branch: target.branch,
        gitLogin: login?.kind === "git" ? login : undefined,
        zipFile: target.file ? uploadedPath(input.uploadsDir, target.file) : undefined,
        workDir: input.workDir,
        agents,
        onProgress,
        signal: input.signal,
      });
    }
    case "android": {
      if (!target.file) throw new Error("Upload the APK file to test.");
      const { scanApk } = await import("./apk.js");
      return scanApk({ apkFile: uploadedPath(input.uploadsDir, target.file), fileName: target.fileName, agents, onProgress });
    }
    case "ios": {
      if (!target.file) throw new Error("Upload the iOS app (.ipa, or a zip of the .app) to test.");
      const { scanIpa } = await import("./ipa.js");
      return scanIpa({ ipaFile: uploadedPath(input.uploadsDir, target.file), fileName: target.fileName, agents, onProgress });
    }
    default:
      return scanSite({
        url: target.url ?? "",
        maxPages: input.maxPages,
        product,
        agents,
        login: login?.kind === "web" ? login : undefined,
        artifactsDir: input.artifactsDir,
        onProgress,
        signal: input.signal,
        onSession: input.onSession,
        parallel: input.parallel,
        live: input.live,
        inspect: input.inspect,
        baselineDir: input.baselineDir,
        journeys: input.journeys,
        mailUrl: input.mailUrl,
      });
  }
}
