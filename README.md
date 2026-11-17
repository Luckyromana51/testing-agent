# GLV Testing Agent

An AI testing agent by GLV Infotech Solutions. Give it a website address and it opens every page in a real browser, checks it the way a QA engineer would, and writes a report with a score, every issue found, screenshots, and (with Claude) a plain-English summary of the fixes that matter most.

This is the first MVP slice from the [architecture plan](https://claude.ai/artifact/PWZA5PZ8vKN8MpmfSUXJmE): the browser engine for web apps, SaaS, CRM and websites.

## What it checks

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
npm start                          # dashboard at http://localhost:4000
```

For development with hot reload: `npm run dev` (API on :4000, dashboard on :5173).

### Turn on the Claude summary

Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`. Each finished scan then gets a short summary and the top 3 to 5 fixes, written by Claude (`claude-opus-5-5` by default; change it with `CLAUDE_MODEL`). Without a key, scans still run; only the summary is skipped.

### Command line (offline and CI)

```bash
npm run scan -- scan https://example.com --pages 20
# or after npm run build:
node dist/cli.js scan https://example.com --fail-on high
```

`--fail-on high` exits with code 1 if anything high or critical is found, so it can block a deploy in GitHub Actions or GitLab CI. The full report is written to `glvtest-report/report.json` with screenshots alongside it.

## Run on GLV servers (Docker)

```bash
cp .env.example .env    # add ANTHROPIC_API_KEY
docker compose up -d --build
```

The dashboard runs on port 4000. Scan results and screenshots are kept in the `agent-data` volume. Put it behind your usual reverse proxy (Nginx or Caddy) with HTTPS and a login, because the dashboard has no sign-in yet.

Each scan uses about 1 to 2 CPU cores and 1 to 2 GB of RAM while running (an estimate, not yet measured). `SCAN_CONCURRENCY` (default 2) controls how many scans run at once.

### Processor type (Intel vs Apple Silicon / ARM)

`docker-compose.yml` builds the Intel (amd64) image by default. That runs natively on most servers (including Hostinger VPS) and on Apple Silicon Macs through Docker Desktop's Rosetta emulation, so `docker compose up -d --build` works on both without extra settings. Docker prints a warning on Apple Silicon that the image platform does not match the host; that is expected.

On an ARM Linux server (for example AWS Graviton), add `DOCKER_PLATFORM=linux/arm64` to `.env` to build the native ARM image.

If you ever see `exec /bin/sh: exec format error` during the build, Docker picked an image your machine cannot run: set `DOCKER_PLATFORM` in `.env` to match `docker version --format '{{.Server.Arch}}'` (or keep the amd64 default) and rebuild with `docker compose build --no-cache`.

## API

| Method | Path | What it does |
| --- | --- | --- |
| `POST` | `/api/runs` | Start a scan. Body: `{ "url": "https://...", "maxPages": 10, "checkLinks": true, "accessibility": true }` |
| `GET` | `/api/runs` | List recent scans |
| `GET` | `/api/runs/:id` | Full report for one scan, including live progress while it runs |
| `DELETE` | `/api/runs/:id` | Delete a scan |
| `GET` | `/api/runs/:id/artifacts/:file` | Screenshot files |
| `GET` | `/api/health` | Health check; shows whether the Claude summary is on |

Local and private addresses (localhost, 10.x, 192.168.x and so on) are blocked by default so the server cannot be used to probe your internal network. Set `ALLOW_PRIVATE_TARGETS=1` to test internal staging sites. The check works on the address as typed; a public hostname that resolves to a private IP is not yet blocked.

## Project layout

```
src/
  runner/scan.ts            crawler and per-page checks (Playwright)
  runner/checks/            seo, security, accessibility rules
  runner/score.ts           category and overall scores
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

- Claude exploring flows and writing saved Playwright tests (login, checkout, forms)
- Code engine: unit tests, Semgrep, Gitleaks, Trivy, and AI fix pull requests
- Client connections: MCP server, Hostinger API, SSH
- Logins, projects and multiple users on the dashboard
- Mobile app testing with Appium (phase 2)
