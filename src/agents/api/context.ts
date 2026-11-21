import type { APIRequestContext } from "playwright";
import type { ApiOperation, Json, ParsedSpec } from "../../engines/openapi.js";
import type { ApiAccessRow, ApiReport, ApiScenario, Login, RoleLogin } from "../../types.js";

/** One request the API engine made, and what came back. */
export interface ApiCall {
  op: ApiOperation;
  /** null when nothing came back (timeout, refused, DNS). */
  status: number | null;
  /** Median of the timed calls, in milliseconds. */
  ms: number;
  /** 95% time of the timed calls (the slowest when there are few). */
  p95?: number;
  /** How many calls were timed. */
  samples?: number;
  contentType: string;
  headers: Record<string, string>;
  /** The body, cut to 200 KB. */
  text: string;
  /** Bytes of the body as received. */
  bytes?: number;
  /** Parsed body, when it is JSON. */
  json?: Json;
  /** Set when the body says it is JSON but does not parse. */
  jsonError?: string;
  /** Why nothing came back. */
  error?: string;
  /** The address really called (with real ids), when it differs from op.url. */
  url?: string;
  /** What was sent: headers other than the login, and the body. */
  sent?: { headers: Record<string, string>; body?: string };
  /** Where real ids in the address came from. */
  idFrom?: string;
}

/** What one request should look like, for calls the agents make on their own. */
export interface CallInput {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  /** JSON (object) or text. */
  body?: unknown;
  /** false: no saved login. A role: that account's login. Default: the main login. */
  as?: false | RoleLogin;
  /** Make the timed extra calls (only the engine's first pass does). */
  timed?: boolean;
}

export interface ApiContext {
  spec: Json;
  parsed: ParsedSpec;
  specUrl: string;
  /** Every operation that was called, in spec order (with the saved login, when there is one). */
  calls: ApiCall[];
  /**
   * Operations that need a login, called without one to check they refuse strangers.
   * Without a saved login this is the same as calls, which were all made without credentials.
   */
  anonymous: ApiCall[];
  /** True when the calls carried the project's saved login. */
  authenticated: boolean;
  /** The saved login (never reported). */
  login?: Login;
  /** The token the calls carry, when there is one (bearer, OAuth2, sign-in call), for the token checks. */
  token?: string;
  /** How the login is sent, for the report. */
  authLabel: string;
  /** Makes extra read-only requests (the probes of the error and CORS agents). */
  request: APIRequestContext;
  /** Calls one address the way the engine does (with retry and the saved login), for probes. */
  call: (op: ApiOperation, headers?: Record<string, string>) => Promise<ApiCall>;
  /** Any request (writes only when the agent checked testServer), never throwing. */
  send: (input: CallInput, op?: ApiOperation) => Promise<ApiCall>;
  /** The project is a test server: data may be created, changed and deleted (and is cleaned up). */
  testServer: boolean;
  /** The project's other accounts (another user, another company, a lower role). */
  roles: RoleLogin[];
  /** The approved copy of the API file, to list what changed. */
  baseline?: { spec: Json; at: string };
  scenarios: ApiScenario[];
  /** What the agents add to the report (scenarios, access grid, writes, changes, audit). */
  report: Partial<ApiReport> & { accessRows?: ApiAccessRow[] };
  /** Calls the agents made that the Endpoints tab should show (write tests). */
  extraCalls: { call: ApiCall; step: string }[];
  log: (m: string) => void;
}
