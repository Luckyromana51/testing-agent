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

/** The fix for a finding, or a general one built from the finding's own text. */
export function fixFor(f: Pick<Finding, "rule" | "detail">): Fix {
  const known = FIXES[f.rule];
  if (known) return known;
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
export const FIX_RULES = Object.keys(FIXES);
