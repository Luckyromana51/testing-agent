import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/*
 * A second demo CRM for the checks that change data, with known problems:
 * - the sign-in form sits inside an iframe, the menu is in a shadow root, and a screen is in a frame;
 * - wrong passwords are never slowed down (no lockout);
 * - the forgot-password page says whether an account exists;
 * - uploads are served inline from the app's own site (an HTML file runs);
 * - the profile save keeps any field it is sent (mass assignment);
 * - the "Run report" form fails with a server error;
 * - a Salesforce-like /s/ community answers Contact records to guests through Aura.
 */

export const CRM2_USER = { email: "asha@acme.test", password: "Ash4-Pass-2026" };
export const CRM2_SPARE = { email: "spare@acme.test", password: "Sp4re-Pass-2026" };

export interface DemoCrm2 {
  base: string;
  /** What the server was asked to do, to check clean-up. */
  log: string[];
  files: Map<string, { type: string; body: Buffer }>;
  profile: Record<string, unknown>;
  wrongPasswords: number;
  close: () => Promise<void>;
}

const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function multipart(body: Buffer, type: string): { fields: Record<string, string>; file?: { name: string; type: string; body: Buffer } } {
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean);
  const out: { fields: Record<string, string>; file?: { name: string; type: string; body: Buffer } } = { fields: {} };
  if (!boundary) return out;
  const text = body.toString("latin1");
  for (const part of text.split(`--${boundary}`)) {
    const at = part.indexOf("\r\n\r\n");
    if (at < 0) continue;
    const head = part.slice(0, at);
    const data = part.slice(at + 4).replace(/\r\n$/, "");
    const name = head.match(/name="([^"]*)"/)?.[1] ?? "";
    const filename = head.match(/filename="([^"]*)"/)?.[1];
    if (filename !== undefined) out.file = { name: filename, type: head.match(/Content-Type:\s*([^\r\n]+)/i)?.[1] ?? "application/octet-stream", body: Buffer.from(data, "latin1") };
    else if (name) out.fields[name] = Buffer.from(data, "latin1").toString();
  }
  return out;
}

export async function startDemoCrm2(): Promise<DemoCrm2> {
  const sessions = new Map<string, string>();
  const state: DemoCrm2 = { base: "", log: [], files: new Map(), profile: { name: "Asha", email: CRM2_USER.email, role: "staff" }, wrongPasswords: 0, close: async () => {} };
  const users = new Map([CRM2_USER, CRM2_SPARE].map((u) => [u.email, u.password]));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const form = new URLSearchParams(raw.toString());
    const sid = /sid=(\w+)/.exec(req.headers.cookie ?? "")?.[1];
    const who = sid ? sessions.get(sid) : undefined;
    const html = (s: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(s);
    };
    const go = (to: string) => {
      res.writeHead(303, { location: to });
      res.end();
    };
    const p = url.pathname;

    // ---- Sign-in, in a frame -----------------------------------------------------------------
    if (p === "/login") return html(page("Sign in", `<h1>Acme CRM</h1><a href="/forgot">Forgot password?</a><iframe title="Sign in" src="/login-frame${url.searchParams.has("e") ? "?e=1" : ""}" style="width:420px;height:320px;border:0"></iframe>`));
    if (p === "/login-frame")
      return html(page("Sign in box", `${url.searchParams.has("e") ? '<div class="error">Wrong email or password</div>' : ""}<form method="post" action="/session" target="_top"><label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password"></label><button>Sign in</button></form>`));
    if (p === "/session" && req.method === "POST") {
      const email = form.get("email") ?? "";
      if (users.get(email) !== form.get("password")) {
        state.wrongPasswords++;
        return go("/login?e=1"); // never slowed down, never locked
      }
      const s = randomBytes(8).toString("hex");
      sessions.set(s, email);
      res.writeHead(303, { location: "/home", "set-cookie": `sid=${s}; Path=/; HttpOnly; SameSite=Lax` });
      return res.end();
    }

    // ---- Forgot password: says whether the account exists ----------------------------------------
    if (p === "/forgot" && req.method === "GET") return html(page("Forgot password", `<h1>Reset your password</h1><form method="post" action="/forgot"><label>Email <input type="email" name="email" required></label><button>Send reset link</button></form>`));
    if (p === "/forgot" && req.method === "POST") {
      const email = form.get("email") ?? "";
      state.log.push(`reset ${email}`);
      return users.has(email)
        ? html(page("Forgot password", `<div role="alert">We sent a reset link to ${email}.</div>`))
        : html(page("Forgot password", `<div role="alert">No account uses ${email}.</div>`), 404);
    }

    // ---- Salesforce-like community, open to guests ------------------------------------------------
    if (p === "/s/" || p === "/s") return html(page("Community", `<h1>Partner community</h1><script>window.auraConfig = {"fwuid":"glvDemoFwuid123","app":"siteforce:communityApp"};</script>`));
    if (p === "/s/sfsites/aura" && req.method === "POST") {
      const message = JSON.parse(form.get("message") ?? "{}");
      const entity = message.actions?.[0]?.params?.entityNameOrId;
      state.log.push(`aura ${entity}`);
      res.writeHead(200, { "content-type": "application/json" });
      if (entity === "Contact") return res.end(JSON.stringify({ actions: [{ id: "1;a", state: "SUCCESS", returnValue: { totalCount: 2, result: [{ record: { Id: "003x1", Name: "Ravi Kumar", Email: "ravi@example.com", Phone: "98450 22222" } }, { record: { Id: "003x2", Name: "Meera Shah" } }] } }] }));
      return res.end(JSON.stringify({ actions: [{ id: "1;a", state: "ERROR", error: [{ message: "Access denied" }] }] }));
    }

    if (!who) {
      if (p.startsWith("/uploads/")) {
        // Files are served to anyone who has the address (fine for this demo).
      } else return go("/login");
    }

    // ---- Signed-in screens --------------------------------------------------------------------
    if (p === "/home")
      return html(
        page(
          "Home",
          `<h1>Welcome ${who}</h1><app-nav></app-nav><iframe title="Reports panel" src="/panel" style="width:600px;height:120px"></iframe>
<script>customElements.define("app-nav", class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: "open" }); r.innerHTML = '<nav><a href="/contacts">Contacts</a> <a href="/files">Files</a> <a href="/profile">My profile</a></nav>'; } });</script>`,
        ),
      );
    if (p === "/panel") return html(page("Reports panel", `<a href="/reports">Reports</a>`));
    if (p === "/contacts" && req.method === "GET")
      return html(page("Contacts", `<h1>Contacts</h1>${url.searchParams.has("saved") ? '<div role="alert">Contact saved</div>' : ""}<form method="post" action="/contacts"><label>Name <input name="name" required></label><label>Email <input type="email" name="email"></label><label>Phone <input type="tel" name="phone"></label><button>Add contact</button></form>`));
    if (p === "/contacts" && req.method === "POST") {
      state.log.push(`contact ${form.get("name")}`);
      return go("/contacts?saved=1");
    }
    if (p === "/reports" && req.method === "GET") return html(page("Reports", `<h1>Reports</h1><form method="post" action="/reports"><label>From <input type="date" name="from" required></label><label>Title <input name="title"></label><button>Run report</button></form>`));
    if (p === "/reports" && req.method === "POST") return html(page("Error", "<h1>500 Internal Server Error</h1><p>Server error</p>"), 500);

    if (p === "/files" && req.method === "GET") {
      const list = [...state.files.keys()].map((n) => `<li class="file">${n} <a href="/uploads/${encodeURIComponent(n)}">open</a> <form method="post" action="/files/delete" style="display:inline"><input type="hidden" name="name" value="${n}"><button>Delete</button></form></li>`).join("");
      return html(page("Files", `<h1>Files</h1><ul>${list}</ul><form method="post" action="/files" enctype="multipart/form-data"><label>Note <input name="note"></label><label>File <input type="file" name="file"></label><button>Upload</button></form>`));
    }
    if (p === "/files" && req.method === "POST") {
      const m = multipart(raw, String(req.headers["content-type"] ?? ""));
      if (m.file?.name) {
        state.files.set(m.file.name, { type: m.file.type, body: m.file.body });
        state.log.push(`upload ${m.file.name}`);
      }
      return go("/files");
    }
    if (p === "/files/delete" && req.method === "POST") {
      state.files.delete(form.get("name") ?? "");
      state.log.push(`delete ${form.get("name")}`);
      return go("/files");
    }
    if (p.startsWith("/uploads/")) {
      const f = state.files.get(decodeURIComponent(p.slice(9)));
      if (!f) return html("not found", 404);
      res.writeHead(200, { "content-type": f.type }); // served inline, with the uploader's type
      return res.end(f.body);
    }

    if (p === "/profile")
      return html(
        page(
          "My profile",
          `<h1>My profile</h1><div id="msg" role="status"></div><form id="f"><label>Name <input name="name" value="${String(state.profile.name)}"></label><button>Save</button></form>
<script>document.getElementById("f").addEventListener("submit", async (e) => { e.preventDefault(); const r = await fetch("/api/profile", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: e.target.name.value }) }); document.getElementById("msg").textContent = r.ok ? "Saved" : "Error"; });</script>`,
        ),
      );
    if (p === "/api/profile" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.profile));
    }
    if (p === "/api/profile" && req.method === "PUT") {
      const b = JSON.parse(raw.toString() || "{}");
      Object.assign(state.profile, b); // every field is kept: mass assignment
      state.log.push(`profile ${Object.keys(b).join(",")}`);
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.profile));
    }
    html("not found", 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return state;
}
