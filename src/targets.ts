import { existsSync } from "node:fs";
import { uploadedPath } from "./engines/index.js";
import { validateRepoUrl } from "./engines/code.js";
import { validateTarget } from "./runner/urls.js";
import type { ProductType, ProjectTarget } from "./types.js";
import { WEB_PRODUCTS } from "./products.js";

export interface TargetInput {
  url?: string;
  specUrl?: string;
  repoUrl?: string;
  branch?: string;
  file?: string;
  fileName?: string;
  maxPages?: number;
  checkLinks?: boolean;
}

/** Which uploaded file types each product takes. */
export const UPLOAD_TYPES: Record<string, RegExp> = {
  api: /\.(json|ya?ml)$/i,
  code: /\.zip$/i,
  android: /\.apk$/i,
  ios: /\.ipa$/i,
};

const clean = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Builds a project's target from what the tester entered, checking each part.
 * `prev` is the current target when editing; fields left out keep their value.
 */
export function buildTarget(type: ProductType, input: TargetInput, uploadsDir: string, defaultMaxPages: number, prev: ProjectTarget = {}): ProjectTarget {
  const t: ProjectTarget = { ...prev };
  const set = <K extends keyof TargetInput>(k: K) => input[k] !== undefined;

  if (set("file")) {
    const file = clean(input.file);
    if (file) {
      const full = uploadedPath(uploadsDir, file);
      if (!existsSync(full)) throw new Error("The uploaded file was not found. Upload it again.");
      if (UPLOAD_TYPES[type] && !UPLOAD_TYPES[type].test(file)) throw new Error("That file type does not fit this product.");
      t.file = file;
      t.fileName = clean(input.fileName).slice(0, 200) || file;
    } else {
      delete t.file;
      delete t.fileName;
    }
  }

  if (WEB_PRODUCTS.includes(type)) {
    if (set("url") || !t.url) t.url = validateTarget(clean(input.url));
    if (set("maxPages") || t.maxPages === undefined) t.maxPages = Math.min(Math.max(Number(input.maxPages) || defaultMaxPages, 1), 200);
    if (set("checkLinks") || t.checkLinks === undefined) t.checkLinks = input.checkLinks !== false;
    return t;
  }

  if (type === "api") {
    if (set("specUrl")) {
      const spec = clean(input.specUrl);
      if (spec) t.specUrl = validateTarget(spec);
      else delete t.specUrl;
    }
    if (set("url")) {
      const url = clean(input.url);
      if (url) t.url = validateTarget(url).replace(/\/$/, "");
      else delete t.url;
    }
    if (!t.specUrl && !t.file) throw new Error("Enter the address of the OpenAPI (Swagger) file, or upload it.");
    return t;
  }

  if (type === "code") {
    if (set("repoUrl")) {
      const repo = clean(input.repoUrl);
      if (repo) t.repoUrl = validateRepoUrl(repo);
      else delete t.repoUrl;
    }
    if (set("branch")) {
      const branch = clean(input.branch);
      if (branch && (!/^[\w./-]{1,100}$/.test(branch) || branch.startsWith("-") || branch.includes(".."))) {
        throw new Error("That branch name has characters Git does not allow.");
      }
      if (branch) t.branch = branch;
      else delete t.branch;
    }
    if (!t.repoUrl && !t.file) throw new Error("Enter the repository address, or upload a zip of the code.");
    return t;
  }

  if (type === "android" || type === "ios") {
    if (!t.file) throw new Error(`Upload the ${type === "android" ? "APK" : "IPA"} file to test.`);
    return t;
  }
  return t;
}

/** A readable default name for a new project. */
export function defaultName(type: ProductType, t: ProjectTarget): string {
  try {
    if (t.repoUrl) return new URL(t.repoUrl).pathname.split("/").filter(Boolean).slice(-1)[0]?.replace(/\.git$/, "") || "Code";
    if (t.specUrl) return `${new URL(t.specUrl).hostname.replace(/^www\./, "")} API`;
    if (t.url) return new URL(t.url).hostname.replace(/^www\./, "");
  } catch {
    /* fall through */
  }
  if (t.fileName) return t.fileName.replace(/\.(apk|ipa|zip|json|ya?ml)$/i, "");
  return type;
}
