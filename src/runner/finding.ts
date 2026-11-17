import { createHash } from "node:crypto";
import type { Finding } from "../types.js";

/** Builds a finding with a stable id, so the same issue keeps its id across scans. */
export function finding(f: Omit<Finding, "id">): Finding {
  const id = createHash("sha1")
    .update(`${f.rule}|${f.pageUrl}|${f.evidence ?? f.title}`)
    .digest("hex")
    .slice(0, 12);
  return { id, ...f };
}
