import type { Run } from "../../src/types.ts";

export type RunSummary = Omit<Run, "result" | "ai" | "progress"> & {
  overallScore?: number;
  pageCount?: number;
  findingCount?: number;
  lastProgress?: string;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then((r) => json<{ ok: boolean; ai: boolean }>(r)),
  list: () => fetch("/api/runs").then((r) => json<RunSummary[]>(r)),
  get: (id: string) => fetch(`/api/runs/${id}`).then((r) => json<Run>(r)),
  create: (body: { url: string; maxPages: number; checkLinks: boolean; accessibility: boolean }) =>
    fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Run>(r)),
  remove: (id: string) => fetch(`/api/runs/${id}`, { method: "DELETE" }),
  artifact: (id: string, file: string) => `/api/runs/${id}/artifacts/${file}`,
};
