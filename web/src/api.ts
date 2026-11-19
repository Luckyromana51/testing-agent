import type { AgentInfo } from "../../src/agents/types.ts";
import type { ProductInfo } from "../../src/products.ts";
import type { ToolChoice, ToolInfo } from "../../src/tools/types.ts";
import type { HelperInfo } from "../../src/helpers.ts";
import type { ModuleInfo } from "../../src/modules.ts";
import type { FlakyIssue, TrendPoint } from "../../src/trends.ts";
import type { Alert, Incident, WatchSummary } from "../../src/watch.ts";
import type { Permission, PermissionKind, PermissionStatus } from "../../src/permission.ts";
import type {
  ApiScenario,
  Issue,
  IssueStatus,
  Journey,
  JourneyWatchRun,
  RoleLogin,
  RoleSummary,
  WatchConfig,
  Login,
  LoginSummary,
  PageResult,
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

export type ProjectSummary = Project & {
  counts: IssueCounts;
  lastRun: RunSummary | null;
  busy: boolean;
  /** Queued behind other tests, not yet running. */
  waiting: boolean;
  /** The saved login, without its secrets. */
  login: LoginSummary | null;
  permissions: PermissionView[];
  /** Other accounts (roles, another company), without their secrets. */
  roles: RoleSummary[];
  /** The project's webhook inbox address, when it is open. */
  hookAddress: string | null;
  /** The API mock server's address, when it is on. */
  mockAddress: string | null;
};

export interface HookMessageView {
  id: number;
  at: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  bytes: number;
}

/** A client's permission for load and attack tests, with where it stands today. */
export type PermissionView = Permission & { status: PermissionStatus };

export interface PermissionDraft {
  hosts: string[];
  kinds: PermissionKind[];
  grantedBy: string;
  reference: string;
  writes: boolean;
  maxUsers: number;
  maxMinutes: number;
  from: string;
  until: string;
  confirm: boolean;
}

export interface ProofCheck {
  host: string;
  ok: boolean;
  method?: "file" | "dns";
  error?: string;
}

export interface ProjectDetail {
  project: ProjectSummary;
  runs: RunSummary[];
  trend: { runId: string; at: string; score: number; diff?: RunDiff }[];
  agents: AgentInfo[];
  trends: TrendPoint[];
  flaky: FlakyIssue[];
  /** Uptime and SSL watch (websites and web apps only). */
  watch: (WatchSummary & { checkUrl: string | null; expectText: string | null; journeys: boolean; journeysEveryMin: number; lastJourneys: JourneyWatchRun | null }) | null;
}

export interface WatchOverview {
  down: { id: string; name: string; url?: string; since: string }[];
  alerts: Alert[];
  incidents: (Incident & { projectName: string })[];
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
  /** Signed-in apps: a known system's id, or "" to let the test spot it. */
  system?: string;
  /** API: a GraphQL endpoint instead of a REST API file. */
  graphqlUrl?: string;
  /** API: the project is a test server (tests may change data, and clean up). */
  testServer?: boolean;
  /** A login to save (secrets left empty keep the saved ones), or null to remove it. */
  login?: Partial<Login> | null;
}

export interface Upload {
  file: string;
  fileName: string;
  size: number;
}

/** An outside tool, with whether it is installed on this server. */
export type MetaTool = ToolInfo & { ready: boolean; notReady?: string };

export interface Meta {
  products: ProductInfo[];
  tools: MetaTool[];
  agents: (AgentInfo & { enabled: boolean })[];
  ai: boolean;
  aiSummary: boolean;
  defaultMaxPages: number;
  /** Pages a web test opens at the same time, and the most the server allows. */
  parallelPages: number;
  maxParallel: number;
  /** Tests (projects) run at the same time, and the most allowed. */
  parallelProjects: number;
  maxParallelProjects: number;
  /** Where the login vault's key comes from, and how many logins it holds. */
  vault: { source: "env" | "file"; keyId: string; saved: number; unreadable: number };
  /** Optional modules (inspect screen, visual compare, journeys...) and whether each is on. */
  modules: (ModuleInfo & { on: boolean; ready: boolean })[];
  /** The business systems the signed-in test knows, and their kinds. */
  systems: { id: string; name: string; kind: string }[];
  systemKinds: { id: string; name: string }[];
}

export interface Settings {
  agents: Record<string, boolean>;
  defaultMaxPages: number;
  aiSummary: boolean;
  /** Pages a web test opens at the same time. */
  parallelPages: number;
  maxParallel: number;
  parallelProjects: number;
  modules?: Record<string, boolean>;
}

/** The tests running now and waiting, and how many may run at the same time. */
export interface QueueOverview {
  limit: number;
  maxLimit: number;
  running: { runId: string; projectId?: string; name: string; url: string; startedAt?: string }[];
  waiting: { runId: string; projectId?: string; name: string; url: string }[];
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

/** A Mac paired with this server, as the owner panel shows it. */
export interface HelperView {
  id: string;
  name: string;
  createdAt: string;
  createdBy: string;
  lastSeen: string | null;
  online: boolean;
  info: HelperInfo | null;
  busy: { label: string; since: string } | null;
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
  saveRole: (id: string, b: Partial<Omit<RoleLogin, "login">> & { login: Partial<Login> }) => call<RoleSummary>("POST", `/api/projects/${id}/roles`, b),
  deleteRole: (id: string, rid: string) => call("DELETE", `/api/projects/${id}/roles/${rid}`),
  hooks: (id: string) => call<{ address: string | null; messages: HookMessageView[] }>("GET", `/api/projects/${id}/hooks`),
  openHooks: (id: string, b: { fresh?: boolean; clear?: boolean } = {}) => call<{ address: string; messages: HookMessageView[] }>("POST", `/api/projects/${id}/hooks`, b),
  closeHooks: (id: string) => call("DELETE", `/api/projects/${id}/hooks`),
  watchJourneysNow: (id: string) => call<JourneyWatchRun | null>("POST", `/api/projects/${id}/watch/journeys`, {}),
  project: (id: string) => call<ProjectDetail>("GET", `/api/projects/${id}`),
  createProject: (b: { name: string; type: ProductType; schedule: Schedule; tools?: ToolChoice[] } & TargetFields) =>
    call<{ project: ProjectSummary; run: Run }>("POST", "/api/projects", b),
  updateProject: (
    id: string,
    b: Partial<{ name: string; schedule: Schedule; tools: ToolChoice[]; journeys: Journey[]; watch: WatchConfig; apiScenarios: ApiScenario[]; mock: boolean | "new" | null } & TargetFields>,
  ) =>
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
  watchCheck: (id: string) => call<WatchSummary>("POST", `/api/projects/${id}/watch/check`, {}),
  watchOverview: () => call<WatchOverview>("GET", "/api/watch"),
  deleteProject: (id: string) => call("DELETE", `/api/projects/${id}`),
  retest: (id: string) => call<Run>("POST", `/api/projects/${id}/runs`, { trigger: "retest" }),
  addPermission: (id: string, b: PermissionDraft) =>
    call<{ project: ProjectSummary; permissionId: string; checks: ProofCheck[] }>("POST", `/api/projects/${id}/permissions`, b),
  checkPermission: (id: string, pid: string) => call<{ project: ProjectSummary; checks: ProofCheck[] }>("POST", `/api/projects/${id}/permissions/${pid}/check`, {}),
  revokePermission: (id: string, pid: string) => call<ProjectSummary>("POST", `/api/projects/${id}/permissions/${pid}/revoke`, {}),

  run: (id: string) => call<Run>("GET", `/api/runs/${id}`),
  deleteRun: (id: string) => call("DELETE", `/api/runs/${id}`),
  cancelRun: (id: string) => call<Run>("POST", `/api/runs/${id}/cancel`),
  summarise: (id: string) => call<Run>("POST", `/api/runs/${id}/summary`),
  artifact: (id: string, file: string) => `/api/runs/${id}/artifacts/${file}`,
  approvePicture: (id: string, index: number, view: "desktop" | "phone") =>
    call<{ ok: true; visual: NonNullable<PageResult["visual"]> }>("POST", `/api/runs/${id}/pages/${index}/approve`, { view }),

  issues: (projectId?: string) => call<IssueSummary[]>("GET", `/api/issues${projectId ? `?projectId=${projectId}` : ""}`),
  issue: (id: string) => call<IssueDetail>("GET", `/api/issues/${id}`),
  updateIssue: (id: string, b: Partial<{ status: IssueStatus; assignee: string; comment: string }>) =>
    call<IssueDetail>("PATCH", `/api/issues/${id}`, b),

  overview: () => call<Overview>("GET", "/api/owner/overview"),
  settings: () => call<Settings>("GET", "/api/owner/settings"),
  queue: () => call<QueueOverview>("GET", "/api/queue"),
  updateSettings: (b: Partial<Settings>) => call<Settings>("PATCH", "/api/owner/settings", b),
  users: () => call<User[]>("GET", "/api/owner/users"),
  addUser: (b: { name: string; email: string; password: string; role: "owner" | "member" }) =>
    call<User>("POST", "/api/owner/users", b),
  removeUser: (id: string) => call("DELETE", `/api/owner/users/${id}`),
  helpers: () => call<{ helpers: HelperView[]; queued: number }>("GET", "/api/owner/helpers"),
  addHelper: (name: string) => call<{ helper: HelperView; token: string }>("POST", "/api/owner/helpers", { name }),
  removeHelper: (id: string) => call("DELETE", `/api/owner/helpers/${id}`),
  helperDownload: "/api/owner/helpers/download",

  /** API projects: approve a test's API file as the new version, the Postman file, and the mock server. */
  approveApiFile: (runId: string) => call<{ ok: true }>("POST", `/api/runs/${runId}/api-baseline`, {}),
  postmanUrl: (runId: string) => `/api/runs/${runId}/postman`,
  mock: (id: string) => call<MockView>("GET", `/api/projects/${id}/mock`),
};

export interface MockView {
  address: string | null;
  ready: boolean;
  endpoints?: number;
  calls: { at: string; method: string; path: string; status: number; problems?: string[] }[];
}
