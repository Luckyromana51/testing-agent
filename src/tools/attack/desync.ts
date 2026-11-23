import net from "node:net";
import tls from "node:tls";
import type { AttackFinding, Family, FamilyContext } from "./types.js";
import { pathOf } from "./types.js";

const id = () => Math.random().toString(36).slice(2, 8);

/** Headers caches often leave out of their key while the site still uses them. */
export const UNKEYED = ["x-forwarded-host", "x-forwarded-scheme", "x-forwarded-proto", "x-original-url", "x-rewrite-url", "x-host", "x-forwarded-server"];

function pages(fc: FamilyContext, n: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of fc.surface.pages) {
    const p = pathOf(u);
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(u);
    if (out.length >= n) break;
  }
  return out;
}

/** Adds a cache buster, so only GLV's own copy of the page can be poisoned, never what visitors get. Pure, for tests. */
export function withBuster(url: string, buster: string): string {
  const u = new URL(url);
  u.searchParams.set("glvcb", buster);
  return u.href;
}

/**
 * Web cache poisoning: an unkeyed header (X-Forwarded-Host…) changes the page, and the cache keeps
 * that changed page for the next visitor. Every request carries GLV's own cache-buster parameter, so
 * only a copy nobody else requests can be poisoned: request once with the header, then once without;
 * if the second answer still carries the marker, the cache stored it.
 */
export const cachePoisonFamily: Family = {
  id: "cache-poison",
  label: "Web cache poisoning",
  hint: "Unkeyed headers on a cache-busted copy of each page (never the copy visitors get); flagged only when a clean request gets the poisoned page back.",
  async run(fc): Promise<AttackFinding[]> {
    const { http, log } = fc;
    const found: AttackFinding[] = [];
    for (const page of pages(fc, 6)) {
      for (const header of UNKEYED) {
        if (http.left() < 4000) return found;
        const marker = `glv-cache-${id()}.invalid`;
        const url = withBuster(page, id());
        const value = /proto|scheme/.test(header) ? "http" : /url/.test(header) ? `/${marker}` : marker;
        try {
          const first = await http.get(url, { headers: { [header]: value } });
          const reflected = first.body.includes(marker) || (first.location ?? "").includes(marker) || (/proto|scheme/.test(header) && first.status >= 300 && first.status < 400 && !/^https?:/.test(first.location ?? "x"));
          if (!reflected) continue;
          const second = await http.get(url);
          const cached = second.body.includes(marker) || (second.location ?? "").includes(marker);
          const cacheSign = second.headers["x-cache"] ?? second.headers["cf-cache-status"] ?? second.headers.age ?? second.headers["x-varnish"] ?? "";
          if (!cached) continue;
          found.push({
            rule: "attack:cache-poisoning",
            severity: "high",
            tag: "header",
            title: `Web cache poisoning through ${header}`,
            detail: `A request with "${header}: ${value}" changed the page, and a following request without it got the changed page back from the cache. An attacker can do this on the real page so every visitor gets a page that loads the attacker's script or redirects (CWE-349). GLV only poisoned its own cache-busted copy (?glvcb=…). How to fix: stop using ${header} (or add it to the cache key with Vary), and build links from a fixed site address.`,
            pageUrl: pathOf(page),
            evidence: `1) ${url} with ${header}: ${value} → marker in the answer\n2) ${url} without it → marker still there${cacheSign ? ` (cache: ${cacheSign})` : ""}`,
            key: `cache-poison:${pathOf(page)}:${header}`,
          });
          break;
        } catch (err) {
          if (fc.ctx.signal.aborted) throw err;
        }
      }
    }
    if (found.length) log(`Cache poisoning: ${found.length} confirmed`);
    return found;
  },
};

/** One raw request, timed; resolves on the first answer bytes or the timeout. */
export function rawTimed(url: URL, payload: string, timeoutMs: number, signal: AbortSignal): Promise<{ ms: number; timedOut: boolean; head: string }> {
  return new Promise((resolve) => {
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    const started = Date.now();
    const sock: net.Socket = url.protocol === "https:" ? tls.connect({ host: url.hostname, port, servername: url.hostname, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] }) : net.connect({ host: url.hostname, port });
    let done = false;
    const finish = (timedOut: boolean, head = "") => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ms: Date.now() - started, timedOut, head });
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    signal.addEventListener("abort", () => finish(true), { once: true });
    sock.once(url.protocol === "https:" ? "secureConnect" : "connect", () => sock.write(payload));
    sock.once("data", (d: Buffer) => finish(false, d.toString("latin1").split("\r\n")[0] ?? ""));
    sock.once("error", () => finish(false));
    sock.once("close", () => finish(false));
  });
}

/** The two smuggling probes in safe "timeout" form: each makes the back end wait, never queues a request for someone else. Pure, for tests. */
export function smugglingProbes(url: URL): { id: "CL.TE" | "TE.CL"; payload: string }[] {
  const path = `${url.pathname || "/"}${url.search}`;
  const head = (extra: string) => `POST ${path} HTTP/1.1\r\nHost: ${url.host}\r\nUser-Agent: GLV-Testing-Agent attack agent\r\nContent-Type: application/x-www-form-urlencoded\r\nConnection: close\r\n${extra}\r\n`;
  return [
    // Front end reads Content-Length (4: "1\r\nA"), back end reads chunked and waits for the rest.
    { id: "CL.TE", payload: `${head("Transfer-Encoding: chunked\r\nContent-Length: 4\r\n")}1\r\nA\r\nX` },
    // Front end reads chunked (ends at 0), back end reads Content-Length 6 and waits for more.
    { id: "TE.CL", payload: `${head("Transfer-Encoding: chunked\r\nContent-Length: 6\r\n")}0\r\n\r\nX` },
  ];
}

/**
 * HTTP request smuggling (desync), in the safe timeout form smuggler and Burp use: a request whose
 * Content-Length and Transfer-Encoding disagree. If the front end and back end read it differently,
 * the back end waits for bytes that never come, so the answer is much slower than a normal one. The
 * probe never leaves a request queued for another visitor. Confirmed by repeating it.
 */
export const smugglingFamily: Family = {
  id: "smuggling",
  label: "HTTP request smuggling (desync)",
  hint: "Safe timeout probes only (CL.TE and TE.CL); flagged when the answer is held back twice in a row while normal requests are fast.",
  async run(fc): Promise<AttackFinding[]> {
    const { http, log, ctx } = fc;
    const found: AttackFinding[] = [];
    const targets = pages(fc, 3);
    for (const page of targets) {
      if (http.left() < 25_000) break;
      const url = new URL(page);
      const normal = await rawTimed(url, `GET ${url.pathname || "/"} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`, 10_000, ctx.signal);
      if (normal.timedOut || normal.ms > 4000) continue;
      for (const p of smugglingProbes(url)) {
        const a = await rawTimed(url, p.payload, 10_000, ctx.signal);
        if (!a.timedOut && a.ms < normal.ms + 5000) continue;
        const b = await rawTimed(url, p.payload, 10_000, ctx.signal);
        if (!b.timedOut && b.ms < normal.ms + 5000) continue;
        found.push({
          rule: "attack:request-smuggling",
          severity: "critical",
          tag: "header",
          title: `HTTP request smuggling (${p.id}) on ${url.host}`,
          detail: `A request whose Content-Length and Transfer-Encoding disagree was held back for ${Math.round(a.ms / 1000)} s twice, while a normal request took ${normal.ms} ms. The front server (CDN, load balancer) and the back server read the request differently (${p.id}), so an attacker can hide a request inside another and take over other visitors' requests and sessions (CWE-444). How to fix: make the front end reject requests with both headers or normalise them, use HTTP/2 end to end, and update the proxy and server.`,
          pageUrl: pathOf(page),
          evidence: `Normal GET ${normal.ms} ms; ${p.id} probe ${a.timedOut ? "timed out" : `${a.ms} ms`} and ${b.timedOut ? "timed out" : `${b.ms} ms`} (safe timeout form, nothing queued)`,
          key: `smuggling:${url.host}:${p.id}`,
        });
        break;
      }
    }
    if (found.length) log(`Request smuggling: ${found.length} found`);
    return found;
  },
};
