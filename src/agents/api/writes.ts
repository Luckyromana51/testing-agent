import { readPath } from "../../engines/api-auth.js";
import { realIds } from "../../engines/api-ids.js";
import { deref, exampleFor, fillPath, validateSchema, type ApiOperation, type Json } from "../../engines/openapi.js";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { ApiCall, ApiContext } from "./context.js";
import { documentedResponse, type ApiAgent } from "./shared.js";

/*
 * Test-server mode, like Schemathesis' stateful tests and ReadyAPI's CRUD flows: for each kind
 * of record the file can create, the test creates one from the file's example, reads it back,
 * changes it, deletes it and checks it is gone, checking every answer against the file. It also
 * tries to set fields a client must never set (role, isAdmin, balance: mass assignment), sends
 * empty and wrong-type input, and creates without a login. Everything it made is deleted at the
 * end. It only runs when the project is marked as a test server.
 */

const MAX_RESOURCES = 10;
const good = (c: ApiCall) => c.status !== null && c.status >= 200 && c.status < 300;
const label = (c: ApiCall) => `${c.op.method} ${c.op.path}`;

/** Fields a client must never be able to set, with the value the test tries. */
export const PRIVILEGED: Record<string, Json> = {
  role: "admin",
  isAdmin: true,
  is_admin: true,
  admin: true,
  permissions: ["*"],
  verified: true,
  isVerified: true,
  balance: 999999,
  credit: 999999,
  discount: 100,
};

/** The new record's id: in the answer (id, data.id, _id, uuid) or the Location header. */
function newId(c: ApiCall): string | undefined {
  for (const p of ["id", "_id", "uuid", "data.id", "data._id", "result.id", "item.id"]) {
    const v = readPath(c.json, p);
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  const loc = c.headers.location;
  if (loc) return decodeURIComponent(loc.replace(/\/+$/, "").split("/").pop() ?? "") || undefined;
  return undefined;
}

/** The record in an answer: itself, or under data / item / result. */
function recordOf(json: Json): Record<string, Json> | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  for (const k of ["data", "item", "result", "record"]) if (json[k] && typeof json[k] === "object" && !Array.isArray(json[k])) return json[k];
  return json;
}

function documentedFields(spec: Json, schema: Json): Set<string> {
  const s = deref(spec, schema);
  const out = new Set<string>(Object.keys(s?.properties ?? {}));
  for (const part of s?.allOf ?? []) for (const k of documentedFields(spec, part)) out.add(k);
  return out;
}

function readOnlyFields(spec: Json, schema: Json): string[] {
  const s = deref(spec, schema);
  return Object.entries<Json>(s?.properties ?? {})
    .filter(([, v]) => deref(spec, v)?.readOnly)
    .map(([k]) => k)
    .sort();
}

interface Resource {
  create: ApiOperation;
  detailPath?: string;
  read?: ApiOperation;
  update?: ApiOperation;
  remove?: ApiOperation;
}

/** POST /things with its GET, PUT/PATCH and DELETE /things/{id}. */
export function resources(ops: ApiOperation[], writes: ApiOperation[]): Resource[] {
  const out: Resource[] = [];
  for (const create of writes.filter((o) => o.method === "POST")) {
    const detail = (o: ApiOperation) => o.path.startsWith(`${create.path}/{`) && o.path.slice(create.path.length + 1).split("/").length === 1;
    const read = ops.find(detail);
    const update = writes.find((o) => o.method === "PATCH" && detail(o)) ?? writes.find((o) => o.method === "PUT" && detail(o));
    const remove = writes.find((o) => o.method === "DELETE" && detail(o));
    out.push({ create, detailPath: (read ?? update ?? remove)?.path, read, update, remove });
  }
  return out.slice(0, MAX_RESOURCES);
}

export const apiWritesAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.writes",
  name: "Test-server write tests",
  description:
    "Only on a project marked as a test server: creates a record of each kind from the API file's example, reads it back, changes it and deletes it, checking every answer. Tries mass assignment (role, isAdmin, balance), empty and wrong-type input and creating without a login. Deletes everything it made.",
  category: "functional",
  async run(ctx) {
    const { parsed, spec, testServer, authenticated, log } = ctx;
    if (!testServer) {
      ctx.report.writes = { ran: false, why: "The project is not marked as a test server, so nothing that changes data was sent.", created: 0, cleanedUp: 0, leftOver: [] };
      return [];
    }
    const out: Finding[] = [];
    const made: { id: string; res: Resource; deleted: boolean }[] = [];
    const add = (c: ApiCall, rule: string, severity: Finding["severity"], title: string, detail: string, evidence: string, category: Finding["category"] = "functional") =>
      out.push(finding({ category, rule, severity, title, detail, pageUrl: c.op.url, evidence }));
    const send = async (op: ApiOperation, step: string, body?: Json, values: Record<string, string> = {}, as?: false): Promise<ApiCall> => {
      const ids = Object.fromEntries(Object.entries(realIds(op, ctx.calls)).map(([k, v]) => [k, v.value]));
      const url = op.path.includes("{") ? fillPath(op, parsed.baseUrl, { ...ids, ...values }) : op.url;
      const c = await ctx.send({ method: op.method, url, body, as }, op);
      ctx.extraCalls.push({ call: c, step });
      if (c.status !== null && c.status >= 500) {
        add(c, "api:server-error", "high", "Endpoint fails with a server error", `${label(c)} (${step}) answered HTTP ${c.status}. The server log at the time of the test shows the cause.`, `${step}: HTTP ${c.status}`);
      }
      return c;
    };
    const checkSchema = (c: ApiCall, step: string) => {
      const doc = c.status !== null ? documentedResponse(c.op, c.status) : undefined;
      if (doc?.schema && c.json !== undefined) {
        const problems = validateSchema(spec, doc.schema, c.json);
        if (problems.length) add(c, "api:schema-mismatch", "medium", "Response does not match the API file", `${label(c)} (${step}) sends data in a different shape from the one documented.`, problems.slice(0, 3).join("; "));
      }
    };
    const pathKey = (r: Resource) => /\{([^}]+)\}$/.exec(r.detailPath ?? "")?.[1] ?? "id";

    const list = resources(parsed.operations, parsed.writes);
    log(`Test server: testing ${list.length} kinds of record (create, read, change, delete)`);
    for (const res of list) {
      const op = res.create;
      const schema = op.body?.schema;
      const body = schema ? exampleFor(spec, schema) : {};
      const required: string[] = deref(spec, schema)?.required ?? [];

      // Empty and wrong-type input must be refused with 400 or 422.
      if (required.length) {
        const empty = await send(op, "empty input", {});
        if (good(empty)) {
          add(empty, "api:no-input-validation", "medium", "The API saves records with missing required fields", `${label(empty)} accepted an empty body although the file says ${required.slice(0, 4).join(", ")} ${required.length === 1 ? "is" : "are"} required. Check input on the server and answer 400 or 422.`, "empty body -> 2xx");
          const id = newId(empty);
          if (id) made.push({ id, res, deleted: false });
        }
        const field = required.find((k) => ["integer", "number", "boolean"].includes(String(deref(spec, deref(spec, schema)?.properties?.[k])?.type)));
        if (field && body && typeof body === "object") {
          const wrong = await send(op, "wrong type", { ...body, [field]: "glv-not-a-number" });
          if (good(wrong)) {
            add(wrong, "api:no-input-validation", "medium", "The API saves records with the wrong type of data", `${label(wrong)} accepted "glv-not-a-number" for ${field}, which the file says is a ${deref(spec, deref(spec, schema).properties[field])?.type}. Check types on the server and answer 400 or 422.`, `${field}: text where a number goes -> 2xx`);
            const id = newId(wrong);
            if (id) made.push({ id, res, deleted: false });
          }
        }
      }
      // Creating without a login, when the file says it needs one.
      if (op.secured && authenticated) {
        const anon = await send(op, "no login", body, {}, false);
        if (good(anon)) {
          add(anon, "api:auth-bypass", "critical", "Anyone can create records without a login", `${label(anon)} needs a login in the API file, but it created a record for a request with no credentials. Check the auth middleware covers write routes.`, "create with no credentials -> 2xx", "security");
          const id = newId(anon);
          if (id) made.push({ id, res, deleted: false });
        }
      }

      // Create, with the fields a client must never set added (mass assignment).
      const known = documentedFields(spec, schema);
      const extra = Object.fromEntries(Object.entries(PRIVILEGED).filter(([k]) => !known.has(k)));
      const ro = readOnlyFields(spec, schema);
      const roValues = Object.fromEntries(ro.filter((k) => !/^(id|_id|uuid)$/i.test(k)).map((k) => [k, typeof exampleFor(spec, deref(spec, schema).properties[k]) === "number" ? 987654 : "glv-readonly-test"]));
      const created = await send(op, "create", body && typeof body === "object" && !Array.isArray(body) ? { ...body, ...extra, ...roValues } : body);
      if (!good(created)) {
        if (created.status !== null && created.status < 500) {
          add(created, "api:example-refused", "low", "The API refuses the API file's own example", `${label(created)} answered HTTP ${created.status} to a record built from the file's example. Either the example is out of date, or the file does not say what the server really needs.`, `create from the example -> HTTP ${created.status}`);
        }
        continue;
      }
      checkSchema(created, "create");
      const id = newId(created);
      if (!id) {
        log(`${label(created)}: created, but the answer has no id, so it cannot be read back or cleaned up`);
        add(created, "api:created-no-id", "low", "Creating a record does not say its id", `${label(created)} created a record but its answer has no id field and no Location header, so clients cannot find it again.`, "create -> no id, no Location");
        continue;
      }
      const record = { id, res, deleted: false };
      made.push(record);
      const values = { [pathKey(res)]: id };

      let saved: Record<string, Json> | undefined = recordOf(created.json);
      if (res.read) {
        const back = await send(res.read, "read back", undefined, values);
        if (good(back)) {
          checkSchema(back, "read back");
          saved = recordOf(back.json) ?? saved;
          const sent = body && typeof body === "object" ? (body as Record<string, Json>) : {};
          const lost = Object.entries(sent)
            .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
            .filter(([k, v]) => saved && k in saved && saved[k] !== v)
            .map(([k]) => k)
            .sort();
          if (lost.length) {
            add(back, "api:write-not-saved", "medium", "A new record does not keep what was sent", `${label(back)} returns different values from the ones just created for ${lost.slice(0, 4).join(", ")}.`, `changed on save: ${lost.slice(0, 4).join(", ")}`);
          }
        } else if (back.status === 404) {
          add(back, "api:created-not-found", "medium", "A record just created cannot be read", `${label(created)} answered ${created.status} with id ${id}, but ${label(back)} answers 404 for it.`, "create -> read back 404");
        }
      }
      if (saved) {
        const taken = Object.entries(extra)
          .filter(([k, v]) => JSON.stringify(saved![k]) === JSON.stringify(v))
          .map(([k]) => k)
          .sort();
        if (taken.length) {
          add(
            created,
            "api:mass-assignment",
            "high",
            "Clients can set fields they should never control (mass assignment)",
            `${label(created)} saved ${taken.join(", ")} from the request although the API file does not list them. A user could make themselves an admin or change their balance. Copy only the allowed fields from the request (an allow-list or a DTO), never the whole body (OWASP API3).`,
            `saved from the request: ${taken.join(", ")}`,
            "security",
          );
        }
        const roTaken = Object.entries(roValues)
          .filter(([k, v]) => saved![k] === v)
          .map(([k]) => k)
          .sort();
        if (roTaken.length) {
          add(created, "api:readonly-writable", "medium", "Fields the file marks read-only can be set by clients", `${label(created)} kept the values sent for ${roTaken.join(", ")}, which the file marks readOnly (set by the server).`, `read-only fields set: ${roTaken.join(", ")}`, "security");
        }
      }

      if (res.update) {
        const props = Object.entries<Json>(deref(spec, res.update.body?.schema ?? schema)?.properties ?? {});
        const field = props.find(([k, v]) => deref(spec, v)?.type === "string" && !deref(spec, v)?.readOnly && !deref(spec, v)?.enum && !deref(spec, v)?.format && !(k in extra))?.[0];
        if (field) {
          const change = res.update.method === "PATCH" ? { [field]: "GLV test updated" } : { ...(body as object), [field]: "GLV test updated" };
          const upd = await send(res.update, "change", change, values);
          if (good(upd)) {
            checkSchema(upd, "change");
            if (res.read) {
              const again = await send(res.read, "read after change", undefined, values);
              const rec = recordOf(again.json);
              if (good(again) && rec && field in rec && rec[field] !== "GLV test updated") {
                add(upd, "api:update-not-saved", "medium", "A change is accepted but not saved", `${label(upd)} answered ${upd.status}, but ${label(again)} still shows the old ${field}.`, `${field} not changed after ${res.update.method}`);
              }
            }
          }
        }
      }
      if (res.remove) {
        const del = await send(res.remove, "delete", undefined, values);
        if (good(del)) {
          record.deleted = true;
          if (res.read) {
            const gone = await send(res.read, "read after delete", undefined, values);
            if (good(gone)) {
              add(del, "api:delete-not-deleted", "medium", "A deleted record can still be read", `${label(del)} answered ${del.status}, but ${label(gone)} still returns the record. If records are only hidden (soft delete), the read endpoint must hide them too.`, "delete -> read still 200");
            }
          }
        }
      }
    }

    // Clean-up: every record made is deleted, even when a step failed.
    let cleaned = made.filter((m) => m.deleted).length;
    const leftOver: string[] = [];
    for (const m of made.filter((x) => !x.deleted)) {
      if (m.res.remove) {
        const c = await send(m.res.remove, "clean-up", undefined, { [pathKey(m.res)]: m.id });
        if (good(c) || c.status === 404) {
          m.deleted = true;
          cleaned++;
          continue;
        }
      }
      leftOver.push(`${m.res.create.path}/${m.id}`);
    }
    ctx.report.writes = { ran: true, created: made.length, cleanedUp: cleaned, leftOver: leftOver.sort() };
    if (leftOver.length) {
      out.push(
        finding({
          category: "functional",
          rule: "api:test-data-left",
          severity: "info",
          title: "Test records that could not be deleted",
          detail: `The test made ${leftOver.length} record${leftOver.length === 1 ? "" : "s"} it could not delete (no DELETE endpoint, or it was refused). Remove them on the test server; they all have "GLV test" in their text.`,
          pageUrl: parsed.baseUrl,
          evidence: [...new Set(made.filter((m) => !m.deleted).map((m) => `POST ${m.res.create.path}`))].sort().join("\n"),
        }),
      );
    }
    return out;
  },
};

export type { ApiContext };
