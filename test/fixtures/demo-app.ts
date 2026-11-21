import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

/**
 * A small web app behind a sign-in form, like a client's CRM or SaaS dashboard.
 * Used by the tests to prove the agent signs in, tests the pages behind the login, signs in again
 * when the session ends, and never opens links that log out or change data.
 */
export interface DemoApp {
  server: Server;
  base: string;
  /** Every path that was requested, in order. */
  requested: string[];
  /** Sign-in attempts that were accepted. */
  logins: () => number;
}

export const DEMO_USER = { email: "tester@glv.test", password: "Corr3ct-Horse-Battery" };

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title} page of the demo CRM"></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

export function startDemoApp(port = 4230): Promise<DemoApp> {
  const base = `http://localhost:${port}`;
  const sessions = new Set<string>();
  const requested: string[] = [];
  let logins = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    requested.push(url.pathname + url.search);
    const sid = /(?:^|;\s*)sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    const signedIn = Boolean(sid && sessions.has(sid));
    // Private pages ask not to be cached, except /leads (a planted bug).
    const cache = signedIn && url.pathname !== "/leads" ? { "cache-control": "no-store" } : {};
    const html = (status: number, body: string, headers: Record<string, string> = {}) =>
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...cache, ...headers }).end(body);
    const redirect = (to: string, headers: Record<string, string> = {}) => res.writeHead(302, { location: to, ...headers }).end();

    const form = (error = "") =>
      page(
        "Sign in",
        `${error ? `<div role="alert">${error}</div>` : ""}<form method="post" action="/login">
          <label>Email <input type="email" name="email" autocomplete="username"></label>
          <label>Password <input type="password" name="password" autocomplete="current-password"></label>
          <button type="submit">Sign in</button></form>`,
      );

    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = new URLSearchParams(body);
        if (f.get("email") === DEMO_USER.email && f.get("password") === DEMO_USER.password) {
          logins++;
          const id = randomBytes(8).toString("hex");
          sessions.add(id);
          return redirect("/dashboard", { "set-cookie": `sid=${id}; Path=/; HttpOnly; SameSite=Lax` });
        }
        html(200, form("Invalid email or password."));
      });
      return;
    }
    if (url.pathname === "/login") return html(200, form());
    if (url.pathname === "/") return redirect(signedIn ? "/dashboard" : "/login");
    // A planted bug: the team page forgot its login check, so strangers see it too.
    if (url.pathname === "/team") {
      return html(
        200,
        page("Team", `<p>Signed in as ${DEMO_USER.email}.</p><a href="/leads?email=asha%40example.in">Asha's leads</a> <a href="/dashboard">Back</a> <a href="/logout">Sign out</a>`),
      );
    }
    if (!signedIn) return redirect("/login");

    // Must never be opened by the agent: they end the session or change data.
    if (url.pathname === "/logout" || url.pathname.endsWith("/cancel") || url.searchParams.has("action")) {
      if (sid) sessions.delete(sid);
      return html(200, page("Done", "<p>Changed.</p>"));
    }
    if (url.pathname === "/dashboard") {
      return html(
        200,
        page(
          "Dashboard",
          `<p>Welcome back, Tester.</p><nav><a href="/leads">Leads</a> <a href="/reports">Reports</a> <a href="/settings">Settings</a> <a href="/team">Team</a>
           <a href="/logout">Sign out</a> <a href="/orders/7/cancel">Cancel order 7</a> <a href="/leads?action=mark_all_read">Mark all read</a></nav>`,
        ),
      );
    }
    if (url.pathname === "/leads") {
      return html(200, page("Leads", `<p>3 new leads.</p><a href="/leads/1">Asha</a> <a href="/dashboard">Back</a> <a href="/logout">Sign out</a>`));
    }
    if (url.pathname === "/leads/1") return html(200, page("Lead: Asha", `<p>Hot lead.</p><a href="/missing-page">Old link</a>`));
    // The session ends while on this page, as when a short session times out.
    if (url.pathname === "/reports") {
      if (sid) sessions.delete(sid);
      return html(200, page("Reports", `<p>Monthly report.</p><a href="/settings">Settings</a>`));
    }
    if (url.pathname === "/settings") return html(200, page("Settings", `<p>Account settings.</p><a href="/dashboard">Back</a>`));
    return html(404, page("Not found", "<p>No such page.</p>"));
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, base, requested, logins: () => logins })));
}
