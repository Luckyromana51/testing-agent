import type { AgentInfo } from "../../src/agents/types.ts";
import type { ProductInfo } from "../../src/products.ts";
import type {
  Issue,
  IssueStatus,
  ProductType,
  Project,
  Run,
  RunDiff,
  Schedule,
  Severity,
  User,
} from "../../src/types.ts";

export type RunSummary = Omit<Run, "result" | "ai" | "progress"> & {
  overallScore?: number;
  pageCount?: number;
  findingCount?: number;
  lastProgress?: string;
};

export interface IssueCounts {
  open: Record<Severity, number>;
  byStatus: Record<IssueStatus, number>;
}

export type ProjectSummary = Project & { counts: IssueCounts; lastRun: RunSummary | null; busy: boolean };

export interface ProjectDetail {
  project: ProjectSummary;
  runs: RunSummary[];
  trend: { runId: string; at: string; score: number; diff?: RunDiff }[];
  agents: AgentInfo[];
}

export type IssueSummary = Omit<Issue, "history"> & { projectName: string; events: number };
export type IssueDetail = Issue & { projectName?: string };

/** What a tester can enter for a project, depending on the product type. */
export interface TargetFields {
  url?: string;
  specUrl?: string;
  repoUrl?: string;
  branch?: string;
  file?: string;
  fileName?: string;
  maxPages?: number;
  checkLinks?: boolean;
}

export interface Upload {
  file: string;
  fileName: string;
  size: number;
}

export interface Meta {
  products: ProductInfo[];
  agents: (AgentInfo & { enabled: boolean })[];
  ai: boolean;
  aiSummary: boolean;
  defaultMaxPages: number;
}

export interface Settings {
  agents: Record<string, boolean>;
  defaultMaxPages: number;
  aiSummary: boolean;
}

export interface Overview {
  projects: number;
  scheduled: number;
  runsTotal: number;
  runsThisWeek: number;
  issues: IssueCounts;
  fixedThisWeek: number;
  queue: { active: number; waiting: number; concurrency: number };
  agents: { total: number; on: number };
  ai: boolean;
  users: number;
  products: { type: ProductType; name: string; available: boolean; projects: number }[];
}

/** Fired when the server says the session is gone, so the app can show the sign-in screen. */
export const UNAUTHORIZED = "glv:unauthorized";

/** loginOff: the server runs with AUTH_DISABLED=1, so there is no sign-in and everyone is the owner. */
export interface AuthState {
  setupNeeded: boolean;
  user: User | null;
  loginOff?: boolean;
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event(UNAUTHORIZED));
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  authState: () => call<AuthState>("GET", "/api/auth/state"),
  setup: (b: { name: string; email: string; password: string }) => call<{ user: User }>("POST", "/api/auth/setup", b),
  login: (b: { email: string; password: string }) => call<{ user: User }>("POST", "/api/auth/login", b),
  logout: () => call("POST", "/api/auth/logout", {}),
  changePassword: (b: { current: string; password: string }) => call("POST", "/api/auth/password", b),

  meta: () => call<Meta>("GET", "/api/meta"),

  projects: () => call<ProjectSummary[]>("GET", "/api/projects"),
  project: (id: string) => call<ProjectDetail>("GET", `/api/projects/${id}`),
  createProject: (b: { name: string; type: ProductType; schedule: Schedule } & TargetFields) =>
    call<{ project: Project; run: Run }>("POST", "/api/projects", b),
  updateProject: (id: string, b: Partial<{ name: string; schedule: Schedule } & TargetFields>) =>
    call<ProjectSummary>("PATCH", `/api/projects/${id}`, b),
  /** Sends a file as the raw request body; returns the stored name to put in the project. */
  upload: async (file: File, onProgress?: (pct: number) => void) =>
    new Promise<Upload>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.setRequestHeader("content-type", "application/octet-stream");
      xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => {
        const data = JSON.parse(xhr.responseText || "{}");
        if (xhr.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED));
        if (xhr.status >= 400) reject(new Error(data.error ?? `Upload failed (${xhr.status})`));
        else resolve(data as Upload);
      };
      xhr.onerror = () => reject(new Error("The upload was interrupted. Check the connection and try again."));
      xhr.send(file);
    }),
  deleteProject: (id: string) => call("DELETE", `/api/projects/${id}`),
  retest: (id: string) => call<Run>("POST", `/api/projects/${id}/runs`, { trigger: "retest" }),

  run: (id: string) => call<Run>("GET", `/api/runs/${id}`),
  deleteRun: (id: string) => call("DELETE", `/api/runs/${id}`),
  artifact: (id: string, file: string) => `/api/runs/${id}/artifacts/${file}`,

  issues: (projectId?: string) => call<IssueSummary[]>("GET", `/api/issues${projectId ? `?projectId=${projectId}` : ""}`),
  issue: (id: string) => call<IssueDetail>("GET", `/api/issues/${id}`),
  updateIssue: (id: string, b: Partial<{ status: IssueStatus; assignee: string; comment: string }>) =>
    call<IssueDetail>("PATCH", `/api/issues/${id}`, b),

  overview: () => call<Overview>("GET", "/api/owner/overview"),
  settings: () => call<Settings>("GET", "/api/owner/settings"),
  updateSettings: (b: Partial<Settings>) => call<Settings>("PATCH", "/api/owner/settings", b),
  users: () => call<User[]>("GET", "/api/owner/users"),
  addUser: (b: { name: string; email: string; password: string; role: "owner" | "member" }) =>
    call<User>("POST", "/api/owner/users", b),
  removeUser: (id: string) => call("DELETE", `/api/owner/users/${id}`),
};
