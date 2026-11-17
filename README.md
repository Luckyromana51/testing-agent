# GLV Testing Agent

An AI testing platform by GLV Infotech Solutions. Pick what you are testing (website, online store, web app, SaaS, CRM, API, source code or Android app), give it the address or upload the file, and a team of specialist agents checks it the way a QA engineer would and writes a report: major issues first, each with a fix you can paste. Every problem becomes a tracked issue (like Jira) that re-tests verify as fixed, or reopen when it comes back.

This follows the [architecture plan](https://claude.ai/artifact/PWZA5PZ8vKN8MpmfSUXJmE). Four engines are built: the browser engine (websites and web apps), the API engine, the source code engine and the Android engine. iOS comes later.

## The dashboard

- **New test**: pick the product type first, then enter its details: a web address; an OpenAPI file address or upload for an API; a Git repository or a zip for source code; an APK upload for an Android app. iOS shows as "Coming soon".
- **Report**: score per category, then the major issues (critical and high) as cards with a fix suggestion and ready-to-paste code for Apache/LiteSpeed (Hostinger), Nginx, WordPress or PHP. Everything else is in a filterable list. The Agents tab shows what each agent found and how long it took; the Tools tab shows each outside tool's scores, findings and its own report to open.
- **Projects**: each site, API, codebase or app you test, with its score trend, open issues, test history and an automatic re-test schedule (daily or weekly). For an app, upload the next build on the project page and press Re-test to see what was fixed and what came back.
- **Issues**: a board (Open, In progress, Fixed, Verified) across projects. Keys look like `GLV-12`. Mark an issue fixed, press Re-test, and the next run either verifies it or moves it back to Open as "Came back". Assign issues and add notes; everything is kept in the history.
- **Logins**: tick "Sign in first" (websites and apps), "The API needs a key or token" or "The repository is private" on the new-test form, or use the Login card on the project page. See [Logged-in testing](#logged-in-testing-and-the-login-vault).
- **Tool tabs**: after you pick the product type, the new-test page shows a row of tabs: **GLV checks** (the platform's own agents) first, then one tab per outside tool that fits that type (Lighthouse, W3C HTML checker, OWASP ZAP, Nuclei, testssl.sh). Each tab says what the tool checks, whether it is safe, how long it takes, and has a switch and options. The project page has the same tabs to change the tools for later tests. See [Outside tools](#outside-tools-tool-tabs).
- **Owner panel**: overview numbers, switch any agent on or off, add team members, set the default page count and the Claude summary, and see the login vault's status.

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

### API engine (OpenAPI 3 or Swagger 2)

Only read-only GET requests are sent, with the project's saved key or token if it has one. POST, PUT, PATCH and DELETE operations are counted but never called. Up to 60 endpoints per test, 3 at a time, with a retry on rate limits and gateway errors.

| Agent | What it checks |
| --- | --- |
| Endpoint health | Server errors, no answer, documented endpoints that are missing (404), slow endpoints (the faster of two calls) |
| Response format | Broken JSON, web pages where JSON should be, wrong content type, answers that do not match the documented schema, undocumented status codes |
| Login protection | Endpoints marked as needing a login that answer without one; login errors sent as 200; no login described at all |
| Data exposure | Password hashes, tokens and keys in answers; lists of personal e-mail addresses readable without a login |
| Error handling | Stack traces, SQL errors and debug pages in answers, including for a missing address and a wrong-type id |
| HTTPS, CORS and headers | Plain HTTP, CORS that lets any website call the API as the logged-in user, HSTS, nosniff, version disclosure |
| API file quality | No servers, duplicate operationIds, operations without documented answers |

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

## Outside tools (tool tabs)

Well-known testing tools run in the same test as the platform's agents. Their findings join the same report, score and Issues board, so a test with five tools still gives one report. The comparison of about 40 tools, and the plan for the next ones, is in [Testing tools for the GLV platform](https://claude.ai/artifact/AUtm8C8zmdxb4qFxnTTYGD).

| Tab | For | What it adds | Signed in |
| --- | --- | --- | --- |
| Lighthouse (Google) | Website, store, web app, SaaS, CRM | The Performance, Accessibility, Best practices and SEO scores clients see in PageSpeed Insights; Core Web Vitals on a slow phone or desktop; what slows the page most, with the time each fix saves | Yes |
| W3C HTML checker | Website, store, web app, SaaS, CRM | HTML that breaks the standard (elements in the wrong place, duplicate ids, bad attributes), on up to 20 pages | Yes |
| OWASP ZAP (passive) | Web types and API | Over 60 passive security rules: headers, cookies, information leaks, unsafe forms | Yes |
| Nuclei | Web types and API | Thousands of community checks: known CVEs, exposed files and panels, wrong server and DNS settings | No |
| TLS check (testssl.sh) | Web types and API | TLS versions, weak ciphers, the certificate, and known TLS attacks, with a grade | No |
| Schemathesis | API | Tens of generated calls per GET endpoint from the OpenAPI file: server errors, answers that break the schema, wrong status codes and content types, endpoints that work without a valid login. Each problem comes with the request that shows it | Yes (API login) |
| Newman (Postman) | API | Runs the team's own Postman collection (uploaded in the tab) and reports every test that fails. Only its GET requests are sent | Yes (API login) |
| Gitleaks | Source code | More than 150 kinds of keys and tokens in the code, and optionally in the whole Git history (a deleted key is still in old commits) | Git token, for the history |
| Opengrep, with GLV's own rules | Source code | Follows request data through the code to SQL, shell commands, file paths, redirects and HTML: 40 rules for JavaScript/TypeScript, Python, PHP, Java, Go and C# | No |
| OSV-Scanner (Google) | Source code | Every package in the lockfiles against Google's OSV database: npm, pnpm, yarn, pip, Poetry, Composer, Go, Cargo, Maven, Gradle, NuGet, Pub, Gems; malware packages too | No |
| Trivy (Aqua Security) | Source code | A second package database, plus unsafe Dockerfile, Kubernetes, Helm, Terraform and Compose settings, and package licences (AGPL, GPL) that may not allow closed-source client delivery | No |

How they are kept safe and accurate:

- **Safe tools only for now.** ZAP only looks at the pages the test already opened (GET requests): no spider, no form posts, no active scan. Nuclei leaves out every check tagged as an attack, flood, password guess or call to an outside service, and every check that sends POST, PUT, PATCH or DELETE. Schemathesis tests GET operations only, and its coverage phase is told not to try other methods (by default it sends POST, PUT and DELETE to every path to see they are refused). Newman runs only the GET and HEAD requests of a collection, leaves out scripts that send requests of their own (`pm.sendRequest`), refuses addresses on the server's own network, and cannot read files outside its work folder. Tests in `tools.test.ts` and `tools-code-api.test.ts` count the requests and check nothing but GET reaches the site or API. Tools that attack, write or load a site come later, behind a permission step.
- **Code is never run.** The code tools only read files. OSV-Scanner's call analysis (which builds the code, and runs Rust build scripts) is switched off. Gitleaks uses its own rules, not a `.gitleaks.toml` in the project, so a project cannot switch its own checks off. The Git history is fetched with the same rules as the clone: https only, never this server's own Git logins.
- **One problem is shown once.** When a tool finds what a platform check already found (a missing header, a slow LCP, the public .env file, a leaked key in the same file, a crash on the same endpoint), the tool's copy is folded into the platform's finding ("Also found by OWASP ZAP") instead of counting twice. Two tools that find the same vulnerable package (Trivy and OSV-Scanner) give one finding too.
- **Never counted as passed.** A tool that is switched on but cannot run (not installed, timed out, its checks not downloaded) makes the test "incomplete" and says why, and its issues stay open until it runs again.
- **Logins stay hidden.** With a saved web login, Lighthouse, the HTML checker and ZAP test the signed-in pages with the same session. The session cookie is passed in a file, not on the command line, and is replaced with `[hidden]` in every finding and in each tool's own report (Lighthouse copies request headers into its report). Each tool's HTML report opens in a browser sandbox, so it cannot read the dashboard's data.
- **Speed findings settle over two runs.** Lighthouse's speed findings follow the same two-run rule as the platform's own (below).
- **Time limits.** Each tool runs as its own process group with a time limit, and Cancel test stops it at once.

Tests started without a tool choice (the API, a quick test, projects made before the tabs existed) run every safe tool that is installed on the server. Set `DEFAULT_TOOLS=none` to run only the platform's own checks unless tools are chosen.

**Why GLV's own Opengrep rules.** The free rule packs (Semgrep's registry rules, and the opengrep-rules fork of them) are under licences that do not allow selling a service built on them: the Opengrep rules repository carries the Commons Clause and says it is for "research, testing & benchmarking". GLV sells testing to clients, so the platform ships its own rules in `rules/opengrep/`, written for it, with examples in `test/opengrep/` that each rule must find (`ruleid:`) and must not find (`ok:`). `opengrep scan --test` checks them all; the tests run it when Opengrep (or Semgrep CE, through `OPENGREP_PATH`) is installed. A project's own rules can be added in a later phase.

**Installing the tools.** The Docker image includes Lighthouse, Java for the W3C HTML checker, testssl.sh, Schemathesis 4.32.7 (in its own Python folder) and Newman 6.2.3 (in its own Node folder, so its old dependencies never load into the app). Nuclei 3.11.1, Gitleaks 8.30.1, OSV-Scanner 2.7.0 and Trivy 0.76.1 are built from source at those versions; Go checks every module against its public checksum database, which is how Trivy is installed safely after its release binaries were hijacked in March 2026 (v0.69.4 and the Docker tags 0.69.5 and 0.69.6). Opengrep 1.30.0's release binary is downloaded and its signature checked with cosign; if it cannot be verified it is left out. `docker compose` starts OWASP ZAP 2.17.0 in its own container that only the app can reach. Trivy downloads its vulnerability database on its first run and keeps it in the data volume (`trivy-cache`, about 2 GB unpacked), updating it at most once a day. Without Docker, `npm install` brings Lighthouse and the HTML checker (it needs Java); install the others yourself, run ZAP in daemon mode and set `ZAP_URL` and `ZAP_API_KEY`. The tabs show any tool that is missing as "Not available on this server", with the reason. On a server, set your own random `ZAP_API_KEY` in `.env`.

**SARIF and JUnit.** Every finished test can be downloaded from its report (Download): SARIF for GitHub code scanning, GitLab, Azure DevOps and security dashboards (code findings point at the file and line), and JUnit XML for CI test reports (a failed test per issue, a skipped test for a check that could not run). The command line writes both next to `report.json`. Schemathesis and Newman also attach their own JUnit files.

## Logged-in testing and the login vault

A project can keep one login, used for every test of that project:

| Product | Login | What happens |
| --- | --- | --- |
| Website, online store, web app, SaaS, CRM | Sign-in page, user name or email, password; optionally text that only shows once signed in, and CSS selectors for unusual forms | The agent opens the sign-in page, fills the form (one page, or email then password), checks it worked, then crawls and tests the pages behind the login. If the site signs it out, it signs in again (up to 3 times). |
| API | Bearer token, a key in a header (like `X-API-Key`), a key in the address (like `?api_key=`), or basic user name and password | Every endpoint is called with it (still GET only). The endpoints the API file marks as needing a login are also called once without it, to check they refuse strangers. |
| Source code | Access token (GitHub fine-grained token with Contents: Read, GitLab project token with read_repository) | The token is sent as a header to the repository's own host only. It never goes into the address, the command line or the clone. |

Safety while signed in:

- The agents only look. They never press buttons or submit forms, and the crawler and link checker skip links that log out or look like actions (delete, cancel, archive, approve, mark all read, switch account, and similar).
- Use a test account, not a real customer's. Two-step codes and CAPTCHAs stop automated sign-in; the report says so when that happens.
- Secrets (passwords, tokens, keys) are encrypted with AES-256-GCM in the database, only unlocked in memory while a test runs, never sent back to the dashboard, and replaced with `[hidden]` anywhere they appear in a report, the progress log or an error.

**The vault key.** Set `SECRET_KEY` in `.env` on a server (make one with `openssl rand -base64 32`, at least 16 characters). Without it, a random key is made once and kept in the data folder as `vault.key`, which is fine on your own computer but keeps the key next to the data it protects. When you add `SECRET_KEY` later, saved logins move to it on their own at the next start. If `SECRET_KEY` is lost or changed, saved logins cannot be unlocked: the project page asks for them again. Keep a copy of the key somewhere safe, like a password manager.

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

### Command line (offline and CI)

```bash
npm run scan -- scan https://example.com --pages 20 --product ecommerce
npm run scan -- api https://api.example.com/openapi.json
npm run scan -- code .                      # the folder you are in (or a repo URL or a zip)
npm run scan -- apk app-release.apk
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

Each scan uses about 1 to 2 CPU cores and 1 to 2 GB of RAM while running (an estimate, not yet measured). `SCAN_CONCURRENCY` (default 2) controls how many scans run at once.

### Processor type (Intel vs Apple Silicon / ARM)

`docker-compose.yml` builds the Intel (amd64) image by default. That runs natively on most servers (including Hostinger VPS) and on Apple Silicon Macs through Docker Desktop's Rosetta emulation, so `docker compose up -d --build` works on both without extra settings. Docker prints a warning on Apple Silicon that the image platform does not match the host; that is expected.

On an ARM Linux server (for example AWS Graviton), add `DOCKER_PLATFORM=linux/arm64` to `.env` to build the native ARM image.

If you ever see `exec /bin/sh: exec format error` during the build, Docker picked an image your machine cannot run: set `DOCKER_PLATFORM` in `.env` to match `docker version --format '{{.Server.Arch}}'` (or keep the amd64 default) and rebuild with `docker compose build --no-cache`.

## API

Every route except `/api/health` and the sign-in routes needs a signed-in session (cookie). Writes from other websites are refused.

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/auth/state` | Whether the owner account exists, and who is signed in |
| `POST` | `/api/auth/setup` | Create the owner account (first start only) |
| `POST` | `/api/auth/login`, `/api/auth/logout` | Sign in and out |
| `GET` | `/api/meta` | Product types, agents with on/off state, and the outside tools with whether each is installed on this server |
| `GET`, `POST` | `/api/projects` | List projects; create one and start its first test. Body: `{ "type": "website", "url": "https://...", "name": "", "maxPages": 20, "schedule": "off" }`. API: `specUrl` (or `file`) and an optional base `url`. Code: `repoUrl` and `branch` (or `file`). Android: `file`. Optional `login`: `{ "loginUrl", "username", "password" }` for web, `{ "authType": "bearer" \| "header" \| "query" \| "basic", "token", "paramName", "username", "password" }` for an API, `{ "token", "username" }` for code. Optional `tools`: `[{ "id": "lighthouse", "options": { "device": "desktop", "pages": "3" } }, { "id": "zap" }]` (left out: every installed safe tool). Answers show only whether a secret is saved |
| `POST` | `/api/uploads` | Upload an APK, a zip of code or an OpenAPI file as the raw body (`content-type: application/octet-stream`, file name in `x-file-name`, up to 300 MB). Returns the `file` to put in the project |
| `GET`, `PATCH`, `DELETE` | `/api/projects/:id` | Project with runs and score trend; change name, address, pages, schedule, the uploaded file (a new app build), `tools` (the tool tabs for later tests; `null` goes back to the default), or `login` (secrets left empty keep the saved ones; `null` removes it); delete (owner; a queued or running test is cancelled first) |
| `POST` | `/api/projects/:id/runs` | Re-test now |
| `GET` | `/api/runs/:id` | Full report, with live progress while it runs |
| `GET` | `/api/runs/:id/artifacts/:file` | Screenshots, and each tool's own report (`tool-*.html` opens in a sandbox, `tool-*.json` is the raw results) |
| `POST` | `/api/runs/:id/cancel` | Cancel a queued or running test (its browser or clone is stopped; issues are not changed) |
| `POST` | `/api/runs` | Quick test by address (reuses the website project for that site) |
| `GET` | `/api/issues?projectId=` | Tracked issues |
| `GET`, `PATCH` | `/api/issues/:id` | One issue with history; change status, assignee, or add a note |
| `GET` | `/api/owner/overview` | Owner numbers |
| `GET`, `PATCH` | `/api/owner/settings` | Agent switches, default pages, Claude summary |
| `GET`, `POST`, `DELETE` | `/api/owner/users` | Team accounts |
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
  agents/mobile/            the Android engine's agents
  engines/                  one runner per engine, plus the OpenAPI, zip and Android binary XML readers
  tools/index.ts            the outside tools (tool tabs); add new ones here. Runs them and merges their findings
  tools/*.ts                one file per tool: Lighthouse, W3C HTML checker, ZAP, Nuclei, testssl.sh
  targets.ts                checks what each product type needs (address, repository, upload)
  runner/scan.ts            crawler that runs the agents (Playwright)
  runner/checks/            seo, security, accessibility rules used by agents
  runner/score.ts           category and overall scores
  group.ts                  groups findings into distinct issues
  fixes.ts                  fix suggestion for every rule
  issues.ts                 issue tracker sync and regression check
  auth.ts                   owner and team sign-in, and the AUTH_DISABLED switch
  vault.ts                  encrypted logins for logged-in testing (AES-256-GCM)
  runner/login.ts           signs in through a site's own sign-in form
  scheduler.ts              daily and weekly re-tests
  ai/triage.ts              Claude summary and top fixes
  queue.ts                  in-process job queue (swap for BullMQ + Redis later)
  store.ts                  SQLite storage (node:sqlite; swap for PostgreSQL later)
  server.ts                 Fastify API, serves the dashboard
  cli.ts                    glvtest command line
web/                        React dashboard (Vite)
test/                       tests, plus a demo site, demo CRM behind a login, demo API and demo APK with deliberate bugs
```

## Testing

```bash
npm test          # unit tests + full tests of the demo site, demo API, demo code and demo APK
                  # tools.test.ts also runs each installed tool on a demo site; tools that are not installed are skipped
npm run typecheck
npm run demo-site # start the demo site on :4100 to try the dashboard
npx tsx test/fixtures/demo-api.ts  # demo API on :4200 (spec at /openapi.json)
```

## Not built yet (next steps from the plan)

- Claude exploring flows while signed in (sign-up, checkout, forms), on a test copy of the client's system
- Sign-in with a one-time code (TOTP) for test accounts that need two-step verification
- iOS app checks (IPA)
- Jira export, and AI fix pull requests
- Client connections: MCP server, Hostinger API, SSH
- Mobile app testing on devices with Appium
- More tool tabs (see the [tools plan](https://claude.ai/artifact/AUtm8C8zmdxb4qFxnTTYGD)): a permission step for tools that send changes or attacks, then ZAP active scans, k6 load tests, MobSF for Android and iOS apps, screenshot compare and PDF reports
