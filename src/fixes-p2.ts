import type { Fix } from "./fixes.js";

/**
 * Written fixes for the checks added in wave 2 of the 2026 gap report: AI answer quality, MCP attacks,
 * lookalike domains, race/smuggling/cache/OAuth/SAML/logic attacks, server hardening, DB health,
 * cloud posture, chaos, supply chain, SAST, SBOM, client tests, APIs, payments, email, web quality,
 * speed, mobile and compliance.
 */
export const P2_FIXES: Record<string, Fix> = {
  // AI answer quality (RAG) and fairness
  "aieval:made-up": { steps: "The AI answered with facts not in the client's documents (a hallucination). Ground answers in retrieved passages only, instruct the model to say 'I don't know' when the context does not cover the question, and lower the temperature.", effort: "hours" },
  "aieval:wrong-answer": { steps: "The answer did not match the expected answer. Improve retrieval (chunking, embeddings, re-ranking) so the right passage is found, and add the missing content to the knowledge base.", effort: "hours" },
  "aieval:no-source": { steps: "The answer cited no source. Make the bot return the document/section it used, so users (and you) can check it.", effort: "hours" },
  "aieval:inconsistent": { steps: "The same question gave different answers on repeat. Lower the temperature, pin the model version, and cache answers to common questions.", effort: "hours" },
  "aieval:unfair": { steps: "Answers differed by the sensitive group named in the question. Remove group-dependent wording from prompts and data, and test fairness on each release.", effort: "days" },
  "aieval:regression": { steps: "Answer quality dropped since the last run (a model or prompt change). Compare against the saved baseline, and gate releases on this score.", effort: "hours" },
  "aieval:low-score": { steps: "Overall answer quality is below target. Improve the knowledge base and retrieval, and re-test against the question set.", effort: "days" },

  // MCP server attacks
  "mcp:path": { steps: "An MCP tool read a file outside its allowed folder (path traversal). Resolve and check every path is inside an allow-listed base directory; reject .. and absolute paths.", effort: "hours" },
  "mcp:sql": { steps: "An MCP tool is open to SQL injection. Use parameterised queries, never string-built SQL, and give the tool a least-privilege database user.", effort: "hours" },
  "mcp:ssrf": { steps: "An MCP tool fetched an attacker-chosen URL (SSRF). Allow-list the hosts it may call, and block internal and metadata addresses (169.254.169.254, localhost, private ranges).", effort: "hours" },
  "mcp:cmd": { steps: "An MCP tool ran a shell command built from input (command injection). Call programs with an argument array, never a shell string, and validate inputs.", effort: "hours" },
  "mcp:call-without-token": { steps: "The MCP server ran a tool with no authentication. Require a token on every call and check it before running any tool.", effort: "hours" },

  // Lookalike domains
  "lookalike:registered": { steps: "A lookalike of your domain is registered and could be used for phishing. Check what it serves, consider a UDRP complaint, register the closest typos yourself, and set DMARC p=reject so spoofed mail is dropped.", effort: "days" },

  // Race / smuggling / cache / host-header
  "race:limit-beaten": { steps: "A once-only action succeeded several times when sent at the same instant. Enforce the limit in one database transaction with a row lock (SELECT … FOR UPDATE) or a unique constraint, or an atomic UPDATE … WHERE used = 0 that you check changed one row.", effort: "hours" },
  "attack:cache-poisoning": { steps: "An unkeyed header changed the cached page, so one visitor's response can be served to others. Include every header that affects the response in the cache key (Vary), or stop reflecting those headers.", effort: "hours" },
  "attack:request-smuggling": { steps: "The front-end and back-end disagree on where a request ends (CL.TE/TE.CL), which lets requests be smuggled. Use the same HTTP server/version front and back, reject conflicting Content-Length and Transfer-Encoding, and prefer HTTP/2 end to end.", effort: "days" },

  // Store business logic
  "logic:negative-quantity": { steps: "The cart accepted a negative quantity, lowering the total. On the server, accept only whole quantities of 1 or more, and recompute the price from the product, never from the browser.", effort: "hours" },
  "logic:fraction-quantity": { steps: "The cart accepted a fraction of an item. Accept whole numbers only.", effort: "hours" },
  "logic:no-quantity-limit": { steps: "The cart took any quantity. Cap quantity at the stock on hand and a sensible maximum, checked on the server.", effort: "hours" },

  // OAuth / OpenID / SAML
  "oauth:implicit-flow": { steps: "The app uses the implicit flow (tokens in the URL). Switch to the authorization-code flow with PKCE.", effort: "hours" },
  "oauth:no-pkce": { steps: "The authorization-code flow has no PKCE, so a stolen code can be swapped for a token. Add PKCE (S256).", effort: "hours" },
  "oauth:pkce-plain": { steps: "PKCE uses the 'plain' method. Use S256 (a SHA-256 challenge).", effort: "minutes" },
  "oauth:endpoint-http": { steps: "An OAuth/OIDC endpoint is served over http. Use https everywhere.", effort: "minutes" },
  "oauth:alg-none": { steps: "The provider lists 'none' as a token signing algorithm, so unsigned tokens could be accepted. Remove 'none' and verify signatures with the published keys.", effort: "hours" },
  "oauth:public-client-no-pkce": { steps: "A public client (SPA, mobile) has no client secret and no PKCE. Add PKCE; public clients must use it.", effort: "hours" },
  "oauth:no-state": { steps: "The login has no state parameter, so it can be CSRF'd. Send a random state and check it on return (PKCE also helps).", effort: "hours" },
  "oauth:link-no-pkce": { steps: "An authorize link starts a flow without PKCE. Add code_challenge/code_challenge_method=S256.", effort: "hours" },
  "oauth:redirect-http": { steps: "A redirect_uri uses http. Register https redirect URIs only, and match them exactly.", effort: "minutes" },
  "saml:assertions-unsigned": { steps: "SAML assertions are not signed, so they can be forged or wrapped. Require signed assertions and verify the signature against the IdP certificate.", effort: "hours" },
  "saml:requests-unsigned": { steps: "SAML requests are not signed. Sign AuthnRequests and verify them.", effort: "hours" },
  "saml:cert-expired": { steps: "The SAML signing certificate has expired. Roll it over with the IdP and update metadata.", effort: "hours" },
  "saml:cert-expiring": { steps: "The SAML signing certificate expires soon. Plan the roll-over now to avoid an outage.", effort: "hours" },
  "saml:sha1": { steps: "SAML uses SHA-1 signatures, which are weak. Move to SHA-256.", effort: "hours" },

  // File upload runs code / EXIF
  "app:upload-runs-code": { steps: "An uploaded file was served and executed as code (a web shell). Store uploads outside the web root, serve them from a path with execution turned off, check the real file type, and rename to a random name with a safe extension.", effort: "hours" },
  "privacy:photo-location": { steps: "Uploaded photos keep their GPS location in EXIF, exposing where users live or work. Strip EXIF on upload (re-encode the image server-side).", code: [{ label: "PHP (GD re-encode strips EXIF)", snippet: "$img = imagecreatefromjpeg($tmp); imagejpeg($img, $dest, 85); imagedestroy($img);" }], effort: "hours" },
  "privacy:photo-owner": { steps: "Photos carry the camera owner's name/serial in EXIF. Strip metadata on upload.", effort: "hours" },

  // Server hardening (CIS-style)
  "server:no-firewall": { steps: "No host firewall is active. Turn on ufw (or nftables) and allow only the ports you use.", code: [{ label: "Shell", snippet: "ufw default deny incoming\nufw allow 22,80,443/tcp\nufw enable" }], effort: "minutes" },
  "server:no-fail2ban": { steps: "No brute-force protection. Install fail2ban to ban IPs that fail SSH/login repeatedly.", code: [{ label: "Shell", snippet: "apt install fail2ban && systemctl enable --now fail2ban" }], effort: "minutes" },
  "server:no-auto-updates": { steps: "Security updates are not applied automatically. Enable unattended-upgrades (Debian/Ubuntu) or dnf-automatic (RHEL).", effort: "minutes" },
  "server:no-auditd": { steps: "No audit logging. Install and enable auditd so security events are recorded.", effort: "minutes" },
  "server:aslr-off": { steps: "Address-space randomisation is off. Set kernel.randomize_va_space=2 in sysctl.", effort: "minutes" },
  "server:syncookies-off": { steps: "TCP SYN cookies are off, so the server is open to SYN floods. Set net.ipv4.tcp_syncookies=1.", effort: "minutes" },
  "server:icmp-redirects": { steps: "ICMP redirects are accepted, which allows route hijacking. Set net.ipv4.conf.all.accept_redirects=0.", effort: "minutes" },
  "server:core-dumps": { steps: "Core dumps are allowed and may leak secrets to disk. Disable them (fs.suid_dumpable=0, limits).", effort: "minutes" },
  "server:ssh-x11": { steps: "SSH X11 forwarding is on and not needed. Set X11Forwarding no in sshd_config.", effort: "minutes" },
  "server:ssh-maxauth": { steps: "SSH allows many auth tries per connection. Set MaxAuthTries 3.", effort: "minutes" },
  "server:extra-root": { steps: "More than one account has UID 0 (root). Give each admin their own account and use sudo; only root should be UID 0.", effort: "hours" },
  "server:lynis-low": { steps: "The Lynis hardening score is low. Work through its suggestions (lynis audit system) starting with the warnings.", effort: "days" },
  "server:no-backups": { steps: "No backup tool or recent backup was found. Set up automated, tested, off-server backups (and practise a restore).", effort: "hours" },
  "certin:no-ntp": { steps: "Time is not synced (NTP off). India's CERT-In rules require synced clocks for logs to be trusted. Enable chrony/systemd-timesyncd to an NTP server (NIC NTP for India).", effort: "minutes" },
  "certin:log-retention": { steps: "Logs are not kept long enough. CERT-In requires 180 days of logs, retained in India. Configure logrotate to keep 180 days and ship logs to retained storage.", effort: "hours" },

  // Database health
  "db:no-primary-key": { steps: "A table has no primary key, which slows replication and some queries. Add a primary key (an auto-increment id if there is no natural key).", effort: "hours" },
  "db:huge-table": { steps: "A very large table was found. Archive old rows, partition by date, and make sure its queries use indexes.", effort: "days" },
  "db:myisam": { steps: "A table uses MyISAM, which has no transactions and locks the whole table. Convert it to InnoDB.", code: [{ label: "SQL", snippet: "ALTER TABLE your_table ENGINE=InnoDB;" }], effort: "hours" },
  "db:missing-index": { steps: "A column used to look rows up has no index, so queries scan the whole table. Add an index on the columns in your WHERE/JOIN clauses.", effort: "hours" },
  "db:no-foreign-keys": { steps: "Tables reference each other with no foreign keys, so orphan rows can build up. Add foreign-key constraints (InnoDB).", effort: "hours" },
  "db:plain-passwords": { steps: "A column looks like it stores passwords in plain text. Hash them with bcrypt/argon2 and never store or log the plain password.", effort: "hours" },
  "db:slow-log-off": { steps: "The slow-query log is off, so you cannot see which queries are slow. Turn on slow_query_log with long_query_time=1.", effort: "minutes" },
  "db:slow-queries": { steps: "The slow-query log has slow queries. Run EXPLAIN on each, add the missing indexes, and rewrite the worst ones.", effort: "hours" },

  // Chaos
  "chaos:no-recovery": { steps: "The site did not come back after a service fault. Set the service to restart itself (systemd Restart=always), fix its start-up errors, and add a health check that alerts you.", effort: "hours" },
  "chaos:slow-recovery": { steps: "A restart took the site down for a while. Use reload instead of restart where possible, run two instances behind the proxy, or serve a maintenance page during restarts.", effort: "hours" },
  "chaos:raw-error-page": { steps: "Visitors saw raw errors while a service was down. Serve a friendly 503 page (with Retry-After) from the web server when the app is down.", effort: "hours" },
  "chaos:delay-amplified": { steps: "A small network delay made pages much slower, a sign of many sequential back-end calls. Batch the calls, add caching, and set timeouts.", effort: "hours" },

  // Supply chain (CI + deps)
  "ci:action-not-pinned": { steps: "A GitHub Action is used by a moving tag (@v3), so its code can change under you. Pin it to a full commit SHA.", effort: "minutes" },
  "ci:pwn-request": { steps: "A workflow runs on pull_request_target and checks out the PR code, which can steal secrets. Do not check out untrusted PR code in a privileged workflow; split build and deploy.", effort: "hours" },
  "ci:script-injection": { steps: "A workflow puts untrusted input (a PR title, branch) straight into a run: script. Pass it through an env var and quote it, never interpolate ${{ github.* }} into the shell.", effort: "hours" },
  "ci:write-all": { steps: "A workflow grants permissions: write-all. Give each job only the scopes it needs (contents: read by default).", effort: "minutes" },
  "ci:self-hosted-pr": { steps: "A self-hosted runner runs on pull requests from forks, which lets strangers run code on your runner. Use ephemeral runners, or restrict to trusted branches.", effort: "hours" },
  "deps:from-git-or-url": { steps: "A dependency is pulled from a git URL or tarball, not a registry with a locked version. Use a published, version-pinned package where possible.", effort: "hours" },
  "deps:plain-http": { steps: "A dependency is fetched over http. Use https so it cannot be swapped in transit.", effort: "minutes" },
  "deps:any-version": { steps: "A dependency allows any version (*, latest), so a build can pull a new, possibly malicious release. Pin versions and commit a lockfile.", effort: "minutes" },
  "deps:install-script": { steps: "A dependency runs an install script (postinstall), a common malware vector. Review it, and install with scripts disabled where you can.", effort: "hours" },
  "deps:typosquat": { steps: "A dependency name is one character from a popular package (typosquat). Confirm it is the package you meant, from the right publisher.", effort: "minutes" },
  "deps:no-lockfile": { steps: "There is no lockfile, so builds are not reproducible and can pull new code. Commit the lockfile (package-lock.json, poetry.lock, composer.lock).", effort: "minutes" },

  // SBOM / licences
  "sbom:copyleft-strong": { steps: "Strong-copyleft (GPL/AGPL/SSPL) packages are in a closed product, which can force you to release your source. Replace them with permissive (MIT/Apache/BSD) packages, buy a commercial licence, or open-source that part.", effort: "days" },
  "sbom:copyleft-weak": { steps: "Weak-copyleft (LGPL/MPL/EUPL) packages have conditions. Confirm you meet them (dynamic linking, sharing changes to the library) and keep them as separate, unmodified components.", effort: "hours" },
  "sbom:no-licence": { steps: "Some packages state no licence (so they are 'all rights reserved' by default). Check each one's repository and prefer packages with a clear licence.", effort: "hours" },

  // Client tests / coverage
  "tests:failing": { steps: "The project's own tests do not pass. Fix the failing tests (or the code they test) before release.", effort: "hours" },
  "tests:low-coverage": { steps: "Test coverage is low, so most code could break unnoticed. Add tests, starting with the least-covered files.", effort: "days" },

  // Pairwise
  "pairwise:use-cases": { steps: "Run the computed pairwise cases (far fewer than every combination) to cover the risky value pairs, plus a few hand-picked known-risky combinations.", effort: "hours" },

  // API diff / lint
  "apidiff:endpoint-removed": { steps: "Removing an endpoint breaks callers. Version the API and keep the old endpoint until callers move.", effort: "hours" },
  "apidiff:new-required-field": { steps: "A new required request field breaks existing callers. Make it optional with a default, or add it in a new version.", effort: "hours" },
  "apidiff:new-required-param": { steps: "A new required parameter breaks callers. Make it optional, or version the API.", effort: "hours" },
  "apidiff:param-now-required": { steps: "Making a parameter required breaks callers that omit it. Keep it optional, or version the API.", effort: "hours" },
  "apidiff:param-removed": { steps: "Removing a parameter may break callers that send it. Ignore it for a deprecation window instead of removing it at once.", effort: "hours" },
  "apidiff:success-response-removed": { steps: "Removing a documented success response can break clients. Keep it until clients move, or version the API.", effort: "hours" },
  "apilint:no-operation-id": { steps: "Add an operationId to each operation so code generators and tests can name it.", effort: "minutes" },
  "apilint:no-summary": { steps: "Add a summary or description to each operation.", effort: "minutes" },
  "apilint:no-error-response": { steps: "Document the 4xx/5xx responses each operation can return.", effort: "minutes" },
  "apilint:no-security": { steps: "Add a security scheme to write endpoints so callers know authentication is required.", effort: "minutes" },
  "apilint:no-info-description": { steps: "Add a top-level description to the API spec.", effort: "minutes" },
  "apilint:no-servers": { steps: "List the servers (base URLs) in the spec so callers know where to call.", effort: "minutes" },

  // Payments
  "payments:live-key": { steps: "A live payment key was used for testing. Use the gateway's test/sandbox keys only, so no real money moves.", effort: "minutes" },

  // Email templates
  "email:no-tables": { steps: "Lay the email out with <table>; Outlook ignores float and flexbox.", effort: "hours" },
  "email:too-wide": { steps: "Keep the email body to about 600px so it is not cut off or shrunk.", effort: "hours" },
  "email:unsupported-css": { steps: "Remove position: absolute/fixed; most email clients drop it. Use tables and spacing.", effort: "hours" },
  "email:no-responsive": { steps: "Add a @media rule (or fluid tables) so the email reads well on phones.", effort: "hours" },
  "email:img-no-alt": { steps: "Add alt text to every image; clients block images by default.", effort: "minutes" },
  "email:image-only-risk": { steps: "Keep real text and background colours so the email still reads when images are blocked.", effort: "hours" },
  "email:no-dark-mode": { steps: "Add a color-scheme meta and test dark mode so logos and text stay readable.", effort: "hours" },
  "email:no-unsubscribe": { steps: "Add a clear unsubscribe link (required for bulk mail by CAN-SPAM, GDPR and Gmail/Yahoo rules).", effort: "minutes" },
  "email:http-link": { steps: "Use https:// links so clients and scanners trust them.", effort: "minutes" },
  "email:no-links": { steps: "Confirm the call-to-action link is present and correct.", effort: "minutes" },
  "email:spam-risk": { steps: "Reduce spam-trigger words and keep a good text-to-image ratio; send from an authenticated domain (SPF/DKIM/DMARC).", effort: "hours" },

  // Local SEO
  "seo:no-localbusiness-schema": { steps: "Add LocalBusiness JSON-LD (name, address, phone, hours, geo) so maps and local search show the business.", effort: "hours" },
  "seo:nap-phone-mismatch": { steps: "Use the same name, address and phone on every page and match your Google Business Profile.", effort: "minutes" },
  "seo:no-address": { steps: "Show the full address as text (not only an image) in the footer and in schema.", effort: "minutes" },
  "seo:no-map": { steps: "Add a map embed on the contact page.", effort: "minutes" },
  "seo:no-gbp-link": { steps: "Link to your Google Business Profile so visitors see reviews and directions.", effort: "minutes" },

  // hreflang
  "seo:hreflang-no-x-default": { steps: "Add an x-default hreflang pointing to the default/chooser page.", effort: "minutes" },
  "seo:hreflang-bad-lang": { steps: "Use valid ISO hreflang codes (en, en-in, hi).", effort: "minutes" },
  "seo:hreflang-duplicate": { steps: "Remove duplicate hreflang entries; each language should appear once.", effort: "minutes" },
  "seo:hreflang-no-return": { steps: "Each language version must link back to the others; add the return hreflang links or Google ignores them.", effort: "hours" },

  // Social preview
  "seo:no-og-title": { steps: "Add og:title (and the other Open Graph tags) for link previews.", effort: "minutes" },
  "seo:no-og-image": { steps: "Add an og:image (1200×630, absolute https URL) so shared links show a picture.", effort: "minutes" },
  "seo:og-image-relative": { steps: "Make og:image a full https:// URL; relative paths are not fetched.", effort: "minutes" },
  "seo:no-og-description": { steps: "Add og:description for the shared card summary.", effort: "minutes" },
  "seo:no-twitter-card": { steps: 'Add twitter:card="summary_large_image" and twitter:image.', effort: "minutes" },

  // JS SEO render diff
  "seo:content-needs-js": { steps: "Most content appears only after JavaScript runs. Render the main content on the server (SSR) or pre-render it so crawlers and link previews see it.", effort: "days" },
  "seo:links-need-js": { steps: "Internal links appear only after JavaScript. Put real <a href> links in the server HTML so crawlers can follow them.", effort: "hours" },

  // Accessibility (colour, AAA, app labels)
  "a11y:links-colour-only": { steps: "In-text links are shown by colour only. Underline them (or add another cue) so colour-blind users can see them (WCAG 1.4.1).", effort: "minutes" },
  "a11y:reading-level": { steps: "Shorten sentences and use common words to lower the reading level, and add a plain summary for complex pages (WCAG AAA 3.1.5).", effort: "hours" },
  "a11y:time-limit": { steps: "Remove the timed refresh/redirect, or let the user turn it off or extend it (WCAG 2.2.1).", effort: "minutes" },
  "a11y:inconsistent-help": { steps: "Put the help/contact link in the same place on every page (WCAG 2.2.6 Consistent Help).", effort: "hours" },
  "a11y:app-unlabelled-controls": { steps: "Add a contentDescription (or label/hint for inputs) to every control so TalkBack can announce it; set it to null for decorative images.", effort: "hours" },

  // Layout
  "layout:phone-side-scroll": { steps: "Something is wider than a phone screen. Use max-width: 100%, let tables scroll inside their box, and let rows wrap.", effort: "hours" },
  "layout:off-canvas": { steps: "Content sits off the side of the phone screen. Check absolute positioning and negative margins at small widths.", effort: "hours" },

  // Performance
  "perf:long-tasks": { steps: "Break long JavaScript tasks into smaller chunks, defer non-critical work, and use a web worker for heavy work (improves INP).", effort: "hours" },
  "perf:too-much-js": { steps: "Code-split by route, drop unused libraries, and load non-critical scripts lazily.", effort: "days" },
  "perf:huge-dom": { steps: "Virtualise long lists and tables so only what is on screen is in the DOM.", effort: "hours" },
  "perf:layout-shift": { steps: "Set width/height on images and reserve space for late content so nothing jumps (CLS).", effort: "hours" },
  "perf:slow-backend-call": { steps: "Profile the slow endpoint on the server, add indexes for its queries, cache what rarely changes, and return less per call.", effort: "hours" },
  "perf:n-plus-one": { steps: "An endpoint is called many times (N+1). Add a bulk/batch endpoint, or include related data in one response.", effort: "hours" },

  // Region speed
  "region:slow-far-away": { steps: "The site is much slower far from the server. Put static files and pages on a CDN with edge locations near your visitors, and cache HTML at the edge where you can.", effort: "days" },
  "region:no-regions": { steps: "This is informational: set up region proxies (REGION_<name>_PROXY in .env) to measure real-world speed from your visitors' regions.", effort: "minutes" },

  // Mobile OTA / perf / deep links
  "mobile:codepush-unsigned": { steps: "Turn on CodePush code signing and ship the public key in the app, so only your signed updates run.", effort: "hours" },
  "mobile:expo-updates-unsigned": { steps: "Set up expo-updates code signing (expo-updates configure-code-signing) and pin the channel.", effort: "hours" },
  "mobile:ota-http": { steps: "Serve OTA updates over https only, and add code signing.", effort: "minutes" },
  "appperf:slow-start": { steps: "Defer heavy work off the main thread at launch, use App Startup/lazy init, and show content sooner.", effort: "hours" },
  "appperf:jank": { steps: "Move work off the UI thread, simplify heavy layouts, and avoid large images in lists to stop stutter.", effort: "hours" },
  "appperf:memory": { steps: "Recycle bitmaps, free caches on onTrimMemory, and fix leaks to lower memory use.", effort: "hours" },
  "appperf:size": { steps: "Ship an app bundle (per-device split), compress assets, and remove unused libraries to shrink the app.", effort: "hours" },
  "deeplink:not-verified": { steps: "Verify your App Links (autoVerify plus a matching /.well-known/assetlinks.json) so Android opens them straight in your app and no other app can claim them.", effort: "hours" },
  "deeplink:dead": { steps: "Register the scheme/host in an intent filter and make sure the target screen exists so the deep link opens something.", effort: "hours" },
  "maestro:flow-failed": { steps: "A user journey failed on the phone. Fix the broken step, or update the Maestro flow if the screen changed.", effort: "hours" },

  // In-app browsers
  "inapp:blank": { steps: "The page is blank in an in-app/older browser. Compile JavaScript for those engines (a browserslist that includes Samsung and older webviews) and provide a working fallback.", effort: "hours" },
  "inapp:blocks-webview": { steps: "Do not block the in-app webview; support it, since many visitors arrive from WhatsApp/Instagram links.", effort: "hours" },
  "inapp:js-error": { steps: "Compile and polyfill JavaScript for in-app and older browsers.", effort: "hours" },
  "inapp:popup-login": { steps: "Use a full-page redirect login (OAuth redirect, not a pop-up) so it works inside in-app webviews that block pop-ups.", effort: "hours" },

  // Compliance (consent, PCI)
  "privacy:tracker-before-consent": { steps: "Block analytics/ad tags until the visitor accepts (Google Consent Mode, or load tags after consent). GDPR/DPDP require consent first.", effort: "hours" },
  "privacy:reject-not-honoured": { steps: "Make 'Reject' actually stop all non-essential tags; a reject that still tracks is a direct GDPR/DPDP breach.", effort: "hours" },
  "privacy:no-reject-button": { steps: "Add a 'Reject all' / 'Only necessary' button as easy to use as 'Accept' (GDPR).", effort: "minutes" },
  "pci:script-no-integrity": { steps: "Add Subresource Integrity and pin versions for third-party scripts on payment pages, keep a reviewed inventory, and alert on changes (PCI DSS 4.0 6.4.3, 11.6.1).", effort: "hours" },
  "pci:inline-script-payment": { steps: "Add a Content-Security-Policy (script-src with a nonce) on payment pages and move inline scripts to pinned files.", effort: "hours" },
};

const PATTERN: { test: RegExp; fix: Fix }[] = [
  { test: /^cloud:/, fix: { steps: "Fix this cloud setting as Prowler's report describes: close public access, restrict the security group to known IPs, turn on MFA and logging, encrypt storage, and rotate or remove old keys.", effort: "hours" } },
  { test: /^netscan:/, fix: { steps: "A network service on the server has a known vulnerability. Update the service to a patched version, or close the port if it should not be open to the internet.", effort: "hours" } },
  { test: /^sast:/, fix: { steps: "Fix the flagged code pattern: validate and escape input, use parameterised queries, avoid eval/exec on input, and follow the language's secure-coding guidance for this rule.", effort: "hours" } },
];

/** A fix for a wave-2 rule matched by its prefix, when there is no exact entry. Pure, for tests. */
export function p2PatternFix(rule: string): Fix | undefined {
  return PATTERN.find((p) => p.test.test(rule))?.fix;
}
