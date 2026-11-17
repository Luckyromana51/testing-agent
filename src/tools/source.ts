import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import { SKIP_DIRS } from "../engines/code.js";
import { uploadedPath } from "../engines/index.js";
import type { ProductType, ProjectTarget } from "../types.js";

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 20_000_000;
const MAX_TOTAL_BYTES = 300_000_000;

/**
 * Unpacks an uploaded zip of code for the code tools, which read files from disk. Entries that
 * try to leave the folder ("../", absolute paths) are refused, installed packages and build
 * output are left out (as in the platform's own code test), and the size is capped.
 * Returns the project's own top folder.
 */
export async function unpackZip(zipFile: string, dir: string): Promise<string> {
  const data = await readFile(zipFile);
  let count = 0;
  let total = 0;
  const entries = unzipSync(data, {
    filter: (f) => {
      const parts = f.name.split("/");
      if (f.name.endsWith("/") || f.name.startsWith("/") || parts.includes("..") || /^[a-z]:/i.test(f.name) || f.name.includes("\\")) return false;
      if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) return false;
      if (count >= MAX_FILES || f.originalSize > MAX_FILE_BYTES || total + f.originalSize > MAX_TOTAL_BYTES) return false;
      count++;
      total += f.originalSize;
      return true;
    },
  });
  const root = path.resolve(dir);
  for (const [name, buf] of Object.entries(entries)) {
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) continue;
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buf);
  }
  // Most zips hold one top folder ("my-shop/..."): the tools then report paths from inside it.
  const names = Object.keys(entries);
  const tops = new Set(names.map((n) => n.split("/")[0]));
  if (tops.size === 1 && names.every((n) => n.includes("/"))) return path.join(root, [...tops][0]);
  return root;
}

/**
 * The project's files on disk for the code tools: the clone the code test just made, or the
 * uploaded zip, unpacked. Undefined for other products or when there is nothing on disk.
 */
export async function sourceDirFor(product: ProductType, target: ProjectTarget, uploadsDir: string, workDir: string): Promise<string | undefined> {
  if (product !== "code") return undefined;
  if (target.file) return unpackZip(uploadedPath(uploadsDir, target.file), path.join(workDir, "tools-src"));
  const clone = path.join(workDir, "repo");
  return existsSync(clone) ? clone : undefined;
}

/** The uploaded OpenAPI file of an API project, on disk. */
export function specFileFor(product: ProductType, target: ProjectTarget, uploadsDir: string): string | undefined {
  if (product !== "api" || !target.file) return undefined;
  return uploadedPath(uploadsDir, target.file);
}

/** A path inside the project, for the report ("src/db.js"), from a tool's absolute or relative path. */
export function relPath(sourceDir: string, file: string): string {
  const rel = path.isAbsolute(file) ? path.relative(sourceDir, file) : file.replace(/^\.\//, "");
  return rel.split(path.sep).join("/") || file;
}
