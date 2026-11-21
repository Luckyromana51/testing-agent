import type { ApiCall } from "../agents/api/context.js";
import type { ApiOperation, Json } from "./openapi.js";

/*
 * Real ids for detail endpoints: /users/{id} is tested with an id the list endpoint GET /users
 * really returned, instead of "1" (which often does not exist and only tests the 404 page).
 * Like RESTler and Schemathesis links, without needing links in the API file.
 */

const LIST_KEYS = ["data", "items", "results", "records", "rows", "content", "list", "entries", "hits", "nodes"];

/** The first record of a list answer: [ {...} ] or { data: [ {...} ] }. */
export function firstRecord(json: Json): { record: Record<string, Json>; at: string } | undefined {
  if (Array.isArray(json)) return json[0] && typeof json[0] === "object" ? { record: json[0], at: "$[0]" } : undefined;
  if (json && typeof json === "object") {
    for (const k of LIST_KEYS) {
      const v = json[k];
      if (Array.isArray(v) && v[0] && typeof v[0] === "object") return { record: v[0], at: `$.${k}[0]` };
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const k2 of LIST_KEYS) {
          const w = v[k2];
          if (Array.isArray(w) && w[0] && typeof w[0] === "object") return { record: w[0], at: `$.${k}.${k2}[0]` };
        }
      }
    }
  }
  return undefined;
}

const scalar = (v: Json) => (typeof v === "string" && v.length && v.length <= 200) || typeof v === "number";

/** The value in a record for a path parameter: "id", "userId" / "user_id", "uuid", "slug"... */
function pick(record: Record<string, Json>, param: string, resource: string): { value: string; key: string } | undefined {
  const low = param.toLowerCase();
  const res = resource.toLowerCase().replace(/[^a-z0-9]/g, "");
  const singular = res.replace(/ies$/, "y").replace(/s$/, "");
  const names = [param, low, param.replace(/([A-Z])/g, "_$1").toLowerCase()];
  if (low === "id" || low === `${singular}id` || low === `${singular}_id`) names.push("id", "_id", "uuid");
  if (/slug|code|key|name|sku|uuid/.test(low)) names.push(low.replace(/^.*(slug|code|key|name|sku|uuid)$/, "$1"));
  for (const n of names) {
    const v = record[n];
    if (scalar(v)) return { value: String(v), key: n };
  }
  return undefined;
}

export interface FoundId {
  value: string;
  /** "GET /users → $[0].id" */
  from: string;
}

/**
 * Real values for each path parameter of an operation, from the answers already received.
 * The list endpoint for "/users/{id}" is "/users"; for "/users/{userId}/orders/{id}", "/users"
 * gives userId and "/users/{userId}/orders" gives id.
 */
export function realIds(op: ApiOperation, calls: ApiCall[]): Record<string, FoundId> {
  const out: Record<string, FoundId> = {};
  const parts = op.path.split("/");
  parts.forEach((part, i) => {
    const m = /^\{(.+)\}$/.exec(part);
    if (!m) return;
    const listPath = parts.slice(0, i).join("/");
    const resource = parts[i - 1] ?? "";
    const list = calls.find((c) => c.op.path === listPath && c.status !== null && c.status >= 200 && c.status < 300 && c.json !== undefined);
    const rec = list && firstRecord(list.json);
    const hit = rec && pick(rec.record, m[1], resource);
    if (list && rec && hit) out[m[1]] = { value: hit.value, from: `GET ${list.op.path} → ${rec.at}.${hit.key}` };
  });
  return out;
}

/** Operations without path parameters first (lists), then by how many parameters they have, in file order. */
export function callOrder(ops: ApiOperation[]): ApiOperation[][] {
  const depth = (o: ApiOperation) => (o.path.match(/\{/g) ?? []).length;
  const max = Math.max(0, ...ops.map(depth));
  const waves: ApiOperation[][] = [];
  for (let d = 0; d <= max; d++) {
    const wave = ops.filter((o) => depth(o) === d);
    if (wave.length) waves.push(wave);
  }
  return waves;
}
