/**
 * The business systems the signed-in test knows: CRMs, ERPs, HR, helpdesks, billing, learning,
 * store admins and the frameworks custom apps are built with. For each one it knows how to spot it,
 * the sign-in fields, where the menu is, and which links change data, so the explorer clicks the
 * right things and never the dangerous ones. Anything not listed still works with the general rules.
 */

export type SystemKind = "crm" | "erp" | "hr" | "helpdesk" | "billing" | "lms" | "store-admin" | "booking" | "dashboard" | "cms" | "project" | "other";

export const SYSTEM_KINDS: { id: SystemKind; name: string }[] = [
  { id: "crm", name: "CRM (leads, contacts, deals, WhatsApp)" },
  { id: "erp", name: "ERP (stock, purchase, accounts)" },
  { id: "hr", name: "HR and payroll" },
  { id: "helpdesk", name: "Helpdesk and tickets" },
  { id: "billing", name: "Billing and invoicing" },
  { id: "lms", name: "Learning (LMS, school, courses)" },
  { id: "store-admin", name: "Store admin (orders, products)" },
  { id: "booking", name: "Booking and appointments" },
  { id: "dashboard", name: "Dashboard and reports" },
  { id: "cms", name: "Website admin (CMS)" },
  { id: "project", name: "Projects and tasks" },
  { id: "other", name: "Custom app (by what it is built with)" },
];

export interface SystemProfile {
  id: string;
  name: string;
  kind: SystemKind;
  /** Spotted by the address (host or path). */
  url?: RegExp;
  /** Spotted by the page's HTML. */
  html?: RegExp;
  /** Spotted by a cookie name. */
  cookie?: RegExp;
  /** Sign-in fields, tried before the general guesses. */
  login?: { username?: string; password?: string; submit?: string };
  /** Where the app's menu items are. */
  nav?: string[];
  /** Links and calls that change data or end the session on this system. */
  unsafe?: RegExp;
  /** Advice shown in the report for this system. */
  tip?: string;
}

/** Most specific first: a framework (Laravel, Django) only counts when no product matched. */
export const SYSTEMS: SystemProfile[] = [
  // CRMs
  {
    id: "salesforce",
    name: "Salesforce",
    kind: "crm",
    url: /(\.force\.com|\.salesforce\.com|\.lightning\.force\.com)/i,
    html: /\bsalesforce\b|\bslds-|one-app-nav-bar/i,
    login: { username: "#username", password: "#password", submit: "#Login" },
    nav: ["one-app-nav-bar a", ".slds-context-bar a", "one-app-launcher-menu-item a", "[role=tablist] a[role=tab]"],
    unsafe: /\/(setup|lightning\/setup)\/.*(delete|remove)|[?&]delID=|\/secur\/logout|frontdoor\.jsp/i,
    tip: "Test a Salesforce sandbox org, never production. Give the test user a profile without Modify All Data.",
  },
  {
    id: "zoho",
    name: "Zoho (CRM, Books, Desk, People)",
    kind: "crm",
    url: /\.zoho\.(com|in|eu|com\.au)|zohocrm|zohobooks|zohopeople|zohodesk/i,
    html: /zoho|zcrm|lyte-/i,
    login: { username: "#login_id", password: "#password", submit: "#nextbtn" },
    nav: ["#tabLayer a", "lyte-menu-item", "crm-menu a", ".zc-nav a", "[data-zcqa] a", "nav a"],
    unsafe: /\/logout|[?&]action=(delete|massdelete)/i,
    tip: "Zoho sign-in asks for the email first, then the password on the next screen; the test handles that. Use a sandbox or a trial organisation.",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    kind: "crm",
    url: /app\.hubspot\.com|app-eu1\.hubspot\.com/i,
    html: /hubspot|hs-nav/i,
    login: { username: "#username", password: "#current-password", submit: "#loginBtn" },
    nav: ["[data-test-id=navigation] a", "#hs-nav-v4 a", "nav a"],
    unsafe: /\/logout|\/(delete|archive)\b/i,
    tip: "HubSpot developer test accounts are free and safe to test against.",
  },
  {
    id: "dynamics",
    name: "Microsoft Dynamics 365",
    kind: "crm",
    url: /\.dynamics\.com|\.crm\d*\.dynamics\.com/i,
    html: /dynamics 365|data-id="sitemap/i,
    nav: ["[data-id=sitemap-body] [role=treeitem]", "[data-id=sitemap-body] a", "#topBar a"],
    unsafe: /[?&](cmd|command)=(delete|deactivate)|\/_layouts\/.*delete/i,
    tip: "Dynamics signs in through Microsoft accounts: use a test user with a two-step secret saved (authenticator app setup), not phone taps.",
  },
  {
    id: "suitecrm",
    name: "SuiteCRM / SugarCRM",
    kind: "crm",
    html: /suitecrm|sugarcrm|SUGAR\.|index\.php\?module=/i,
    login: { username: "#user_name", password: "#username_password", submit: "#bigbutton" },
    nav: ["#toolbar a", ".navbar a", "#ajaxHeader a", ".topnav a"],
    unsafe: /[?&]action=(Delete|MassUpdate|Save|Logout)|[?&]mass/i,
  },
  {
    id: "espocrm",
    name: "EspoCRM",
    kind: "crm",
    html: /espocrm|espo\.min\.js|client\/lib\/espo/i,
    login: { username: "#field-userName", password: "#field-password", submit: "#btn-login" },
    nav: ["#navbar a.nav-link", "#navbar .tab a", "#navbar a"],
    unsafe: /#(?:\w+\/)?(?:delete|remove)|\/logout/i,
  },
  {
    id: "vtiger",
    name: "vTiger CRM",
    kind: "crm",
    html: /vtiger|index\.php\?module=Home&view=DashBoard/i,
    login: { username: "#username", password: "#password" },
    nav: [".app-navigator a", ".app-menu a", "#appnavigator a", ".menuBar a"],
    unsafe: /[?&](action|mode)=(Delete|MassDelete|Save|Logout)/i,
  },
  {
    id: "perfex",
    name: "Perfex CRM",
    kind: "crm",
    html: /perfex_crm|app\.perfexcrm|perfex/i,
    login: { username: 'input[name="email"]', password: 'input[name="password"]' },
    nav: ["#side-menu a", ".sidebar a", ".navbar a"],
    unsafe: /\/(delete|remove|mark_as|change_status|bulk_action)\b|\/authentication\/logout/i,
    tip: "Perfex admin links like /delete/12 delete straight away: the test never opens them.",
  },
  {
    id: "bitrix24",
    name: "Bitrix24",
    kind: "crm",
    url: /\.bitrix24\./i,
    html: /bitrix24|BX\.ready/i,
    nav: [".menu-items-block a", "#menu-items-block a", ".main-buttons-item a"],
    unsafe: /[?&](logout|action=delete)/i,
  },
  // ERPs
  {
    id: "odoo",
    name: "Odoo",
    kind: "erp",
    html: /odoo|o_main_navbar|web\.assets_backend|data-menu-xmlid/i,
    login: { username: 'input[name="login"]', password: 'input[name="password"]', submit: 'button[type="submit"]' },
    nav: [".o_menu_sections a", ".o_menu_sections button", ".o_menu_apps a", ".o_navbar_apps_menu a", ".dropdown-item[data-menu-xmlid]", ".o_app"],
    unsafe: /\/web\/session\/logout|\/web\/dataset\/call_kw\/.*(unlink|write|create|action_)/i,
    tip: "Use an Odoo database copy (duplicate the database in the database manager) for tests that save records.",
  },
  {
    id: "erpnext",
    name: "ERPNext / Frappe (and Frappe HR)",
    kind: "erp",
    html: /frappe|erpnext|frappe-boot|desk-sidebar/i,
    cookie: /^system_user$/,
    login: { username: "#login_email", password: "#login_password", submit: ".btn-login" },
    nav: [".sidebar-item-container a", ".desk-sidebar a", ".standard-sidebar a", ".sidebar-menu a", ".navbar a.nav-link"],
    unsafe: /\/api\/method\/(logout|frappe\.client\.(delete|set_value|insert|save))|\/api\/resource\/.*[?&]_method=/i,
  },
  {
    id: "dolibarr",
    name: "Dolibarr",
    kind: "erp",
    html: /dolibarr/i,
    login: { username: "#username", password: "#password" },
    nav: [".vmenu a", "#tmenu_tooltip a", ".tmenu a", "#id-left a"],
    unsafe: /[?&]action=(delete|confirm_delete|confirm_validate|confirm_close|add|update|setstatut)|\/logout\.php/i,
  },
  {
    id: "sap",
    name: "SAP Fiori / Business One",
    kind: "erp",
    html: /sap-ui-core|sap\.ushell|sap\.m\./i,
    nav: [".sapUshellTile a", ".sapMGT", "[role=menuitem]"],
    unsafe: /\/sap\/public\/bc\/icf\/logoff/i,
    tip: "Fiori screens are drawn by script; the explorer clicks tiles and menu items.",
  },
  // HR
  {
    id: "orangehrm",
    name: "OrangeHRM",
    kind: "hr",
    html: /orangehrm|oxd-main-menu/i,
    login: { username: 'input[name="username"]', password: 'input[name="password"]', submit: 'button[type="submit"]' },
    nav: [".oxd-main-menu a", ".oxd-topbar-body-nav a"],
    unsafe: /\/auth\/logout|\/(delete|terminate)\b/i,
  },
  // Helpdesks
  { id: "freshdesk", name: "Freshdesk / Freshworks", kind: "helpdesk", url: /\.freshdesk\.com|\.freshworks\.com|\.myfreshworks\.com/i, html: /freshdesk|freshworks/i, nav: ["nav a", "[data-test-nav] a"], unsafe: /\/logout|\/(delete|spam)\b/i },
  { id: "zendesk", name: "Zendesk", kind: "helpdesk", url: /\.zendesk\.com/i, html: /zendesk/i, nav: ["[data-test-id=navigation] a", "nav a"], unsafe: /\/access\/logout|\/(delete|suspend)\b/i },
  { id: "osticket", name: "osTicket", kind: "helpdesk", html: /osticket/i, nav: ["#nav a", "#sub_nav a"], unsafe: /[?&]a=(delete|mass_process)|logout\.php/i },
  // Learning
  {
    id: "moodle",
    name: "Moodle",
    kind: "lms",
    html: /moodle|M\.cfg|yui_\d/i,
    cookie: /^MoodleSession/,
    login: { username: "#username", password: "#password", submit: "#loginbtn" },
    nav: [".primary-navigation a", "#nav-drawer a", ".drawer a", ".navbar a", ".secondary-navigation a"],
    // Moodle actions carry the session key: anything with sesskey changes something.
    unsafe: /[?&]sesskey=|\/login\/logout\.php/i,
  },
  // CMS and store admins
  {
    id: "wordpress",
    name: "WordPress admin (and WooCommerce)",
    kind: "cms",
    url: /\/wp-admin|\/wp-login\.php/i,
    html: /wp-admin|wp-content|adminmenu/i,
    cookie: /^wordpress_logged_in/,
    login: { username: "#user_login", password: "#user_pass", submit: "#wp-submit" },
    nav: ["#adminmenu a", "#wp-admin-bar-root-default a"],
    unsafe: /[?&]action=(trash|delete|untrash|deactivate|activate|logout|upgrade|update-selected|do-plugin-upgrade)|\/(update|update-core|plugin-install|theme-install|plugin-editor|theme-editor)\.php|_wpnonce=/i,
    tip: "Links with _wpnonce in WordPress admin do something on click: the test never opens them.",
  },
  {
    id: "magento",
    name: "Magento / Adobe Commerce admin",
    kind: "store-admin",
    html: /magento|mage\/|admin__menu/i,
    login: { username: "#username", password: "#login", submit: ".action-login" },
    nav: [".admin__menu a", "#nav a", "#menu-magento-backend-dashboard a"],
    unsafe: /\/(delete|massDelete|massDisable|massEnable|cancel|hold|unhold|logout)\b/i,
  },
  { id: "shopify", name: "Shopify admin", kind: "store-admin", url: /admin\.shopify\.com|\.myshopify\.com\/admin/i, html: /Polaris-/i, nav: ["nav a", ".Polaris-Navigation a"], unsafe: /\/(delete|archive|cancel|refund)\b/i, tip: "Shopify's sign-in has a CAPTCHA: use a development store and a staff account with the test server's address allowed." },
  { id: "opencart", name: "OpenCart admin", kind: "store-admin", html: /opencart|route=common\/dashboard/i, nav: ["#menu a", "#column-left a"], unsafe: /route=[\w/]*(delete|logout|uninstall)|user_token=.*&.*delete/i },
  { id: "prestashop", name: "PrestaShop admin", kind: "store-admin", html: /prestashop/i, nav: ["#nav-sidebar a", ".main-menu a"], unsafe: /[?&](delete\w*|logout)\b/i },
  { id: "strapi", name: "Strapi admin", kind: "cms", html: /strapi-|strapi\.io|@strapi/i, nav: ["nav a"], unsafe: /\/(delete|publish|unpublish)\b/i },
  { id: "directus", name: "Directus", kind: "cms", html: /directus/i, nav: ["#navigation a", ".module-bar a"], unsafe: /\/auth\/logout/i },
  // Dashboards and project tools
  { id: "metabase", name: "Metabase", kind: "dashboard", html: /metabase/i, nav: ["[data-testid=main-navbar-root] a", "nav a"], unsafe: /\/api\/session(\/|$)/i },
  { id: "grafana", name: "Grafana", kind: "dashboard", html: /grafana/i, nav: ["[data-testid*=navigation] a", "nav a"], unsafe: /\/logout/i },
  { id: "jira", name: "Jira / Confluence", kind: "project", url: /\.atlassian\.net/i, html: /atlassian|jira/i, nav: ["[data-testid*=navigation] a", "nav a"], unsafe: /\/logout|\/(delete|archive)\b/i },
  { id: "redmine", name: "Redmine", kind: "project", html: /redmine/i, nav: ["#main-menu a", "#top-menu a"], unsafe: /\/(destroy|logout)\b|[?&]_method=delete/i },
  // Admin panel kits on frameworks
  { id: "filament", name: "Laravel Filament admin", kind: "dashboard", html: /filament|fi-sidebar/i, nav: [".fi-sidebar a", ".fi-sidebar-nav a", ".fi-topbar a"], unsafe: /\/(delete|force-delete|restore)\b|\/logout/i },
  { id: "nova", name: "Laravel Nova", kind: "dashboard", url: /\/nova(\/|$)/i, html: /laravel nova|nova-app/i, nav: ["[dusk=sidebar-menu] a", "nav a"], unsafe: /\/(delete|force|restore)\b|\/logout/i },
  {
    id: "django-admin",
    name: "Django admin",
    kind: "dashboard",
    html: /django administration|django-admin|id="nav-sidebar"/i,
    login: { username: "#id_username", password: "#id_password", submit: 'input[type="submit"]' },
    nav: ["#nav-sidebar a", ".app-list a", "#content-main a"],
    unsafe: /\/(delete|history)\/?$|\/logout\/?$/i,
  },
  { id: "react-admin", name: "React-admin / Refine / AdminJS", kind: "dashboard", html: /react-admin|RaLayout|refine|adminjs/i, nav: [".RaMenu-root a", ".RaSidebar-root a", "nav a", "[role=menu] a"], unsafe: /\/(delete|logout)\b/i },
  // Frameworks: custom apps. Only the general rules plus the framework's own habits.
  { id: "laravel", name: "Laravel app", kind: "other", cookie: /^(laravel_session|XSRF-TOKEN)$/, html: /laravel|livewire/i, unsafe: /\/(delete|destroy|logout)\b/i },
  { id: "django", name: "Django app", kind: "other", cookie: /^(sessionid|csrftoken)$/, html: /csrfmiddlewaretoken/i },
  { id: "rails", name: "Ruby on Rails app", kind: "other", cookie: /^_[\w]+_session$/, html: /authenticity_token|data-turbo|csrf-param/i, unsafe: /data-method=["']?(delete|post|patch|put)/i },
  { id: "aspnet", name: "ASP.NET app", kind: "other", cookie: /^(\.AspNetCore\.|ASP\.NET_SessionId|\.ASPXAUTH)/i, html: /__VIEWSTATE|__doPostBack|aspnetForm/i, unsafe: /__doPostBack/i },
  { id: "codeigniter", name: "CodeIgniter / PHP app", kind: "other", cookie: /^(ci_session|PHPSESSID)$/ },
  { id: "spring", name: "Java / Spring app", kind: "other", cookie: /^JSESSIONID$/ },
  { id: "node", name: "Node.js app", kind: "other", cookie: /^connect\.sid$/ },
];

const FRAMEWORKS = new Set(["laravel", "django", "rails", "aspnet", "codeigniter", "spring", "node"]);

/** What the test found about the system, for the report. */
export interface SystemFound {
  id: string;
  name: string;
  kind: SystemKind;
  /** What gave it away: "address", "page", "cookie". */
  by: string[];
  tip?: string;
  /** The framework under it, when a product was found too (Perfex on CodeIgniter...). */
  framework?: string;
}

/** Spots the system from what the browser saw. A product beats a framework. */
export function detectSystem(input: { url: string; html?: string; cookies?: string[] }): SystemFound | undefined {
  const hits: { p: SystemProfile; by: string[] }[] = [];
  for (const p of SYSTEMS) {
    const by: string[] = [];
    if (p.url?.test(input.url)) by.push("address");
    if (p.html && input.html && p.html.test(input.html)) by.push("page");
    if (p.cookie && input.cookies?.some((c) => p.cookie!.test(c))) by.push("cookie");
    // A word on the page alone is weak for short names: need the page plus another sign, or a strong page sign.
    if (by.length) hits.push({ p, by });
  }
  const product = hits.find((h) => !FRAMEWORKS.has(h.p.id) && (h.by.length > 1 || h.by[0] !== "page" || strongPage(h.p, input.html ?? "")));
  const framework = hits.find((h) => FRAMEWORKS.has(h.p.id));
  const pick = product ?? framework;
  if (!pick) return undefined;
  return {
    id: pick.p.id,
    name: pick.p.name,
    kind: pick.p.kind,
    by: pick.by,
    ...(pick.p.tip ? { tip: pick.p.tip } : {}),
    ...(product && framework ? { framework: framework.p.name } : {}),
  };
}

/** Page signs that only the product leaves (a class or script name, not a word anyone could write). */
function strongPage(p: SystemProfile, html: string): boolean {
  const m = html.match(p.html!);
  return Boolean(m && /[-_./#=]/.test(m[0]));
}

export const profileOf = (id?: string): SystemProfile | undefined => SYSTEMS.find((s) => s.id === id);

/** The system chosen on the project, when the test cannot spot it (a custom domain or an in-house app). */
export function chosenSystem(id?: string): SystemFound | undefined {
  const p = profileOf(id);
  return p ? { id: p.id, name: p.name, kind: p.kind, by: ["project setting"], ...(p.tip ? { tip: p.tip } : {}) } : undefined;
}

/** Menu places the explorer looks at on every app, after the system's own. */
export const GENERAL_NAV = [
  "nav a",
  "nav button",
  "aside a",
  "aside button",
  "[role=navigation] a",
  "[role=navigation] button",
  "[role=menubar] [role=menuitem]",
  "[role=menu] [role=menuitem]",
  "[role=tablist] [role=tab]",
  "[role=tree] [role=treeitem]",
  "header a",
  ".sidebar a",
  ".side-menu a",
  ".sidenav a",
  ".menu a",
  ".navbar a",
  ".nav-link",
  "[aria-haspopup=true]",
  "[aria-haspopup=menu]",
  "[data-toggle=dropdown]",
  "[data-bs-toggle=dropdown]",
  "[data-bs-toggle=tab]",
  "[data-toggle=tab]",
];
