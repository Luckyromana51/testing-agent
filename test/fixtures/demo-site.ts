import { createServer, type Server } from "node:http";

/**
 * A small website with known, deliberate bugs. Used by the tests and for demos,
 * so we can prove the scanner finds each kind of problem.
 */
const pages: Record<string, string> = {
  "/": `<!doctype html><html><head><title>Demo Shop</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
  <h1>Demo Shop</h1>
  <img src="/logo.png">
  <p style="color:#bbb;background:#fff">Low contrast text that is hard to read.</p>
  <a href="/about">About us</a>
  <a href="/contact">Contact</a>
  <a href="/missing-page">Our team</a>
  <script>window.addEventListener('load', () => { undefinedFunction(); });</script>
</body></html>`,
  "/about": `<!doctype html><html lang="en"><head><title>About Demo Shop - who we are</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Demo Shop sells handmade products and ships worldwide from our small workshop.">
<link rel="canonical" href="/about"></head>
<body><h1>About</h1><h1>Second heading</h1>
  <div style="width:1200px">This box is too wide for phones.</div>
  <a href="/">Home</a></body></html>`,
  "/contact": `<!doctype html><html lang="en"><head><title>Contact</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>Contact us</h1>
  <form><input type="email" placeholder="Email"><button></button></form>
  <a href="/">Home</a></body></html>`,
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export function startDemoSite(port = 4100): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    // Like a real site moving from example.com to www.example.com: localhost redirects to 127.0.0.1.
    const host = req.headers.host ?? "";
    if (host.startsWith("localhost:")) {
      res.writeHead(301, { location: `http://127.0.0.1:${host.split(":")[1]}${url.pathname}` }).end();
      return;
    }
    if (url.pathname === "/logo.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(PNG);
      return;
    }
    const html = pages[url.pathname];
    if (!html) {
      res.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "session_id=abc123; Path=/",
        "x-powered-by": "Express 4.17.1",
      })
      .end(html);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

if (process.argv[1]?.endsWith("demo-site.ts")) {
  const port = Number(process.env.DEMO_PORT ?? 4100);
  startDemoSite(port).then(() => console.log(`Demo site with known bugs: http://127.0.0.1:${port}`));
}
