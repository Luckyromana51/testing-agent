import net from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isPrivateHost, registrableDomain, systemDns, type DnsLookup } from "../agents/web/domain.js";
import { WEB_PRODUCTS } from "../products.js";
import type { Severity } from "../types.js";
import { runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

/**
 * Attack surface: every subdomain of the client's domain we can find, which of them still point at a
 * deleted cloud service anyone can claim (subdomain takeover), and forgotten servers (staging, old,
 * default pages). Discovery reads public data only (DNS and certificate logs); each found subdomain is
 * opened once, like a visitor. The port check is separate and needs the client's written permission.
 */

/** Names companies often give subdomains. */
export const COMMON_SUBS = [
  "www", "mail", "webmail", "smtp", "pop", "imap", "mx", "autodiscover", "cpanel", "whm", "webdisk", "ftp", "sftp", "ns1", "ns2",
  "api", "api2", "app", "apps", "admin", "administrator", "portal", "dashboard", "panel", "login", "auth", "sso", "id", "account", "accounts",
  "dev", "development", "staging", "stage", "stg", "test", "testing", "qa", "uat", "demo", "sandbox", "preprod", "pre", "beta", "alpha", "old", "new", "legacy", "backup", "bak", "temp", "tmp",
  "shop", "store", "cart", "pay", "payment", "payments", "checkout", "billing", "invoice", "crm", "erp", "hr", "jobs", "careers",
  "blog", "news", "docs", "doc", "help", "support", "kb", "status", "wiki", "forum", "community", "events", "learn", "academy",
  "cdn", "static", "assets", "img", "images", "media", "files", "download", "downloads", "upload", "uploads", "s3", "storage",
  "m", "mobile", "wap", "intranet", "internal", "vpn", "remote", "git", "gitlab", "jenkins", "ci", "jira", "confluence", "grafana", "kibana", "monitor", "metrics", "db", "mysql", "phpmyadmin", "pma",
  "web", "www2", "home", "office", "partner", "partners", "client", "clients", "customer", "go", "link", "links", "click", "track", "email", "newsletter", "marketing", "promo", "landing", "lp",
];

/** Cloud services where a forgotten subdomain can be claimed, with how to recognise an unclaimed one. */
export const TAKEOVER: { service: string; cname: RegExp; body?: RegExp; nxdomain?: boolean }[] = [
  { service: "GitHub Pages", cname: /\.github\.io$/, body: /There isn't a GitHub Pages site here/i },
  { service: "Heroku", cname: /\.(herokuapp|herokudns|herokussl)\.com$/, body: /no-such-app\.html|No such app|herokucdn\.com\/error-pages/i },
  { service: "Amazon S3", cname: /\.s3[.-]([a-z0-9-]+\.)?amazonaws\.com$|\.s3-website[.-]/, body: /NoSuchBucket|The specified bucket does not exist/i },
  { service: "AWS Elastic Beanstalk", cname: /\.elasticbeanstalk\.com$/, nxdomain: true },
  { service: "Azure", cname: /\.(azurewebsites\.net|cloudapp\.net|cloudapp\.azure\.com|trafficmanager\.net|blob\.core\.windows\.net|azureedge\.net|azure-api\.net|azurefd\.net|azurecontainer\.io|azurestaticapps\.net)$/, nxdomain: true },
  { service: "Shopify", cname: /\.myshopify\.com$/, body: /Sorry, this shop is currently unavailable|Only one step left/i },
  { service: "Fastly", cname: /\.fastly\.net$/, body: /Fastly error: unknown domain/i },
  { service: "Ghost", cname: /\.ghost\.io$/, body: /The thing you were looking for is no longer here|Domain error/i },
  { service: "Surge", cname: /\.surge\.sh$/, body: /project not found/i },
  { service: "Bitbucket", cname: /\.bitbucket\.io$/, body: /Repository not found/i },
  { service: "Pantheon", cname: /\.pantheonsite\.io$/, body: /The gods are wise|404 error unknown site/i },
  { service: "Tumblr", cname: /^domains\.tumblr\.com$/, body: /Whatever you were looking for doesn't currently exist at this address|There's nothing here/i },
  { service: "WordPress.com", cname: /\.wordpress\.com$/, body: /Do you want to register .*\.wordpress\.com/i },
  { service: "Zendesk", cname: /\.zendesk\.com$/, body: /Help Center Closed/i },
  { service: "Webflow", cname: /proxy(-ssl)?\.webflow\.com$/, body: /The page you are looking for doesn.t exist or has been moved/i },
  { service: "Unbounce", cname: /\.unbouncepages\.com$/, body: /The requested URL was not found on this server/i },
  { service: "ReadMe", cname: /\.readme\.io$/, body: /Project doesnt exist\.\.\. yet!/i },
  { service: "Strikingly", cname: /\.strikinglydns\.com$/, body: /PAGE NOT FOUND/i },
  { service: "Helpjuice", cname: /\.helpjuice\.com$/, body: /We could not find what you're looking for/i },
  { service: "Agile CRM", cname: /\.agilecrm\.com$/, body: /Sorry, this page is no longer available/i },
  { service: "UserVoice", cname: /\.uservoice\.com$/, body: /This UserVoice subdomain is currently available/i },
  { service: "Kinsta", cname: /\.kinsta\.cloud$/, body: /No Site For Domain/i },
  { service: "Canny", cname: /\.canny\.io$/, body: /Company Not Found|There is no such company/i },
  { service: "LaunchRock", cname: /\.launchrock\.com$/, body: /It looks like you may have taken a wrong turn/i },
  { service: "Netlify", cname: /\.netlify\.(app|com)$/, body: /Not Found - Request ID/i },
  { service: "Cargo", cname: /\.cargocollective\.com$/, body: /404 Not Found/i },
];

/** Names that usually mean a server nobody looks after any more. */
const FORGOTTEN = /^(dev|development|staging|stage|stg|test|testing|qa|uat|demo|sandbox|preprod|pre|beta|alpha|old|legacy|backup|bak|temp|tmp|phpmyadmin|pma|jenkins|ci|grafana|kibana|db|mysql|internal|intranet)\d*\./;
/** Pages that show a server was set up and never finished, or leaks its files. */
const DEFAULT_PAGES: [RegExp, string][] = [
  [/<title>Index of \//i, "a folder listing (Index of /)"],
  [/Welcome to nginx!/i, "the default nginx page"],
  [/Apache2 (Ubuntu|Debian) Default Page|It works!<\/h1>/i, "the default Apache page"],
  [/IIS Windows Server|iisstart\.png/i, "the default IIS page"],
  [/<title>phpinfo\(\)<\/title>|PHP Version \d/i, "phpinfo() output"],
  [/phpMyAdmin/i, "phpMyAdmin"],
  [/Dashboard \[Jenkins\]|<title>Jenkins/i, "Jenkins"],
  [/Kibana|<title>Grafana/i, "a monitoring dashboard"],
  [/Domain (is )?(for sale|parked)|This domain may be for sale|sedoparking/i, "a parked or for-sale page"],
];

export interface SubdomainFacts {
  name: string;
  cname: string[];
  addresses: string[];
  status?: number;
  title?: string;
  body?: string;
  /** The CNAME target does not exist any more. */
  dangling?: boolean;
}

/** Pure: what is wrong with one subdomain. */
export function subdomainProblems(s: SubdomainFacts): { rule: string; severity: Severity; title: string; detail: string; evidence: string }[] {
  const out: { rule: string; severity: Severity; title: string; detail: string; evidence: string }[] = [];
  const target = s.cname[s.cname.length - 1]?.toLowerCase().replace(/\.$/, "") ?? "";
  for (const t of TAKEOVER) {
    if (!target || !t.cname.test(target)) continue;
    const bodyHit = t.body && s.body ? t.body.test(s.body) : false;
    if (bodyHit || (t.nxdomain && s.dangling)) {
      out.push({
        rule: "surface:subdomain-takeover",
        severity: "critical",
        title: `${s.name} can be taken over (${t.service})`,
        detail: `${s.name} still points to ${target} on ${t.service}, but nothing is set up there any more. Anyone can create a ${t.service} site with that name and serve their own pages, cookies and phishing on your domain. Remove the DNS record now, or claim the name again on ${t.service}.`,
        evidence: `${s.name} CNAME ${s.cname.join(" → ")}${bodyHit ? `\n${t.service} answers: unclaimed` : "\nThe target does not exist (NXDOMAIN)"}`,
      });
      return out;
    }
  }
  if (s.dangling && target) {
    out.push({
      rule: "surface:dangling-cname",
      severity: "medium",
      title: `${s.name} points to a name that no longer exists`,
      detail: `${s.name} has a CNAME to ${target}, which does not exist. If that name can be registered by someone else, they control ${s.name}. Remove the record if it is not used.`,
      evidence: `${s.name} CNAME ${s.cname.join(" → ")} (NXDOMAIN)`,
    });
  }
  const page = DEFAULT_PAGES.find(([re]) => s.body && re.test(s.body));
  if (page && (s.status ?? 0) < 400) {
    out.push({
      rule: "surface:default-page",
      severity: /phpinfo|folder|phpMyAdmin|Jenkins|monitoring/.test(page[1]) ? "high" : "medium",
      title: `${s.name} shows ${page[1]}`,
      detail: `A forgotten or half-set-up server is open to the internet. ${/phpinfo|folder|phpMyAdmin|Jenkins|monitoring/.test(page[1]) ? "It gives away files, settings or admin access. " : ""}Take it down, put it behind a login or VPN, or finish setting it up.`,
      evidence: `https://${s.name}/ → ${s.status} ${s.title ?? ""}`.trim(),
    });
  } else if (FORGOTTEN.test(`${s.name}.`) && s.status !== undefined && s.status < 400) {
    out.push({
      rule: "surface:exposed-non-production",
      severity: "medium",
      title: `${s.name} is open to everyone`,
      detail: "Staging, test, old and admin servers are often out of date and less protected than the live site, and they can hold real data. Put them behind a login, VPN or IP allow-list, and stop search engines indexing them.",
      evidence: `https://${s.name}/ → ${s.status} ${s.title ?? ""}`.trim(),
    });
  }
  return out;
}

/** Subdomains from certificate transparency logs (crt.sh): every HTTPS certificate ever issued for the domain. */
async function fromCertLogs(domain: string, signal: AbortSignal): Promise<string[]> {
  const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, { signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]) });
  if (!res.ok) throw new Error(`crt.sh answered ${res.status}`);
  const rows = (await res.json()) as { name_value?: string }[];
  return rows.flatMap((r) => (r.name_value ?? "").split(/\s+/)).map((n) => n.toLowerCase().replace(/^\*\./, ""));
}

async function fromSubfinder(domain: string, ctx: ToolContext): Promise<string[]> {
  const bin = process.env.SUBFINDER_PATH || "subfinder";
  if (!(await which(bin))) return [];
  const res = await runProcess(bin, ["-d", domain, "-silent", "-all", "-timeout", "20", "-max-time", "4"], { signal: ctx.signal, timeoutMs: 300_000, cwd: ctx.workDir });
  return res.stdout.split("\n").map((l) => l.trim().toLowerCase()).filter(Boolean);
}

/** Runs many small jobs, a few at a time. */
async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>, signal: AbortSignal): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        signal.throwIfAborted();
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function look(name: string, d: DnsLookup, signal: AbortSignal): Promise<SubdomainFacts | null> {
  const chain: string[] = [];
  let at = name;
  for (let i = 0; i < 6; i++) {
    const c = await d.cname(at).catch(() => []);
    if (!c.length) break;
    chain.push(c[0]);
    at = c[0];
  }
  const addresses = await d.a(name).catch(() => []);
  if (!chain.length && !addresses.length) return null;
  const facts: SubdomainFacts = { name, cname: chain, addresses };
  if (chain.length && !addresses.length) {
    const target = chain[chain.length - 1];
    facts.dangling = (await d.a(target).catch(() => [])).length === 0 && (await d.cname(target).catch(() => [])).length === 0;
  }
  if (addresses.length) {
    for (const scheme of ["https", "http"]) {
      try {
        const res = await fetch(`${scheme}://${name}/`, { redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        const body = (await res.text()).slice(0, 60_000);
        facts.status = res.status;
        facts.body = body;
        facts.title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim().slice(0, 80);
        break;
      } catch {
        // Try plain http, then give up: nothing is served.
      }
    }
  }
  return facts;
}

export async function discover(domain: string, ctx: ToolContext, d: DnsLookup, opts: { certLogs: boolean; limit: number }): Promise<{ facts: SubdomainFacts[]; sources: string[]; names: number }> {
  const names = new Set(COMMON_SUBS.map((s) => `${s}.${domain}`));
  const sources = [`${COMMON_SUBS.length} common names`];
  if (opts.certLogs) {
    try {
      const fromCt = (await fromCertLogs(domain, ctx.signal)).filter((n) => n.endsWith(`.${domain}`) && /^[a-z0-9.-]+$/.test(n));
      for (const n of fromCt) names.add(n);
      sources.push(`${fromCt.length} names from certificate logs`);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log(`Attack surface: certificate logs could not be read (${(err as Error).message})`);
    }
  }
  const sf = await fromSubfinder(domain, ctx).catch(() => []);
  if (sf.length) {
    for (const n of sf.filter((n) => n.endsWith(`.${domain}`))) names.add(n);
    sources.push(`${sf.length} names from subfinder`);
  }
  const list = [...names].slice(0, opts.limit);
  const found = (await pool(list, 12, (n) => look(n, d, ctx.signal), ctx.signal)).filter((f): f is SubdomainFacts => f !== null);
  return { facts: found, sources, names: list.length };
}

export const surfaceTool: Tool = {
  id: "surface",
  name: "Attack surface and subdomain takeover",
  maker: "GLV Infotech (built in), with subfinder (ProjectDiscovery) when installed",
  description:
    "Finds the client's subdomains (common names, certificate logs, subfinder), then flags subdomains anyone can take over (a CNAME to a deleted GitHub Pages, Heroku, S3, Azure, Shopify… site), dangling DNS records, and forgotten servers: staging and test sites open to all, default server pages, folder listings, phpinfo and admin tools.",
  checks: [
    "Subdomain takeover on 26 cloud services (the can-i-take-over-xyz fingerprints)",
    "Dangling CNAME records that point to names that no longer exist",
    "Forgotten servers: dev, staging, test, old, backup, admin open to everyone",
    "Default nginx, Apache and IIS pages, folder listings, phpinfo, phpMyAdmin, Jenkins",
    "Public data only: DNS and certificate logs, each subdomain opened once like a visitor",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "safe",
  takes: "1 to 4 minutes",
  licence: "GLV's own; subfinder MIT",
  homepage: "https://github.com/projectdiscovery/subfinder",
  signedIn: "public",
  options: [
    { id: "certLogs", label: "Read certificate logs (crt.sh)", hint: "Public, free certificate transparency logs; they list subdomains the common names miss.", choices: [{ value: "on", label: "Yes" }, { value: "off", label: "No" }], default: "on" },
    { id: "limit", label: "Most subdomains to check", choices: ["200", "500", "1000", "2000"].map((v) => ({ value: v, label: v })), default: "500" },
  ],

  async ready() {
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const host = new URL(ctx.startUrl).hostname;
    if (isPrivateHost(host)) {
      return { findings: [], summary: ["The site is on a private address: it has no public subdomains to check"], tested: "Nothing: private address" };
    }
    const domain = registrableDomain(host);
    ctx.log(`Attack surface: finding subdomains of ${domain}`);
    const { facts, sources, names } = await discover(domain, ctx, systemDns(), { certLogs: ctx.options.certLogs !== "off", limit: Number(ctx.options.limit) || 500 });
    const findings: ToolFinding[] = [];
    for (const s of facts) {
      for (const p of subdomainProblems(s)) {
        findings.push({ category: "security", rule: p.rule, severity: p.severity, title: p.title, detail: p.detail, pageUrl: `https://${s.name}/`, evidence: p.evidence, key: `${p.rule}:${s.name}` });
      }
    }
    const rows = facts
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => [s.name, s.cname.length ? s.cname[s.cname.length - 1] : s.addresses.slice(0, 2).join(", "), s.status === undefined ? (s.dangling ? "dangling" : "no web server") : String(s.status), s.title ?? ""]);
    await writeFile(path.join(ctx.outDir, "tool-surface.json"), JSON.stringify({ domain, sources, subdomains: facts.map(({ body: _b, ...f }) => f) }, null, 2));
    return {
      findings,
      summary: [`${facts.length} live subdomains of ${domain} (checked ${names}: ${sources.join(", ")})`, `${findings.filter((f) => f.rule === "surface:subdomain-takeover").length} can be taken over`],
      reports: [{ file: "tool-surface.json", label: "Subdomains found (JSON)" }],
      tested: `${names} possible subdomains of ${domain}`,
      table: { title: "Subdomains", columns: ["Name", "Points to", "Answer", "Title"], rows: rows.slice(0, 300) },
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Open ports: only with the client's written permission (it is a scan of their servers)

export const PORTS: [number, string, Severity][] = [
  [21, "FTP (passwords travel in plain text)", "high"],
  [22, "SSH", "info"],
  [23, "Telnet (plain text remote login)", "critical"],
  [25, "SMTP mail", "info"],
  [53, "DNS", "info"],
  [80, "HTTP", "info"],
  [110, "POP3 mail (plain text)", "low"],
  [111, "RPC portmapper", "high"],
  [135, "Windows RPC", "high"],
  [139, "Windows file sharing (NetBIOS)", "critical"],
  [143, "IMAP mail (plain text)", "low"],
  [443, "HTTPS", "info"],
  [445, "Windows file sharing (SMB)", "critical"],
  [465, "SMTP over TLS", "info"],
  [587, "SMTP submission", "info"],
  [993, "IMAPS", "info"],
  [995, "POP3S", "info"],
  [1433, "Microsoft SQL Server database", "critical"],
  [1521, "Oracle database", "critical"],
  [2049, "NFS file sharing", "critical"],
  [2082, "cPanel (plain HTTP)", "medium"],
  [2083, "cPanel", "low"],
  [2086, "WHM (plain HTTP)", "medium"],
  [2087, "WHM", "low"],
  [2375, "Docker API without TLS (full control of the server)", "critical"],
  [2376, "Docker API", "high"],
  [3000, "Development server (Node, Grafana)", "medium"],
  [3306, "MySQL / MariaDB database", "critical"],
  [3389, "Windows Remote Desktop", "high"],
  [5000, "Development server (Flask, Docker registry)", "medium"],
  [5432, "PostgreSQL database", "critical"],
  [5601, "Kibana", "high"],
  [5900, "VNC remote desktop", "critical"],
  [5984, "CouchDB database", "critical"],
  [6379, "Redis database", "critical"],
  [7001, "WebLogic", "high"],
  [8000, "Development or admin web server", "medium"],
  [8080, "Alternate web server or proxy", "low"],
  [8081, "Alternate web server", "low"],
  [8443, "Alternate HTTPS (admin panels)", "low"],
  [8888, "Jupyter or admin web server", "high"],
  [9000, "PHP-FPM, Portainer or SonarQube", "high"],
  [9090, "Prometheus or Cockpit", "high"],
  [9200, "Elasticsearch database", "critical"],
  [9300, "Elasticsearch cluster", "high"],
  [10000, "Webmin", "high"],
  [11211, "Memcached", "critical"],
  [15672, "RabbitMQ admin", "high"],
  [27017, "MongoDB database", "critical"],
  [50000, "Jenkins agent", "high"],
];

/** Opens a TCP connection and reads the first line the service says, if any. */
export function probePort(host: string, port: number, timeoutMs = 2500): Promise<{ open: boolean; banner: string }> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let banner = "";
    let open = false;
    const done = () => {
      sock.destroy();
      resolve({ open, banner: banner.replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 120) });
    };
    sock.setTimeout(timeoutMs, done);
    sock.on("connect", () => {
      open = true;
      setTimeout(done, 800);
    });
    sock.on("data", (d) => {
      banner += d.toString("latin1");
      if (banner.length > 80) done();
    });
    sock.on("error", done);
  });
}

export const portsTool: Tool = {
  id: "ports",
  name: "Open ports",
  maker: "GLV Infotech (built in)",
  description: "Connects to the 50 ports attackers check first on each host the client allowed, and flags databases, remote desktops, file sharing, Docker and admin tools that are open to the internet.",
  checks: [
    "Databases open to the internet: MySQL, PostgreSQL, MongoDB, Redis, Elasticsearch, SQL Server",
    "Remote access: Telnet, RDP, VNC, SMB, an open Docker API",
    "Admin and development tools: Jenkins, Kibana, Webmin, Jupyter, dev servers",
    "A plain connect, nothing is sent: only on hosts in the client's written permission",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "permission",
  permission: "attack",
  takes: "under a minute",
  licence: "GLV's own",
  homepage: "https://glvinfotechsolutions.com",
  signedIn: "public",

  async ready() {
    return null;
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const hosts = [...new Set((ctx.permit?.hosts ?? [new URL(ctx.startUrl).host]).map((h) => h.replace(/:\d+$/, "")))];
    const findings: ToolFinding[] = [];
    const rows: string[][] = [];
    for (const host of hosts) {
      ctx.signal.throwIfAborted();
      ctx.log(`Open ports: checking ${PORTS.length} ports on ${host}`);
      const results = await pool(PORTS, 10, async ([port, what, severity]) => ({ port, what, severity, ...(await probePort(host, port)) }), ctx.signal);
      for (const r of results.filter((r) => r.open)) {
        rows.push([host, String(r.port), r.what, r.banner]);
        if (r.severity === "info") continue;
        findings.push({
          category: "security",
          rule: r.severity === "critical" ? "ports:dangerous-open" : "ports:open",
          severity: r.severity,
          title: `Port ${r.port} is open on ${host}: ${r.what}`,
          detail: `${r.what} answers on ${host}:${r.port} from the internet. ${r.severity === "critical" ? "Services like this are attacked within hours of being found; many leak all their data with no password. " : ""}Close it in the firewall (or Hostinger's VPS firewall), or allow only GLV's and the client's office IP addresses.`,
          pageUrl: `https://${host}/`,
          evidence: `${host}:${r.port} open${r.banner ? `, says: ${r.banner}` : ""}`,
          key: `ports:${host}:${r.port}`,
        });
      }
    }
    return {
      findings,
      summary: [`${rows.length} open ports on ${hosts.length} host${hosts.length === 1 ? "" : "s"}`],
      tested: `${PORTS.length} ports on ${hosts.join(", ")}`,
      table: { title: "Open ports", columns: ["Host", "Port", "Service", "Says"], rows },
    };
  },
};
