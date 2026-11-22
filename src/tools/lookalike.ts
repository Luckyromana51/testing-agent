import { isPrivateHost, registrableDomain, systemDns, type DnsLookup } from "../agents/web/domain.js";
import { WEB_PRODUCTS } from "../products.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Lookalike domains, in the way dnstwist works: typo and look-alike versions of the client's domain
 * (glvinfotech → glvlnfotech, glv-infotech, glvinfotech.co, glvinfotecch…) are looked up in public
 * DNS. A registered one with mail servers can send phishing email that looks like the client's; one
 * with a website can host a fake login page. DNS only: the lookalike sites are never opened.
 */

const KEYBOARD: Record<string, string> = {
  q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "o",
  a: "qsz", s: "awdz", d: "sefx", f: "drgc", g: "fthv", h: "gyjb", j: "hukn", k: "jilm", l: "kop",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};
const GLYPHS: Record<string, string[]> = { o: ["0"], l: ["1", "i"], i: ["1", "l"], e: ["3"], a: ["4"], s: ["5"], m: ["rn"], w: ["vv"], g: ["q"], b: ["d"], d: ["b", "cl"], n: ["m"], u: ["v"] };
export const LOOKALIKE_TLDS = ["com", "in", "co.in", "net", "org", "co", "info", "online", "site", "app", "io", "shop", "store", "biz", "xyz"];

/** The lookalike names of a domain, without the domain itself. Pure, for tests. */
export function lookalikes(domain: string, max = 600): string[] {
  const dot = domain.indexOf(".");
  const name = domain.slice(0, dot);
  const tld = domain.slice(dot + 1);
  const out = new Set<string>();
  const add = (n: string, t = tld) => {
    if (n && n !== name && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(n)) out.add(`${n}.${t}`);
  };
  for (let i = 0; i < name.length; i++) {
    add(name.slice(0, i) + name.slice(i + 1)); // omission
    add(name.slice(0, i) + name[i] + name.slice(i)); // repetition
    if (i < name.length - 1) add(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2)); // swap
    for (const k of KEYBOARD[name[i]] ?? "") add(name.slice(0, i) + k + name.slice(i + 1)); // typo
    for (const g of GLYPHS[name[i]] ?? []) add(name.slice(0, i) + g + name.slice(i + 1)); // look-alike letters
    if (i > 0) add(`${name.slice(0, i)}-${name.slice(i)}`); // hyphen
  }
  for (const w of ["login", "secure", "support", "pay", "online", "app", "my", "account", "help", "official", "india", "verify"]) {
    add(`${name}-${w}`);
    add(`${w}-${name}`);
    add(`${name}${w}`);
  }
  for (const t of LOOKALIKE_TLDS) if (t !== tld) out.add(`${name}.${t}`);
  out.delete(domain);
  return [...out].slice(0, max);
}

export interface Lookalike {
  name: string;
  addresses: string[];
  mx: string[];
}

/** How risky a registered lookalike is. Pure, for tests. */
export function lookalikeRisk(l: Lookalike, ownAddresses: string[]): { severity: "high" | "medium" | "low"; why: string } | null {
  if (!l.addresses.length && !l.mx.length) return null;
  if (l.addresses.some((a) => ownAddresses.includes(a))) return null; // the client's own (same server)
  if (l.mx.length && l.addresses.length) return { severity: "high", why: "it has a website and mail servers, so it can send email in a look-alike name and host a fake login page" };
  if (l.mx.length) return { severity: "high", why: "it has mail servers, so it can send phishing email that looks like yours" };
  return { severity: "medium", why: "it has a website, which could be a fake copy of yours" };
}

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>, signal: AbortSignal): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        signal.throwIfAborted();
        const x = items[i++];
        out.push(await fn(x));
      }
    }),
  );
  return out;
}

export async function findLookalikes(domain: string, d: DnsLookup, signal: AbortSignal, max = 600): Promise<{ registered: Lookalike[]; checked: number }> {
  const names = lookalikes(domain, max);
  const found = await pool(
    names,
    16,
    async (name) => {
      const [addresses, mx] = await Promise.all([d.a(name).catch(() => []), d.mx(name).catch(() => [])]);
      return { name, addresses, mx: mx.map((m) => m.exchange) };
    },
    signal,
  );
  return { registered: found.filter((f) => f.addresses.length || f.mx.length), checked: names.length };
}

export const lookalikeTool: Tool = {
  id: "lookalike",
  name: "Lookalike domains",
  maker: "GLV Infotech (built in), in the way of dnstwist",
  description:
    "Makes the typo and look-alike versions of the client's domain (a missing letter, 0 for o, a hyphen, -login, another ending such as .co.in) and looks each up in public DNS. Registered ones with mail servers or a website are listed: phishers use them to send email and host fake login pages in the client's name.",
  checks: ["Typos, swapped and doubled letters, look-alike letters (0/o, rn/m), hyphens", "Added words (-login, secure-, -support) and other endings (.in, .co.in, .net, .shop…)", "Mail servers (phishing email) and websites (fake pages) on each", "DNS only: the lookalike sites are never opened"],
  products: WEB_PRODUCTS,
  category: "security",
  safety: "safe",
  takes: "1 to 2 minutes",
  licence: "GLV's own",
  homepage: "https://github.com/elceef/dnstwist",
  signedIn: "public",
  options: [{ id: "max", label: "Most names to check", choices: ["200", "600", "1200"].map((v) => ({ value: v, label: v })), default: "600" }],
  async ready() {
    return null;
  },
  async run(ctx: ToolContext): Promise<ToolOutput> {
    const host = new URL(ctx.startUrl).hostname;
    if (isPrivateHost(host)) return { findings: [], summary: ["The site is on a private address: nothing to check"], tested: "Nothing: private address" };
    const domain = registrableDomain(host);
    const d = systemDns();
    const own = [...(await d.a(domain).catch(() => [])), ...(await d.a(host).catch(() => []))];
    const { registered, checked } = await findLookalikes(domain, d, ctx.signal, Number(ctx.options.max) || 600);
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    for (const l of registered) {
      const risk = lookalikeRisk(l, own);
      rows.push([l.name, l.addresses.slice(0, 2).join(", ") || "-", l.mx.slice(0, 2).join(", ") || "-", risk ? risk.severity : "yours"]);
      if (!risk) continue;
      findings.push({ category: "security", rule: "lookalike:registered", severity: risk.severity, title: `${l.name} looks like ${domain} and is registered`, detail: `Someone owns ${l.name}: ${risk.why}. Check who owns it (whois). If it is not yours, report it to the registrar's abuse contact and to CERT-In (incident@cert-in.org.in), warn customers, and consider buying the most likely typos yourself. A strict DMARC policy (p=reject) on your own domain also helps customers' mail servers.`, pageUrl: `https://${domain}/`, evidence: `${l.name}: A ${l.addresses.join(", ") || "none"}; MX ${l.mx.join(", ") || "none"}`, key: `lookalike:${l.name}` });
    }
    return {
      findings,
      summary: [`${checked} lookalike names of ${domain} checked, ${registered.length} registered, ${findings.length} not on your servers`],
      tested: `${checked} lookalike names of ${domain}`,
      table: { title: "Registered lookalikes", columns: ["Domain", "Website", "Mail", "Risk"], rows },
    };
  },
};
