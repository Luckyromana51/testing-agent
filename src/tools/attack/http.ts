import http from "node:http";
import https from "node:https";
import type { ToolContext } from "../types.js";

/**
 * The attack agent's own HTTP client. It talks to the client's site directly (no outside service),
 * one small, polite stream of requests: at most two at a time and about eight a second, each with a
 * timeout, all stopped the moment the run's signal aborts or its time runs out. It gives full control
 * of the request headers (so the Origin, X-Forwarded-Host and cookie checks can send what they need)
 * and reports how long each request took, which the timing-based checks rely on.
 */
export interface Reply {
  status: number;
  /** Lower-cased header names to their value (the last one when a header repeats). */
  headers: Record<string, string>;
  /** Every Set-Cookie line, kept apart because they repeat. */
  setCookie: string[];
  body: string;
  type: string;
  location?: string;
  /** Round trip in milliseconds. */
  ms: number;
}

export interface GetOptions {
  /** Follow redirects (off by default: most checks read the first answer). */
  follow?: boolean;
  /** Extra request headers, such as a test Origin or X-Forwarded-Host. */
  headers?: Record<string, string>;
  /** Send the signed-in session cookie (off by default; on for the access-control checks). */
  cookie?: boolean;
  /** Replace the cookie entirely (an empty string sends none), for the signed-out half of a check. */
  cookieOverride?: string;
}

export interface AttackHttp {
  /** How many requests have gone out, for the report. */
  sent: number;
  get(url: string, opts?: GetOptions): Promise<Reply>;
  /** Milliseconds left before the run's own time limit. */
  left(): number;
}

const MAX_BODY = 1_500_000;
const PER_REQUEST_TIMEOUT = 15_000;
/** The smallest gap between requests: about eight a second. */
const GAP = 125;
const MAX_ACTIVE = 2;

export function attackHttp(ctx: ToolContext, deadline: number): AttackHttp {
  let last = 0;
  let active = 0;
  const waiting: (() => void)[] = [];
  const baseCookie = ctx.cookie ?? "";

  const run = (url: string, opts: GetOptions): Promise<Reply> =>
    new Promise<Reply>((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        return reject(new Error(`not an address: ${url}`));
      }
      const lib = u.protocol === "https:" ? https : http;
      const headers: Record<string, string> = { "user-agent": "GLV-Testing-Agent attack agent", accept: "*/*", ...(opts.headers ?? {}) };
      const cookie = opts.cookieOverride !== undefined ? opts.cookieOverride : opts.cookie ? baseCookie : "";
      if (cookie) headers.cookie = cookie;
      const started = Date.now();
      const perTimeout = Math.max(1000, Math.min(PER_REQUEST_TIMEOUT, deadline - started));
      const timer = AbortSignal.timeout(perTimeout);
      const signal = AbortSignal.any([ctx.signal, timer]);
      const req = lib.request(
        url,
        { method: "GET", headers, signal, rejectUnauthorized: false },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            if (size < MAX_BODY) {
              chunks.push(c);
              size += c.length;
            }
            if (size >= MAX_BODY) res.destroy();
          });
          res.on("end", () => done(res, Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8")));
          res.on("close", () => done(res, Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8")));
        },
      );
      let settled = false;
      const done = (res: http.IncomingMessage, body: string) => {
        if (settled) return;
        settled = true;
        const flat: Record<string, string> = {};
        const setCookie: string[] = [];
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === "set-cookie") setCookie.push(...(Array.isArray(v) ? v : v ? [v] : []));
          else flat[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flat,
          setCookie,
          body,
          type: flat["content-type"] ?? "",
          ...(flat.location ? { location: flat.location } : {}),
          ms: Date.now() - started,
        });
      };
      req.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      req.end();
    });

  const client: AttackHttp = {
    sent: 0,
    left: () => deadline - Date.now(),
    async get(url, opts = {}) {
      if (Date.now() > deadline) throw new Error("time limit");
      ctx.signal.throwIfAborted();
      if (active >= MAX_ACTIVE) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        const gap = GAP - (Date.now() - last);
        if (gap > 0) await new Promise((r) => setTimeout(r, gap));
        last = Date.now();
        ctx.signal.throwIfAborted();
        client.sent++;
        return await run(url, opts);
      } finally {
        active--;
        waiting.shift()?.();
      }
    },
  };
  return client;
}
