import { request as playwrightRequest, type APIRequestContext } from "playwright";
import type { SiteAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import type { Finding } from "../types.js";
import { APPS } from "./calls.js";

/**
 * Admin and debug screens that well-known systems and frameworks leave open: the Odoo database
 * manager, Metabase's setup token, Laravel Telescope, Spring's actuator, Django's debug page... Each
 * is asked for once with no login (GET or HEAD only) and reported only when the answer really is
 * that screen, not a sign-in page or a friendly "not found".
 */

interface Exposure {
  /** The systems it belongs to; "any" is tried on every app. */
  on: string[];
  path: string;
  head?: boolean;
  rule: string;
  severity: Finding["severity"];
  title: string;
  detail: string;
  matches: (text: string, status: number, type: string, headers: Record<string, string>) => boolean;
}

const html = (t: string) => /html/i.test(t);

export const EXPOSURES: Exposure[] = [
  {
    on: ["odoo"],
    path: "/web/database/manager",
    rule: "app:odoo-database-manager",
    severity: "critical",
    title: "The Odoo database manager is open to anyone",
    detail: "Anyone can reach the screen that backs up, copies, restores and deletes whole databases. If the master password is weak or the default, the whole company's data can be downloaded or wiped. Set list_db = False and a strong admin_passwd in odoo.conf, and block /web/database/ in the web server.",
    matches: (t, s, type) => s === 200 && html(type) && /o_database_list|database manager|Create Database|Backup|Restore Database/i.test(t),
  },
  {
    on: ["odoo"],
    path: "/web/database/selector",
    rule: "app:odoo-database-list",
    severity: "medium",
    title: "Odoo lists its database names to anyone",
    detail: "The database selector shows every database name on the server, which helps attackers aim at them. Set list_db = False and dbfilter in odoo.conf.",
    matches: (t, s, type) => s === 200 && html(type) && /o_database_list|Select a database|database selector/i.test(t) && !/database manager/i.test(t),
  },
  {
    on: ["metabase"],
    path: "/api/session/properties",
    rule: "app:metabase-setup-token",
    severity: "critical",
    title: "Metabase still hands out its setup token",
    detail: "The setup token in /api/session/properties should be empty once Metabase is set up. With it, older versions can be taken over without a login (CVE-2023-38646). Update Metabase to the latest version at once.",
    matches: (t, s) => s === 200 && /"setup-token"\s*:\s*"[\w-]{8,}"/.test(t),
  },
  {
    on: ["strapi"],
    path: "/admin/init",
    rule: "app:strapi-no-admin",
    severity: "critical",
    title: "Strapi has no admin yet: anyone can register as admin",
    detail: "The Strapi admin panel says no administrator exists, so the first person to open /admin registers as the owner. Create the admin account now, or block /admin until you do.",
    matches: (t, s) => s === 200 && /"hasAdmin"\s*:\s*false/.test(t),
  },
  {
    on: ["magento"],
    path: "/app/etc/env.php",
    rule: "app:magento-env",
    severity: "critical",
    title: "Magento's settings file with the database password is public",
    detail: "app/etc/env.php holds the database password and the encryption key. Point the web server at the pub/ folder only, and change every secret in the file.",
    matches: (t, s, type) => s === 200 && !html(type) && /'db'\s*=>|'crypt'\s*=>/.test(t),
  },
  {
    on: ["wordpress"],
    path: "/xmlrpc.php",
    rule: "app:wordpress-xmlrpc",
    severity: "low",
    title: "WordPress XML-RPC is switched on",
    detail: "xmlrpc.php lets attackers try hundreds of passwords in one request and use the site in attacks on others. Turn it off (a security plugin can) unless the Jetpack app needs it.",
    matches: (t, s) => (s === 200 || s === 405) && /XML-RPC server accepts POST requests only/i.test(t),
  },
  {
    on: ["grafana"],
    path: "/api/search?limit=5",
    rule: "app:grafana-anonymous",
    severity: "high",
    title: "Grafana shows dashboards to anyone, with no login",
    detail: "Anonymous access is on: a visitor with no login can list and open the dashboards. Set [auth.anonymous] enabled = false in grafana.ini, or give the anonymous role access to nothing.",
    matches: (t, s, type) => s === 200 && /json/i.test(type) && /"type"\s*:\s*"dash-(db|folder)"/.test(t),
  },
  {
    on: ["laravel", "filament", "nova", "any"],
    path: "/telescope/requests",
    rule: "app:laravel-telescope",
    severity: "critical",
    title: "Laravel Telescope is open to anyone",
    detail: "Telescope shows every request, database query, session and email the app handled, with the data in them. Install it only in local development (--dev), or limit it with the viewTelescope gate.",
    matches: (t, s, type) => s === 200 && html(type) && /telescope/i.test(t) && /window\.Telescope|telescope\/app\.js|id="telescope"/i.test(t),
  },
  {
    on: ["laravel", "filament", "nova", "any"],
    path: "/horizon/dashboard",
    rule: "app:laravel-horizon",
    severity: "high",
    title: "Laravel Horizon is open to anyone",
    detail: "Horizon shows the app's background jobs with their data, and lets a visitor retry or delete them. Limit it with the viewHorizon gate.",
    matches: (t, s, type) => s === 200 && html(type) && /window\.Horizon|horizon\/app\.js|id="horizon"/i.test(t),
  },
  {
    on: ["laravel", "filament", "nova", "any"],
    path: "/_debugbar/open",
    rule: "app:laravel-debugbar",
    severity: "high",
    title: "The Laravel debug bar is on in production",
    detail: "The debug bar lists recent requests with their queries, session data and settings. Set APP_DEBUG=false and DEBUGBAR_ENABLED=false on the server.",
    matches: (t, s, type) => s === 200 && /json/i.test(type) && /"(id|datetime|utime)"\s*:/.test(t) && /"(method|uri)"\s*:/.test(t),
  },
  {
    on: ["laravel", "any"],
    path: "/_ignition/health-check",
    rule: "app:laravel-ignition",
    severity: "critical",
    title: "Laravel's error page tool (Ignition) can run commands",
    detail: "Ignition answers that it can execute commands, which on older versions lets anyone run code on the server (CVE-2021-3129). Set APP_DEBUG=false and update facade/ignition or spatie/laravel-ignition.",
    matches: (t, s) => s === 200 && /"can_execute_commands"\s*:\s*true/.test(t),
  },
  {
    on: ["spring", "any"],
    path: "/actuator/env",
    rule: "app:spring-actuator-env",
    severity: "critical",
    title: "Spring's actuator shows the app's settings to anyone",
    detail: "/actuator/env lists the app's settings and environment, often with database passwords and keys. Expose only health (management.endpoints.web.exposure.include=health) and put the rest behind a login.",
    matches: (t, s) => s === 200 && /"propertySources"\s*:/.test(t),
  },
  {
    on: ["spring", "any"],
    path: "/actuator/heapdump",
    head: true,
    rule: "app:spring-heapdump",
    severity: "critical",
    title: "Anyone can download the app's memory (Spring heap dump)",
    detail: "/actuator/heapdump hands out a copy of the app's memory, with sessions, passwords and keys in it. Turn the endpoint off (management.endpoint.heapdump.enabled=false).",
    matches: (_t, s, type, h) => s === 200 && /octet-stream|hprof/i.test(type + (h["content-disposition"] ?? "")),
  },
  {
    on: ["django", "django-admin", "any"],
    path: "/glv-check-not-a-page-9d2f/",
    rule: "app:django-debug",
    severity: "high",
    title: "Django runs with DEBUG = True",
    detail: "A missing address shows Django's debug page with every URL pattern of the app (and on errors, the settings and local values). Set DEBUG = False in production.",
    matches: (t) => /You're seeing this error because you have <code>DEBUG = True<\/code>|DEBUG = True/i.test(t) && /URLconf/i.test(t),
  },
  {
    on: ["rails", "any"],
    path: "/rails/info/routes",
    rule: "app:rails-info",
    severity: "high",
    title: "Rails runs in development mode",
    detail: "/rails/info/routes lists every route of the app, which only development mode shows. Run the server with RAILS_ENV=production.",
    matches: (t, s, type) => s === 200 && html(type) && /Helper/i.test(t) && /HTTP Verb/i.test(t),
  },
  {
    on: ["aspnet", "any"],
    path: "/elmah.axd",
    rule: "app:aspnet-elmah",
    severity: "high",
    title: "The ASP.NET error log (ELMAH) is open to anyone",
    detail: "ELMAH shows every error with its request, cookies and server settings. Set allowRemoteAccess=\"false\" or require a login for elmah.axd.",
    matches: (t, s) => s === 200 && /Error Log for/i.test(t) && /elmah/i.test(t),
  },
  {
    on: ["aspnet", "any"],
    path: "/trace.axd",
    rule: "app:aspnet-trace",
    severity: "high",
    title: "ASP.NET request tracing is open to anyone",
    detail: "trace.axd shows recent requests with their cookies, form values and headers. Set <trace enabled=\"false\"/> in web.config.",
    matches: (t, s) => s === 200 && /Application Trace/i.test(t),
  },
  {
    on: ["any"],
    path: "/graphql",
    rule: "app:graphql-playground",
    severity: "low",
    title: "The GraphQL playground is open to anyone",
    detail: "A visitor gets a ready-made screen to try every query of the app's API. Switch the playground (GraphiQL, Apollo Sandbox) off in production.",
    matches: (t, s, type) => s === 200 && html(type) && /graphiql|graphql-playground|apollo-sandbox|embeddable-sandbox/i.test(t),
  },
  {
    on: ["any"],
    path: "/phpmyadmin/",
    rule: "app:db-admin-public",
    severity: "medium",
    title: "phpMyAdmin is reachable from the internet",
    detail: "The database admin screen is open to the world, so anyone can try passwords on the database. Allow it only from the office or a VPN, or remove it.",
    matches: (t, s, type) => s === 200 && html(type) && /phpMyAdmin/i.test(t) && /pma_|phpmyadmin\.css|name="pma_username"/i.test(t),
  },
  {
    on: ["any"],
    path: "/adminer.php",
    rule: "app:db-admin-public",
    severity: "medium",
    title: "Adminer (database admin) is reachable from the internet",
    detail: "The database admin screen is open to the world, so anyone can try passwords on the database. Remove adminer.php from the server.",
    matches: (t, s, type) => s === 200 && html(type) && /adminer/i.test(t) && /name="auth\[/i.test(t),
  },
];

/** The checks that fit this app: its own system's and those every app gets. */
export const exposuresFor = (systemId?: string, framework?: string) =>
  EXPOSURES.filter((e) => e.on.includes("any") || (systemId && e.on.includes(systemId)) || (framework && e.on.some((o) => framework.toLowerCase().startsWith(o))));

export async function checkExposures(req: APIRequestContext, origin: string, list: Exposure[], signal?: AbortSignal): Promise<Finding[]> {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const e of list) {
    signal?.throwIfAborted();
    if (seen.has(e.rule) && e.rule === "app:db-admin-public") continue;
    const url = origin + e.path;
    const r = await (e.head ? req.head(url, { timeout: 10_000, maxRedirects: 0 }) : req.get(url, { timeout: 10_000, maxRedirects: 0 })).catch(() => null);
    if (!r) continue;
    const headers = r.headers();
    const type = headers["content-type"] ?? "";
    const text = e.head ? "" : (await r.text().catch(() => "")).slice(0, 200_000);
    if (!e.matches(text, r.status(), type, headers)) continue;
    seen.add(e.rule);
    out.push(
      finding({
        category: "security",
        rule: e.rule,
        severity: e.severity,
        title: e.title,
        detail: e.detail,
        pageUrl: url,
        evidence: `No login: GET ${e.path} → HTTP ${r.status()}${type ? `, ${type.split(";")[0]}` : ""}`,
        agent: "app.exposed",
      }),
    );
  }
  return out;
}

export const exposedAgent: SiteAgent = {
  id: "app.exposed",
  name: "System admin and debug screens open to anyone",
  description:
    "Asks, with no login, for the admin and debug screens that well-known systems and frameworks leave open: the Odoo database manager, Metabase's setup token, Laravel Telescope, Horizon and Debugbar, Spring's actuator, Django's debug page, Rails' route list, ASP.NET's error log, GraphQL playgrounds and database admin screens.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  async run({ origin, site, log }) {
    const list = exposuresFor(site.system?.id, site.system?.framework);
    log(`Checking ${list.length} known admin and debug addresses with no login${site.system ? ` (${site.system.name})` : ""}`);
    const proxyServer = process.env.HTTPS_PROXY || process.env.https_proxy;
    const stranger = await playwrightRequest.newContext({
      ...(proxyServer ? { proxy: { server: proxyServer, bypass: process.env.NO_PROXY || process.env.no_proxy } } : {}),
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 GLVTestingAgent/0.5",
    });
    try {
      return await checkExposures(stranger, origin, list, site.signal);
    } finally {
      await stranger.dispose();
    }
  },
};
