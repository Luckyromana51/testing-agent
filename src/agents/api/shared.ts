import type { ApiOperation } from "../../engines/openapi.js";
import type { EngineAgent } from "../types.js";
import type { ApiContext } from "./context.js";

export type ApiAgent = EngineAgent<ApiContext>;

/** The documented response for a status: exact code, then "2XX", then "default". */
export function documentedResponse(op: ApiOperation, status: number) {
  return op.responses[String(status)] ?? op.responses[`${String(status)[0]}XX`] ?? op.responses.default;
}
