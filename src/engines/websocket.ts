import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { request as playwrightRequest } from "playwright";
import { CouldNotTestError } from "../runner/coverage.js";
import { tellCall } from "../runner/live-code.js";
import type { ApiCallView, Finding, Login, ScanResult } from "../types.js";
import { redact } from "../vault.js";
import { resolveAuth } from "./api-auth.js";
import { leakFindings, protocolResult, protoFinding } from "./protocol.js";

/*
 * WebSocket APIs, with our own small client (so the test controls every header): connects with
 * the saved login, sends the messages the project lists and checks the answers, then checks what
 * attackers try: connecting without a login, connecting from another website (cross-site
 * WebSocket hijacking), plain ws://, and errors that show the server's insides.
 */

export interface WsConnection {
  status: number;
  headers: http.IncomingHttpHeaders;
  send: (text: string) => void;
  /** The next message (text), or undefined after `ms`. */
  next: (ms: number) => Promise<string | undefined>;
  close: () => void;
}

/** One frame from the client (always masked, as RFC 6455 says). */
export function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const mask = randomBytes(4);
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, body]);
}

/** Frames from the server (not masked). Returns the complete frames and the bytes left over. */
export function decodeFrames(buf: Buffer): { frames: { opcode: number; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; payload: Buffer }[] = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const opcode = buf[at] & 0x0f;
    const masked = Boolean(buf[at + 1] & 0x80);
    let len = buf[at + 1] & 0x7f;
    let off = at + 2;
    if (len === 126) {
      if (buf.length - off < 2) break;
      len = buf.readUInt16BE(off);
      off += 2;
    } else if (len === 127) {
      if (buf.length - off < 8) break;
      len = Number(buf.readBigUInt64BE(off));
      off += 8;
    }
    const maskKey = masked ? buf.subarray(off, off + 4) : undefined;
    if (masked) off += 4;
    if (buf.length - off < len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    frames.push({ opcode, payload });
    at = off + len;
  }
  return { frames, rest: buf.subarray(at) };
}

/** Opens a WebSocket with exactly these headers. A refused handshake gives its status and no socket. */
export function connect(url: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<WsConnection> {
  const u = new URL(url.replace(/^ws/, "http"));
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": randomBytes(16).toString("base64"), "user-agent": "GLVTestingAgent/0.5 (WebSocket test)", ...headers },
      timeout: timeoutMs,
    });
    req.on("timeout", () => req.destroy(new Error("The server did not answer the WebSocket handshake in time.")));
    req.on("error", reject);
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers, send: () => {}, next: async () => undefined, close: () => {} });
    });
    req.on("upgrade", (res, socket: Duplex, head: Buffer) => {
      let buf: Buffer = Buffer.alloc(0);
      const inbox: string[] = [];
      const waiting: ((m: string | undefined) => void)[] = [];
      let closed = false;
      const deliver = (m: string | undefined) => {
        const w = waiting.shift();
        if (w) w(m);
        else if (m !== undefined) inbox.push(m);
      };
      const onBytes = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const { frames, rest } = decodeFrames(buf);
        buf = rest;
        for (const f of frames) {
          if (f.opcode === 0x1 || f.opcode === 0x2) deliver(f.payload.toString("utf8").slice(0, 100_000));
          else if (f.opcode === 0x9) socket.write(encodeFrame(f.payload, 0xa));
          else if (f.opcode === 0x8) {
            closed = true;
            while (waiting.length) deliver(undefined);
          }
        }
      };
      socket.on("data", onBytes);
      // Frames the server sent with its handshake answer (a hello) arrive in head.
      if (head.length) queueMicrotask(() => onBytes(Buffer.from(head)));
      socket.on("close", () => {
        closed = true;
        while (waiting.length) deliver(undefined);
      });
      socket.on("error", () => {});
      resolve({
        status: res.statusCode ?? 101,
        headers: res.headers,
        send: (text) => void (!closed && socket.write(encodeFrame(Buffer.from(text)))),
        next: (ms) =>
          inbox.length
            ? Promise.resolve(inbox.shift())
            : closed
              ? Promise.resolve(undefined)
              : new Promise((r) => {
                  const take = (m: string | undefined) => {
                    clearTimeout(t);
                    r(m);
                  };
                  const t = setTimeout(() => {
                    const i = waiting.indexOf(take);
                    if (i >= 0) waiting.splice(i, 1);
                    r(undefined);
                  }, ms);
                  waiting.push(take);
                }),
        close: () => {
          if (!closed) socket.write(encodeFrame(Buffer.alloc(0), 0x8));
          socket.end();
          closed = true;
        },
      });
    });
    req.end();
  });
}

/** The project's messages: one per line, "send this" or "send this => the answer has this". */
export function parseMessages(text: string | undefined): { send: string; expect?: string }[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .slice(0, 20)
    .map((l) => {
      const at = l.lastIndexOf("=>");
      return at > 0 ? { send: l.slice(0, at).trim(), expect: l.slice(at + 2).trim() || undefined } : { send: l };
    });
}

export interface WsScanOptions {
  url: string;
  messages?: string;
  auth?: Login;
  onProgress?: (m: string) => void;
  signal?: AbortSignal;
}

const EVIL_ORIGIN = "https://glv-origin-check.example";

export async function scanWebSocket(opts: WsScanOptions): Promise<ScanResult> {
  const startedAt = new Date().toISOString();
  const log = (m: string) => opts.onProgress?.(m);
  const req = await playwrightRequest.newContext();
  const { parts: auth } = await resolveAuth(req, opts.auth, log).finally(() => req.dispose());
  const withQuery = (u: string, on: boolean) => {
    if (!on || !auth.query) return u;
    const x = new URL(u);
    x.searchParams.set(auth.query[0], auth.query[1]);
    return x.href;
  };
  const own = new URL(opts.url.replace(/^ws/, "http")).origin;
  const findings: Finding[] = [];
  const mk = protoFinding("api.websocket", opts.url);
  const add = (...a: Parameters<typeof mk>) => void findings.push(mk(...a));
  const views: ApiCallView[] = [];
  const record = (path: string, sent: string | undefined, got: string | undefined, ms: number, status: number | null, step?: string, problems?: string[]) => {
    views.push({ method: "WS", path, url: opts.url, status, ms, bytes: got?.length ?? 0, contentType: "websocket", requestHeaders: step === "no login" ? {} : Object.fromEntries(Object.keys(auth.headers).map((k) => [k, "[hidden]"])), ...(sent !== undefined ? { requestBody: sent.slice(0, 8000) } : {}), responseHeaders: {}, body: (got ?? "").slice(0, 8000), ...(problems?.length ? { problems } : {}), ...(step ? { step } : {}) });
    tellCall({ method: "GET", url: opts.url, headers: step === "no login" ? {} : auth.headers, body: sent }, { status, ms });
  };
  const open = async (login: boolean, origin = own) => {
    const t = Date.now();
    try {
      const c = await connect(withQuery(opts.url, login), { origin, ...(login ? auth.headers : {}) });
      return { c, ms: Date.now() - t };
    } catch (err) {
      return { error: (err as Error).message.split("\n")[0], ms: Date.now() - t };
    }
  };

  log(`Connecting to ${opts.url}`);
  const main = await open(true);
  if (!main.c) throw new CouldNotTestError(`Could not test the WebSocket: ${opts.url} did not answer (${main.error}).`);
  record("Connect", undefined, `HTTP ${main.c.status}`, main.ms, main.c.status);
  if (main.c.status !== 101) throw new CouldNotTestError(`Could not test the WebSocket: the server refused the connection with HTTP ${main.c.status}${opts.auth ? " (with the saved login)" : ""}.`);
  const messages = parseMessages(opts.messages);
  const replies: (string | undefined)[] = [];
  const greeting = await main.c.next(1500);
  if (greeting) record("Message from the server on connect", undefined, greeting, 0, 101);
  for (const m of messages) {
    opts.signal?.throwIfAborted();
    const t = Date.now();
    main.c.send(m.send);
    const got = await main.c.next(5000);
    replies.push(got);
    const ms = Date.now() - t;
    const problems = got === undefined ? ["No answer in 5 seconds"] : m.expect && !got.includes(m.expect) ? [`The answer does not have "${m.expect}"`] : undefined;
    record(`Send: ${m.send.slice(0, 60)}`, m.send, got, ms, 101, undefined, problems);
    if (problems) add("api:ws-unexpected", "medium", `The WebSocket did not answer "${m.send.slice(0, 40)}" as expected`, `${problems[0]}. The project lists what this message must get back.`, `Sent: ${m.send.slice(0, 120)}\nGot: ${(got ?? "nothing").slice(0, 200)}`, "functional");
    else if (ms > 2000) add("api:ws-slow", "medium", "The WebSocket answers slowly", `The answer took ${(ms / 1000).toFixed(1)} s.`, `${m.send.slice(0, 60)}: ${ms} ms`, "performance");
  }
  // A broken message: the error must not show the server's insides.
  main.c.send("{glv-not-json");
  const broken = await main.c.next(3000);
  record("Broken message", "{glv-not-json", broken, 0, 101);
  main.c.close();

  if (opts.auth) {
    const anon = await open(false);
    record("Connect without the login", undefined, anon.c ? `HTTP ${anon.c.status}` : anon.error, anon.ms, anon.c?.status ?? null, "no login");
    if (anon.c?.status === 101) {
      let same = !messages.length;
      if (messages.length) {
        if (greeting) await anon.c.next(1500); // the same hello the signed-in connection got
        anon.c.send(messages[0].send);
        const got = await anon.c.next(4000);
        record(`Send without the login: ${messages[0].send.slice(0, 50)}`, messages[0].send, got, 0, 101, "no login");
        same = got !== undefined && got === replies[0] && !/unauth|forbidden|login|denied|error/i.test(got);
      }
      anon.c.close();
      if (same) add("api:ws-no-auth", "high", "The WebSocket works without a login", "A connection with no login was accepted and answered like a signed-in one. Check the login when the connection opens (a token in the first message or the handshake), and close connections that do not have it.", `${opts.url}: HTTP 101 without a login`);
    }
  }
  const cross = await open(true, EVIL_ORIGIN);
  record("Connect from another website", undefined, cross.c ? `HTTP ${cross.c.status}` : cross.error, cross.ms, cross.c?.status ?? null, "other origin");
  if (cross.c?.status === 101) {
    cross.c.close();
    add("api:ws-any-origin", opts.auth ? "medium" : "low", "The WebSocket accepts connections from any website", `A connection with Origin: ${EVIL_ORIGIN} was accepted. Browsers send the user's cookies with WebSocket connections, so any web page a signed-in user visits can open the socket as them and read their data (cross-site WebSocket hijacking). Check the Origin header against your own sites when the connection opens.`, `Origin: ${EVIL_ORIGIN} → HTTP 101`);
  }
  const u = new URL(opts.url.replace(/^ws/, "http"));
  if (opts.url.startsWith("ws://") && !/^(localhost|127\.)/.test(u.hostname)) add("api:no-https", "high", "The WebSocket is not encrypted (ws://)", "Messages, logins included, travel unencrypted. Use wss://.", opts.url);
  findings.push(...leakFindings("api.websocket", opts.url, views));
  const result = protocolResult({
    kind: "websocket",
    agent: "api.websocket",
    agentName: "WebSocket checks",
    url: opts.url,
    service: u.host,
    operations: messages.length,
    notCalled: [],
    views,
    findings,
    notes: [
      `WebSocket ${opts.url}: connected${opts.auth ? " with the saved login" : ""}, sent ${messages.length} message${messages.length === 1 ? "" : "s"} from the project${messages.length ? "" : " (add messages on the API setup tab to check answers)"}.`,
      "Also tried: a connection without the login, a connection from another website (Origin), and a broken message.",
    ],
    startedAt,
  });
  return auth.secrets?.length ? redact(result, auth.secrets) : result;
}
