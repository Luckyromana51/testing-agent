import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A small site for the outside tools, with planted problems each tool should find:
 * - HTML errors: a duplicate id and a <div> inside a <ul> (W3C HTML checker)
 * - a render-blocking script that takes 2.5 s, so the page paints late (Lighthouse)
 * - no security headers and an "X-Powered-By: Express" header (ZAP, and the platform's own checks)
 * - a public /.env file (Nuclei, with the test checks in test/fixtures/nuclei)
 * - /account, which only shows "Signed in as dana@example.com" with the session cookie
 * The HTTPS copy uses a self-signed certificate (testssl.sh).
 */
const page = (title: string, body: string, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>${extra}</head><body>${body}</body></html>`;

const PAGES: Record<string, string> = {
  "/": page(
    "Tools demo",
    `<main><h1 id="top">Tools demo</h1><p id="top">Same id twice.</p><ul><div>Not allowed here</div><li><a href="/about">About</a></li><li><a href="/account">Account</a></li></ul></main>`,
    `<script src="/slow.js"></script>`,
  ),
  "/about": page("About", `<main><h1>About</h1><p>We make tools.</p><a href="/">Home</a></main>`),
};

/** Every request the site received, so tests can check no tool sent anything but GET or HEAD. */
export const requests: { method: string; path: string }[] = [];

function handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  requests.push({ method: req.method ?? "", path: url.pathname });
  res.setHeader("X-Powered-By", "Express");
  if (url.pathname === "/slow.js") {
    setTimeout(() => res.writeHead(200, { "content-type": "text/javascript" }).end("window.slow=1;"), 2500);
    return;
  }
  if (url.pathname === "/.env") return res.writeHead(200, { "content-type": "text/plain" }).end("DB_PASSWORD=hunter2\nAPI_KEY=abc\n");
  if (url.pathname === "/account") {
    const signedIn = /(?:^|;\s*)sid=demo-session-0123456789/.test(req.headers.cookie ?? "");
    return res
      .writeHead(200, { "content-type": "text/html" })
      .end(page("Account", signedIn ? `<main><h1>Account</h1><p>Signed in as dana@example.com</p><span id="me"></span><span id="me"></span></main>` : `<main><h1>Please sign in</h1></main>`));
  }
  const body = PAGES[url.pathname];
  if (!body) return res.writeHead(404, { "content-type": "text/html" }).end(page("Not found", "<h1>Not found</h1>"));
  res.writeHead(200, { "content-type": "text/html" }).end(body);
}

export interface DemoTools {
  http: Server;
  https?: Server;
  base: string;
  httpsBase?: string;
  close(): Promise<void>;
}

/** Starts the site on http, and on https too when openssl is installed to make a certificate. */
export async function startDemoTools(port = 4250, httpsPort = 4251): Promise<DemoTools> {
  const http = createServer(handler);
  await new Promise<void>((r) => http.listen(port, r));
  let https: Server | undefined;
  const dir = mkdtempSync(path.join(tmpdir(), "glv-tls-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "2", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem")], { stdio: "ignore" });
    https = createHttps({ key: readFileSync(path.join(dir, "k.pem")), cert: readFileSync(path.join(dir, "c.pem")) }, handler) as unknown as Server;
    await new Promise<void>((r) => https!.listen(httpsPort, r));
  } catch {
    https = undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    http,
    https,
    base: `http://localhost:${port}`,
    httpsBase: https ? `https://localhost:${httpsPort}` : undefined,
    async close() {
      await new Promise((r) => http.close(r));
      if (https) await new Promise((r) => https!.close(r));
    },
  };
}
