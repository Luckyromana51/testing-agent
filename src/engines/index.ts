import { readFile } from "node:fs/promises";
import path from "node:path";
import { scanSite } from "../runner/scan.js";
import type { ProductType, ProjectTarget, ScanResult } from "../types.js";
import { scanApi } from "./api.js";

export interface EngineInput {
  product: ProductType;
  target: ProjectTarget;
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
}

/** Full path of an uploaded file, refusing names that try to leave the uploads folder. */
export function uploadedPath(uploadsDir: string, file: string): string {
  const name = path.basename(file);
  if (!name || name !== file) throw new Error("Bad upload name.");
  return path.join(uploadsDir, name);
}

/** Picks the test engine for the product and runs it. */
export async function runEngine(input: EngineInput): Promise<ScanResult> {
  const { product, target, agents, onProgress } = input;
  switch (product) {
    case "api":
      return scanApi({
        specUrl: target.specUrl,
        specText: target.file ? await readFile(uploadedPath(input.uploadsDir, target.file), "utf8") : undefined,
        baseUrl: target.url,
        agents,
        onProgress,
      });
    case "code": {
      const { scanCode } = await import("./code.js");
      return scanCode({
        repoUrl: target.repoUrl,
        branch: target.branch,
        zipFile: target.file ? uploadedPath(input.uploadsDir, target.file) : undefined,
        workDir: input.workDir,
        agents,
        onProgress,
      });
    }
    case "android": {
      if (!target.file) throw new Error("Upload the APK file to test.");
      const { scanApk } = await import("./apk.js");
      return scanApk({ apkFile: uploadedPath(input.uploadsDir, target.file), fileName: target.fileName, agents, onProgress });
    }
    case "ios":
      throw new Error("iOS app testing is not available yet.");
    default:
      return scanSite({
        url: target.url ?? "",
        maxPages: input.maxPages,
        product,
        agents,
        artifactsDir: input.artifactsDir,
        onProgress,
      });
  }
}
