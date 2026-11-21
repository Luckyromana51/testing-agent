import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { request as playwrightRequest } from "playwright";
import { CouldNotTestError } from "../runner/coverage.js";
import { tellCall } from "../runner/live-code.js";
import type { ApiCallView, Finding, Login, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { resolveAuth } from "./api-auth.js";
import { leakFindings, protocolResult, protoFinding, READ_NAME } from "./protocol.js";

/*
 * gRPC services, like grpcurl and ghz's basic checks: the methods come from an uploaded .proto
 * file or from the server's own reflection service. Methods whose names say they only read
 * (GetUser, ListOrders, Check...) are called with example values, unary and server-streaming
 * ones; methods that change data are listed and never called on a live server. Checks: no TLS,
 * reflection open to anyone, methods that answer without the saved login, errors that show the
 * server's insides, the health service, and slow methods.
 */

const REFLECTION_PROTO = `syntax = "proto3";
package grpc.reflection.v1alpha;
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest { string host = 1; oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; } }
message ServerReflectionResponse { string valid_host = 1; ServerReflectionRequest original_request = 2; oneof message_response { FileDescriptorResponse file_descriptor_response = 4; ListServiceResponse list_services_response = 6; ErrorResponse error_response = 7; } }
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
message ErrorResponse { int32 error_code = 1; string error_message = 2; }
`;

const LOADER: protoLoader.Options = { keepCase: true, longs: String, enums: String, defaults: false, oneofs: true };

/** grpc://host:port → { host:port, tls } */
export function grpcTarget(address: string): { target: string; tls: boolean; host: string } {
  const tls = address.startsWith("grpcs://");
  const u = new URL(address.replace(/^grpcs?:/, "http:"));
  return { target: `${u.hostname}:${u.port || (tls ? 443 : 80)}`, tls, host: u.hostname };
}

/** Joins file descriptors (as reflection sends them) into one FileDescriptorSet. */
export function descriptorSet(files: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const len: number[] = [];
    let n = f.length;
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      len.push(b);
    } while (n);
    parts.push(Buffer.from([0x0a, ...len]), f);
  }
  return Buffer.concat(parts);
}

let reflectionDef: Promise<grpc.ServiceClientConstructor> | undefined;
async function reflectionClient(): Promise<grpc.ServiceClientConstructor> {
  reflectionDef ??= (async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "glv-grpc-"));
    const file = path.join(dir, "reflection.proto");
    await writeFile(file, REFLECTION_PROTO);
    const pkg = grpc.loadPackageDefinition(await protoLoader.load(file, LOADER)) as unknown as { grpc: { reflection: { v1alpha: { ServerReflection: grpc.ServiceClientConstructor } } } };
    return pkg.grpc.reflection.v1alpha.ServerReflection;
  })();
  return reflectionDef;
}

/** The server's services and their file descriptors, through reflection (v1alpha, which every server with reflection speaks). */
export async function reflect(target: string, creds: grpc.ChannelCredentials, metadata: grpc.Metadata, deadlineMs = 10_000): Promise<{ services: string[]; files: Buffer[] }> {
  const Ctor = await reflectionClient();
  const client = new Ctor(target, creds);
  try {
    const ask = (req: object) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const call = (client as unknown as { ServerReflectionInfo: (m: grpc.Metadata, o: grpc.CallOptions) => grpc.ClientDuplexStream<object, Record<string, unknown>> }).ServerReflectionInfo(metadata, { deadline: Date.now() + deadlineMs });
        const out: Record<string, unknown>[] = [];
        call.on("data", (d) => out.push(d));
        call.on("error", reject);
        call.on("end", () => resolve(out));
        call.write(req);
        call.end();
      });
    const listed = await ask({ list_services: "" });
    const services = ((listed[0]?.list_services_response as { service?: { name: string }[] })?.service ?? []).map((s) => s.name).filter((n) => !n.startsWith("grpc.reflection."));
    const files = new Map<string, Buffer>();
    for (const s of services) {
      const got = await ask({ file_containing_symbol: s });
      for (const b of ((got[0]?.file_descriptor_response as { file_descriptor_proto?: Buffer[] })?.file_descriptor_proto ?? [])) files.set(b.toString("base64"), Buffer.from(b));
    }
    return { services, files: [...files.values()] };
  } finally {
    client.close();
  }
}

interface MethodDef {
  path: string;
  requestStream: boolean;
  responseStream: boolean;
  requestSerialize: (v: object) => Buffer;
  responseDeserialize: (b: Buffer) => object;
  requestType?: { type?: { field?: { name: string; type: string; label?: string }[] } };
  originalName?: string;
}

/** Every method of every service in a package definition. */
export function methodsOf(pkg: protoLoader.PackageDefinition): { service: string; name: string; def: MethodDef }[] {
  const out: { service: string; name: string; def: MethodDef }[] = [];
  for (const [name, def] of Object.entries(pkg)) {
    if ((def as { format?: string }).format || name.startsWith("grpc.reflection.")) continue;
    for (const [m, md] of Object.entries(def as Record<string, MethodDef>)) {
      if (md && typeof md === "object" && "path" in md) out.push({ service: name, name: md.originalName ?? m, def: md });
    }
  }
  return out;
}

/** An example request from the message's fields (strings, numbers and booleans one level deep). */
export function sampleRequest(def: MethodDef): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.requestType?.type?.field ?? []) {
    if (f.label === "LABEL_REPEATED") continue;
    if (f.type === "TYPE_STRING") out[f.name] = /id$/i.test(f.name) ? "1" : "test";
    else if (/TYPE_(U?INT|S?FIXED|SINT)(32|64)/.test(f.type)) out[f.name] = 1;
    else if (f.type === "TYPE_BOOL") out[f.name] = false;
    else if (/TYPE_(DOUBLE|FLOAT)/.test(f.type)) out[f.name] = 1;
  }
  return out;
}

const HTTP_OF: Record<number, number> = { 0: 200, 3: 400, 5: 404, 6: 409, 7: 403, 8: 429, 9: 400, 12: 501, 14: 503, 16: 401, 4: 504 };

interface Answer {
  code: number;
  details: string;
  ms: number;
  body: string;
  messages: number;
}

function callMethod(client: grpc.Client, def: MethodDef, req: object, metadata: grpc.Metadata, deadlineMs = 10_000): Promise<Answer> {
  const started = Date.now();
  return new Promise((resolve) => {
    const deadline = Date.now() + deadlineMs;
    if (!def.responseStream) {
      client.makeUnaryRequest(def.path, def.requestSerialize, def.responseDeserialize, req, metadata, { deadline }, (err, value) => {
        resolve({ code: err?.code ?? 0, details: err?.details ?? "", ms: Date.now() - started, body: err ? `${grpc.status[err.code] ?? err.code}: ${err.details}` : JSON.stringify(value ?? {}, null, 1).slice(0, 8000), messages: err ? 0 : 1 });
      });
      return;
    }
    // Server streaming: the first few messages, then stop.
    const call = client.makeServerStreamRequest(def.path, def.requestSerialize, def.responseDeserialize, req, metadata, { deadline: Date.now() + Math.min(deadlineMs, 5000) });
    const got: object[] = [];
    let done = false;
    const finish = (code: number, details: string) => {
      if (done) return;
      done = true;
      resolve({ code, details, ms: Date.now() - started, body: code && !got.length ? `${grpc.status[code] ?? code}: ${details}` : JSON.stringify(got, null, 1).slice(0, 8000), messages: got.length });
    };
    call.on("data", (d: object) => {
      got.push(d);
      if (got.length >= 5) {
        call.cancel();
        finish(0, "");
      }
    });
    call.on("error", (e: grpc.ServiceError) => finish(got.length && (e.code === grpc.status.CANCELLED || e.code === grpc.status.DEADLINE_EXCEEDED) ? 0 : e.code, e.details));
    call.on("end", () => finish(0, ""));
  });
}

export interface GrpcScanOptions {
  address: string;
  protoFile?: string;
  auth?: Login;
  testServer?: boolean;
  onProgress?: (m: string) => void;
  signal?: AbortSignal;
}

export async function scanGrpc(opts: GrpcScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const { target, tls, host } = grpcTarget(opts.address);
  const creds = tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  // The login: the same kinds as REST APIs, sent as gRPC metadata.
  const req = await playwrightRequest.newContext();
  const { parts: auth } = await resolveAuth(req, opts.auth, log).finally(() => req.dispose());
  const md = (withLogin: boolean) => {
    const m = new grpc.Metadata();
    if (withLogin) for (const [k, v] of Object.entries(auth.headers)) m.set(k.toLowerCase(), v);
    return m;
  };
  const findings: Finding[] = [];
  const mk = protoFinding("api.grpc", opts.address);
  const add = (...a: Parameters<typeof mk>) => void findings.push(mk(...a));

  let pkg: protoLoader.PackageDefinition;
  let viaReflection = false;
  if (opts.protoFile) {
    log("Reading the .proto file");
    try {
      pkg = await protoLoader.load(opts.protoFile, LOADER);
    } catch (err) {
      throw new Error(`The .proto file could not be read: ${(err as Error).message.split("\n")[0]}`);
    }
  } else {
    log("Asking the server for its services (gRPC reflection)");
    let r: Awaited<ReturnType<typeof reflect>>;
    try {
      r = await reflect(target, creds, md(true));
    } catch (err) {
      const e = err as grpc.ServiceError;
      if (e.code === grpc.status.UNAVAILABLE) throw new CouldNotTestError(`Could not test the gRPC server: ${target} did not answer (${e.details}). Check the address, the port and ${tls ? "that it speaks TLS (use grpc:// for plain)" : "whether it needs TLS (use grpcs://)"}.`);
      throw new Error(`The server does not offer reflection (${grpc.status[e.code] ?? ""} ${e.details ?? e.message}). Upload the service's .proto file on the project page.`);
    }
    if (!r.files.length) throw new Error("The server's reflection lists no services. Upload the service's .proto file on the project page.");
    pkg = protoLoader.loadFileDescriptorSetFromBuffer(descriptorSet(r.files), LOADER);
    viaReflection = true;
    // Reflection open without the login?
    const anon = opts.auth ? await reflect(target, creds, md(false)).catch(() => undefined) : undefined;
    add("api:grpc-reflection", anon || !opts.auth ? "low" : "info", "The server describes all its methods to anyone (gRPC reflection is on)", `Reflection lists every service and message${opts.auth && !anon ? " (it needs the login here)" : ", without a login"}. On a live server it hands attackers a map of the API. Turn reflection off in production, or allow it only for signed-in callers.`, `${r.services.length} services: ${r.services.slice(0, 6).join(", ")}`);
  }

  const methods = methodsOf(pkg);
  const health = methods.find((m) => m.service === "grpc.health.v1.Health" && m.name === "Check");
  const callable = methods.filter((m) => !m.def.requestStream && (opts.testServer || READ_NAME.test(m.name)));
  const notCalled = methods.filter((m) => !callable.includes(m)).map((m) => ({ method: "gRPC", path: m.def.path, why: m.def.requestStream ? "Client streaming: not called" : "Its name says it changes data: only called when the project is marked as a test server" }));
  log(`${methods.length} methods in ${new Set(methods.map((m) => m.service)).size} services; calling ${Math.min(callable.length, 40)} that read`);
  const client = new grpc.Client(target, creds);
  const views: ApiCallView[] = [];
  const view = (m: (typeof methods)[number], reqObj: object, a: Answer, step?: string) => {
    const status = HTTP_OF[a.code] ?? 500;
    views.push({
      method: "gRPC",
      path: m.def.path,
      url: `${opts.address}${m.def.path}`,
      status,
      ms: a.ms,
      bytes: a.body.length,
      contentType: "application/grpc",
      requestHeaders: Object.fromEntries(Object.keys(step === "no login" ? {} : auth.headers).map((k) => [k, "[hidden]"])),
      requestBody: JSON.stringify(reqObj),
      responseHeaders: {},
      body: a.body,
      ...(a.code ? { problems: [`${grpc.status[a.code] ?? a.code}: ${a.details}`] } : {}),
      ...(step ? { step } : {}),
    });
    tellCall({ method: "POST", url: `${opts.address}${m.def.path}`, headers: step === "no login" ? {} : auth.headers, body: reqObj }, { status, ms: a.ms });
  };
  try {
    const ok: { m: (typeof methods)[number]; a: Answer; reqObj: object }[] = [];
    for (const m of callable.slice(0, 40)) {
      opts.signal?.throwIfAborted();
      const reqObj = sampleRequest(m.def);
      const a = await callMethod(client, m.def, reqObj, md(true));
      view(m, reqObj, a);
      if (a.code === 0) ok.push({ m, a, reqObj });
      if (a.code === grpc.status.INTERNAL || a.code === grpc.status.UNKNOWN) add("api:grpc-internal", "high", `${m.name} fails with ${grpc.status[a.code]}`, `A request made from the method's own message type was answered with ${grpc.status[a.code]}: the server did not handle it. Return INVALID_ARGUMENT or NOT_FOUND for bad input, and log the cause.`, `${m.def.path}: ${a.details.slice(0, 160)}`, "functional");
      if (a.code === 0 && a.ms > 2000) add("api:grpc-slow", "medium", `${m.name} is slow`, `It took ${(a.ms / 1000).toFixed(1)} s to answer one small request.`, `${m.def.path}: ${a.ms} ms`, "performance");
    }
    if (callable.length && views.every((v) => v.problems?.[0]?.startsWith("UNAVAILABLE"))) throw new CouldNotTestError(`Could not test the gRPC server: ${target} did not answer any call.`);
    if (opts.auth) {
      for (const { m, a, reqObj } of ok.slice(0, 5)) {
        const b = await callMethod(client, m.def, reqObj, md(false));
        view(m, reqObj, b, "no login");
        if (b.code === 0 && b.body === a.body) add("api:auth-bypass", "critical", `${m.name} answers without a login`, "The method gave the same answer with no login as with the saved one. Check the server's auth interceptor covers every method.", `${m.def.path}: same answer with no login`);
      }
    }
    if (!health) add("api:grpc-no-health", "info", "No standard health check (grpc.health.v1)", "Load balancers and Kubernetes check gRPC servers through grpc.health.v1.Health/Check. Add it so a stuck server is taken out of service.", host, "functional");
  } finally {
    client.close();
  }
  if (!tls && !/^(localhost|127\.|\[::1\])/.test(host)) add("api:no-https", "high", "The gRPC server does not use TLS", "Calls, logins included, travel unencrypted. Serve it with TLS (grpcs://).", opts.address);
  findings.push(...leakFindings("api.grpc", opts.address, views));
  const services = [...new Set(methods.map((m) => m.service))];
  const result = protocolResult({
    kind: "grpc",
    agent: "api.grpc",
    agentName: "gRPC checks",
    url: opts.address,
    service: services.join(", ").slice(0, 200),
    operations: methods.length,
    notCalled,
    views,
    findings,
    detail: viaReflection ? "Methods from the server's reflection" : "Methods from the uploaded .proto file",
    notes: [
      `gRPC server ${target} (${tls ? "TLS" : "plain, no TLS"}): ${services.length} service${services.length === 1 ? "" : "s"}, ${methods.length} methods, read ${viaReflection ? "from the server's reflection" : "from the uploaded .proto file"}.`,
      opts.testServer ? "Every unary and server-streaming method was called (the project is a test server)." : `Called the methods whose names say they only read; ${notCalled.length} others were not called, to keep your data safe.`,
    ],
    startedAt,
  });
  return auth.secrets?.length ? redact(result, auth.secrets) : result;
}
