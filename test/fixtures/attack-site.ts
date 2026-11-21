import http from "node:http";

/**
 * A site with planted holes for the attack agent (or, as "clean", the same site built safely). It
 * covers command injection (a timed sleep), template injection, NoSQL operators, CRLF/header and
 * host-header injection, CORS, SSRF, broken access control by id (IDOR) and exposed files. Every
 * request is recorded so a test can check nothing but GET went out and nothing was changed.
 */
export interface AttackSite {
  url: string;
  host: string;
  requests: { method: string; url: string }[];
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Distinct records, so stepping the id in /profile returns a genuinely different person. */
const PEOPLE: Record<number, { name: string; city: string; note: string }> = {
  9: { name: "Priya Nair", city: "Kochi", note: "two sarees and a blouse on order" },
  10: { name: "Alice Kumar", city: "Pune", note: "a blue kurta awaiting dispatch" },
  11: { name: "Bob Singh", city: "Delhi", note: "a green dupatta, delivered last week" },
  12: { name: "Chen Wei", city: "Mumbai", note: "a red lehenga, gift wrapped" },
  13: { name: "Dev Patel", city: "Surat", note: "wholesale cotton, forty metres" },
};

export async function startAttackSite(kind: "planted" | "clean"): Promise<AttackSite> {
  const planted = kind === "planted";
  const requests: { method: string; url: string }[] = [];
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}<p>GLV demo shop. Free delivery over 999. Terms apply. Contact support any time.</p></body></html>`;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    const u = new URL(req.url ?? "/", "http://x");
    const sp = u.searchParams;
    const q = (k: string) => sp.get(k) ?? "";
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    const signedIn = (req.headers.cookie ?? "").split(/;\s*/).some((c) => c.startsWith("sid=good"));

    if (req.method !== "GET" && req.method !== "HEAD") return html(405, "no");

    switch (u.pathname) {
      case "/":
        return html(
          200,
          page(
            "Shop",
            `<a href="/net/ping?host=8.8.8.8">Ping</a> <a href="/greet?name=Guest">Greet</a> <a href="/members?user=alice">Members</a>
             <a href="/redir?to=/home">Continue</a> <a href="/profile?id=10">My profile</a> <a href="/fetch?url=https://example.com/logo.png">Preview</a>
             <a href="/account">Account</a> <a href="/api/me">API</a>`,
          ),
        );

      // Command injection: planted, a shell runs, so "; sleep N" delays the answer by N seconds.
      case "/net/ping": {
        const host = q("host");
        const m = planted ? /(?:;|\||\$\(|`|&&|\n)\s*sleep\s+(\d+)/.exec(host) : null;
        const delay = m ? Math.min(Number(m[1]), 12) * 1000 : 0;
        setTimeout(() => html(200, page("Ping", `<pre>PING ${esc(host.split(/[;|`$&\n]/)[0])}: 1 packets</pre>`)), delay);
        return;
      }

      // Template injection: planted, the server works out a sum placed in the name.
      case "/greet": {
        const name = q("name");
        const shown = planted
          ? name.replace(/(?:\{\{|\$\{\{?|#\{|\{|<%=\s*)\s*(\d+)\s*\*\s*(\d+)\s*(?:\}\}|\}|%>)/g, (_, a, b) => String(Number(a) * Number(b)))
          : esc(name);
        return html(200, page("Greeting", `<p>Hello, ${shown}!</p>`));
      }

      // NoSQL: planted, query operators ($ne, $gt) open the member list up.
      case "/members": {
        const plain = q("user");
        const hasOperator = planted && [...sp.keys()].some((k) => /^user\[\$(ne|gt|gte|lt|regex)\]$/.test(k));
        const inControl = [...sp.keys()].some((k) => k === "user[$in]");
        const everyone = Object.values(PEOPLE).map((p) => `<li>${esc(p.name)} — ${esc(p.city)} — ${esc(p.note)}</li>`).join("");
        if (hasOperator && !inControl) return html(200, page("Members", `<ul>${everyone}</ul>`));
        const found = plain && /^(alice|bob|priya|chen|dev)$/i.test(plain);
        return html(200, page("Members", found ? `<ul><li>${esc(plain)} is a member</li></ul>` : `<p>No member by that name. Try searching our directory.</p>`));
      }

      // CRLF / header injection: planted copies the value into a header without stripping line breaks.
      case "/redir": {
        const to = q("to");
        if (planted) {
          const body = page("Redirecting", "<p>Taking you there…</p>");
          const raw =
            `HTTP/1.1 200 OK\r\n` +
            `X-Redirect-To: ${to}\r\n` +
            `Content-Type: text/html; charset=utf-8\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            `Connection: close\r\n\r\n` +
            body;
          try {
            res.socket?.write(raw);
            res.socket?.end();
          } catch {
            html(200, page("Redirecting", "<p>…</p>"));
          }
          return;
        }
        const safe = to.replace(/[\r\n]/g, "");
        return html(200, page("Redirecting", "<p>Taking you there…</p>"), { "x-redirect-to": safe || "/" });
      }

      // Host-header injection: planted builds a link from the host the request claims.
      case "/account": {
        const host = planted ? (req.headers["x-forwarded-host"] as string) || (req.headers["x-forwarded-server"] as string) || req.headers.host || "shop.example" : "shop.example";
        return html(200, page("Account", `<p>Reset your password: <a href="https://${host}/reset?token=abc">click here</a>.</p>`));
      }

      // CORS: planted echoes any Origin back and allows credentials.
      case "/api/me": {
        const origin = (req.headers.origin as string) ?? "";
        const headers: Record<string, string> = {};
        if (planted && origin) {
          headers["access-control-allow-origin"] = origin;
          headers["access-control-allow-credentials"] = "true";
        } else if (origin === "https://shop.example") {
          headers["access-control-allow-origin"] = origin;
        }
        return html(200, JSON.stringify({ user: signedIn ? "alice" : null }), { "content-type": "application/json", ...headers });
      }

      // SSRF: planted fetches whatever address the parameter holds, including internal ones.
      case "/fetch": {
        const url = q("url");
        if (planted) {
          if (url.startsWith("http://169.254.169.254")) return html(200, page("Preview", `<pre>ami-id\ninstance-id\niam/\nplacement/\nreservation-id</pre>`));
          if (url.startsWith("file:///etc/passwd")) return html(200, page("Preview", `<pre>root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1::/usr/sbin:/usr/sbin/nologin</pre>`));
          return html(200, page("Preview", `<p>Fetched ${esc(url)}: Example Domain, a sample page.</p>`));
        }
        if (/^https?:\/\//.test(url) && !/169\.254|127\.0|localhost|\[::1\]|metadata/.test(url)) return html(200, page("Preview", `<p>Fetched a sample page.</p>`));
        return html(400, page("Preview", "<p>That address is not allowed.</p>"));
      }

      // IDOR: planted returns any profile by id to any signed-in user; clean returns only your own.
      case "/profile": {
        if (!signedIn) return html(403, page("Profile", "<p>Please sign in to see this profile.</p>"));
        const id = Number(q("id"));
        const person = PEOPLE[id];
        if (planted) {
          if (!person) return html(404, page("Profile", "<p>No such profile.</p>"));
          return html(200, page("Profile", `<p>${esc(person.name)} from ${esc(person.city)} — ${esc(person.note)}.</p>`));
        }
        // Clean: you may only open your own profile (the session belongs to id 10).
        if (id !== 10) return html(403, page("Profile", "<p>You cannot view someone else's profile.</p>"));
        return html(200, page("Profile", `<p>${esc(PEOPLE[10].name)} from ${esc(PEOPLE[10].city)} — ${esc(PEOPLE[10].note)}.</p>`));
      }

      // Exposed files: planted serves repository and secret files that should never be public.
      case "/.git/config":
        return planted ? html(200, "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = git@github.com:acme/shop.git\n") : html(404, "no");
      case "/.env":
        return planted ? html(200, "SECRET_KEY=s3cr3t-value\nDB_PASSWORD=hunter2\nSTRIPE_KEY=sk_live_abc\n") : html(404, "no");

      default:
        return html(404, page("Not found", "<p>That page does not exist.</p>"));
    }
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    host: `127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
