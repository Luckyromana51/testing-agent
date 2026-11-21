import YAML from "yaml";

/* Reads an OpenAPI 3 or Swagger 2 file into the GET operations we can safely call. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiParam {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  schema?: Json;
}

export interface ApiOperation {
  method: string;
  path: string;
  operationId?: string;
  /** The spec marks it as deprecated. */
  deprecated?: boolean;
  /** Path, query and header parameters, with their schemas. */
  params?: ApiParam[];
  /** The documented request body (JSON only), for test-server write tests. */
  body?: { contentType: string; schema?: Json; required: boolean };
  /** Path parameters still filled with a guess ("1") rather than an example or a real id. */
  guessed?: string[];
  /** Address to call, with example values in place of path parameters. */
  url: string;
  title: string;
  /** The spec says this operation needs credentials. */
  secured: boolean;
  /** Documented responses: status code -> schema and content type. */
  responses: Record<string, { schema?: Json; contentType?: string; headers?: string[] }>;
  /** Why we will not call it (needs a header we do not have, a body, and so on). */
  skip?: string;
}

export interface ParsedSpec {
  version: string;
  title: string;
  baseUrl: string;
  operations: ApiOperation[];
  /** Operations that change data (POST, PUT, PATCH, DELETE). Only called on a test server. */
  writeOperations: number;
  writes: ApiOperation[];
  hasSecuritySchemes: boolean;
  warnings: string[];
}

export function isJsonType(contentType: string | undefined): boolean {
  return /[/+]json\b/i.test(contentType ?? "");
}

export function parseSpecText(text: string): Json {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  return YAML.parse(trimmed);
}

/** Follows a local "$ref": "#/components/schemas/User" pointer. */
export function deref(spec: Json, node: Json, depth = 0): Json {
  if (!node || typeof node !== "object" || depth > 20) return node;
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
    const target = node.$ref
      .slice(2)
      .split("/")
      .reduce((o: Json, k: string) => (o ? o[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), spec);
    return deref(spec, target, depth + 1);
  }
  return node;
}

/** An example the file gives for a parameter, or undefined when only a guess is possible. */
export function documentedExample(spec: Json, param: Json): string | undefined {
  const p = deref(spec, param);
  const schema = deref(spec, p.schema ?? p);
  const candidates = [p.example, schema?.example, schema?.default, schema?.enum?.[0], p.examples && Object.values(p.examples)[0]];
  for (const c of candidates) {
    const v = deref(spec, c);
    if (v !== undefined && v !== null && typeof v !== "object") return String(v);
    if (v && typeof v === "object" && "value" in v) return String(v.value);
  }
  return undefined;
}

function exampleValue(spec: Json, param: Json): string | undefined {
  const p = deref(spec, param);
  const schema = deref(spec, p.schema ?? p);
  const candidates = [p.example, schema?.example, schema?.default, schema?.enum?.[0], p.examples && Object.values(p.examples)[0]];
  for (const c of candidates) {
    const v = deref(spec, c);
    if (v !== undefined && v !== null && typeof v !== "object") return String(v);
    if (v && typeof v === "object" && "value" in v) return String(v.value);
  }
  const type = schema?.type ?? p.type;
  if (type === "integer" || type === "number") return "1";
  if (type === "boolean") return "true";
  if (schema?.format === "uuid") return "00000000-0000-0000-0000-000000000001";
  if (type === "string" || !type) return "1";
  return undefined;
}

function readOperation(spec: Json, isV3: boolean, baseUrl: string, path: string, method: string, item: Json, op: Json, globalSecurity: Json[]): ApiOperation {
  const params: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: Json) => deref(spec, p));
  // An operation's own parameter replaces the path item's one with the same name and place.
  const byKey = new Map<string, Json>();
  for (const p of params) if (p && p.name) byKey.set(`${p.in}|${p.name}`, p);
  let skip: string | undefined;
  let url = path;
  const query = new URLSearchParams();
  const guessed: string[] = [];
  const list: ApiParam[] = [];
  let bodyParam: Json;
  for (const p of byKey.values()) {
    if (p.in === "body") {
      bodyParam = p;
      continue;
    }
    if (p.in === "formData") continue;
    list.push({ name: p.name, in: p.in, required: Boolean(p.required || p.in === "path"), schema: deref(spec, p.schema ?? { type: p.type, format: p.format, enum: p.enum, maximum: p.maximum }) });
    if (p.in === "path") {
      const v = exampleValue(spec, p);
      if (documentedExample(spec, p) === undefined) guessed.push(p.name);
      if (v === undefined) skip = `No example value for path parameter "${p.name}"`;
      else url = url.replace(`{${p.name}}`, encodeURIComponent(v));
    } else if (p.in === "query" && p.required) {
      const v = exampleValue(spec, p);
      if (v === undefined) skip = `No example value for required query parameter "${p.name}"`;
      else query.set(p.name, v);
    } else if (p.in === "header" && p.required && !/^authorization$/i.test(p.name)) {
      skip = `Needs the "${p.name}" header`;
    }
  }
  const security: Json[] = op.security ?? globalSecurity;
  const secured = security.length > 0 && !security.some((s: Json) => s && Object.keys(s).length === 0);
  const responses: ApiOperation["responses"] = {};
  for (const [code, raw] of Object.entries<Json>(op.responses ?? {})) {
    const r = deref(spec, raw);
    const headers = Object.keys(r?.headers ?? {}).map((h) => h.toLowerCase());
    if (isV3) {
      const content = r?.content ?? {};
      const [contentType, media] = Object.entries<Json>(content).find(([t]) => isJsonType(t)) ?? Object.entries<Json>(content)[0] ?? [];
      responses[code] = { contentType, schema: media?.schema, ...(headers.length ? { headers } : {}) };
    } else {
      responses[code] = { contentType: (op.produces ?? spec.produces ?? [])[0], schema: r?.schema, ...(headers.length ? { headers } : {}) };
    }
  }
  let body: ApiOperation["body"];
  if (isV3 && op.requestBody) {
    const rb = deref(spec, op.requestBody);
    const content = rb?.content ?? {};
    const [contentType, media] = Object.entries<Json>(content).find(([t]) => isJsonType(t)) ?? Object.entries<Json>(content)[0] ?? [];
    if (contentType) body = { contentType, schema: media?.schema, required: Boolean(rb.required) };
  } else if (bodyParam) {
    body = { contentType: "application/json", schema: bodyParam.schema, required: Boolean(bodyParam.required) };
  }
  const qs = query.toString();
  const M = method.toUpperCase();
  return {
    method: M,
    path,
    url: `${baseUrl}${url}${qs ? `?${qs}` : ""}`,
    title: op.summary ?? op.operationId ?? `${M} ${path}`,
    ...(op.operationId ? { operationId: String(op.operationId) } : {}),
    ...(op.deprecated ? { deprecated: true } : {}),
    secured,
    responses,
    params: list,
    ...(body ? { body } : {}),
    ...(guessed.length ? { guessed } : {}),
    skip,
  };
}

/** The address of an operation with these path values (and the documented examples for the rest). */
export function fillPath(op: ApiOperation, baseUrl: string, values: Record<string, string>): string {
  const original = new URL(op.url);
  let path = op.path;
  const fromUrl = decodeURIComponent(original.pathname.slice(new URL(baseUrl).pathname.replace(/\/$/, "").length));
  // Path parts in the original address line up with the template: reuse the ones not given.
  const tParts = op.path.split("/");
  const uParts = fromUrl.split("/");
  tParts.forEach((t, i) => {
    const m = /^\{(.+)\}$/.exec(t);
    if (!m) return;
    const v = values[m[1]] ?? uParts[i] ?? "1";
    path = path.replace(t, encodeURIComponent(v));
  });
  return `${baseUrl}${path}${original.search}`;
}

export function parseSpec(spec: Json, specUrl: string, baseOverride?: string): ParsedSpec {
  const warnings: string[] = [];
  const isV3 = typeof spec?.openapi === "string";
  const isV2 = spec?.swagger === "2.0";
  if (!isV3 && !isV2) throw new Error("This is not an OpenAPI 3 or Swagger 2 file (no 'openapi' or 'swagger' field).");
  if (!spec.paths || typeof spec.paths !== "object") throw new Error("The API file has no paths.");

  let baseUrl = baseOverride ?? "";
  if (!baseUrl) {
    if (isV3) {
      const server = spec.servers?.[0]?.url as string | undefined;
      if (!server) warnings.push("The file lists no servers, so the address of the file itself was used.");
      baseUrl = new URL(
        (server ?? "/").replace(/\{(\w+)\}/g, (_m: string, v: string) => spec.servers?.[0]?.variables?.[v]?.default ?? v),
        specUrl,
      ).toString();
    } else {
      const scheme = spec.schemes?.includes("https") ? "https" : (spec.schemes?.[0] ?? new URL(specUrl).protocol.replace(":", ""));
      baseUrl = `${scheme}://${spec.host ?? new URL(specUrl).host}${spec.basePath ?? ""}`;
    }
  }
  baseUrl = baseUrl.replace(/\/+$/, "");

  const globalSecurity: Json[] = spec.security ?? [];
  const hasSecuritySchemes = Boolean(
    Object.keys(spec.components?.securitySchemes ?? spec.securityDefinitions ?? {}).length,
  );
  const operations: ApiOperation[] = [];
  let writeOperations = 0;

  const writes: ApiOperation[] = [];
  for (const [path, rawItem] of Object.entries<Json>(spec.paths)) {
    const item = deref(spec, rawItem);
    if (!item || typeof item !== "object") continue;
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const op = item[method];
      if (!op) continue;
      const parsedOp = readOperation(spec, isV3, baseUrl, path, method, item, op, globalSecurity);
      if (method === "get") operations.push(parsedOp);
      else {
        writeOperations++;
        writes.push(parsedOp);
      }
    }
  }

  return {
    version: isV3 ? `OpenAPI ${spec.openapi}` : "Swagger 2.0",
    title: spec.info?.title ?? "API",
    baseUrl,
    operations,
    writeOperations,
    writes,
    hasSecuritySchemes,
    warnings,
  };
}

const FORMATS: Record<string, RegExp> = {
  "date-time": /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i,
  date: /^\d{4}-\d{2}-\d{2}$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  uri: /^[a-z][\w+.-]*:\S+$/i,
  url: /^[a-z][\w+.-]*:\S+$/i,
  ipv4: /^(\d{1,3}\.){3}\d{1,3}$/,
};

/** The documented fields a schema allows (properties of it and its allOf parts), or undefined when any field goes. */
function knownFields(spec: Json, schema: Json, depth = 0): Set<string> | undefined {
  const s = deref(spec, schema);
  if (!s || typeof s !== "object" || depth > 8) return undefined;
  if (s.oneOf || s.anyOf || s.additionalProperties === true || (s.additionalProperties && typeof s.additionalProperties === "object")) return undefined;
  if (!s.properties && !s.allOf) return undefined;
  const out = new Set<string>(Object.keys(s.properties ?? {}));
  for (const part of s.allOf ?? []) {
    const more = knownFields(spec, part, depth + 1);
    if (!more) return undefined;
    for (const k of more) out.add(k);
  }
  return out;
}

export interface SchemaOptions {
  /** Also list fields the schema does not document (only where it lists its fields). */
  extra?: string[];
}

/**
 * Checks a JSON value against a schema (the parts of JSON Schema used by OpenAPI: type, required,
 * properties, items, enum, nullable, allOf, oneOf, anyOf, format, minimum, maximum, minLength,
 * maxLength, pattern, minItems, maxItems, additionalProperties). Returns up to 5 problems, in a fixed
 * order, so the same answer always gives the same finding.
 */
export function validateSchema(spec: Json, rawSchema: Json, value: unknown, path = "$", out: string[] = [], depth = 0, opts: SchemaOptions = {}): string[] {
  const schema = deref(spec, rawSchema);
  if (!schema || typeof schema !== "object" || out.length >= 5 || depth > 12) return out;
  if (value === null) {
    if (!(schema.nullable || schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null")) || schema["x-nullable"])) {
      if (schema.type) out.push(`${path} is null but should be ${schema.type}`);
    }
    return out;
  }
  if (schema.allOf) for (const s of schema.allOf) validateSchema(spec, s, value, path, out, depth + 1);
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key])) {
      const ok = schema[key].some((s: Json) => validateSchema(spec, s, value, path, [], depth + 1).length === 0);
      if (!ok) out.push(`${path} matches none of the allowed shapes`);
    }
  }
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = Array.isArray(value) ? "array" : typeof value === "number" ? (Number.isInteger(value) ? "integer" : "number") : typeof value;
  if (types.length && !types.some((t) => t === actual || (t === "number" && actual === "integer"))) {
    out.push(`${path} is ${actual} but should be ${types.join(" or ")}`);
    return out;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) out.push(`${path} is ${JSON.stringify(value)}, not one of ${schema.enum.slice(0, 5).join(", ")}`);
  if (typeof value === "string") {
    const re = schema.format ? FORMATS[schema.format] : undefined;
    if (re && value !== "" && !re.test(value)) out.push(`${path} is not a valid ${schema.format}`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) out.push(`${path} is longer than ${schema.maxLength} characters`);
    if (typeof schema.minLength === "number" && value.length < schema.minLength) out.push(`${path} is shorter than ${schema.minLength} characters`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) out.push(`${path} does not match the pattern ${schema.pattern.slice(0, 40)}`);
      } catch {
        /* a pattern JavaScript cannot read is the file's problem, reported by the audit */
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && (schema.exclusiveMinimum === true ? value <= schema.minimum : value < schema.minimum)) out.push(`${path} is below the minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && (schema.exclusiveMaximum === true ? value >= schema.maximum : value > schema.maximum)) out.push(`${path} is above the maximum ${schema.maximum}`);
  }
  if (actual === "object" && value && typeof value === "object") {
    for (const req of schema.required ?? []) {
      if (!(req in (value as object))) out.push(`${path}.${req} is missing`);
    }
    for (const [k, sub] of Object.entries<Json>(schema.properties ?? {})) {
      if (k in (value as object)) validateSchema(spec, sub, (value as Record<string, unknown>)[k], `${path}.${k}`, out, depth + 1, opts);
    }
    const known = knownFields(spec, schema);
    if (known) {
      const unknown = Object.keys(value as object).filter((k) => !known.has(k)).sort();
      if (unknown.length && schema.additionalProperties === false) out.push(`${path} has fields the file does not allow: ${unknown.slice(0, 4).join(", ")}`);
      else if (unknown.length && opts.extra && opts.extra.length < 20) for (const k of unknown) opts.extra.push(`${path}.${k}`);
    }
  }
  if (actual === "array") {
    const arr = value as unknown[];
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) out.push(`${path} has ${arr.length} items, more than ${schema.maxItems}`);
    if (typeof schema.minItems === "number" && arr.length < schema.minItems) out.push(`${path} has ${arr.length} items, fewer than ${schema.minItems}`);
    // Every item up to 20 (a bad item further down a long list is the same bug as the first ones).
    if (schema.items) arr.slice(0, 20).forEach((v, i) => validateSchema(spec, schema.items, v, `${path}[${i}]`, out, depth + 1, opts));
  }
  return out.slice(0, 5);
}

/** A value that fits a schema: the file's own example when it has one, made up otherwise. */
export function exampleFor(spec: Json, rawSchema: Json, depth = 0, field = ""): Json {
  const schema = deref(spec, rawSchema);
  if (!schema || typeof schema !== "object" || depth > 8) return null;
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s: Json) => exampleFor(spec, s, depth + 1, field)).filter((v: Json) => v && typeof v === "object"));
  if (schema.oneOf || schema.anyOf) return exampleFor(spec, (schema.oneOf ?? schema.anyOf)[0], depth + 1, field);
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== "null") : schema.type;
  if (type === "object" || (!type && schema.properties)) {
    const out: Record<string, Json> = {};
    for (const [k, sub] of Object.entries<Json>(schema.properties ?? {})) {
      const s = deref(spec, sub);
      if (s?.readOnly) continue;
      out[k] = exampleFor(spec, s, depth + 1, k);
    }
    return out;
  }
  if (type === "array") return [exampleFor(spec, schema.items ?? {}, depth + 1, field)];
  if (type === "integer") return typeof schema.minimum === "number" ? Math.max(1, Math.ceil(schema.minimum)) : 1;
  if (type === "number") return typeof schema.minimum === "number" ? Math.max(1, schema.minimum) : 1.5;
  if (type === "boolean") return false;
  const f = schema.format;
  if (f === "date-time") return "2026-01-15T10:00:00Z";
  if (f === "date") return "2026-01-15";
  if (f === "email" || /e-?mail/i.test(field)) return "glv-test@example.com";
  if (f === "uuid") return "00000000-0000-4000-8000-000000000001";
  if (f === "uri" || f === "url") return "https://example.com/glv-test";
  if (/phone|mobile/i.test(field)) return "+919800000000";
  const text = `GLV test ${field || "value"}`.trim();
  const max = typeof schema.maxLength === "number" ? schema.maxLength : 60;
  const min = typeof schema.minLength === "number" ? schema.minLength : 0;
  return text.padEnd(min, "x").slice(0, Math.max(1, max));
}
