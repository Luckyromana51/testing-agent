import YAML from "yaml";

/* Reads an OpenAPI 3 or Swagger 2 file into the GET operations we can safely call. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface ApiOperation {
  method: string;
  path: string;
  /** Address to call, with example values in place of path parameters. */
  url: string;
  title: string;
  /** The spec says this operation needs credentials. */
  secured: boolean;
  /** Documented responses: status code -> schema and content type. */
  responses: Record<string, { schema?: Json; contentType?: string }>;
  /** Why we will not call it (needs a header we do not have, a body, and so on). */
  skip?: string;
}

export interface ParsedSpec {
  version: string;
  title: string;
  baseUrl: string;
  operations: ApiOperation[];
  /** Operations that change data (POST, PUT, PATCH, DELETE). Never called; only counted. */
  writeOperations: number;
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

  for (const [path, rawItem] of Object.entries<Json>(spec.paths)) {
    const item = deref(spec, rawItem);
    if (!item || typeof item !== "object") continue;
    for (const method of ["post", "put", "patch", "delete"]) if (item[method]) writeOperations++;
    const op = item.get;
    if (!op) continue;
    const params: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: Json) => deref(spec, p));
    let skip: string | undefined;
    let url = path;
    const query = new URLSearchParams();
    for (const p of params) {
      if (p.in === "path") {
        const v = exampleValue(spec, p);
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
      if (isV3) {
        const [contentType, media] = Object.entries<Json>(r?.content ?? {})[0] ?? [];
        responses[code] = { contentType, schema: media?.schema };
      } else {
        responses[code] = { contentType: (op.produces ?? spec.produces ?? [])[0], schema: r?.schema };
      }
    }
    const qs = query.toString();
    operations.push({
      method: "GET",
      path,
      url: `${baseUrl}${url}${qs ? `?${qs}` : ""}`,
      title: op.summary ?? op.operationId ?? `GET ${path}`,
      secured,
      responses,
      skip,
    });
  }

  return {
    version: isV3 ? `OpenAPI ${spec.openapi}` : "Swagger 2.0",
    title: spec.info?.title ?? "API",
    baseUrl,
    operations,
    writeOperations,
    hasSecuritySchemes,
    warnings,
  };
}

/**
 * Checks a JSON value against a schema (the common parts of JSON Schema used by OpenAPI:
 * type, required, properties, items, enum, nullable, allOf, oneOf, anyOf). Returns up to 5 problems.
 */
export function validateSchema(spec: Json, rawSchema: Json, value: unknown, path = "$", out: string[] = [], depth = 0): string[] {
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
  if (actual === "object" && value && typeof value === "object") {
    for (const req of schema.required ?? []) {
      if (!(req in (value as object))) out.push(`${path}.${req} is missing`);
    }
    for (const [k, sub] of Object.entries<Json>(schema.properties ?? {})) {
      if (k in (value as object)) validateSchema(spec, sub, (value as Record<string, unknown>)[k], `${path}.${k}`, out, depth + 1);
    }
  }
  if (actual === "array" && schema.items) {
    (value as unknown[]).slice(0, 3).forEach((v, i) => validateSchema(spec, schema.items, v, `${path}[${i}]`, out, depth + 1));
  }
  return out.slice(0, 5);
}
