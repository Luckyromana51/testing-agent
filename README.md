# GLV Testing Agent

An AI testing platform by GLV Infotech Solutions. Pick what you are testing (website, online store, web app, SaaS, CRM), give it the address, and a team of specialist agents opens every page in a real browser, checks it the way a QA engineer would, and writes a report: major issues first, each with a fix you can paste. Every problem becomes a tracked issue (like Jira) that re-tests verify as fixed, or reopen when it comes back.

This follows the [architecture plan](https://claude.ai/artifact/PWZA5PZ8vKN8MpmfSUXJmE). The browser engine is built; API, source code and Android engines come next.

## The dashboard

- **New test**: pick the product type first, then enter its details. API, source code, Android and iOS show as "Next update" until their engines land.
- **Report**: score per category, then the major issues (critical and high) as cards with a fix suggestion and ready-to-paste code for Apache/LiteSpeed (Hostinger), Nginx, WordPress or PHP. Everything else is in a filterable list. The Agents tab shows what each agent found and how long it took.
- **Projects**: each site or app you test, with its score trend, open issues, test history and an automatic re-test schedule (daily or weekly).
- **Issues**: a board (Open, In progress, Fixed, Verified) across projects. Keys look like `GLV-12`. Mark an issue fixed, press Re-test, and the next run either verifies it or moves it back to Open as "Came back". Assign issues and add notes; everything is kept in the history.
- **Owner panel**: overview numbers, switch any agent on or off, add team members, set the default page count and the Claude summary.

With login on, the first time the dashboard opens it asks you to create the owner account. Do that straight after the first start, before anyone else can reach the server. While GLV is still building the system, Docker starts with login off (see [Login switch](#login-switch-auth_disabled)).

## Specialist agents

| Agent | What it checks |
| --- | --- |
| JavaScript errors | Crashes, scripts blocked by a wrong integrity hash, CSP blocks, console errors (your own code apart from third-party widgets) |
| Missing files | Images, scripts, styles and fonts that fail to load |
| Link checker | Every link; only reported after a second look a few seconds later |
| Content mistakes | Lorem ipsum, unfilled `{{tags}}`, "undefined" / "NaN" on the page, old copyright year |
| Forms | Passwords on pages without HTTPS, data sent over HTTP, fields that would not be submitted, email field type |
| Accessibility (WCAG 2.2) | axe-core rules for WCAG 2.0 to 2.2, A and AA |
| On-page SEO | Title, description, headings, canonical, viewport, noindex, Open Graph |
| Structured data | JSON-LD syntax errors; Product data on store product pages |
| Duplicate titles | Pages sharing a title or description |
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

### How it avoids false alarms

- The same problem on many pages (for example in a shared header) is one issue, listed with every page it affects. Scores count each distinct issue once, weighted by how many pages it is on.
- A page or link that answers 429, 502, 503 or 504 is tried again a few seconds later before anything is reported, because that is usually rate limiting, not a broken page. Internal links are checked a second time in a real browser.
- Links to social networks (LinkedIn, Facebook, Instagram, X, WhatsApp and others) are skipped, because they block automated checks. Other sites that refuse the check are listed as info, not as broken.
- "Failed to load resource" console lines are not counted again on top of the broken resource itself. Console errors from third-party scripts are kept apart and rated low.
- Speed uses Google's Core Web Vitals thresholds. It is one lab measurement from the testing server, so real visitors' numbers can differ.

## Quick start

Needs Node 22.13 or newer.

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
# or after npm run build:
node dist/cli.js scan https://example.com --fail-on high
```

`--fail-on high` exits with code 1 if anything high or critical is found, so it can block a deploy in GitHub Actions or GitLab CI. The full report is written to `glvtest-report/report.json` with screenshots alongside it.

## Run on GLV servers (Docker)

```bash
cp .env.example .env    # add ANTHROPIC_API_KEY
docker compose up -d --build
```

The dashboard runs on port 4000. Scan results and screenshots are kept in the `agent-data` volume. On a server, turn login on first (below), then put it behind your usual reverse proxy (Nginx or Caddy) with HTTPS and set `TRUST_PROXY=1`.

### Login switch (AUTH_DISABLED)

While GLV builds and tests the system on its own computers, `docker compose` starts with **login off** (`AUTH_DISABLED=1`): no owner account screen and no sign-in, and everyone who opens the dashboard is the owner. The sidebar shows "Login is off for local use", and the server log prints a warning at start.

As a safety net, with login off the server only answers visits from its own computer and local network (including Docker's network on a Mac). Anything from the internet, directly or through a proxy that passes the visitor's address, gets "Login is turned off on this server". Do not rely on that on a real server.

**Before putting it on a server, turn login on:**

1. In `.env`, set `AUTH_DISABLED=0` (add the line if it is missing).
2. Optional: set `OWNER_EMAIL` and `OWNER_PASSWORD` in `.env` to create the owner account at start. Otherwise the dashboard asks for it the first time it opens.
3. Restart: `docker compose up -d`.
4. Check: opening the dashboard now shows the sign-in or owner account screen, and the sidebar no longer says "Login is off".

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
| `GET` | `/api/meta` | Product types and agents, with on/off state |
| `GET`, `POST` | `/api/projects` | List projects; create one and start its first test. Body: `{ "type": "website", "url": "https://...", "name": "", "maxPages": 20, "schedule": "off" }` |
| `GET`, `PATCH`, `DELETE` | `/api/projects/:id` | Project with runs and score trend; change name, address, pages, schedule; delete (owner) |
| `POST` | `/api/projects/:id/runs` | Re-test now |
| `GET` | `/api/runs/:id` | Full report, with live progress while it runs |
| `POST` | `/api/runs` | Quick test by address (reuses the website project for that site) |
| `GET` | `/api/issues?projectId=` | Tracked issues |
| `GET`, `PATCH` | `/api/issues/:id` | One issue with history; change status, assignee, or add a note |
| `GET` | `/api/owner/overview` | Owner numbers |
| `GET`, `PATCH` | `/api/owner/settings` | Agent switches, default pages, Claude summary |
| `GET`, `POST`, `DELETE` | `/api/owner/users` | Team accounts |
| `GET` | `/api/health` | Health check |

Local and private addresses (localhost, 10.x, 192.168.x and so on) are blocked by default so the server cannot be used to probe your internal network. Set `ALLOW_PRIVATE_TARGETS=1` to test internal staging sites. The check works on the address as typed; a public hostname that resolves to a private IP is not yet blocked.

## Project layout

```
src/
  agents/registry.ts        every specialist agent; add new ones here
  agents/web/               the browser engine's agents
  runner/scan.ts            crawler that runs the agents (Playwright)
  runner/checks/            seo, security, accessibility rules used by agents
  runner/score.ts           category and overall scores
  group.ts                  groups findings into distinct issues
  fixes.ts                  fix suggestion for every rule
  issues.ts                 issue tracker sync and regression check
  auth.ts                   owner and team sign-in
  scheduler.ts              daily and weekly re-tests
  ai/triage.ts              Claude summary and top fixes
  queue.ts                  in-process job queue (swap for BullMQ + Redis later)
  store.ts                  SQLite storage (node:sqlite; swap for PostgreSQL later)
  server.ts                 Fastify API, serves the dashboard
  cli.ts                    glvtest command line
web/                        React dashboard (Vite)
test/                       tests, plus a demo site with deliberate bugs
```

## Testing

```bash
npm test          # unit tests + a full scan of the bundled demo site
npm run typecheck
npm run demo-site # start the demo site on :4100 to try the dashboard
```

## Not built yet (next steps from the plan)

- API engine (OpenAPI), source code engine (secrets, vulnerable packages, risky code), Android APK checks
- Testing pages behind a login for SaaS and CRM, and Claude exploring flows (sign-up, checkout, forms)
- Jira export, and AI fix pull requests
- Client connections: MCP server, Hostinger API, SSH
- Mobile app testing on devices with Appium
