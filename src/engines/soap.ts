import { request as playwrightRequest, type APIRequestContext } from "playwright";
import { CouldNotTestError } from "../runner/coverage.js";
import { tellCall } from "../runner/live-code.js";
import { validateTarget } from "../runner/urls.js";
import type { ApiCallView, Finding, Login, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { resolveAuth, type AuthParts } from "./api-auth.js";
import { leakFindings, protocolResult, protoFinding, READ_NAME } from "./protocol.js";
import { escapeXml, find, findAll, kids, parseXml, textOf, type XmlNode } from "./xml.js";

/*
 * SOAP web services, like SoapUI's basic checks: reads the WSDL, makes a request for each
 * operation from its schema, and calls the operations whose names say they only read (GetOrder,
 * ListCustomers...). Operations that change data are listed but never called on a live service.
 * Checks: plain http, faults that show stack traces, faults sent with HTTP 200, the service
 * answering without the saved login, the WSDL open to anyone, and slow operations.
 */

export interface SoapOperation {
  name: string;
  /** SOAPAction header. */
  action: string;
  /** "1.1" or "1.2". */
  version: "1.1" | "1.2";
  endpoint: string;
  /** Document/literal: the request's root element and its namespace. */
  element: string;
  ns: string;
  /** The request's child fields, with an example value each. */
  fields: { name: string; value: string }[];
  style: "document" | "rpc";
}

export interface Wsdl {
  service: string;
  targetNamespace: string;
  operations: SoapOperation[];
}

const SAMPLE: Record<string, string> = {
  string: "test",
  int: "1",
  integer: "1",
  long: "1",
  short: "1",
  decimal: "1.00",
  double: "1.0",
  float: "1.0",
  boolean: "false",
  date: "2026-01-15",
  dateTime: "2026-01-15T10:00:00Z",
  time: "10:00:00",
  base64Binary: "dGVzdA==",
  anyURI: "https://example.com",
};
const sample = (type: string | undefined, name: string) => {
  const t = (type ?? "string").split(":").pop()!;
  if (/id$/i.test(name) && /int|long/.test(t)) return "1";
  return SAMPLE[t] ?? "test";
};

/** The element's fields (one level), from the inline or named complex type. */
function fieldsOf(schemaRoot: XmlNode[], elementName: string): { name: string; value: string }[] {
  const elements = schemaRoot.flatMap((s) => kids(s, "element"));
  const el = elements.find((e) => e.attrs.name === elementName);
  if (!el) return [];
  let complex = find(el, "complexType");
  if (!complex && el.attrs.type) {
    const t = el.attrs.type.split(":").pop();
    complex = schemaRoot.flatMap((s) => kids(s, "complexType")).find((c) => c.attrs.name === t);
  }
  if (!complex) return [];
  return findAll(complex, "element")
    .filter((e) => e.attrs.name)
    .slice(0, 30)
    .map((e) => ({ name: e.attrs.name, value: sample(e.attrs.type, e.attrs.name) }));
}

/** Reads a WSDL 1.1 file: the service, its address, and each operation's request. */
export function parseWsdl(text: string, wsdlUrl: string): Wsdl {
  const doc = parseXml(text);
  if (doc.local !== "definitions") throw new Error("This is not a WSDL 1.1 file (no <definitions>).");
  const tns = doc.attrs.targetNamespace ?? "";
  const schemas = findAll(doc, "schema");
  const messages = new Map(kids(doc, "message").map((m) => [m.attrs.name, m]));
  const portTypes = new Map(kids(doc, "portType").map((p) => [p.attrs.name, p]));
  const service = kids(doc, "service")[0];
  const ports = service ? kids(service, "port") : [];
  const bindings = new Map(kids(doc, "binding").map((b) => [b.attrs.name, b]));
  const out: SoapOperation[] = [];
  const seen = new Set<string>();
  // SOAP 1.1 ports first: they are the most widely served.
  const sorted = [...ports].sort((a, b) => Number(Boolean(find(a, "address")?.name.startsWith("soap12"))) - Number(Boolean(find(b, "address")?.name.startsWith("soap12"))));
  for (const port of sorted) {
    const address = port.children.find((c) => c.local === "address");
    if (!address?.attrs.location) continue;
    const version = /soap12/i.test(address.name) || Object.entries(doc.attrs).some(([k, v]) => k === `xmlns:${address.name.split(":")[0]}` && /soap12/.test(v)) ? "1.2" : "1.1";
    const binding = bindings.get((port.attrs.binding ?? "").split(":").pop()!);
    if (!binding) continue;
    const style = (find(binding, "binding")?.attrs.style as "rpc" | "document") ?? "document";
    const portType = portTypes.get((binding.attrs.type ?? "").split(":").pop()!);
    for (const bop of kids(binding, "operation")) {
      const name = bop.attrs.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const action = bop.children.find((c) => c.local === "operation")?.attrs.soapAction ?? "";
      const pop = portType && kids(portType, "operation").find((o) => o.attrs.name === name);
      const inMsg = pop && messages.get((kids(pop, "input")[0]?.attrs.message ?? "").split(":").pop()!);
      const part = inMsg ? kids(inMsg, "part")[0] : undefined;
      let element = name;
      let fields: SoapOperation["fields"] = [];
      if (part?.attrs.element) {
        element = part.attrs.element.split(":").pop()!;
        fields = fieldsOf(schemas, element);
      } else if (inMsg) {
        fields = kids(inMsg, "part").map((p) => ({ name: p.attrs.name, value: sample(p.attrs.type, p.attrs.name) }));
      }
      out.push({ name, action, version, endpoint: new URL(address.attrs.location, wsdlUrl).href, element, ns: tns, fields, style });
    }
  }
  if (!out.length) throw new Error("The WSDL lists no operations with a SOAP address.");
  return { service: service?.attrs.name ?? doc.attrs.name ?? "SOAP service", targetNamespace: tns, operations: out };
}

/** The request envelope for an operation, with example values. */
export function envelope(op: SoapOperation, values?: Record<string, string>): string {
  const env = op.version === "1.2" ? "http://www.w3.org/2003/05/soap-envelope" : "http://schemas.xmlsoap.org/soap/envelope/";
  const body = op.fields.map((f) => `<tns:${f.name}>${escapeXml(values?.[f.name] ?? f.value)}</tns:${f.name}>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${env}" xmlns:tns="${escapeXml(op.ns)}"><soap:Body><tns:${op.element}>${body}</tns:${op.element}></soap:Body></soap:Envelope>`;
}

/** A SOAP fault in an answer: its code and message. */
export function faultOf(text: string): { code: string; message: string } | undefined {
  try {
    const doc = parseXml(text);
    const fault = find(doc, "Fault");
    if (!fault) return undefined;
    return { code: textOf(find(fault, "faultcode") ?? find(fault, "Code")), message: textOf(find(fault, "faultstring") ?? find(fault, "Reason")).slice(0, 300) };
  } catch {
    return undefined;
  }
}

interface Sent {
  status: number | null;
  ms: number;
  text: string;
  headers: Record<string, string>;
  error?: string;
}

async function send(request: APIRequestContext, op: SoapOperation, body: string, auth: AuthParts | undefined): Promise<Sent> {
  const headers: Record<string, string> =
    op.version === "1.2"
      ? { "content-type": `application/soap+xml; charset=utf-8; action="${op.action}"` }
      : { "content-type": "text/xml; charset=utf-8", soapaction: `"${op.action}"` };
  Object.assign(headers, auth?.headers ?? {});
  const started = Date.now();
  let out: Sent;
  try {
    const u = new URL(op.endpoint);
    if (auth?.query) u.searchParams.set(auth.query[0], auth.query[1]);
    const url = u.href;
    const res = await request.post(url, { data: body, headers, timeout: 20_000, failOnStatusCode: false, maxRedirects: 0 });
    out = { status: res.status(), ms: Date.now() - started, text: (await res.text()).slice(0, 200_000), headers: res.headers() };
  } catch (err) {
    out = { status: null, ms: Date.now() - started, text: "", headers: {}, error: (err as Error).message.split("\n")[0] };
  }
  tellCall({ method: "POST", url: op.endpoint, headers, body, queryKey: auth?.query?.[0] }, { status: out.status, ms: out.ms, error: out.error });
  return out;
}

export interface SoapScanOptions {
  wsdlUrl: string;
  auth?: Login;
  testServer?: boolean;
  onProgress?: (m: string) => void;
  signal?: AbortSignal;
}

export async function scanSoap(opts: SoapScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const wsdlUrl = validateTarget(opts.wsdlUrl);
  const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
  const request = await playwrightRequest.newContext({
    ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
    userAgent: "GLVTestingAgent/0.5 (SOAP test)",
  });
  try {
    const { parts: auth } = await resolveAuth(request, opts.auth, log);
    const findings: Finding[] = [];
    const mk = protoFinding("api.soap", wsdlUrl);
    const add = (...a: Parameters<typeof mk>) => void findings.push(mk(...a));
    log("Reading the WSDL");
    let res = await request.get(wsdlUrl, { timeout: 30_000, failOnStatusCode: false }).catch((err: Error) => {
      throw new CouldNotTestError(`Could not test the SOAP service: the WSDL did not download (${err.message.split("\n")[0]}).`);
    });
    const openWsdl = res.status() < 400;
    if (!openWsdl && opts.auth) res = await request.get(wsdlUrl, { headers: auth.headers, timeout: 30_000, failOnStatusCode: false });
    if (res.status() >= 400) throw new CouldNotTestError(`Could not test the SOAP service: the WSDL at ${wsdlUrl} answered HTTP ${res.status()}.`);
    let wsdl: Wsdl;
    try {
      wsdl = parseWsdl(await res.text(), wsdlUrl);
    } catch (err) {
      throw new Error(`The WSDL could not be read: ${(err as Error).message}`);
    }
    for (const op of wsdl.operations) validateTarget(op.endpoint);
    const reads = wsdl.operations.filter((o) => READ_NAME.test(o.name));
    const writes = wsdl.operations.filter((o) => !READ_NAME.test(o.name));
    log(`${wsdl.service}: ${wsdl.operations.length} operations (${reads.length} that read)`);
    if (openWsdl && opts.auth) add("api:soap-wsdl-public", "low", "Anyone can download the service's WSDL", "The WSDL (the full list of operations and fields) downloads without a login, while the service needs one. On a live server it maps the service for attackers. Serve it only to signed-in callers, or not at all in production.", wsdlUrl);

    const views: ApiCallView[] = [];
    const view = (op: SoapOperation, body: string, r: Sent, step?: string): ApiCallView => {
      const f = r.text ? faultOf(r.text) : undefined;
      const v: ApiCallView = {
        method: "POST",
        path: op.name,
        url: op.endpoint,
        status: r.status,
        ms: r.ms,
        bytes: r.text.length,
        contentType: r.headers["content-type"] ?? "",
        requestHeaders: { "content-type": op.version === "1.2" ? "application/soap+xml" : "text/xml", ...(op.version === "1.1" ? { soapaction: `"${op.action}"` } : {}), ...Object.fromEntries(Object.keys(auth.headers).map((k) => [k, "[hidden]"])) },
        requestBody: body.slice(0, 8000),
        responseHeaders: Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^(content-type|server|x-powered-by|x-aspnet-version)$/i.test(k))),
        body: r.text.slice(0, 8000),
        ...(f ? { problems: [`SOAP fault ${f.code}: ${f.message}`] } : {}),
        ...(r.error ? { error: r.error } : {}),
        ...(step ? { step } : {}),
      };
      views.push(v);
      return v;
    };

    const toCall = (opts.testServer ? wsdl.operations : reads).slice(0, 40);
    const answered: { op: SoapOperation; r: Sent }[] = [];
    for (const op of toCall) {
      opts.signal?.throwIfAborted();
      log(`Calling ${op.name}`);
      const body = envelope(op);
      const r = await send(request, op, body, auth);
      view(op, body, r);
      answered.push({ op, r });
      const f = faultOf(r.text);
      if (r.status !== null && r.status >= 500 && !f) add("api:soap-server-error", "high", `${op.name} fails with a server error`, `The operation answered HTTP ${r.status} without a SOAP fault to a request made from its own WSDL.`, `${op.name}: HTTP ${r.status}`, "functional");
      if (f && r.status === 200) add("api:soap-fault-200", "low", "SOAP faults are sent with HTTP 200", "SOAP 1.1 and 1.2 say a fault goes with HTTP 500 (or 400 for the caller's mistake). Clients and monitors that look at the status code think the failed call worked.", `${op.name}: fault ${f.code} with HTTP 200`, "functional");
      if (r.ms > 3000 && r.status !== null && r.status < 400) add("api:soap-slow", "medium", `${op.name} is slow`, `It took ${(r.ms / 1000).toFixed(1)} s to answer one small request. Callers often time out at 5 to 10 s.`, `${op.name}: ${r.ms} ms`, "performance");
    }
    if (!answered.some((a) => a.r.status !== null)) throw new CouldNotTestError(`Could not test the SOAP service: no answer from ${wsdl.operations[0].endpoint} (${answered[0]?.r.error ?? "no reply"}).`);

    // A request that is not valid: the fault must not show the server's insides.
    const probe = wsdl.operations[0];
    const broken = envelope(probe).replace("</soap:Body>", "<tns:GlvNotAField>x</tns:GlvNotAField></soap:Body>").replace(`<tns:${probe.element}>`, `<tns:${probe.element}Glv>`).replace(`</tns:${probe.element}>`, `</tns:${probe.element}Glv>`);
    const pr = await send(request, probe, broken, auth);
    view(probe, broken, pr, "wrong request");
    const pf = faultOf(pr.text);
    if (pf && pr.status === 200 && !findings.some((f) => f.rule === "api:soap-fault-200")) add("api:soap-fault-200", "low", "SOAP faults are sent with HTTP 200", "SOAP 1.1 and 1.2 say a fault goes with HTTP 500 (or 400 for the caller's mistake). Clients and monitors that look at the status code think the failed call worked.", `${probe.name} (a wrong request): fault ${pf.code} with HTTP 200`, "functional");

    // Without the saved login.
    if (opts.auth) {
      for (const { op, r } of answered.filter((a) => a.r.status !== null && a.r.status < 400 && !faultOf(a.r.text)).slice(0, 5)) {
        const body = envelope(op);
        const a = await send(request, op, body, undefined);
        view(op, body, a, "no login");
        if (a.status !== null && a.status < 400 && !faultOf(a.text) && a.text === r.text) {
          add("api:auth-bypass", "critical", `${op.name} answers without a login`, `The operation gave the same answer with no login as with the saved one. Check the service's security settings (WS-Security, the HTTP login) apply to every operation.`, `${op.name}: same answer with no login`);
        }
      }
    }
    const endpoint = new URL(wsdl.operations[0].endpoint);
    if (endpoint.protocol === "http:" && !/^(localhost|127\.)/.test(endpoint.hostname)) add("api:no-https", "high", "The SOAP service uses plain http", "Requests and answers, logins included, travel unencrypted. Serve the endpoint over https and change the WSDL's soap:address.", endpoint.href);
    const server = Object.entries(answered[0]?.r.headers ?? {}).find(([k]) => /^(x-powered-by|x-aspnet-version)$/i.test(k));
    if (server) add("api:server-version", "low", "The service says what software it runs", `The ${server[0]} header (${server[1]}) tells attackers which known bugs to try. Remove it.`, `${server[0]}: ${server[1]}`);
    findings.push(...leakFindings("api.soap", wsdlUrl, views));

    const result = protocolResult(
      {
        kind: "soap",
        agent: "api.soap",
        agentName: "SOAP checks",
        url: wsdlUrl,
        service: wsdl.service,
        operations: wsdl.operations.length,
        notCalled: [...(opts.testServer ? [] : writes.map((o) => ({ method: "SOAP", path: o.name, why: "Its name says it changes data: only called when the project is marked as a test server" }))), ...wsdl.operations.slice(40).map((o) => ({ method: "SOAP", path: o.name, why: "One test calls at most 40 operations" }))],
        views,
        findings,
        notes: [
          `SOAP service ${wsdl.service} (SOAP ${wsdl.operations[0].version}) at ${endpoint.origin}: ${wsdl.operations.length} operations.`,
          opts.testServer ? `Called ${toCall.length} operations (the project is a test server).` : `Called the ${toCall.length} operations whose names say they only read (Get, List, Find...). ${writes.length} others were not called, to keep your data safe.`,
          "Each request was made from the WSDL with example values; a wrong request was also sent to check the error does not show the server's insides.",
        ],
        startedAt,
      },
      {},
    );
    return auth.secrets?.length ? redact(result, auth.secrets) : result;
  } finally {
    await request.dispose();
  }
}
