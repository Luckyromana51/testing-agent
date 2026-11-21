/*
 * GLV's own traffic recorder for apps under test. The test phone is pointed at it as its HTTP
 * proxy; it passes every call on unchanged and writes down where it went. HTTPS stays encrypted
 * (only the server name is seen, from the CONNECT line); plain HTTP calls are seen in full, which
 * is exactly the problem the report shows. Nothing is changed, blocked or decrypted.
 */
import http from "node:http";
import net from "node:net";

export interface TrafficEvent {
  /** CONNECT for HTTPS (encrypted), else the HTTP method. */
  method: string;
  host: string;
  port: number;
  /** Plain HTTP only: the address called. */
  url?: string;
  secure: boolean;
  /** Plain HTTP only: words in the call that look like private data (password, token, otp...). */
  sensitive?: string[];
  /** Milliseconds since the recorder started. */
  at: number;
}

const SENSITIVE = /\b(pass(word)?|pwd|token|access_token|auth|otp|pin|secret|session|card|cvv|aadhaar|pan|email|phone|mobile)\b/gi;

/** Loopback, private (10/8, 172.16/12, 192.168/16), link-local, CGNAT (100.64/10) and IPv6 local addresses. */
export function localAddress(addr?: string): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, "");
  if (a === "::1" || /^f[cd]/i.test(a) || /^fe80:/i.test(a)) return true;
  const m = a.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  return x === 127 || x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127);
}

export class TrafficRecorder {
  readonly events: TrafficEvent[] = [];
  /** The port it listens on, once started. */
  port = 0;
  private server: http.Server;
  private started = Date.now();
  private sockets = new Set<net.Socket>();
  /** Where calls are marked from now on ("launch", "Home screen"...). */
  stage = "launch";
  readonly stages: { stage: string; from: number }[] = [{ stage: "launch", from: 0 }];

  constructor() {
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.on("connect", (req, client: net.Socket, head) => this.tunnel(req, client, head));
    this.server.on("connection", (s) => {
      // Only phones on this machine's own networks may use it, so it is never an open proxy for the internet.
      if (!localAddress(s.remoteAddress)) return s.destroy();
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  /** Starts listening; port 0 picks a free one. */
  listen(port: number, host = "0.0.0.0"): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  mark(stage: string) {
    this.stage = stage;
    this.stages.push({ stage, from: Date.now() - this.started });
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private record(e: Omit<TrafficEvent, "at">) {
    if (this.events.length < 5000) this.events.push({ ...e, at: Date.now() - this.started });
  }

  private tunnel(req: http.IncomingMessage, client: net.Socket, head: Buffer) {
    const [host, portText] = (req.url ?? "").split(":");
    const port = Number(portText) || 443;
    this.record({ method: "CONNECT", host: host.toLowerCase(), port, secure: true });
    const upstream = net.connect({ host, port, timeout: 15_000 }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const end = () => {
      upstream.destroy();
      client.destroy();
    };
    upstream.on("error", () => {
      if (client.writable) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      end();
    });
    upstream.on("timeout", end);
    client.on("error", end);
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse) {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size < 64_000) chunks.push(c);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const words = new Set<string>();
      for (const m of `${target.search} ${body}`.matchAll(SENSITIVE)) words.add(m[1].toLowerCase());
      for (const h of ["authorization", "cookie"]) if (req.headers[h]) words.add(h);
      this.record({
        method: req.method ?? "GET",
        host: target.hostname.toLowerCase(),
        port: Number(target.port) || 80,
        url: `${target.origin}${target.pathname}`,
        secure: false,
        ...(words.size ? { sensitive: [...words].sort() } : {}),
      });
      const headers = { ...req.headers };
      delete headers["proxy-connection"];
      const up = http.request({ host: target.hostname, port: Number(target.port) || 80, method: req.method, path: `${target.pathname}${target.search}`, headers, timeout: 15_000 }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      });
      up.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      up.on("timeout", () => up.destroy());
      up.end(Buffer.concat(chunks));
    });
  }

  /** The stage a call happened in. */
  stageAt(at: number): string {
    let s = this.stages[0].stage;
    for (const st of this.stages) if (st.from <= at) s = st.stage;
    return s;
  }
}
