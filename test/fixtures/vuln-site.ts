import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * A small shop with planted security holes (or, as "clean", the same shop done right), for the
 * attack probes and the permission step. It serves the permission proof file when given a token,
 * and records every request so tests can check that nothing but GET was sent.
 */
export interface VulnSite {
  url: string;
  host: string;
  requests: { method: string; url: string }[];
  /** The line the proof file serves; empty serves 404. */
  setProof(token: string): void;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export async function startVulnSite(kind: "planted" | "clean", docsDir: string): Promise<VulnSite> {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price INTEGER);
    INSERT INTO products VALUES (1, 'Blue kurta', 899), (2, 'Red saree', 2499), (3, 'Green dupatta', 499);
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, city TEXT);
    INSERT INTO users VALUES (1, 'alice', 'Pune'), (2, 'bob', 'Delhi');`);
  const planted = kind === "planted";
  const requests: { method: string; url: string }[] = [];
  let proof = "";
  const page = (title: string, body: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}<p>Thank you for shopping with us. Free delivery on orders above 999.</p></body></html>`;

  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "" });
    const u = new URL(req.url ?? "/", "http://x");
    const q = (k: string) => u.searchParams.get(k) ?? "";
    const html = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };
    if (u.pathname === "/.well-known/glv-testing.txt") {
      if (!proof) return html(404, "not found");
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`# GLV testing permission\n${proof}\n`);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return html(405, "no");
    switch (u.pathname) {
      case "/":
        return html(
          200,
          page(
            "Shop",
            `<a href="/search?q=kurta">Search</a> <a href="/product?id=1">Kurta</a> <a href="/item?id=2">Saree</a> <a href="/user?name=alice">Alice</a>
             <a href="/go?next=/">Home</a> <a href="/doc?file=intro.txt">About</a> <a href="/csp-search?q=saree">Search 2</a> <a href="/news?id=1">News</a>
             <a href="/logout?next=/">Sign out</a> <a href="/cart/delete?id=3">Remove</a>
             <form action="/find"><input name="term" value=""><button>Find</button></form>
             <form action="/subscribe" method="post"><input name="email"><button>Subscribe</button></form>`,
          ),
        );
      case "/search": {
        const v = q("q");
        return html(200, page("Search", `<p>Results for ${planted ? v : esc(v)}</p>`));
      }
      case "/find": {
        const v = q("term");
        return html(200, page("Find", `<input name="term" value="${planted ? v : esc(v)}"><p>No results.</p>`));
      }
      case "/csp-search": {
        const v = q("q");
        // A Content Security Policy that blocks inline scripts: the hole is there, but scripts do not run.
        return html(200, page("Search", `<p>Results for ${planted ? v : esc(v)}</p>`), { "content-security-policy": "script-src 'none'" });
      }
      case "/product": {
        const id = q("id");
        try {
          const rows = planted
            ? (db.prepare(`SELECT name, price FROM products WHERE id = ${id}`).all() as { name: string; price: number }[])
            : /^\d+$/.test(id)
              ? (db.prepare("SELECT name, price FROM products WHERE id = ?").all(Number(id)) as { name: string; price: number }[])
              : null;
          if (rows === null) return html(400, page("Product", "<p>Please choose a product from the list.</p>"));
          return html(200, page("Product", rows.length ? rows.map((r) => `<p>${esc(r.name)}: Rs ${r.price}</p>`).join("") : "<p>No such product.</p>"));
        } catch (err) {
          return html(500, page("Error", `<pre>SQLITE_ERROR: ${esc((err as Error).message)}</pre>`));
        }
      }
      case "/item": {
        // Errors are hidden here: only true/false conditions show the hole.
        const id = q("id");
        let rows: { name: string; price: number }[] = [];
        try {
          rows = planted
            ? (db.prepare(`SELECT name, price FROM products WHERE id = ${id}`).all() as { name: string; price: number }[])
            : /^\d+$/.test(id)
              ? (db.prepare("SELECT name, price FROM products WHERE id = ?").all(Number(id)) as { name: string; price: number }[])
              : [];
        } catch {
          rows = [];
        }
        return html(200, page("Item", rows.length ? rows.map((r) => `<p>${esc(r.name)} costs Rs ${r.price}. In stock and ready to ship from our Jaipur store.</p>`).join("") : "<p>Sorry, we could not find that item.</p>"));
      }
      case "/user": {
        const name = q("name");
        try {
          const rows = planted
            ? (db.prepare(`SELECT name, city FROM users WHERE name = '${name}'`).all() as { name: string; city: string }[])
            : (db.prepare("SELECT name, city FROM users WHERE name = ?").all(name) as { name: string; city: string }[]);
          return html(200, page("User", rows.map((r) => `<p>${esc(r.name)} from ${esc(r.city)}</p>`).join("") || "<p>Nobody by that name.</p>"));
        } catch (err) {
          return html(500, page("Error", `<pre>Error: near "${esc(name.slice(-3))}": syntax error (${esc((err as Error).message)})</pre>`));
        }
      }
      case "/go": {
        const next = q("next");
        const safe = planted ? next : next.startsWith("/") && !next.startsWith("//") ? next : "/";
        res.writeHead(302, { location: safe || "/" });
        return res.end();
      }
      case "/doc": {
        const file = q("file");
        const full = planted ? path.join(docsDir, file) : path.join(docsDir, path.basename(file));
        try {
          if (!planted && !full.startsWith(docsDir)) throw new Error("no");
          return html(200, page("Document", `<pre>${esc(readFileSync(full, "utf8").slice(0, 4000))}</pre>`));
        } catch {
          return html(404, page("Document", "<p>No such document.</p>"));
        }
      }
      case "/news": {
        // Changes on every load (a random offer): true/false comparisons must not be fooled by it.
        const id = q("id");
        const offer = `Today's offer code: SAVE${Math.floor(Math.random() * 90 + 10)}`;
        return html(200, page("News", `<p>Story ${esc(id)}: our winter collection is here.</p><p>${offer}</p>`));
      }
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
    setProof: (t) => (proof = t),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
        db.close();
      }),
  };
}
