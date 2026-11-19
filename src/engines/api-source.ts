import type { APIRequestContext } from "playwright";
import type { Json } from "./openapi.js";
import { parseSpecText } from "./openapi.js";

/*
 * Where the endpoint list comes from when there is no OpenAPI file: the file found at a common
 * address, or a Postman collection, a HAR file (Chrome's network export) or cURL commands, turned
 * into an OpenAPI 3 file so every check works the same way.
 */

export type SourceKind = "openapi" | "postman" | "har" | "curl";

/** Common places frameworks serve their API file (Springdoc, Swashbuckle, FastAPI, NestJS, Laravel...). */
export const SPEC_PLACES = [
  "/openapi.json",
  "/openapi.yaml",
  "/swagger.json",
  "/v3/api-docs",
  "/v2/api-docs",
  "/api-docs",
  "/api-docs.json",
  "/swagger/v1/swagger.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/api/docs/openapi.json",
  "/docs/openapi.json",
  "/api/v1/openapi.json",
  "/.well-known/openapi.json",
];

/** What kind of file this text is. */
export function sourceKind(text: string): SourceKind | undefined {
  const t = text.trim();
  if (/^curl\s/i.test(t)) return "curl";
  let j: Json;
  try {
    j = parseSpecText(t);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object") return undefined;
  if (typeof j.openapi === "string" || j.swagger === "2.0") return "openapi";
  if (j.log && Array.isArray(j.log.entries)) return "har";
  if (Array.isArray(j.item) && (j.info?.schema?.includes?.("getpostman") || j.info?._postman_id || j.info?.name)) return "postman";
  return undefined;
}

/** Looks for the API file at the common places, near the base address first. Returns its address and text. */
export async function findSpec(request: APIRequestContext, base: string, headers: Record<string, string>, log: (m: string) => void): Promise<{ url: string; text: string } | undefined> {
  const b = new URL(base);
  const roots = [...new Set([b.pathname.replace(/\/+$/, ""), ""])];
  log("No API file given: looking for it at the usual addresses");
  for (const root of roots) {
    for (const place of SPEC_PLACES) {
      const url = `${b.origin}${root}${place}`;
      const res = await request.get(url, { headers, timeout: 10_000, failOnStatusCode: false, maxRedirects: 2 }).catch(() => undefined);
      if (!res || res.status() !== 200) continue;
      const text = await res.text().catch(() => "");
      if (sourceKind(text) === "openapi") {
        log(`Found the API file at ${url}`);
        return { url, text };
      }
    }
  }
  return undefined;
}

interface Endpoint {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  status?: number;
  responseType?: string;
  response?: string;
  name?: string;
}

const SKIP_HEADERS = /^(authorization|cookie|host|content-length|connection|accept-encoding|user-agent|origin|referer|sec-|x-api-key|api-key|x-auth-token|:)/i;

/** "/users/42/orders/9f1c..." -> "/users/{id}/orders/{orderId}": numbers and ids become parameters. */
export function templatePath(pathname: string): { path: string; examples: Record<string, string> } {
  const examples: Record<string, string> = {};
  const parts = pathname.split("/");
  const out = parts.map((part, i) => {
    if (!/^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24})$/i.test(part)) return part;
    const before = (parts[i - 1] ?? "").replace(/[^a-z0-9]/gi, "");
    const singular = before.replace(/ies$/i, "y").replace(/s$/i, "");
    let name = singular ? `${singular}Id` : "id";
    if (i === parts.length - 1) name = "id";
    while (examples[name] !== undefined) name = `${name}2`;
    examples[name] = decodeURIComponent(part);
    return `{${name}}`;
  });
  return { path: out.join("/") || "/", examples };
}

/** A schema guessed from one JSON value, so answers can be compared on the next test. */
function schemaOf(v: unknown, depth = 0): Json {
  if (depth > 6) return {};
  if (v === null) return { nullable: true };
  if (Array.isArray(v)) return { type: "array", items: v.length ? schemaOf(v[0], depth + 1) : {} };
  if (typeof v === "object") {
    const properties: Record<string, Json> = {};
    for (const [k, x] of Object.entries(v as object).slice(0, 60)) properties[k] = schemaOf(x, depth + 1);
    return { type: "object", properties };
  }
  if (typeof v === "number") return { type: Number.isInteger(v) ? "integer" : "number" };
  return { type: typeof v };
}

/** Builds an OpenAPI 3 file from the endpoints of a collection, HAR or cURL list. */
export function toOpenApi(title: string, endpoints: Endpoint[]): Json {
  if (!endpoints.length) throw new Error("The file has no requests to test.");
  // The base address is the origin most requests go to.
  const counts = new Map<string, number>();
  for (const e of endpoints) counts.set(e.url.origin, (counts.get(e.url.origin) ?? 0) + 1);
  const origin = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const paths: Record<string, Json> = {};
  for (const e of endpoints) {
    if (e.url.origin !== origin) continue;
    const method = e.method.toLowerCase();
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    const { path, examples } = templatePath(e.url.pathname);
    const item = (paths[path] ??= {});
    if (item[method]) continue;
    const parameters: Json[] = Object.entries(examples).map(([name, example]) => ({ name, in: "path", required: true, schema: { type: /^\d+$/.test(example) ? "integer" : "string", example } }));
    for (const [name, value] of e.url.searchParams) parameters.push({ name, in: "query", required: true, schema: { type: "string", example: value } });
    for (const [name, value] of Object.entries(e.headers)) if (!SKIP_HEADERS.test(name)) parameters.push({ name, in: "header", required: false, schema: { type: "string", example: value } });
    const op: Json = { summary: e.name ?? `${e.method.toUpperCase()} ${path}`, parameters, responses: {} };
    if (e.body) {
      let example: unknown = e.body;
      try {
        example = JSON.parse(e.body);
      } catch {
        /* not JSON: kept as text */
      }
      op.requestBody = { content: { [typeof example === "string" ? "text/plain" : "application/json"]: { schema: { ...schemaOf(example), example } } } };
    }
    if (e.status) {
      let parsed: unknown;
      try {
        parsed = e.response ? JSON.parse(e.response) : undefined;
      } catch {
        /* not JSON */
      }
      op.responses[String(e.status)] = {
        description: "seen",
        ...(parsed !== undefined ? { content: { "application/json": { schema: schemaOf(parsed) } } } : {}),
      };
    } else op.responses.default = { description: "not documented" };
    item[method] = op;
  }
  return { openapi: "3.0.3", info: { title, version: "imported" }, servers: [{ url: origin }], paths };
}

/** Postman collection v2 / v2.1: every request in every folder, with its {{variables}} filled in. */
export function fromPostman(json: Json): Json {
  const vars = new Map<string, string>();
  for (const v of json.variable ?? []) if (v?.key) vars.set(String(v.key), String(v.value ?? ""));
  const fill = (s: string) => s.replace(/\{\{([\w.-]+)\}\}/g, (m, k) => vars.get(k) ?? m);
  const endpoints: Endpoint[] = [];
  const walk = (items: Json[]) => {
    for (const it of items ?? []) {
      if (Array.isArray(it.item)) walk(it.item);
      const r = it.request;
      if (!r) continue;
      const raw = fill(typeof r.url === "string" ? r.url : (r.url?.raw ?? ""));
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        continue;
      }
      const headers: Record<string, string> = {};
      for (const h of r.header ?? []) if (h?.key && !h.disabled) headers[String(h.key).toLowerCase()] = fill(String(h.value ?? ""));
      endpoints.push({ method: String(r.method ?? "GET"), url, headers, body: r.body?.mode === "raw" ? fill(String(r.body.raw ?? "")) : undefined, name: it.name });
    }
  };
  walk(json.item);
  return toOpenApi(json.info?.name ?? "Postman collection", endpoints);
}

/** HAR (Chrome DevTools > Network > Save all as HAR): the API calls in it (fetch / XHR and JSON answers). */
export function fromHar(json: Json): Json {
  const endpoints: Endpoint[] = [];
  for (const e of json.log.entries ?? []) {
    const req = e.request;
    const type = String(e.response?.content?.mimeType ?? "");
    const isApi = e._resourceType === "xhr" || e._resourceType === "fetch" || /json|xml/i.test(type);
    if (!req?.url || !isApi) continue;
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      continue;
    }
    const headers: Record<string, string> = {};
    for (const h of req.headers ?? []) headers[String(h.name).toLowerCase()] = String(h.value);
    endpoints.push({
      method: String(req.method ?? "GET"),
      url,
      headers,
      body: req.postData?.text,
      status: Number(e.response?.status) || undefined,
      responseType: type,
      response: typeof e.response?.content?.text === "string" && e.response.content.encoding !== "base64" ? e.response.content.text : undefined,
    });
  }
  if (!endpoints.length) throw new Error("The HAR file has no API calls (fetch or XHR requests with JSON answers).");
  return toOpenApi(json.log.pages?.[0]?.title ?? "HAR import", endpoints);
}

/** Splits a shell command line into words, with single and double quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < line.length) cur += line[++i];
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** cURL commands, one or more (as "Copy as cURL" gives them). */
export function fromCurl(text: string): Json {
  const commands = text
    .replace(/\\\r?\n/g, " ")
    .split(/\n(?=\s*curl\s)/i)
    .map((c) => c.trim())
    .filter((c) => /^curl\s/i.test(c));
  const endpoints: Endpoint[] = [];
  for (const c of commands) {
    const w = words(c).slice(1);
    let method = "";
    let raw = "";
    let body: string | undefined;
    const headers: Record<string, string> = {};
    for (let i = 0; i < w.length; i++) {
      const a = w[i];
      if (a === "-X" || a === "--request") method = w[++i] ?? "";
      else if (a === "-H" || a === "--header") {
        const h = w[++i] ?? "";
        const at = h.indexOf(":");
        if (at > 0) headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
      } else if (/^(-d|--data|--data-raw|--data-binary|--json)$/.test(a)) body = w[++i];
      else if (a === "--url") raw = w[++i] ?? "";
      else if (/^-(u|A|e|b|o|-user|-user-agent|-cookie|-output)$/.test(a)) i++;
      else if (!a.startsWith("-") && !raw) raw = a;
    }
    try {
      endpoints.push({ method: method || (body ? "POST" : "GET"), url: new URL(raw), headers, body });
    } catch {
      /* not a full address */
    }
  }
  if (!endpoints.length) throw new Error("No cURL command with a full address was found.");
  return toOpenApi("cURL import", endpoints);
}

/** Any accepted file as an OpenAPI file, and what it was. */
export function readSource(text: string): { spec: Json; kind: SourceKind } {
  const kind = sourceKind(text);
  if (kind === "curl") return { spec: fromCurl(text), kind };
  if (kind === "har") return { spec: fromHar(parseSpecText(text)), kind };
  if (kind === "postman") return { spec: fromPostman(parseSpecText(text)), kind };
  return { spec: parseSpecText(text), kind: "openapi" };
}
