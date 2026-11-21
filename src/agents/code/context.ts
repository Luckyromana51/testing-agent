import type { APIRequestContext } from "playwright";

export interface SourceFile {
  /** Path inside the project, with forward slashes. */
  path: string;
  size: number;
  text: string;
}

export interface CodeContext {
  /** Where the code came from: a Git clone or an uploaded zip. */
  source: "git" | "zip";
  /** Readable text files (binary files and files over 1 MB are left out). */
  files: SourceFile[];
  /** Every path seen, including binary and large files. */
  allPaths: string[];
  /** Folders that were not read, such as node_modules, with where they were found. */
  skippedDirs: string[];
  /** For the package vulnerability lookup. */
  request: APIRequestContext;
  log: (m: string) => void;
  /** Adds a line to the report's "what was tested" notes. */
  note: (m: string) => void;
}

/** Test, example and fixture files: findings there are usually not live problems. */
export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|fixtures?|mocks?|__mocks__|examples?|samples?|demo|e2e|cypress)(\/|$)|\.(test|spec|stories)\.\w+$|_test\.(go|py)$|(^|\/)test_\w+\.py$/i;
