import type { Fix } from "./fixes.js";

/** Fixes for the website agents added with the keyboard, layout, network and language checks. */
export const WEB_AGENT_FIXES: Record<string, Fix> = {
  // Keyboard, zoom and screen readers
  "a11y:keyboard-trap": {
    steps: "Press Tab through the page yourself. Where focus gets stuck, find the script that moves focus back (often a widget or embedded frame) and let Tab and Shift+Tab leave it. A modal may keep focus inside only while it is open, and must close with Escape.",
    effort: "hours",
  },
  "a11y:focus-not-visible": {
    steps: "Give every link, button and field a clear focus style, and never remove the outline without a replacement.",
    code: [{ label: "CSS", snippet: ":focus-visible {\n  outline: 3px solid #1a73e8;\n  outline-offset: 2px;\n}" }],
    effort: "minutes",
  },
  "a11y:focus-obscured": {
    steps: "Make sure a fixed header, footer or cookie bar never hides the element that has focus. Add scroll padding equal to the bar's height so the browser scrolls focused elements clear of it.",
    code: [{ label: "CSS", snippet: "html {\n  scroll-padding-top: 80px;    /* height of the fixed header */\n  scroll-padding-bottom: 60px; /* height of a fixed bottom bar */\n}" }],
    effort: "minutes",
  },
  "a11y:positive-tabindex": {
    steps: "Remove tabindex values above 0 and put the elements in the right order in the HTML instead. Use tabindex=\"0\" to make a custom control reachable, and tabindex=\"-1\" for elements focused only by script.",
    effort: "minutes",
  },
  "a11y:click-only": {
    steps: "Use a real <button> or <a href> for anything clickable: they work with the keyboard for free. If a <div> must stay, add role=\"button\", tabindex=\"0\" and a keydown handler for Enter and Space.",
    code: [{ label: "HTML", snippet: '<!-- Instead of <div class="buy" onclick="buy()"> -->\n<button type="button" class="buy" onclick="buy()">Buy now</button>' }],
    effort: "minutes",
  },
  "a11y:zoom-200": {
    steps: "Open the page at 200% zoom (Ctrl and +). Replace fixed widths with max-width and percentages, let menus collapse into a menu button, and let tables scroll inside their own box.",
    effort: "hours",
  },
  "a11y:reflow-400": {
    steps: "At 400% zoom the page is as wide as a 320 px phone. Use the same rules as the phone layout: one column, wrapping text, images with max-width: 100%, and wide tables scrolling inside their own box.",
    code: [{ label: "CSS", snippet: "img, video { max-width: 100%; height: auto; }\n.table-wrap { overflow-x: auto; }" }],
    effort: "hours",
  },
  "a11y:text-spacing": {
    steps: "Boxes with a fixed height or overflow: hidden cut text off when visitors widen the spacing. Use min-height instead of height, and let the boxes grow with their text.",
    effort: "hours",
  },
  "a11y:heading-skip": {
    steps: "Use headings in order (h1, then h2, then h3) so screen reader users can jump through the page. Style headings with CSS classes instead of picking a level for its size.",
    effort: "minutes",
  },
  "a11y:no-main": {
    steps: "Wrap the page's main content in <main> (once per page), so screen readers can skip the menu and jump straight to it.",
    code: [{ label: "HTML", snippet: "<header>…</header>\n<main id=\"content\">…</main>\n<footer>…</footer>" }],
    effort: "minutes",
  },
  "a11y:vague-link": {
    steps: "Write link text that says where the link goes (\"Read the refund policy\" instead of \"Click here\"). If the design needs a short label, add the rest for screen readers with aria-label or visually hidden text.",
    effort: "minutes",
  },
  "a11y:same-name-links": {
    steps: "Links with the same text should go to the same place. Make each one distinct, for example \"Buy Blue Kurta\" and \"Buy Red Kurta\" instead of two \"Buy\" links, or add aria-label.",
    effort: "minutes",
  },
  "a11y:ignores-reduced-motion": {
    steps: "Stop or slow endless animations for visitors who turned on Reduce motion in their system settings.",
    code: [{ label: "CSS", snippet: "@media (prefers-reduced-motion: reduce) {\n  *, *::before, *::after {\n    animation-duration: 0.01ms !important;\n    animation-iteration-count: 1 !important;\n    transition-duration: 0.01ms !important;\n    scroll-behavior: auto !important;\n  }\n}" }],
    effort: "minutes",
  },
  "a11y:autoplay-sound": {
    steps: "Do not play sound on arrival: it drowns out screen readers. Start videos muted (autoplay muted) or let visitors press play.",
    code: [{ label: "HTML", snippet: '<video src="intro.mp4" autoplay muted playsinline controls></video>' }],
    effort: "minutes",
  },

  // Forms
  "form:email-accepts-anything": {
    steps: "Use type=\"email\" for email fields, so the browser checks the address and phones show the @ keyboard. Check the address on the server too.",
    code: [{ label: "HTML", snippet: '<input type="email" name="email" autocomplete="email" required>' }],
    effort: "minutes",
  },
  "form:negative-number": {
    steps: "Add min=\"1\" (or min=\"0\") to quantity, age and amount fields, and check the value on the server as well: a negative quantity can make an order total negative.",
    code: [{ label: "HTML", snippet: '<input type="number" name="qty" min="1" max="99" step="1" value="1">' }],
    effort: "minutes",
  },
  "form:boundary-refused": {
    steps: "The field's own lowest or highest value does not fit its step. Make min, max and step agree (with min=\"0.5\" use step=\"0.5\", or step=\"any\" for prices).",
    effort: "minutes",
  },
  "form:phone-accepts-letters": {
    steps: "Use type=\"tel\" with a pattern for phone numbers, and check them on the server.",
    code: [{ label: "HTML (Indian mobile numbers)", snippet: '<input type="tel" name="phone" autocomplete="tel" inputmode="numeric" pattern="[6-9][0-9]{9}" title="10-digit mobile number">' }],
    effort: "minutes",
  },
  "form:pattern-invalid": {
    steps: "The browser cannot read the field's pattern, so it checks nothing. Browsers read patterns with the Unicode \"v\" flag: escape -, (, ), [, ], {, }, / and | inside character classes, and test the pattern in the browser console with new RegExp(pattern, \"v\").",
    effort: "minutes",
  },
  "form:required-not-marked": {
    steps: "Show which fields are required before visitors submit: put \"(required)\" or an asterisk explained above the form in the label, and keep the required attribute.",
    effort: "minutes",
  },

  // Random clicking, screen sizes, search, links
  "monkey:crash": {
    steps: "Repeat the listed clicks and key presses on the page with the console open (F12). Fix the error the console shows, and guard event handlers against missing elements and data.",
    effort: "hours",
  },
  "monkey:frozen": {
    steps: "Something the agent clicked kept the page busy for over 8 seconds. Record it in the browser's Performance tab, find the long task (often a loop or a huge re-render), and split or remove it.",
    effort: "hours",
  },
  "monkey:js-error": {
    steps: "Repeat the listed actions with the console open (F12) and fix the error at the line it shows. Errors after ordinary clicks usually come from handlers that expect an element or data that is not there.",
    effort: "hours",
  },
  "layout:sideways-at-size": {
    steps: "Open the page at the listed sizes (browser DevTools, device toolbar) and find what sticks out: fixed widths, wide tables, long words or images without max-width. Test between your breakpoints, not only at them.",
    code: [{ label: "CSS", snippet: "img, video, iframe { max-width: 100%; }\n.table-wrap { overflow-x: auto; }\np, td { overflow-wrap: anywhere; }" }],
    effort: "hours",
  },
  "link:missing-anchor": {
    steps: "Give the section the id the link points to, or fix the link's #name to match an id that exists.",
    code: [{ label: "HTML", snippet: '<a href="#pricing">Pricing</a>\n…\n<section id="pricing">…</section>' }],
    effort: "minutes",
  },
  "search:error": {
    steps: "Run the same search yourself and read the server error log at that time. Search pages often fail on empty or unusual words: handle them and show a results page every time.",
    effort: "hours",
  },
  "search:finds-nothing": {
    steps: "Rebuild the search index (WooCommerce, Shopify and most CMS search plugins have a reindex button) and check it covers all products and pages.",
    effort: "minutes",
  },
  "search:no-empty-message": {
    steps: "When nothing matches, say so (\"No results for …\"), and suggest popular pages or a spelling.",
    effort: "minutes",
  },
  "search:js-error": {
    steps: "Open the search results page with the console open (F12) and fix the script error it shows.",
    effort: "hours",
  },
  "search:slow": {
    steps: "Add a database index on the searched columns, or use the platform's search service; cache results for common words.",
    effort: "hours",
  },
  "ux:dead-end-404": {
    steps: "Make the missing-page screen helpful: say the page was not found, and link to the home page, search and the main sections. Keep the 404 status code.",
    effort: "minutes",
  },

  // Layout
  "ui:text-overlap": {
    steps: "Inspect the listed elements in DevTools. Remove fixed heights, absolute positions and negative margins that make one block sit on another, and let boxes grow when their text wraps.",
    effort: "hours",
  },
  "ui:text-overlap-phone": {
    steps: "Open the page at 390 px wide (DevTools device toolbar) and inspect the listed elements. Stack side-by-side blocks in one column on small screens and replace fixed heights with min-height.",
    effort: "hours",
  },
  "ui:text-cut-off": {
    steps: "Let the label's box grow: use min-height instead of height, remove white-space: nowrap or allow wrapping on small screens, or shorten the label. If cutting is intended, add text-overflow: ellipsis and the full text in a title.",
    effort: "minutes",
  },
  "ui:sticky-cover": {
    steps: "On phones, keep bars that stay on screen under about a quarter of the height: shrink the header when scrolling, hide it when scrolling down and show it when scrolling up, or let it scroll away.",
    effort: "hours",
  },
  "ui:consent-button-covered": {
    steps: "Give the page room under its last item as tall as the bar that stays on screen, so the accept button can scroll above it. Better still, show the accept button right under the policy's first lines, or in a bar of its own while the policy is open.",
    code: [{ label: "CSS", snippet: "main { padding-bottom: calc(64px + env(safe-area-inset-bottom)); } /* 64px = the bottom menu's height */" }],
    effort: "minutes",
  },
  "ui:consent-no-button": {
    steps: "Draw the \"I agree\" button in the same step that shows the policy text, and keep it on screen if loading the policy fails (with the error next to it). Do not show only \"Try again\" on a screen that asks people to accept something.",
    effort: "minutes",
  },
  "ui:consent-gate": {
    steps: "Nothing to fix in the app. To test the screen behind the policy, sign in once with the test account, accept the policy by hand, then run the test again.",
    effort: "minutes",
  },
  "ui:intrusive-popup": {
    steps: "Do not cover the page on arrival on phones. Show the offer after the visitor scrolls or is about to leave, or use a small banner. Cookie and age notices are fine.",
    effort: "minutes",
  },
  "ui:long-lines": {
    steps: "Limit the width of text columns so lines stay under about 80 characters.",
    code: [{ label: "CSS", snippet: "article p, .content p { max-width: 70ch; }" }],
    effort: "minutes",
  },
  "ui:justified-text": {
    steps: "Align body text to the start of the line instead of justifying it.",
    code: [{ label: "CSS", snippet: "p { text-align: start; }" }],
    effort: "minutes",
  },
  "ui:stretched-image": {
    steps: "Set only one dimension and let the other follow (height: auto), or crop with object-fit.",
    code: [{ label: "CSS", snippet: "img { height: auto; }\n.card img { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; }" }],
    effort: "minutes",
  },

  // Images and network
  "perf:oversized-image": {
    steps: "Resize images to at most twice the size they are shown at, and give the browser several sizes to choose from.",
    code: [{ label: "HTML", snippet: '<img src="shoe-800.webp"\n     srcset="shoe-400.webp 400w, shoe-800.webp 800w, shoe-1600.webp 1600w"\n     sizes="(max-width: 600px) 100vw, 400px"\n     width="400" height="400" alt="Running shoe">' }],
    effort: "hours",
  },
  "perf:lcp-lazy": {
    steps: "Remove loading=\"lazy\" from the main image of the first screen and ask the browser to load it first.",
    code: [{ label: "HTML", snippet: '<img src="hero.webp" fetchpriority="high" width="1200" height="600" alt="…">' }],
    effort: "minutes",
  },
  "perf:no-lazy-images": {
    steps: "Add loading=\"lazy\" to images more than a screen down the page (WordPress 5.5 and later does it for content images).",
    code: [{ label: "HTML", snippet: '<img src="gallery-1.webp" loading="lazy" width="600" height="400" alt="…">' }],
    effort: "minutes",
  },
  "perf:legacy-image-format": {
    steps: "Convert large photos to WebP or AVIF (Squoosh, cwebp, or an image plugin or CDN that does it automatically), and keep a JPEG fallback only if you must support very old browsers.",
    code: [{ label: "HTML", snippet: '<picture>\n  <source srcset="photo.avif" type="image/avif">\n  <source srcset="photo.webp" type="image/webp">\n  <img src="photo.jpg" width="800" height="600" alt="…">\n</picture>' }],
    effort: "hours",
  },
  "perf:no-compression": {
    steps: "Turn on gzip or Brotli compression for HTML, CSS, JavaScript, JSON and SVG in the web server or CDN (on Hostinger, Cloudflare and most hosts it is a switch).",
    code: [
      { label: "Apache / LiteSpeed (.htaccess)", snippet: "<IfModule mod_deflate.c>\n  AddOutputFilterByType DEFLATE text/html text/css text/plain application/javascript application/json image/svg+xml\n</IfModule>" },
      { label: "Nginx", snippet: "gzip on;\ngzip_types text/css application/javascript application/json image/svg+xml text/plain;\ngzip_min_length 1024;" },
    ],
    effort: "minutes",
  },
  "perf:no-cache": {
    steps: "Send caching headers for static files. Files whose name changes with each release (app.3f9a.js) can be cached for a year; others for a day or a week.",
    code: [
      { label: "Apache / LiteSpeed (.htaccess)", snippet: '<FilesMatch "\\.(js|css|woff2|png|jpe?g|webp|avif|svg)$">\n  Header set Cache-Control "public, max-age=604800"\n</FilesMatch>' },
      { label: "Nginx", snippet: "location ~* \\.(js|css|woff2|png|jpe?g|webp|avif|svg)$ {\n  add_header Cache-Control \"public, max-age=604800\";\n}" },
    ],
    effort: "minutes",
  },
  "perf:redirected-file": {
    steps: "Update the page to use each file's final address (often https:// instead of http://, or the address with or without a trailing slash).",
    effort: "minutes",
  },
  "perf:duplicate-requests": {
    steps: "Search the theme and plugins for the file and include it once. If it is included once, check it is sent with caching headers.",
    effort: "minutes",
  },
  "perf:many-requests": {
    steps: "Remove plugins and scripts the page does not use, combine small icons into an SVG sprite or icon font, and load chat, video and map widgets only when the visitor opens them.",
    effort: "hours",
  },
  "perf:third-party-weight": {
    steps: "List the outside scripts (chat, ads, analytics, video, fonts), remove those no longer used, and load the heavy ones after the page or when they are clicked (a video thumbnail that loads the player on click, for example).",
    effort: "hours",
  },
  "perf:slow-phone-network": {
    steps: "Send less before the first screen: compress and resize the main image (WebP, under 150 KB), inline the critical CSS, add defer to scripts, use at most two web font files with font-display: swap, and remove unused plugins. Measure again with Lighthouse's mobile setting.",
    effort: "days",
  },

  // Other browsers
  "browser:page-fails": {
    steps: "Open the page in that browser (Firefox, or Safari on a Mac or iPhone). Check the server does not block or redirect it by its user agent, and that no script stops the page from showing.",
    effort: "hours",
  },
  "browser:js-error": {
    steps: "Open the page in that browser with its developer tools and read the error. Look up the feature on caniuse.com; add the missing feature with core-js or a polyfill, or build the scripts for older browsers with Babel and a browserslist that includes Safari 15 and Firefox ESR.",
    effort: "hours",
  },
  "browser:file-fails": {
    steps: "Open the listed files in that browser. Check their format is supported there (for example AVIF or WebP on old Safari), the server sends the right Content-Type, and CORS headers allow fonts from other domains.",
    effort: "hours",
  },
  "browser:sideways": {
    steps: "Compare the page in both browsers with their developer tools at the same width, find the element that sticks out, and replace the CSS that browser reads differently.",
    effort: "hours",
  },
  "browser:missing-parts": {
    steps: "Compare the saved screenshots. Missing parts usually come from a script error (see the browser's console) or CSS the browser does not support: check each property on caniuse.com and add a fallback.",
    effort: "hours",
  },

  // Search engines
  "seo:deep-page": {
    steps: "Link important pages from the main menu, the footer, category pages or related posts, so every key page is at most 3 clicks from the home page. List them in the sitemap too.",
    effort: "hours",
  },
  "seo:internal-redirect": {
    steps: "Change the listed links to the new address. In WordPress, a search-and-replace plugin can update old addresses in all posts at once.",
    effort: "minutes",
  },
  "seo:thin-content": {
    steps: "Add useful text (what it is, who it is for, details, prices, common questions), merge it with a similar page and redirect the old one, or add <meta name=\"robots\" content=\"noindex\"> if the page is not meant for search.",
    effort: "hours",
  },
  "seo:session-in-url": {
    steps: "Keep the session in a cookie only. In PHP set session.use_only_cookies=1 and session.use_trans_sid=0; in Java set the session tracking mode to COOKIE. Add a canonical link without the id on every page.",
    code: [{ label: "php.ini", snippet: "session.use_only_cookies = 1\nsession.use_trans_sid = 0" }],
    effort: "minutes",
  },
  "seo:url-uppercase": {
    steps: "Use lower-case addresses for new pages, and redirect (301) the old capitalised ones to the lower-case version.",
    effort: "hours",
  },
  "seo:url-underscore": {
    steps: "Use hyphens between words in new addresses (red-shoes). Leave existing addresses unless you add a 301 redirect for each.",
    effort: "minutes",
  },
  "seo:url-long": {
    steps: "Shorten addresses to the words that describe the page (/blog/gst-filing-guide instead of /blog/2026/03/25/a-complete-guide-on-how-to-file-gst-…), and redirect the old ones.",
    effort: "minutes",
  },
  "seo:hreflang-invalid": {
    steps: "Use a language code with an optional country code, full addresses, and a link back from each language version.",
    code: [{ label: "HTML", snippet: '<link rel="alternate" hreflang="en-IN" href="https://example.in/">\n<link rel="alternate" hreflang="hi-IN" href="https://example.in/hi/">\n<link rel="alternate" hreflang="x-default" href="https://example.in/">' }],
    effort: "minutes",
  },

  // Security (passive)
  "sec:html-comment": {
    steps: "Remove the comments from the templates, or strip HTML comments when building or minifying the site. Change any password or key that appeared in one, because it has been public.",
    effort: "minutes",
  },
  "sec:error-details": {
    steps: "Turn off error display on the live site and log errors to a file instead, then fix the error itself. A database error after ordinary browsing can also mean queries are built from text: use prepared statements.",
    code: [
      { label: "PHP (php.ini or .htaccess)", snippet: "display_errors = Off\nlog_errors = On" },
      { label: "Django (settings.py)", snippet: "DEBUG = False" },
      { label: "ASP.NET (web.config)", snippet: '<customErrors mode="On" />' },
    ],
    effort: "minutes",
  },
  "sec:source-map": {
    steps: "Do not upload .map files to the live server (in webpack use devtool: 'hidden-source-map' and keep the maps for your error tracker), or block them in the web server.",
    code: [
      { label: "Nginx", snippet: "location ~* \\.map$ { return 404; }" },
      { label: "Apache (.htaccess)", snippet: '<FilesMatch "\\.map$">\n  Require all denied\n</FilesMatch>' },
    ],
    effort: "minutes",
  },
  "sec:vulnerable-js": {
    steps: "Upgrade the library to the version named in the issue, then test the pages that use it (menus, sliders, forms). On WordPress, update WordPress and the theme or plugin that brings the old copy. If a vendor patched this copy itself, mark the issue as not a problem.",
    effort: "hours",
  },
  "sec:no-sri": {
    steps: "Add an integrity hash and crossorigin to each CDN tag (cdnjs and jsDelivr show the tag with the hash ready to copy), or serve the file from your own server.",
    code: [{ label: "HTML", snippet: '<script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js"\n        integrity="sha384-…" crossorigin="anonymous"></script>' }],
    effort: "minutes",
  },
  "sec:password-in-url": {
    steps: "Send sign-in forms with POST, never GET.",
    code: [{ label: "HTML", snippet: '<form method="post" action="/login">' }],
    effort: "minutes",
  },
  "sec:password-other-site": {
    steps: "Check the form's action address. If it is your own sign-in service on another domain, note it and mark the issue as not a problem; if not, restore the template from a clean copy and look for other changes.",
    effort: "minutes",
  },
  "sec:password-manager-blocked": {
    steps: "Remove paste blockers from password fields and use the right autocomplete value, so password managers can fill them.",
    code: [{ label: "HTML", snippet: '<input type="password" name="password" autocomplete="current-password">\n<!-- on sign-up and change-password forms: autocomplete="new-password" -->' }],
    effort: "minutes",
  },

  // Language and region
  "l10n:wrong-lang": {
    steps: "Set <html lang> to the language the page is written in, and mark passages in another language with their own lang attribute.",
    code: [{ label: "HTML", snippet: '<html lang="hi">\n…\n<p lang="en">Terms and conditions apply.</p>' }],
    effort: "minutes",
  },
  "l10n:rtl-missing": {
    steps: "Add dir=\"rtl\" to the page (or to the parts in Arabic, Urdu or Hebrew) and use logical CSS (margin-inline-start instead of margin-left) so the layout mirrors.",
    code: [{ label: "HTML", snippet: '<html lang="ar" dir="rtl">' }],
    effort: "hours",
  },
  "l10n:not-utf8": {
    steps: "Save templates as UTF-8, send the charset in the Content-Type header, and put <meta charset=\"utf-8\"> first in <head>.",
    code: [{ label: "Apache (.htaccess)", snippet: "AddDefaultCharset UTF-8" }],
    effort: "minutes",
  },
  "l10n:garbled-text": {
    steps: "Make every step UTF-8: the database tables and connection (utf8mb4 on MySQL), imported files, and the page. Then fix the stored text that was already garbled.",
    code: [{ label: "MySQL", snippet: "ALTER TABLE products CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" }],
    effort: "hours",
  },
  "l10n:mixed-currency": {
    steps: "Show all prices in one currency, or the visitor's currency with a switcher. Check the listed products for a price entered in the wrong currency.",
    effort: "minutes",
  },
  "l10n:us-date": {
    steps: "Format dates for Indian visitors day first, ideally with the month as a word.",
    code: [{ label: "JavaScript", snippet: "new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }).format(date) // 25 Mar 2026" }],
    effort: "minutes",
  },
  "l10n:locale-error": {
    steps: "Open the page with the browser's language set to Arabic and its time zone far ahead (DevTools, Sensors panel), and fix the error. Parse ISO dates (2026-03-25T10:00:00Z), format with Intl.DateTimeFormat and Intl.NumberFormat, and never parse numbers from formatted text.",
    effort: "hours",
  },
  "l10n:locale-broken-text": {
    steps: "Find where the page builds dates or numbers from text. Send ISO dates from the server, parse them with new Date(iso), and format them with Intl.DateTimeFormat for the visitor's language.",
    effort: "hours",
  },

  // Site icon and app install
  "app:no-favicon": {
    steps: "Add a site icon in several sizes.",
    code: [{ label: "HTML (in <head>)", snippet: '<link rel="icon" href="/favicon.svg" type="image/svg+xml">\n<link rel="icon" href="/favicon-48.png" sizes="48x48">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">' }],
    effort: "minutes",
  },
  "app:no-manifest": {
    steps: "Add a web app manifest so the site can be installed like an app.",
    code: [{ label: "manifest.webmanifest", snippet: '{\n  "name": "Your App",\n  "short_name": "App",\n  "start_url": "/",\n  "display": "standalone",\n  "theme_color": "#1a73e8",\n  "background_color": "#ffffff",\n  "icons": [\n    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },\n    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" }\n  ]\n}' }],
    effort: "minutes",
  },
  "app:manifest-incomplete": {
    steps: "Fill in the parts the issue lists: name, start_url, display: standalone, and icons of 192 and 512 px. Check it in Chrome DevTools, Application panel, Manifest.",
    effort: "minutes",
  },
  "app:offline-broken": {
    steps: "In the service worker, cache the start page and an offline page when it installs, and answer page requests from the cache when the network fails (Workbox's offline fallback recipe does this).",
    code: [{ label: "Service worker", snippet: "self.addEventListener('install', (e) => e.waitUntil(caches.open('v1').then((c) => c.addAll(['/', '/offline.html']))));\nself.addEventListener('fetch', (e) => {\n  if (e.request.mode === 'navigate') {\n    e.respondWith(fetch(e.request).catch(() => caches.match('/offline.html')));\n  }\n});" }],
    effort: "hours",
  },

  // Load tests (k6, JMeter)
  "load:errors": {
    steps: "Open the server's error log and monitoring for the test window and find what failed first: the web server's worker limit, PHP-FPM or Node processes, database connections, or memory. Raise the limit that ran out, cache pages that are the same for everyone, and move slow work (emails, reports) to a background queue. Then run the same load test again.",
    code: [
      { label: "Nginx: cache pages for 60 s", snippet: "proxy_cache_path /var/cache/nginx keys_zone=pages:10m max_size=1g;\nlocation / {\n  proxy_cache pages;\n  proxy_cache_valid 200 60s;\n  proxy_cache_use_stale error timeout updating;\n  proxy_pass http://app;\n}" },
      { label: "PHP-FPM (www.conf)", snippet: "pm = dynamic\npm.max_children = 40      ; about (RAM for PHP) / (memory per process)\npm.start_servers = 8\npm.min_spare_servers = 4\npm.max_spare_servers = 12" },
    ],
    effort: "days",
  },
  "load:slow": {
    steps: "Profile the slowest addresses listed in the finding under load: look for database queries without indexes, the same query run once per item (N+1), and work done on every request that could be cached. Add indexes, cache results, and serve images and scripts from a CDN or with long cache times.",
    code: [{ label: "SQL: find slow queries (MySQL)", snippet: "SET GLOBAL slow_query_log = 'ON';\nSET GLOBAL long_query_time = 0.5;\n-- then run the load test again and read the slow query log" }],
    effort: "days",
  },
  "load:breaking-point": {
    steps: "Compare the expected peak (a sale, a campaign, exam results day) with the breaking point. If the peak is higher, find what runs out first in the server's monitoring at that moment (CPU, memory, database connections, worker processes), then add caching, a bigger server or more servers behind a load balancer, and test again until the breaking point is well above the peak.",
    effort: "days",
  },
  "load:spike-recovery": {
    steps: "Make the site recover by itself after a rush: set timeouts so stuck requests are dropped instead of queued, let worker processes restart quickly, and make sure caches refill without every request hitting the database at once (cache stampede protection).",
    effort: "days",
  },
  "load:degrades": {
    steps: "Watch memory and open database connections during a long test. Memory that only grows means a leak (objects kept in a global cache or list); connections that only grow mean they are not closed or returned to the pool. Fix the leak, or as a stopgap restart workers after a number of requests.",
    code: [{ label: "PHP-FPM: restart workers regularly", snippet: "pm.max_requests = 500" }, { label: "Node (PM2)", snippet: "pm2 start app.js --max-memory-restart 600M" }],
    effort: "days",
  },
  // Attack probes
  "probe:xss": {
    steps: "Escape every value before putting it into HTML, in the right way for where it goes (HTML text, an attribute, JavaScript or a URL). Use the template engine's automatic escaping instead of building HTML by joining strings, and add a Content Security Policy that blocks inline scripts.",
    code: [
      { label: "PHP", snippet: "<p>Results for <?= htmlspecialchars($_GET['q'] ?? '', ENT_QUOTES, 'UTF-8') ?></p>" },
      { label: "Header (CSP)", snippet: "Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'" },
    ],
    effort: "hours",
  },
  "probe:sql-injection": {
    steps: "Never put request values into SQL text. Use parameterised queries (prepared statements) for every value, check that ids are numbers, and turn off database error messages for visitors. Then check the database logs for signs that the hole was already used.",
    code: [
      { label: "PHP (PDO)", snippet: "$stmt = $pdo->prepare('SELECT name, price FROM products WHERE id = ?');\n$stmt->execute([(int) $_GET['id']]);" },
      { label: "Node (mysql2)", snippet: "const [rows] = await db.execute('SELECT name FROM users WHERE name = ?', [req.query.name]);" },
    ],
    effort: "hours",
  },
  "probe:open-redirect": {
    steps: "Only redirect to the site's own paths: accept a value that starts with a single / (not //), or look the target up in a list of allowed addresses. Otherwise send the visitor to the home page.",
    code: [{ label: "PHP", snippet: "$next = $_GET['next'] ?? '/';\nif (!preg_match('#^/(?!/)#', $next)) $next = '/';\nheader('Location: ' . $next);" }],
    effort: "minutes",
  },
  "probe:path-traversal": {
    steps: "Never use a request value as a file path. Map allowed names to files, or take only the base name and check that the final path is still inside the documents folder. Then check the server logs for earlier reads of system files, and change any password or key stored in files the site can read.",
    code: [{ label: "PHP", snippet: "$name = basename($_GET['file'] ?? '');\n$path = realpath(__DIR__ . '/docs/' . $name);\nif (!$path || !str_starts_with($path, __DIR__ . '/docs/')) { http_response_code(404); exit; }\nreadfile($path);" }],
    effort: "hours",
  },
};
