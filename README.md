# GLV Testing Agent

An AI testing platform by GLV Infotech Solutions. Pick what you are testing (website, online store, web app, SaaS, CRM, API, source code, Android app or iOS app), give it the address or upload the file, and a team of specialist agents checks it the way a QA engineer would and writes a report: major issues first, each with a fix you can paste. Every problem becomes a tracked issue (like Jira) that re-tests verify as fixed, or reopen when it comes back.

This follows the [architecture plan](https://claude.ai/artifact/PWZA5PZ8vKN8MpmfSUXJmE). Five engines are built: the browser engine (websites and web apps), the API engine, the source code engine, the Android engine and the iOS engine. A helper on a Mac with Xcode adds what a Linux server cannot do: real Safari on Mac, iPhone and iPad, VoiceOver, and running iOS apps in the Simulator with Apple's accessibility audit (see [Mac helper](#mac-helper-safari-voiceover-ios-simulator)).

## The dashboard

- **Simple and Full view** (switch at the bottom of the menu, remembered in that browser): **Simple** is the default. The new-test form asks only for the address or file, a name and the sign-in, and says in one line what runs; project pages and reports show the main tabs (Fix first, issues, pages, journeys, signed-in app). **Full** shows every agent, tool, setting, tab and master control. Both start the same safe test; nothing about the safety rules changes.
- **Manual tests** (menu item, and **Test by hand** on a project): checklists a person works through by hand. Each project gets ready-made cases for its type (about 80 written cases: first look, forms, sign-in, checkout, roles, records, layout, accessibility, security, API, code, phone app), cases from the project itself (each journey, app journey, API scenario, the saved sign-in and each role), and one case for every testing type of the handbook that applies. **Every case is on by default**; turn single cases, a whole group, or all of them off and on under **Cases**, and add your own. A **round** is one pass through the checklist for one build: press **Pass**, **Fail** or **Skip** on each case, add a note, attach or paste (Ctrl+V) screenshots, send a failure to the issue board, then **Finish the round** to lock it. **Re-check** starts a round with only the failed and unfinished cases of the last one. Each case shows its results in the last rounds. Download a round as CSV (opens in Excel) or Markdown. Issues found by hand are only closed by a person, never by an automatic re-test.
- **New test**: pick the product type first, then enter its details: a web address; an OpenAPI file address or upload for an API; a Git repository or a zip for source code; an APK upload for an Android app; an IPA (or a zip of the .app) for an iOS app.
- **Live view**: while a website test runs, its report page shows the test browser's screens live, side by side, next to what each agent is doing on each screen. Show 1 to 4 screens, pick a shape (side by side, stacked, one big, grid), drag the lines between them to resize, drag a screen's grip onto another to swap them, make one big, or change which screen each place shows. The layout is remembered in that browser. Pictures are only sent while someone watches, so a test nobody watches runs at full speed, and nothing is recorded.
- **Code panel beside the live screens** (optional, **Show code** / **Hide code**): for the screen you pick (or the busy one), five tabs: **Test code** (each step the test takes on the page as Playwright code, with time and result; **Copy as script** / **Download script** gives a script that opens and pictures the page the same way), **Checks found** (each problem the moment a check finds it, with the code that failed and the fix code), **Network** (every request: method, status, type, size, time; failed only), **Console** (everything the page prints, errors first in colour) and **Page code** (the page's HTML as the browser has it now, coloured, with find, copy and download). Lines are sent only while the panel is open. No headers or cookies are shown; passwords and tokens in addresses, and password, hidden-field and CSRF values in the HTML, are hidden. API, code and app tests have a **Show code** button too, under the progress: **API calls** (each call as a cURL command you can paste into a terminal, with tokens, keys and passwords shown as •••) and **Checks found**.
- **Report**: score per category, then the major issues (critical and high) as cards with a fix suggestion and ready-to-paste code for Apache/LiteSpeed (Hostinger), Nginx, WordPress or PHP. Everything else is in a filterable list. The Agents tab shows what each agent found and how long it took; the Tools tab shows each outside tool's scores, findings and its own report to open.
- **Projects**: each site, API, codebase or app you test, with its score trend, open issues, test history and an automatic re-test schedule (daily or weekly). For an app, upload the next build on the project page and press Re-test to see what was fixed and what came back.
- **Issues**: a board (Open, In progress, Fixed, Verified) across projects. Keys look like `GLV-12`. Mark an issue fixed, press Re-test, and the next run either verifies it or moves it back to Open as "Came back". Assign issues and add notes; everything is kept in the history.
- **Logins**: tick "Sign in first" (websites and apps), "The API needs a key or token" or "The repository is private" on the new-test form, or use the Login card on the project page. See [Logged-in testing](#logged-in-testing-and-the-login-vault).
- **Tool tabs**: after you pick the product type, the new-test page shows a row of tabs: **GLV checks** (the platform's own agents) first, then one tab per outside tool that fits that type (Lighthouse, W3C HTML checker, OWASP ZAP, Nuclei, testssl.sh). Each tab says what the tool checks, whether it is safe, how long it takes, and has a switch and options. The project page has the same tabs to change the tools for later tests. See [Outside tools](#outside-tools-tool-tabs).
- **Owner panel**: overview numbers, switch any agent on or off, add team members, pair Macs for the Mac helper and see what each can test, set the default page count, how many pages are tested at the same time, and the Claude summary, and see the login vault's status.

With login on, the first time the dashboard opens it asks you to create the owner account. Do that straight after the first start, before anyone else can reach the server. While GLV is still building the system, Docker starts with login off (see [Login switch](#login-switch-auth_disabled)).

## Specialist agents

| Agent | What it checks |
| --- | --- |
| JavaScript errors | Crashes, scripts blocked by a wrong integrity hash, CSP blocks, console errors (your own code apart from third-party widgets) |
| Missing files | Images, scripts, styles and fonts that fail to load |
| Link checker | Every link; only reported after a second look a few seconds later |
| Content mistakes | Lorem ipsum, unfilled `{{tags}}`, "undefined" / "NaN" on the page, old copyright year (text inside code examples is skipped) |
| Forms | Passwords on pages without HTTPS, data sent over HTTP, fields that would not be submitted, email field type |
| Accessibility (WCAG 2.2) | axe-core rules for WCAG 2.0 to 2.2, A and AA |
| On-page SEO | Title, description, headings, canonical, viewport, noindex, Open Graph |
| Structured data | JSON-LD syntax errors; Product data on store product pages |
| Duplicate titles | Pages sharing a title or description (pages that name the same canonical address count as one) |
| Search engine access | robots.txt blocking Google, missing sitemap, sitemap on the wrong address or listing missing pages |
| Missing page handling | Unknown addresses must answer 404 (no soft 404) |
| Security headers and cookies | HTTPS, HSTS, CSP, clickjacking, nosniff, referrer, version disclosure, cookie flags |
| HTTPS and certificate | http:// redirects to https://, certificate trusted, complete chain, not about to expire |
| Mixed content | HTTP files on HTTPS pages |
| Exposed files | .env, .git, config backups, phpinfo, debug logs, folder listings (confirmed by content, secrets masked) |
| WordPress security | Public user list, XML-RPC, visible version |
| Privacy and cookie consent | Trackers loaded without a consent banner (GDPR, India's DPDP Act) |
| Speed (Core Web Vitals) | LCP, CLS, server response time, page weight |
| Phone layout | Sideways scrolling, tap targets (WCAG 2.2), text too small |

**Deeper website checks.** Our own agents, built in: none of them calls an outside service.

| Agent | What it checks |
| --- | --- |
| Keyboard use | Presses Tab through the page: focus stuck in one place, focus that cannot be seen, focused items hidden behind sticky bars, tabindex above 0, clickable things the keyboard cannot reach |
| Zoom 200% and 400% | Sideways scrolling at 200% zoom (683 px) and 400% zoom (320 px), WCAG 1.4.4 and 1.4.10 |
| Text spacing | Widens line, letter and word spacing (WCAG 1.4.12) and finds text that gets cut off |
| Screen reader view | Saves what a screen reader announces on each page (open it from the Pages tab); skipped heading levels, no `<main>`, "Click here" links, same-named links to different pages |
| Motion and sound | Endless animations that ignore "reduce motion", video or audio that plays sound on its own |
| Reading comfort | Lines over 120 characters, justified text (WCAG 1.4.8) |
| Form field limits | Boundary and wrong values (an email without @, -1 as a quantity, letters as a phone number, a field's own min and max, broken patterns, fields marked * that are not required). Values are set and read back; nothing is typed or sent |
| Monkey testing | 40 random clicks and typing on 3 pages, the same each re-test, with every change blocked (only GET, no leaving the page): crashes, freezes and script errors |
| Screen sizes (device lab) | 11 more sizes from small Android phones and iPads to full HD; saves a picture of the first page at each size |
| Cross-browser lab | Up to 5 pages in Firefox and WebKit (Safari's engine) next to Chromium: script errors, failed files, missing parts and sideways scrolling that only one browser has, with screenshots from each |
| Same-page links, site search, missing-page screen | Links to `#sections` that do not exist; the site's search box with a real word and a made-up word; a 404 page with no way back |
| Overlapping text, cut-off labels | Text drawn over other text (desktop and phone), labels cut off by their own box on a phone |
| Bars and pop-ups covering the phone screen | Headers and footers that stay on screen and take over 30% of a phone, pop-ups that cover the page on arrival (cookie and age notices are allowed) |
| Images | Images sent much bigger than shown, stretched images, a main image held back by lazy loading, many images far down the page loaded at once, large JPEG/PNG/GIF files |
| Network inspector | Like the browser's Network tab, saved per page as JSON: files without compression or caching, files fetched twice or through a redirect, over 120 requests, weight from other companies' servers |
| Slow phone connection | The first page like a mid-range phone on slow 4G (Lighthouse's settings: 1.6 Mbit/s, 150 ms, 4x slower processor, nothing cached) |
| Site structure, thin pages, page addresses | Pages more than 3 clicks from home, internal links that redirect, pages under 150 words, session ids, capitals, underscores and very long addresses |
| Information leaks | HTML comments with passwords, keys, internal addresses or queries; error messages showing code or the database; public source maps of the site's own scripts |
| Outdated JavaScript libraries | jQuery, jQuery UI, Bootstrap, AngularJS, Lodash and Moment versions the page really runs, against GLV's own table of known CVEs |
| Subresource Integrity, sign-in forms | CDN files without an integrity check; passwords sent in the address or to another site, paste and autofill blocked |
| Page language, prices and dates, other language and time zone | The declared language against the real script (Hindi, Tamil, Arabic...), right-to-left text, garbled characters, UTF-8, hreflang codes; prices in two currencies, US dates on Indian sites; script errors and "Invalid Date" for a visitor set to Arabic in a time zone 14 hours ahead |
| Site icon and app install | Favicon, the web app manifest phones need to install the site, and offline start when there is a service worker |

A file that many pages load (a script, an image, a comment in the footer) is reported once, on the first page that loads it, instead of on every page. The agents that press keys, zoom or change settings run one at a time after the others on each page and put the page back as it was. The slow-connection agent runs alone at the end, so other work does not slow its numbers.

The crawler and the link checker never open log-out or delete links.

**Checks for one kind of product.** These run on top of the ones above, only for the product they are for:

| Agent | Products | What it checks |
| --- | --- | --- |
| Store policies | Online store | Links to a refund and return policy (High if missing), shipping, terms, privacy and contact pages, which shoppers, payment gateways and India's e-commerce rules expect |
| Product pages | Online store | A visible price, an Add to cart or Buy button, and price, currency and stock in the product data |
| Checkout safety | Online store | Scripts from other websites on cart and checkout pages (card skimming risk, PCI DSS 6.4.3), and a Content Security Policy there |
| Private pages need a login | Web app, SaaS, CRM | With a saved login: opens every signed-in page again with no login, and reports pages that still show the signed-in view (Critical when they show the user's own name or email) |
| Private pages not cached | Web app, SaaS, CRM | With a saved login: signed-in pages must send `Cache-Control: no-store` or `private` |
| Personal data in addresses | Web app, SaaS, CRM | E-mail addresses and phone numbers in page addresses (masked in the report) |
| SaaS trust pages | SaaS | Links to pricing, terms, privacy and a refund or cancellation policy |

A CRM gets no search engine (SEO) checks and no SEO score: only its sign-in page is public. Any test that runs signed in leaves the SEO checks out too, because private pages are not meant to be found on Google. The two login-only checks are listed as "Needs a saved login" when a project has none.

### API engine (REST and GraphQL)

What it reads: an OpenAPI 3 or Swagger 2 file (address or upload), or just the API's base address (it looks for the file at the usual places: `/openapi.json`, `/swagger.json`, `/v3/api-docs`, `/api-docs` and more), a Postman collection, a HAR recording from the browser, a text file of cURL commands, or a GraphQL endpoint. Postman, HAR and cURL are turned into an API file, with ids in addresses made into `{id}` templates.

Logins: bearer token, a key in a header or the address, basic, **OAuth2 client credentials** (it fetches the token from the token address, with a scope) or **a login call** (POST user name and password to the API's login address and read the token from the answer, like `$.data.token`). A fetched token is renewed once if the API answers 401 halfway. Tokens never show in the report.

How it calls: endpoints are called in waves, lists first, so detail endpoints get **real ids** from the lists (`GET /users/{id}` uses the first id that `GET /users` gave; the report says where the id came from). Each endpoint is timed `API_SAMPLES` times (default 5): the report shows the median and the 95% time, so one slow call is not a slow endpoint. On a live API only GET is sent. Tick **This API is a test server** (new-test form or the project's API setup tab) to let the test add, change and delete its own records, which it always removes after.

| Agent | What it checks |
| --- | --- |
| Endpoint health | Server errors, no answer, documented endpoints that are missing (404), slow endpoints (median time) |
| Response format | Broken JSON, wrong content type, answers that break the schema (types, formats like email and date, min and max, lengths, patterns, list sizes, extra fields where the file forbids them), fields the file does not list, documented headers that are missing, deprecated endpoints with no Deprecation or Sunset header |
| Login protection | Endpoints marked as needing a login that answer without one; login errors sent as 200; no login described at all |
| Data exposure | Password hashes, tokens and keys in answers; lists of personal e-mail addresses readable without a login |
| Error handling | Stack traces, SQL errors and debug pages, including for a missing address and a wrong-type id |
| HTTPS, CORS and headers | Plain HTTP, CORS that lets any website call the API as the logged-in user, HSTS, nosniff, version disclosure |
| API file quality | No servers, duplicate operationIds, operations without documented answers |
| API file audit | 26 rules like 42Crunch and Spectral (security schemes, plain-http servers, keys in the address, no 401 or 429 answers, strings with no length limit, lists with no limit, missing descriptions and examples...), with a score out of 100 |
| OWASP API Top 10 | No rate limit (a burst of 20 calls, never on a health check), lists with no page limit, debug and admin endpoints left open (actuator, /debug, phpinfo...), old API versions still answering, address parameters that take a URL (SSRF candidates), TRACE switched on |
| Login tokens (JWT) | Not signed, no end time, a life over 30 days, secrets inside the token, signed with a well-known key (`secret`, `changeme`... checked on this server, nothing is sent), and whether the API accepts a token with its signature changed or with `alg: none` |
| Breaking changes | Compares the API file with the approved copy: removed endpoints, fields, answers and parameters, new required fields, changed types. The first test's file is approved by itself; press **Approve as the new version** in the report to accept a change |
| Who can read what | With other accounts on the project (roles, another company): every endpoint is called as each one. Another company getting the same record (BOLA, broken object level authorization), an account opening what it must not (BFLA, like `/admin*` for staff), and data with no login. Shown as a grid in the report |
| Scenarios | The team's own tests in plain words, one step a line (see below) |
| Test-server writes | Only on a test server: wrong and empty input (should be 400 or 422, not 500 or 201), create without a login, create with fields a user must not set (`role`, `isAdmin`, `balance`...: mass assignment) and with read-only fields, read back, change, delete, read after delete, then clean-up. Anything left over is listed |
| GraphQL | Introspection open, field suggestions, no depth limit (a depth-10 query), no alias limit (50 aliases), batching, queries over GET (CSRF), errors that leak, and every read-only query run with made-up arguments, with and without the login. Mutations are never sent, even on a test server |

**Scenarios** (project page > API setup) look like this:

```
GET /orders
expect status 200
expect time < 800
save id = $.data[0].id
GET /orders/{{id}}
expect $.total > 0
expect schema
```

Other steps: `header Name: value`, `body {...}`, `as Role name` (or `as nobody`), `set name = value`, `wait 500`, `expect header Content-Type contains json`, and clean-up steps that always run at the end. POST, PUT, PATCH and DELETE steps run only on a test server.

**In the report**, the API tab shows every call with its request and answer (headers and body, login hidden), **Copy as cURL**, what was not called and why, the scenarios step by step, the changes since the approved file, the who-can-read-what grid and the write tests. **Download collection** gives a Postman collection of the tested calls with a status test each; the token is a `{{token}}` variable.

**Mock server** (project page > API setup): a secret address on this server (`/mock/<token>/...`) that answers like the API from its file, with the file's examples or made-up data that fits the schema. It checks requests (required query parameters, the body against its schema) and answers 400 with the reasons, keeps the last 50 calls, and lets front ends on any address call it. **New address** stops the old one.

**API watch** (project page): checks an endpoint every few minutes with the saved login (uptime, answer time, SSL, words the answer must hold), and can also run the read-only scenarios every 15 to 60 minutes.

### SOAP, gRPC, WebSocket and contract tests

Pick the kind on the new API test form.

- **SOAP**: reads the WSDL, builds a request for each operation from its schema and calls the operations whose names say they only read (GetOrder, ListCustomers...). Operations that change data are listed but called only on a test server. Reports plain http, faults with stack traces, faults sent with HTTP 200, slow operations and leaks.
- **gRPC**: the methods come from an uploaded `.proto` file or the server's reflection service. Methods whose names say they only read are called with example values; methods that change data are never called on a live server. Reports no TLS, reflection open to anyone, methods that answer without the login, errors that show the server's insides, the health service and slow methods.
- **WebSocket**: our own small client connects with the saved login, sends the messages the project lists and checks the answers, then tries without a login, from another website (Origin) and with plain `ws://`.
- **Contract tests (Pact)**: upload a Pact file (version 2, 3 or 4) that a website or app wrote. Each of its requests is sent to the API and the answer must keep the contract (status, headers, body, with Pact's matching rules). Requests that change data are sent only to a test server.

### Source code engine (offline)

Give it a Git repository (https; private ones need an access token in the project's login) or upload a zip. The code is read on the server and deleted after the test; installed packages and build output are skipped.

| Agent | What it checks |
| --- | --- |
| Leaked secrets | AWS, GitHub, Stripe, Slack, SendGrid, Twilio, Google, Anthropic and OpenAI keys, private keys, database addresses with passwords, hard-coded passwords, session and signing secrets (`cookieSecret`, `jwtSecret`, express-session's `secret: "keyboard cat"`), committed .env files, database dumps, key stores. Values are masked in the report |
| Vulnerable packages | Reads npm, Yarn, pnpm, Composer, pip, Pipfile, Poetry, Bundler and Go lockfiles and looks up every package in the free [OSV database](https://osv.dev), with the version that fixes it |
| Risky code | Request input that reaches eval, a shell, SQL, a MongoDB filter or `$where` (NoSQL injection), an outgoing request (SSRF), a redirect (open redirect) or a deep merge (prototype pollution); file inclusion, unsafe unserialize, XSS, hard-coded encryption keys, MD5/SHA-1 passwords, turned-off HTTPS checks, debug mode, merge conflict markers (PHP, JavaScript/TypeScript, Python, Java, Kotlin) |
| Project health | Broken JSON, no README, no .gitignore, committed node_modules, no tests, leftover debug output |

The risky-code agent follows request input (`req.body`, `req.query`, `$_GET`, `request.args` and similar) through variables in the same file, so `const url = req.query.url; needle.get(url)` is reported and the same call on a fixed address is not. When input reaches eval, a shell or SQL, the issue is Critical. It does not follow values into other files, and the other rules read one line at a time, so treat findings as leads to confirm. Text that only mentions a risky call (a string, a regex or a comment) is not counted. Mark a reviewed line safe with a `glvtest-ignore` comment on it or on the line above.

### Android engine (APK)

The APK is unpacked and read on the server; it is never installed or run.

| Agent | What it checks |
| --- | --- |
| App settings | Debug builds, test-only builds, USB backups, plain HTTP (manifest and network security config), trusting user-installed certificates, target API below what Google Play accepts, very old minimum API |
| Permissions | SMS and call log permissions Play restricts, permissions that need a Play declaration, sensitive permissions to double-check |
| Exposed components | Content providers, services, receivers and inner screens any other app can open (the app's own classes only) |
| Signing | Unsigned, signed with the Android debug key, v1-only signatures (Janus) |
| Hard-coded secrets and servers | Keys in the code, React Native bundle and Flutter library; the app's own servers called over plain HTTP |
| Firebase database | A Realtime Database that anyone can read |
| Native libraries | Missing 64-bit code, libraries not ready for 16 KB memory pages |

App bundles (.aab) and split sets (.apks from bundletool, .xapk from app stores) are read too: a bundle's manifest is in aapt2's protocol-buffer format, and its base module is checked the way Google Play will build it into APKs; for a split set, the base APK is checked with the native libraries of its processor splits added.

| Agent | What it checks |
| --- | --- |
| Code | WebViews with JavaScript bridges, file access or ignored certificate errors, trust-all certificates and hostnames, weak ciphers, code loaded at run time, files on shared storage, a FileProvider sharing the whole storage, release builds that were not shrunk |
| SDKs and trackers | About 50 known SDKs (analytics, ads, crash reporting, payments, push) from their package names, the advertising ID permission missing or unused |
| Framework | Flutter, React Native, Cordova, Capacitor, .NET MAUI and Unity: debug builds, the development bundle, Capacitor pointed at a dev server, source maps left in |
| Libraries and SBOM | Library versions (OkHttp, Retrofit, AndroidX and the Maven files in the APK), written to `app-sbom.cdx.json` (CycloneDX) |
| Size | A large download, big pictures that could be WebP, the same file twice |
| App links | Links set to open in the app (autoVerify): the site's `/.well-known/assetlinks.json` must name this app and its signing key's SHA-256 |
| Servers | The app's own test servers, private addresses and servers with a broken certificate |
| Languages | Translations missing strings (counted from resources.arsc), so screens fall back to English |
| Play Store | No icon, no app name, components without android:exported for API 31 or newer |

Every app test also keeps a summary (version, SDKs, permissions, servers, libraries), and the next test of the same project lists what changed: new permissions, new trackers, new servers, a bigger download.

### iOS engine (IPA)

The IPA (or a zip of the .app, such as a Simulator build) is unpacked and read on the server; it is never installed or run, and no Mac is needed. It reads Info.plist in either format (XML or binary), the program's headers (Mach-O, including fat files with several processors), the embedded provisioning profile and the privacy manifests. An IPA downloaded from the App Store has its code encrypted: the settings are still checked, and the report lists the checks that could not read the code, so export the IPA from Xcode's Organizer (Development or Ad Hoc) for a full test.

| Agent | What it checks |
| --- | --- |
| App settings | App Transport Security switched off, or allowed over plain HTTP or old TLS for some servers (following iOS's rule that some settings make it ignore NSAllowsArbitraryLoads); Documents folder shown in Files; custom URL schemes other apps can open; the export compliance answer (ITSAppUsesNonExemptEncryption) |
| Permissions and purpose texts | Code that asks for the camera, location, contacts, tracking and more without the Info.plist purpose text (iOS closes the app; App Store Connect rejects it with ITMS-90683); purpose texts that do not say why |
| Privacy manifest | Apple's "required reason" APIs used with no PrivacyInfo.xcprivacy, or without a reason for each one (ITMS-91053); SDKs from Apple's list without their own manifest; tracking without tracking domains |
| App binary | No 64-bit (arm64) code, not built as PIE, unsigned, UIWebView still in the app or its frameworks (ITMS-90809) |
| Hard-coded secrets and servers | Keys in the program, its config files, the React Native bundle and Flutter's App.framework; the app's own servers called over plain HTTP |
| Firebase database | A Realtime Database that anyone can read |
| Signing and provisioning | Debug builds (get-task-allow), expired or soon-expiring profiles, Enterprise distribution, push notifications set to the sandbox server |

The iOS engine has the same SDK, framework, library, size, server and language checks, plus code checks (keychain items readable while the phone is locked, trust-all certificates, WebViews with file access, no stack canary or ARC), universal links (the site's `apple-app-site-association` must name this app's Team ID and bundle ID) and App Store checks (icon, launch screen, build number, 32-bit code).

### Test phones (Appium)

The "Run on a test phone (Appium)" tool tab installs the app on a phone, emulator or Simulator and uses it the way a person would. Appium (open source, Apache-2.0) is in the Docker image; GLV's own explorer drives it. It is never on by default: turn it on in a project's What runs tab.

- It opens every screen it can reach (up to 10, 20 or 40) and taps buttons, but never ones like Buy, Pay, Delete, Send or Log out. With a saved app login (Login tab), it signs in first.
- It reports crashes and "not responding" with the stack trace and the step that caused it, and checks each screen for TalkBack and VoiceOver labels, tap targets under 48 dp (44 pt on iOS), fields without a label, cut-off text, overlaps and low text contrast measured on the screenshot.
- Then it tries the phone sideways, dark mode, the largest text, a tablet screen, no internet and the Back button, measures cold start time, memory and slow frames, and taps at random for a while (the same taps each test, so results repeat).
- On Android, the phone's traffic goes through GLV's own recorder: plain-HTTP calls (and any password or token in them) and trackers that start before the user agrees are reported. HTTPS is not decrypted. The recorder accepts only phones on the server's own networks.
- App journeys (project page > App journeys) are steps in plain words, like `tap "Cart"` and `see "Total"`, run on every test.

Where the phone comes from (Owner panel > Test phones):

- **Built-in Android emulator:** `docker compose --profile android up -d`, then add `ANDROID_DEVICE=android:5555` and `APP_SERVER_ADDRESS=http://testing-agent:4000` to `.env` and run `docker compose up -d` again. It needs hardware virtualisation (`/dev/kvm`): a Linux server, or WSL 2 on Windows with virtualisation on in the BIOS. Watch its screen at http://localhost:6080.
- **A real Android phone:** on a laptop with the phone plugged in (USB debugging on), run `npx appium@3.9.1 driver install uiautomator2` once, then `npx appium@3.9.1 --address 0.0.0.0 --allow-insecure=*:adb_shell`, and add it with the laptop's address.
- **iPhone Simulator or a real iPhone:** on the Mac with Xcode, `npx appium@3.9.1 driver install xcuitest` once, then `npx appium@3.9.1 --address 0.0.0.0`. A real iPhone needs a Development build signed for it. Appium on another machine downloads the app from this server, so set "This server's address" for the device.

Without `--allow-insecure=*:adb_shell`, crashes, screens, labels and touch checks still run; speed, dark mode, large text, tablet, offline and traffic checks are skipped and the report says so.

Symbols are matched as whole names in the program's symbol and selector tables, so `_status` is not read as the file-date function `_stat`. App extensions (widgets, share extensions) are listed in the report but their own settings are not tested yet.

## Outside tools (tool tabs)

Well-known testing tools run in the same test as the platform's agents. Their findings join the same report, score and Issues board, so a test with five tools still gives one report. The comparison of about 40 tools, and the plan for the next ones, is in [Testing tools for the GLV platform](https://claude.ai/artifact/AUtm8C8zmdxb4qFxnTTYGD).

| Tab | For | What it adds | Signed in |
| --- | --- | --- | --- |
| Lighthouse (Google) | Website, store, web app, SaaS, CRM | The Performance, Accessibility, Best practices and SEO scores clients see in PageSpeed Insights; Core Web Vitals on a slow phone or desktop; what slows the page most, with the time each fix saves | Yes |
| W3C HTML checker | Website, store, web app, SaaS, CRM | HTML that breaks the standard (elements in the wrong place, duplicate ids, bad attributes), on up to 20 pages | Yes |
| OWASP ZAP (passive) | Web types and API | Over 60 passive security rules: headers, cookies, information leaks, unsafe forms | Yes |
| Nuclei | Web types and API | Thousands of community checks: known CVEs, exposed files and panels, wrong server and DNS settings | No |
| TLS check (testssl.sh) | Web types and API | TLS versions, weak ciphers, the certificate, and known TLS attacks, with a grade | No |
| GLV attack probes | Web types and API | **Client's permission.** GLV's own XSS, SQL injection, open redirect and path traversal probes on up to 60 address parameters, GET form fields and link parameters the test found. Each hole is confirmed before it is reported (script that really runs in a browser, an SQL error that the escaped value clears, or true and false conditions that change the page twice) | Yes |
| OWASP ZAP (active) | Web types and API | **Client's permission.** ZAP's active scan rules on the pages the test opened, GET only, at the chosen strength | Yes |
| k6 load test | Web types and API | **Client's permission.** Many users at once on the pages the test found: load, stress (finds the breaking point), spike or soak, with the response times and errors for each step | Yes |
| JMeter test plan | Web types and API | **Client's permission.** Runs the team's own JMeter plan (`.jmx`, uploaded in the tab) after checking every part of it, and reads the results the same way as k6 | No |
| Schemathesis | API | Tens of generated calls per GET endpoint from the OpenAPI file: server errors, answers that break the schema, wrong status codes and content types, endpoints that work without a valid login. Each problem comes with the request that shows it | Yes (API login) |
| Newman (Postman) | API | Runs the team's own Postman collection (uploaded in the tab) and reports every test that fails. Only its GET requests are sent | Yes (API login) |
| Gitleaks | Source code | More than 150 kinds of keys and tokens in the code, and optionally in the whole Git history (a deleted key is still in old commits) | Git token, for the history |
| Opengrep, with GLV's own rules | Source code | Follows request data through the code to SQL, shell commands, file paths, redirects and HTML: 40 rules for JavaScript/TypeScript, Python, PHP, Java, Go and C# | No |
| OSV-Scanner (Google) | Source code | Every package in the lockfiles against Google's OSV database: npm, pnpm, yarn, pip, Poetry, Composer, Go, Cargo, Maven, Gradle, NuGet, Pub, Gems; malware packages too | No |
| Real Safari (Mac helper) | Website, store, web app, SaaS, CRM | Each page in real Safari on a Mac, and in Safari on iPhone and iPad in the iOS Simulator, next to Chromium at the same size and user agent: pages that do not open, scroll sideways, lose parts (a script that stops only in Safari) or cannot show images, only in Safari. A screenshot from each device | No |
| VoiceOver (Mac helper) | Website, store, web app, SaaS, CRM | VoiceOver reads each page item by item the way a blind visitor hears it, saved as a transcript: images, buttons, links and fields it cannot name, file names read aloud, links that all sound the same, pages with no headings | No |
| iOS Simulator (Mac helper) | iOS app | Installs the app in the iOS Simulator (or a Development or Ad Hoc build on a connected test iPhone), opens it and watches for crashes, with the crash report's reason and code; Apple's accessibility audit (as in Xcode) on the first screen and each tab; screenshots in light, dark and the largest text size | No |
| Trivy (Aqua Security) | Source code | A second package database, plus unsafe Dockerfile, Kubernetes, Helm, Terraform and Compose settings, and package licences (AGPL, GPL) that may not allow closed-source client delivery | No |

How they are kept safe and accurate:

- **Safe tools only for now.** ZAP only looks at the pages the test already opened (GET requests): no spider, no form posts, no active scan. Nuclei leaves out every check tagged as an attack, flood, password guess or call to an outside service, and every check that sends POST, PUT, PATCH or DELETE. Schemathesis tests GET operations only, and its coverage phase is told not to try other methods (by default it sends POST, PUT and DELETE to every path to see they are refused). Newman runs only the GET and HEAD requests of a collection, leaves out scripts that send requests of their own (`pm.sendRequest`), refuses addresses on the server's own network, and cannot read files outside its work folder. Tests in `tools.test.ts` and `tools-code-api.test.ts` count the requests and check nothing but GET reaches the site or API. Tools that load or attack a site run only with the client's written permission (next section).
- **Code is never run.** The code tools only read files. OSV-Scanner's call analysis (which builds the code, and runs Rust build scripts) is switched off. Gitleaks uses its own rules, not a `.gitleaks.toml` in the project, so a project cannot switch its own checks off. The Git history is fetched with the same rules as the clone: https only, never this server's own Git logins.
- **One problem is shown once.** When a tool finds what a platform check already found (a missing header, a slow LCP, the public .env file, a leaked key in the same file, a crash on the same endpoint), the tool's copy is folded into the platform's finding ("Also found by OWASP ZAP") instead of counting twice. Two tools that find the same vulnerable package (Trivy and OSV-Scanner) give one finding too.
- **Never counted as passed.** A tool that is switched on but cannot run (not installed, timed out, its checks not downloaded) makes the test "incomplete" and says why, and its issues stay open until it runs again.
- **Logins stay hidden.** With a saved web login, Lighthouse, the HTML checker and ZAP test the signed-in pages with the same session. The session cookie is passed in a file, not on the command line, and is replaced with `[hidden]` in every finding and in each tool's own report (Lighthouse copies request headers into its report). Each tool's HTML report opens in a browser sandbox, so it cannot read the dashboard's data.
- **Speed findings settle over two runs.** Lighthouse's speed findings follow the same two-run rule as the platform's own (below).
- **Time limits.** Each tool runs as its own process group with a time limit, and Cancel test stops it at once.

Tests started without a tool choice (the API, a quick test, projects made before the tabs existed) run every safe tool that is installed on the server. Set `DEFAULT_TOOLS=none` to run only the platform's own checks unless tools are chosen.

**Why GLV's own Opengrep rules.** The free rule packs (Semgrep's registry rules, and the opengrep-rules fork of them) are under licences that do not allow selling a service built on them: the Opengrep rules repository carries the Commons Clause and says it is for "research, testing & benchmarking". GLV sells testing to clients, so the platform ships its own rules in `rules/opengrep/`, written for it, with examples in `test/opengrep/` that each rule must find (`ruleid:`) and must not find (`ok:`). `opengrep scan --test` checks them all; the tests run it when Opengrep (or Semgrep CE, through `OPENGREP_PATH`) is installed. A project's own rules can be added in a later phase.

**Installing the tools.** The Docker image includes Lighthouse, Java for the W3C HTML checker, testssl.sh, Schemathesis 4.32.7 (in its own Python folder) and Newman 6.2.3 (in its own Node folder, so its old dependencies never load into the app). Nuclei 3.11.1, Gitleaks 8.30.1, OSV-Scanner 2.7.0 and Trivy 0.76.1 are built from source at those versions; Go checks every module against its public checksum database, which is how Trivy is installed safely after its release binaries were hijacked in March 2026 (v0.69.4 and the Docker tags 0.69.5 and 0.69.6). k6 1.8.2 is built from source the same way. Opengrep 1.30.0's release binary is downloaded and its signature checked with cosign; if it cannot be verified it is left out. Apache JMeter 5.6.3 is downloaded from the Apache archive and checked against its published SHA-512. `docker compose` starts OWASP ZAP 2.17.0 in its own container that only the app can reach; it runs an active scan only for a project with the client's permission. Trivy downloads its vulnerability database on its first run and keeps it in the data volume (`trivy-cache`, about 2 GB unpacked), updating it at most once a day. Without Docker, `npm install` brings Lighthouse and the HTML checker (it needs Java); install the others yourself, run ZAP in daemon mode and set `ZAP_URL` and `ZAP_API_KEY`. The tabs show any tool that is missing as "Not available on this server", with the reason. On a server, set your own random `ZAP_API_KEY` in `.env`.

**SARIF and JUnit.** Every finished test can be downloaded from its report (Download): SARIF for GitHub code scanning, GitLab, Azure DevOps and security dashboards (code findings point at the file and line), and JUnit XML for CI test reports (a failed test per issue, a skipped test for a check that could not run). The command line writes both next to `report.json`. Schemathesis and Newman also attach their own JUnit files.

## Optional modules (inspect screen, visual compare, journeys, app explorer, webhooks, test mailbox, load charts, own tests)

Owner panel > **Modules** switches these on and off. All run on our server; nothing goes to an outside service.

- **Inspect screen** (on by default): Report > Pages > **Inspect page** opens a developer-tools view of the page, like Playwright's trace viewer: Steps (timeline of what the test did), Network (waterfall with timing and headers, filter by type), Console (logs, warnings, errors), Elements (the page's HTML, as source or a script-free snapshot), Tab order and outline (keyboard order, headings and landmarks drawn over the picture), Unused code (JavaScript and CSS coverage). **Download HAR** opens in Chrome or any HAR viewer. Cookies and login headers are always hidden.
- **Visual compare** (on by default): each project keeps an approved picture of every page (desktop and phone) in `data/baselines/<project>`. The first test saves them; later tests show the approved picture, the new one and the changes in red (side by side, slider, changes only). A change over 0.5% becomes an issue; **Approve** makes the new picture the approved one.
- **User journeys** (on by default): project page > User journeys. One step per line in plain words (`open /shop`, `click Add to cart`, `fill Email = {{username}}`, `see Your cart`, `url has /cart`); `{{password}}` uses the saved login and is never shown. Read-only by default: POST and other changes are stopped. Tick **May send forms** only for staging or test sites. Each step gets a picture; a journey that breaks becomes a high issue.
- **App explorer**, **Webhook inbox** and **Journey watch** (on by default): the signed-in app parts described in [Signed-in apps](#signed-in-apps-crm-saas-erp-admin-panels). Switching one off leaves that part out of every test.
- **Own checks folder** (off): put `.mjs` files in `data/modules/` (Docker: `/data/modules/`) and restart. Each exports `{ id, name, run({ page, url }) }` and returns findings; the Modules tab shows an example.
- **Bring your own tests** (off): adds the tool tab **Your own tests (Playwright)**. Upload a zip of the client's Playwright tests folder (with `playwright.config` if they have one; no `node_modules`). They run with our Chromium against the project's address (`baseURL` is set for them, their `webServer` is ignored, one retry so flaky tests show). Each failed test is a high issue, each flaky one medium. Only for code you trust, and point it at a staging site: tests may change data.

### Modules in their own containers

These start only when you ask for them, with a Docker Compose profile. The Modules tab shows **Not installed** until the address is in `.env`.

| Module | Start it | Add to `.env`, then `docker compose up -d` | Use it |
|---|---|---|---|
| **Test mailbox** (Mailpit, MIT) | `docker compose --profile mail up -d` | `MAILPIT_URL=http://mailpit:8025` | Point the staging site's SMTP at this server, port 1025. In a journey: `fill Email = {{inbox}}`, `click Sign up`, `email has Welcome`, `open email link Confirm`. The mailbox screen is on port 8025. |
| **Live load charts** (InfluxDB 1.8 and Grafana OSS) | `docker compose --profile loadcharts up -d` | `K6_INFLUX_URL=http://influxdb:8086` and `GRAFANA_URL=http://localhost:3000` | k6 load tests stream their numbers while they run. The k6 tab's result has a **Live charts** link to the ready dashboard (Grafana, port 3000, view-only without a login). Set `GRAFANA_ADMIN_PASSWORD` on a server. |

Both stay on our server. On a public server, keep ports 1025, 8025 and 3000 behind the firewall or a VPN.

## Mac helper (Safari, VoiceOver, iOS Simulator)

Safari, VoiceOver and the iOS Simulator only run on macOS, so a small program, `helper/mac/glv-helper.mjs`, runs them on a Mac with Xcode (GLV's own Mac). It needs Node.js 22 and nothing from npm, and only runs Apple's own tools (xcrun, xcodebuild, safaridriver, osascript, ditto) with fixed arguments, never through a shell.

- **Pairing.** Owner panel > Mac helpers: name the Mac, press Make a pairing token, and run the two commands it shows on the Mac. The token is shown once and only its hash is kept; it lets the Mac pick up tests and send back results, and it cannot sign in to the dashboard. Unpair shuts the Mac out at once. The same page has the download (the helper and its Xcode project as one zip) and the one-time setup: `safaridriver --enable`, the VoiceOver Utility AppleScript switch, and an iOS 17 or newer Simulator.
- **Nothing reaches the Mac.** The Mac asks the server for work over HTTPS (plain http only on the local network), one test at a time, so no port is opened on it. A test waits up to 15 minutes for a free Mac, and is marked not tested if none is online, with the step that fixes it.
- **The server decides.** The Mac sends back what it saw (Safari's page counts and screenshots, what VoiceOver said, the audit's issues and crash reports); the rules that turn that into findings are on the server, the same for every Mac. Files from the Mac are checked (names, sizes, real PNG, JPEG, JSON or text) before they are kept.
- **Same problem, shown once.** Safari on Mac confirms the cross-browser lab's WebKit findings on the same page ("Also found by Real Safari"), and VoiceOver's unnamed images, buttons, links and fields fold into axe's findings on the same page.
- **Never on by default.** The Mac tests are switched on per test in the tool tabs. They test what anyone can reach, without the saved login. VoiceOver speaks and uses the Mac's screen while it runs.
- **Phones only when allowed.** Development and Ad Hoc builds run on an iPhone connected to the Mac only after `node glv-helper.mjs devices on`, since the app is installed on that phone. App Store copies are encrypted and cannot run outside the App Store; upload a Simulator build (a zip of the .app) instead. The app runs on the Mac, so only test apps from clients you trust.
- **Apple's audit.** `helper/mac/GLVRunner` is a small Xcode project with one UI test that opens the client's app by its bundle ID and calls `performAccessibilityAudit` (iOS 17+, Xcode 15+) on each screen, collecting every issue without failing. The helper builds it on the first app test.

`test/mac-helper.test.ts` runs the real helper against a stand-in Mac (`test/fixtures/fake-mac.ts`: small programs named like Apple's tools that answer the same way), through pairing, Safari, VoiceOver and an iOS app with a crash, so the whole path is tested on Linux. Its setup steps are in `helper/mac/README.md`.

## Load and attack tests (client's permission)

Load tests (k6, JMeter) and attack tests (ZAP's active scan, GLV's attack probes) send far more than a visitor would, so they run only with the client's written permission, recorded on the project page:

- **Only the owner records it**, with who gave it (name and role), where it is in writing (an email or a signed letter), the addresses it covers (up to 10, each exact, port included), the dates (up to 90 days), the most users at once (up to 1,000), the longest test (up to 120 minutes), and whether requests that change data are allowed. Only the owner can withdraw it. Anyone on the team can check the proof again.
- **The client proves it on each address.** The permission gets a token, and the client puts the line `glv-testing=<token>` either in a file at `/.well-known/glv-testing.txt` (https first, then http; a redirect to another host does not count) or in a DNS TXT record at `_glv-testing.<host>`. Until every address has its proof, the permission waits.
- **Checked again before every test.** A load or attack tool runs only on the addresses the permission names, between its dates, within its limits, and only if the proof is still there. If the client took the proof down, the tool does not run and the test is marked incomplete with the reason. A choice above the limits is refused, and a running test is held to them.
- **Never on the schedule.** Scheduled tests leave load and attack tools out; they run only when a person starts the test. They also run one at a time: never two load or attack tools at once.
- **The probes only read.** GLV's attack probes send GET requests only, two at a time with a pause, and never a payload that could change or delete data or slow a database down (no `OR`, `;`, `DROP`, `SLEEP` and the like). POST forms are left alone. Sign-out and delete links (and, signed in, links that look like actions) are skipped, by the same rule the crawler follows. `probes.test.ts` counts every request on a site with planted holes and on the same site done right (no false alarms).
- **ZAP's active scan stays inside the lines.** It scans only the pages the test opened, never spiders, sends GET only, skips sign-out, delete, cancel and reset addresses, uses two threads with a delay, and stops at the permission's time limit. Four rules are always off: Log4Shell, server-side request forgery and out-of-band XSS (they wait for calls to ZAP's outside callback servers, and GLV keeps everything in-house), and exponential entity expansion (it is made to exhaust the server's memory).
- **JMeter plans are checked first.** A plan may only use plain HTTP requests, timers, assertions, extractors, controllers and thread groups. Code (BeanShell, JSR223, JavaScript), programs on the server, file reads, databases, mail, raw TCP and listeners that send results elsewhere are refused with the reason, and so are hosts outside the permission and any request but GET, HEAD or OPTIONS unless the permission allows changes. The users and the time come from the plan and must fit the permission.
- **What the load report shows.** One table with each step (users, requests, requests a second, the times half and 95% of pages loaded within, failures) and findings for errors under load, slow pages, the breaking point (where errors or response times jump), a spike the site did not recover from, and a soak that gets slower over time. A rate limit or firewall that answers "429" is called out as such.

## Logged-in testing and the login vault

A project can keep one login, used for every test of that project:

| Product | Login | What happens |
| --- | --- | --- |
| Website, online store, web app, SaaS, CRM | Sign-in page, user name or email, password; optionally text that only shows once signed in, and CSS selectors for unusual forms | The agent opens the sign-in page, fills the form (one page, or email then password), checks it worked, then crawls and tests the pages behind the login. If the site signs it out, it signs in again (up to 3 times). |
| API | Bearer token, a key in a header (like `X-API-Key`), a key in the address (like `?api_key=`), basic user name and password, OAuth2 client credentials, or a login call that returns a token | Every endpoint is called with it (GET only, unless the project is a test server). The endpoints the API file marks as needing a login are also called once without it, to check they refuse strangers. Other accounts (roles, another company) can be added for the who-can-read-what grid. |
| Source code | Access token (GitHub fine-grained token with Contents: Read, GitLab project token with read_repository) | The token is sent as a header to the repository's own host only. It never goes into the address, the command line or the clone. |

Safety while signed in:

- The agents only look. They never submit forms, and the crawler and link checker skip links that log out or look like actions (delete, cancel, archive, approve, mark all read, switch account, and similar). The app explorer clicks menus, dropdowns and tabs to find screens, but never an item that sounds like a change (delete, save, send, pay, approve...), and every request it causes that is not a plain GET is stopped.
- Use a test account, not a real customer's. Two-step codes from an authenticator app (TOTP) and codes sent by email work (see below); CAPTCHAs stop automated sign-in, and the report says so when that happens.
- Secrets (passwords, tokens, keys) are encrypted with AES-256-GCM in the database, only unlocked in memory while a test runs, never sent back to the dashboard, and replaced with `[hidden]` anywhere they appear in a report, the progress log or an error.

**The vault key.** Set `SECRET_KEY` in `.env` on a server (make one with `openssl rand -base64 32`, at least 16 characters). Without it, a random key is made once and kept in the data folder as `vault.key`, which is fine on your own computer but keeps the key next to the data it protects. When you add `SECRET_KEY` later, saved logins move to it on their own at the next start. If `SECRET_KEY` is lost or changed, saved logins cannot be unlocked: the project page asks for them again. Keep a copy of the key somewhere safe, like a password manager.

## Signed-in apps (CRM, SaaS, ERP, admin panels)

For a web app, SaaS or CRM project, the test signs in with the saved login and tests the whole app behind it, every screen it can find, with every website check plus these. The project page's **Signed-in app** tab holds the extra accounts, the webhook inbox and the step recorder; the report's **Signed-in app** tab shows what was found.

- **Works with any system.** The test recognises 40 well-known systems from the sign-in page and the first screen (Salesforce, Zoho, HubSpot, Dynamics 365, SuiteCRM, EspoCRM, Vtiger, Perfex, Bitrix24, Odoo, ERPNext, Dolibarr, SAP Fiori, OrangeHRM, Freshdesk, Zendesk, osTicket, Moodle, WordPress admin, Magento, Shopify admin, OpenCart, PrestaShop, Strapi, Directus, Metabase, Grafana, Jira, Redmine, Laravel Filament and Nova, Django admin, React-admin, and apps built on Laravel, Django, Rails, ASP.NET, CodeIgniter, Spring or Node). For a known system it uses that system's sign-in fields, menus and its list of action links never to open. Anything else is tested with general rules.
- **App explorer.** After signing in, it clicks through the menus, dropdowns, side bars and tabs (single-page apps too, with `#/` addresses), records every screen it reaches and tests each one like a page. The report lists the screens, how each was reached, and whether it was tested.
- **Two-step sign-in.** Save the authenticator app's secret (the text under the QR code, or the `otpauth://` link) with the login, and the test makes the 6-digit code itself (RFC 6238). Or choose "code sent by email" with the test mailbox. For an unusual sign-in, write the steps in plain words, like a journey.
- **More accounts.** Add up to 6 accounts with other roles (staff, viewer...) and one from another company. Each signs in, and the test tries every screen and app call the main account found. **Who can see what** shows the grid: a screen in another role's "must never open" list that opens, a screen that opens although it is not in that role's menu, or another company's records and data showing, each become an issue.
- **App calls.** The app's own fetch and XHR calls are recorded: server errors, failures, slow calls, calls that send passwords or tokens back, calls that return far too much data, and calls that answer with the same data without any login.
- **Session and login safety.** Session fixation (the session id stays the same after sign-in), sign-out that leaves the old session working, sessions that never end, login tokens kept in the browser's storage, unsigned or never-expiring JWTs and JWTs with secrets in them, forms that change data without a CSRF token, a sign-in page that tells whether an account exists, and Aadhaar, PAN and card numbers shown in full.
- **Data tables.** Search that does nothing, no message when nothing is found, sort that does not change the order, next page showing the same rows, and CSV exports with cells that a spreadsheet would run as a formula.
- **Journeys per role, with clean-up.** A journey can run as one of the accounts, record the app calls of each step, and end with clean-up steps that always run (delete the test record it made). New words: `{{random}}`, `{{today}}`, `{{code}}` (the two-step code), `{{role}}`, `{{webhook}}`, and the step `webhook has <text>`. **+ Record test** gives a create, read, update and delete template for test servers.
- **Webhook inbox.** Open an inbox to get an address the client's app can send its webhooks to; the tab shows each one as it arrives, and a journey can check one came. Set `PUBLIC_URL` in `.env` to the address the client's app can reach this server at.
- **Journey watch.** The website watch can also run the read-only journeys (sign in, open a lead...) every 15, 30 or 60 minutes, and alerts when one fails and again when it passes.
- **Apps that read with POST.** Odoo, ERPNext, Salesforce Lightning and GraphQL apps load their screens with POST calls. Calls that plainly only read (GraphQL queries, never mutations; Odoo's search_read and other read methods; Frappe's get methods; Salesforce getters; search endpoints) pass the read-only guard, and the access grid sends them again as each account and with no login. A GraphQL schema anyone can read is reported too.
- **Admin and debug screens left open.** With no login, the test asks for the screens well-known systems leave open: the Odoo database manager, Metabase's setup token, Strapi with no admin, Magento's env.php, Grafana without login, Laravel Telescope, Horizon, Debugbar and Ignition, Spring's actuator and heap dump, Django's debug page, Rails' route list, ASP.NET's ELMAH and trace, GraphQL playgrounds, phpMyAdmin and Adminer.
- **Admin screens by address.** Each system's admin screens (users, roles, settings, plugins) and the usual ones of custom apps (/admin, /admin/users...) are tried directly by every account, even when no menu leads there.
- **Two-step and sign-in checks.** After the password, the test opens the app before typing the code (it must not open), signs in again with the code already used (it must be refused), and signs in through `?next=` (or the app's own return parameter) pointing at an outside site (it must not go there).
- **Back and expired sessions.** After signing out, Back must not show the private screen. When the session ends mid-work, clicking a menu item must lead to the sign-in page, not a blank or broken screen.
- **Who can change what (test servers).** A journey ticked "May send forms" runs only on a test server; the saves it makes are sent again as each other account and with no login. A save the server accepts from the wrong account is reported. This can leave extra test records on the test server.
- **Test data.** A journey can hold a small table (CSV with a header row). It runs once per row, with `{{column}}` words, for phone formats, long names or Hindi text.
- **Live connections.** WebSocket addresses are listed with the app calls; a login token in the address, or plain ws:// on an https app, is reported.
- **Step recorder for Chrome.** Download it from the Signed-in app tab, load it in Chrome (Extensions > Developer mode > Load unpacked), press Record, use the app, and copy the steps into a journey. It never records what is typed into password fields.

The demo CRM in `test/fixtures/demo-crm.ts` has each of these problems planted, and `test/crm-saas.test.ts` checks the test finds every one without changing any data (except the saves of a journey allowed to send forms).

Checks that change data (account lockout on a spare account you mark, file upload safety with harmless marker files, mass assignment on a save a journey made, forgot-password, the Salesforce guest data check and Claude filling forms) run only on a project marked as a test copy, or with the client's written "Checks that change data" permission, never on scheduled re-tests. Each report lists what ran, what was put back and anything left to delete by hand. The Salesforce guest check is proven against a demo Aura endpoint; its first run on a real Experience Cloud site is still to come.

## Website extras

- **Tablet.** Every page is also checked at tablet width (820 px), with tablet screenshots next to the desktop and phone ones.
- **Real-visitor speed** (project page > Visitors and SEO). A small script for the site's pages sends each visitor's real LCP, INP, CLS, TTFB and FCP to this server (`/rum/<token>`), with no cookies, names or IP addresses. The project shows the 75th percentile of the last 28 days, and reports flag slow pages once 20 visits have come in.
- **SEO audit** (same tab). Target keywords per page, the backlinks you list and a Search Console CSV export. It cannot find backlinks nobody listed or see rankings without that export: that needs a web-wide crawl or Google's own data.
- **Ask Claude to fix.** Save the site's repository (GitHub or GitLab, https) and a token in the project's vault. On an issue, **Ask Claude to fix** writes the smallest change and opens a pull request on a new `glv-fix/...` branch. Nothing is merged. Needs `ANTHROPIC_API_KEY`.
- **Watch the sign-in live.** For a signed-in test, the live view shows the sign-in from **Start test**. When the sign-in gets stuck (a CAPTCHA, a code, a button that does nothing) and someone is watching, the screen is handed over: click and type on the picture, then press **Done**, and the test carries on.

## Wave 1 testing types (2026 gap report)

All in-house, with free or open-source tools in the Docker image. Attack-type checks keep the usual gates: the client's written permission with a proof file (or the owner's own-system unlock), started by hand, read-only, and never on other people's sites.

- **AI chatbot red-team** (tool tab, attack permission naming the chatbot's host): about 30 GLV probes in 10 families (prompt injection, jailbreaks, system-prompt leaks, data leaks, indirect injection from a page GLV serves, unsafe output, excessive agency, made-up answers, endless output, harmful content), each mapped to the OWASP Top 10 for LLM apps 2025 and the OWASP Agentic Top 10 2026. Works on a chat API or the chat widget on the page. Probes that ask for refunds or admin changes run only when the permission allows changes. garak runs too when the image is built with `--build-arg WITH_GARAK=1`.
- **Hacked site and malware**: hidden spam links, spam text, hidden iframes, skimmers, miners, defacement and cloaking (Googlebot sees other content, Google visitors redirected) on every test; the Malware scan tab runs YARA (GLV's rules in `rules/yara`) and ClamAV over the pages and scripts. An SSH connection also looks for web shells on the server.
- **Email and DNS**: SPF (including the 10-lookup limit), DMARC, DKIM, MTA-STS, TLS-RPT, BIMI, DNSSEC and CAA for the site's domain, on every test.
- **Attack surface** tab: subdomains from certificate logs and subfinder, subdomain takeover (26 services), forgotten staging and admin hosts. The **Open ports** tab needs attack permission and checks only the permitted hosts.
- **Blind holes**: the attack agent's Blind family (blind SSRF and XSS, Log4Shell, header fetches), detected by a callback to `OOB_BASE_URL` or an Interactsh server.
- **security.txt** (RFC 9116), **GEO / AI search readiness** (AI bots in robots.txt and the firewall, llms.txt, Organization markup, authors, dates, answer headings).
- **Documents**: PDF and Office files linked from the site (tags, scanned pages, language, title, alt text, headings), and the veraPDF tab for full PDF/UA.
- **India**: DPDP Rules 2025 (notice items, Board, grievance officer, languages, consent on forms), GIGW 3.0 (Owner can switch it on; off by default), IS 17802 view in the WCAG tab, and the 13 CCPA dark patterns (pre-ticked boxes, basket sneaking, confirm-shaming, false urgency, fake timers, drip pricing, trick questions).
- **Browser version matrix** tab (profile `grid`): pages in Chrome 109 and 120, Firefox 115 and Edge 120.
- **Phone farm** (Owner > Test phones > Phone farm): GLV's own Android rack (DeviceFarmer, profile `farm`) and iPhones on USB (go-ios). **MobSF** tab (profile `mobsf`) and **Mobile runtime security** tab (adb and Frida on a test phone).
- **Journeys**: write a test in plain English and get the steps (Claude when the API key is set, else GLV's rules); steps heal themselves when a button's words or id change a little, and the report says so.
- **Record and replay** tab (APIs): upload a HAR recording; every GET is replayed on each test and compared (status, JSON fields removed or changed type, speed). The recording also becomes WireMock mocks.
- **Mutation testing** tab (code, started by hand): small changes to a copy of the code, the project's own tests run after each one, and the changes no test caught are listed.

## Wave 2 testing types (2026 gap report)

Same rule as wave 1: in-house, free or open-source tools in the image, attack and load checks keep the written-permission/own-system gates, started by hand, read-only. Each optional tool below works from its tab only when it is installed; GLV's own fallback runs otherwise.

- **AI**: RAG answer quality and regression (`AI answer quality` tab — grades answers against a question set, checks sources and consistency, keeps a score history), AI agent/tool-use safety (in the red-team tab), and **MCP attack** tab (path, SQL, SSRF, command injection, calls without a token).
- **Attacks** (attack permission): **Race conditions** tab (one action sent many times at the same instant), HTTP request smuggling / cache poisoning / host-header (attack agent), OAuth/OpenID/SAML flaws, store business logic (negative/fractional/huge quantities), file-upload code execution and photo EXIF location.
- **Lookalike domains** tab: typosquat domains a phisher could register.
- **Servers** (SSH / cloud): hardening score (CIS-style), CERT-In log retention and time sync, read-only database health (indexes, foreign keys, plain-text passwords, slow queries, backups), **network CVE scan** of open ports (nuclei), **Cloud posture** tab (Prowler, read-only keys), and **Chaos** tab (restart/stop/delay a service, each self-undoing).
- **Code / API**: supply-chain depth (typosquats, install scripts, unpinned Actions, risky CI) and more-language SAST (Python, PHP, Go, Java, Kotlin, Swift, Dart), **SBOM** tab (CycloneDX + copyleft licences), **Run the client's tests** tab (npm/pytest/phpunit/flutter + coverage), **OpenAPI diff** tab (breaking changes + lint), **API mocks** tab, **Payment flows** tab (Stripe/Razorpay sandbox), **Email template** tab, **Pairwise** tab, **Export as code** tab (Playwright/Appium).
- **Web quality**: local SEO, hreflang, social previews, JavaScript render diff, colour-blind / low-vision, WCAG AAA + cognitive, phone layout breaks, **VPAT / EN 301 549** report tab.
- **Speed**: frontend profiling (INP/CLS/JS size), backend slow calls and N+1 (signed in), **Region speed** tab (proxies in other regions).
- **Mobile**: OTA update safety (CodePush/Expo), **App performance** tab (start time, jank, memory, size), **Maestro** tab, **Deep-link runner** tab, **TalkBack labels** tab, **In-app / India browsers** tab (WhatsApp/Instagram/Facebook webviews, Samsung, Opera, UC).
- **Compliance**: GDPR/DPDP consent proof (trackers before consent, a real Reject that works) and PCI DSS 4.0 payment-page script controls (SRI, CSP).

## Wave 3 testing types (2026 gap report, the P3 / niche tail)

Same rule again: in-house, free or open-source tools in the image, the same safety gates, read-only. Optional external scanners (ModelScan, Checkov, kube-bench/Dockle, GoAccess) deepen a check when installed; GLV's own fallback runs otherwise.

- **Code**: **Model file security** (pickle `.pkl/.pt` models that run code when loaded), **IaC** (Terraform/CloudFormation/Kubernetes/Dockerfile rules), **Code fuzzing** readiness (fast-check/Hypothesis/Jazzer), **Browser extension** (manifest permissions, content-script risks), **Desktop app** (Electron/Tauri security settings).
- **Web**: **Print & PDF layout** (invoices/tickets print without being cut off), **Video/WebRTC quality** (start time, buffering), **Legal page change watch** (terms/privacy fingerprint), **Carbon** (CO2 per page view), **Image/video/Discover SEO**, **Video & audio accessibility** (captions/transcripts), a **second accessibility engine** beside axe, **HIPAA** (health data in URLs and to trackers).
- **API / data**: **Reconciliation** (a total matches across two systems), **Data quality** (nulls/duplicates/ranges in an export), **Queues** (AsyncAPI validation), **Distributed tracing** (traceparent propagation).
- **Servers (SSH)**: **Kubernetes/Docker host** (privileged pods, rootful Docker), **Log-file SEO** (what Googlebot really crawls), **Backup & DR drill** (recent backups, a restore test), **Database code** (untested stored procedures/triggers).
- **Other**: **AI call cost & speed** (tokens, latency, timeouts), **SMS/WhatsApp** templates (length, opt-out, India DLT ids), **Post-quantum readiness** (TLS ML-KEM probe + weak-crypto in code), **SOC 2 / ISO 27001 evidence** report, **Backlinks** (Common Crawl open web graph), **Store listing** and **In-app purchases** (mobile, static).
- **Deferred (noted in the handbook and gap doc, not built)**: IAST (research-grade), keyword/rank tracking (needs Google), AI-answer visibility (needs AI-service keys), Windows-only browsers (needs a Windows VM), Wear/TV/Auto/kiosk/IoT (emulators, niche), games (out of scope), push-notification live send (needs client FCM/APNs keys), Jira/Linear export (needs tracker tokens) and voice-bot testing (needs speech models). Test history and a combined risk score are already covered by the trends view and master-control gate.

## Client connections (SSH, Hostinger, MCP)

Everything runs on GLV's own servers. A project's **Connections** tab is how they reach the client's own system. The owner adds a connection and presses **Test the connection**; from then on every test of the project (scheduled ones too) adds that connection's read-only checks to the report.

- **SSH server**: GLV signs in with the client's key (or password) using OpenSSH (in the Docker image). Only fixed, read-only commands run: system past end of support, waiting security updates, databases listening on every network, SSH root or password sign-in, disk, memory, clock, old PHP. The server's key is learned on the first test and must stay the same. With **Test the site through this server** on, the test's browser opens the client's private test site (like `http://localhost:8080` on their server) through an SSH tunnel; outside tools and load or attack tools are left out of those tests.
- **Hostinger account**: the client's API token from hPanel. Only GET requests: servers stopped or without firewall or backups, domains expired or ending soon, domains without SPF or DMARC. The test lists the account's websites ("use as this project's address") and servers ("add an SSH connection").
- **MCP server**: the client's own MCP server. GLV lists its tools (never calls one) and checks sign-in, HTTPS, Origin checks, CORS and tool poisoning (hidden characters, hidden instructions).
- **GLV's MCP server** (`/api/mcp`): a token made on the tab lets the client's AI assistant read that one project's status, open issues and latest report, and start a normal test (safe tools only).

Secrets pasted on the tab are sealed with `SECRET_KEY` and never shown again. To keep a secret out of the database, put it in `.env` as `CONN_<NAME>` and write `env:CONN_<NAME>` on the tab, or put an SSH key file in `SSH_KEYS_DIR` (default `/data/ssh-keys`) and write `file:<name>`. Only `CONN_` names can be read, so a connection can never send the server's own keys anywhere.

## What the categories cover

| Area | Checks |
| --- | --- |
| Functional | Pages that fail to load or return 4xx/5xx, broken links (internal and external), uncaught JavaScript errors, scripts blocked by a wrong integrity hash, console errors, failed or broken resources |
| Accessibility | WCAG 2.0 to 2.2 A/AA rules via axe-core: contrast, alt text, labels, button names, lang, tap target size and more |
| SEO | Title and meta description length, `<h1>` count, image alt text, canonical, `lang`, viewport, `noindex`, Open Graph |
| Security (passive only) | HTTPS, HSTS, CSP, clickjacking protection, nosniff, Referrer-Policy, version disclosure, cookie Secure/HttpOnly flags, mixed content |
| Performance | Core Web Vitals from the browser's own timing data (LCP, CLS, time to first byte), full load time and download size per page |
| Mobile | Sideways scrolling at phone width, WCAG 2.2 tap target size at phone width, phone screenshot of every page |

Security checks only read what the server already sends. Nothing sends attack payloads, so a scan is safe to run on any site the client has authorised. Active scanning (OWASP ZAP) comes in phase 2 and will run only on staging with written permission.

Each category gets a score out of 100. Any critical issue caps the overall score at 69.

**Not tested is never a pass.** When a check cannot run (the package database cannot be reached, an agent crashes on every page), the report opens with an "Incomplete test" box, the category shows "Not tested" instead of a score, and the overall score averages only what was tested. Its earlier issues stay open, because nothing looked again. When nothing can be tested at all (the site cannot be reached, its certificate cannot be checked, or every API call is refused the same way), the run ends as "Not tested" with the reason, and no score.

### How it avoids false alarms

- The same problem on many pages (for example in a shared header) is one issue, listed with every page it affects. Scores count each distinct issue once, weighted by how many pages it is on.
- A page or link that answers 429, 502, 503 or 504 is tried again a few seconds later before anything is reported, because that is usually rate limiting, not a broken page. Internal links are checked a second time in a real browser.
- Links to social networks (LinkedIn, Facebook, Instagram, X, WhatsApp and others) are skipped, because they block automated checks. Other sites that refuse the check are listed as info, not as broken.
- "Failed to load resource" console lines are not counted again on top of the broken resource itself. Console errors from third-party scripts are kept apart and rated low.
- Speed uses Google's Core Web Vitals thresholds. It is one lab measurement from the testing server, so real visitors' numbers can differ. Because timing changes from run to run, speed issues (and slow API endpoints) are only verified as fixed, or reopened, when two tests in a row agree.
- A missing alt text is High, not Critical: it does not cap the score.

### Same site, same result

A re-test of a site that has not changed gives the same issues and the same score. What used to make it move, and what the platform does now:

- **Numbers in issue names.** "1 focused item is hidden" and "8 focused items are hidden", or "LCP 6.7 s" and "LCP 4.8 s", are one issue: the issue key ignores numbers, units, plurals and is/are. Issues saved under the older key are merged into one the first time (the extra ones are closed as "Merged into GLV-12").
- **Checks that did not finish.** When a tool stopped half way last time (testssl.sh hit its time limit), what it finds the next time is shown as "checked for the first time", not as new problems. testssl.sh now has 15 minutes (`TESTSSL_MINUTES`).
- **Tools that check some pages.** The W3C HTML checker (first 20 pages) and Lighthouse (start page) say which pages they checked; an issue on a page they did not check this time is never called fixed. The HTML checker tries each page twice and lists errors in page order. CSS errors of one kind (`Style rule ... not allowed outside @scope`) are one issue with every selector listed, not one issue per selector.
- **Lighthouse.** Runs 3 times per page and keeps the middle run (Google's own advice); a speed tip counts only when most runs show it. The Lighthouse tab can change this to 1 or 5 runs.
- **Page pictures.** Taken as the page loaded, before any agent presses keys or opens menus, with animations stopped, videos paused and web fonts loaded. Each picture is taken twice a moment apart, and what moves by itself (sliders, tickers, videos, embedded frames) is left out of visual compare, shown in blue. Pictures approved automatically by older versions are replaced once without a finding; pictures a person approved are kept.
- **Signed-in apps.** The app's own calls are put in a fixed order before the checks read them, so the access grid and the call checks take the same calls every time, whichever screen loaded first.
- Speed itself still changes from run to run (it is a measurement), so speed issues change state only when two tests in a row agree.
- A page that fails to load is reported once, not also as "1 request failed".

## Quick start

Needs Node 22.19 or newer (Lighthouse needs it).

```bash
npm install
npx playwright install chromium   # first time only
npm run build
npm start                          # dashboard at http://localhost:4000 (asks for the owner account first)
```

For development with hot reload: `npm run dev` (API on :4000, dashboard on :5173).

### Turn on the Claude summary

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. Each finished scan then gets a short summary and the top 3 to 5 fixes, written by Claude (`claude-opus-5-5` by default; change it with `CLAUDE_MODEL`). Without a key, scans still run; only the summary is skipped.

To use fewer credits:
- A re-test that finds exactly the same issues as the last summarised test of that project reuses its summary, and the report says so ("summary reused, no credits used").
- Each report shows how many tokens its summary used. `CLAUDE_EFFORT` (low, medium, high, max; medium by default) sets how hard Claude thinks.
- A report made while the summary was off, or before the key was set, has a **Write summary** button.

### Faster tests: pages at the same time

A website test opens several pages at the same time (4 by default, up to 16), each in its own browser screen, and all the agents of a page check it together. Site-wide agents (links, exposed files, duplicates) also run together. A website test has about 50 agents: about 33 check each page and the rest check the whole site, so 8 pages at the same time means over 250 agent checks at once. Change it in the owner panel, with `PARALLEL_PAGES` in `.env`, or with `--parallel` on the command line.

Accuracy stays the same as one page at a time:
- The first page is tested alone, since it decides where the site lives.
- A site that answers 429 (too many requests) is tested one page at a time from then on.
- When a site signs the agent out while several pages are open, the pages of that session are tested again one at a time.
- Pages still load one at a time, so the site's speed is measured as one visitor sees it. Only the checks, which take most of the time, overlap.
- Links are followed in the order one page at a time would find them, so the same pages are tested when the site has more pages than the limit.

### Command line (offline and CI)

```bash
npm run scan -- scan https://example.com --pages 20 --product ecommerce
npm run scan -- scan https://example.com --parallel 8   # 8 pages at the same time
npm run scan -- api https://api.example.com/openapi.json
npm run scan -- code .                      # the folder you are in (or a repo URL or a zip)
npm run scan -- apk app-release.apk
npm run scan -- ipa GLVShop.ipa          # or a zip of the .app
# or after npm run build:
node dist/cli.js code . --fail-on high
# add outside tools (a list, or all for every installed one):
node dist/cli.js code . --tools gitleaks,opengrep,osv-scanner,trivy --fail-on high
node dist/cli.js api ./openapi.json --tools schemathesis
node dist/cli.js tools                      # which tools are installed on this machine
```

`--fail-on high` exits with code 1 if anything high or critical is found, so it can block a deploy in GitHub Actions or GitLab CI. The full report is written to `glvtest-report/report.json` with screenshots alongside it, and `report.sarif` and `report.junit.xml` next to it for GitHub code scanning and CI test views.

## Run on GLV servers (Docker)

```bash
cp .env.example .env    # add ANTHROPIC_API_KEY
docker compose up -d --build
```

The dashboard runs on port 4000, with OWASP ZAP in a second container for the ZAP tool tab. The first build takes longer than before (it builds Nuclei and downloads its checks). Scan results and screenshots are kept in the `agent-data` volume. `docker compose stop` (or Ctrl-C when it runs in the foreground) cancels the running tests, closes their browsers and exits within a few seconds; cancelled tests say so in their report. On a server, turn login on first (below), then put it behind your usual reverse proxy (Nginx or Caddy) with HTTPS and set `TRUST_PROXY=1`.

### Login switch (AUTH_DISABLED)

While GLV builds and tests the system on its own computers, `docker compose` starts with **login off** (`AUTH_DISABLED=1`): no owner account screen and no sign-in, and everyone who opens the dashboard is the owner. The sidebar shows "Login is off for local use", and the server log prints a warning at start.

As a safety net, with login off the server only answers visits from its own computer and local network (including Docker's network on a Mac). Anything from the internet, directly or through a proxy that passes the visitor's address, gets "Login is turned off on this server". Do not rely on that on a real server.

**Before putting it on a server, turn login on:**

1. In `.env`, set `AUTH_DISABLED=0` (add the line if it is missing).
2. In `.env`, set `SECRET_KEY` (make one with `openssl rand -base64 32`) so saved client logins are encrypted with a key that is not stored next to the data. Keep a copy somewhere safe.
3. Optional: set `OWNER_EMAIL` and `OWNER_PASSWORD` in `.env` to create the owner account at start. Otherwise the dashboard asks for it the first time it opens.
4. Restart: `docker compose up -d`.
5. Check: opening the dashboard now shows the sign-in or owner account screen, and the sidebar no longer says "Login is off".

Projects, reports and issues made while login was off are kept. To turn login off again on your own computer, set `AUTH_DISABLED=1` and restart. Without Docker (`npm start`), login is on unless you set `AUTH_DISABLED=1` yourself.

Each scan uses about 1 to 2 CPU cores and 1 to 2 GB of RAM while running (an estimate, not yet measured). How many tests run at once is set in Owner panel > Settings ("Projects tested at the same time", 1 to 8; `SCAN_CONCURRENCY` in .env is the starting value, default 2). The sidebar shows how many are running, and the **Live** page shows every running test's screens on one page.

### Processor type (Intel vs Apple Silicon / ARM)

`docker-compose.yml` builds the Intel (amd64) image by default. That runs natively on most servers (including Hostinger VPS) and on Apple Silicon Macs through Docker Desktop's Rosetta emulation, so `docker compose up -d --build` works on both without extra settings. Docker prints a warning on Apple Silicon that the image platform does not match the host; that is expected.

On an ARM Linux server (for example AWS Graviton), add `DOCKER_PLATFORM=linux/arm64` to `.env` to build the native ARM image.

If you ever see `exec /bin/sh: exec format error` during the build, Docker picked an image your machine cannot run: set `DOCKER_PLATFORM` in `.env` to match `docker version --format '{{.Server.Arch}}'` (or keep the amd64 default) and rebuild with `docker compose build --no-cache`.

### Disk space, and "Build fails with read-only file system"

The first build downloads the Playwright, Go and ZAP images and compiles five Go tools, so leave about 25 GB free for Docker (and on a Mac, on the Mac's own disk too). That is an estimate, not a measurement: the finished images take roughly 6 to 8 GB, and the build needs room for downloads and compiling on top.

If the build stops with `read-only file system` (often next to `curl: (23) Failure writing output to destination` or `metadata_v2.db`), Docker's own disk filled up and Docker switched it to read-only. It is not a problem in this project, and it stays read-only until Docker restarts. On Docker Desktop (Mac or Windows):

1. Check the computer's free disk (`df -h ~` on a Mac) and free space if it is nearly full.
2. Restart Docker Desktop (whale icon > Restart, or Troubleshoot > Restart Docker Desktop).
3. See what Docker keeps with `docker system df`, then remove old build steps and unused images: `docker builder prune -af` and `docker image prune -af`. Neither touches the `agent-data` volume (projects and reports) or a running container. Images they remove download again on the next build.
4. If Docker's disk is still small, raise it in Docker Desktop > Settings > Resources > Advanced > Disk usage limit (64 GB or more), then Apply & restart.
5. Build again: `docker compose up -d --build`. After a prune it starts from the beginning, so it takes as long as the first build.

Troubleshoot > Clean / Purge data also frees the space, but it deletes every image, container and volume, including `agent-data`. Use it only if the steps above do not help, and only if you do not need the saved projects and reports.

On a Linux server, check `df -h /var/lib/docker` and use the same `docker builder prune -af` and `docker image prune -af`.

## API

Every route except `/api/health` and the sign-in routes needs a signed-in session (cookie). Writes from other websites are refused.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/auth/state` | Whether the owner account exists, and who is signed in |
| `POST` | `/api/auth/setup` | Create the owner account (first start only) |
| `POST` | `/api/auth/login`, `/api/auth/logout` | Sign in and out |
| `GET` | `/api/meta` | Product types, agents with on/off state, and the outside tools with whether each is installed on this server |
| `GET`, `POST` | `/api/projects` | List projects; create one and start its first test. Body: `{ "type": "website", "url": "https://...", "name": "", "maxPages": 20, "schedule": "off" }`. API: `specUrl` (or `file`) and an optional base `url`. Code: `repoUrl` and `branch` (or `file`). Android and iOS: `file`. Optional `login`: `{ "loginUrl", "username", "password" }` for web, `{ "authType": "bearer" \| "header" \| "query" \| "basic", "token", "paramName", "username", "password" }` for an API, `{ "token", "username" }` for code. Optional `tools`: `[{ "id": "lighthouse", "options": { "device": "desktop", "pages": "3" } }, { "id": "zap" }]` (left out: every installed safe tool). Answers show only whether a secret is saved |
| `POST` | `/api/uploads` | Upload an APK, a zip of code or an OpenAPI file as the raw body (`content-type: application/octet-stream`, file name in `x-file-name`, up to 300 MB). Returns the `file` to put in the project |
| `GET`, `PATCH`, `DELETE` | `/api/projects/:id` | Project with runs and score trend; change name, address, pages, schedule, the uploaded file (a new app build), `tools` (the tool tabs for later tests; `null` goes back to the default), `login` (secrets left empty keep the saved ones; `null` removes it), and for APIs `apiScenarios`, `testServer`, `graphqlUrl` and `mock`; delete (owner; a queued or running test is cancelled first) |
| `POST` | `/api/projects/:id/runs` | Re-test now |
| `POST` | `/api/projects/:id/permissions` | Record the client's permission for load or attack tests (owner). Body: `{ "hosts": ["shop.example.com"], "kinds": ["load", "attack"], "grantedBy", "reference", "from", "until", "maxUsers", "maxMinutes", "writes": false, "confirm": true }`. Answers with the token for the proof and the first proof check |
| `POST` | `/api/projects/:id/permissions/:pid/check`, `/revoke` | Check the client's proof again (anyone on the team); withdraw the permission (owner), which also switches its tools off |
| `GET` | `/api/runs/:id` | Full report, with live progress while it runs |
| `POST` | `/api/runs/:id/api-baseline` | API tests: approve this test's API file as the new version (later tests list changes against it) |
| `GET` | `/api/runs/:id/postman` | API tests: the tested calls as a Postman collection (v2.1) |
| `GET` | `/api/projects/:id/mock` | API projects: the mock server's address, whether it is ready, and its last 50 calls. Turn it on with `PATCH /api/projects/:id` `{ "mock": true }` (`"new"` for a new address, `false` to turn it off) |
| any | `/mock/:token/*` | The mock server itself (no login, only the secret address) |
| `GET` | `/api/runs/:id/live` | The live view while a website test runs, as server-sent events: `screens` (how many), `screen` (address, desktop or phone, what it is doing, which agents are checking it), `frame` (a JPEG picture), `log` and `end`. Pictures are only made while a viewer is connected. With `?code=1` (the code panel) also `code`: lines of steps, requests, console and findings |
| `GET` | `/api/runs/:id/live/source/:slot` | The HTML one live screen shows right now, secret values hidden (404 when the screen has no page or the test is over) |
| `POST` | `/api/runs/:id/summary` | Write the Claude summary for a finished test that has none |
| `GET` | `/api/runs/:id/artifacts/:file` | Screenshots, and each tool's own report (`tool-*.html` opens in a sandbox, `tool-*.json` is the raw results) |
| `POST` | `/api/runs/:id/cancel` | Cancel a queued or running test (its browser or clone is stopped; issues are not changed) |
| `POST` | `/api/runs` | Quick test by address (reuses the website project for that site) |
| `GET` | `/api/issues?projectId=` | Tracked issues |
| `GET`, `PATCH` | `/api/issues/:id` | One issue with history; change status, assignee, or add a note |
| `GET` | `/api/owner/overview` | Owner numbers |
| `GET`, `PATCH` | `/api/owner/settings` | Agent switches, default pages, pages at the same time (`parallelPages`), Claude summary |
| `GET`, `POST`, `DELETE` | `/api/owner/users` | Team accounts |
| `GET`, `POST`, `DELETE` | `/api/owner/helpers` | Paired Macs, with what each can test; pair one (answers with its token, once); unpair one |
| `GET` | `/api/owner/helpers/download` | The Mac helper and its Xcode project as a zip |
| `POST`, `GET` | `/api/helper/*` | The Mac helper's own routes (hello, ping, jobs/next, the app file, progress, files, result), signed in with its token (`Authorization: Bearer glvh_...`), never a user's session |
| `GET`, `POST`, `DELETE` | `/api/projects/:id/roles`, `/api/projects/:id/roles/:rid` | Extra accounts for the access grid (up to 6): `{ "name", "login": { "username", "password", "loginUrl" }, "otherCompany": false, "mustNotOpen": ["/admin*"] }`. Answers never include secrets |
| `GET`, `POST`, `DELETE` | `/api/projects/:id/hooks` | The webhook inbox: its address and messages; `{ "fresh": true }` makes a new address, `{ "clear": true }` empties it; delete closes it |
| `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | `/hooks/:token` | The inbox address itself, for the client's app (no login; only the secret address works) |
| `POST` | `/api/projects/:id/watch/journeys` | Run the read-only journeys now (journey watch) |
| `GET` | `/api/recorder/download` | The Chrome step recorder as a zip |
| `GET` | `/api/health` | Health check |

Local and private addresses (localhost, 10.x, 192.168.x and so on) are blocked by default so the server cannot be used to probe your internal network. This also applies to the server address inside an uploaded API file. Set `ALLOW_PRIVATE_TARGETS=1` to test internal staging sites. The check works on the address as typed; a public hostname that resolves to a private IP is not yet blocked.

Repositories are cloned with this server's own Git logins and settings switched off (credential helpers, askpass, SSH agent, global and system git config) and over https only, so a project can never read GLV's private repositories with the server's access.

## Project layout

```
src/
  agents/registry.ts        every specialist agent; add new ones here
  agents/web/               the browser engine's agents
  agents/api/               the API engine's agents
  agents/code/              the source code engine's agents
  agents/mobile/            the Android and iOS engines' agents
  engines/                  one runner per engine, plus the OpenAPI, zip, Android binary XML, plist and Mach-O readers
  tools/index.ts            the outside tools (tool tabs); add new ones here. Runs them and merges their findings
  tools/*.ts                one file per tool: Lighthouse, W3C HTML checker, ZAP, Nuclei, testssl.sh, ...
  tools/mac.ts              the Mac helper's tools (Safari, VoiceOver, iOS Simulator) and their rules
  helpers.ts                paired Macs and the queue of work for them
  targets.ts                checks what each product type needs (address, repository, upload)
  runner/scan.ts            crawler that runs the agents (Playwright), several pages at the same time
  live.ts                   the live view of a running test (screens, pictures, agents) sent to the dashboard
  runner/checks/            seo, security, accessibility rules used by agents
  runner/score.ts           category and overall scores
  group.ts                  groups findings into distinct issues
  fixes.ts                  fix suggestion for every rule
  issues.ts                 issue tracker sync and regression check
  auth.ts                   owner and team sign-in, and the AUTH_DISABLED switch
  vault.ts                  encrypted logins for logged-in testing (AES-256-GCM)
  runner/login.ts           signs in through a site's own sign-in form (two-step codes, written steps)
  app/                      signed-in app checks: systems, explorer, access grid, app calls, sessions, tables, TOTP, webhook inbox
  scheduler.ts              daily and weekly re-tests
  ai/triage.ts              Claude summary and top fixes
  queue.ts                  in-process job queue (swap for BullMQ + Redis later)
  store.ts                  SQLite storage (node:sqlite; swap for PostgreSQL later)
  server.ts                 Fastify API, serves the dashboard
  cli.ts                    glvtest command line
web/                        React dashboard (Vite)
helper/mac/                 the Mac helper (glv-helper.mjs) and its Xcode audit runner (GLVRunner)
helper/chrome-recorder/     the Chrome step recorder extension (records journey steps)
test/                       tests, plus a demo site, demo CRM behind a login, demo API, demo APK and demo IPA with deliberate bugs
```

## Testing

```bash
npm test          # unit tests + full tests of the demo site, demo API, demo code, demo APK and demo IPA
                  # tools.test.ts also runs each installed tool on a demo site; tools that are not installed are skipped
                  # load.test.ts runs real k6 and JMeter tests when they are installed; probes.test.ts attacks a site with planted holes
                  # mac-helper.test.ts runs the Mac helper against a stand-in Mac
npm run typecheck
npm run demo-site # start the demo site on :4100 to try the dashboard
npx tsx test/fixtures/demo-api.ts  # demo API on :4200 (spec at /openapi.json)
```

## Not built yet (next steps from the plan)

- GraphQL mutations on a test server
- Jira export
- iOS traffic recording on the test phone (Android only for now), and Espresso or XCUITest suites the client wrote
- VoiceOver on iPhone (the Mac helper reads pages with VoiceOver on the Mac), and the Mac helper as a signed app that starts with the Mac
- Waves 1–3 of the 2026 gap report (P1, P2 and the P3 niche tail) are built — the whole ~100-gap list. Left for a separate decision or as noted: the white-label client portal (a platform/product feature, tenant login and branding, not a test), and the P3 items that need outside infrastructure or paid-service/client keys (IAST, keyword/rank tracking, AI-answer visibility, Windows VM browsers, Wear/TV/Auto/kiosk/IoT, games, push live-send, Jira/Linear export, voice-bot testing)
- A local copy of the OSV database kept up to date on the server
- SEO: finding backlinks nobody listed and rankings without Search Console data need a web-wide crawl or Google's data, so the in-house audit works from the backlinks you list and your Search Console export
