import dgram from "node:dgram";
import { promises as dns } from "node:dns";

/**
 * Domain helpers for the DNS checks: the registrable domain of a host (example.co.in for
 * www.example.co.in), and a small DNS client for the record types Node cannot ask for (DS).
 */

/** Two-part public suffixes common for GLV's clients (India, UK, Australia...). */
const TWO_PART = new Set(
  [
    "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "res.in", "gov.in", "nic.in", "mil.in",
    "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "org.nz", "co.za", "com.sg", "com.my", "com.br", "com.mx", "co.jp", "ne.jp", "or.jp", "com.cn", "com.hk",
    "co.id", "co.kr", "com.tr", "com.sa", "com.pk", "com.bd", "com.np", "com.lk", "ae.org", "co.ae", "com.ng", "co.ke",
  ],
);

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || !h.includes(".")) return h;
  const parts = h.split(".");
  const last2 = parts.slice(-2).join(".");
  return TWO_PART.has(last2) && parts.length >= 3 ? parts.slice(-3).join(".") : last2;
}

/** True for addresses that are only on this machine or a private network (no public DNS to check). */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0)/.test(h) || h.endsWith(".local") || h.endsWith(".test") || h.endsWith(".internal") || !h.includes(".");
}

/** The lookups the DNS checks need; tests pass a fake. */
export interface DnsLookup {
  txt(name: string): Promise<string[]>;
  mx(name: string): Promise<{ exchange: string; priority: number }[]>;
  caa(name: string): Promise<{ tag: string; value: string }[]>;
  cname(name: string): Promise<string[]>;
  a(name: string): Promise<string[]>;
  ns(name: string): Promise<string[]>;
  /** How many DS records the parent zone has for the name (DNSSEC); null when it cannot be asked. */
  ds(name: string): Promise<number | null>;
}

const quiet = async <T>(p: Promise<T>, empty: T): Promise<T> => {
  try {
    return await p;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "ENOTIMP" || code === "EREFUSED" || code === "ESERVFAIL" || code === "NXDOMAIN") return empty;
    throw err;
  }
};

/** Builds a DNS question packet for one name and type (RFC 1035). */
export function dnsQuery(name: string, type: number, id = Math.floor(Math.random() * 65535)): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const qname = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, "ascii")])), Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4);
  // One additional record: EDNS0 with the DNSSEC OK bit, so a validating resolver keeps DS records.
  header.writeUInt16BE(1, 10);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2);
  const opt = Buffer.from([0, 0, 41, 0x10, 0x00, 0, 0, 0x80, 0, 0, 0]);
  return Buffer.concat([header, qname, q, opt]);
}

/** Counts the answers of one type in a DNS reply, or null when the reply is broken. */
export function countAnswers(reply: Buffer, type: number): number | null {
  if (reply.length < 12) return null;
  const rcode = reply.readUInt16BE(2) & 0x0f;
  if (rcode === 3) return 0;
  if (rcode !== 0) return null;
  const qd = reply.readUInt16BE(4);
  const an = reply.readUInt16BE(6);
  let off = 12;
  const skipName = () => {
    while (off < reply.length) {
      const len = reply[off];
      if (len === 0) {
        off += 1;
        return;
      }
      if ((len & 0xc0) === 0xc0) {
        off += 2;
        return;
      }
      off += len + 1;
    }
  };
  for (let i = 0; i < qd; i++) {
    skipName();
    off += 4;
  }
  let n = 0;
  for (let i = 0; i < an && off < reply.length; i++) {
    skipName();
    const t = reply.readUInt16BE(off);
    const rdlen = reply.readUInt16BE(off + 8);
    off += 10 + rdlen;
    if (t === type) n++;
  }
  return n;
}

function udpAsk(server: string, packet: Buffer, timeoutMs = 4000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(server.includes(":") ? "udp6" : "udp4");
    const timer = setTimeout(() => {
      sock.close();
      resolve(null);
    }, timeoutMs);
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      sock.close();
      resolve(null);
    });
    sock.send(packet, 53, server);
  });
}

/** The real lookups, through this server's own resolver (or DNS_SERVER from .env). */
export function systemDns(): DnsLookup {
  const r = new dns.Resolver({ timeout: 5000, tries: 2 });
  if (process.env.DNS_SERVER) r.setServers(process.env.DNS_SERVER.split(",").map((s) => s.trim()));
  return {
    txt: async (n) => (await quiet(r.resolveTxt(n), [] as string[][])).map((parts) => parts.join("")),
    mx: (n) => quiet(r.resolveMx(n), []),
    caa: async (n) =>
      (await quiet(r.resolveCaa(n), [])).map((c) => {
        const rec = c as unknown as Record<string, string>;
        const tag = ["issue", "issuewild", "iodef"].find((t) => rec[t] !== undefined) ?? "other";
        return { tag, value: String(rec[tag] ?? "") };
      }),
    cname: (n) => quiet(r.resolveCname(n), []),
    a: (n) => quiet(r.resolve4(n), []),
    ns: (n) => quiet(r.resolveNs(n), []),
    async ds(n) {
      const server = r.getServers()[0]?.replace(/^\[|\](:\d+)?$/g, "").replace(/:53$/, "");
      if (!server) return null;
      const reply = await udpAsk(server, dnsQuery(n, 43));
      return reply ? countAnswers(reply, 43) : null;
    },
  };
}
