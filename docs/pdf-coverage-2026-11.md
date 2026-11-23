# PDF coverage check: "Complete Website Testing Reference"

Date: 2026-11-23. Branch checked: `claude/project-thread-9wz902` (PR #30, commit c594f8a). Source: the 15-page PDF Lucky shared, 783 numbered rows in 23 sections (the numbering runs 1 to 783 with no gaps or repeats).

Each PDF row was matched against what really runs in the system: the 181 agents, 87 tools, the 358 Testing-types (handbook) rows, the 73 written manual-checklist cases (`lib.*`), the ~1,500 finding rules inside them, and platform features (journeys, re-tests, visual compare, uptime watch, RUM snippet, master-control gate, issue board, API module protocols). A name that only sounds similar did not count.

## Verdicts

- **Covered**: an agent, tool, finding rule or platform feature runs it, or a real manual-checklist case exists for it.
- **Partly**: something real touches it, but only one part (for example the security side of social login, not the sign-in flow).
- **Partly (journey only)**: nothing built in checks it; a person can test it today only by writing a journey (and, for anything that changes data, on a test copy). Counted inside "partly".
- **Missing**: nothing in the system checks it.
- **Not automatable**: a process, research or team practice (UAT, card sorting, surveys, retrospectives...). These belong in the manual checklist or the handbook, not in a tool. Many are already handbook rows; the note says so.

## Totals

| Verdict | Rows |
|---|---|
| Covered | 421 |
| Partly | 175 |
| Partly (journey only) | 40 |
| Missing | 86 |
| Not automatable | 61 |
| **All** | **783** |

## By section

| Section | Rows | Covered | Partly | Journey only | Missing | Not automatable |
|---|---|---|---|---|---|---|
| 1. Functional Testing: Levels and Types | 55 | 29 | 11 | 0 | 4 | 11 |
| 2. Test Design Techniques | 29 | 17 | 5 | 0 | 0 | 7 |
| 3. Website Feature Checks | 49 | 19 | 16 | 11 | 3 | 0 |
| 4. Content, Link and URL Checks | 29 | 20 | 7 | 0 | 2 | 0 |
| 5. Performance Testing | 52 | 41 | 8 | 0 | 3 | 0 |
| 6. Security Testing | 83 | 64 | 11 | 0 | 5 | 3 |
| 7. Usability and UX Testing | 36 | 4 | 4 | 1 | 7 | 20 |
| 8. Accessibility Testing | 29 | 22 | 2 | 0 | 5 | 0 |
| 9. Compatibility Testing | 23 | 13 | 7 | 0 | 3 | 0 |
| 10. SEO Testing | 45 | 27 | 11 | 0 | 6 | 1 |
| 11. Localisation and Internationalisation | 12 | 4 | 4 | 0 | 2 | 2 |
| 12. Compliance, Legal and Policy Testing | 23 | 13 | 8 | 0 | 2 | 0 |
| 13. API and Back-end Testing | 31 | 22 | 9 | 0 | 0 | 0 |
| 14. Database and Data Testing | 18 | 7 | 7 | 0 | 4 | 0 |
| 15. Infrastructure, DevOps and Release Testing | 31 | 13 | 12 | 0 | 3 | 3 |
| 16. Visual and Front-end Quality Testing | 27 | 14 | 9 | 0 | 4 | 0 |
| 17. E-commerce / Online Store Testing | 42 | 15 | 10 | 12 | 5 | 0 |
| 18. SaaS, Web App and CRM Testing | 40 | 8 | 8 | 16 | 8 | 0 |
| 19. Modern Web Technology Testing | 28 | 5 | 14 | 0 | 9 | 0 |
| 20. AI and Chatbot Feature Testing | 16 | 9 | 3 | 0 | 4 | 0 |
| 21. Mobile Web and Mobile App Testing | 30 | 28 | 2 | 0 | 0 | 0 |
| 22. Source Code and Pipeline Testing | 24 | 13 | 4 | 0 | 7 | 0 |
| 23. Test Management, Process and Release Practices | 31 | 14 | 3 | 0 | 0 | 14 |

## Missing rows, by section

### 1. Functional Testing: Levels and Types

- **38. Path coverage**: Branch coverage only; no path coverage
- **39. Condition coverage**: No condition / MC/DC coverage
- **47. Uninstallation**: App uninstall leftovers not checked
- **52. Forward compatibility**: No beta/canary browser channel run

### 3. Website Feature Checks

- **89. Spam protection**: No CAPTCHA/honeypot presence check on forms
- **125. Scheduled publishing**: Time-based publishing not testable read-only
- **133. Live data widgets**: Live widgets not checked

### 4. Content, Link and URL Checks

- **159. Email address exposure**: Plain e-mail addresses on pages not flagged
- **160. Plagiarism / copied content**: No copied-content check

### 5. Performance Testing

- **198. HTTP/2 and HTTP/3**: No HTTP/2 or HTTP/3 check
- **203. Memory leak**: No browser/server memory-growth test
- **207. Autoscaling**: Autoscaling not tested

### 6. Security Testing

- **247. HTTP parameter pollution**: No HTTP parameter pollution test
- **277. Web Application Firewall (WAF)**: No WAF detection
- **279. Bot and scraping protection**: No bot/scraping protection check
- **280. CAPTCHA effectiveness**: No CAPTCHA effectiveness check
- **281. Credential stuffing**: Not done (by design)

### 7. Usability and UX Testing

- **305. Heuristic evaluation**: Could be AI-assisted (Claude reviews screenshots against Nielsen's 10)
- **314. Heatmaps and click maps**: Real-user analytics (would extend the RUM snippet)
- **315. Session recording**: Real-user analytics (would extend the RUM snippet)
- **316. Funnel analysis**: Real-user analytics
- **317. User flow analysis**: Real-user analytics
- **319. Microcopy**: Labels/help text quality not reviewed (AI-assisted possible)
- **333. Customer feedback widgets**: Feedback widgets not checked

### 8. Accessibility Testing

- **341. Voice control**: No voice-control (label-in-name) test
- **351. Flashing content**: No three-flashes check
- **353. Audio description**: Audio description not checked
- **359. Accessible CAPTCHA**: No accessible-CAPTCHA check
- **361. Magnifier and high-contrast mode**: No forced-colors / high-contrast run

### 9. Compatibility Testing

- **370. Touch vs mouse**: Hover-only menus/touch vs mouse not checked
- **376. Browser extension interference**: Extension interference not tested
- **381. Reader mode and text-only**: Reader mode not tested

### 10. SEO Testing

- **406. Keyword research**: Needs search-volume data (not in-house)
- **408. Content gap analysis**: Needs competitor ranking data
- **416. Pagination SEO**: Pagination SEO not checked
- **417. Faceted navigation SEO**: Faceted URL explosion not checked
- **424. Site migration SEO**: No old-to-new redirect map check
- **428. Competitor SEO benchmarking**: No competitor benchmark run

### 11. Localisation and Internationalisation

- **438. Text expansion**: No text-expansion (pseudo-locale) run
- **442. Locale-specific sorting and search**: Locale sorting not checked

### 12. Compliance, Legal and Policy Testing

- **460. Age gating**: Age gates not checked
- **461. Advertising disclosure**: Sponsored/affiliate labels not checked

### 14. Database and Data Testing

- **504. Replication and failover**: Replication/failover not tested
- **507. Data masking and anonymisation**: Test-data masking not checked
- **510. Search index consistency**: Search index vs database not compared
- **513. Archival and purge**: Archival/purge not checked

### 15. Infrastructure, DevOps and Release Testing

- **521. Status page**: Status page not checked
- **529. Rollback**: Rollback not tested
- **536. Environment parity**: Staging vs production not compared

### 16. Visual and Front-end Quality Testing

- **548. Design-to-code (pixel perfect)**: No design-file compare
- **552. Spacing and alignment**: Spacing/alignment not checked
- **563. Z-pattern and fold content**: Above-the-fold content not checked
- **570. Component library consistency**: No component-library (Storybook) check

### 17. E-commerce / Online Store Testing

- **593. Inventory sync**: Inventory sync not checked
- **596. Abandoned cart recovery**: Abandoned-cart reminders not tested
- **605. Fraud and risk rules**: Fraud rules not tested
- **608. Product feed (Google Merchant)**: Google Merchant feed not checked
- **609. Tracking pixels and conversion events**: Purchase events firing once not checked

### 18. SaaS, Web App and CRM Testing

- **619. Payment failure and dunning**: Dunning not tested
- **620. Proration and credits**: Proration not tested
- **621. Usage limits and quotas**: Plan limits not tested
- **631. Telephony and click-to-call**: Telephony not tested
- **632. Calendar sync**: Calendar sync not tested
- **644. Third-party integrations**: Zapier/Slack/accounting integrations not tested
- **650. Feature flags and gradual rollout**: Feature flags not tested
- **654. Disaster recovery for tenant data**: Per-tenant restore not tested

### 19. Modern Web Technology Testing

- **660. Web push notifications**: Web push not tested
- **664. WebAssembly**: WebAssembly not tested
- **669. Passkeys / WebAuthn**: Passkeys/WebAuthn not tested
- **670. Payment Request API (Apple/Google Pay)**: Payment Request API not tested
- **672. Camera, microphone and device APIs**: Camera/mic APIs not tested on the web
- **673. Drag and drop**: Drag and drop not tested
- **674. Clipboard and file system APIs**: Clipboard/file system APIs not tested
- **675. Browser extensions interaction**: Extensions interaction not tested
- **680. Captcha and bot challenges**: CAPTCHA/bot challenges not tested

### 20. AI and Chatbot Feature Testing

- **691. Conversation memory and context**: Multi-turn memory not tested
- **694. Recommendation relevance**: Recommendation relevance not tested
- **695. AI search quality**: Semantic search quality not tested
- **696. Personalisation and privacy**: Personalisation consent not tested

### 22. Source Code and Pipeline Testing

- **739. Dead and unused code**: Dead code in the repo not found
- **743. Type checking**: No tsc/mypy type check run
- **744. Formatting checks**: No formatting check
- **745. Commit and branch policy checks**: No commit/branch policy check
- **746. Pre-commit and pre-push hooks**: No pre-commit hook check
- **747. Test pyramid health**: No test-pyramid report
- **749. Build performance**: Build time not measured

## Partly covered rows, by section

### 1. Functional Testing: Levels and Types

- **6. Component**: has byo-playwright can run component tests; visual compare is page-level. Gap: No Storybook / isolated component runner.
- **20. Operational acceptance (OAT)**: has dr-drill, conn-ssh (backups, logs, NTP), uptime watch. Gap: Alert firing and full OAT checklist not covered.
- **22. Regulation acceptance**: has Compliance agents (DPDP, GDPR, WCAG, PCI, HIPAA), soc2 evidence. Gap: Final regulatory sign-off is human.
- **29. Gorilla**: has rel.repeat (5 times in a row and at once). Gap: No deep hammering of one module.
- **40. Data-flow testing**: has iast taint scan, opengrep taint rules. Gap: Security data-flow only, not general def-use testing.
- **41. Control-flow testing**: has code.maintainability (cyclomatic complexity, nesting). Gap: Measures, does not test control flow.
- **44. Migration**: has Test the new host as a project; Trends compares runs. Gap: No old-vs-new site diff or redirect-map check.
- **46. Installation**: has Mobile: appium install, android/ios store checks. Gap: No web-software installer check.
- **48. Configuration**: has Master control settings (browser, locale, dark mode); handbook Configuration row. Gap: Configuration matrix not run automatically.
- **49. Parallel / back-to-back**: has T replay (HAR answers vs recording), api.changes. Gap: Web back-to-back old vs new not compared.
- **50. Comparison**: has Trends compares with the previous version. Gap: No competitor comparison.

### 2. Test Design Techniques

- **58. Decision table**: has app.access / api.access grids. Gap: Business rule tables must be written as journeys.
- **59. State transition**: has app.session, app.two-step, func.back-forward. Gap: Order/business state machines not modelled.
- **63. Orthogonal array**: has T pairwise (all-pairs). Gap: No orthogonal-array generator as such.
- **75. Behaviour-driven (BDD)**: has Journeys/scenarios in plain words. Gap: No Gherkin Given/When/Then import.
- **78. Property-based**: has schemathesis (API); code-fuzz checks if client has PBT. Gap: No fast-check/Hypothesis run on client code.

### 3. Website Feature Checks

- **88. Auto-reply email** _(journey only)_: has Journey "email has" with Mailpit. Gap: No built-in auto-reply check.
- **90. Newsletter signup** _(journey only)_: has Journeys + Mailpit; ux.dark-patterns flags pre-ticked sign-ups.
- **92. Mobile hamburger menu**: has web.tablet (menu vanishes, no menu button). Gap: Phone menu is not opened and its links not checked.
- **93. Mega menu** _(journey only)_: has nothing built in. Gap: Dropdowns not opened by any check.
- **100. Registration / signup** _(journey only)_: has app.form-fill on a test copy. Gap: No sign-up flow check.
- **103. Social login**: has sec.oauth (security of the sign-in setup). Gap: The social sign-in flow itself is not run.
- **107. Popups and modals**: has ui.cover (intrusive pop-ups), ui.consent-gate. Gap: Open/close, focus trap, Escape not tested.
- **108. Chat widget** _(journey only)_: has Listed only as a third-party script. Gap: Widget is not opened.
- **109. Click-to-call and email links**: has seo.local phone consistency. Gap: tel:/mailto: links not validated.
- **110. WhatsApp / social buttons**: has Social profile links in web.links; lib.smoke-footer. Gap: Share/WhatsApp buttons not exercised.
- **111. Image slider / carousel** _(journey only)_: has func.monkey clicks at random. Gap: No slider check.
- **112. Accordion and tabs** _(journey only)_: has nothing built in. Gap: No accordion/tab check.
- **113. Date picker / calendar**: has func.form-fields tries date values. Gap: Picker widget itself not used.
- **114. Booking / appointment widget** _(journey only)_: has nothing built in. Gap: No booking-slot check.
- **118. Maps embed**: has seo.local checks a map embed exists. Gap: Map loading not checked.
- **119. Comments and reviews** _(journey only)_: has nothing built in. Gap: Posting changes data; journeys on a test copy only.
- **120. Rating and testimonial widgets** _(journey only)_: has nothing built in. Gap: No rating widget check.
- **121. Social share buttons**: has seo.social (share preview tags). Gap: Share buttons not clicked.
- **122. Blog features**: has Crawl covers category/tag/author pages. Gap: RSS/Atom feed not validated.
- **123. WYSIWYG / rich text editor** _(journey only)_: has nothing built in. Gap: Admin editor not tested.
- **124. Admin panel / CMS**: has App module can test the admin as a signed-in app; app.exposed. Gap: No CMS-specific checks.
- **127. PDF generation**: has T print-layout (page to PDF), a11y.documents. Gap: App-generated invoices/reports not checked.
- **128. Notifications**: has push-send (apps), Mailpit in journeys. Gap: In-site banners/toasts not checked.
- **129. Error and status pages**: has web.soft-404, func.not-found-page; chaos:raw-error-page. Gap: 500 and maintenance pages only via chaos test.
- **130. Back-to-top and scroll behaviour**: has ui.cover (sticky bars). Gap: Back-to-top not checked.
- **131. Language switcher**: has seo.hreflang, l10n.language; lib.content-languages. Gap: Switcher not clicked.
- **132. Currency / unit switcher**: has l10n.formats (mixed currencies). Gap: Switcher not clicked.

### 4. Content, Link and URL Checks

- **141. www vs non-www**: has web.https (http to https). Gap: www and non-www pair not compared.
- **143. Trailing slash and URL case**: has seo.urls (capital letters). Gap: Trailing-slash duplicates not flagged.
- **148. Contact details accuracy**: has seo.local name/address/phone consistency. Gap: Phone only across pages; email/address not compared.
- **150. Header and footer consistency**: has func.navigation (menu the same everywhere). Gap: Footer consistency not compared.
- **152. Duplicate pages**: has web.duplicates (titles, descriptions). Gap: Body-content duplicates not detected.
- **157. Link target and rel attributes**: has lib.nav-new-tab. Gap: rel=noopener/nofollow not checked.
- **162. Metadata consistency**: has web.duplicates, seo.local, seo.geo organisation schema. Gap: No full metadata cross-check.

### 5. Performance Testing

- **167. Volume**: has api.owasp (10,000-record lists), app.tables. Gap: No large-data seeding.
- **168. Scalability**: has k6 at rising user counts, compare runs. Gap: Adding servers not tested.
- **183. Time to Interactive (TTI)**: has lighthouse TBT. Gap: Lighthouse 13 no longer reports TTI.
- **187. Critical rendering path**: has lighthouse request-chain insight. Gap: Shown, no own rule.
- **196. Server-side caching**: has cache:html-stale, cache:no-304. Gap: Redis/Varnish not checked.
- **197. CDN**: has region-speed (from other regions). Gap: No CDN detection rule.
- **204. CPU and resource utilisation**: has Grafana during load tests, conn-ssh memory/disk. Gap: No automatic CPU/RAM findings for web.
- **214. Battery and power usage**: has appium runs the app at 4% battery. Gap: Drain not measured.

### 6. Security Testing

- **228. XML external entity (XXE)**: has zap-active (GET only). Gap: No XML-body XXE probe.
- **230. Insecure deserialisation**: has glv-attack flags the surface; sast deserialize rules. Gap: Not actively exploited (by design).
- **231. Authentication testing**: has sec.auth-forms, app.user-enum, app.lockout, app.two-step. Gap: Default passwords / brute force not tried (by design).
- **232. Password policy**: has form:short-password, db:password-column-short. Gap: No password strength-rule test on sign-up.
- **242. Business-logic flaws**: has glv-attack logic (quantity), race. Gap: Price tampering and step skipping not tried.
- **254. Prototype pollution**: has sec.js-libraries (known prototype-pollution CVEs), code.risky. Gap: No client-side pollution probe.
- **272. Plugin and theme vulnerabilities**: has nuclei WordPress CVE templates. Gap: No plugin/theme enumeration like WPScan.
- **274. Admin login protection**: has app.lockout, app.two-step. Gap: Hidden login URL / admin rate limit not checked.
- **275. Malware and blacklist check**: has malware, sec.hacked. Gap: No blacklist (Safe Browsing style) lookup.
- **278. DoS / DDoS resistance**: has k6 stress/spike (permission). Gap: No flood-style DoS (by design).
- **289. IAST**: has iast (pattern scan + optional runtime hook). Gap: No true in-app sensor.

### 7. Usability and UX Testing

- **300. Navigation / information architecture**: has func.navigation, seo.link-graph (click depth). Gap: Real "can users find it" needs people.
- **318. Onboarding** _(journey only)_: has nothing built in. Gap: No onboarding check.
- **321. Form usability**: has autocomplete and label checks, axe labels. Gap: Field order/autofill flow not tested.
- **323. Consistency**: has func.navigation (menus). Gap: Visual/wording consistency not compared.
- **326. Trust signals**: has saas.trust, store.policies, seo.local contact. Gap: Reviews/badges not checked.

### 8. Accessibility Testing

- **360. Cognitive accessibility**: has a11y.aaa (reading level, consistent help). Gap: Flows not judged.
- **362. Accessibility statement**: has india.gigw (gov sites, off by default). Gap: Not checked for other sites.

### 9. Compatibility Testing

- **368. Screen resolution and DPI**: has func.devices sizes. Gap: Retina / 4K pixel ratios not run.
- **374. Polyfill and fallback**: has browser-matrix older versions. Gap: Fallbacks not judged separately.
- **375. Browser settings**: has seo.rendered-html shows the no-JavaScript view. Gap: Cookies-off and ad-blocker runs not done.
- **377. Email client compatibility**: has email-render (rule-based). Gap: No real mail-client renders.
- **383. Operating-system settings**: has a11y.motion, master control dark mode, device:large-text (apps). Gap: Web large-font setting not run.
- **384. Hardware variety**: has perf.slow-network (4x slower CPU). Gap: Low RAM not simulated.
- **385. Server environment compatibility**: has conn-ssh (PHP/OS end of life), code.container. Gap: No version matrix run.

### 10. SEO Testing

- **395. Index coverage**: has seo.audit reads an uploaded Search Console export. Gap: No live index check (needs Google).
- **401. Mobile-first indexing**: has web.mobile, web.seo. Gap: Phone vs desktop content parity not compared.
- **404. Duplicate content**: has web.duplicates (titles, descriptions). Gap: Body-text duplicates not detected.
- **413. Anchor text profile**: has backlinks tool. Gap: Anchor-text profile not reported.
- **420. Google Business Profile**: has seo:no-gbp-link. Gap: Listing completeness needs Google.
- **421. Rich snippet eligibility**: has web.structured-data (product rich results). Gap: Other rich-result types not checked.
- **422. Voice and featured snippet readiness**: has seo.geo (answer headings). Gap: No FAQ/featured-snippet check.
- **425. Analytics and tag verification**: has web.privacy lists trackers; consent-proof. Gap: Events firing correctly not checked.
- **426. Search Console health**: has Search Console export upload. Gap: Manual actions/security issues need Google.
- **429. Content freshness**: has geo:no-dates, content:copyright-old.
- **430. E-E-A-T signals**: has geo:no-author, organisation schema, sameAs.

### 11. Localisation and Internationalisation

- **431. Internationalisation (i18n)**: has l10n.locale (other language and time zone). Gap: No pseudo-localisation.
- **432. Localisation (l10n)**: has l10n.language, app:partial-translation, android/ios languages. Gap: Translation completeness only.
- **440. Local payment and address formats**: has form:pincode-letters, form:phone-length (India). Gap: Local payment methods not checked.
- **441. Language detection and switching**: has l10n.locale. Gap: Auto-detect and switch not exercised.

### 12. Compliance, Legal and Policy Testing

- **444. CCPA / CPRA**: has Generic consent checks. Gap: No "Do not sell/share" link or GPC check.
- **453. HIPAA**: has sec.hipaa (health data leakage). Gap: Leakage only, not the full rule set.
- **454. COPPA**: has india.dpdp checks the children's-data part of the notice. Gap: COPPA itself not checked.
- **456. Licensing of fonts, images and libraries**: has sbom licences for packages. Gap: Fonts and images not checked.
- **458. Data retention and deletion**: has india.dpdp notice mentions retention. Gap: Export/delete-on-request not tested.
- **459. Data residency**: has cloud (regions in the account). Gap: No residency rule.
- **463. Consumer protection and e-commerce law**: has ux.dark-patterns (drip pricing), store.product price. Gap: Seller/tax information not checked.
- **464. Accessibility statement and contact**: has india.gigw (gov sites). Gap: Not checked for other sites.

### 13. API and Back-end Testing

- **478. Pagination and filtering API**: has api:no-page-limit. Gap: Correct slices and counts not checked.
- **481. GraphQL**: has API module GraphQL (depth, alias, introspection). Gap: Mutations not tested yet.
- **484. WebSocket and server-sent events**: has API module WebSocket. Gap: Server-sent events not tested.
- **487. Timeout and retry behaviour**: has res:no-timeout (code), chaos delay (server). Gap: No live retry test.
- **488. Third-party API integration**: has payments (test keys), messaging templates. Gap: Other third-party APIs not exercised.
- **490. Background jobs and queues**: has queues (AsyncAPI spec). Gap: Workers/cron runs not tested.
- **491. Message queue testing**: has queues (spec only). Gap: No broker connection.
- **492. File and media handling**: has app.file-upload (security). Gap: Processing and storage not checked.
- **493. Logging and audit trail**: has conn-ssh log retention. Gap: App audit trail not verified.

### 14. Database and Data Testing

- **499. Transactions (ACID)**: has res:payment-no-idempotency. Gap: No transaction rollback test.
- **500. Stored procedures and triggers**: has db-code lists procedures/triggers. Gap: Does not run them.
- **501. Data migration**: has code.database migration checks. Gap: Moved data not compared.
- **503. Backup and restore**: has dr-drill (backups recent, restore tested?). Gap: Does not perform a restore.
- **508. Test data generation**: has app.form-fill realistic values, api-mock examples. Gap: No test-data generator.
- **509. Data encryption**: has testssl, db:plain-passwords, iac:unencrypted. Gap: At-rest database encryption not checked.
- **511. Report and dashboard accuracy**: has reconciliation (totals). Gap: Dashboards not compared.

### 15. Infrastructure, DevOps and Release Testing

- **515. DNS configuration**: has sec.email-dns (mail records, CAA, DNSSEC). Gap: A/AAAA records and propagation not checked.
- **516. Domain expiry and ownership**: has conn-hostinger (Hostinger domains only). Gap: Other registrars not checked.
- **522. Load balancer**: has k6 load. Gap: Traffic spread across servers not checked.
- **523. Reverse proxy and CDN rules**: has web.cache, cache poisoning. Gap: Routing rules not checked.
- **525. Failover and redundancy**: has chaos (stop a service, recovery), k8s:single-replica. Gap: Automatic failover not proven.
- **526. Disaster recovery**: has dr-drill. Gap: Checks drill evidence, does not run one.
- **528. Deployment**: has Post-deploy smoke and re-tests. Gap: Deploy step itself not checked.
- **531. Zero-downtime deploy**: has Uptime watch every minute. Gap: Not tied to a deploy.
- **538. Logging and monitoring**: has conn-ssh logs. Gap: Error capture/alerts not verified.
- **541. Cron and scheduled tasks**: has conn-ssh reads cron. Gap: Runs on time not verified.
- **542. Backup verification**: has dr-drill. Gap: Same as backup and restore.
- **543. Cost and resource monitoring**: has ai-cost (AI calls only). Gap: Cloud spend not checked.

### 16. Visual and Front-end Quality Testing

- **547. UI / GUI**: has ui.overlap, ui.cut-text, ui.visual-layout. Gap: Match to design not checked.
- **550. Typography**: has a11y2:tiny-font, ui.readability, windows fonts.
- **553. Icons and images**: has ui:stretched-image, perf:oversized-image. Gap: Blurry upscaled images not flagged.
- **554. Animation and transitions**: has a11y.motion. Gap: Smoothness not measured.
- **555. Scroll effects and parallax**: has ui.cover (sticky bars). Gap: Parallax not checked.
- **562. Z-index and overlay issues**: has ui.overlap, ui.cover, a11y:focus-obscured. Gap: Menu-behind-popup cases not checked.
- **565. Empty, loading and error states**: has app:table-no-empty-message, search:no-empty-message. Gap: Loading/error states not checked.
- **566. Form field styling and states**: has a11y focus visible. Gap: Error/disabled/success states not checked.
- **569. Dark mode visuals**: has Master control dark mode; lib.look-dark. Gap: No dark-specific checks.

### 17. E-commerce / Online Store Testing

- **575. Product data accuracy**: has store.product (price/stock in product data). Gap: Back-end values not compared.
- **576. Variants and options** _(journey only)_: has nothing built in. Gap: Variant selection not tested.
- **577. Product images and zoom** _(journey only)_: has nothing built in. Gap: Gallery/zoom not tested.
- **580. Mini cart and cart drawer** _(journey only)_: has nothing built in. Gap: Mini cart not tested.
- **582. Guest checkout** _(journey only)_: has nothing built in. Gap: Guest checkout not called out.
- **583. Address and pin-code validation**: has form:pincode-letters. Gap: Serviceability not checked.
- **588. Payment methods**: has payments (Stripe, Razorpay). Gap: UPI, wallets, COD, EMI, BNPL not covered.
- **589. 3-D Secure / OTP flow** _(journey only)_: has nothing built in. Gap: 3-D Secure step not tested.
- **591. Order management** _(journey only)_: has nothing built in. Gap: Order management not tested.
- **592. Invoice and receipt** _(journey only)_: has nothing built in. Gap: Invoice PDF not checked.
- **594. Out-of-stock and backorder** _(journey only)_: has nothing built in. Gap: Out-of-stock and notify-me not tested.
- **595. Returns, refunds and exchanges** _(journey only)_: has nothing built in. Gap: Returns/refunds not tested.
- **597. Wishlist and compare** _(journey only)_: has nothing built in. Gap: Wishlist/compare not tested.
- **598. Customer reviews and ratings** _(journey only)_: has nothing built in. Gap: Reviews not tested.
- **599. Account area**: has Signed-in app module. Gap: No store-account checks.
- **600. Search and merchandising**: has func.search. Gap: Relevance/synonyms not judged.
- **601. Multi-currency and multi-language**: has l10n.formats, seo.hreflang.
- **602. Marketplace / multi-vendor**: has app.access (vendor role). Gap: Commissions not checked.
- **603. Subscription and recurring orders**: has iap (apps); handbook Subscription row. Gap: No billing test clock.
- **604. Gift cards and store credit**: has race (redeem many times at once). Gap: Balance logic not tested.
- **606. Order notifications and tracking** _(journey only)_: has nothing built in. Gap: Tracking links not tested.
- **610. Theme and plugin conflicts**: has web.js-errors after updates. Gap: No conflict-specific test.

### 18. SaaS, Web App and CRM Testing

- **617. Signup and onboarding** _(journey only)_: has nothing built in. Gap: Sign-up/onboarding not tested.
- **618. Subscription and billing**: has saas.trust, payments. Gap: Plan changes and invoices not tested.
- **623. Lead assignment and routing** _(journey only)_: has nothing built in. Gap: Lead routing not tested.
- **624. Pipeline and stage workflow** _(journey only)_: has nothing built in. Gap: Pipeline stages not tested.
- **626. Duplicate detection and merge** _(journey only)_: has nothing built in. Gap: Duplicate detection not tested.
- **627. Custom fields and layouts** _(journey only)_: has nothing built in. Gap: Custom fields not tested.
- **628. Automation and triggers** _(journey only)_: has Webhook inbox + Mailpit in journeys. Gap: No built-in check.
- **629. Email integration** _(journey only)_: has Mailpit in journeys.
- **630. WhatsApp and SMS integration**: has messaging (SMS/WhatsApp templates). Gap: Send/receive not tested.
- **633. Tasks, reminders and follow-ups** _(journey only)_: has nothing built in. Gap: Reminders not tested.
- **635. Bulk actions** _(journey only)_: has nothing built in. Gap: Bulk actions not tested.
- **637. Reports and dashboards**: has reconciliation. Gap: Dashboards not compared.
- **638. Notifications and alerts** _(journey only)_: has nothing built in. Gap: In-app notifications not tested.
- **639. Audit log** _(journey only)_: has nothing built in. Gap: Audit log not verified.
- **640. Permissions on fields and records**: has app.access (record-level, hidden screens). Gap: Field-level access not checked.
- **641. Team and user management** _(journey only)_: has nothing built in. Gap: Invite/deactivate not tested.
- **642. Single sign-on (SSO)**: has sec.oauth (SAML metadata). Gap: SSO sign-in flow not run.
- **645. Data backup and export for customers** _(journey only)_: has lib.crud-import (export part).
- **646. Account deletion and offboarding** _(journey only)_: has nothing built in. Gap: Account deletion not tested.
- **648. Real-time collaboration**: has lib.crud-two-tabs, API WebSocket. Gap: Live updates between users not tested.
- **649. Performance with large data**: has app.tables, perf.backend, k6.
- **651. In-app help and chat** _(journey only)_: has nothing built in. Gap: In-app help not tested.
- **652. White-label and branding** _(journey only)_: has nothing built in. Gap: Client's white-label settings not tested.
- **653. Localisation of the app**: has app:partial-translation, l10n agents.

### 19. Modern Web Technology Testing

- **661. Web storage**: has app.tokens (tokens in storage). Gap: Storage behaviour not tested.
- **662. WebSocket and server-sent events**: has API module WebSocket. Gap: Server-sent events not tested.
- **663. WebRTC**: has webrtc detects WebRTC use. Gap: Calls not placed.
- **665. Web Components and Shadow DOM**: has App explorer reads shadow DOM. Gap: No component behaviour check.
- **666. Micro-frontends**: has Standard crawl and JS errors.
- **667. Headless CMS**: has API module can test the content API.
- **668. Social login and OAuth**: has sec.oauth. Gap: Flow not run.
- **671. Geolocation**: has lighthouse geolocation-on-start. Gap: Fallback not tested.
- **676. Edge and serverless functions**: has API tests reach the endpoints. Gap: No emulator runs.
- **677. GraphQL front-end data**: has app.calls sees GraphQL calls. Gap: Caching/error states not checked.
- **678. Third-party embeds**: has perf:third-party-weight, CSP, axe iframe titles.
- **679. Tag manager and analytics**: has privacy.consent-proof. Gap: Events not verified.
- **681. Geo-blocking and VPN behaviour**: has region-speed regional proxies. Gap: Per-country content not compared.
- **682. Deep links and URL fragments**: has func.anchors, deeplink-run (apps). Gap: Web state-in-URL not checked.

### 20. AI and Chatbot Feature Testing

- **690. Response quality and tone**: has ai-eval scoring. Gap: Tone not judged.
- **692. Fallback and handoff**: has ai-eval ("I don't know" when not covered). Gap: Hand-off to a human not checked.
- **698. AI accessibility**: has axe and keyboard checks on the page. Gap: Chat widget not opened.

### 21. Mobile Web and Mobile App Testing

- **710. Battery, memory and heat**: has app-perf memory; lib.app-battery. Gap: Heat and battery drain not measured.
- **727. Beta distribution testing**: has ios.signing (Ad Hoc / TestFlight profile). Gap: Play internal testing not checked.

### 22. Source Code and Pipeline Testing

- **729. Linting**: has code.hygiene (broken JSON). Gap: No ESLint/Stylelint/Pylint run.
- **735. Technical debt measurement**: has code.maintainability. Gap: No debt cost figure.
- **742. Build reproducibility**: has deps:no-lockfile. Gap: Build not reproduced.
- **748. Flaky test detection**: has byo-playwright flaky tests. Gap: Only for uploaded Playwright suites.

### 23. Test Management, Process and Release Practices

- **761. Defect leakage and test metrics**: has Trends, pass rate. Gap: Defect leakage after release not tracked.
- **764. Test data management**: has Vault for saved logins; journey test data. Gap: No test-data sets manager.
- **775. Shadow testing / traffic mirroring**: has replay (HAR against the API). Gap: No live traffic mirroring.

## Not automatable (belongs in the manual checklist or handbook)

- **1. Functional Testing: Levels and Types**: 8. Big-bang integration; 9. Incremental integration; 10. Top-down integration; 11. Bottom-up integration; 12. Sandwich (hybrid) integration; 17. User acceptance (UAT) (in handbook); 18. Alpha (in handbook); 19. Beta (in handbook); 21. Contract acceptance; 27. Ad-hoc (in handbook); 30. Guerrilla
- **2. Test Design Techniques**: 64. Cause-effect graphing (in handbook); 65. Classification tree; 68. Session-based (in handbook); 70. Requirements-based (in handbook); 71. Experience-based; 76. Test-driven (TDD) (in handbook); 77. Acceptance TDD (ATDD) (in handbook)
- **6. Security Testing**: 292. Threat modelling; 293. Red teaming; 294. Social engineering / phishing simulation
- **7. Usability and UX Testing**: 298. Usability (moderated) (in handbook); 299. Usability (unmoderated remote) (in handbook); 301. Card sorting; 302. Tree testing; 303. First-click; 304. Five-second test; 306. Cognitive walkthrough; 307. Task success and time-on-task; 308. System Usability Scale (SUS); 309. Net Promoter Score (NPS); 310. Customer satisfaction (CSAT); 311. A/B testing (in handbook); 312. Multivariate testing; 313. Split-URL testing; 324. Visual hierarchy; 325. Call-to-action (CTA) effectiveness; 327. Content comprehension; 330. Eye tracking; 331. Prototype testing; 332. Diary and field studies
- **10. SEO Testing**: 409. Search intent match
- **11. Localisation and Internationalisation**: 433. Translation quality; 439. Cultural and legal fit
- **15. Infrastructure, DevOps and Release Testing**: 530. Blue-green and canary release (in handbook); 539. Alert and on-call testing; 544. Hosting and CDN failover
- **23. Test Management, Process and Release Practices**: 753. Test strategy and plan; 754. Test case design and review; 755. Requirements traceability matrix (in handbook); 760. Root cause analysis; 763. Test environment management; 765. Test automation strategy; 766. Automation framework design; 771. Dogfooding; 772. Bug bash; 773. Crowd testing; 774. Pilot release (in handbook); 778. Retrospective; 779. Exploratory test charters; 783. Sign-off and acceptance (in handbook)

## Small fix spotted

- The Testing-types row "Pairwise testing" (`src/handbook.ts`, Test design techniques) still says "Not automatic yet", but the `pairwise` tool was built in wave 2. The row should point at the tool. Not changed here (analysis only).

## Full mapping

Evidence uses agent ids (like `web.links`), tool ids (like `k6`), finding rules (like `perf:no-compression`), manual cases (`lib.*`) and platform features.

### 1. Functional Testing: Levels and Types

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 1 | Smoke | Covered | web.js-errors, web.resources, api.availability; lib.smoke-open |  |
| 2 | Sanity | Covered | Re-test one issue or a small preset (platform) |  |
| 3 | Regression | Covered | Every re-test compared with the last; come-back issues marked regression |  |
| 4 | Retesting (confirmation) | Covered | Mark fixed + re-test; closes only when the check passes |  |
| 5 | Unit | Covered | T unit-tests runs the client's suite; A code.tests |  |
| 6 | Component | Partly | byo-playwright can run component tests; visual compare is page-level | No Storybook / isolated component runner |
| 7 | Integration | Covered | app.calls, api.scenarios, api.writes |  |
| 8 | Big-bang integration | Not automatable | Integration strategy; covered by Integration row in handbook | Strategy, not a separate check |
| 9 | Incremental integration | Not automatable | Integration strategy | Strategy, not a separate check |
| 10 | Top-down integration | Not automatable | Integration strategy; T api-mock supplies the stubs | Strategy; stubs exist via api-mock |
| 11 | Bottom-up integration | Not automatable | Integration strategy | Strategy, not a separate check |
| 12 | Sandwich (hybrid) integration | Not automatable | Integration strategy | Strategy, not a separate check |
| 13 | Interface testing | Covered | api.contract, API module (SOAP, gRPC, WebSocket, Pact) |  |
| 14 | System | Covered | Full test runs every agent for the product (platform) |  |
| 15 | End-to-end (E2E) | Covered | User journeys / App journeys (platform) |  |
| 16 | Workflow | Covered | Multi-step journeys (platform) |  |
| 17 | User acceptance (UAT) | Not automatable | Handbook: Acceptance testing (UAT); master-control gate | Client sign-off |
| 18 | Alpha | Not automatable | Handbook: Alpha testing | Internal team practice |
| 19 | Beta | Not automatable | Handbook: Beta testing; RUM snippet | Real users; no feature-flag or feedback widget |
| 20 | Operational acceptance (OAT) | Partly | dr-drill, conn-ssh (backups, logs, NTP), uptime watch | Alert firing and full OAT checklist not covered |
| 21 | Contract acceptance | Not automatable | - | Contract wording is a human review |
| 22 | Regulation acceptance | Partly | Compliance agents (DPDP, GDPR, WCAG, PCI, HIPAA), soc2 evidence | Final regulatory sign-off is human |
| 23 | Black-box | Covered | Handbook: Black box testing |  |
| 24 | White-box | Covered | Handbook: White box testing; unit-tests coverage |  |
| 25 | Grey-box | Covered | Handbook: Grey box testing (app.access, app.calls, api.access) |  |
| 26 | Exploratory | Covered | App explorer + func.monkey; handbook Exploratory | Human exploration is manual |
| 27 | Ad-hoc | Not automatable | Handbook: Ad-hoc testing (func.monkey for random) | Informal human testing |
| 28 | Monkey | Covered | func.monkey |  |
| 29 | Gorilla | Partly | rel.repeat (5 times in a row and at once) | No deep hammering of one module |
| 30 | Guerrilla | Not automatable | - | Testing with passers-by |
| 31 | Positive | Covered | Handbook: Positive testing |  |
| 32 | Negative | Covered | Handbook: Negative testing |  |
| 33 | Static | Covered | Handbook: Static testing (code agents, opengrep, gitleaks) |  |
| 34 | Dynamic | Covered | Handbook: Dynamic testing |  |
| 35 | Structural | Covered | code.tests, unit-tests coverage |  |
| 36 | Statement coverage | Covered | unit-tests reads line coverage (lcov) |  |
| 37 | Branch / decision coverage | Covered | tests:low-branch-coverage (code.tests / unit-tests) |  |
| 38 | Path coverage | Missing | - | Branch coverage only; no path coverage |
| 39 | Condition coverage | Missing | - | No condition / MC/DC coverage |
| 40 | Data-flow testing | Partly | iast taint scan, opengrep taint rules | Security data-flow only, not general def-use testing |
| 41 | Control-flow testing | Partly | code.maintainability (cyclomatic complexity, nesting) | Measures, does not test control flow |
| 42 | Build verification (BVT) | Covered | Smoke agents + CLI in CI pipelines |  |
| 43 | Maintenance | Covered | Re-tests and regression tracking |  |
| 44 | Migration | Partly | Test the new host as a project; Trends compares runs | No old-vs-new site diff or redirect-map check |
| 45 | Upgrade | Covered | Re-run the suite; code.packages, sec.js-libraries flag versions |  |
| 46 | Installation | Partly | Mobile: appium install, android/ios store checks | No web-software installer check |
| 47 | Uninstallation | Missing | - | App uninstall leftovers not checked |
| 48 | Configuration | Partly | Master control settings (browser, locale, dark mode); handbook Configuration row | Configuration matrix not run automatically |
| 49 | Parallel / back-to-back | Partly | T replay (HAR answers vs recording), api.changes | Web back-to-back old vs new not compared |
| 50 | Comparison | Partly | Trends compares with the previous version | No competitor comparison |
| 51 | Backward compatibility | Covered | api.changes, openapi-diff, api.versions; lib.api-versions |  |
| 52 | Forward compatibility | Missing | - | No beta/canary browser channel run |
| 53 | Hotfix verification | Covered | Re-test one issue / smoke preset |  |
| 54 | Release candidate | Covered | Full test + master-control pass/fail gate |  |
| 55 | Post-release / production verification | Covered | Uptime watch, scheduled tests, read-only production testing |  |

### 2. Test Design Techniques

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 56 | Boundary value analysis | Covered | func.form-fields, api.negative |  |
| 57 | Equivalence partitioning | Covered | func.form-fields, api.negative |  |
| 58 | Decision table | Partly | app.access / api.access grids | Business rule tables must be written as journeys |
| 59 | State transition | Partly | app.session, app.two-step, func.back-forward | Order/business state machines not modelled |
| 60 | Use-case / scenario | Covered | User journeys, App journeys, API scenarios |  |
| 61 | Pairwise (all-pairs) | Covered | T pairwise | Handbook row still says "not automatic yet" (stale) |
| 62 | Combinatorial | Covered | T pairwise, schemathesis |  |
| 63 | Orthogonal array | Partly | T pairwise (all-pairs) | No orthogonal-array generator as such |
| 64 | Cause-effect graphing | Not automatable | Handbook: Cause-effect graphing | Design technique |
| 65 | Classification tree | Not automatable | - | Design technique |
| 66 | Error guessing | Covered | Handbook: Error guessing |  |
| 67 | Checklist-based | Covered | Agents as checklists + manual checklists |  |
| 68 | Session-based | Not automatable | Handbook: Session-based testing | Team practice |
| 69 | Risk-based | Covered | Critical-to-Low ranking, "Fix first" list |  |
| 70 | Requirements-based | Not automatable | Handbook: Test management & traceability | No requirement-to-test links in the tool |
| 71 | Experience-based | Not automatable | - | Tester experience |
| 72 | Data-driven | Covered | api.scenarios, func.form-fields |  |
| 73 | Keyword-driven | Covered | Journeys written in action words |  |
| 74 | Model-based | Covered | API file as the model (schemathesis, api.contract) |  |
| 75 | Behaviour-driven (BDD) | Partly | Journeys/scenarios in plain words | No Gherkin Given/When/Then import |
| 76 | Test-driven (TDD) | Not automatable | Handbook: Test-driven development | Developer practice |
| 77 | Acceptance TDD (ATDD) | Not automatable | Handbook: ATDD | Team practice |
| 78 | Property-based | Partly | schemathesis (API); code-fuzz checks if client has PBT | No fast-check/Hypothesis run on client code |
| 79 | Mutation | Covered | T mutation |  |
| 80 | Syntax testing | Covered | func.form-fields formats, api.negative, schemathesis |  |
| 81 | Random testing | Covered | func.monkey, schemathesis |  |
| 82 | Snapshot testing | Covered | Visual compare, API approved copy |  |
| 83 | Golden master | Covered | T replay, api.changes approved copy, visual baselines |  |
| 84 | Approval testing | Covered | Visual compare approve-once, API Changes tab |  |

### 3. Website Feature Checks

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 85 | Contact / enquiry form | Covered | web.forms, func.form-fields; lib.form-happy; journeys with test mailbox | Public-site forms are not auto-submitted (read-only) |
| 86 | Form validation | Covered | func.form-fields; lib.form-empty, lib.form-bad |  |
| 87 | Form email delivery | Covered | lib.form-happy; journey "email has" with Mailpit |  |
| 88 | Auto-reply email | Partly (journey only) | Journey "email has" with Mailpit | No built-in auto-reply check |
| 89 | Spam protection | Missing | - | No CAPTCHA/honeypot presence check on forms |
| 90 | Newsletter signup | Partly (journey only) | Journeys + Mailpit; ux.dark-patterns flags pre-ticked sign-ups |  |
| 91 | Navigation menu | Covered | func.navigation; lib.smoke-main-pages |  |
| 92 | Mobile hamburger menu | Partly | web.tablet (menu vanishes, no menu button) | Phone menu is not opened and its links not checked |
| 93 | Mega menu | Partly (journey only) | - | Dropdowns not opened by any check |
| 94 | Breadcrumbs | Covered | func.navigation (nav:no-breadcrumbs) |  |
| 95 | Footer links | Covered | web.links; lib.smoke-footer |  |
| 96 | Site search | Covered | func.search; lib.nav-search |  |
| 97 | Filters, sorting, pagination | Covered | app.tables; lib.crud-list, lib.shop-browse | Auto check runs on signed-in lists only |
| 98 | Login | Covered | App sign-in, sec.auth-forms; lib.login-ok |  |
| 99 | Logout | Covered | app.session (sign-out keeps session); lib.login-logout |  |
| 100 | Registration / signup | Partly (journey only) | app.form-fill on a test copy | No sign-up flow check |
| 101 | Forgot / reset password | Covered | app.forgot-password; lib.login-forgot |  |
| 102 | OTP / 2FA | Covered | app.two-step; lib.login-2fa |  |
| 103 | Social login | Partly | sec.oauth (security of the sign-in setup) | The social sign-in flow itself is not run |
| 104 | Session timeout | Covered | app.session (expired session handling, long sessions); lib.sec-session |  |
| 105 | Cookies | Covered | web.cookies |  |
| 106 | Cookie consent banner | Covered | web.privacy, privacy.consent-proof |  |
| 107 | Popups and modals | Partly | ui.cover (intrusive pop-ups), ui.consent-gate | Open/close, focus trap, Escape not tested |
| 108 | Chat widget | Partly (journey only) | Listed only as a third-party script | Widget is not opened |
| 109 | Click-to-call and email links | Partly | seo.local phone consistency | tel:/mailto: links not validated |
| 110 | WhatsApp / social buttons | Partly | Social profile links in web.links; lib.smoke-footer | Share/WhatsApp buttons not exercised |
| 111 | Image slider / carousel | Partly (journey only) | func.monkey clicks at random | No slider check |
| 112 | Accordion and tabs | Partly (journey only) | - | No accordion/tab check |
| 113 | Date picker / calendar | Partly | func.form-fields tries date values | Picker widget itself not used |
| 114 | Booking / appointment widget | Partly (journey only) | - | No booking-slot check |
| 115 | File upload | Covered | app.file-upload; lib.sec-files |  |
| 116 | File download | Covered | func.downloads |  |
| 117 | Video and audio embeds | Covered | T webrtc plays page audio/video (start time, stalls); a11y.media |  |
| 118 | Maps embed | Partly | seo.local checks a map embed exists | Map loading not checked |
| 119 | Comments and reviews | Partly (journey only) | - | Posting changes data; journeys on a test copy only |
| 120 | Rating and testimonial widgets | Partly (journey only) | - | No rating widget check |
| 121 | Social share buttons | Partly | seo.social (share preview tags) | Share buttons not clicked |
| 122 | Blog features | Partly | Crawl covers category/tag/author pages | RSS/Atom feed not validated |
| 123 | WYSIWYG / rich text editor | Partly (journey only) | - | Admin editor not tested |
| 124 | Admin panel / CMS | Partly | App module can test the admin as a signed-in app; app.exposed | No CMS-specific checks |
| 125 | Scheduled publishing | Missing | - | Time-based publishing not testable read-only |
| 126 | Print layout | Covered | T print-layout |  |
| 127 | PDF generation | Partly | T print-layout (page to PDF), a11y.documents | App-generated invoices/reports not checked |
| 128 | Notifications | Partly | push-send (apps), Mailpit in journeys | In-site banners/toasts not checked |
| 129 | Error and status pages | Partly | web.soft-404, func.not-found-page; chaos:raw-error-page | 500 and maintenance pages only via chaos test |
| 130 | Back-to-top and scroll behaviour | Partly | ui.cover (sticky bars) | Back-to-top not checked |
| 131 | Language switcher | Partly | seo.hreflang, l10n.language; lib.content-languages | Switcher not clicked |
| 132 | Currency / unit switcher | Partly | l10n.formats (mixed currencies) | Switcher not clicked |
| 133 | Live data widgets | Missing | - | Live widgets not checked |

### 4. Content, Link and URL Checks

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 134 | Broken link (internal) | Covered | web.links |  |
| 135 | Broken link (external) | Covered | web.links |  |
| 136 | Broken image and assets | Covered | web.resources |  |
| 137 | Custom 404 page | Covered | func.not-found-page; lib.nav-404 |  |
| 138 | Soft 404 | Covered | web.soft-404 |  |
| 139 | Redirect chains and loops | Covered | seo.redirect-chain |  |
| 140 | 301 vs 302 redirects | Covered | seo.redirect-chain (temporary should be permanent) |  |
| 141 | www vs non-www | Partly | web.https (http to https) | www and non-www pair not compared |
| 142 | HTTP to HTTPS redirect | Covered | web.https |  |
| 143 | Trailing slash and URL case | Partly | seo.urls (capital letters) | Trailing-slash duplicates not flagged |
| 144 | URL structure | Covered | seo.urls |  |
| 145 | Placeholder text | Covered | web.content |  |
| 146 | Spelling and grammar | Covered | content.spelling; lib.content-spelling | Spelling rules; grammar is light |
| 147 | Readability | Covered | a11y.aaa reading level, ui.readability |  |
| 148 | Contact details accuracy | Partly | seo.local name/address/phone consistency | Phone only across pages; email/address not compared |
| 149 | Social media links | Covered | web.links; lib.smoke-footer |  |
| 150 | Header and footer consistency | Partly | func.navigation (menu the same everywhere) | Footer consistency not compared |
| 151 | Favicon and logo | Covered | func.app-install (favicon), nav:logo-not-home |  |
| 152 | Duplicate pages | Partly | web.duplicates (titles, descriptions) | Body-content duplicates not detected |
| 153 | Orphan pages | Covered | seo.orphans |  |
| 154 | Outdated content | Covered | content:copyright-old; lib.content-facts |  |
| 155 | Copyright year and legal text | Covered | content:copyright-old |  |
| 156 | Link text quality | Covered | a11y.screen-reader, a11y:vague-link |  |
| 157 | Link target and rel attributes | Partly | lib.nav-new-tab | rel=noopener/nofollow not checked |
| 158 | In-page anchors | Covered | func.anchors |  |
| 159 | Email address exposure | Missing | - | Plain e-mail addresses on pages not flagged |
| 160 | Plagiarism / copied content | Missing | - | No copied-content check |
| 161 | Media file checks | Covered | perf.images (size, format) |  |
| 162 | Metadata consistency | Partly | web.duplicates, seo.local, seo.geo organisation schema | No full metadata cross-check |

### 5. Performance Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 163 | Load | Covered | k6, jmeter (permission) |  |
| 164 | Stress | Covered | k6 stress |  |
| 165 | Spike | Covered | k6 spike |  |
| 166 | Soak / endurance | Covered | k6 soak |  |
| 167 | Volume | Partly | api.owasp (10,000-record lists), app.tables | No large-data seeding |
| 168 | Scalability | Partly | k6 at rising user counts, compare runs | Adding servers not tested |
| 169 | Capacity | Covered | k6 stress (breaking point) |  |
| 170 | Breakpoint | Covered | load:breaking-point |  |
| 171 | Concurrency | Covered | rel.repeat, race, k6 |  |
| 172 | Throughput | Covered | k6, jmeter |  |
| 173 | Latency / response time | Covered | web.speed TTFB, api.availability |  |
| 174 | Baseline and benchmark | Covered | Trends baseline, master-control thresholds |  |
| 175 | Page load speed | Covered | lighthouse, web.speed |  |
| 176 | Largest Contentful Paint (LCP) | Covered | web.speed, lighthouse |  |
| 177 | Interaction to Next Paint (INP) | Covered | perf.frontend (long tasks), RUM INP |  |
| 178 | Cumulative Layout Shift (CLS) | Covered | web.speed, lighthouse |  |
| 179 | First Contentful Paint (FCP) | Covered | lighthouse |  |
| 180 | Time to First Byte (TTFB) | Covered | web.speed |  |
| 181 | Total Blocking Time (TBT) | Covered | lighthouse |  |
| 182 | Speed Index | Covered | lighthouse |  |
| 183 | Time to Interactive (TTI) | Partly | lighthouse TBT | Lighthouse 13 no longer reports TTI |
| 184 | Page weight | Covered | web.speed size, perf.carbon |  |
| 185 | Number of requests | Covered | perf:many-requests |  |
| 186 | Render-blocking resources | Covered | lighthouse audits |  |
| 187 | Critical rendering path | Partly | lighthouse request-chain insight | Shown, no own rule |
| 188 | Image optimisation | Covered | perf.images |  |
| 189 | Minification | Covered | lighthouse unminified CSS/JS audits |  |
| 190 | Compression (gzip / Brotli) | Covered | perf:no-compression |  |
| 191 | JavaScript bundle size | Covered | perf:too-much-js |  |
| 192 | Unused CSS and JS | Covered | lighthouse unused CSS/JS; Inspect coverage tab |  |
| 193 | Font loading | Covered | lighthouse font-display insight; windows-browser missing fonts |  |
| 194 | Preload / prefetch hints | Covered | lighthouse preconnect / LCP discovery |  |
| 195 | Browser caching | Covered | web.cache, perf:no-cache |  |
| 196 | Server-side caching | Partly | cache:html-stale, cache:no-304 | Redis/Varnish not checked |
| 197 | CDN | Partly | region-speed (from other regions) | No CDN detection rule |
| 198 | HTTP/2 and HTTP/3 | Missing | Inspect panel records the HTTP version | No HTTP/2 or HTTP/3 check |
| 199 | Lazy loading | Covered | perf:no-lazy-images, perf:lcp-lazy |  |
| 200 | Third-party script impact | Covered | perf:third-party-weight |  |
| 201 | Network throttling | Covered | perf.slow-network |  |
| 202 | Geographic latency | Covered | region-speed (needs regional proxies) |  |
| 203 | Memory leak | Missing | app-perf reads memory once on Android | No browser/server memory-growth test |
| 204 | CPU and resource utilisation | Partly | Grafana during load tests, conn-ssh memory/disk | No automatic CPU/RAM findings for web |
| 205 | Database performance | Covered | conn-ssh slow-query log, db:missing-index, perf.backend |  |
| 206 | API response performance | Covered | api.availability, k6 |  |
| 207 | Autoscaling | Missing | - | Autoscaling not tested |
| 208 | Performance budget | Covered | Master-control pass/fail thresholds, CLI in CI |  |
| 209 | Real User Monitoring (RUM) | Covered | RUM speed snippet |  |
| 210 | Synthetic monitoring | Covered | Schedules, uptime watch, region-speed |  |
| 211 | Uptime / availability | Covered | Uptime watch |  |
| 212 | Reliability and stability | Covered | rel.repeat, uptime watch |  |
| 213 | Mobile performance | Covered | perf.slow-network, lighthouse mobile, app-perf |  |
| 214 | Battery and power usage | Partly | appium runs the app at 4% battery | Drain not measured |

### 6. Security Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 215 | Vulnerability scanning | Covered | zap, nuclei |  |
| 216 | Penetration testing | Covered | glv-attack, zap-active, glv-probes (permission) |  |
| 217 | Black-box pen test | Covered | glv-attack |  |
| 218 | White-box pen test | Covered | Code module SAST + glv-attack | Run as two separate tests |
| 219 | Grey-box pen test | Covered | glv-attack signed-in families, app.access |  |
| 220 | SQL injection | Covered | glv-probes, zap-active, code.risky |  |
| 221 | NoSQL injection | Covered | glv-attack NoSQL |  |
| 222 | Cross-site scripting (XSS) | Covered | glv-probes, zap-active |  |
| 223 | Cross-site request forgery (CSRF) | Covered | app.csrf |  |
| 224 | Command injection | Covered | glv-attack command |  |
| 225 | Server-side template injection (SSTI) | Covered | glv-attack SSTI |  |
| 226 | Local / remote file inclusion | Covered | zap-active (remote file inclusion), glv-probes path traversal, sast:php-file-include |  |
| 227 | Directory traversal | Covered | glv-probes traversal, zap-active |  |
| 228 | XML external entity (XXE) | Partly | zap-active (GET only) | No XML-body XXE probe |
| 229 | Server-side request forgery (SSRF) | Covered | glv-attack SSRF + blind |  |
| 230 | Insecure deserialisation | Partly | glv-attack flags the surface; sast deserialize rules | Not actively exploited (by design) |
| 231 | Authentication testing | Partly | sec.auth-forms, app.user-enum, app.lockout, app.two-step | Default passwords / brute force not tried (by design) |
| 232 | Password policy | Partly | form:short-password, db:password-column-short | No password strength-rule test on sign-up |
| 233 | Account lockout and rate limiting | Covered | app.lockout, api.owasp rate limit; lib.login-lockout |  |
| 234 | Multi-factor bypass | Covered | app.two-step (skippable, reused code) |  |
| 235 | Session management | Covered | app.session |  |
| 236 | JWT attacks | Covered | app.tokens, api.tokens (unsigned, weak key, forged) |  |
| 237 | OAuth / SSO flaws | Covered | sec.oauth |  |
| 238 | Authorisation / access control | Covered | app.access |  |
| 239 | IDOR / BOLA | Covered | attack:idor, api:bola |  |
| 240 | Privilege escalation | Covered | app.access admin screens/calls, api:bfla |  |
| 241 | Mass assignment | Covered | app.mass-assignment, api:mass-assignment |  |
| 242 | Business-logic flaws | Partly | glv-attack logic (quantity), race | Price tampering and step skipping not tried |
| 243 | Race conditions | Covered | race |  |
| 244 | Account enumeration | Covered | app.user-enum, app:reset-user-enum |  |
| 245 | Password reset poisoning | Covered | app.forgot-password (reset link built from Host) |  |
| 246 | Host header injection | Covered | glv-attack host header |  |
| 247 | HTTP parameter pollution | Missing | - | No HTTP parameter pollution test |
| 248 | CRLF / header injection | Covered | glv-attack CRLF |  |
| 249 | HTTP request smuggling | Covered | glv-attack smuggling |  |
| 250 | Web cache poisoning | Covered | glv-attack cache poisoning |  |
| 251 | Open redirect | Covered | glv-probes open redirect, app.login-redirect |  |
| 252 | Clickjacking | Covered | sec:clickjacking |  |
| 253 | CORS misconfiguration | Covered | sec.cors, glv-attack CORS |  |
| 254 | Prototype pollution | Partly | sec.js-libraries (known prototype-pollution CVEs), code.risky | No client-side pollution probe |
| 255 | File upload vulnerabilities | Covered | app.file-upload |  |
| 256 | Sensitive data exposure | Covered | sec.info-leak, api.exposure, code.secrets |  |
| 257 | PII in URLs and logs | Covered | app.data-in-url, sec.hipaa, runtime:log-leak |  |
| 258 | Source map and secret exposure | Covered | sec:source-map, app:source-maps, gitleaks |  |
| 259 | Exposed files and folders | Covered | web.exposed-files |  |
| 260 | Security misconfiguration | Covered | nuclei, app.exposed |  |
| 261 | Error message leakage | Covered | sec.info-leak, api.errors |  |
| 262 | Security headers | Covered | web.security-headers, sec.csp-strength |  |
| 263 | SSL/TLS | Covered | testssl |  |
| 264 | Certificate expiry | Covered | web.https, uptime watch certificate |  |
| 265 | Mixed content | Covered | web.mixed-content |  |
| 266 | Cookie security | Covered | web.security-headers, web.cookies |  |
| 267 | Subresource integrity (SRI) | Covered | sec.sri |  |
| 268 | Subdomain takeover | Covered | surface |  |
| 269 | Subdomain and asset discovery | Covered | surface |  |
| 270 | Port scanning | Covered | ports (permission) |  |
| 271 | Outdated software and CMS | Covered | nuclei, sec.js-libraries, wp:version-visible |  |
| 272 | Plugin and theme vulnerabilities | Partly | nuclei WordPress CVE templates | No plugin/theme enumeration like WPScan |
| 273 | WordPress hardening | Covered | web.wordpress |  |
| 274 | Admin login protection | Partly | app.lockout, app.two-step | Hidden login URL / admin rate limit not checked |
| 275 | Malware and blacklist check | Partly | malware, sec.hacked | No blacklist (Safe Browsing style) lookup |
| 276 | Magecart / card-skimming scan | Covered | sec.hacked skimmer, store.checkout, sec.pci-scripts |  |
| 277 | Web Application Firewall (WAF) | Missing | - | No WAF detection |
| 278 | DoS / DDoS resistance | Partly | k6 stress/spike (permission) | No flood-style DoS (by design) |
| 279 | Bot and scraping protection | Missing | - | No bot/scraping protection check |
| 280 | CAPTCHA effectiveness | Missing | - | No CAPTCHA effectiveness check |
| 281 | Credential stuffing | Missing | app.lockout is the closest | Not done (by design) |
| 282 | Fuzzing | Covered | schemathesis, api.negative, func.monkey, func.form-fields |  |
| 283 | DNS and email spoofing | Covered | sec.email-dns (SPF, DKIM, DMARC, DNSSEC) |  |
| 284 | API security | Covered | api.owasp, api.audit, api.access |  |
| 285 | Cloud misconfiguration | Covered | cloud |  |
| 286 | Container and image security | Covered | trivy, code.container |  |
| 287 | SAST | Covered | code.risky, opengrep, code.sast-languages |  |
| 288 | DAST | Covered | zap, nuclei, DAST agents |  |
| 289 | IAST | Partly | iast (pattern scan + optional runtime hook) | No true in-app sensor |
| 290 | SCA / dependency scanning | Covered | code.packages, osv-scanner, trivy |  |
| 291 | Secrets scanning | Covered | gitleaks, code.secrets |  |
| 292 | Threat modelling | Not automatable | - | Planning workshop |
| 293 | Red teaming | Not automatable | glv-attack is the closest automated part | Specialist human team |
| 294 | Social engineering / phishing simulation | Not automatable | lookalike domains is related | Human-side testing |
| 295 | Compliance security audit | Covered | soc2 evidence, OWASP Top 10 and PCI handbook rows |  |
| 296 | Security regression | Covered | Re-tests mark issues that come back |  |
| 297 | Private-page cache control | Covered | app.private-cache |  |

### 7. Usability and UX Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 298 | Usability (moderated) | Not automatable | Handbook: Usability testing | Real users |
| 299 | Usability (unmoderated remote) | Not automatable | Handbook: Usability testing | Real users |
| 300 | Navigation / information architecture | Partly | func.navigation, seo.link-graph (click depth) | Real "can users find it" needs people |
| 301 | Card sorting | Not automatable | - | User research |
| 302 | Tree testing | Not automatable | - | User research |
| 303 | First-click | Not automatable | - | User research |
| 304 | Five-second test | Not automatable | - | User research |
| 305 | Heuristic evaluation | Missing | - | Could be AI-assisted (Claude reviews screenshots against Nielsen's 10) |
| 306 | Cognitive walkthrough | Not automatable | - | Expert walkthrough |
| 307 | Task success and time-on-task | Not automatable | - | Needs real users |
| 308 | System Usability Scale (SUS) | Not automatable | - | Survey |
| 309 | Net Promoter Score (NPS) | Not automatable | - | Survey |
| 310 | Customer satisfaction (CSAT) | Not automatable | - | Survey |
| 311 | A/B testing | Not automatable | Handbook: A/B testing | Marketing experiment |
| 312 | Multivariate testing | Not automatable | - | Marketing experiment |
| 313 | Split-URL testing | Not automatable | - | Marketing experiment |
| 314 | Heatmaps and click maps | Missing | - | Real-user analytics (would extend the RUM snippet) |
| 315 | Session recording | Missing | - | Real-user analytics (would extend the RUM snippet) |
| 316 | Funnel analysis | Missing | - | Real-user analytics |
| 317 | User flow analysis | Missing | - | Real-user analytics |
| 318 | Onboarding | Partly (journey only) | - | No onboarding check |
| 319 | Microcopy | Missing | content.spelling only | Labels/help text quality not reviewed (AI-assisted possible) |
| 320 | Error message usability | Covered | lib.form-bad; form-fields checks messages |  |
| 321 | Form usability | Partly | autocomplete and label checks, axe labels | Field order/autofill flow not tested |
| 322 | Mobile usability | Covered | web.mobile (tap targets, text size) |  |
| 323 | Consistency | Partly | func.navigation (menus) | Visual/wording consistency not compared |
| 324 | Visual hierarchy | Not automatable | - | Design judgement |
| 325 | Call-to-action (CTA) effectiveness | Not automatable | - | Needs analytics/A-B |
| 326 | Trust signals | Partly | saas.trust, store.policies, seo.local contact | Reviews/badges not checked |
| 327 | Content comprehension | Not automatable | - | Needs people |
| 328 | Search usability | Covered | func.search (no-result message) | Autocomplete not checked |
| 329 | Dark mode and theming | Covered | Master control dark mode; lib.look-dark; device:dark-mode |  |
| 330 | Eye tracking | Not automatable | - | Hardware study |
| 331 | Prototype testing | Not automatable | - | Design stage |
| 332 | Diary and field studies | Not automatable | - | User research |
| 333 | Customer feedback widgets | Missing | - | Feedback widgets not checked |

### 8. Accessibility Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 334 | WCAG 2.2 automated scan | Covered | web.accessibility (axe), a11y.engine2, lighthouse |  |
| 335 | WCAG manual audit | Covered | WCAG tab (every A/AA criterion); lib.a11y-* manual cases |  |
| 336 | Keyboard navigation | Covered | a11y.keyboard; lib.a11y-keyboard |  |
| 337 | Tab and focus order | Covered | a11y.keyboard, Inspect tab-order view |  |
| 338 | Visible focus indicator | Covered | a11y:focus-not-visible |  |
| 339 | Skip links | Covered | axe bypass rule, india.gigw skip link |  |
| 340 | Screen reader | Covered | a11y.screen-reader, mac-voiceover, talkback; lib.a11y-reader |  |
| 341 | Voice control | Missing | - | No voice-control (label-in-name) test |
| 342 | Colour contrast | Covered | axe contrast |  |
| 343 | Colour-blindness simulation | Covered | a11y.colour-vision; lib.a11y-colour |  |
| 344 | Alt text | Covered | axe image-alt |  |
| 345 | Headings and landmarks | Covered | a11y.screen-reader (heading skips, no main) |  |
| 346 | ARIA roles and labels | Covered | axe ARIA rules |  |
| 347 | Form labels and errors | Covered | axe labels, func.form-fields |  |
| 348 | Zoom and text resize | Covered | a11y.zoom 200% |  |
| 349 | Reflow and responsive | Covered | a11y.zoom 400% reflow |  |
| 350 | Reduced motion | Covered | a11y.motion |  |
| 351 | Flashing content | Missing | - | No three-flashes check |
| 352 | Captions and transcripts | Covered | a11y.media; lib.a11y-captions |  |
| 353 | Audio description | Missing | - | Audio description not checked |
| 354 | Time limits | Covered | a11y:time-limit, a11y.aaa timed refresh |  |
| 355 | Link purpose | Covered | a11y:vague-link, axe link-name |  |
| 356 | Touch target size | Covered | web.mobile (WCAG 2.5.8) |  |
| 357 | Language declaration | Covered | axe html-has-lang, seo:lang-missing |  |
| 358 | Accessible PDFs | Covered | a11y.documents, verapdf |  |
| 359 | Accessible CAPTCHA | Missing | - | No accessible-CAPTCHA check |
| 360 | Cognitive accessibility | Partly | a11y.aaa (reading level, consistent help) | Flows not judged |
| 361 | Magnifier and high-contrast mode | Missing | - | No forced-colors / high-contrast run |
| 362 | Accessibility statement | Partly | india.gigw (gov sites, off by default) | Not checked for other sites |

### 9. Compatibility Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 363 | Cross-browser | Covered | func.browsers, mac-safari, windows-browser, inapp-browser |  |
| 364 | Browser version | Covered | browser-matrix (needs GLV Selenium Grid) |  |
| 365 | Cross-device | Covered | func.devices, device-matrix, appium |  |
| 366 | Cross-OS | Covered | Linux bundled, windows-browser VM, Mac helper, Android/iOS emulators | Windows and Mac need their helpers set up |
| 367 | Responsive design | Covered | web.mobile, web.tablet, func.devices |  |
| 368 | Screen resolution and DPI | Partly | func.devices sizes | Retina / 4K pixel ratios not run |
| 369 | Orientation | Covered | appium rotation, device:landscape; lib.look-rotate |  |
| 370 | Touch vs mouse | Missing | - | Hover-only menus/touch vs mouse not checked |
| 371 | Network compatibility | Covered | perf.slow-network, app:offline-broken, device offline |  |
| 372 | Assistive technology compatibility | Covered | mac-voiceover, talkback, a11y.screen-reader |  |
| 373 | Browser feature support | Covered | browser-matrix (matrix:css-unsupported) |  |
| 374 | Polyfill and fallback | Partly | browser-matrix older versions | Fallbacks not judged separately |
| 375 | Browser settings | Partly | seo.rendered-html shows the no-JavaScript view | Cookies-off and ad-blocker runs not done |
| 376 | Browser extension interference | Missing | - | Extension interference not tested |
| 377 | Email client compatibility | Partly | email-render (rule-based) | No real mail-client renders |
| 378 | Print and PDF output | Covered | print-layout |  |
| 379 | Smart TV and wearables | Covered | device-matrix (watch/TV profiles) | Screen profiles, not real devices |
| 380 | In-app browsers | Covered | inapp-browser |  |
| 381 | Reader mode and text-only | Missing | - | Reader mode not tested |
| 382 | Right-to-left rendering | Covered | l10n:rtl-missing |  |
| 383 | Operating-system settings | Partly | a11y.motion, master control dark mode, device:large-text (apps) | Web large-font setting not run |
| 384 | Hardware variety | Partly | perf.slow-network (4x slower CPU) | Low RAM not simulated |
| 385 | Server environment compatibility | Partly | conn-ssh (PHP/OS end of life), code.container | No version matrix run |

### 10. SEO Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 386 | On-page SEO | Covered | web.seo, seo.audit |  |
| 387 | Technical SEO | Covered | web.crawlability, seo.redirect-chain, seo.rendered-html |  |
| 388 | Title tag | Covered | web.seo, web.duplicates |  |
| 389 | Meta description | Covered | web.seo, web.duplicates |  |
| 390 | Heading structure | Covered | seo:h1-missing/multiple, a11y heading skips |  |
| 391 | Robots.txt | Covered | web.crawlability |  |
| 392 | XML sitemap | Covered | web.crawlability, seo.orphans |  |
| 393 | Canonical tags | Covered | web.seo canonical |  |
| 394 | Noindex / nofollow | Covered | seo:noindex |  |
| 395 | Index coverage | Partly | seo.audit reads an uploaded Search Console export | No live index check (needs Google) |
| 396 | Crawl budget and crawl errors | Covered | log-seo (Googlebot in logs), crawl errors |  |
| 397 | Redirect audit | Covered | seo.redirect-chain |  |
| 398 | Structured data / schema | Covered | web.structured-data |  |
| 399 | Open Graph and Twitter cards | Covered | seo.social |  |
| 400 | hreflang | Covered | seo.hreflang |  |
| 401 | Mobile-first indexing | Partly | web.mobile, web.seo | Phone vs desktop content parity not compared |
| 402 | Core Web Vitals for SEO | Covered | web.speed, lighthouse, RUM |  |
| 403 | HTTPS and mixed content | Covered | web.https, web.mixed-content |  |
| 404 | Duplicate content | Partly | web.duplicates (titles, descriptions) | Body-text duplicates not detected |
| 405 | Thin content | Covered | seo.thin-content |  |
| 406 | Keyword research | Missing | - | Needs search-volume data (not in-house) |
| 407 | Keyword cannibalisation | Covered | seo:keyword-cannibal (seo.audit) |  |
| 408 | Content gap analysis | Missing | - | Needs competitor ranking data |
| 409 | Search intent match | Not automatable | - | SERP review by a person |
| 410 | Internal linking | Covered | seo.link-graph |  |
| 411 | Orphan pages | Covered | seo.orphans |  |
| 412 | Backlink audit | Covered | backlinks (Common Crawl), seo.audit backlink check | Smaller index than paid tools |
| 413 | Anchor text profile | Partly | backlinks tool | Anchor-text profile not reported |
| 414 | Image SEO | Covered | seo.image-video, image alt |  |
| 415 | URL structure | Covered | seo.urls |  |
| 416 | Pagination SEO | Missing | - | Pagination SEO not checked |
| 417 | Faceted navigation SEO | Missing | seo:session-in-url only | Faceted URL explosion not checked |
| 418 | JavaScript SEO | Covered | seo.js-render, seo.rendered-html |  |
| 419 | Local SEO | Covered | seo.local |  |
| 420 | Google Business Profile | Partly | seo:no-gbp-link | Listing completeness needs Google |
| 421 | Rich snippet eligibility | Partly | web.structured-data (product rich results) | Other rich-result types not checked |
| 422 | Voice and featured snippet readiness | Partly | seo.geo (answer headings) | No FAQ/featured-snippet check |
| 423 | International SEO | Covered | seo.hreflang |  |
| 424 | Site migration SEO | Missing | - | No old-to-new redirect map check |
| 425 | Analytics and tag verification | Partly | web.privacy lists trackers; consent-proof | Events firing correctly not checked |
| 426 | Search Console health | Partly | Search Console export upload | Manual actions/security issues need Google |
| 427 | Rank tracking | Covered | rank-tracking (directional) |  |
| 428 | Competitor SEO benchmarking | Missing | - | No competitor benchmark run |
| 429 | Content freshness | Partly | geo:no-dates, content:copyright-old |  |
| 430 | E-E-A-T signals | Partly | geo:no-author, organisation schema, sameAs |  |

### 11. Localisation and Internationalisation

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 431 | Internationalisation (i18n) | Partly | l10n.locale (other language and time zone) | No pseudo-localisation |
| 432 | Localisation (l10n) | Partly | l10n.language, app:partial-translation, android/ios languages | Translation completeness only |
| 433 | Translation quality | Not automatable | - | Native reviewers |
| 434 | Currency, number and date formats | Covered | l10n.formats, l10n.locale |  |
| 435 | Time zone handling | Covered | l10n.locale (+14 h zone), res:naive-datetime |  |
| 436 | Right-to-left (RTL) support | Covered | l10n:rtl-missing |  |
| 437 | Unicode and character encoding | Covered | l10n:not-utf8, l10n:garbled-text; lib.form-long |  |
| 438 | Text expansion | Missing | - | No text-expansion (pseudo-locale) run |
| 439 | Cultural and legal fit | Not automatable | - | Native reviewers |
| 440 | Local payment and address formats | Partly | form:pincode-letters, form:phone-length (India) | Local payment methods not checked |
| 441 | Language detection and switching | Partly | l10n.locale | Auto-detect and switch not exercised |
| 442 | Locale-specific sorting and search | Missing | - | Locale sorting not checked |

### 12. Compliance, Legal and Policy Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 443 | GDPR | Covered | web.privacy, privacy.consent-proof, web.cookies |  |
| 444 | CCPA / CPRA | Partly | Generic consent checks | No "Do not sell/share" link or GPC check |
| 445 | India DPDP Act | Covered | india.dpdp, india.dpdp-forms |  |
| 446 | Cookie consent compliance | Covered | privacy.consent-proof |  |
| 447 | Privacy policy | Covered | india.dpdp notice checks, page-watch; lib.content-legal |  |
| 448 | Terms and conditions | Covered | store.policies, saas.trust, page-watch |  |
| 449 | Refund, shipping and return policy | Covered | store.policies |  |
| 450 | PCI-DSS | Covered | sec.pci-scripts, store.checkout, PCI handbook row |  |
| 451 | ADA and Section 508 | Covered | WCAG tab, vpat |  |
| 452 | EN 301 549 / EAA | Covered | vpat (EN 301 549) |  |
| 453 | HIPAA | Partly | sec.hipaa (health data leakage) | Leakage only, not the full rule set |
| 454 | COPPA | Partly | india.dpdp checks the children's-data part of the notice | COPPA itself not checked |
| 455 | CAN-SPAM and email consent | Covered | email-render (no unsubscribe), messaging (no opt-out) |  |
| 456 | Licensing of fonts, images and libraries | Partly | sbom licences for packages | Fonts and images not checked |
| 457 | Open-source licence compliance | Covered | sbom, trivy licence |  |
| 458 | Data retention and deletion | Partly | india.dpdp notice mentions retention | Export/delete-on-request not tested |
| 459 | Data residency | Partly | cloud (regions in the account) | No residency rule |
| 460 | Age gating | Missing | - | Age gates not checked |
| 461 | Advertising disclosure | Missing | - | Sponsored/affiliate labels not checked |
| 462 | Payment gateway approval checks | Covered | store.policies, saas.trust |  |
| 463 | Consumer protection and e-commerce law | Partly | ux.dark-patterns (drip pricing), store.product price | Seller/tax information not checked |
| 464 | Accessibility statement and contact | Partly | india.gigw (gov sites) | Not checked for other sites |
| 465 | SOC 2 / ISO 27001 readiness | Covered | soc2 |  |

### 13. API and Back-end Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 466 | Functional API | Covered | api.availability, api.contract, api.scenarios |  |
| 467 | Schema / contract | Covered | api.contract, schemathesis, Pact |  |
| 468 | OpenAPI / Swagger conformance | Covered | schemathesis |  |
| 469 | Negative API | Covered | api.negative |  |
| 470 | Status codes and error format | Covered | api.contract, api.errors |  |
| 471 | Authentication (API key, OAuth, JWT) | Covered | api.auth, api.tokens |  |
| 472 | Authorisation per endpoint | Covered | api.access |  |
| 473 | Rate limiting and throttling | Covered | api.owasp |  |
| 474 | API load | Covered | k6 |  |
| 475 | API security | Covered | api.owasp, api.audit, zap, nuclei |  |
| 476 | Excessive data exposure | Covered | api.exposure, api:undocumented-fields, app:call-too-much-data |  |
| 477 | Versioning | Covered | api.versions, api.changes |  |
| 478 | Pagination and filtering API | Partly | api:no-page-limit | Correct slices and counts not checked |
| 479 | Idempotency | Covered | api.http, api.writes |  |
| 480 | Webhooks | Covered | Webhook test inbox, res:webhook-unsigned |  |
| 481 | GraphQL | Partly | API module GraphQL (depth, alias, introspection) | Mutations not tested yet |
| 482 | SOAP / XML services | Covered | API module SOAP |  |
| 483 | gRPC | Covered | API module gRPC |  |
| 484 | WebSocket and server-sent events | Partly | API module WebSocket | Server-sent events not tested |
| 485 | Mocking and stubbing | Covered | api-mock |  |
| 486 | Service virtualisation | Covered | api-mock |  |
| 487 | Timeout and retry behaviour | Partly | res:no-timeout (code), chaos delay (server) | No live retry test |
| 488 | Third-party API integration | Partly | payments (test keys), messaging templates | Other third-party APIs not exercised |
| 489 | Data validation | Covered | api.negative (invalid input accepted) |  |
| 490 | Background jobs and queues | Partly | queues (AsyncAPI spec) | Workers/cron runs not tested |
| 491 | Message queue testing | Partly | queues (spec only) | No broker connection |
| 492 | File and media handling | Partly | app.file-upload (security) | Processing and storage not checked |
| 493 | Logging and audit trail | Partly | conn-ssh log retention | App audit trail not verified |
| 494 | Microservice contract | Covered | Pact in API module |  |
| 495 | API documentation | Covered | api.spec, api.audit; lib.api-docs |  |
| 496 | Backward-compatibl e changes | Covered | api.changes, openapi-diff |  |

### 14. Database and Data Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 497 | CRUD operations | Covered | api.writes, app.form-fill (test copy); lib.crud-* |  |
| 498 | Data integrity and constraints | Covered | code.database (keys, foreign keys) | Static schema check |
| 499 | Transactions (ACID) | Partly | res:payment-no-idempotency | No transaction rollback test |
| 500 | Stored procedures and triggers | Partly | db-code lists procedures/triggers | Does not run them |
| 501 | Data migration | Partly | code.database migration checks | Moved data not compared |
| 502 | Data validation and reconciliation | Covered | reconciliation, data-quality |  |
| 503 | Backup and restore | Partly | dr-drill (backups recent, restore tested?) | Does not perform a restore |
| 504 | Replication and failover | Missing | - | Replication/failover not tested |
| 505 | Index and query performance | Covered | db:slow-queries, db:missing-index |  |
| 506 | Concurrency and locking | Covered | race; lib.crud-two-tabs |  |
| 507 | Data masking and anonymisation | Missing | - | Test-data masking not checked |
| 508 | Test data generation | Partly | app.form-fill realistic values, api-mock examples | No test-data generator |
| 509 | Data encryption | Partly | testssl, db:plain-passwords, iac:unencrypted | At-rest database encryption not checked |
| 510 | Search index consistency | Missing | - | Search index vs database not compared |
| 511 | Report and dashboard accuracy | Partly | reconciliation (totals) | Dashboards not compared |
| 512 | Data import and export | Covered | lib.crud-import; app:csv-formula-injection |  |
| 513 | Archival and purge | Missing | - | Archival/purge not checked |
| 514 | Schema migration | Covered | code.database (destructive, no down migration) |  |

### 15. Infrastructure, DevOps and Release Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 515 | DNS configuration | Partly | sec.email-dns (mail records, CAA, DNSSEC) | A/AAAA records and propagation not checked |
| 516 | Domain expiry and ownership | Partly | conn-hostinger (Hostinger domains only) | Other registrars not checked |
| 517 | SSL certificate renewal | Covered | web.https expiry, uptime watch certificate |  |
| 518 | Server configuration | Covered | conn-ssh hardening, lynis |  |
| 519 | Email deliverability | Covered | sec.email-dns, email:spam-risk |  |
| 520 | Uptime and health checks | Covered | Uptime watch |  |
| 521 | Status page | Missing | - | Status page not checked |
| 522 | Load balancer | Partly | k6 load | Traffic spread across servers not checked |
| 523 | Reverse proxy and CDN rules | Partly | web.cache, cache poisoning | Routing rules not checked |
| 524 | Firewall and network rules | Covered | ports, server:no-firewall, cloud |  |
| 525 | Failover and redundancy | Partly | chaos (stop a service, recovery), k8s:single-replica | Automatic failover not proven |
| 526 | Disaster recovery | Partly | dr-drill | Checks drill evidence, does not run one |
| 527 | Chaos engineering | Covered | chaos (permission) |  |
| 528 | Deployment | Partly | Post-deploy smoke and re-tests | Deploy step itself not checked |
| 529 | Rollback | Missing | - | Rollback not tested |
| 530 | Blue-green and canary release | Not automatable | Handbook: Blue-green / Canary rows | Release practice; test each address as a project |
| 531 | Zero-downtime deploy | Partly | Uptime watch every minute | Not tied to a deploy |
| 532 | Post-deploy smoke | Covered | Smoke agents, scheduled re-test |  |
| 533 | Infrastructure as code | Covered | iac |  |
| 534 | Container testing | Covered | trivy, code.container |  |
| 535 | Kubernetes and orchestration | Covered | k8s |  |
| 536 | Environment parity | Missing | - | Staging vs production not compared |
| 537 | Environment variable and secret handling | Covered | gitleaks, code:env-committed |  |
| 538 | Logging and monitoring | Partly | conn-ssh logs | Error capture/alerts not verified |
| 539 | Alert and on-call testing | Not automatable | - | Paging people is an ops drill |
| 540 | CI/CD pipeline | Covered | code.supply-chain CI checks, tests:no-ci, CLI in CI |  |
| 541 | Cron and scheduled tasks | Partly | conn-ssh reads cron | Runs on time not verified |
| 542 | Backup verification | Partly | dr-drill | Same as backup and restore |
| 543 | Cost and resource monitoring | Partly | ai-cost (AI calls only) | Cloud spend not checked |
| 544 | Hosting and CDN failover | Not automatable | - | Provider-outage drill |
| 545 | Version and dependency monitoring | Covered | code.packages, sec.js-libraries, server:php-end-of-life |  |

### 16. Visual and Front-end Quality Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 546 | Visual regression | Covered | Visual compare |  |
| 547 | UI / GUI | Partly | ui.overlap, ui.cut-text, ui.visual-layout | Match to design not checked |
| 548 | Design-to-code (pixel perfect) | Missing | - | No design-file compare |
| 549 | Responsive layout breakpoints | Covered | ui.overlap-phone, ui.visual-layout, func.devices |  |
| 550 | Typography | Partly | a11y2:tiny-font, ui.readability, windows fonts |  |
| 551 | Colour and brand consistency | Covered | lib.look-brand | Manual case |
| 552 | Spacing and alignment | Missing | - | Spacing/alignment not checked |
| 553 | Icons and images | Partly | ui:stretched-image, perf:oversized-image | Blurry upscaled images not flagged |
| 554 | Animation and transitions | Partly | a11y.motion | Smoothness not measured |
| 555 | Scroll effects and parallax | Partly | ui.cover (sticky bars) | Parallax not checked |
| 556 | Video and audio playback | Covered | webrtc media playback |  |
| 557 | HTML validation | Covered | vnu |  |
| 558 | CSS validation and linting | Covered | vnu --also-check-css | No Stylelint |
| 559 | JavaScript console errors | Covered | web.js-errors |  |
| 560 | Network errors | Covered | web.resources, perf.network |  |
| 561 | Mixed content | Covered | web.mixed-content |  |
| 562 | Z-index and overlay issues | Partly | ui.overlap, ui.cover, a11y:focus-obscured | Menu-behind-popup cases not checked |
| 563 | Z-pattern and fold content | Missing | - | Above-the-fold content not checked |
| 564 | Spelling and text overflow | Covered | ui.cut-text, ui.overlap |  |
| 565 | Empty, loading and error states | Partly | app:table-no-empty-message, search:no-empty-message | Loading/error states not checked |
| 566 | Form field styling and states | Partly | a11y focus visible | Error/disabled/success states not checked |
| 567 | Pop-up and cookie banner overlap | Covered | ui.cover, ui:consent-button-covered |  |
| 568 | Print stylesheet | Covered | print:no-print-css |  |
| 569 | Dark mode visuals | Partly | Master control dark mode; lib.look-dark | No dark-specific checks |
| 570 | Component library consistency | Missing | - | No component-library (Storybook) check |
| 571 | Browser rendering differences | Covered | func.browsers, mac-safari side by side |  |
| 572 | Image formats and art direction | Covered | perf:legacy-image-format, oversized/srcset |  |

### 17. E-commerce / Online Store Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 573 | Product listing and category pages | Covered | store agents; lib.shop-browse |  |
| 574 | Product detail page | Covered | store.product |  |
| 575 | Product data accuracy | Partly | store.product (price/stock in product data) | Back-end values not compared |
| 576 | Variants and options | Partly (journey only) | - | Variant selection not tested |
| 577 | Product images and zoom | Partly (journey only) | - | Gallery/zoom not tested |
| 578 | Add to cart | Covered | lib.shop-cart | Manual case |
| 579 | Cart | Covered | lib.shop-cart | Persistence after login not covered |
| 580 | Mini cart and cart drawer | Partly (journey only) | - | Mini cart not tested |
| 581 | Checkout flow | Covered | lib.shop-checkout, store.checkout |  |
| 582 | Guest checkout | Partly (journey only) | - | Guest checkout not called out |
| 583 | Address and pin-code validation | Partly | form:pincode-letters | Serviceability not checked |
| 584 | Shipping methods and cost | Covered | lib.shop-tax (delivery adds up) |  |
| 585 | Tax calculation | Covered | lib.shop-tax |  |
| 586 | Coupon and discount | Covered | lib.shop-coupon, race (coupon reuse) |  |
| 587 | Payment gateway | Covered | payments (test mode), lib.shop-declined |  |
| 588 | Payment methods | Partly | payments (Stripe, Razorpay) | UPI, wallets, COD, EMI, BNPL not covered |
| 589 | 3-D Secure / OTP flow | Partly (journey only) | - | 3-D Secure step not tested |
| 590 | Order confirmation | Covered | lib.shop-checkout (confirmation + email) |  |
| 591 | Order management | Partly (journey only) | - | Order management not tested |
| 592 | Invoice and receipt | Partly (journey only) | - | Invoice PDF not checked |
| 593 | Inventory sync | Missing | - | Inventory sync not checked |
| 594 | Out-of-stock and backorder | Partly (journey only) | - | Out-of-stock and notify-me not tested |
| 595 | Returns, refunds and exchanges | Partly (journey only) | - | Returns/refunds not tested |
| 596 | Abandoned cart recovery | Missing | - | Abandoned-cart reminders not tested |
| 597 | Wishlist and compare | Partly (journey only) | - | Wishlist/compare not tested |
| 598 | Customer reviews and ratings | Partly (journey only) | - | Reviews not tested |
| 599 | Account area | Partly | Signed-in app module | No store-account checks |
| 600 | Search and merchandising | Partly | func.search | Relevance/synonyms not judged |
| 601 | Multi-currency and multi-language | Partly | l10n.formats, seo.hreflang |  |
| 602 | Marketplace / multi-vendor | Partly | app.access (vendor role) | Commissions not checked |
| 603 | Subscription and recurring orders | Partly | iap (apps); handbook Subscription row | No billing test clock |
| 604 | Gift cards and store credit | Partly | race (redeem many times at once) | Balance logic not tested |
| 605 | Fraud and risk rules | Missing | - | Fraud rules not tested |
| 606 | Order notifications and tracking | Partly (journey only) | - | Tracking links not tested |
| 607 | Policy pages for gateways | Covered | store.policies |  |
| 608 | Product feed (Google Merchant) | Missing | - | Google Merchant feed not checked |
| 609 | Tracking pixels and conversion events | Missing | - | Purchase events firing once not checked |
| 610 | Theme and plugin conflicts | Partly | web.js-errors after updates | No conflict-specific test |
| 611 | Checkout script integrity | Covered | sec.pci-scripts, sec.hacked skimmer |  |
| 612 | Performance during sales | Covered | k6, jmeter journeys |  |
| 613 | Store speed (Shopify and Woo specific) | Covered | lighthouse, perf agents |  |
| 614 | Admin and staff roles | Covered | app.access roles |  |

### 18. SaaS, Web App and CRM Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 615 | Multi-tenant isolation | Covered | app.access other company; lib.role-other-client |  |
| 616 | Role-based access control (RBAC) | Covered | app.access; lib.role-each |  |
| 617 | Signup and onboarding | Partly (journey only) | - | Sign-up/onboarding not tested |
| 618 | Subscription and billing | Partly | saas.trust, payments | Plan changes and invoices not tested |
| 619 | Payment failure and dunning | Missing | - | Dunning not tested |
| 620 | Proration and credits | Missing | - | Proration not tested |
| 621 | Usage limits and quotas | Missing | - | Plan limits not tested |
| 622 | Lead capture forms | Covered | lib.form-happy; webhook inbox in journeys |  |
| 623 | Lead assignment and routing | Partly (journey only) | - | Lead routing not tested |
| 624 | Pipeline and stage workflow | Partly (journey only) | - | Pipeline stages not tested |
| 625 | Contact and company records | Covered | lib.crud-add/edit/delete |  |
| 626 | Duplicate detection and merge | Partly (journey only) | - | Duplicate detection not tested |
| 627 | Custom fields and layouts | Partly (journey only) | - | Custom fields not tested |
| 628 | Automation and triggers | Partly (journey only) | Webhook inbox + Mailpit in journeys | No built-in check |
| 629 | Email integration | Partly (journey only) | Mailpit in journeys |  |
| 630 | WhatsApp and SMS integration | Partly | messaging (SMS/WhatsApp templates) | Send/receive not tested |
| 631 | Telephony and click-to-call | Missing | - | Telephony not tested |
| 632 | Calendar sync | Missing | - | Calendar sync not tested |
| 633 | Tasks, reminders and follow-ups | Partly (journey only) | - | Reminders not tested |
| 634 | Import and export (CSV) | Covered | lib.crud-import; app:csv-formula-injection |  |
| 635 | Bulk actions | Partly (journey only) | - | Bulk actions not tested |
| 636 | Search and filters | Covered | app.tables; lib.crud-list |  |
| 637 | Reports and dashboards | Partly | reconciliation | Dashboards not compared |
| 638 | Notifications and alerts | Partly (journey only) | - | In-app notifications not tested |
| 639 | Audit log | Partly (journey only) | - | Audit log not verified |
| 640 | Permissions on fields and records | Partly | app.access (record-level, hidden screens) | Field-level access not checked |
| 641 | Team and user management | Partly (journey only) | - | Invite/deactivate not tested |
| 642 | Single sign-on (SSO) | Partly | sec.oauth (SAML metadata) | SSO sign-in flow not run |
| 643 | API and webhook access | Covered | API module |  |
| 644 | Third-party integrations | Missing | - | Zapier/Slack/accounting integrations not tested |
| 645 | Data backup and export for customers | Partly (journey only) | lib.crud-import (export part) |  |
| 646 | Account deletion and offboarding | Partly (journey only) | - | Account deletion not tested |
| 647 | Mobile and responsive app | Covered | web.mobile, web.tablet, func.devices |  |
| 648 | Real-time collaboration | Partly | lib.crud-two-tabs, API WebSocket | Live updates between users not tested |
| 649 | Performance with large data | Partly | app.tables, perf.backend, k6 |  |
| 650 | Feature flags and gradual rollout | Missing | - | Feature flags not tested |
| 651 | In-app help and chat | Partly (journey only) | - | In-app help not tested |
| 652 | White-label and branding | Partly (journey only) | - | Client's white-label settings not tested |
| 653 | Localisation of the app | Partly | app:partial-translation, l10n agents |  |
| 654 | Disaster recovery for tenant data | Missing | - | Per-tenant restore not tested |

### 19. Modern Web Technology Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 655 | Single-page app (SPA) routing | Covered | func.back-forward, hash-route screens |  |
| 656 | Server-side rendering and hydration | Covered | seo.rendered-html, seo.js-render, web.js-errors |  |
| 657 | Static site / Jamstack | Covered | Standard crawl and link checks |  |
| 658 | Progressive Web App (PWA) | Covered | func.app-install (manifest) |  |
| 659 | Service worker and offline mode | Covered | app:offline-broken |  |
| 660 | Web push notifications | Missing | - | Web push not tested |
| 661 | Web storage | Partly | app.tokens (tokens in storage) | Storage behaviour not tested |
| 662 | WebSocket and server-sent events | Partly | API module WebSocket | Server-sent events not tested |
| 663 | WebRTC | Partly | webrtc detects WebRTC use | Calls not placed |
| 664 | WebAssembly | Missing | - | WebAssembly not tested |
| 665 | Web Components and Shadow DOM | Partly | App explorer reads shadow DOM | No component behaviour check |
| 666 | Micro-frontends | Partly | Standard crawl and JS errors |  |
| 667 | Headless CMS | Partly | API module can test the content API |  |
| 668 | Social login and OAuth | Partly | sec.oauth | Flow not run |
| 669 | Passkeys / WebAuthn | Missing | - | Passkeys/WebAuthn not tested |
| 670 | Payment Request API (Apple/Google Pay) | Missing | - | Payment Request API not tested |
| 671 | Geolocation | Partly | lighthouse geolocation-on-start | Fallback not tested |
| 672 | Camera, microphone and device APIs | Missing | - | Camera/mic APIs not tested on the web |
| 673 | Drag and drop | Missing | - | Drag and drop not tested |
| 674 | Clipboard and file system APIs | Missing | - | Clipboard/file system APIs not tested |
| 675 | Browser extensions interaction | Missing | - | Extensions interaction not tested |
| 676 | Edge and serverless functions | Partly | API tests reach the endpoints | No emulator runs |
| 677 | GraphQL front-end data | Partly | app.calls sees GraphQL calls | Caching/error states not checked |
| 678 | Third-party embeds | Partly | perf:third-party-weight, CSP, axe iframe titles |  |
| 679 | Tag manager and analytics | Partly | privacy.consent-proof | Events not verified |
| 680 | Captcha and bot challenges | Missing | - | CAPTCHA/bot challenges not tested |
| 681 | Geo-blocking and VPN behaviour | Partly | region-speed regional proxies | Per-country content not compared |
| 682 | Deep links and URL fragments | Partly | func.anchors, deeplink-run (apps) | Web state-in-URL not checked |

### 20. AI and Chatbot Feature Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 683 | Chatbot answer accuracy | Covered | ai-eval |  |
| 684 | Hallucination testing | Covered | ai-eval (made-up answers) |  |
| 685 | Prompt-injection testing | Covered | ai-redteam (permission) |  |
| 686 | Jailbreak and misuse testing | Covered | ai-redteam |  |
| 687 | Data leakage | Covered | ai-redteam (system prompt, other users' data) |  |
| 688 | Bias and fairness | Covered | ai-eval (aieval:unfair) | Needs the tester's question set |
| 689 | Toxicity and content moderation | Covered | ai-redteam harmful-content prompts |  |
| 690 | Response quality and tone | Partly | ai-eval scoring | Tone not judged |
| 691 | Conversation memory and context | Missing | - | Multi-turn memory not tested |
| 692 | Fallback and handoff | Partly | ai-eval ("I don't know" when not covered) | Hand-off to a human not checked |
| 693 | Latency and cost of AI calls | Covered | ai-cost |  |
| 694 | Recommendation relevance | Missing | - | Recommendation relevance not tested |
| 695 | AI search quality | Missing | - | Semantic search quality not tested |
| 696 | Personalisation and privacy | Missing | - | Personalisation consent not tested |
| 697 | Regression evaluation sets | Covered | ai-eval regression |  |
| 698 | AI accessibility | Partly | axe and keyboard checks on the page | Chat widget not opened |

### 21. Mobile Web and Mobile App Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 699 | Mobile browser testing | Covered | mac-safari (iOS Simulator), appium, inapp-browser |  |
| 700 | Responsive and touch gestures | Covered | App journeys tap/type/swipe | Pinch/long-press limited |
| 701 | Device fragmentation | Covered | Test phones, phone farm, func.devices |  |
| 702 | App installation and update | Covered | appium install, upload compare; lib.app-update |  |
| 703 | App permissions | Covered | android.permissions, ios.permissions; lib.app-permissions |  |
| 704 | Permission purpose text (iOS) | Covered | ios:missing-purpose |  |
| 705 | Offline and poor network | Covered | device:offline; lib.app-offline |  |
| 706 | Interrupt testing | Covered | appium interruptions; lib.app-interrupt |  |
| 707 | Background and foreground | Covered | device:state-lost |  |
| 708 | Push notifications | Covered | push-send; lib.app-push |  |
| 709 | Deep links and universal links | Covered | deeplink-run, android.links, ios.links |  |
| 710 | Battery, memory and heat | Partly | app-perf memory; lib.app-battery | Heat and battery drain not measured |
| 711 | App performance | Covered | app-perf |  |
| 712 | Crash and ANR analysis | Covered | device:crash, device:anr |  |
| 713 | Debug build and signing | Covered | android.signing, ios.signing, android:debuggable |  |
| 714 | Plain HTTP and certificate checks | Covered | android:cleartext, ios ATS, runtime:no-pinning |  |
| 715 | Hard-coded keys and secrets | Covered | android.secrets, ios.secrets |  |
| 716 | Insecure data storage | Covered | runtime:plain-storage, mobsf |  |
| 717 | Jailbreak and root detection | Covered | runtime:no-root-detection | Android only at runtime |
| 718 | Reverse engineering resistance | Covered | android:not-shrunk, mobsf |  |
| 719 | Store policy compliance | Covered | android.store, ios.store, store-listing |  |
| 720 | App Transport Security (iOS) | Covered | ios.settings (ATS) |  |
| 721 | Privacy manifest (iOS) | Covered | ios.privacy-manifest |  |
| 722 | 64-bit and architecture support | Covered | android.native, ios.binary |  |
| 723 | WebView testing | Covered | android webview rules, ios webview rules |  |
| 724 | In-app purchases | Covered | iap |  |
| 725 | Accessibility on mobile | Covered | talkback, device:unlabeled, device:large-text |  |
| 726 | Localisation and orientation | Covered | android/ios languages, device:landscape |  |
| 727 | Beta distribution testing | Partly | ios.signing (Ad Hoc / TestFlight profile) | Play internal testing not checked |
| 728 | Automation frameworks | Covered | appium, maestro | Espresso/XCUITest/Detox suites not run |

### 22. Source Code and Pipeline Testing

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 729 | Linting | Partly | code.hygiene (broken JSON) | No ESLint/Stylelint/Pylint run |
| 730 | Static analysis | Covered | opengrep, code.risky, code.sast-languages |  |
| 731 | Code review | Covered | lib.code-review | Manual case |
| 732 | Code coverage | Covered | unit-tests coverage |  |
| 733 | Cyclomatic complexity | Covered | maint:complex-function |  |
| 734 | Code duplication | Covered | maint:duplicate-code |  |
| 735 | Technical debt measurement | Partly | code.maintainability | No debt cost figure |
| 736 | Dependency vulnerability scan | Covered | code.packages, osv-scanner, trivy |  |
| 737 | Licence scan | Covered | sbom |  |
| 738 | Secrets in code and history | Covered | gitleaks (with history) |  |
| 739 | Dead and unused code | Missing | Inspect shows unused web CSS/JS | Dead code in the repo not found |
| 740 | Broken files and missing tests | Covered | code:broken-json, code:no-tests |  |
| 741 | SQL injection patterns in code | Covered | code.risky, opengrep |  |
| 742 | Build reproducibility | Partly | deps:no-lockfile | Build not reproduced |
| 743 | Type checking | Missing | - | No tsc/mypy type check run |
| 744 | Formatting checks | Missing | - | No formatting check |
| 745 | Commit and branch policy checks | Missing | - | No commit/branch policy check |
| 746 | Pre-commit and pre-push hooks | Missing | - | No pre-commit hook check |
| 747 | Test pyramid health | Missing | - | No test-pyramid report |
| 748 | Flaky test detection | Partly | byo-playwright flaky tests | Only for uploaded Playwright suites |
| 749 | Build performance | Missing | - | Build time not measured |
| 750 | Supply-chain security | Covered | code.supply-chain |  |
| 751 | Infrastructure and config scanning | Covered | iac, trivy |  |
| 752 | Documentation checks | Covered | code:no-readme, api.spec; lib.code-readme |  |

### 23. Test Management, Process and Release Practices

| # | PDF row | Verdict | What covers it | Gap / note |
|---|---|---|---|---|
| 753 | Test strategy and plan | Not automatable | - | Planning document |
| 754 | Test case design and review | Not automatable | Own manual cases can be added | Writing/peer review is a human task |
| 755 | Requirements traceability matrix | Not automatable | Handbook: Test management & traceability | No requirement-to-test links in the tool |
| 756 | Entry and exit criteria | Covered | Master-control pass/fail gate |  |
| 757 | Defect life cycle | Covered | Issue board (open, fixed, re-test, closed, came back) |  |
| 758 | Defect severity and priority | Covered | Critical-to-Low severity on every issue |  |
| 759 | Bug reporting quality | Covered | Findings carry steps, evidence, screenshots and a fix |  |
| 760 | Root cause analysis | Not automatable | - | Team analysis (Claude triage helps) |
| 761 | Defect leakage and test metrics | Partly | Trends, pass rate | Defect leakage after release not tracked |
| 762 | Risk assessment | Covered | Risk-based ranking (Fix first) |  |
| 763 | Test environment management | Not automatable | Mark a project as a test copy | Environment upkeep is ops work |
| 764 | Test data management | Partly | Vault for saved logins; journey test data | No test-data sets manager |
| 765 | Test automation strategy | Not automatable | - | Strategy |
| 766 | Automation framework design | Not automatable | export-code writes Playwright specs | Framework design is a human task |
| 767 | Continuous testing | Covered | Schedules, CLI in CI |  |
| 768 | Shift-left testing | Covered | Code tests before release |  |
| 769 | Shift-right testing | Covered | Uptime watch, RUM |  |
| 770 | Testing in production | Covered | Read-only tests safe on live sites |  |
| 771 | Dogfooding | Not automatable | - | Team practice |
| 772 | Bug bash | Not automatable | Manual rounds can host it | Team event |
| 773 | Crowd testing | Not automatable | - | Outside testers |
| 774 | Pilot release | Not automatable | Handbook: Pilot testing | Release decision |
| 775 | Shadow testing / traffic mirroring | Partly | replay (HAR against the API) | No live traffic mirroring |
| 776 | Release and go-live checklist | Covered | Manual checklist rounds + master-control gate |  |
| 777 | Post-release monitoring | Covered | Uptime watch, RUM, scheduled tests |  |
| 778 | Retrospective | Not automatable | - | Team meeting |
| 779 | Exploratory test charters | Not automatable | - | Exploration planning |
| 780 | Accessibility and security in CI | Covered | CLI in CI with the gate (axe, ZAP, code checks) |  |
| 781 | Test documentation | Covered | Report exports, manual round Markdown/CSV |  |
| 782 | Test reporting and dashboards | Covered | Reports, Trends, Grafana |  |
| 783 | Sign-off and acceptance | Not automatable | Handbook: Acceptance testing (UAT) | Formal approval |
