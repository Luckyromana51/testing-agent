import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";

/*
 * Small demo services for the protocol tests, each with known problems:
 * - SOAP: ListOrders answers without the login, faults are sent with HTTP 200, a wrong request
 *   shows a Node stack trace, and X-Powered-By is sent.
 * - gRPC: reflection on, ListOrders answers without the login, GetBroken fails with INTERNAL,
 *   no health service. DeleteOrder must never be called.
 * - WebSocket: accepts any Origin and connections without the login.
 * - REST for Pact: GET /orders/1 keeps the contract, GET /users/1 breaks it (a number became text).
 */

export const SOAP_TOKEN = "soap-secret-token";
export const GRPC_TOKEN = "grpc-secret-token";
export const WS_TOKEN = "ws-secret-token";

export const WSDL = (base: string) => `<?xml version="1.0"?>
<definitions name="OrderService" targetNamespace="urn:glv:orders" xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:glv:orders" xmlns:xsd="http://www.w3.org/2001/XMLSchema">
  <types>
    <xsd:schema targetNamespace="urn:glv:orders">
      <xsd:element name="GetOrderRequest"><xsd:complexType><xsd:sequence><xsd:element name="orderId" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="ListOrdersRequest"><xsd:complexType><xsd:sequence><xsd:element name="page" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:element>
      <xsd:element name="DeleteOrderRequest"><xsd:complexType><xsd:sequence><xsd:element name="orderId" type="xsd:int"/></xsd:sequence></xsd:complexType></xsd:element>
    </xsd:schema>
  </types>
  <message name="GetOrderIn"><part name="body" element="tns:GetOrderRequest"/></message>
  <message name="ListOrdersIn"><part name="body" element="tns:ListOrdersRequest"/></message>
  <message name="DeleteOrderIn"><part name="body" element="tns:DeleteOrderRequest"/></message>
  <portType name="OrderPort">
    <operation name="GetOrder"><input message="tns:GetOrderIn"/></operation>
    <operation name="ListOrders"><input message="tns:ListOrdersIn"/></operation>
    <operation name="DeleteOrder"><input message="tns:DeleteOrderIn"/></operation>
  </portType>
  <binding name="OrderBinding" type="tns:OrderPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="GetOrder"><soap:operation soapAction="urn:GetOrder"/></operation>
    <operation name="ListOrders"><soap:operation soapAction="urn:ListOrders"/></operation>
    <operation name="DeleteOrder"><soap:operation soapAction="urn:DeleteOrder"/></operation>
  </binding>
  <service name="OrderService"><port name="OrderPort" binding="tns:OrderBinding"><soap:address location="${base}/soap"/></port></service>
</definitions>`;

const soapEnv = (inner: string) => `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const fault = (code: string, msg: string) => soapEnv(`<soap:Fault><faultcode>${code}</faultcode><faultstring>${msg}</faultstring></soap:Fault>`);

export const ORDERS_PROTO = `syntax = "proto3";
package demo;
service Orders {
  rpc GetOrder (OrderRequest) returns (Order);
  rpc ListOrders (ListRequest) returns (stream Order);
  rpc GetBroken (OrderRequest) returns (Order);
  rpc DeleteOrder (OrderRequest) returns (Order);
}
message OrderRequest { int32 id = 1; }
message ListRequest { int32 page = 1; string status = 2; }
message Order { int32 id = 1; string item = 2; double total = 3; }
`;

export interface DemoProtocols {
  http: string;
  soap: string;
  grpc: string;
  ws: string;
  protoFile: string;
  /** What the services were sent, to check nothing that changes data was called. */
  log: string[];
  close: () => Promise<void>;
}

function wsFrame(text: string): Buffer {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
}

function readClientFrames(buf: Buffer): { texts: string[]; close: boolean; rest: Buffer } {
  const texts: string[] = [];
  let close = false;
  let i = 0;
  while (buf.length - i >= 2) {
    const op = buf[i] & 0x0f;
    let len = buf[i + 1] & 0x7f;
    let at = i + 2;
    if (len === 126) {
      if (buf.length < at + 2) break;
      len = buf.readUInt16BE(at);
      at += 2;
    }
    if (buf.length < at + 4 + len) break;
    const mask = buf.subarray(at, at + 4);
    const data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
    for (let j = 0; j < data.length; j++) data[j] ^= mask[j % 4];
    if (op === 0x1) texts.push(data.toString());
    if (op === 0x8) close = true;
    i = at + 4 + len;
  }
  return { texts, close, rest: buf.subarray(i) };
}

export async function startDemoProtocols(dir: string): Promise<DemoProtocols> {
  const log: string[] = [];
  let base = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    for await (const c of req) body += c;
    if (url.pathname === "/soap" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/xml" });
      return res.end(WSDL(base));
    }
    if (url.pathname === "/soap" && req.method === "POST") {
      const action = String(req.headers.soapaction ?? "").replace(/"/g, "");
      log.push(`soap ${action}`);
      const authed = req.headers.authorization === `Bearer ${SOAP_TOKEN}`;
      res.setHeader("x-powered-by", "Express 4.17.1");
      res.setHeader("content-type", "text/xml");
      if (!/<tns:(GetOrderRequest|ListOrdersRequest|DeleteOrderRequest)>/.test(body)) {
        // A wrong request: a fault with HTTP 200, and the stack trace in it.
        return res.end(fault("soap:Client", "TypeError: Cannot read properties of undefined (reading 'orderId')\n    at handle (/srv/orders/soap.js:42:17)"));
      }
      if (action === "urn:ListOrders") return res.end(soapEnv(`<ListOrdersResponse><order><id>1</id><item>Pen</item></order></ListOrdersResponse>`));
      if (!authed) return res.end(fault("soap:Client", "Login required"));
      if (action === "urn:GetOrder") return res.end(soapEnv(`<GetOrderResponse><id>1</id><item>Pen</item></GetOrderResponse>`));
      if (action === "urn:DeleteOrder") return res.end(soapEnv(`<DeleteOrderResponse><ok>true</ok></DeleteOrderResponse>`));
      res.statusCode = 500;
      return res.end(fault("soap:Server", "Unknown action"));
    }
    // REST for the Pact test.
    log.push(`http ${req.method} ${url.pathname}`);
    if (url.pathname === "/orders/1" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ id: 1, item: "Pen", total: 12.5, lines: [{ sku: "P-1", qty: 2 }, { sku: "P-2", qty: 1 }], createdAt: "2026-11-20T10:00:00Z", extra: "fine" }));
    }
    if (url.pathname === "/users/1" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "1", name: "Asha" }));
    }
    if (url.pathname === "/orders" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: 2 }));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });

  // WebSocket on the same server: any Origin, no login needed.
  server.on("upgrade", (req, socket) => {
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(wsFrame(JSON.stringify({ type: "hello" })));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      const r = readClientFrames(Buffer.concat([buf, chunk]));
      buf = Buffer.from(r.rest);
      for (const t of r.texts) {
        log.push(`ws ${t}`);
        let msg: { type?: string };
        try {
          msg = JSON.parse(t);
        } catch {
          socket.write(wsFrame(JSON.stringify({ error: "SyntaxError: Unexpected token g in JSON at position 1\n    at JSON.parse (<anonymous>)\n    at Socket.onMessage (/srv/app/ws.js:12:20)" })));
          continue;
        }
        if (msg.type === "ping") socket.write(wsFrame(JSON.stringify({ type: "pong" })));
        else if (msg.type === "orders") socket.write(wsFrame(JSON.stringify({ type: "orders", list: [1, 2] })));
        else socket.write(wsFrame(JSON.stringify({ type: "unknown" })));
      }
      if (r.close) socket.end(Buffer.from([0x88, 0]));
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;

  // gRPC with reflection.
  const protoFile = path.join(dir, "orders.proto");
  await writeFile(protoFile, ORDERS_PROTO);
  const pkg = protoLoader.loadSync(protoFile, { keepCase: true, defaults: true });
  const loaded = grpc.loadPackageDefinition(pkg) as unknown as { demo: { Orders: grpc.ServiceClientConstructor } };
  const g = new grpc.Server();
  const authed = (call: { metadata: grpc.Metadata }) => call.metadata.get("authorization")[0] === `Bearer ${GRPC_TOKEN}`;
  g.addService(loaded.demo.Orders.service, {
    GetOrder: (call: grpc.ServerUnaryCall<{ id: number }, object>, cb: grpc.sendUnaryData<object>) => {
      log.push("grpc GetOrder");
      if (!authed(call)) return cb({ code: grpc.status.UNAUTHENTICATED, details: "login required" } as grpc.ServiceError);
      cb(null, { id: call.request.id || 1, item: "Pen", total: 12.5 });
    },
    ListOrders: (call: grpc.ServerWritableStream<object, object>) => {
      log.push("grpc ListOrders");
      call.write({ id: 1, item: "Pen", total: 12.5 });
      call.write({ id: 2, item: "Ink", total: 3 });
      call.end();
    },
    GetBroken: (_call: unknown, cb: grpc.sendUnaryData<object>) => {
      log.push("grpc GetBroken");
      cb({ code: grpc.status.INTERNAL, details: "TypeError: x is undefined\n    at getBroken (/srv/orders/grpc.js:31:9)" } as grpc.ServiceError);
    },
    DeleteOrder: (_call: unknown, cb: grpc.sendUnaryData<object>) => {
      log.push("grpc DeleteOrder");
      cb(null, { id: 1 });
    },
  });
  // Reflection (v1alpha), answered from the .proto file's descriptor.
  const root = protobuf.parse(ORDERS_PROTO, { keepCase: true }).root;
  (root as unknown as { files?: string[] }).files = [];
  const set = (root as unknown as { toDescriptor: (s: string) => { file: object[] } }).toDescriptor("proto3");
  const files = set.file.map((f) => {
    (f as { name?: string }).name = "orders.proto";
    return Buffer.from((descriptor as unknown as { FileDescriptorProto: { encode: (m: object) => { finish: () => Uint8Array } } }).FileDescriptorProto.encode(f).finish());
  });
  const reflFile = path.join(dir, "reflection.proto");
  await writeFile(
    reflFile,
    `syntax = "proto3";
package grpc.reflection.v1alpha;
service ServerReflection { rpc ServerReflectionInfo(stream ServerReflectionRequest) returns (stream ServerReflectionResponse); }
message ServerReflectionRequest { string host = 1; oneof message_request { string file_by_filename = 3; string file_containing_symbol = 4; string list_services = 7; } }
message ServerReflectionResponse { string valid_host = 1; ServerReflectionRequest original_request = 2; oneof message_response { FileDescriptorResponse file_descriptor_response = 4; ListServiceResponse list_services_response = 6; } }
message FileDescriptorResponse { repeated bytes file_descriptor_proto = 1; }
message ListServiceResponse { repeated ServiceResponse service = 1; }
message ServiceResponse { string name = 1; }
`,
  );
  const refl = grpc.loadPackageDefinition(protoLoader.loadSync(reflFile, { keepCase: true, oneofs: true })) as unknown as { grpc: { reflection: { v1alpha: { ServerReflection: grpc.ServiceClientConstructor } } } };
  g.addService(refl.grpc.reflection.v1alpha.ServerReflection.service, {
    ServerReflectionInfo: (call: grpc.ServerDuplexStream<Record<string, string>, object>) => {
      call.on("data", (r) => {
        if (r.list_services !== undefined) call.write({ list_services_response: { service: [{ name: "demo.Orders" }, { name: "grpc.reflection.v1alpha.ServerReflection" }] } });
        else call.write({ file_descriptor_response: { file_descriptor_proto: files } });
      });
      call.on("end", () => call.end());
    },
  });
  const gport = await new Promise<number>((resolve, reject) => g.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))));

  return {
    http: base,
    soap: `${base}/soap?wsdl`,
    grpc: `grpc://127.0.0.1:${gport}`,
    ws: `ws://127.0.0.1:${port}/socket`,
    protoFile,
    log,
    close: async () => {
      g.forceShutdown();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A Pact v3 file: two GETs the consumer relies on, and one POST. */
export const PACT = {
  consumer: { name: "ShopWeb" },
  provider: { name: "OrdersAPI" },
  interactions: [
    {
      description: "an order with its lines",
      providerStates: [{ name: "order 1 exists" }],
      request: { method: "GET", path: "/orders/1", headers: { Accept: "application/json" } },
      response: {
        status: 200,
        headers: { "Content-Type": "application/json" },
        body: { id: 1, item: "Pen", total: 10.0, lines: [{ sku: "X", qty: 1 }], createdAt: "2026-01-01T00:00:00Z" },
        matchingRules: {
          body: {
            "$.total": { matchers: [{ match: "decimal" }] },
            "$.lines": { matchers: [{ match: "type", min: 1 }] },
            "$.lines[*].qty": { matchers: [{ match: "integer" }] },
            "$.createdAt": { matchers: [{ match: "regex", regex: "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z" }] },
          },
        },
      },
    },
    {
      description: "a user",
      request: { method: "GET", path: "/users/1" },
      response: { status: 200, body: { id: 1, name: "Asha" }, matchingRules: { body: { "$.name": { matchers: [{ match: "type" }] } } } },
    },
    {
      description: "a new order",
      request: { method: "POST", path: "/orders", body: { item: "Pen" } },
      response: { status: 201, body: { id: 2 } },
    },
  ],
  metadata: { pactSpecification: { version: "3.0.0" } },
};
