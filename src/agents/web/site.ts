import { randomBytes } from "node:crypto";
import tls from "node:tls";
import type { APIRequestContext, APIResponse } from "playwright";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";

async function fetchText(
  request: APIRequestContext,
  url: string,
  maxBytes = 512_000,
): Promise<{ status: number; type: string; text: string; res: APIResponse } | null> {
  try {
    const res = await request.get(url, { timeout: 15_000, maxRedirects: 3 });
    const type = res.headers()["content-type"] ?? "";
    const length = Number(res.headers()["content-length"] ?? 0);
    const text = length > maxBytes ? "" : (await res.text()).slice(0, maxBytes);
    return { status: res.status(), type, text, res };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// HTTPS: redirect from http:// and the certificate itself

export interface CertFacts {
  validTo: Date | null;
  authorizationError: string | null;
}

/** Turns certificate facts into findings. Pure, so it can be tested without a server. */
export function certFindings(host: string, cert: CertFacts, now = new Date()): Finding[] {
  const pageUrl = `https://${host}/`;
  const out: Finding[] = [];
  const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence?: string) =>
    out.push(finding({ category: "security", rule, severity, title, detail, pageUrl, evidence }));
  if (cert.validTo) {
    const days = Math.floor((cert.validTo.getTime() - now.getTime()) / 86_400_000);
    if (days < 0) {
      add(
        "sec:cert-expired",
        "critical",
        "The HTTPS certificate has expired",
        "Browsers show a full-page security warning and most visitors leave. Renew the certificate now and turn on auto-renewal.",
        `Expired ${cert.validTo.toDateString()}`,
      );
    } else if (days < 14) {
      add(
        "sec:cert-expiring",
        "high",
        `The HTTPS certificate expires in ${days} days`,
        "When it expires, browsers show a security warning. Renew it and check that auto-renewal works (Let's Encrypt certificates last 90 days).",
        `Valid until ${cert.validTo.toDateString()}`,
      );
    } else if (days < 30) {
      add(
        "sec:cert-expiring",
        "medium",
        `The HTTPS certificate expires in ${days} days`,
        "Renew it soon, or confirm auto-renewal is set up.",
        `Valid until ${cert.validTo.toDateString()}`,
      );
    }
  }
  const err = cert.authorizationError ?? "";
  if (err && err !== "CERT_HAS_EXPIRED") {
    const incomplete = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/.test(err);
    add(
      incomplete ? "sec:cert-chain" : "sec:cert-invalid",
      incomplete ? "medium" : "high",
      incomplete ? "The HTTPS certificate chain is incomplete" : "The HTTPS certificate is not trusted",
      incomplete
        ? "The server does not send the intermediate certificate. Desktop browsers often cope, but apps, APIs, payment callbacks and older phones fail. Install the full chain (fullchain.pem)."
        : "Some or all visitors will see a security warning. Check the certificate matches this domain and comes from a trusted authority.",
      err,
    );
  }
  return out;
}

function readCertificate(host: string): Promise<CertFacts | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      const facts: CertFacts = {
        validTo: cert?.valid_to ? new Date(cert.valid_to) : null,
        authorizationError: socket.authorized ? null : String(socket.authorizationError ?? ""),
      };
      socket.end();
      resolve(facts);
    });
    socket.on("error", () => resolve(null));
    socket.on("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

async function httpsFindings({ browser, origin, log }: SiteContext): Promise<Finding[]> {
  const u = new URL(origin);
  if (u.protocol !== "https:") return [];
  const out: Finding[] = [];
  const httpUrl = `http://${u.host}/`;
  try {
    const res = await browser.request.get(httpUrl, { maxRedirects: 0, timeout: 15_000 });
    const location = res.headers()["location"] ?? "";
    const redirectsToHttps = res.status() >= 300 && res.status() < 400 && location.startsWith("https://");
    if (!redirectsToHttps && res.status() < 300) {
      out.push(
        finding({
          category: "security",
          rule: "sec:no-https-redirect",
          severity: "medium",
          title: "The http:// address does not redirect to https://",
          detail:
            "Visitors who type the address without https:// get an unencrypted page. Add a permanent (301) redirect from HTTP to HTTPS.",
          pageUrl: httpUrl,
        }),
      );
    }
  } catch {
    // Port 80 closed or unreachable: nothing is served insecurely.
  }
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    // Behind a proxy we would see the proxy's certificate, not the site's.
    log("Skipping the certificate check: this server reaches the internet through a proxy");
  } else {
    const cert = await readCertificate(u.hostname);
    if (cert) out.push(...certFindings(u.hostname, cert));
  }
  return out;
}

export const httpsAgent: SiteAgent = {
  id: "web.https",
  name: "HTTPS and certificate",
  description: "Checks that http:// redirects to https://, and that the certificate is trusted, complete and not about to expire.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: httpsFindings,
};

// ---------------------------------------------------------------------------------------------
// Search engine access: robots.txt and sitemap

/** True when robots.txt blocks every crawler from the whole site. */
export function robotsBlocksAll(robots: string): boolean {
  let agents: string[] = [];
  let inRules = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const [field, value] = [m[1].toLowerCase(), m[2].trim()];
    if (field === "user-agent") {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      inRules = true;
      if (field === "disallow" && value === "/" && agents.includes("*")) return true;
    }
  }
  return false;
}

async function crawlabilityFindings({ browser, origin, pages }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  const robotsUrl = `${origin}/robots.txt`;
  const add = (rule: string, severity: Finding["severity"], title: string, detail: string, pageUrl: string, evidence?: string) =>
    out.push(finding({ category: "seo", rule, severity, title, detail, pageUrl, evidence }));

  const robots = await fetchText(browser.request, robotsUrl);
  const robotsText = robots && robots.status === 200 && !/html/i.test(robots.type) ? robots.text : "";
  if (robots && robots.status === 404) {
    add(
      "seo:robots-missing",
      "low",
      "No robots.txt file",
      "robots.txt tells search engines what to crawl and where the sitemap is. Add one, even if it allows everything.",
      robotsUrl,
    );
  }
  if (robotsText && robotsBlocksAll(robotsText)) {
    add(
      "seo:robots-blocks-all",
      "critical",
      "robots.txt blocks all search engines from the whole site",
      'The site will drop out of Google. This often happens when a staging robots.txt goes live. Remove "Disallow: /" for "User-agent: *".',
      robotsUrl,
      robotsText.slice(0, 300),
    );
  }

  const sitemapUrls = [...robotsText.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
  if (!sitemapUrls.length) sitemapUrls.push(`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`);
  let sitemap: { url: string; text: string } | null = null;
  for (const url of sitemapUrls.slice(0, 3)) {
    const r = await fetchText(browser.request, url, 5_000_000);
    if (r && r.status === 200 && /<(urlset|sitemapindex)/i.test(r.text)) {
      sitemap = { url, text: r.text };
      break;
    }
  }
  if (!sitemap) {
    add(
      "seo:sitemap-missing",
      "low",
      "No XML sitemap found",
      "A sitemap helps Google find every page. Add /sitemap.xml and list it in robots.txt.",
      `${origin}/sitemap.xml`,
    );
    return out;
  }

  // A sitemap index points to more sitemaps; read the first one.
  let locs = [...sitemap.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  if (/<sitemapindex/i.test(sitemap.text) && locs.length) {
    const child = await fetchText(browser.request, locs[0], 5_000_000);
    locs = child ? [...child.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&")) : [];
  }
  const otherHost = locs.filter((l) => {
    try {
      return new URL(l).origin !== origin;
    } catch {
      return false;
    }
  });
  if (locs.length && otherHost.length / locs.length > 0.5) {
    add(
      "seo:sitemap-wrong-host",
      "medium",
      "The sitemap lists a different address than the site uses",
      `The site lives at ${origin}, but the sitemap lists pages at ${new URL(otherHost[0]).origin}. Google treats these as different pages and has to follow redirects. Generate the sitemap with the final address.`,
      sitemap.url,
      otherHost.slice(0, 5).join("\n"),
    );
  }

  // Check a sample of sitemap pages we did not visit.
  const visited = new Set(pages.flatMap((p) => [p.url, p.redirectedFrom].filter(Boolean)));
  const sample = locs.filter((l) => !visited.has(l.replace(/\/$/, "")) && !visited.has(l)).slice(0, 15);
  const missing: string[] = [];
  for (const l of sample) {
    try {
      const res = await browser.request.get(l, { timeout: 15_000, maxRedirects: 5 });
      if (res.status() === 404 || res.status() === 410) missing.push(`${l}  (HTTP ${res.status()})`);
    } catch {
      // unreachable is not proof of a missing page
    }
  }
  if (missing.length) {
    add(
      "seo:sitemap-404",
      "medium",
      `${missing.length} page(s) in the sitemap do not exist`,
      "The sitemap sends Google to pages that return 404. Remove them from the sitemap or restore the pages.",
      sitemap.url,
      missing.join("\n"),
    );
  }
  return out;
}

export const crawlabilityAgent: SiteAgent = {
  id: "web.crawlability",
  name: "Search engine access",
  description: "Reads robots.txt and the sitemap: is Google blocked, is the sitemap there, does it list pages that exist on the right address.",
  category: "seo",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: crawlabilityFindings,
};

export const soft404Agent: SiteAgent = {
  id: "web.soft-404",
  name: "Missing page handling",
  description: "Opens an address that cannot exist and checks the site answers 404, not a normal page.",
  category: "seo",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, origin }) {
    const url = `${origin}/glv-check-${randomBytes(6).toString("hex")}`;
    const r = await fetchText(browser.request, url);
    if (!r || r.status !== 200 || !/html/i.test(r.type)) return [];
    return [
      finding({
        category: "seo",
        rule: "seo:soft-404",
        severity: "medium",
        title: "Missing pages answer 200 instead of 404",
        detail:
          "An address that does not exist still returns a normal page. Google may index error pages as real ones, and broken links are hard to spot. Return a 404 status from the not-found page.",
        pageUrl: url,
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------
// Files that should never be public

interface Probe {
  path: string;
  rule: string;
  severity: Finding["severity"];
  title: string;
  detail: string;
  /** Only report when the answer really is that file, not a friendly error page. */
  matches: (text: string, type: string) => boolean;
}

const notHtml = (type: string) => !/html/i.test(type);

const PROBES: Probe[] = [
  {
    path: "/.env",
    rule: "sec:exposed-env",
    severity: "critical",
    title: "The .env file with passwords and keys is public",
    detail: "Anyone can download the database password, API keys and secrets. Block the file in the web server, move it outside the public folder, and change every secret in it.",
    matches: (t, type) => notHtml(type) && /^\s*[A-Z][A-Z0-9_]*\s*=/m.test(t) && !/<html/i.test(t),
  },
  {
    path: "/.git/HEAD",
    rule: "sec:exposed-git",
    severity: "critical",
    title: "The Git repository is public",
    detail: "Anyone can download the full source code and its history, often including passwords. Block /.git in the web server and deploy without the .git folder.",
    matches: (t) => /^ref: refs\//.test(t.trim()) || /^[0-9a-f]{40}$/.test(t.trim()),
  },
  {
    path: "/wp-config.php.bak",
    rule: "sec:exposed-backup",
    severity: "critical",
    title: "A backup of wp-config.php is public",
    detail: "It contains the database password. Delete the backup file and change the password.",
    matches: (t) => /DB_PASSWORD/.test(t),
  },
  {
    path: "/wp-config.php~",
    rule: "sec:exposed-backup",
    severity: "critical",
    title: "A backup of wp-config.php is public",
    detail: "It contains the database password. Delete the backup file and change the password.",
    matches: (t) => /DB_PASSWORD/.test(t),
  },
  {
    path: "/phpinfo.php",
    rule: "sec:exposed-phpinfo",
    severity: "high",
    title: "A phpinfo() page is public",
    detail: "It shows server paths, versions and settings that help attackers. Delete the file.",
    matches: (t) => /phpinfo\(\)|<title>PHP \d/i.test(t),
  },
  {
    path: "/info.php",
    rule: "sec:exposed-phpinfo",
    severity: "high",
    title: "A phpinfo() page is public",
    detail: "It shows server paths, versions and settings that help attackers. Delete the file.",
    matches: (t) => /phpinfo\(\)|<title>PHP \d/i.test(t),
  },
  {
    path: "/wp-content/debug.log",
    rule: "sec:exposed-log",
    severity: "high",
    title: "The WordPress debug log is public",
    detail: "Error logs reveal file paths, plugin names and sometimes user data. Turn off WP_DEBUG_LOG on the live site or block the file.",
    matches: (t, type) => notHtml(type) && /PHP (Warning|Notice|Fatal|Deprecated)/.test(t),
  },
  {
    path: "/server-status",
    rule: "sec:exposed-server-status",
    severity: "medium",
    title: "The Apache server-status page is public",
    detail: "It shows live requests, client addresses and internal URLs. Restrict it to localhost.",
    matches: (t) => /Apache Server Status/i.test(t),
  },
  {
    path: "/.DS_Store",
    rule: "sec:exposed-ds-store",
    severity: "low",
    title: "A .DS_Store file is public",
    detail: "These Mac folder files list the names of every file in the folder, including hidden ones. Delete them from the server.",
    matches: (t) => t.includes("Bud1"),
  },
];

const LISTING_DIRS = ["/uploads/", "/wp-content/uploads/", "/images/", "/assets/", "/backup/"];

export const exposedFilesAgent: SiteAgent = {
  id: "web.exposed-files",
  name: "Exposed files",
  description:
    "Looks for files that should never be public: .env, .git, config backups, phpinfo, debug logs, and folders that list their files. Each hit is confirmed by its content.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, origin }) {
    const out: Finding[] = [];
    const seenRules = new Set<string>();
    for (const p of PROBES) {
      if (seenRules.has(p.rule)) continue;
      const r = await fetchText(browser.request, origin + p.path, 200_000);
      if (r && r.status === 200 && p.matches(r.text, r.type)) {
        seenRules.add(p.rule);
        out.push(
          finding({
            category: "security",
            rule: p.rule,
            severity: p.severity,
            title: p.title,
            detail: p.detail,
            pageUrl: origin + p.path,
            evidence: r.text.slice(0, 120).replace(/(=|:)\s*\S+/g, "$1 ••••"),
          }),
        );
      }
    }
    const listed: string[] = [];
    for (const dir of LISTING_DIRS) {
      const r = await fetchText(browser.request, origin + dir, 200_000);
      if (r && r.status === 200 && /<title>\s*Index of \//i.test(r.text)) listed.push(origin + dir);
    }
    if (listed.length) {
      out.push(
        finding({
          category: "security",
          rule: "sec:directory-listing",
          severity: "medium",
          title: "Folders list their files publicly",
          detail: "Anyone can browse every file in these folders, including ones you never linked. Turn off directory listing (Options -Indexes in Apache, autoindex off in Nginx).",
          pageUrl: listed[0],
          evidence: listed.join("\n"),
        }),
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// WordPress

export const wordpressAgent: SiteAgent = {
  id: "web.wordpress",
  name: "WordPress security",
  description: "On WordPress sites, checks for public user lists, XML-RPC, and a visible WordPress version.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  async run({ browser, origin, startUrl }) {
    const home = await fetchText(browser.request, startUrl);
    if (!home || !/wp-content|wp-includes|<meta[^>]+generator[^>]+WordPress/i.test(home.text)) return [];
    const out: Finding[] = [];
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, pageUrl: string, evidence?: string) =>
      out.push(finding({ category: "security", rule, severity, title, detail, pageUrl, evidence }));

    const version = home.text.match(/<meta[^>]+generator[^>]+WordPress\s*([\d.]+)/i)?.[1];
    if (version) {
      add(
        "wp:version-visible",
        "low",
        `The WordPress version (${version}) is public`,
        "Attackers match the version to known weaknesses. Remove the generator tag (and /readme.html) and keep WordPress updated.",
        startUrl,
        `WordPress ${version}`,
      );
    }
    const users = await fetchText(browser.request, `${origin}/wp-json/wp/v2/users`);
    if (users && users.status === 200 && /"slug"\s*:/.test(users.text)) {
      const slugs = [...users.text.matchAll(/"slug"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).slice(0, 5);
      add(
        "wp:user-enumeration",
        "medium",
        "WordPress shows its user names to anyone",
        "The REST API lists login names, which makes password-guessing attacks easier. Restrict /wp-json/wp/v2/users to logged-in users (a security plugin can do this).",
        `${origin}/wp-json/wp/v2/users`,
        slugs.join(", "),
      );
    }
    const xmlrpc = await fetchText(browser.request, `${origin}/xmlrpc.php`);
    if (xmlrpc && /XML-RPC server accepts POST requests only/i.test(xmlrpc.text)) {
      add(
        "wp:xmlrpc",
        "low",
        "WordPress XML-RPC is turned on",
        "XML-RPC lets attackers try hundreds of passwords in one request. Turn it off unless the Jetpack plugin or a mobile app needs it.",
        `${origin}/xmlrpc.php`,
      );
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Duplicate titles and descriptions across pages

export const duplicatesAgent: SiteAgent = {
  id: "web.duplicates",
  name: "Duplicate titles",
  description: "Finds pages that share the same title or meta description, which makes them compete in Google.",
  category: "seo",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run({ site }) {
    const out: Finding[] = [];
    const check = (field: "title" | "description", rule: string, label: string) => {
      const byValue = new Map<string, string[]>();
      for (const [url, facts] of site.seo) {
        const v = facts[field]?.trim();
        if (!v) continue;
        byValue.set(v, [...(byValue.get(v) ?? []), url]);
      }
      for (const [value, urls] of byValue) {
        if (urls.length < 2) continue;
        out.push(
          finding({
            category: "seo",
            rule,
            severity: "low",
            title: `${urls.length} pages share the same ${label}`,
            detail: `"${value.slice(0, 120)}". Give each page its own ${label} that says what is on that page.`,
            pageUrl: urls[0],
            evidence: urls.slice(0, 10).join("\n"),
          }),
        );
      }
    };
    check("title", "seo:duplicate-title", "title");
    check("description", "seo:duplicate-description", "meta description");
    return out;
  },
};
