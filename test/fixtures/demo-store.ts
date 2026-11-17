import { createServer, type Server } from "node:http";

/**
 * A small online store with deliberate store bugs: no refund or shipping policy, a product page
 * with no price or buy button, product data without stock, and a checkout page that loads scripts
 * from several other websites and has no Content Security Policy.
 */
const head = (title: string, extra = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><meta name="description" content="${title} at the demo store, handmade in Jaipur."><link rel="canonical" href="/${title === "Home" ? "" : title.toLowerCase().replace(/\s+/g, "-")}">${extra}</head>`;

const footer = `<footer><a href="/privacy-policy">Privacy</a> <a href="/terms">Terms</a> <a href="/contact">Contact</a></footer>`;

function pages(base: string): Record<string, string> {
  // Other "websites": loopback addresses are other hosts to the browser, so no outside site is needed.
  const others = [2, 3, 4, 5, 6].map((n) => `<script src="${base.replace("localhost", `127.0.0.${n}`)}/tag.js"></script>`).join("");
  return {
    // A planted content bug ({{ cart.count }} shown to shoppers) and an image without alt text.
    "/": `${head("Home")}<body><main><h1>Demo store</h1><p>Items in your cart: {{ cart.count }}</p><img src="/tag.js" width="10" height="10"><a href="/products/mug">Blue mug</a> <a href="/products/lamp">Lamp</a> <a href="/cart">Cart</a> <a href="/blog">Blog</a> <a href="/contact?topic=chat">Chat with us</a></main>${footer}</body></html>`,
    // Not bugs: a template example inside code, and a contact page variant that names /contact as its canonical.
    "/blog": `${head("Blog")}<body><main><h1>Email templates</h1><p>Use this in your order emails:</p><pre><code>Hello {{ customer.name }}, your order is on its way.</code></pre><a href="/">Home</a></main>${footer}</body></html>`,
    "/products/mug": `${head(
      "Blue mug",
      `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Blue mug","offers":{"@type":"Offer","price":"499","priceCurrency":"INR"}}</script>`,
    )}<body><main><h1>Blue mug</h1><p>₹499</p><button>Add to cart</button><a href="/">Home</a></main>${footer}</body></html>`,
    "/products/lamp": `${head("Lamp", `<meta property="og:type" content="product">`)}<body><main><h1>Lamp</h1><p>A brass lamp. Ask us for the price.</p><a href="/">Home</a></main>${footer}</body></html>`,
    "/cart": `${head("Cart")}<body><main><h1>Your cart</h1><p>1 item</p><a href="/">Home</a></main>${others}${footer}</body></html>`,
    "/privacy-policy": `${head("Privacy policy")}<body><main><h1>Privacy</h1><p>We keep your address to deliver orders.</p><a href="/">Home</a></main>${footer}</body></html>`,
    "/terms": `${head("Terms")}<body><main><h1>Terms</h1><p>Rules of sale.</p><a href="/">Home</a></main>${footer}</body></html>`,
    "/contact": `${head("Contact")}<body><main><h1>Contact</h1><p>Write to us.</p><a href="/">Home</a></main>${footer}</body></html>`,
  };
}

export function startDemoStore(port = 4240): Promise<{ server: Server; base: string }> {
  const base = `http://localhost:${port}`;
  const all = pages(base);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    if (path === "/tag.js") return res.writeHead(200, { "content-type": "text/javascript" }).end("window.tags=(window.tags||0)+1;");
    const body = all[path];
    if (!body) return res.writeHead(404, { "content-type": "text/html" }).end(`${head("Not found")}<body><h1>Not found</h1></body></html>`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, base })));
}
