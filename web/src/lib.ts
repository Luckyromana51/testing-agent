import { useEffect, useRef, useState } from "react";
import type { Category, IssueStatus, Severity } from "../../src/types.ts";

export const CATEGORY_LABEL: Record<Category, string> = {
  functional: "Functional",
  accessibility: "Accessibility",
  seo: "SEO",
  security: "Security",
  performance: "Performance",
  mobile: "Mobile",
};

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];
export const isMajor = (s: Severity) => s === "critical" || s === "high";

export const STATUS_LABEL: Record<IssueStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  fixed: "Fixed, waiting for re-test",
  verified: "Verified fixed",
  reopened: "Came back",
  wont_fix: "Won't fix",
};

export function scoreTone(score?: number) {
  if (score === undefined || score === null) return "muted";
  if (score >= 90) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

export function timeAgo(iso?: string) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export const hostOf = (url?: string) => {
  try {
    return url ? new URL(url).host.replace(/^www\./, "") : "";
  } catch {
    return url ?? "";
  }
};

/** One line naming what a project tests: the site, the API file, the repository or the uploaded file. */
export function targetLabel(t: { url?: string; specUrl?: string; repoUrl?: string; fileName?: string; branch?: string }): string {
  if (t.repoUrl) return `${t.repoUrl.replace(/^https:\/\//, "")}${t.branch ? ` (${t.branch})` : ""}`;
  if (t.specUrl) return t.specUrl.replace(/^https?:\/\//, "");
  if (t.url) return hostOf(t.url);
  return t.fileName ?? "";
}

/** A link for the target, when it has a web address. */
export const targetHref = (t: { url?: string; specUrl?: string; repoUrl?: string }) => t.repoUrl ?? t.specUrl ?? t.url;

export const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
};

export interface Route {
  name: "home" | "new" | "projects" | "project" | "run" | "issues" | "owner";
  id?: string;
  query: URLSearchParams;
}

function parse(): Route {
  const [pathPart, queryPart] = window.location.hash.replace(/^#\/?/, "").split("?");
  const [name, id] = pathPart.split("/");
  const query = new URLSearchParams(queryPart ?? "");
  const known: Route["name"][] = ["new", "projects", "project", "run", "issues", "owner"];
  return { name: known.includes(name as Route["name"]) ? (name as Route["name"]) : "home", id, query };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const go = (hash: string) => {
  window.location.hash = hash;
};

/** Loads data, and reloads every `everyMs` while `keepPolling(data)` is true. */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], everyMs = 2000, keepPolling?: (d: T) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      try {
        const d = await loadRef.current();
        if (stop) return;
        setData(d);
        setError("");
        if (!keepPolling || keepPolling(d)) timer = setTimeout(run, everyMs);
      } catch (err) {
        if (!stop) setError((err as Error).message);
      }
    };
    run();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, reload: () => setTick((t) => t + 1), setData };
}
