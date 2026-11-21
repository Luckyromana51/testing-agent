import type { Severity } from "../../types.js";
import type { ProbeTarget } from "../probes.js";
import type { ToolContext } from "../types.js";
import type { AttackHttp } from "./http.js";

/**
 * One confirmed problem the attack agent found. It carries a short tag the chaining pass reads to
 * join findings into an attack path, and a key so the same hole on the same place is never counted
 * twice. The detail always ends with how to reproduce it and how to fix it.
 */
export interface AttackFinding {
  rule: string;
  severity: Severity;
  title: string;
  detail: string;
  pageUrl: string;
  evidence: string;
  key: string;
  /** What kind of hole it is, for chaining: "rce", "ssrf", "idor", "cors", "header", "deserialize". */
  tag: AttackTag;
}

export type AttackTag = "rce" | "ssrf" | "idor" | "cors" | "header" | "deserialize" | "injection";

/** A cookie from the signed-in session, split out so the session checks can read it. */
export interface Cookie {
  name: string;
  value: string;
}

/** What the attack agent found to work with, built once and shared by every family. */
export interface Surface {
  /** The pages the crawl opened, filtered to safe GET addresses on allowed hosts. */
  pages: string[];
  /** One target per path and parameter (query parameters and GET form fields). */
  params: ProbeTarget[];
  /** The signed-in session's cookies (empty when the test is not signed in). */
  cookies: Cookie[];
  signedIn: boolean;
}

export interface FamilyContext {
  http: AttackHttp;
  surface: Surface;
  ctx: ToolContext;
  log: (message: string) => void;
}

/** One attack technique. Families are listed as toggles in the tool's tab, each on by default. */
export interface Family {
  id: string;
  label: string;
  hint: string;
  run(fc: FamilyContext): Promise<AttackFinding[]>;
}

export const sev = (s: Severity) => s;
export const where = (t: ProbeTarget) => `${t.from === "form" ? "form field" : "parameter"} "${t.param}"`;
export const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
};
export type { ToolContext };
