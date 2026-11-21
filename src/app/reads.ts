/**
 * Calls sent with POST that only read. Odoo, ERPNext, Salesforce Lightning and GraphQL apps load
 * their screens this way, so a test that stops every POST sees them empty. These pass the read-only
 * guard, and the access grid sends them again as each account (like Burp's Autorize). Anything that
 * is not plainly a read (a GraphQL mutation, an Odoo button, a Frappe save) is still stopped.
 */

/** Odoo model methods that only read (and onchange, which works out values without saving). */
const ODOO_READS = new Set([
  "search_read",
  "web_search_read",
  "read",
  "web_read",
  "search",
  "search_count",
  "name_search",
  "name_get",
  "fields_get",
  "read_group",
  "web_read_group",
  "read_progress_bar",
  "get_views",
  "load_views",
  "default_get",
  "onchange",
  "check_access_rights",
  "has_group",
  "get_formview_id",
  "get_formview_action",
  "search_panel_select_range",
  "search_panel_select_multi_range",
  "get_empty_list_help",
  "web_name_search",
]);
/** Odoo routes that only read. */
const ODOO_ROUTES = /^\/(web\/action\/load|web\/session\/get_session_info|web\/webclient\/(load_menus|translations|version_info|bootstrap_translations)|web\/dataset\/search_read|mail\/(init_messaging|thread\/data|thread\/messages|load_message_failures)|longpolling\/poll|bus\/(poll|im_status)|web\/bundle\/)/;
/** JSON-RPC and Frappe method names that read: get, list, search, load, fetch, count, describe... */
const READ_NAME = /^(get|list|search|find|fetch|load|read|query|count|describe|show|lookup|validate_link|getdoc|getdoctype)(_|[A-Z]|$)/;
const AURA = /\/(s\/sfsites\/)?aura$/;

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** A GraphQL document that only asks: no mutation and no subscription. */
function graphqlQuery(doc: unknown): string | undefined {
  if (typeof doc !== "string" || !doc.trim()) return undefined;
  const text = doc.replace(/#[^\n]*/g, "").replace(/"""[\s\S]*?"""|"(?:[^"\\]|\\.)*"/g, '""');
  if (/\b(mutation|subscription)\b\s*[\w({@]/.test(text)) return undefined;
  const name = /\bquery\s+(\w+)/.exec(text)?.[1];
  return name ? `GraphQL query ${name}` : "GraphQL query";
}

/**
 * What a POST call reads, if it only reads: "GraphQL query Contacts", "Odoo search_read on
 * res.partner", "Frappe frappe.client.get_list". Undefined when it may change something.
 */
export function safeRead(method: string, url: string, body?: string | null, contentType = ""): string | undefined {
  if (method !== "POST" || !body) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const path = u.pathname.replace(/\/+$/, "");
  const ct = contentType.toLowerCase();

  // GraphQL: one query or a batch of queries.
  if (/graphql/i.test(path) || /^\s*[[{]\s*"(query|operationName)"/.test(body)) {
    const json = ct.includes("graphql") ? { query: body } : parseJson(body);
    const ops = Array.isArray(json) ? json : [json];
    if (!ops.length || ops.length > 20) return undefined;
    const names = ops.map((o) => graphqlQuery((o as { query?: unknown } | undefined)?.query));
    return names.every(Boolean) ? (names.length === 1 ? names[0] : `${names.length} GraphQL queries`) : undefined;
  }

  // Odoo: JSON-RPC to /web/dataset/call_kw with a model method that only reads.
  if (/^\/web\/dataset\/call_kw(\/|$)/.test(path)) {
    const p = (parseJson(body) as { params?: { model?: string; method?: string } } | undefined)?.params;
    return p?.method && ODOO_READS.has(p.method) ? `Odoo ${p.method}${p.model ? ` on ${p.model}` : ""}` : undefined;
  }
  if (ODOO_ROUTES.test(path)) return `Odoo ${path.split("/").slice(1, 4).join("/")}`;

  // Frappe and ERPNext: /api/method/frappe.client.get_list and the like.
  const frappe = /^\/api\/method\/([\w.]+)$/.exec(path);
  if (frappe) {
    const last = frappe[1].split(".").at(-1) ?? "";
    return READ_NAME.test(last) && !/^(get_?(token|password|api_?key|secret))/.test(last) ? `Frappe ${frappe[1]}` : undefined;
  }

  // Salesforce Lightning (Aura): every action in the message must be a getter.
  if (AURA.test(path)) {
    const message = new URLSearchParams(body).get("message");
    const actions = (parseJson(message ?? "") as { actions?: { descriptor?: string }[] } | undefined)?.actions;
    if (!actions?.length) return undefined;
    const names = actions.map((a) => /ACTION\$(\w+)$/.exec(a.descriptor ?? "")?.[1] ?? "");
    return names.every((n) => READ_NAME.test(n)) ? `Salesforce ${names.slice(0, 3).join(", ")}` : undefined;
  }

  // Any JSON-RPC 2.0 call whose method reads.
  const rpc = parseJson(body) as { jsonrpc?: string; method?: string } | undefined;
  if (rpc && rpc.jsonrpc === "2.0" && typeof rpc.method === "string") {
    const last = rpc.method.split(/[./]/).at(-1) ?? "";
    return READ_NAME.test(last) ? `JSON-RPC ${rpc.method}` : undefined;
  }

  // Search endpoints (Elasticsearch, HubSpot and other "search" APIs) only read.
  if (/\/(_search|_msearch|_count|search)$/.test(path) && (ct.includes("json") || /^\s*[[{]/.test(body))) return `Search ${path.split("/").slice(-2).join("/")}`;
  return undefined;
}

/** The query that asks a GraphQL server for its whole schema (types and fields). */
export const INTROSPECTION = JSON.stringify({ query: "query GlvSchemaCheck { __schema { queryType { name } types { name } } }" });
