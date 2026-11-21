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
  <a href="/busy">Offers</a>
  <a href="/files/brochure.pdf">Brochure</a>
  <a href="/files/price-list.pdf">Price list</a>
  <a href="/login">Log in</a>
  <a href="/logout">Log out</a>
  <p class="price">Total: ₹NaN</p>
  <footer>© 2019 Demo Shop</footer>
  <script>window.addEventListener('load', () => { undefinedFunction(); });</script>
</body></html>`,
  "/about": `<!doctype html><html lang="en"><head><title>About Demo Shop - who we are</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Demo Shop sells handmade products and ships worldwide from our small workshop.">
<link rel="canonical" href="/about"></head>
<script type="application/ld+json">{ "@type": "Organization", "name": "Demo Shop", }</script>
<body><h1>About</h1><h1>Second heading</h1>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>
  <div style="width:1200px">This box is too wide for phones.</div>
  <a href="/">Home</a></body></html>`,
  "/busy": `<!doctype html><html lang="en"><head><title>Offers at Demo Shop</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>Offers</h1><a href="/">Home</a></body></html>`,
  "/login": `<!doctype html><html lang="en"><head><title>Contact</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>Log in</h1>
  <form method="post" action="/session"><label>Email <input type="text" name="email"></label>
  <label>Password <input type="password" name="password"></label><button>Log in</button></form>
  <a href="/">Home</a></body></html>`,
  "/contact": `<!doctype html><html lang="en"><head><title>Contact</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1>Contact us</h1>
  <img src="/missing.png" alt="Map">
  <form><input type="email" placeholder="Email"><button></button></form>
  <a href="/">Home</a></body></html>`,
};

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** How many times something opened /logout. Must stay 0. */
export let unsafeHits = 0;

/** Pages that answer 503 at first, like a server that is rate limiting or briefly overloaded. */
const FLAKY: Record<string, number> = { "/busy": 1, "/files/price-list.pdf": 2 };

export function startDemoSite(port = 4100): Promise<Server> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const hit = (hits.get(url.pathname) ?? 0) + 1;
    hits.set(url.pathname, hit);
    if (FLAKY[url.pathname] && hit <= FLAKY[url.pathname]) {
      res.writeHead(503, { "content-type": "text/html" }).end("<h1>Busy, try again</h1>");
      return;
    }
    if (url.pathname === "/files/price-list.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.4");
      return;
    }
    // Like a real site moving from example.com to www.example.com: localhost redirects to 127.0.0.1.
    const host = req.headers.host ?? "";
    if (host.startsWith("localhost:")) {
      res.writeHead(301, { location: `http://127.0.0.1:${host.split(":")[1]}${url.pathname}` }).end();
      return;
    }
    if (url.pathname === "/logout") {
      // The crawler and link checker must never open log-out links.
      unsafeHits++;
      res.writeHead(302, { location: "/" }).end();
      return;
    }
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /\n");
      return;
    }
    if (url.pathname === "/.env") {
      res.writeHead(200, { "content-type": "text/plain" }).end("APP_KEY=base64:secret\nDB_PASSWORD=hunter2\n");
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
