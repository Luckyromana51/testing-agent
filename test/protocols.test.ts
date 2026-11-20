import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { scanGrpc, grpcTarget, descriptorSet } from "../src/engines/grpc.js";
import { matchBody, matchHeaders, parsePact, verifyPact } from "../src/engines/pact.js";
import { mergeResults } from "../src/engines/protocol.js";
import { envelope, faultOf, parseWsdl, scanSoap } from "../src/engines/soap.js";
import { decodeFrames, encodeFrame, parseMessages, scanWebSocket } from "../src/engines/websocket.js";
import { parseXml, textOf } from "../src/engines/xml.js";
import { buildTarget } from "../src/targets.js";
import type { ScanResult } from "../src/types.js";
import { GRPC_TOKEN, PACT, SOAP_TOKEN, startDemoProtocols, WS_TOKEN, WSDL, type DemoProtocols } from "./fixtures/demo-protocols.js";

process.env.ALLOW_PRIVATE_TARGETS = "1";
const rules = (r: ScanResult) => new Set(r.findings.map((f) => f.rule));

describe("protocol helpers", () => {
  it("reads XML without running DTDs or outside entities", () => {
    const doc = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a:root xmlns:a="u"><a:b k="1 &amp; 2">x &lt; y &xxe;</a:b><c/></a:root>`);
    assert.equal(doc.local, "root");
    assert.equal(doc.children[0].attrs.k, "1 & 2");
    assert.equal(textOf(doc), "x < y &xxe;");
  });

  it("reads a WSDL and makes envelopes, and spots faults", () => {
    const w = parseWsdl(WSDL("https://soap.test"), "https://soap.test/soap?wsdl");
    assert.equal(w.service, "OrderService");
    assert.deepEqual(w.operations.map((o) => o.name), ["GetOrder", "ListOrders", "DeleteOrder"]);
    const get = w.operations[0];
    assert.equal(get.action, "urn:GetOrder");
    assert.equal(get.endpoint, "https://soap.test/soap");
    assert.deepEqual(get.fields, [{ name: "orderId", value: "1" }]);
    assert.match(envelope(get), /<tns:GetOrderRequest><tns:orderId>1<\/tns:orderId><\/tns:GetOrderRequest>/);
    assert.deepEqual(faultOf(`<Envelope><Body><Fault><faultcode>soap:Client</faultcode><faultstring>Bad</faultstring></Fault></Body></Envelope>`), { code: "soap:Client", message: "Bad" });
    assert.equal(faultOf("<Envelope><Body><ok/></Body></Envelope>"), undefined);
  });

  it("reads gRPC addresses and joins descriptors", () => {
    assert.deepEqual(grpcTarget("grpcs://api.test"), { target: "api.test:443", tls: true, host: "api.test" });
    assert.deepEqual(grpcTarget("grpc://10.0.0.1:50051"), { target: "10.0.0.1:50051", tls: false, host: "10.0.0.1" });
    assert.deepEqual([...descriptorSet([Buffer.from([1, 2]), Buffer.alloc(200)]).subarray(0, 6)], [0x0a, 2, 1, 2, 0x0a, 0xc8]);
  });

  it("frames WebSocket messages the way RFC 6455 says", () => {
    const f = encodeFrame(Buffer.from("hello"));
    assert.equal(f[0], 0x81);
    assert.equal(f[1], 0x80 | 5); // masked
    const server = Buffer.concat([Buffer.from([0x81, 2]), Buffer.from("hi"), Buffer.from([0x81, 5])]);
    const { frames, rest } = decodeFrames(server);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].payload.toString(), "hi");
    assert.equal(rest.length, 2);
    assert.deepEqual(parseMessages('{"a":1} => pong\n# note\nplain'), [{ send: '{"a":1}', expect: "pong" }, { send: "plain" }]);
  });

  it("matches Pact rules: types, lists, regex, number kinds, extra fields", () => {
    const rules = { "body:$.n": [{ match: "integer" }], "body:$.list": [{ match: "type", min: 2 }], "body:$.d": [{ match: "regex", regex: "\\d{4}" }] };
    assert.deepEqual(matchBody({ n: 1, list: [{ a: "x" }], d: "2026", s: "same" }, { n: 7, list: [{ a: "y" }, { a: "z" }], d: "1999", s: "same", more: true }, rules), []);
    const p = matchBody({ n: 1, list: [{ a: "x" }], d: "2026", s: "same" }, { n: 1.5, list: [{ a: 3 }], d: "26", s: "other" }, rules);
    assert.ok(p.some((x) => x.startsWith("$.n: expected a whole number")));
    assert.ok(p.some((x) => x.includes("at least 2 items")));
    assert.ok(p.some((x) => x.startsWith("$.d:")));
    assert.ok(p.some((x) => x.startsWith('$.s: expected "same"')));
    assert.deepEqual(matchHeaders({ "content-type": "application/json" }, { "content-type": "application/json; charset=utf-8" }, {}), []);
    assert.equal(matchHeaders({ "x-v": "2" }, {}, {}).length, 1);
    // Version 2 paths, and version 4 bodies.
    const v2 = parsePact(JSON.stringify({ consumer: { name: "A" }, provider: { name: "B" }, interactions: [{ description: "d", providerState: "s", request: { method: "get", path: "/x", query: "a=1" }, response: { status: 200, body: { id: 1 }, matchingRules: { "$.body.id": { match: "type" } } } }] }));
    assert.equal(v2.interactions[0].state, "s");
    assert.equal(v2.interactions[0].method, "GET");
    assert.deepEqual(v2.interactions[0].rules["body:$.id"], [{ match: "type" }]);
    const v4 = parsePact(JSON.stringify({ consumer: { name: "A" }, provider: { name: "B" }, metadata: { pactSpecification: { version: "4.0" } }, interactions: [{ type: "Synchronous/HTTP", description: "d", request: { method: "GET", path: "/x", query: { a: ["1", "2"] } }, response: { status: 200, body: { content: { id: 1 }, contentType: "application/json" } } }, { type: "Asynchronous/Messages", description: "m" }] }));
    assert.equal(v4.spec, "4");
    assert.equal(v4.interactions.length, 1);
    assert.equal(v4.interactions[0].query, "a=1&a=2");
    assert.deepEqual(v4.interactions[0].response.body, { id: 1 });
  });

  it("checks protocol targets", () => {
    const t = buildTarget("api", { grpcUrl: "api.test:50051", contractFile: undefined });
    assert.equal(t.grpcUrl, "grpcs://api.test:50051"); // TLS unless grpc:// is written
    assert.throws(() => buildTarget("api", { wsUrl: "https://x.test" }), /ws/i);
  });
});

describe("protocol tests against demo services", () => {
  let demo: DemoProtocols;
  let dir: string;
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "glv-proto-"));
    demo = await startDemoProtocols(dir);
  });
  after(async () => {
    await demo?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("SOAP: calls only the operations that read, and finds the problems", async () => {
    demo.log.length = 0;
    const r = await scanSoap({ wsdlUrl: demo.soap, auth: { kind: "api", authType: "bearer", token: SOAP_TOKEN } });
    const got = rules(r);
    for (const rule of ["api:auth-bypass", "api:soap-fault-200", "api:server-version", "api:error-leak", "api:soap-wsdl-public"]) assert.ok(got.has(rule), `${rule} in ${[...got]}`);
    assert.ok(!demo.log.includes("soap urn:DeleteOrder"), "DeleteOrder must not be called on a live service");
    assert.equal(r.api?.source, "soap");
    assert.equal(r.api?.protocol?.operations, 3);
    assert.ok(r.api?.coverage.skipped.some((s) => s.path === "DeleteOrder"));
    assert.ok(!JSON.stringify(r).includes(SOAP_TOKEN), "the token never shows in the result");
  });

  it("gRPC: reads the methods by reflection and finds the problems", async () => {
    demo.log.length = 0;
    const r = await scanGrpc({ address: demo.grpc, auth: { kind: "api", authType: "bearer", token: GRPC_TOKEN } });
    const got = rules(r);
    for (const rule of ["api:grpc-reflection", "api:grpc-internal", "api:auth-bypass", "api:grpc-no-health", "api:error-leak"]) assert.ok(got.has(rule), `${rule} in ${[...got]}`);
    assert.ok(!demo.log.includes("grpc DeleteOrder"));
    assert.ok(demo.log.includes("grpc GetOrder"));
    assert.equal(r.api?.protocol?.operations, 4);
    assert.ok(!JSON.stringify(r).includes(GRPC_TOKEN));
  });

  it("gRPC: works from an uploaded .proto file too", async () => {
    const r = await scanGrpc({ address: demo.grpc, protoFile: demo.protoFile });
    assert.ok(!rules(r).has("api:grpc-reflection"));
    assert.match(r.api?.protocol?.detail ?? "", /proto file/);
  });

  it("WebSocket: sends the project's messages and checks login and origin", async () => {
    demo.log.length = 0;
    const r = await scanWebSocket({ url: demo.ws, messages: '{"type":"ping"} => pong\n{"type":"orders"} => nothing-like-this', auth: { kind: "api", authType: "bearer", token: WS_TOKEN } });
    const got = rules(r);
    for (const rule of ["api:ws-any-origin", "api:ws-no-auth", "api:ws-unexpected", "api:error-leak"]) assert.ok(got.has(rule), `${rule} in ${[...got]}`);
    assert.ok(demo.log.includes('ws {"type":"ping"}'));
    assert.equal(r.api?.source, "websocket");
  });

  it("Pact: keeps what matches, reports what breaks, never sends a POST to a live API", async () => {
    demo.log.length = 0;
    const r = await verifyPact({ pactText: JSON.stringify(PACT), baseUrl: demo.http });
    const c = r.api!.contract!;
    assert.equal(c.consumer, "ShopWeb");
    assert.equal(c.interactions[0].ok, true, c.interactions[0].problems.join("; "));
    assert.equal(c.interactions[1].ok, false);
    assert.ok(c.interactions[1].problems.some((p) => p.startsWith("$.id: expected number, got string")));
    assert.match(c.interactions[2].skipped ?? "", /test server/);
    assert.ok(!demo.log.includes("http POST /orders"));
    assert.equal(r.findings.filter((f) => f.rule === "contract:broken").length, 1);
    // On a test server the POST is sent.
    const t = await verifyPact({ pactText: JSON.stringify(PACT), baseUrl: demo.http, testServer: true });
    assert.equal(t.api!.contract!.interactions[2].ok, true);
    // Joined with a protocol test, both reports stay.
    const both = mergeResults(await scanWebSocket({ url: demo.ws }), r);
    assert.ok(both.api?.contract);
    assert.ok(both.api?.protocol);
    assert.ok(both.findings.some((f) => f.rule === "contract:broken"));
  });
});
