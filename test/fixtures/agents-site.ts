import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateSync, gzipSync } from "node:zlib";

/**
 * Two small sites for the website agents. "planted" has one known problem for each agent, page by
 * page; "clean" does everything right, so any finding of the new agents there is a false alarm.
 */

/** A greyscale PNG; with noise it does not compress, so its size is close to width × height bytes. */
export function png(width: number, height: number, noise = false): Buffer {
  let seed = width * 31 + height;
  const next = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed >>> 24;
  };
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1);
    for (let x = 0; x < width; x++) raw[row + 1 + x] = noise ? next() : 180;
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Plain sentences, for pages that need real-looking text. */
const SENTENCES = [
  "Our workshop in Jaipur makes every kurta by hand from soft cotton that breathes in the summer heat.",
  "Each piece is cut, stitched and checked by the same small team, so the fit stays the same from order to order.",
  "We dye the fabric with colours that do not run in the wash, and we test every batch before it reaches you.",
  "Orders leave the workshop within two working days and reach most Indian cities within a week.",
  "If something does not fit, send it back within thirty days and we will exchange it or refund you in full.",
  "Customers often ask how to wash the fabric: cold water and a gentle cycle keep the colour bright for years.",
  "We also make matching dupattas and stoles, and we can tailor sizes for schools, offices and weddings.",
  "Every label lists the fabric, the size chart and the name of the person who checked the stitching.",
];
const words = (n: number) => {
  const out: string[] = [];
  for (let i = 0; out.join(" ").split(" ").length < n; i++) out.push(SENTENCES[i % SENTENCES.length]);
  return out.join(" ");
};
const HINDI =
  "हमारी कार्यशाला जयपुर में है और हर कुर्ता हाथ से बनाया जाता है। हम नरम सूती कपड़े का उपयोग करते हैं जो गर्मी में आरामदायक रहता है। हर टुकड़े को एक ही छोटी टीम काटती, सिलती और जाँचती है। ऑर्डर दो कार्य दिवसों में भेजे जाते हैं और एक सप्ताह में ज़्यादातर शहरों तक पहुँचते हैं। अगर कुछ ठीक न बैठे तो तीस दिनों में वापस भेजें।";
const ARABIC = "ورشتنا في جايبور تصنع كل قطعة يدويا من القطن الناعم الذي يناسب حرارة الصيف. يقوم فريق صغير بقص كل قطعة وخياطتها وفحصها. تغادر الطلبات الورشة خلال يومي عمل وتصل إلى معظم المدن خلال أسبوع. إذا لم تناسبك القطعة يمكنك إعادتها خلال ثلاثين يوما.";

interface Page {
  body: string;
  type?: string;
  status?: number;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// The planted site: one problem per page, so each agent has something to find.

function planted(port: number): (path: string) => Page | Buffer | null {
  const other = `http://localhost:${port}`; // another site, as far as the agents can tell
  const shell = (title: string, body: string, head = "", lang = "en") =>
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${body}</body></html>`;
  const pages: Record<string, () => Page> = {
    "/": () => ({
      body: shell(
        "Planted Shop",
        `<main><h1>Planted Shop</h1>
        <p id="d">25 Mar 2026</p>
        <img src="/hero.png" width="600" height="400" alt="Our workshop">
        <div class="wide">Wide on a sideways iPad</div>
        <ul>
          <li><a href="/monkey">Try the widgets</a></li>
          <li><a href="/keyboard">Keyboard page</a></li><li><a href="/obscured">Long list</a></li>
          <li><a href="/zoom">Zoom page</a></li><li><a href="/spacing">Spacing page</a></li>
          <li><a href="/reader">Reader page</a></li><li><a href="/motion">Motion page</a></li>
          <li><a href="/form">Form page</a></li><li><a href="/anchors">Anchors page</a></li>
          <li><a href="/overlap">Overlap page</a></li><li><a href="/cut">Cut page</a></li>
          <li><a href="/bars">Bars page</a></li><li><a href="/popup">Popup page</a></li>
          <li><a href="/read">Reading page</a></li><li><a href="/images">Images page</a></li>
          <li><a href="/network">Network page</a></li><li><a href="/many">Many files</a></li>
          <li><a href="/third">Third party</a></li><li><a href="/old-page">Moved page</a></li>
          <li><a href="/thin">Thin page</a></li><li><a href="/Upper_Case_Page">Odd address</a></li>
          <li><a href="/sess?PHPSESSID=abc123def456">Session page</a></li>
          <li><a href="/a-very-long-address-for-a-page-that-keeps-going-with-words-nobody-needs-in-an-address-at-all-really">Long address</a></li>
          <li><a href="/deep/1">Deep pages</a></li><li><a href="/leaks">Leaks page</a></li>
          <li><a href="/libs">Libraries page</a></li><li><a href="/login">Sign in</a></li>
          <li><a href="/lang">Language page</a></li><li><a href="/arabic">Arabic page</a></li>
          <li><a href="/latin1">Old charset page</a></li><li><a href="/prices">Prices page</a></li>
          <li><a href="/search?q=kurta">Search</a></li>
        </ul>
        <form action="/search" method="get"><input type="search" name="q"><button>Search</button></form>
        <img src="/shared.png" width="300" height="225" alt="Shared footer picture">
        </main>
        <script>
          if (/^ar/.test(navigator.language) || new Date().getTimezoneOffset() <= -720) {
            document.getElementById("d").textContent = "Invalid Date";
            throw new Error("Unsupported locale");
          }
          if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
        </script>`,
        `<link rel="manifest" href="/manifest.webmanifest"><style>@media (min-width: 1000px) and (max-width: 1100px) { .wide { width: 1300px; } }</style>`,
      ),
    }),
    "/monkey": () => ({
      body: shell("Widgets", `<button onclick="window.cart.open()">Open cart</button><button onclick="null.y">More</button>`),
    }),
    "/keyboard": () => ({
      body: shell(
        "Keyboard",
        `<main><h1>Keyboard</h1><button tabindex="3">First by force</button>
        <p><a href="/" style="outline:none">Home without a focus ring</a></p>
        <div style="cursor:pointer;padding:8px" onclick="this.textContent='opened'">Open the menu</div>
        <p><input id="trap" aria-label="Trap" onkeydown="if (event.key === 'Tab') event.preventDefault()"></p>
        <p><a href="/zoom">After the trap</a></p></main>`,
      ),
    }),
    "/obscured": () => ({
      body: shell(
        "Long list",
        `<main><h1>Long list</h1><ul>${Array.from({ length: 30 }, (_, i) => `<li style="height:40px"><a href="/form">Form link ${i + 1}</a></li>`).join("")}</ul></main>
        <div style="position:fixed;bottom:0;left:0;right:0;height:150px;background:#123;color:#fff">Fixed bottom bar</div>`,
      ),
    }),
    "/zoom": () => ({
      body: shell(
        "Zoom",
        `<main><h1>Zoom</h1><div class="z">Wide at 200% zoom</div><div class="r">Wide at 400% zoom</div></main>`,
        `<style>@media (min-width: 600px) and (max-width: 800px) { .z { width: 1000px; } } @media (max-width: 340px) { .r { width: 500px; } }</style>`,
      ),
    }),
    "/spacing": () => ({
      body: shell(
        "Spacing",
        `<main><h1>Spacing</h1><div style="width:400px;overflow:hidden;white-space:nowrap;font:20px monospace">Free-delivery-on-all-orders-now</div></main>`,
      ),
    }),
    "/reader": () => ({
      body: shell(
        "Reader",
        `<div><h1>Reader</h1><h3>Jumped a level</h3><p>${words(100)}</p>
        <p><a href="/form">Click here</a></p><p><a href="/p/1">Buy</a> <a href="/p/2">Buy</a></p></div>`,
      ),
    }),
    "/motion": () => ({
      body: shell(
        "Motion",
        `<main><h1>Motion</h1><div class="promo">Sale</div><audio src="/tone.wav" autoplay></audio></main>`,
        `<style>.promo { width: 200px; height: 50px; background: gold; animation: slide 2s linear infinite; } @keyframes slide { from { transform: translateX(0); } to { transform: translateX(40px); } }</style>`,
      ),
    }),
    "/form": () => ({
      body: shell(
        "Form",
        `<main><h1>Order form</h1><form method="post" action="/order">
        <p><label for="e">Your email</label> <input type="text" id="e" name="email"></p>
        <p><label for="q">Quantity</label> <input type="number" id="q" name="qty"></p>
        <p><label for="s">Boxes</label> <input type="number" id="s" name="boxes" min="0" max="10" step="3"></p>
        <p><label for="t">Phone</label> <input type="tel" id="t" name="phone"></p>
        <p><label for="c">Pin code</label> <input type="text" id="c" name="pin" pattern="[a-z-.]+"></p>
        <p><label for="n">Name *</label> <input type="text" id="n" name="name"></p>
        </form></main>`,
      ),
    }),
    "/anchors": () => ({ body: shell("Anchors", `<main><h1>Anchors</h1><a href="#delivery">Delivery</a><h2 id="returns">Returns</h2></main>`) }),
    "/overlap": () => ({
      body: shell(
        "Overlap",
        `<main><h1>Overlap</h1><div style="position:relative;height:60px"><p style="position:absolute;top:0;left:0;margin:0;font-size:18px">Free delivery on all orders</p><p style="position:absolute;top:4px;left:20px;margin:0;font-size:18px">Cash on delivery available</p></div></main>`,
      ),
    }),
    "/cut": () => ({
      body: shell("Cut", `<main><h1>Cut</h1><button style="width:70px;overflow:hidden;white-space:nowrap">Add everything to the cart</button></main>`),
    }),
    "/bars": () => ({
      body: shell(
        "Bars",
        `<header style="position:fixed;top:0;left:0;right:0;height:200px;background:#234;color:#fff">Big header</header><main style="padding:220px 0 200px"><h1>Bars</h1><p>${words(60)}</p></main><footer style="position:fixed;bottom:0;left:0;right:0;height:140px;background:#234;color:#fff">Big footer</footer>`,
      ),
    }),
    "/popup": () => ({
      body: shell(
        "Popup",
        `<main><h1>Popup</h1><p>${words(40)}</p></main><div style="position:fixed;inset:0;background:#fff;z-index:9"><h2>Subscribe to our newsletter</h2><p>Get 10% off your first order.</p></div>`,
      ),
    }),
    "/read": () => ({
      body: shell("Reading", `<main><h1>Reading</h1><p style="width:1300px">${words(120)}</p><p style="text-align:justify;max-width:60ch">${words(80)}</p></main>`),
    }),
    "/images": () => ({
      body: shell(
        "Images",
        `<main><h1>Images</h1><img src="/lazy-hero.png" loading="lazy" width="800" height="600" alt="Hero">
        <img src="/big.png" width="200" height="150" alt="Big picture shown small">
        <img src="/big.png" width="300" height="100" alt="Big picture squashed">
        <div style="height:3000px"></div>
        ${Array.from({ length: 5 }, (_, i) => `<img src="/below-${i}.png" width="200" height="150" alt="Below ${i}">`).join("")}</main>`,
      ),
    }),
    "/network": () => ({
      body: shell(
        "Network",
        `<main><h1>Network</h1><p>Files</p></main><script src="/raw.js"></script><script src="/old.js"></script><script src="/dup.js"></script><script src="/dup.js"></script>`,
        `<link rel="stylesheet" href="/nocache.css">`,
      ),
    }),
    "/many": () => ({
      body: shell("Many files", `<main><h1>Many files</h1>${Array.from({ length: 125 }, (_, i) => `<img src="/px/${i}.png" width="4" height="4" alt="">`).join("")}</main>`),
    }),
    "/third": () => ({ body: shell("Third party", `<main><h1>Third party</h1><img src="${other}/heavy.png" width="300" height="300" alt="Widget"></main>`) }),
    "/old-page": () => ({ status: 301, headers: { location: "/new-page" }, body: "" }),
    "/new-page": () => ({ body: shell("New page", `<main><h1>New page</h1><p>${words(200)}</p></main>`) }),
    "/thin": () => ({ body: shell("Thin", `<main><h1>Thin</h1><p>Just a few words here and nothing else.</p><img src="/shared.png" width="300" height="225" alt="Shared"></main>`) }),
    "/Upper_Case_Page": () => ({ body: shell("Odd address", `<main><h1>Odd address</h1><p>${words(200)}</p></main>`) }),
    "/sess": () => ({ body: shell("Session", `<main><h1>Session</h1><p>${words(200)}</p></main>`) }),
    "/a-very-long-address-for-a-page-that-keeps-going-with-words-nobody-needs-in-an-address-at-all-really": () => ({
      body: shell("Long", `<main><h1>Long</h1><p>${words(200)}</p></main>`),
    }),
    "/deep/1": () => ({ body: shell("Deep 1", `<main><h1>Deep 1</h1><p>${words(200)}</p><a href="/deep/2">Deeper</a><img src="/shared.png" width="300" height="225" alt="Shared"></main>`) }),
    "/deep/2": () => ({ body: shell("Deep 2", `<main><h1>Deep 2</h1><p>${words(200)}</p><a href="/deep/3">Deeper</a></main>`) }),
    "/deep/3": () => ({ body: shell("Deep 3", `<main><h1>Deep 3</h1><p>${words(200)}</p><a href="/deep/4">Deeper</a></main>`) }),
    "/deep/4": () => ({ body: shell("Deep 4", `<main><h1>Deep 4</h1><p>${words(200)}</p></main>`) }),
    "/leaks": () => ({
      body: shell(
        "Leaks",
        `<!-- db password = Secr3t!pass --><main><h1>Leaks</h1><p>Fatal error: Uncaught Exception: boom in /var/www/html/index.php on line 42</p></main><script src="/app.js"></script>`,
      ),
    }),
    "/libs": () => ({
      headers: { "content-security-policy": "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" },
      body: shell(
        "Libraries",
        `<main><h1>Libraries</h1></main><script>window.jQuery = function () {}; window.jQuery.fn = { jquery: "1.12.4" };</script>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"></script>`,
      ),
    }),
    "/login": () => ({
      body: shell(
        "Sign in",
        `<main><h1>Sign in</h1>
        <form method="get" action="/session"><input name="user" aria-label="User"><input type="password" name="pw" aria-label="Password" onpaste="return false"></form>
        <form method="post" action="${other}/collect"><input type="password" name="pw2" aria-label="Password again"></form></main>`,
      ),
    }),
    "/lang": () => ({ body: shell("Language", `<main><h1>भाषा</h1><p>${HINDI}</p><p>Itâ€™s our best seller.</p></main>`, `<link rel="alternate" hreflang="en-UK" href="https://example.co.uk/">`) }),
    "/arabic": () => ({ body: shell("Arabic", `<main><h1>عربي</h1><p>${ARABIC}</p></main>`, "", "ar") }),
    "/latin1": () => ({ type: "text/html; charset=windows-1252", body: `<!doctype html><html lang="en"><head><title>Old</title></head><body><main><h1>Old charset</h1><p>${words(200)}</p></main></body></html>` }),
    "/prices": () => ({
      body: shell("Prices", `<main><h1>Prices</h1><p>Kurta ₹499. Stole ₹999. Gift card $20. Gift box $35. Ordered on 03/25/2026.</p><p>${words(160)}</p></main>`),
    }),
    "/search": () => ({ body: shell("Search", `<main><h1>Search</h1><p>No results found.</p></main>`) }),
    "/session": () => ({ body: "signed in" }),
    "/p/1": () => ({ body: shell("Product 1", `<main><h1>Product 1</h1><p>${words(200)}</p></main>`) }),
    "/p/2": () => ({ body: shell("Product 2", `<main><h1>Product 2</h1><p>${words(200)}</p></main>`) }),
  };
  const hero = png(1100, 1000, true);
  const big = png(900, 600, true);
  const shared = png(400, 300, true);
  const files: Record<string, () => Page | Buffer> = {
    "/hero.png": () => hero,
    "/lazy-hero.png": () => png(800, 600),
    "/big.png": () => big,
    "/shared.png": () => shared,
    "/heavy.png": () => hero,
    "/raw.js": () => ({ type: "application/javascript", body: `/* ${"x".repeat(5000)} */ window.raw = 1;`, headers: { "cache-control": "max-age=3600" } }),
    "/old.js": () => ({ status: 301, headers: { location: "/new.js" }, body: "" }),
    "/new.js": () => ({ type: "application/javascript", body: "window.moved = 1;", headers: { "cache-control": "max-age=3600" } }),
    "/dup.js": () => ({ type: "application/javascript", body: "window.dup = (window.dup || 0) + 1;", headers: { "cache-control": "no-store" } }),
    "/nocache.css": () => ({ type: "text/css", body: "main { color: #111; }" }),
    "/app.js": () => ({ type: "application/javascript", body: "window.app = 1;\n//# sourceMappingURL=app.js.map", headers: { "cache-control": "max-age=3600" } }),
    "/app.js.map": () => ({ type: "application/json", body: JSON.stringify({ version: 3, sources: ["src/app.ts"], sourcesContent: ["const secret = 'x';"], mappings: "AAAA" }) }),
    "/manifest.webmanifest": () => ({ type: "application/manifest+json", body: JSON.stringify({ name: "Planted", start_url: "/" }) }),
    "/sw.js": () => ({ type: "application/javascript", body: "self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));" }),
    "/tone.wav": () => ({ type: "audio/wav", body: "" }),
  };
  return (path) => {
    if (path.startsWith("/px/")) return png(4, 4);
    if (path.startsWith("/below-")) return png(320, 240, true);
    return (pages[path] ?? files[path])?.() ?? null;
  };
}

// ---------------------------------------------------------------------------------------------
// The clean site: the same kinds of pages, done right.

function clean(): (path: string, query: URLSearchParams) => Page | Buffer | null {
  const nav = `<header><nav aria-label="Main"><a href="/">Home</a> · <a href="/about">About us</a> · <a href="/kurtas">Kurtas</a> · <a href="/hindi">हिन्दी</a> · <a href="/order">Order</a> · <a href="/sign-in">Sign in</a></nav>
    <form action="/search" method="get" role="search"><label for="q">Search the shop</label> <input type="search" id="q" name="q"> <button>Search</button></form></header>`;
  const shell = (title: string, body: string, lang = "en") =>
    `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="description" content="Handmade cotton kurtas from our Jaipur workshop, delivered across India.">
    <link rel="icon" href="/favicon.png" type="image/png"><link rel="manifest" href="/manifest.webmanifest"><link rel="stylesheet" href="/site.css"></head>
    <body>${nav}<main>${body}</main><footer><p>© 2026 Kurta Workshop · <a href="/about">About us</a></p></footer></body></html>`;
  const pages: Record<string, (q: URLSearchParams) => Page> = {
    "/": () => ({
      body: shell(
        "Handmade Cotton Kurtas",
        `<h1>Handmade Cotton Kurtas</h1><p>${words(60)}</p><img src="/kurta.png" width="120" height="120" alt="A blue kurta"><p>Kurta from ₹499. Next delivery: 25 Mar 2026.</p>
        <h2>Why our kurtas</h2><p>${words(40)}</p><p><button type="button" onclick="this.textContent = 'Thank you'">Say thanks</button></p>`,
      ),
    }),
    "/about": () => ({ body: shell("About our workshop", `<h1>About our workshop</h1><p>${words(180)}</p><h2>Our team</h2><p>${words(60)}</p>`) }),
    "/kurtas": () => ({
      body: shell(
        "Kurtas",
        `<h1>Kurtas</h1><p>${words(160)}</p><ul><li><a href="/kurtas/blue">Blue cotton kurta, ₹499</a></li><li><a href="/kurtas/red">Red cotton kurta, ₹549</a></li></ul>`,
      ),
    }),
    "/kurtas/blue": () => ({ body: shell("Blue cotton kurta", `<h1>Blue cotton kurta</h1><p>₹499</p><p>${words(170)}</p>`) }),
    "/kurtas/red": () => ({ body: shell("Red cotton kurta", `<h1>Red cotton kurta</h1><p>₹549</p><p>${words(170)}</p>`) }),
    "/hindi": () => ({ body: shell("हमारी कार्यशाला", `<h1>हमारी कार्यशाला</h1><p>${HINDI}</p><p>${HINDI}</p><p>${HINDI}</p>`, "hi") }),
    "/order": () => ({
      body: shell(
        "Order",
        `<h1>Order</h1><p>${words(160)}</p><form method="post" action="/order">
        <p><label for="e">Email (required)</label> <input type="email" id="e" name="email" required autocomplete="email"></p>
        <p><label for="qty">Quantity</label> <input type="number" id="qty" name="qty" min="1" max="10" step="1" value="1"></p>
        <p><label for="ph">Phone</label> <input type="tel" id="ph" name="phone" pattern="[6-9][0-9]{9}" inputmode="numeric"></p>
        <p><button>Place order</button></p></form>`,
      ),
    }),
    "/sign-in": () => ({
      body: shell(
        "Sign in",
        `<h1>Sign in</h1><p>${words(160)}</p><form method="post" action="/sign-in"><p><label for="u">Email</label> <input type="email" id="u" name="user" autocomplete="username"></p>
        <p><label for="pw">Password</label> <input type="password" id="pw" name="password" autocomplete="current-password"></p><p><button>Sign in</button></p></form>`,
      ),
    }),
    "/search": (q) => {
      const term = (q.get("q") ?? "").toLowerCase();
      const hit = term && ["handmade", "cotton", "kurta", "kurtas"].includes(term);
      return {
        body: shell(
          "Search results",
          hit ? `<h1>Search results</h1><p>2 results for ${term}:</p><ul><li><a href="/kurtas/blue">Blue cotton kurta</a></li><li><a href="/kurtas/red">Red cotton kurta</a></li></ul>` : `<h1>Search results</h1><p>No results found. Try "kurta" or "cotton".</p>`,
        ),
      };
    },
  };
  const css = `body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #111; background: #fff; } header, main, footer { padding: 16px; } main { max-width: 70ch; } nav a { margin-right: 8px; } img { max-width: 100%; height: auto; }`;
  const files: Record<string, () => Page | Buffer> = {
    "/site.css": () => ({ type: "text/css", body: css }),
    "/kurta.png": () => png(120, 120),
    "/favicon.png": () => png(48, 48),
    "/icon-192.png": () => png(192, 192),
    "/icon-512.png": () => png(512, 512),
    "/manifest.webmanifest": () => ({
      type: "application/manifest+json",
      body: JSON.stringify({ name: "Kurta Workshop", short_name: "Kurtas", start_url: "/", display: "standalone", icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }] }),
    }),
  };
  return (path, query) => {
    const page = pages[path];
    if (page) return page(query);
    return files[path]?.() ?? null;
  };
}

/** Starts one of the two sites on a free port. */
export async function startAgentsSite(kind: "planted" | "clean"): Promise<{ server: Server; port: number; url: string }> {
  let route: (path: string, query: URLSearchParams) => Page | Buffer | null = () => null;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? "/", "http://x");
    const out = route(u.pathname, u.searchParams);
    const gzip = kind === "clean" && /gzip/.test(String(req.headers["accept-encoding"] ?? ""));
    if (!out) {
      const body =
        kind === "clean"
          ? `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page not found</title></head><body><main><h1>Page not found</h1><p>The page you asked for is not here.</p><p><a href="/">Go to the home page</a></p></main></body></html>`
          : "";
      res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(body);
      return;
    }
    if (Buffer.isBuffer(out)) {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400", "content-length": out.length }).end(out);
      return;
    }
    const type = out.type ?? "text/html; charset=utf-8";
    const headers: Record<string, string | number> = { "content-type": type, ...(out.headers ?? {}) };
    if (kind === "clean" && !/html/.test(type)) headers["cache-control"] = "public, max-age=86400";
    if (gzip && out.body) {
      const body = gzipSync(out.body);
      res.writeHead(out.status ?? 200, { ...headers, "content-encoding": "gzip", "content-length": body.length }).end(body);
      return;
    }
    res.writeHead(out.status ?? 200, headers).end(out.body);
  });
  // Both 127.0.0.1 and localhost reach it: the agents treat them as two different sites.
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  route = kind === "planted" ? planted(port) : clean();
  return { server, port, url: `http://127.0.0.1:${port}/` };
}
