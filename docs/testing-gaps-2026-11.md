# GLV Testing Agent: worldwide gap report

Date: 22 November 2026. Checked against branch `claude/project-thread-95q1m0` (PR #28, the newest everything-branch).

This report lists every kind of software testing, tool or capability we found in the industry that the GLV testing agent does **not** have yet, or only has in part. Every suggested tool is open source and can run inside our own Docker image or on GLV's servers, following the in-house rule (no outside paid services).

How to read it:

- **P1** = build next. Clients ask for it, it is cheap to add, or a law now requires it.
- **P2** = strong value, more work.
- **P3** = niche, or only for certain clients.
- **Partial** = we have some of it; the gap is the missing part.
- Licence notes are given where a tool's licence could matter for a commercial service.

---

## 1. What we already have (short inventory)

So the gaps below make sense, this is what the branch already covers.

- **Product types:** website, online store, web app, SaaS, CRM, API (REST, GraphQL, SOAP, gRPC, WebSocket, Pact), source code, Android (APK/AAB), iOS (IPA).
- **Own agents:** about 190 checks across web (links, JS errors, WCAG 2.2 A/AA, keyboard, zoom, text spacing, motion, screen reader view, UI overlap/cut text, consent gates, cookies, cache, privacy, HTTPS, mixed content, security headers, CSP, SRI, CORS, exposed files, WordPress, speed, slow network, tablet/phone, cross-browser Chromium/Firefox/WebKit, locale/RTL, PWA, SEO site audit), store (checkout, policies, product data), app (private pages, private cache, data in URL), API (contract, negative, OWASP API, tokens, writes, versions, rate limits), code (secrets, packages, taint, risky code, AI code rules, containers, tests), Android and iOS static checks.
- **Bundled tools:** Lighthouse, W3C vnu, ZAP passive and active, Nuclei, testssl.sh, Schemathesis, Newman, Gitleaks, Opengrep (40 GLV rules), OSV-Scanner, Trivy, k6, JMeter, Appium + Android emulator, Mailpit, Grafana/InfluxDB.
- **Modules:** inspect screen, visual compare, user journeys, app explorer, webhook inbox, journey watch, uptime watch, RUM (real visitor speed), own checks folder, bring-your-own Playwright tests, manual checklists and rounds, issues board with regression, master control, AI triage and fix PRs.
- **Attack/hack agent:** injection, SSRF, IDOR/access, sessions, JWT, headers, exposed files, attack chains, under written permission only.
- **Mac helper:** Safari, VoiceOver, iOS Simulator.
- **Client connections:** SSH server checks (updates, disks, memory, open ports, SSH settings), Hostinger account checks (domains, SPF/DMARC, backups), MCP server checks.

The built-in "Testing types" handbook (`src/handbook.ts`) already marks about 45 types as **manual only**. Those are included below as gaps where a tool could automate them.

---

## 2. Top 15 to build next (summary)

| # | Gap | Why first | Main open-source tools |
|---|-----|-----------|------------------------|
| 1 | Live AI chatbot / LLM red-teaming | Most GLV clients now add AI chat; we only scan AI *code*, never talk to the live bot | garak, promptfoo, PyRIT, DeepTeam |
| 2 | Hacked-site / malware / SEO-spam detection | Hostinger and WordPress clients get hacked often; no check today | ClamAV, YARA rules, own cloaking check |
| 3 | Domain, DNS and email security for any domain | Only Hostinger accounts get SPF/DMARC today | checkdmarc, dnstwist, dnsx, own DKIM/MTA-STS/DNSSEC checks |
| 4 | Subdomain takeover and attack-surface discovery | Classic real-world break-in, cheap to detect | subfinder, dnsx, naabu, httpx, own fingerprint list |
| 5 | GEO / AI search readiness (ChatGPT, Gemini, Perplexity visibility) | New SEO battleground; GLV sells SEO | own llms.txt, AI-crawler robots, answer-ready content checks |
| 6 | Real phone farm (BrowserStack replacement for real devices) | Emulators miss real-device bugs | DeviceFarmer (STF), go-ios, Appium |
| 7 | Mobile dynamic security (MASVS) | Static only today; pinning, root checks, storage at runtime untested | Frida, objection, MobSF (dynamic), mitmproxy |
| 8 | Out-of-band (blind) attack detection | Blind SSRF/XSS/injection only show via callbacks | self-hosted Interactsh |
| 9 | Mutation testing | Handbook marks it manual; tells clients if their tests really work | Stryker, PIT, Infection, mutmut |
| 10 | PDF and document accessibility | EAA (EU) and India's IS 17802 cover documents; we only list PDF links | veraPDF (PDF/UA), own checks |
| 11 | India compliance pack (DPDP Rules, GIGW 3.0, CERT-In, RBI) | GLV's home market; laws now in force | own rules on existing agents |
| 12 | Plain-English test writing + self-healing steps | What Mabl, Testim, Momentic sell; we have recorder and journeys | Playwright codegen + Claude, own locator fallback |
| 13 | Old and other browser versions matrix | BrowserStack's main selling point | Selenium Grid 4, versioned browser images, Edge for Linux |
| 14 | Dark patterns and consumer-law checks | EU DSA, India's dark pattern guidelines (CCPA 2023) | own detectors on store/SaaS flows |
| 15 | Traffic record-and-replay API tests | Turns real traffic into regression tests fast | Keploy, GoReplay, mitmproxy |

---

## 3. Full gap list by area

### 3.1 AI and LLM application testing

Today: static code rules only (`code.ai`, rules like `ai:prompt-injection`). Nothing talks to a live AI feature. The handbook lists 10 AI types as manual.

| Gap | Priority | What it is | Why it matters for GLV clients | In-house tools |
|-----|----------|-----------|-------------------------------|----------------|
| Live chatbot red-teaming | **P1** | Send thousands of attack prompts (jailbreaks, prompt injection, data leaks, system-prompt theft) to the client's real chatbot | AI chat on websites and CRMs is now common; a leaking bot is a headline risk | garak (Apache-2.0), promptfoo (MIT), PyRIT (MIT), DeepTeam (Apache-2.0) |
| OWASP LLM Top 10 (2025) and OWASP Agentic Top 10 (2026) reports | **P1** | Map every AI finding to those lists, like we do for OWASP Top 10 | Clients and auditors ask for this mapping | own mapping on top of the red-team results |
| Indirect prompt injection | **P1** | Plant hidden instructions in a page, PDF, email or CRM record the AI reads, and see if it obeys | Agents that read customer data are the main attack path in 2026 | garak / promptfoo plugins, own planted fixtures |
| Agent and tool-use safety | P2 | Check an AI agent cannot run tools, send email or change data beyond what it should (excessive agency, tool misuse) | WhatsApp CRM bots and booking bots act on real data | promptfoo agent plugins, own harness in a test copy |
| MCP server security | P2 (Partial) | Tool poisoning, over-broad tools, missing auth on MCP servers | We already check MCP connections; add attack tests | own checks, mcp-scan style rules |
| RAG answer quality | P2 | Correct answers from the client's documents, with sources, no made-up facts | Support bots that make things up cost clients money | Ragas (Apache-2.0), DeepEval (Apache-2.0) |
| Hallucination, consistency, toxicity, bias | P2 | Same question many times, sensitive groups, harmful output | Brand safety; India/EU rules on fairness | DeepEval, promptfoo, lm-evaluation-harness (MIT), Detoxify (Apache-2.0) |
| AI regression and drift | P2 | A fixed question set runs on a schedule; alert when answers get worse after a model or prompt change | Model upgrades silently change behaviour | promptfoo eval + our scheduler and trends |
| Cost and speed of AI calls | P3 | Tokens per answer, time to first word, timeouts | Runaway AI bills | own measurement in the harness |
| Model file security | P3 | Unsafe pickles and backdoored model files in the repo | Clients downloading models from the internet | ModelScan (Apache-2.0), fickling (LGPL-3) |
| Voice bot testing | P3 | Speech in, speech out, accents, noise | Voice IVR/agents for clients | Whisper (MIT), Piper TTS (MIT) to generate test speech |

### 3.2 Security (beyond what the attack agent does)

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| Hacked site / malware / SEO spam | **P1** | Find injected scripts, hidden casino/pharma links, cloaking (different page for Googlebot), web shells, defacement | Very common on WordPress/Hostinger; clients lose Google ranking overnight | ClamAV (GPL-2), YARA (BSD-3) with open rule sets, own Googlebot-vs-browser compare, PHP web-shell rules via SSH |
| DNS and email security for any domain | **P1** (Partial: Hostinger only) | SPF, DKIM, DMARC, MTA-STS, TLS-RPT, BIMI, DNSSEC, CAA, dangling records | Fake emails in the client's name; works for every client, not only Hostinger | checkdmarc (Apache-2.0), dnsx (MIT), own checks |
| Lookalike domains | P2 | Typo domains registered by phishers (glvinfotech-solutions.com etc.) | Brand protection service GLV can sell | dnstwist (Apache-2.0) |
| Subdomain takeover | **P1** | A subdomain still points to a deleted GitHub Pages/Heroku/S3 site anyone can claim | Real break-ins; easy to find | subfinder (MIT), dnsx, own fingerprint list (like can-i-take-over-xyz) |
| Attack surface discovery | **P1** | Find all subdomains, open ports and forgotten servers of a client | You can't test what you don't know exists | subfinder, naabu (MIT), httpx (MIT), katana (MIT). Avoid bundling nmap: its licence limits commercial redistribution |
| Out-of-band (blind) detection | **P1** | A GLV callback server catches blind SSRF, XXE, blind XSS, log4shell-type hits | Many real holes only show this way; ZAP and Nuclei can use it | Interactsh server (MIT), self-hosted on a GLV domain |
| Race conditions | P2 | Send the same coupon/withdrawal/vote at the exact same moment | Stores and wallets lose money; handbook lists it but no check | own single-packet sender (HTTP/2) in a test copy |
| HTTP request smuggling, cache poisoning, host-header attacks | P2 | Front-end and back-end servers read a request differently | Affects sites behind CDNs and load balancers | own probes (like smuggler, MIT) under permission |
| OAuth / OpenID / SAML flaws | P2 | Redirect URI tricks, missing state/PKCE, SAML signature wrapping | "Sign in with Google" and SSO in SaaS/CRM | own checks, ZAP add-ons |
| File upload attacks | P2 (Partial) | Upload web shells, SVG with script, huge files, zip bombs, EXIF location left in photos | CRMs and portals take uploads | own payload set (data-changing: test copy only) |
| Business logic tests | P2 | Negative prices, skipping checkout steps, changing quantities, coupon stacking | Biggest real losses in e-commerce | own store flow checks on a test copy |
| Network vulnerability scan of servers | P2 (Partial via SSH) | Known CVEs on every open service of the client's servers | Clients with VPS/dedicated servers | Greenbone/OpenVAS (GPL), Nuclei network templates |
| Cloud account posture | P2 | Public S3 buckets, open security groups, no MFA, logging off in AWS/GCP/Azure | Clients on cloud | Prowler (Apache-2.0), ScoutSuite (GPL-2) with client's read-only keys |
| Kubernetes and Docker host checks | P3 | CIS benchmarks, risky pods, runtime alerts | Larger clients | kube-bench (Apache-2.0), Kubescape (Apache-2.0), Dockle (Apache-2.0), Falco (Apache-2.0) |
| Server hardening score | P2 (Partial via SSH) | Full CIS-style audit of Linux servers | Our SSH checks cover basics only | Lynis (GPL-3), OpenSCAP (LGPL) |
| Post-quantum readiness | P3 | Does the server's TLS offer ML-KEM hybrid key exchange; crypto inventory in code | Banks and governments now ask for PQC plans | OpenSSL 3.5+ `-groups X25519MLKEM768` probe, own code rules for weak crypto |
| security.txt and vulnerability disclosure | **P1** | `/.well-known/security.txt` present and valid; a way to report holes | EU Cyber Resilience Act reporting started 11 Sept 2026; cheap check | own check |
| Supply chain depth | P2 (Partial: OSV includes malicious packages) | Reachability (is the vulnerable function actually used), typosquat names, install scripts, unpinned GitHub Actions | Cuts false alarms; catches poisoned packages | OSV-Scanner call analysis, zizmor (MIT) for GitHub Actions, own install-script rules |
| SBOM and licence compliance | P2 (Partial: Trivy licences, mobile CycloneDX) | Full SBOM for any repo; flag GPL/AGPL in closed products | CRA requires SBOMs for products sold in EU; clients ship apps | Syft (Apache-2.0), ScanCode Toolkit (Apache-2.0), CycloneDX |
| More SAST languages and engines | P2 | Deeper rules for Python, PHP, Go, Java, Kotlin, Swift, Dart/Flutter | GLV builds Flutter and React Native; no Dart rules today | Opengrep (more own rules), Bandit, gosec, SpotBugs + FindSecBugs, Joern (Apache-2.0). Avoid CodeQL (licence bars commercial closed-source use) and Brakeman (non-OSS licence) |
| IaC deep checks | P3 (Partial: Trivy config) | Terraform, CloudFormation, Helm, Dockerfile rules | DevOps clients | Checkov (Apache-2.0), KICS (Apache-2.0), Hadolint (GPL-3) |
| IAST | P3 | An agent inside the app watches real data flow during tests | Handbook marks it manual | OpenTelemetry-based taint is research-grade; skip for now |

### 3.3 Mobile apps

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| Real phone farm | **P1** | GLV's own rack of real Android phones and iPhones, used remotely from the tool | BrowserStack/Sauce replacement; real cameras, GPUs, OEM skins (Xiaomi, Samsung, Vivo are big in India) | DeviceFarmer/STF (Apache-2.0), go-ios (MIT) for iPhones on Linux, Appium |
| Dynamic security (OWASP MASVS/MASTG) | **P1** | Run the app and check data at rest, SSL pinning, root/jailbreak detection, keystore use, logs, clipboard | Static checks miss most real mobile holes | Frida (wxWindows licence), objection (GPL-3), MobSF dynamic (GPL-3), mitmproxy (MIT) |
| Flutter and React Native specifics | P2 | Dart snapshot secrets, JS bundle secrets, Hermes bytecode, OTA update (CodePush/Expo) safety | GLV builds in both | blutter/reFlutter for Dart, hermes-dec, own rules |
| App performance on device | P2 | Start time, frame drops (jank), memory, battery drain, app size over releases | Users uninstall slow apps | Android `dumpsys gfxinfo`/Perfetto (Apache-2.0), Xcode Instruments via Mac helper |
| Maestro / Detox flows | P2 | Simpler app journeys than Appium, readable YAML | Faster to write client app tests | Maestro (Apache-2.0), Detox (MIT) |
| Deep links and app links | P2 (Partial: static) | Open every deep link, check it lands right and can't be hijacked | Marketing links and login links break | adb/simctl + own runner |
| In-app purchases and subscriptions | P3 | Sandbox purchase, restore, cancel, refund | Subscription apps | Google Play test tracks, StoreKit test config via Mac helper |
| Push notifications end to end | P3 (Manual today) | Send a test push and confirm it arrives and opens the right screen | CRM apps live on push | own FCM/APNs test sender with client keys |
| Wear OS / watchOS / Android TV / Android Auto | P3 | Other device types | Few clients | emulators + Appium |
| Store-listing checks | P3 | Screenshots sizes, privacy labels match the app, data safety form | Store rejections delay launches | own checks against the uploaded app |

### 3.4 Browsers, devices and visual (BrowserStack / Applitools equivalents)

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| Browser version matrix | **P1** | Test on older Chrome/Firefox/Edge versions, not only today's | Clients' customers use old phones and browsers | Selenium Grid 4 (Apache-2.0) with versioned browser images, Microsoft Edge for Linux, Playwright old builds |
| Samsung Internet, Opera, UC, in-app browsers (WhatsApp, Instagram, Facebook webviews) | P2 | Browsers big in India that behave differently | Many Indian users open links inside WhatsApp | real phone farm (3.3), Android emulator with those apps |
| Windows-only browsers and fonts | P3 | Edge on Windows, Windows font rendering | Corporate clients | a Windows VM on GLV hardware with the Mac-helper style agent |
| Visual AI diff | P2 (Partial: pixel compare) | Ignore harmless shifts, catch real layout breaks; layout-aware compare | Fewer false alarms than pixel diff | own DOM-box compare, SSIM (open), odiff (MIT) |
| Component/storybook visual tests | P3 | Test each UI component in all states | Design-system clients | Storybook test runner (MIT) + our visual compare |
| Colour-blind and low-vision simulation | P2 | Show pages as seen with deuteranopia, protanopia, blur | Easy demo value; finds colour-only meaning | own CSS/SVG filters in inspect screen |
| Print and PDF export layout | P3 | Invoices and tickets print correctly | Billing/CRM | Playwright print-to-PDF + visual compare |

### 3.5 Accessibility (beyond WCAG 2.2 AA web pages)

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| PDF / document accessibility | **P1** | Tagged PDF, reading order, alt text, PDF/UA; Word/Excel files too | European Accessibility Act (in force since June 2025) and EN 301 549 cover documents; GIGW 3.0 in India | veraPDF (GPL/MPL) for PDF/UA, own checks |
| India standards: GIGW 3.0 and IS 17802 | **P1** | Indian government and public-sector accessibility rules | GLV can sell to Indian government/PSU projects | own mapping on top of WCAG results |
| EN 301 549 / EAA report and VPAT/ACR | P2 | Report formatted as an EU conformance or US VPAT document | Clients selling to EU/US need it | own report template from WCAG tab |
| WCAG AAA and cognitive accessibility | P2 (Partial: readability) | Plain language, consistent help, no time limits, COGA patterns | Wider audience; WCAG 3 direction | own checks, readability formulas for Hindi and English |
| Real NVDA / TalkBack runs | P2 (Partial: VoiceOver via Mac) | Real screen readers, not only the accessibility tree | Most blind users on Windows use NVDA; Android uses TalkBack | NVDA (GPL-2) in a Windows VM, TalkBack on emulator/phone farm |
| Video and audio accessibility | P3 (Partial: captions) | Caption accuracy, audio description, transcripts | Media and e-learning clients | Whisper (MIT) to compare spoken words vs captions |
| Second accessibility engine | P3 | A second rule engine to catch what axe misses | Fewer misses | IBM Equal Access checker (Apache-2.0) |

### 3.6 SEO, GEO and marketing (Ahrefs / SEMrush equivalents)

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| GEO / AI search readiness | **P1** | llms.txt, AI crawler access (GPTBot, ClaudeBot, PerplexityBot, Google-Extended) in robots.txt, answer-ready content, entity and author signals, schema for AI | AI answers now take clicks from Google; GLV sells SEO | own checks; many open GEO auditors exist to borrow ideas from |
| AI answer visibility tracking | P3 | Does ChatGPT/Gemini/Perplexity mention the client for key questions | Clients ask "are we visible in AI?" | Needs those AI services; only possible with the client's own API keys, so outside the in-house rule unless Lucky approves |
| Backlink index | P3 | Who links to the client | Ahrefs' core feature | Common Crawl's free web graph, loaded on GLV servers (large disk, monthly refresh). It is open data, not a service. Smaller than Ahrefs but real |
| Keyword and rank tracking | P3 | Where the client ranks for a keyword | Core SEO report | Needs Google results; scraping breaks Google's terms. Clients can connect their own Search Console. Mark "cannot fully copy" |
| Local SEO | P2 | Name/address/phone same everywhere, LocalBusiness schema, map embed, Google Business info on site | Small-business clients | own checks |
| hreflang and international SEO depth | P2 (Partial) | Return links, language codes, x-default | Multi-country clients | own checks extending seo-site |
| Image, video and news SEO | P3 | Image sitemaps, video schema, Discover rules | Media clients | own checks |
| JavaScript SEO render diff | P2 (Partial: rendered HTML) | What Google sees before vs after JS for every page | React/Next sites lose content | existing rendered-html agent, extend to full diff |
| Log file SEO | P3 | Read server logs to see what Googlebot really crawls | Big sites | own log parser via SSH, GoAccess (MIT) |
| Social preview checks | P2 | Open Graph/Twitter cards, WhatsApp link preview image size | Links are shared on WhatsApp a lot in India | own checks with a preview render |

### 3.7 Performance and reliability

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| Testing from other regions | P2 | Speed from Mumbai, Singapore, Frankfurt, US | Clients have customers abroad; CDN issues show only remotely | small GLV-owned VPS "probes" running our agent; sitespeed.io (MIT) |
| Frontend deep profiling | P2 | Long tasks, memory leaks in single-page apps, bundle size and unused JS trends | SPAs get slower each release | Chrome DevTools Protocol traces, Unlighthouse (MIT), own bundle-size check |
| Backend profiling and slow queries | P2 | Which API or SQL query is slow during a load test | Load tests say "slow" but not why | pg_stat_statements / MySQL slow log via SSH, Pyroscope (AGPL-3, keep separate service) |
| Distributed tracing tests | P3 | Test that a request passes all microservices within time | Microservice clients | OpenTelemetry Collector, Jaeger (Apache-2.0), Tracetest (MIT) |
| Chaos testing on servers | P2 (Phones only) | Kill a service, add network delay, fill disk, and see if the app survives | Handbook says server chaos is manual | Toxiproxy (MIT), Pumba (Apache-2.0), Chaos Mesh / LitmusChaos (Apache-2.0) on a test copy under permission |
| Failover, backup restore and DR drills | P3 (Manual) | Restore last night's backup to a test server and run the tests on it | Many clients never test backups | own runbook via SSH: restore DB to a temp container, run smoke tests |
| Video/streaming and WebRTC quality | P3 | Start time, buffering, call quality | Telehealth, e-learning | own Playwright WebRTC stats checks |
| Carbon / sustainability | P3 | CO2 per page view | EU clients and ESG reports | CO2.js (Apache-2.0) on our speed data |

### 3.8 Functional and test automation

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| Plain-English test writing | **P1** | "Log in, add a red shirt to cart, check total" becomes a saved journey | What Mabl, Testim, QA Wolf, Momentic sell; huge time saver | Claude + Playwright codegen + our journeys |
| Self-healing steps | **P1** | When a button's id changes, the step finds it by text/role instead of failing | Fewer broken tests after each client release | own locator fallback chain in journeys |
| Export tests as code | P2 | Download journeys as Playwright/Appium test files the client can keep | Clients want to own their tests | own exporter |
| Record-and-replay API tests | **P1** | Record real API traffic once, replay it as regression tests with mocks | Fast API coverage for CRMs | Keploy (Apache-2.0), GoReplay, mitmproxy (MIT) |
| Pairwise and combinatorial for forms | P2 (Manual) | Pick the smallest set of input combinations that covers all pairs | Handbook marks pairwise manual | PICT (MIT), allpairspy (MIT) |
| Mutation testing | **P1** (Manual) | Change the code slightly and check the client's tests notice | Shows if the client's tests are real | Stryker (Apache-2.0), PIT (Apache-2.0), Infection (BSD-3), mutmut (BSD) |
| Running the client's own unit tests and coverage | P2 (Partial: BYO Playwright) | Run `npm test`, `pytest`, `phpunit`, `flutter test` in a sandbox, read coverage | Turns "code has tests" into "tests pass, 64% covered" | the existing code engine + language images, lcov/cobertura readers |
| Property-based and coverage-guided fuzzing of code | P3 (API only today) | Generate inputs to crash parsers and functions | Finds crashes in core libraries | fast-check (MIT), Hypothesis (MPL-2.0), Jazzer (Apache-2.0), AFL++ (Apache-2.0) |
| API mocks and service virtualisation | P2 | Fake a payment gateway or third-party API for tests | Test checkout without real money | WireMock (Apache-2.0), Prism (Apache-2.0), Microcks (Apache-2.0) |
| API breaking-change and lint | P2 (Partial: api.changes, lint) | Diff two OpenAPI files, flag breaking changes; style rules | Mobile apps break when APIs change | oasdiff (Apache-2.0), Spectral (Apache-2.0) |
| Payment gateway test flows | P2 (Manual) | Razorpay, PayU, Stripe, PayPal test modes, UPI collect/intent, failure and refund paths | India stores live on Razorpay/UPI | own journeys using each gateway's test cards/UPI IDs |
| Email template testing | P2 | HTML email renders in Gmail/Outlook widths, dark mode, links, unsubscribe, spam score | CRM and store emails | Mailpit (have it) + SpamAssassin/rspamd (Apache-2.0) score + own render checks |
| SMS / WhatsApp message tests | P3 | Template variables, length, DLT template IDs (India), opt-out words | WhatsApp CRM is GLV's own product | own checks on the webhook inbox |
| Test management and traceability | P3 (Partial) | Requirements to test cases to results; release sign-off | Enterprise clients ask for it | extend manual checklists; Kiwi TCMS (GPL-2) ideas |
| Jira / Linear export | P3 (planned) | Push issues to client trackers | Already on the "later" list | own exporter with client tokens |

### 3.9 Data, databases and back-end systems

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| Read-only database health check (via SSH) | P2 | Missing indexes, no foreign keys, plain-text passwords, huge tables, slow queries, backups present | CRM databases decay; we already have SSH | own read-only SQL, SchemaSpy (LGPL) diagram, sqlfluff (MIT) for SQL files |
| Stored procedures and triggers | P3 (Manual) | Unit tests for database code | Older ERP/CRM clients | pgTAP, tSQLt (Apache-2.0) |
| Data quality and ETL | P3 (Manual) | Nulls, duplicates, ranges, freshness in data pipelines | Analytics clients | Great Expectations (Apache-2.0), Soda Core (Apache-2.0), dbt tests |
| Message queues and events | P3 (Manual) | Messages arrive once, in order, dead-letter handled | Microservice clients | own checks with Kafka/RabbitMQ admin APIs, AsyncAPI validators (Apache-2.0) |
| Data reconciliation | P3 (Manual) | Totals match across two systems (CRM vs accounting) | Billing errors | own scenario type comparing two API answers |

### 3.10 Compliance, privacy and law packs

| Gap | Priority | What it is | Why it matters | In-house tools |
|-----|----------|-----------|----------------|----------------|
| India DPDP Rules pack | **P1** (Partial: privacy, id-numbers) | Consent notice in plain language and Indian languages, consent withdrawal as easy as giving, children's data, data-breach contact, grievance officer | DPDP Rules notified Nov 2025, phased in by 2027; every Indian client | own rules on existing privacy/consent agents |
| CERT-In / RBI / SEBI pack | P2 | Log retention, NTP time sync, incident contact, payment data stored in India | Fintech and regulated clients | SSH checks + web checks |
| Dark patterns | **P1** | Fake timers, pre-ticked boxes, hidden costs added at checkout, hard-to-cancel subscriptions, confirm-shaming | India's 2023 dark-pattern guidelines list 13 patterns; EU DSA | own detectors on store and SaaS flows |
| GDPR cookie consent proof | P2 (Partial: cookies, consent) | Do tags/trackers fire *before* consent; does "Reject" really reject | Most common GDPR fine | extend cookies agent: compare network before/after reject |
| PCI DSS 4.0 script controls | P2 (Partial: checkout scripts) | Inventory and change alerts for every script on payment pages (req. 6.4.3, 11.6.1) | Required since March 2025 for stores | extend store.checkout + journey watch to alert on new scripts |
| HIPAA / health data | P3 | PHI in URLs, logs, analytics tags | Health clients | own rules |
| SOC 2 / ISO 27001 evidence | P3 | Turn our scans into control evidence | SaaS clients selling to enterprises | own report template |
| EU Cyber Resilience Act readiness | P2 | SBOM, vulnerability handling, security.txt, update policy | Reporting duties started Sept 2026; full rules Dec 2027 | combine SBOM, security.txt, update checks |
| Terms/privacy page change watch | P3 | Alert when legal pages change | Contract and audit trail | journey watch on those pages |

### 3.11 Other product types we cannot test yet

| Gap | Priority | What it is | In-house tools |
|-----|----------|-----------|----------------|
| Desktop apps (Electron, Tauri, Windows, macOS) | P3 | GLV or clients shipping desktop apps | Playwright Electron mode, tauri-driver, WinAppDriver/Appium Windows driver in a Windows VM, Mac helper |
| Browser extensions | P3 | Manifest permissions, content-script risks | own static checks + Playwright with extension loaded |
| WordPress/Shopify plugins and themes | P2 (Partial: wordpress agent) | Known-vulnerable plugin versions | Wordfence Intelligence free vulnerability feed (check its terms), WPScan open database is limited without its paid API |
| Smart TV, kiosk, POS | P3 | Rare for GLV now | Tizen/webOS emulators |
| IoT / BLE / MQTT | P3 | Rare for GLV now | own MQTT checks, Mosquitto test broker |
| Games | P3 | Out of scope | none |

### 3.12 Reporting, CI and platform gaps

| Gap | Priority | What it is | Why it matters |
|-----|----------|-----------|----------------|
| CI plug-ins | P2 | GitHub Action / GitLab CI job that runs a GLV test on every pull request and fails on new issues | Shift-left; clients' developers see issues before release |
| Allure-style test history | P3 | Rich history and flaky charts across runs | Partial: trends and flaky detection exist |
| White-label client portal | P2 | Clients log in, see only their projects and reports with GLV branding | Turns the tool into a sellable QA service |
| Risk score and release gate per client | P3 (Partial: master control pass/fail) | One score combining security, speed, a11y, SEO over time | Easy sales story |

---

## 4. What cannot be fully copied in-house

Be honest with clients about these:

- **Google's own data:** real search rankings, Search Console data, Chrome UX Report field data at scale. The client can connect their own Search Console; we can't own it.
- **Ahrefs-size backlink index:** Common Crawl gets part of the way, not all of it.
- **Hundreds of real device models:** a GLV phone rack covers the top 15 to 25 devices, not 3,000.
- **Safari on iPhone without Apple hardware:** needs the Mac helper or real iPhones.
- **AI answer engines (ChatGPT, Gemini, Perplexity):** checking what they say about a client needs their services.

---

## 5. Suggested build order

1. **Quick wins (days each):** security.txt, DNS/email security for any domain, subdomain takeover, GEO/AI-crawler checks, social preview, dark-pattern detectors, India DPDP pack, OWASP LLM/Agentic mapping.
2. **New engines (one to two weeks each):** live AI chatbot red-team (garak + promptfoo), hacked-site/malware scan, Interactsh callback server, mutation testing + running client unit tests, PDF accessibility (veraPDF), plain-English tests + self-healing, Keploy record/replay.
3. **Hardware and bigger work:** real phone farm (DeviceFarmer + go-ios), mobile dynamic security (Frida/MobSF), browser version matrix (Selenium Grid), region probes, server chaos and backup-restore drills, cloud posture (Prowler).
4. **Later, by client demand:** data/ETL, queues, desktop apps, IoT, Smart TV.

---

## 6. Sources

- OWASP Top 10 for Agentic Applications 2026: https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026
- LLM red-teaming tools compared: https://www.promptfoo.dev/blog/promptfoo-vs-garak/ , https://www.promptfoo.dev/blog/promptfoo-vs-pyrit/ , https://arxiv.org/pdf/2410.02828
- OWASP MASTG testing tools: https://mas.owasp.org/MASTG/tools
- European Accessibility Act and EN 301 549: https://www.deque.com/fr/blog/en-301-549-v4-1-1-is-final-what-changed-what-it-means-and-what-you-should-do/ , https://www.dwt.com/insights/2026/09/european-accessibility-act-ict-standards-update
- EU Cyber Resilience Act reporting (from 11 Sept 2026): https://digital-strategy.ec.europa.eu/en/policies/cra-reporting
- Post-quantum TLS readiness: https://arxiv.org/pdf/2605.02978
- Keploy record/replay: https://github.com/keploy/keploy
- GEO audit tools: https://github.com/cloudapp-dev/awesome-open-geo
- Core Web Vitals 2026: https://web.dev/blog/lcp-and-inp-are-now-baseline-newly-available
- BrowserStack product range (for the comparison): https://www.g2.com/products/browserstack/features
