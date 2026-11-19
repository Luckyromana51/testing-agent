import { WEB_AGENT_FIXES } from "./fixes-web.js";
import type { Finding } from "./types.js";

/** How to fix an issue, written for the developer who will do it. */
export interface Fix {
  steps: string;
  /** Ready-to-paste snippets, labelled by where they go. */
  code?: { label: string; snippet: string }[];
  effort: "minutes" | "hours" | "days";
}

const header = (name: string, value: string): Fix["code"] => [
  { label: "Apache / LiteSpeed (.htaccess, Hostinger)", snippet: `Header always set ${name} "${value}"` },
  { label: "Nginx (server block)", snippet: `add_header ${name} "${value}" always;` },
];

const FIXES: Record<string, Fix> = {
  // Visual compare and user journeys
  "visual:changed": {
    steps:
      "Open the page in the report and press Inspect page, then Visual compare: the red parts show what moved. If the change was planned (a new banner, a redesign), press Approve so it becomes the new picture. If not, compare the last deploy's CSS and template changes for that part of the page; a missing stylesheet, a font that did not load, or a script error that stopped a slider are the usual causes.",
    effort: "minutes",
  },
  "journey:failed": {
    steps:
      "Open the journey in the report: the picture after each step shows where it went wrong. If the page changed on purpose (a button renamed), update the journey's steps on the project page. If a request was stopped because it could change data and this is a staging or test site, allow the journey to send forms. Otherwise the step found a real bug: fix the button, link or page the step names, then test again.",
    effort: "hours",
  },
  // Functional
  "page-load-failed": {
    steps: "Open the page yourself. If it times out, check the server error log and the hosting resource limits; if the domain does not resolve, check DNS.",
    effort: "hours",
  },
  "page-error-status": {
    steps: "If the page moved, add a 301 redirect to the new address and update the links pointing here. If it should exist, restore it. For 5xx errors, read the server error log at the time of the test.",
    code: [{ label: "Apache (.htaccess) redirect", snippet: "Redirect 301 /old-page /new-page" }],
    effort: "minutes",
  },
  "broken-link": {
    steps: "Point the link at the right page, or add a 301 redirect from the broken address. Search the theme or CMS for the old address, because menus and footers repeat it on every page.",
    effort: "minutes",
  },
  "broken-external-link": {
    steps: "Find the new address of the page on the other site and update the link, or remove it.",
    effort: "minutes",
  },
  "unverified-external-link": {
    steps: "Open the link in a normal browser. If it works, nothing to do: the other site just blocks automated checks.",
    effort: "minutes",
  },
  "js-exception": {
    steps: "Open the page with the browser console open (F12), reproduce the error and follow the stack trace to the script. Guard against missing elements and data before using them.",
    effort: "hours",
  },
  "sri-blocked": {
    steps: "Recompute the hash of the file exactly as the server sends it and update the integrity attribute (or the script loader that sets it). Then purge the page cache so visitors get the new hash.",
    code: [{ label: "Compute the hash", snippet: "curl -s https://your-site/path/file.js | openssl dgst -sha256 -binary | base64" }],
    effort: "minutes",
  },
  "console-error": {
    steps: "Open the browser console on this page and fix each error in your own scripts. Missing files usually mean a wrong path after a deploy.",
    effort: "hours",
  },
  "console-error-third-party": {
    steps: "Check the widget's settings or update its embed code. Remove widgets you no longer use.",
    effort: "minutes",
  },
  "broken-resource": {
    steps: "Fix the file paths in the theme or template, or upload the missing files. Check case: Linux servers treat Logo.png and logo.png as different files.",
    effort: "minutes",
  },
  "failed-request": {
    steps: "Check that the domain of each failed file still exists and is reachable. Remove scripts from services you no longer use.",
    effort: "minutes",
  },
  "content:placeholder": {
    steps: "Replace the lorem ipsum with real copy, or hide the section until the copy is ready.",
    effort: "minutes",
  },
  "content:template-tag": {
    steps: "Find the template that renders this tag and check that the variable is passed to it. Give it a fallback value so a missing value never shows raw.",
    effort: "hours",
  },
  "content:broken-value": {
    steps: "Find the script that fills in this value and handle the case where the data is missing or not a number (show a dash or hide the element instead).",
    effort: "hours",
  },
  "content:copyright-old": {
    steps: "Print the year automatically instead of typing it.",
    code: [
      { label: "PHP / WordPress", snippet: "&copy; <?php echo date('Y'); ?> Your Company" },
      { label: "JavaScript", snippet: "document.querySelector('.year').textContent = new Date().getFullYear();" },
    ],
    effort: "minutes",
  },
  "forms:unnamed-fields": {
    steps: "Give every input a name attribute that matches what the server expects.",
    code: [{ label: "HTML", snippet: '<input type="tel" name="phone">' }],
    effort: "minutes",
  },
  "forms:email-type": {
    steps: "Change the field type to email so phones show the @ keyboard and the browser checks the format.",
    code: [{ label: "HTML", snippet: '<input type="email" name="email" autocomplete="email">' }],
    effort: "minutes",
  },

  // Security
  "sec:no-https": {
    steps: "Install a free certificate (Let's Encrypt; one click in hPanel under SSL) and redirect all HTTP traffic to HTTPS.",
    code: [
      {
        label: "Apache (.htaccess)",
        snippet: "RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]",
      },
    ],
    effort: "minutes",
  },
  "sec:no-https-redirect": {
    steps: "Redirect every http:// request to https:// with a permanent 301 redirect. In hPanel, turn on Force HTTPS.",
    code: [
      {
        label: "Apache (.htaccess)",
        snippet: "RewriteEngine On\nRewriteCond %{HTTPS} off\nRewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]",
      },
      { label: "Nginx", snippet: "server {\n  listen 80;\n  server_name example.com;\n  return 301 https://$host$request_uri;\n}" },
    ],
    effort: "minutes",
  },
  "sec:hsts-missing": {
    steps: "Send the HSTS header so browsers always use HTTPS. Start with a short max-age, then raise it to one year once everything works over HTTPS.",
    code: header("Strict-Transport-Security", "max-age=31536000; includeSubDomains"),
    effort: "minutes",
  },
  "sec:csp-missing": {
    steps: "Add a Content-Security-Policy. Start in report-only mode, list the domains your scripts, fonts and images come from, then switch to enforcing.",
    code: header(
      "Content-Security-Policy-Report-Only",
      "default-src 'self'; script-src 'self' https://www.googletagmanager.com; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'",
    ),
    effort: "hours",
  },
  "sec:clickjacking": {
    steps: "Stop other sites from embedding your pages in a frame.",
    code: header("X-Frame-Options", "SAMEORIGIN"),
    effort: "minutes",
  },
  "sec:nosniff-missing": {
    steps: "Tell browsers not to guess file types.",
    code: header("X-Content-Type-Options", "nosniff"),
    effort: "minutes",
  },
  "sec:referrer-policy": {
    steps: "Limit how much of your URLs is sent to other sites.",
    code: header("Referrer-Policy", "strict-origin-when-cross-origin"),
    effort: "minutes",
  },
  "sec:version-disclosure": {
    steps: "Hide version numbers from response headers.",
    code: [
      { label: "PHP (php.ini or hPanel PHP options)", snippet: "expose_php = Off" },
      { label: "Apache", snippet: "ServerTokens Prod\nServerSignature Off\nHeader unset X-Powered-By" },
      { label: "Nginx", snippet: "server_tokens off;" },
      { label: "Express", snippet: "app.disable('x-powered-by');" },
    ],
    effort: "minutes",
  },
  "sec:cookie-flags": {
    steps: "Set Secure and HttpOnly on session cookies, and SameSite=Lax unless the cookie must be sent cross-site.",
    code: [
      { label: "PHP", snippet: "session_set_cookie_params(['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);" },
      { label: "Express", snippet: "res.cookie('session', id, { secure: true, httpOnly: true, sameSite: 'lax' });" },
    ],
    effort: "minutes",
  },
  "sec:mixed-content": {
    steps: "Change every http:// file address on the page to https:// (or a relative path). In WordPress, a search-replace of http://yourdomain to https://yourdomain in the database fixes most of them.",
    code: header("Content-Security-Policy", "upgrade-insecure-requests"),
    effort: "minutes",
  },
  "sec:cert-expired": {
    steps: "Renew the certificate now (hPanel > SSL, or certbot renew on a VPS) and make sure auto-renewal runs.",
    code: [{ label: "VPS with certbot", snippet: "sudo certbot renew && sudo systemctl reload nginx" }],
    effort: "minutes",
  },
  "sec:cert-expiring": {
    steps: "Renew the certificate and test auto-renewal so it does not lapse.",
    code: [{ label: "VPS with certbot", snippet: "sudo certbot renew --dry-run" }],
    effort: "minutes",
  },
  "sec:cert-chain": {
    steps: "Configure the server with the full chain (your certificate plus the intermediate), not the certificate alone.",
    code: [{ label: "Nginx", snippet: "ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;" }],
    effort: "minutes",
  },
  "sec:cert-invalid": {
    steps: "Issue a certificate that covers this exact domain (with and without www) from a trusted authority.",
    effort: "minutes",
  },
  "sec:exposed-env": {
    steps: "Block access to the file now, then change every password and key in it, because it may already have been downloaded. Keep .env outside the public folder.",
    code: [
      { label: "Apache (.htaccess)", snippet: '<FilesMatch "^\\.env">\n  Require all denied\n</FilesMatch>' },
      { label: "Nginx", snippet: "location ~ /\\.env { deny all; }" },
    ],
    effort: "hours",
  },
  "sec:exposed-git": {
    steps: "Block /.git in the web server and deploy without the .git folder. Change any password that was ever committed.",
    code: [
      { label: "Apache (.htaccess)", snippet: "RedirectMatch 404 /\\.git" },
      { label: "Nginx", snippet: "location ~ /\\.git { deny all; }" },
    ],
    effort: "hours",
  },
  "sec:exposed-backup": {
    steps: "Delete the backup from the public folder and change the database password. Keep backups outside the web root.",
    effort: "minutes",
  },
  "sec:exposed-phpinfo": { steps: "Delete the phpinfo file from the server.", effort: "minutes" },
  "sec:exposed-log": {
    steps: "Turn off logging to a public file on the live site.",
    code: [{ label: "wp-config.php", snippet: "define('WP_DEBUG', false);\ndefine('WP_DEBUG_LOG', false);" }],
    effort: "minutes",
  },
  "sec:exposed-server-status": {
    steps: "Allow /server-status only from the server itself.",
    code: [{ label: "Apache", snippet: "<Location /server-status>\n  Require local\n</Location>" }],
    effort: "minutes",
  },
  "sec:exposed-ds-store": { steps: "Delete .DS_Store files from the server and add them to .gitignore.", effort: "minutes" },
  "sec:directory-listing": {
    steps: "Turn off automatic folder listings.",
    code: [
      { label: "Apache (.htaccess)", snippet: "Options -Indexes" },
      { label: "Nginx", snippet: "autoindex off;" },
    ],
    effort: "minutes",
  },
  "sec:password-over-http": {
    steps: "Serve the whole site over HTTPS and redirect HTTP to HTTPS. Never collect passwords on an http:// page.",
    effort: "minutes",
  },
  "sec:form-over-http": { steps: "Change the form's action to an https:// address.", effort: "minutes" },
  "csp-violation": {
    steps: "Read the blocked address in the console message. If it is yours, add its domain to the right CSP directive; if you do not recognise it, find out what injected it.",
    effort: "hours",
  },
  "wp:version-visible": {
    steps: "Remove the generator tag and delete /readme.html. Keep WordPress, themes and plugins updated.",
    code: [{ label: "functions.php", snippet: "remove_action('wp_head', 'wp_generator');" }],
    effort: "minutes",
  },
  "wp:user-enumeration": {
    steps: "Hide the users endpoint from visitors who are not logged in (Wordfence or a similar plugin has a switch for this).",
    code: [
      {
        label: "functions.php",
        snippet:
          "add_filter('rest_endpoints', function ($e) {\n  if (!is_user_logged_in()) unset($e['/wp/v2/users'], $e['/wp/v2/users/(?P<id>[\\d]+)']);\n  return $e;\n});",
      },
    ],
    effort: "minutes",
  },
  "wp:xmlrpc": {
    steps: "Turn off XML-RPC unless Jetpack or the WordPress mobile app needs it.",
    code: [
      { label: "functions.php", snippet: "add_filter('xmlrpc_enabled', '__return_false');" },
      { label: "Apache (.htaccess)", snippet: "<Files xmlrpc.php>\n  Require all denied\n</Files>" },
    ],
    effort: "minutes",
  },
  "privacy:no-consent": {
    steps: "Add a consent banner (CookieYes, Complianz or Cookiebot) and load analytics and ad tags only after visitors agree. With Google tags, use Consent Mode v2 defaults set to denied.",
    code: [
      {
        label: "Google Consent Mode default (before the gtag snippet)",
        snippet:
          "gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });",
      },
    ],
    effort: "hours",
  },

  // SEO
  "seo:title-missing": { steps: "Add a unique <title> of 30 to 60 characters with the page's main topic first.", effort: "minutes" },
  "seo:title-length": { steps: "Rewrite the title to 30 to 60 characters, most important words first, brand last.", effort: "minutes" },
  "seo:description-missing": {
    steps: "Add a meta description of 120 to 160 characters that sums up the page and invites the click.",
    code: [{ label: "HTML <head>", snippet: '<meta name="description" content="What this page offers, in one or two sentences.">' }],
    effort: "minutes",
  },
  "seo:description-length": { steps: "Rewrite the description to 120 to 160 characters.", effort: "minutes" },
  "seo:h1-missing": { steps: "Add one <h1> that states the page's main topic.", effort: "minutes" },
  "seo:h1-multiple": { steps: "Keep one <h1> and change the others to <h2> (often the logo or a section title is an extra h1).", effort: "minutes" },
  "seo:img-alt": {
    steps: 'Add alt text that describes each image. Decorative images get an empty alt="".',
    code: [{ label: "HTML", snippet: '<img src="team.jpg" alt="GLV team at the Mohali office">' }],
    effort: "minutes",
  },
  "seo:canonical-missing": {
    steps: "Add a canonical link to the page's preferred address.",
    code: [{ label: "HTML <head>", snippet: '<link rel="canonical" href="https://www.example.com/page">' }],
    effort: "minutes",
  },
  "seo:lang-missing": { steps: "Set the page language on the html tag.", code: [{ label: "HTML", snippet: '<html lang="en">' }], effort: "minutes" },
  "seo:viewport-missing": {
    steps: "Add the viewport tag so the page scales on phones.",
    code: [{ label: "HTML <head>", snippet: '<meta name="viewport" content="width=device-width, initial-scale=1">' }],
    effort: "minutes",
  },
  "seo:noindex": {
    steps: "Remove the noindex robots tag if the page should appear in Google. In WordPress, check Settings > Reading > Discourage search engines.",
    effort: "minutes",
  },
  "seo:og-missing": {
    steps: "Add Open Graph tags so shared links show a title, text and image.",
    code: [
      {
        label: "HTML <head>",
        snippet:
          '<meta property="og:title" content="Page title">\n<meta property="og:description" content="Short summary">\n<meta property="og:image" content="https://www.example.com/share.jpg">',
      },
    ],
    effort: "minutes",
  },
  "seo:robots-missing": {
    steps: "Add a robots.txt that allows crawling and points to the sitemap.",
    code: [{ label: "robots.txt", snippet: "User-agent: *\nAllow: /\n\nSitemap: https://www.example.com/sitemap.xml" }],
    effort: "minutes",
  },
  "seo:robots-blocks-all": {
    steps: 'Remove "Disallow: /" for all user agents. In WordPress, untick Settings > Reading > Discourage search engines.',
    code: [{ label: "robots.txt", snippet: "User-agent: *\nAllow: /\n\nSitemap: https://www.example.com/sitemap.xml" }],
    effort: "minutes",
  },
  "seo:sitemap-missing": {
    steps: "Generate an XML sitemap (Yoast or Rank Math in WordPress, built in on Shopify) and submit it in Google Search Console.",
    effort: "minutes",
  },
  "seo:sitemap-wrong-host": {
    steps: "Set the site address in the CMS or sitemap generator to the final address (https and the same www or non-www as the site), then resubmit the sitemap.",
    effort: "minutes",
  },
  "seo:sitemap-404": { steps: "Regenerate the sitemap so it lists only live pages, then resubmit it in Search Console.", effort: "minutes" },
  "seo:soft-404": {
    steps: "Make the not-found page return HTTP 404. In single-page apps, have the server answer 404 for unknown routes.",
    code: [
      { label: "Apache (.htaccess)", snippet: "ErrorDocument 404 /404.html" },
      { label: "PHP", snippet: "http_response_code(404);" },
    ],
    effort: "hours",
  },
  "seo:duplicate-title": { steps: "Write a different title for each page that names what is unique about it.", effort: "minutes" },
  "seo:duplicate-description": { steps: "Write a different meta description for each page.", effort: "minutes" },
  "seo:structured-data-invalid": {
    steps: "Paste the page into Google's Rich Results Test, fix the JSON error it shows (often a trailing comma or an unescaped quote).",
    effort: "minutes",
  },
  "seo:product-schema-missing": {
    steps: "Add schema.org Product markup with name, image, price, currency and availability. WooCommerce with Yoast or Rank Math, and most Shopify themes, can output it.",
    effort: "hours",
  },

  // Performance
  "perf:lcp": {
    steps: "Find the largest element in the first screen (usually the hero image). Serve it as WebP or AVIF at the size it is shown, preload it, do not lazy-load it, and defer scripts that block rendering.",
    code: [{ label: "HTML <head>", snippet: '<link rel="preload" as="image" href="/hero.webp" fetchpriority="high">' }],
    effort: "hours",
  },
  "perf:cls": {
    steps: "Give images, videos and embeds width and height attributes, reserve space for banners and ads, and use font-display: swap with a matching fallback font.",
    code: [{ label: "HTML", snippet: '<img src="banner.webp" width="1200" height="400" alt="...">' }],
    effort: "hours",
  },
  "perf:ttfb": {
    steps: "Turn on full-page caching (LiteSpeed Cache on Hostinger, or a CDN such as Cloudflare), and look for slow database queries and plugins.",
    effort: "hours",
  },
  "slow-page": { steps: "Lazy-load images and videos below the first screen and defer third-party scripts until after load.", effort: "hours" },
  "heavy-page": {
    steps: "Convert images to WebP or AVIF at the size they are shown, lazy-load videos, and remove unused scripts and fonts.",
    code: [{ label: "HTML", snippet: '<img src="photo.webp" loading="lazy" width="800" height="600" alt="...">' }],
    effort: "hours",
  },

  // Mobile
  "mobile-overflow": {
    steps: "Find the element wider than the screen (often a fixed width, a wide table or an image) and make it fit.",
    code: [{ label: "CSS", snippet: "img, video, iframe { max-width: 100%; height: auto; }\ntable { display: block; overflow-x: auto; }" }],
    effort: "hours",
  },
  "small-tap-targets": {
    steps: "Make buttons and links at least 24 x 24 px (44 x 44 px is better) or add space between them.",
    code: [{ label: "CSS", snippet: ".icon-link { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }" }],
    effort: "hours",
  },
  "mobile-small-text": { steps: "Use at least 16px for body text on phones and 12px for small print.", effort: "minutes" },

  // Accessibility (axe-core rule ids)
  "axe:color-contrast": {
    steps: "Darken the text or lighten the background until the contrast is at least 4.5:1 (3:1 for large text). Check colours at webaim.org/resources/contrastchecker.",
    effort: "minutes",
  },
  "axe:image-alt": { steps: 'Add alt text to each image; use alt="" for decorative ones.', effort: "minutes" },
  "axe:label": {
    steps: "Give every form field a visible label linked to it.",
    code: [{ label: "HTML", snippet: '<label for="email">Email</label>\n<input id="email" type="email" name="email">' }],
    effort: "minutes",
  },
  "axe:button-name": {
    steps: "Give icon-only buttons a name screen readers can read.",
    code: [{ label: "HTML", snippet: '<button aria-label="Open menu"><svg aria-hidden="true">...</svg></button>' }],
    effort: "minutes",
  },
  "axe:link-name": {
    steps: "Give icon-only links a name.",
    code: [{ label: "HTML", snippet: '<a href="https://wa.me/..." aria-label="Chat on WhatsApp"><svg aria-hidden="true">...</svg></a>' }],
    effort: "minutes",
  },
  "axe:html-has-lang": { steps: "Set the page language.", code: [{ label: "HTML", snippet: '<html lang="en">' }], effort: "minutes" },
  "axe:document-title": { steps: "Add a descriptive <title> to the page.", effort: "minutes" },
  "axe:label-content-name-mismatch": {
    steps: "Make the aria-label start with the words that are visible, or remove the aria-label so the visible text is used.",
    code: [{ label: "HTML", snippet: '<a href="/" aria-label="GLV Infotech Solutions Pvt. Ltd. home">GLV INFOTECH SOLUTIONS PVT. LTD.</a>' }],
    effort: "minutes",
  },
  "axe:meta-viewport": {
    steps: "Allow zooming: remove user-scalable=no and maximum-scale=1 from the viewport tag.",
    code: [{ label: "HTML <head>", snippet: '<meta name="viewport" content="width=device-width, initial-scale=1">' }],
    effort: "minutes",
  },
  "axe:frame-title": { steps: "Add a title to each iframe, such as title=\"Office location map\".", effort: "minutes" },
  "axe:select-name": { steps: "Give each dropdown a label.", effort: "minutes" },
  "axe:link-in-text-block": { steps: "Underline links inside paragraphs so they are not told apart by colour alone.", effort: "minutes" },
  "axe:nested-interactive": { steps: "Do not put buttons or links inside other buttons or links; split them apart.", effort: "hours" },
  "axe:aria-hidden-focus": { steps: 'Elements hidden with aria-hidden="true" must not be focusable; add tabindex="-1" or remove aria-hidden.', effort: "minutes" },
  "axe:scrollable-region-focusable": { steps: 'Let keyboard users scroll the area: add tabindex="0" to the scrollable element.', effort: "minutes" },
};

const ROTATE_SECRET: Fix = {
  steps:
    "1. Revoke the key or change the password now: it is already exposed to everyone who has the code. 2. Make a new one and load it from an environment variable or a secrets store. 3. Remove it from the code; if the repository is shared, also purge it from Git history (git filter-repo) because old commits keep it.",
  code: [
    { label: "Node.js", snippet: "const key = process.env.PAYMENT_API_KEY;" },
    { label: "PHP", snippet: "$key = getenv('PAYMENT_API_KEY');" },
    { label: ".gitignore", snippet: ".env\n.env.*\n!.env.example" },
  ],
  effort: "hours",
};

/** A key found inside an Android or iOS app: anyone with the app can unpack it, so it moves to a server. */
const MOBILE_SECRET: Fix = {
  steps:
    "1. Revoke the key now and make a new one: anyone who has the app can unpack it and read the key, and builds already on phones keep it. 2. Do not put the new key in the app. Move the call that needs it to your server: the app calls your server with the user's sign-in, and the server adds the key. 3. Keys that are meant to live in apps (Google Maps, Firebase) stay, but restrict them to your app's bundle ID or package name in their console.",
  code: [
    { label: "Swift", snippet: 'var req = URLRequest(url: URL(string: "https://api.example.com/payments")!)\nreq.setValue("Bearer \\(session.token)", forHTTPHeaderField: "Authorization")' },
    { label: "Kotlin", snippet: 'val req = Request.Builder().url("https://api.example.com/payments")\n    .header("Authorization", "Bearer ${session.token}").build()' },
    { label: "Server (Node.js)", snippet: "// The key lives only on the server.\nconst key = process.env.PAYMENT_API_KEY;" },
  ],
  effort: "hours",
};

/** An example purpose text for each Info.plist key, so the fix shows the key that is missing. */
const PURPOSE_EXAMPLES: Record<string, string> = {
  NSCameraUsageDescription: "Your camera is used to scan the bar code on your order.",
  NSMicrophoneUsageDescription: "Your microphone is used to record voice notes for the seller.",
  NSLocationWhenInUseUsageDescription: "Your location is used to show the stores near you.",
  NSLocationAlwaysAndWhenInUseUsageDescription: "Your location is used to tell you when you are near a store with your order, even when the app is closed.",
  NSContactsUsageDescription: "Your contacts are used so you can invite the friends you pick.",
  NSCalendarsUsageDescription: "Your calendar is used to add the delivery date you choose.",
  NSCalendarsFullAccessUsageDescription: "Your calendar is used to add the delivery date you choose.",
  NSRemindersUsageDescription: "Reminders are used to remind you when your order arrives.",
  NSPhotoLibraryUsageDescription: "Your photos are used so you can add a picture to your review.",
  NSPhotoLibraryAddUsageDescription: "This lets the app save your receipt to your photos.",
  NSSpeechRecognitionUsageDescription: "Speech recognition lets you search the shop by voice.",
  NSBluetoothAlwaysUsageDescription: "Bluetooth is used to connect to your receipt printer.",
  NSMotionUsageDescription: "Motion data is used to count your steps for fitness rewards.",
  NSUserTrackingUsageDescription: "This lets us show you offers from shops you like in other apps.",
  NSHealthShareUsageDescription: "Health data is used to show your workouts in the app.",
  NSHealthUpdateUsageDescription: "This lets the app save your workouts to Health.",
  NSHomeKitUsageDescription: "HomeKit is used to control the lights you add to the app.",
  NFCReaderUsageDescription: "NFC is used to read the tag on your loyalty card.",
  NSAppleMusicUsageDescription: "Your music library is used to pick songs for your videos.",
  NSFaceIDUsageDescription: "Face ID is used to sign you in without your password.",
};

function missingPurposeFix(detail: string): Fix {
  const base = ENGINE_FIXES["ios:missing-purpose"];
  const key = detail.match(/Info\.plist has no (\w+)/)?.[1];
  if (!key) return base;
  const text = PURPOSE_EXAMPLES[key] ?? "Say here what the app uses it for.";
  return { ...base, code: [{ label: "Info.plist", snippet: `<key>${key}</key>\n<string>${text}</string>` }] };
}

/** Fixes for the API, source code and Android engines. */
const ENGINE_FIXES: Record<string, Fix> = {
  // API
  "api:down": { steps: "Check the API server is running and reachable from the internet, and that the base address in the API file (servers) is right.", effort: "hours" },
  "api:no-answer": { steps: "Find why the endpoint hangs: a slow database query, a call to another service without a timeout, or a crash that leaves the request open. Add timeouts and log slow requests.", effort: "hours" },
  "api:server-error": { steps: "Read the server log at the time of the test for the stack trace. Wrap the handler so unexpected errors become a clean 500 with a request id, and fix the cause.", effort: "hours" },
  "api:missing-endpoint": { steps: "Either restore the route, or update the API file so it matches what is deployed. Generate the file from the code (for example with swagger-jsdoc or NestJS Swagger) so they cannot drift apart.", effort: "hours" },
  "api:undocumented-auth": { steps: "Add the security requirement to this operation in the API file.", code: [{ label: "OpenAPI", snippet: "security:\n  - bearerAuth: []" }], effort: "minutes" },
  "api:rate-limited": { steps: "Nothing to fix if the limit is intended. Allow-list the testing server's IP if you want full results.", effort: "minutes" },
  "api:slow": { steps: "Time the database queries behind the endpoint and add indexes for the filters it uses. Cache answers that rarely change, and page long lists (limit and offset or cursor).", effort: "hours" },
  "api:undocumented-status": { steps: "Add the status code the endpoint really returns to its responses in the API file, or change the code to return the documented one.", effort: "minutes" },
  "api:invalid-json": { steps: "Build the answer with your framework's JSON serializer (res.json(), json_encode()) instead of joining strings, and check nothing prints warnings or debug output before the JSON.", effort: "hours" },
  "api:not-json": { steps: "Check the route exists in the API server and is not caught by the website's catch-all route. Set Content-Type: application/json on every answer.", effort: "hours" },
  "api:json-content-type": { steps: "Send Content-Type: application/json.", code: [{ label: "PHP", snippet: "header('Content-Type: application/json');" }, { label: "Express", snippet: "res.json(data);" }], effort: "minutes" },
  "api:schema-mismatch": { steps: "Compare the answer with the schema in the API file and fix whichever is wrong. Add a contract test so a change to either side fails the build.", effort: "hours" },
  "api:refusal-200": { steps: "Return 401 Unauthorized (no or bad login) or 403 Forbidden (logged in but not allowed) instead of 200 with an error message.", code: [{ label: "Express", snippet: "return res.status(401).json({ error: 'Login required' });" }, { label: "PHP", snippet: "http_response_code(401);" }], effort: "minutes" },
  "api:public-marked-secured": { steps: "Mark the operation public in the API file.", code: [{ label: "OpenAPI", snippet: "security: []" }], effort: "minutes" },
  "api:auth-bypass": {
    steps: "Put the auth check in front of this route. In Express, add the middleware to the router, not to single routes, so new routes are covered by default. Then check the logs for who already read this data.",
    code: [{ label: "Express", snippet: "router.use(requireAuth); // before every route in this router" }, { label: "Laravel", snippet: "Route::middleware('auth:sanctum')->group(function () { /* routes */ });" }],
    effort: "hours",
  },
  "api:no-auth-described": { steps: "Describe how clients log in, in components.securitySchemes, and apply it with a top-level security entry.", code: [{ label: "OpenAPI", snippet: "components:\n  securitySchemes:\n    bearerAuth: { type: http, scheme: bearer }\nsecurity:\n  - bearerAuth: []" }], effort: "minutes" },
  "api:secret-in-response": { steps: "Remove the fields from the answer. Use a response model (DTO) or an allow-list of fields instead of returning database rows as they are.", code: [{ label: "Laravel model", snippet: "protected $hidden = ['password', 'remember_token'];" }], effort: "hours" },
  "api:personal-data-public": { steps: "Require a login for this endpoint and return only the logged-in user's own records. If the list must be public, leave out e-mail addresses and phone numbers.", effort: "hours" },
  "api:error-leak": { steps: "Turn off debug mode in production and return a short error message with a request id; write the details to the server log only.", code: [{ label: "Laravel .env", snippet: "APP_DEBUG=false" }, { label: "Express", snippet: "app.use((err, req, res, next) => { log(err); res.status(500).json({ error: 'Server error' }); });" }, { label: "PHP", snippet: "ini_set('display_errors', '0');" }], effort: "minutes" },
  "api:bad-input-crash": { steps: "Check inputs before using them: answer 400 Bad Request for an id of the wrong type and 404 Not Found for unknown ids or routes. Add a catch-all 404 handler.", effort: "hours" },
  "api:no-https": { steps: "Serve the API over HTTPS (a free Let's Encrypt certificate works) and redirect or refuse plain HTTP.", effort: "hours" },
  "api:hsts-missing": { steps: "Add the HSTS header to every HTTPS answer.", code: header("Strict-Transport-Security", "max-age=31536000; includeSubDomains"), effort: "minutes" },
  "api:nosniff-missing": { steps: "Add the header to every answer.", code: header("X-Content-Type-Options", "nosniff"), effort: "minutes" },
  "api:version-disclosure": { steps: "Hide the server software version.", code: [{ label: "Nginx", snippet: "server_tokens off;" }, { label: "Express", snippet: "app.disable('x-powered-by');" }, { label: "PHP (php.ini)", snippet: "expose_php = Off" }], effort: "minutes" },
  "api:cors-reflect": { steps: "Allow only your own front-end addresses instead of copying back any Origin.", code: [{ label: "Express (cors)", snippet: "app.use(cors({ origin: ['https://app.example.com'], credentials: true }));" }], effort: "minutes" },
  "api:cors-invalid": { steps: "List your front-end addresses in Access-Control-Allow-Origin instead of *, when credentials are allowed.", effort: "minutes" },
  "api:spec-no-servers": { steps: "Add the API's address to the file.", code: [{ label: "OpenAPI", snippet: "servers:\n  - url: https://api.example.com/v1" }], effort: "minutes" },
  "api:spec-duplicate-id": { steps: "Give every operation its own operationId, such as listUsers and getUser.", effort: "minutes" },
  "api:spec-no-responses": { steps: "Document at least the success answer of each operation, with its schema.", effort: "hours" },
  "api:spec-no-get": { steps: "Nothing to fix. Logged-in testing of write operations comes with the credentials vault.", effort: "minutes" },
  // Source code
  "code:env-committed": {
    steps: "1. git rm --cached .env 2. Add .env to .gitignore and commit an .env.example with empty values. 3. Change every password and key that was in the file: it stays in Git history.",
    code: [{ label: "Terminal", snippet: "git rm --cached .env\necho '.env' >> .gitignore\ngit commit -m 'Stop tracking .env'" }],
    effort: "hours",
  },
  "code:db-dump": { steps: "Delete the dump from the repository and its history (git filter-repo). Keep only a schema file or seed data with made-up people. If it held real customer data, follow your data-breach process.", effort: "hours" },
  "code:key-file": { steps: "Remove the key file from the code, store it in a secure vault or CI secret, and make a new one if the code was ever shared. For Android upload keys, use Play App Signing so a leak can be recovered.", effort: "hours" },
  "code:vulnerable-package": { steps: "Upgrade the package to the fixed version and run the tests. For npm: npm install name@version. For Composer: composer require vendor/name:^version. If it comes in through another package, upgrade that one, or use npm overrides.", code: [{ label: "npm", snippet: "npm audit fix" }, { label: "Composer", snippet: "composer update vendor/package --with-dependencies" }], effort: "hours" },
  "code:no-lockfile": { steps: "Run npm install (or composer install) once and commit the lockfile it creates. Install with npm ci in CI and on servers.", effort: "minutes" },
  "code:sql-injection": { steps: "Never put values into SQL text. Use placeholders and pass the values separately.", code: [{ label: "PHP (PDO)", snippet: "$stmt = $pdo->prepare('SELECT * FROM users WHERE email = ?');\n$stmt->execute([$email]);" }, { label: "Node (mysql2)", snippet: "await db.execute('SELECT * FROM users WHERE id = ?', [id]);" }, { label: "Python", snippet: "cursor.execute('SELECT * FROM users WHERE id = %s', (user_id,))" }], effort: "hours" },
  "code:command-injection": { steps: "Do not build shell commands from input. Call the program directly with a list of arguments.", code: [{ label: "Node", snippet: "execFile('convert', [input, output]);" }, { label: "PHP", snippet: "exec('convert ' . escapeshellarg($input));" }], effort: "hours" },
  "code:eval": { steps: "Remove eval. Parse data with JSON.parse (or json_decode), and use a map of allowed functions for dynamic calls.", effort: "hours" },
  "code:file-include": { steps: "Map request values to a fixed list of files and never pass input to include or require.", code: [{ label: "PHP", snippet: "$pages = ['home' => 'home.php', 'about' => 'about.php'];\ninclude $pages[$_GET['page'] ?? 'home'] ?? 'home.php';" }], effort: "minutes" },
  "code:unsafe-deserialize": { steps: "Use JSON for data that comes from outside (json_decode, json.loads, yaml.safe_load).", effort: "hours" },
  "code:xss": { steps: "Escape everything you print. In PHP use htmlspecialchars; in JavaScript set textContent, or clean HTML with DOMPurify first.", code: [{ label: "PHP", snippet: "echo htmlspecialchars($value, ENT_QUOTES, 'UTF-8');" }, { label: "JavaScript", snippet: "el.textContent = value;" }], effort: "hours" },
  "code:weak-password-hash": { steps: "Hash passwords with bcrypt or Argon2. Keep the old check for one login, then re-hash with the new method.", code: [{ label: "PHP", snippet: "$hash = password_hash($password, PASSWORD_DEFAULT);\nif (password_verify($password, $hash)) { /* ok */ }" }, { label: "Node", snippet: "const hash = await bcrypt.hash(password, 12);" }], effort: "hours" },
  "code:tls-verify-off": { steps: "Turn certificate checks back on. If the server uses a private certificate authority, give its certificate to the client instead.", effort: "minutes" },
  "code:debug-on": { steps: "Read the debug setting from the environment and keep it off in production.", code: [{ label: "Django", snippet: "DEBUG = os.environ.get('DJANGO_DEBUG') == '1'" }, { label: "PHP", snippet: "ini_set('display_errors', '0');\nini_set('log_errors', '1');" }], effort: "minutes" },
  "code:debugger": { steps: "Remove the debugger statement. Add the no-debugger ESLint rule so it cannot come back.", effort: "minutes" },
  "code:merge-conflict": { steps: "Open the file, keep the right code between the <<<<<<< and >>>>>>> markers, delete the markers and run the tests.", effort: "minutes" },
  "code:broken-json": { steps: "Open the file in an editor that highlights JSON errors (VS Code) and fix the line shown. Usually a trailing comma or a missing quote.", effort: "minutes" },
  "code:no-readme": { steps: "Add README.md with: what the project is, how to install and run it, the environment variables it needs, and how to deploy.", effort: "hours" },
  "code:no-gitignore": { steps: "Add a .gitignore for your stack from github.com/github/gitignore.", code: [{ label: ".gitignore", snippet: "node_modules/\nvendor/\n.env\ndist/\n*.log" }], effort: "minutes" },
  "code:node-modules-committed": { steps: "Stop tracking installed packages.", code: [{ label: "Terminal", snippet: "git rm -r --cached node_modules\necho 'node_modules/' >> .gitignore\ngit commit -m 'Stop tracking node_modules'" }], effort: "minutes" },
  "code:no-tests": { steps: "Add a test runner (Vitest or Jest for JavaScript, PHPUnit for PHP, pytest for Python) and start with tests for login, sign-up and payments. Run them in CI on every push.", effort: "days" },
  "code:debug-output": { steps: "Remove console.log, var_dump and print_r from app code, or switch to a logger with levels. The no-console ESLint rule finds them.", effort: "hours" },
  // Android
  "android:debuggable": { steps: "Build a release version: Build > Generate Signed Bundle / APK > release. Never set android:debuggable in the manifest; Gradle sets it for debug builds only.", effort: "minutes" },
  "android:test-only": { steps: "Build with the release build type from Android Studio or ./gradlew bundleRelease, not from the Run button.", effort: "minutes" },
  "android:backup": { steps: "Turn off backups, or leave out tokens and databases.", code: [{ label: "AndroidManifest.xml", snippet: '<application android:allowBackup="false" ...>' }], effort: "minutes" },
  "android:cleartext": { steps: "Use https:// for every server and block plain HTTP.", code: [{ label: "AndroidManifest.xml", snippet: '<application android:usesCleartextTraffic="false" ...>' }, { label: "res/xml/network_security_config.xml", snippet: '<network-security-config>\n  <base-config cleartextTrafficPermitted="false" />\n</network-security-config>' }], effort: "hours" },
  "android:cleartext-domains": { steps: "Move the listed servers to HTTPS and remove their domain-config exceptions.", effort: "hours" },
  "android:user-certs": { steps: "Trust user-installed certificates only in debug builds.", code: [{ label: "res/xml/network_security_config.xml", snippet: '<debug-overrides>\n  <trust-anchors><certificates src="user" /></trust-anchors>\n</debug-overrides>' }], effort: "minutes" },
  "android:old-target": { steps: "Raise targetSdkVersion in build.gradle to the level Google Play currently requires, then test the behaviour changes listed on developer.android.com for each version in between.", code: [{ label: "app/build.gradle", snippet: "android {\n  defaultConfig { targetSdk 35 }\n}" }], effort: "days" },
  "android:old-min-sdk": { steps: "Raise minSdk to 24 or newer if your users allow it (check Play Console > Statistics > Android version).", effort: "hours" },
  "android:restricted-permissions": { steps: "Remove the SMS and call log permissions. For OTP auto-fill use the SMS Retriever API, which needs no permission.", code: [{ label: "Kotlin", snippet: "SmsRetriever.getClient(context).startSmsRetriever()" }], effort: "hours" },
  "android:declared-permissions": { steps: "Remove the permissions you do not need (the photo picker needs no media permission). For the rest, fill in the declaration in Play Console > App content.", effort: "hours" },
  "android:sensitive-permissions": { steps: "Remove permissions the app does not use, and explain the rest in the privacy policy and the Data safety form.", effort: "hours" },
  "android:open-provider": { steps: "Stop exporting the provider, or protect it with a signature-level permission.", code: [{ label: "AndroidManifest.xml", snippet: '<provider android:name=".DataProvider" android:exported="false" ... />' }], effort: "minutes" },
  "android:open-service": { steps: "Set android:exported=\"false\" unless other apps must call the component; if they must, protect it with a signature-level permission and check every input.", effort: "minutes" },
  "android:open-activity": { steps: "Set android:exported=\"false\" on screens that are not entry points, and check the login state in onCreate of screens that are.", effort: "minutes" },
  "android:http-backend": { steps: "Move the app's servers to HTTPS and update the addresses in the app.", effort: "hours" },
  "android:firebase-open": { steps: "Lock the database rules in Firebase console > Realtime Database > Rules, then check what was exposed.", code: [{ label: "database.rules.json", snippet: '{\n  "rules": { ".read": "auth != null", ".write": "auth != null" }\n}' }], effort: "hours" },
  "ios:ats-off": { steps: "Remove NSAllowsArbitraryLoads and allow plain HTTP only for the servers that still need it, until they move to HTTPS.", code: [{ label: "Info.plist", snippet: "<key>NSAppTransportSecurity</key>\n<dict>\n  <key>NSExceptionDomains</key>\n  <dict>\n    <key>legacy.example.com</key>\n    <dict>\n      <key>NSExceptionAllowsInsecureHTTPLoads</key>\n      <true/>\n    </dict>\n  </dict>\n</dict>" }], effort: "hours" },
  "ios:ats-web-content": { steps: "Remove NSAllowsArbitraryLoadsInWebContent unless the app must show other people's websites, and load your own pages over https.", effort: "minutes" },
  "ios:ats-http-domains": { steps: "Move each listed server to HTTPS (a free Let's Encrypt certificate is enough), then delete its NSExceptionAllowsInsecureHTTPLoads entry.", effort: "hours" },
  "ios:ats-old-tls": { steps: "Turn on TLS 1.2 and 1.3 on the listed servers, then remove NSExceptionMinimumTLSVersion from Info.plist.", effort: "hours" },
  "ios:file-sharing": { steps: "Turn file sharing off, or keep private data out of Documents: databases and caches in Application Support, tokens in the Keychain.", code: [{ label: "Swift", snippet: "let dir = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)" }], effort: "hours" },
  "ios:url-schemes": { steps: "Check every parameter the app reads from these links, ask the user before any sign-in, payment or delete a link starts, and move sensitive links to Universal Links (apple-app-site-association).", effort: "hours" },
  "ios:export-compliance": { steps: "If the app only uses HTTPS and Apple's own encryption, say so in Info.plist.", code: [{ label: "Info.plist", snippet: "<key>ITSAppUsesNonExemptEncryption</key>\n<false/>" }], effort: "minutes" },
  "ios:vague-purpose": { steps: "Rewrite each purpose text to say what the app does with it, in one sentence the user understands.", code: [{ label: "Info.plist", snippet: "<key>NSCameraUsageDescription</key>\n<string>Your camera is used to scan the bar code on your order.</string>" }], effort: "minutes" },
  "ios:missing-purpose": { steps: "Add the missing purpose key to Info.plist with a sentence that says why. If an SDK asks for something the app does not use, turn that part off in the SDK's settings (for Flutter's permission_handler, the PERMISSION_ macros in the Podfile).", code: [{ label: "Info.plist", snippet: "<key>NSLocationWhenInUseUsageDescription</key>\n<string>Your location is used to show the stores near you.</string>" }], effort: "minutes" },
  "ios:no-privacy-manifest": { steps: "In Xcode choose File > New > File > App Privacy, add it to the app target, and declare each listed API category with the reason code that fits (Apple's list of approved reasons).", code: [{ label: "PrivacyInfo.xcprivacy", snippet: "<key>NSPrivacyAccessedAPITypes</key>\n<array>\n  <dict>\n    <key>NSPrivacyAccessedAPIType</key>\n    <string>NSPrivacyAccessedAPICategoryUserDefaults</string>\n    <key>NSPrivacyAccessedAPITypeReasons</key>\n    <array><string>CA92.1</string></array>\n  </dict>\n</array>" }], effort: "hours" },
  "ios:privacy-manifest-reasons": { steps: "Add each listed category to NSPrivacyAccessedAPITypes in PrivacyInfo.xcprivacy, with the reason code that fits from Apple's list.", effort: "hours" },
  "ios:sdk-privacy-manifest": { steps: "Update the listed SDKs (pod update, or the package versions in Xcode or pubspec.yaml) to versions that ship a privacy manifest, then build and check again.", effort: "hours" },
  "ios:tracking-domains": { steps: "List the servers the app or its SDKs use for tracking under NSPrivacyTrackingDomains, or set NSPrivacyTracking to NO if the app does not track.", effort: "hours" },
  "ios:no-arm64": { steps: "Open the project in a current Xcode, set Architectures to Standard Architectures, and archive again.", effort: "hours" },
  "ios:no-pie": { steps: "Remove -no_pie and old linker flags from Other Linker Flags, then build again with a current Xcode.", effort: "minutes" },
  "ios:unsigned": { steps: "Export the app from Xcode: Product > Archive, then Distribute App > Ad Hoc or Development. Xcode signs it with your team's profile.", effort: "minutes" },
  "ios:uiwebview": { steps: "Replace UIWebView with WKWebView in the app, and update the SDKs listed (old Cordova, Facebook and ad SDKs often bring it).", code: [{ label: "Swift", snippet: "import WebKit\nlet webView = WKWebView(frame: view.bounds)\nwebView.load(URLRequest(url: url))" }], effort: "days" },
  "ios:http-backend": { steps: "Move the app's servers to HTTPS and update the addresses in the app.", effort: "hours" },
  "ios:firebase-open": { steps: "Lock the database rules in Firebase console > Realtime Database > Rules, then check what was exposed.", code: [{ label: "database.rules.json", snippet: '{\n  "rules": { ".read": "auth != null", ".write": "auth != null" }\n}' }], effort: "hours" },
  "ios:debug-build": { steps: "Send a release build: Product > Archive, then Distribute App > Ad Hoc (for named devices) or App Store Connect (for TestFlight).", effort: "minutes" },
  "ios:profile-expired": { steps: "Renew the provisioning profile in the Apple Developer account (Certificates, Identifiers & Profiles), or let Xcode manage signing, then export and send the app again.", effort: "minutes" },
  "ios:profile-expiring": { steps: "Renew the provisioning profile before it expires and send a new build to everyone who has the app.", effort: "minutes" },
  "ios:enterprise-build": { steps: "Give clients and testers the app through TestFlight or an Ad Hoc build instead of the Enterprise certificate.", effort: "hours" },
  "ios:push-sandbox": { steps: "Turn on Push Notifications for the App ID, export with a distribution profile (Ad Hoc or App Store), and check aps-environment is production.", effort: "minutes" },
  "android:unsigned": { steps: "Sign the APK with your release key: Build > Generate Signed Bundle / APK, or apksigner sign.", effort: "minutes" },
  "android:debug-signed": { steps: "Make a release key once (keytool), keep it safe, and sign release builds with it; or upload an app bundle and let Play App Signing manage the key.", code: [{ label: "Terminal", snippet: "keytool -genkey -v -keystore release.jks -keyalg RSA -keysize 2048 -validity 10000 -alias release" }], effort: "hours" },
  "android:v1-only": { steps: "Sign with apksigner (Android build tools), which adds the v2 and v3 signatures.", code: [{ label: "Terminal", snippet: "apksigner sign --ks release.jks app.apk" }], effort: "minutes" },
  "android:no-64bit": { steps: "Build native code for arm64-v8a too.", code: [{ label: "app/build.gradle", snippet: "ndk { abiFilters 'armeabi-v7a', 'arm64-v8a' }" }], effort: "hours" },
  "android:16kb-pages": { steps: "Update the libraries that ship these .so files to versions built for 16 KB pages, or rebuild your own native code with NDK r28 or newer and Android Gradle Plugin 8.5.1 or newer. Test on the Android 15 16 KB emulator image.", effort: "hours" },
};

/* Outside tools: their findings get the platform's written fix for the same problem. */
/** The upgrade command for the package named in the finding ("lodash 4.17.15 in package-lock.json has ... Upgrade to 4.17.21 or newer."). */
function packageUpgrade(detail: string): Fix {
  const steps =
    "Upgrade the package to the version named above or newer, then run the tests. If another package brings it in, upgrade that one, or pin the fixed version (npm overrides, a pip constraint, a Go require).";
  const m = detail.match(/^(\S+) \S+ in (\S+) has/);
  const to = detail.match(/Upgrade to (\S+) or newer/)?.[1];
  if (!m || !to) return { steps, effort: "hours" };
  const [, name, file] = m;
  const base = file.split("/").pop() ?? file;
  const how: [RegExp, string, string][] = [
    [/^(package(-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/, "npm", `npm install ${name}@${to}`],
    [/^(requirements.*\.txt|Pipfile(\.lock)?|poetry\.lock|pyproject\.toml|uv\.lock)$/, "requirements.txt", `${name}>=${to}`],
    [/^go\.(mod|sum)$/, "Go", `go get ${name}@v${to.replace(/^v/, "")} && go mod tidy`],
    [/^composer\.(json|lock)$/, "Composer", `composer require ${name}:^${to}`],
    [/^Gemfile(\.lock)?$/, "Bundler", `bundle update ${name}`],
    [/^Cargo\.(toml|lock)$/, "Cargo", `cargo update -p ${name} --precise ${to}`],
  ];
  const hit = how.find(([re]) => re.test(base));
  return { steps, ...(hit ? { code: [{ label: hit[1], snippet: hit[2] }] } : {}), effort: "hours" };
}
const LICENCE_CHECK: Fix = {
  steps:
    "Check the licence against how the product reaches the client. If it is delivered closed-source or run as an online service, replace the package with one under MIT, Apache-2.0 or BSD, or buy a commercial licence from its makers.",
  effort: "hours",
};
const POSTMAN_TEST: Fix = {
  steps:
    "Send the same request from Postman to the same server and compare the answer with the test. If the API is wrong, fix the API; if it changed on purpose, update the test in the collection and export it again.",
  effort: "hours",
};
/** GLV's Opengrep rules (glv.<language>.<name>): the platform rule with the same fix, or a fix of their own. */
const OPENGREP_SAME: Record<string, string> = {
  "eval-input": "code:eval",
  eval: "code:eval",
  unserialize: "code:unsafe-deserialize",
  pickle: "code:unsafe-deserialize",
  "unsafe-yaml": "code:unsafe-deserialize",
  "dom-xss": "code:xss",
  "react-raw-html": "code:xss",
  "trust-all-certs": "code:tls-verify-off",
};
const OPENGREP_FIXES: Record<string, Fix> = {
  ssrf: {
    steps: "Do not fetch addresses taken from the request. Keep a list of allowed hosts, check the parsed host against it, and block private and cloud metadata addresses (10.x, 192.168.x, 169.254.169.254).",
    code: [{ label: "Node", snippet: "const u = new URL(input);\nif (!ALLOWED_HOSTS.includes(u.hostname)) throw new Error('Host not allowed');" }],
    effort: "hours",
  },
  "open-redirect": {
    steps: "Only redirect to paths on your own site, or to addresses on a fixed list. Reject anything that starts with // or a scheme.",
    code: [{ label: "Node", snippet: "const next = String(req.query.next ?? '/');\nres.redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');" }],
    effort: "minutes",
  },
  "path-traversal": {
    steps: "Never join request input into a file path directly. Resolve the full path and check it is still inside the folder you allow, or look the file up by an id.",
    code: [
      { label: "Node", snippet: "const full = path.resolve(BASE, name);\nif (!full.startsWith(BASE + path.sep)) throw new Error('Not allowed');" },
      { label: "Python", snippet: "full = (BASE / name).resolve()\nif not full.is_relative_to(BASE): abort(400)" },
    ],
    effort: "hours",
  },
  "cors-any-origin-credentials": {
    steps: "List the exact sites that may call the API with cookies. Never reflect the request's Origin or use * together with credentials.",
    code: [{ label: "Express (cors)", snippet: "app.use(cors({ origin: ['https://app.example.com'], credentials: true }));" }],
    effort: "minutes",
  },
  "weak-cipher": {
    steps: "Use AES-GCM (or ChaCha20-Poly1305) from the platform's crypto library instead of DES, RC4 or ECB mode, and re-encrypt stored data with the new cipher.",
    code: [{ label: "Java", snippet: 'Cipher.getInstance("AES/GCM/NoPadding")' }],
    effort: "hours",
  },
};
const SCHEMATHESIS_SAME: Record<string, string> = {
  ST101: "api:server-error",
  ST103: "api:undocumented-status",
  ST105: "api:json-content-type",
  ST108: "api:schema-mismatch",
  ST109: "api:invalid-json",
  ST401: "api:auth-bypass",
};

const written = (rule: string): Fix | undefined => FIXES[rule] ?? ENGINE_FIXES[rule] ?? WEB_AGENT_FIXES[rule];

/** What the Mac helper finds that the platform's own rules do not cover. */
const MAC_FIXES: Record<string, Fix> = {
  "voiceover:vague-links": {
    steps: "Put the subject in the link text. If the design needs the short text, add the subject for screen readers only.",
    code: [
      { label: "HTML", snippet: '<a href="/blog/fast-checkout">Read more<span class="sr-only"> about fast checkout</span></a>' },
      { label: "CSS", snippet: ".sr-only {\n  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;\n  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;\n}" },
    ],
    effort: "minutes",
  },
  "voiceover:no-headings": {
    steps: "Mark the page title as h1 and each section title as h2 (sub-sections h3), instead of bold or large text. Keep the look with CSS.",
    code: [{ label: "HTML", snippet: '<h1>Summer sale</h1>\n<section>\n  <h2>New arrivals</h2>\n  ...\n</section>' }],
    effort: "minutes",
  },
  "safari:images-fail": {
    steps: "Serve a format every Safari can show, with the new format as an option the browser picks when it can. Check that the server sends the right Content-Type for each image.",
    code: [{ label: "HTML", snippet: '<picture>\n  <source srcset="/img/hero.avif" type="image/avif">\n  <source srcset="/img/hero.webp" type="image/webp">\n  <img src="/img/hero.jpg" alt="Summer sale" width="1200" height="600">\n</picture>' }],
    effort: "minutes",
  },
  "ios-run:install-fails": {
    steps: "Build for the Simulator from Xcode (Product > Build with a Simulator selected), then zip the .app from the build folder (Product > Show Build Folder in Finder > Products > Debug-iphonesimulator). For a phone, export a Development or Ad Hoc IPA whose profile includes that phone.",
    effort: "minutes",
  },
  "ios-run:crash-on-launch": {
    steps: "Run the app from Xcode on the same iOS version with the debugger attached; it stops on the line that crashes. The crash report's first lines in your own code (below) show where to look. Common causes: a missing Info.plist key, a force-unwrapped value that is nil, a file missing from Copy Bundle Resources.",
    code: [{ label: "Swift", snippet: "// Instead of crashing when a value is missing:\nguard let url = Bundle.main.url(forResource: \"config\", withExtension: \"json\") else {\n    assertionFailure(\"config.json is not in the app\")\n    return\n}" }],
    effort: "hours",
  },
  "ios-run:crash": {
    steps: "Open the same tabs one by one with Xcode's debugger attached to reproduce it, then fix the line it stops on. The crash report below names the code it stopped in.",
    effort: "hours",
  },
  "ios-a11y:sufficientElementDescription": {
    steps: "Give each control and meaningful image a label that says what it does; hide decorative images from VoiceOver.",
    code: [
      { label: "SwiftUI", snippet: 'Button(action: openCart) {\n    Image(systemName: "cart.fill")\n}\n.accessibilityLabel("Cart")\n\nImage("divider").accessibilityHidden(true)' },
      { label: "UIKit", snippet: 'cartButton.accessibilityLabel = "Cart"\ndividerImageView.isAccessibilityElement = false' },
    ],
    effort: "minutes",
  },
  "ios-a11y:hitRegion": {
    steps: "Make each tappable area at least 44 by 44 points, even when the icon stays small.",
    code: [
      { label: "SwiftUI", snippet: "Button(action: remove) { Image(systemName: \"xmark\") }\n    .frame(minWidth: 44, minHeight: 44)\n    .contentShape(Rectangle())" },
      { label: "UIKit", snippet: "// In a UIButton subclass:\noverride func point(inside point: CGPoint, with event: UIEvent?) -> Bool {\n    bounds.insetBy(dx: min(0, (bounds.width - 44) / 2), dy: min(0, (bounds.height - 44) / 2)).contains(point)\n}" },
    ],
    effort: "minutes",
  },
  "ios-a11y:contrast": {
    steps: "Use colours with a contrast of at least 4.5:1 for text (3:1 for large text and controls), in light and dark mode. Asset catalog colours can have a separate dark and high-contrast version.",
    code: [{ label: "SwiftUI", snippet: "Text(\"Sale\")\n    .foregroundStyle(.primary) // system colours adapt to dark mode and Increase Contrast" }],
    effort: "minutes",
  },
  "ios-a11y:dynamicType": {
    steps: "Use text styles instead of fixed point sizes, so text follows the size set in Settings > Accessibility > Display & Text Size.",
    code: [
      { label: "SwiftUI", snippet: 'Text("Total").font(.body)\n// A custom font that still scales:\nText("Total").font(.custom("Avenir", size: 17, relativeTo: .body))' },
      { label: "UIKit", snippet: 'label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(name: "Avenir", size: 17)!)\nlabel.adjustsFontForContentSizeCategory = true' },
    ],
    effort: "minutes",
  },
  "ios-a11y:textClipped": {
    steps: "Let labels wrap onto more lines at large text sizes, and avoid fixed heights around text. Check the large-text screenshot.",
    code: [
      { label: "SwiftUI", snippet: 'Text(product.name)\n    .lineLimit(nil)\n    .fixedSize(horizontal: false, vertical: true)' },
      { label: "UIKit", snippet: "label.numberOfLines = 0" },
    ],
    effort: "minutes",
  },
  "ios-a11y:trait": {
    steps: "Tell VoiceOver what each element is: buttons as buttons, section titles as headers.",
    code: [
      { label: "SwiftUI", snippet: 'Text("Your orders").accessibilityAddTraits(.isHeader)\nview.onTapGesture(perform: open).accessibilityAddTraits(.isButton)' },
      { label: "UIKit", snippet: "titleLabel.accessibilityTraits = .header" },
    ],
    effort: "minutes",
  },
  "ios-a11y:elementDetection": {
    steps: "Expose text drawn in images, and each control inside a custom view, as its own accessibility element, or combine a group into one element with a single label.",
    code: [{ label: "SwiftUI", snippet: 'HStack {\n    Image(systemName: "star.fill")\n    Text("4.5")\n}\n.accessibilityElement(children: .combine)\n.accessibilityLabel("Rated 4.5 out of 5")' }],
    effort: "hours",
  },
};

/** VoiceOver and Safari findings that are the platform's own problems, seen in Apple's software. */
const MAC_SAME: Record<string, string> = {
  "voiceover:unnamed-image": "axe:image-alt",
  "voiceover:file-names": "axe:image-alt",
  "voiceover:unnamed-button": "axe:button-name",
  "voiceover:unnamed-link": "axe:link-name",
  "voiceover:unnamed-field": "axe:label",
  "safari:page-fails": "browser:page-fails",
  "safari:sideways": "browser:sideways",
  "safari:missing-parts": "browser:missing-parts",
};

/** The written fix for an outside tool's finding, when the platform has one for the same problem. */
function toolFix(rule: string, detail: string): Fix | undefined {
  const [tool, id = ""] = rule.split(/:(.*)/s);
  switch (tool) {
    case "pkg":
      return packageUpgrade(detail);
    case "gitleaks":
      return ROTATE_SECRET;
    case "opengrep": {
      const name = id.split(".").pop() ?? "";
      if (name === "hardcoded-jwt-secret") return ROTATE_SECRET;
      return OPENGREP_FIXES[name] ?? written(OPENGREP_SAME[name] ?? `code:${name}`);
    }
    case "trivy": {
      if (id === "licence") return LICENCE_CHECK;
      // Trivy's own advice for a settings problem, without repeating the problem itself.
      const advice = detail.match(/ Fix: (.+)$/s)?.[1];
      return advice ? { steps: advice, effort: "minutes" } : undefined;
    }
    case "schemathesis":
      return written(SCHEMATHESIS_SAME[id] ?? "");
    case "newman":
      return id === "test-failed" ? POSTMAN_TEST : written("api:no-answer");
    case "voiceover":
    case "safari":
    case "ios-run":
    case "ios-a11y":
      return MAC_FIXES[rule] ?? written(MAC_SAME[rule] ?? "");
  }
  return undefined;
}

/** The fix for a finding, or a general one built from the finding's own text. */
export function fixFor(f: Pick<Finding, "rule" | "detail">): Fix {
  if (f.rule === "ios:missing-purpose") return missingPurposeFix(f.detail);
  const known = FIXES[f.rule] ?? ENGINE_FIXES[f.rule] ?? WEB_AGENT_FIXES[f.rule];
  if (known) return known;
  if (/^(android|ios):secret-/.test(f.rule)) return MOBILE_SECRET;
  if (/^code:secret-/.test(f.rule)) return ROTATE_SECRET;
  const tool = toolFix(f.rule, f.detail);
  if (tool) return tool;
  if (f.rule.startsWith("axe:")) {
    const link = f.detail.match(/https:\/\/dequeuniversity\.com\S+/)?.[0];
    return {
      steps: `Follow the step-by-step guide for this accessibility rule${link ? ` at ${link}` : ""}. It shows passing and failing code examples.`,
      effort: "minutes",
    };
  }
  return { steps: f.detail, effort: "hours" };
}

/** Rules that have a written fix (used by tests to keep the list complete). */
export const FIX_RULES = [...Object.keys(FIXES), ...Object.keys(ENGINE_FIXES), ...Object.keys(WEB_AGENT_FIXES)];
