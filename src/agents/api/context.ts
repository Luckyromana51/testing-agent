import type { APIRequestContext } from "playwright";
import type { ApiOperation, Json, ParsedSpec } from "../../engines/openapi.js";

/** One GET request the API engine made, and what came back. */
export interface ApiCall {
  op: ApiOperation;
  /** null when nothing came back (timeout, refused, DNS). */
  status: number | null;
  /** Fastest of the attempts, in milliseconds. */
  ms: number;
  contentType: string;
  headers: Record<string, string>;
  /** The body, cut to 200 KB. */
  text: string;
  /** Parsed body, when it is JSON. */
  json?: Json;
  /** Set when the body says it is JSON but does not parse. */
  jsonError?: string;
  /** Why nothing came back. */
  error?: string;
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
  /** Makes extra read-only requests (the probes of the error and CORS agents). */
  request: APIRequestContext;
  /** Calls one address the way the engine does (with retry and the saved login), for probes. */
  call: (op: ApiOperation, headers?: Record<string, string>) => Promise<ApiCall>;
  log: (m: string) => void;
}
