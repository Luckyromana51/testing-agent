import { deref, type Json } from "../../engines/openapi.js";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { ApiAgent } from "./shared.js";

/*
 * The API file audit: our own Spectral-style rule set, with the OWASP API Security rules
 * (like 42Crunch's audit), checked on the file alone. Each rule is one finding listing where it
 * breaks (up to 6 places, in file order), so the same file always gives the same result.
 */

interface Rule {
  id: string;
  severity: Finding["severity"];
  category: Finding["category"];
  title: string;
  fix: string;
  /** Points off the file score when it breaks. */
  weight: number;
}

const RULES: Rule[] = [
  { id: "write-no-security", severity: "medium", category: "security", weight: 15, title: "Operations that change data need no login in the API file", fix: "Add a security requirement to every POST, PUT, PATCH and DELETE (or once at the top of the file)." },
  { id: "oauth-implicit", severity: "medium", category: "security", weight: 10, title: "The API file uses the OAuth2 implicit flow", fix: "The implicit flow puts tokens in the browser's address and is deprecated (OAuth 2.1). Use the authorization code flow with PKCE." },
  { id: "key-in-query", severity: "medium", category: "security", weight: 10, title: "API keys are sent in the address", fix: "Addresses end up in server logs, proxies and browser history. Send the key in a header (X-API-Key) instead." },
  { id: "http-server", severity: "medium", category: "security", weight: 10, title: "The API file lists a plain http server", fix: "List only https:// servers so clients never send tokens unencrypted." },
  { id: "basic-auth", severity: "low", category: "security", weight: 5, title: "The API file uses basic login (user name and password on every call)", fix: "Basic login sends the password with every request. Use tokens (OAuth2 or a signed API key) that can expire and be revoked." },
  { id: "bad-ref", severity: "medium", category: "functional", weight: 10, title: "The API file points to definitions that do not exist", fix: "Each $ref must point to a schema, parameter or response that is in the file; code generators stop at a broken one." },
  { id: "path-param-undefined", severity: "medium", category: "functional", weight: 8, title: "Path parameters that the API file never describes", fix: "Every {name} in a path needs a parameter with in: path and required: true." },
  { id: "no-4xx", severity: "low", category: "functional", weight: 5, title: "Operations that document no error answers", fix: "Document at least one 4xx answer (400, 404, 422...) with its error format, so clients can handle errors." },
  { id: "secured-no-401", severity: "low", category: "security", weight: 4, title: "Operations that need a login but do not document 401 or 403", fix: "Document what a refused login returns (401, and 403 for no access)." },
  { id: "string-no-limit", severity: "low", category: "security", weight: 5, title: "Text inputs with no length limit", fix: "Give every string parameter and request field a maxLength (and a pattern or format where it fits), so oversized input is refused early (OWASP API4)." },
  { id: "array-no-limit", severity: "low", category: "security", weight: 4, title: "List inputs with no size limit", fix: "Give request arrays a maxItems, so one request cannot carry millions of items (OWASP API4)." },
  { id: "number-no-limit", severity: "low", category: "security", weight: 3, title: "Number inputs with no minimum or maximum", fix: "Give integer and number parameters a minimum and maximum (page sizes, amounts, quantities)." },
  { id: "list-no-paging", severity: "low", category: "performance", weight: 4, title: "List endpoints with no paging", fix: "Lists should take a limit (with a maximum) and a page or cursor, so one call never returns the whole table." },
  { id: "body-open", severity: "low", category: "security", weight: 4, title: "Request bodies accept any extra field", fix: "Set additionalProperties: false on request bodies, and mark server-set fields readOnly, so clients cannot set fields like role or isAdmin (mass assignment, OWASP API3)." },
  { id: "get-with-body", severity: "low", category: "functional", weight: 3, title: "GET operations with a request body", fix: "Many clients and proxies drop the body of a GET. Use query parameters, or POST for searches." },
  { id: "bad-pattern", severity: "low", category: "functional", weight: 3, title: "Patterns that are not valid regular expressions", fix: "Fix the pattern so clients and servers can check input with it." },
  { id: "no-operation-id", severity: "low", category: "functional", weight: 3, title: "Operations without an operationId", fix: "Code generators name functions after operationId. Give each operation a unique one." },
  { id: "no-rate-limit-doc", severity: "info", category: "functional", weight: 2, title: "The API file does not mention rate limits", fix: "Document the 429 answer and the RateLimit or Retry-After headers so clients can slow down." },
  { id: "no-description", severity: "info", category: "functional", weight: 2, title: "Operations with no summary or description", fix: "A one-line summary per operation makes the docs and generated clients readable." },
  { id: "no-examples", severity: "info", category: "functional", weight: 2, title: "Answers with no example", fix: "Examples show client developers real data and let a mock server answer like the real API." },
  { id: "verbs-in-path", severity: "info", category: "functional", weight: 1, title: "Paths named after actions", fix: "REST paths name things (/orders) and the method says the action (POST /orders), not /createOrder." },
  { id: "mixed-naming", severity: "info", category: "functional", weight: 1, title: "Paths mix naming styles", fix: "Pick one style for path words (kebab-case is the most common) and use it everywhere." },
  { id: "trailing-slash", severity: "info", category: "functional", weight: 1, title: "Paths ending in a slash", fix: "/users and /users/ are different addresses on many servers. Drop the trailing slash." },
  { id: "no-tags", severity: "info", category: "functional", weight: 1, title: "Operations with no tag", fix: "Tags group operations in the docs (Users, Orders)." },
  { id: "unused-schemas", severity: "info", category: "functional", weight: 1, title: "Schemas the API file never uses", fix: "Remove them or use them, so the file stays easy to read." },
  { id: "no-contact", severity: "info", category: "functional", weight: 1, title: "The API file has no contact or version details", fix: "info.contact and a real info.version tell clients who to ask and which version they use." },
];

export const AUDIT_RULES = RULES.length;
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

/** Every $ref string in the file, with where it is. */
function refs(node: Json, at: string, out: { ref: string; at: string }[], depth = 0) {
  if (!node || typeof node !== "object" || depth > 40 || out.length > 5000) return;
  if (typeof node.$ref === "string") out.push({ ref: node.$ref, at });
  for (const [k, v] of Object.entries(node)) if (k !== "$ref") refs(v, `${at}/${k}`, out, depth + 1);
}

/** The request fields of a schema, one level deep into objects and arrays. */
function fields(spec: Json, schema: Json, name: string, out: { name: string; schema: Json }[], depth = 0) {
  const s = deref(spec, schema);
  if (!s || typeof s !== "object" || depth > 4 || out.length > 200) return;
  for (const part of [...(s.allOf ?? [])]) fields(spec, part, name, out, depth + 1);
  if (s.type === "object" || s.properties) {
    for (const [k, v] of Object.entries<Json>(s.properties ?? {})) {
      const d = deref(spec, v);
      if (d?.readOnly) continue;
      out.push({ name: `${name}.${k}`, schema: d });
      if (d && (d.type === "object" || d.type === "array" || d.properties)) fields(spec, d, `${name}.${k}`, out, depth + 1);
    }
  } else if (s.type === "array" && s.items) {
    fields(spec, s.items, `${name}[]`, out, depth + 1);
  }
}

export interface AuditResult {
  score: number;
  hits: Map<string, string[]>;
}

export function auditSpec(spec: Json): AuditResult {
  const hits = new Map<string, string[]>();
  const hit = (id: string, where: string) => {
    const list = hits.get(id) ?? [];
    if (!list.includes(where)) list.push(where);
    hits.set(id, list);
  };
  const isV3 = typeof spec?.openapi === "string";
  const schemes: Record<string, Json> = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  for (const [name, raw] of Object.entries<Json>(schemes)) {
    const sc = deref(spec, raw);
    if (sc?.type === "apiKey" && sc.in === "query") hit("key-in-query", `${name} (${sc.name})`);
    if ((sc?.type === "http" && /^basic$/i.test(sc.scheme ?? "")) || sc?.type === "basic") hit("basic-auth", name);
    if (sc?.type === "oauth2" && (sc.flows?.implicit || sc.flow === "implicit")) hit("oauth-implicit", name);
  }
  for (const s of spec.servers ?? []) {
    const url = String(s?.url ?? "");
    if (/^http:\/\//i.test(url) && !/^http:\/\/(localhost|127\.|\[::1\])/i.test(url)) hit("http-server", url);
  }
  if (spec.swagger === "2.0" && (spec.schemes ?? []).includes("http") && !/^(localhost|127\.)/.test(spec.host ?? "")) hit("http-server", `http://${spec.host ?? ""}`);
  if (!spec.info?.contact || !spec.info?.version || spec.info.version === "imported") hit("no-contact", "info");

  // References that lead nowhere.
  const allRefs: { ref: string; at: string }[] = [];
  refs(spec, "#", allRefs);
  const used = new Set<string>();
  for (const r of allRefs) {
    if (!r.ref.startsWith("#/")) continue;
    used.add(r.ref);
    const target = r.ref
      .slice(2)
      .split("/")
      .reduce((o: Json, k: string) => (o ? o[k.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), spec);
    if (target === undefined) hit("bad-ref", r.ref);
  }
  const schemaRoot = isV3 ? "#/components/schemas/" : "#/definitions/";
  for (const name of Object.keys((isV3 ? spec.components?.schemas : spec.definitions) ?? {})) {
    if (![...used].some((u) => u === `${schemaRoot}${name}`)) hit("unused-schemas", name);
  }

  const globalSecurity: Json[] = spec.security ?? [];
  let mentions429 = false;
  const styles = new Set<string>();
  for (const [path, rawItem] of Object.entries<Json>(spec.paths ?? {})) {
    const item = deref(spec, rawItem);
    if (!item || typeof item !== "object") continue;
    if (path.length > 1 && path.endsWith("/")) hit("trailing-slash", path);
    for (const word of path.split("/").filter((w) => w && !w.startsWith("{"))) {
      if (/^(get|create|update|delete|remove|add|fetch|list|set|do)[A-Z_-]/.test(word)) hit("verbs-in-path", path);
      if (/[a-z][A-Z]/.test(word)) styles.add("camelCase");
      else if (word.includes("_")) styles.add("snake_case");
      else if (word.includes("-")) styles.add("kebab-case");
    }
    const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      const label = `${method.toUpperCase()} ${path}`;
      const params: Json[] = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p: Json) => deref(spec, p)).filter(Boolean);
      for (const name of pathParams) if (!params.some((p) => p.in === "path" && p.name === name)) hit("path-param-undefined", `${label} {${name}}`);
      if (!op.operationId) hit("no-operation-id", label);
      if (!op.summary && !op.description) hit("no-description", label);
      if (!op.tags?.length) hit("no-tags", label);
      const codes = Object.keys(op.responses ?? {});
      if (codes.includes("429")) mentions429 = true;
      if (method !== "head" && method !== "options" && codes.length && !codes.some((c) => /^4/.test(c)) && !codes.includes("default")) hit("no-4xx", label);
      const security: Json[] = op.security ?? globalSecurity;
      const secured = security.length > 0 && !security.some((s: Json) => s && Object.keys(s).length === 0);
      if (secured && codes.length && !codes.some((c) => c === "401" || c === "403" || c === "4XX" || c === "default")) hit("secured-no-401", label);
      if (["post", "put", "patch", "delete"].includes(method) && !secured) hit("write-no-security", label);
      for (const p of params) {
        const sc = deref(spec, p.schema ?? p);
        if (p.in === "path" || p.in === "query") {
          if (sc?.type === "string" && !sc.enum && sc.maxLength === undefined && !sc.format && !sc.pattern) hit("string-no-limit", `${label} ${p.name}`);
          if ((sc?.type === "integer" || sc?.type === "number") && (sc.maximum === undefined || sc.minimum === undefined) && !sc.enum) hit("number-no-limit", `${label} ${p.name}`);
        }
        if (typeof sc?.pattern === "string") {
          try {
            new RegExp(sc.pattern, "u");
          } catch {
            hit("bad-pattern", `${label} ${p.name}`);
          }
        }
      }
      // Lists: an array answer and no limit-like parameter.
      const ok = deref(spec, op.responses?.["200"]);
      const okSchema = deref(spec, isV3 ? (Object.values<Json>(ok?.content ?? {})[0] as Json)?.schema : ok?.schema);
      if (method === "get" && okSchema?.type === "array" && !params.some((p) => p.in === "query" && /^(limit|per_?page|page_?size|size|count|top|first|take|max(_?results)?|cursor|page|offset)$/i.test(p.name))) hit("list-no-paging", label);
      if (ok && isV3 && Object.values<Json>(ok.content ?? {}).length && !Object.values<Json>(ok.content ?? {}).some((m) => m?.example !== undefined || m?.examples || deref(spec, m?.schema)?.example !== undefined)) hit("no-examples", label);
      const rb = isV3 ? deref(spec, op.requestBody) : params.find((p) => p.in === "body");
      if (rb) {
        if (method === "get") hit("get-with-body", label);
        const schema = isV3 ? (Object.values<Json>(rb.content ?? {})[0] as Json)?.schema : rb.schema;
        const s = deref(spec, schema);
        if (s && (s.type === "object" || s.properties) && s.additionalProperties !== false) hit("body-open", label);
        const list: { name: string; schema: Json }[] = [];
        fields(spec, schema, "body", list);
        for (const f of list) {
          if (f.schema?.type === "string" && !f.schema.enum && f.schema.maxLength === undefined && !f.schema.format) hit("string-no-limit", `${label} ${f.name}`);
          if (f.schema?.type === "array" && f.schema.maxItems === undefined) hit("array-no-limit", `${label} ${f.name}`);
          if (typeof f.schema?.pattern === "string") {
            try {
              new RegExp(f.schema.pattern, "u");
            } catch {
              hit("bad-pattern", `${label} ${f.name}`);
            }
          }
        }
      }
    }
  }
  if (styles.size > 1) hit("mixed-naming", [...styles].sort().join(", "));
  if (!mentions429 && Object.keys(spec.paths ?? {}).length) hit("no-rate-limit-doc", "responses");
  let score = 100;
  for (const r of RULES) if (hits.has(r.id)) score -= r.weight;
  return { score: Math.max(0, score), hits };
}

export const apiAuditAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.audit",
  name: "API file audit",
  description:
    "Checks the API file against 26 rules, with the OWASP API Security ones: logins on write operations, keys in addresses, size limits on inputs, paging, mass-assignment-safe bodies, broken references, error answers, examples and naming. Gives the file a score.",
  category: "functional",
  run(ctx) {
    const { spec, specUrl } = ctx;
    const { score, hits } = auditSpec(spec);
    ctx.report.audit = { score, failed: hits.size, rules: RULES.length };
    const out: Finding[] = [];
    for (const r of RULES) {
      const where = hits.get(r.id);
      if (!where) continue;
      out.push(
        finding({
          category: r.category,
          rule: `api:audit-${r.id}`,
          severity: r.severity,
          title: r.title,
          detail: `${where.length === 1 ? "1 place" : `${where.length} places`} in the API file. ${r.fix}`,
          pageUrl: specUrl,
          evidence: where.slice(0, 6).join("\n") + (where.length > 6 ? `\nand ${where.length - 6} more` : ""),
        }),
      );
    }
    return out;
  },
};
