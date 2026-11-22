import type { Finding, ProductType, ScanResult } from "./types.js";

/**
 * Every testing type of the Software Testing Handbook (Beginner to Advanced), mapped to what this
 * platform does for it: the agents and outside tools that test it, the platform feature that does it
 * (re-tests, regression tracking, journeys...), or why it needs a person. A report then shows, type by
 * type, which ones found problems, which passed, which were not run this time and which need a person.
 */

/** website: public sites and stores; app: signed-in web apps, SaaS and CRMs; mobile: Android and iOS apps. */
export type Module = "website" | "app" | "api" | "code" | "mobile";

export interface HandbookType {
  section: string;
  name: string;
  purpose: string;
  modules: Module[];
  /** Agents that test it. */
  agents?: string[];
  /** Outside tools (tool ids) that test it. */
  tools?: string[];
  /** Finding rules (exact, or a prefix ending in *) that count as this type failing. */
  rules?: string[];
  /** The platform does it as a feature rather than an agent (shown as covered when the module applies). */
  platform?: string;
  /** Why it needs a person, or something outside the tool. */
  manual?: string;
}

export type HandbookStatus = "fails" | "passes" | "platform" | "not-run" | "manual";

export interface HandbookRow extends HandbookType {
  status: HandbookStatus;
  /** Problems found for this type. */
  findings: number;
  problems: string[];
  /** Test cases the agents counted while checking it (0 when they do not count). */
  cases: number;
  /** Names of the agents and tools that ran it. */
  ranBy: string[];
}

export interface HandbookReport {
  rows: HandbookRow[];
  counts: Record<HandbookStatus, number>;
  /** All test cases counted in the run, and how many failed. */
  cases: number;
  casesFailed: number;
  /** Checks run (agents and tools that ran). */
  checks: number;
}

const WEB: Module[] = ["website", "app"];
const ALL: Module[] = ["website", "app", "api", "code", "mobile"];
const RUN: Module[] = ["website", "app", "api", "mobile"];

type Opts = Omit<HandbookType, "section" | "name" | "purpose" | "modules">;
let section = "";
const T: HandbookType[] = [];
const s = (name: string) => (section = name);
const t = (name: string, purpose: string, modules: Module[], o: Opts = {}) => T.push({ section, name, purpose, modules, ...o });

const ANDROID_STATIC = ["android.manifest", "android.permissions", "android.components", "android.signing", "android.secrets", "android.code", "android.sdks", "android.framework", "android.libraries", "android.size", "android.links", "android.servers", "android.languages", "android.store", "android.native", "android.firebase"];
const IOS_STATIC = ["ios.settings", "ios.permissions", "ios.privacy-manifest", "ios.binary", "ios.secrets", "ios.firebase", "ios.signing", "ios.code", "ios.sdks", "ios.framework", "ios.libraries", "ios.size", "ios.links", "ios.servers", "ios.languages", "ios.store"];
const A11Y = ["web.accessibility", "a11y.keyboard", "a11y.zoom", "a11y.text-spacing", "a11y.screen-reader", "a11y.motion"];
const FUNCTIONAL_WEB = ["web.links", "web.forms", "func.form-fields", "func.search", "func.navigation", "func.back-forward", "func.downloads", "web.content", "content.spelling"];

s("Fundamentals");
t("Manual testing", "A tester runs test cases by hand.", ALL, { manual: "A person follows the test cases; the platform's journeys and issue board record what they check and find." });
t("Automation testing", "Scripts and tools run repeatable checks.", ALL, { platform: "Every test here is automated: the agents and tools run on each test and each re-test." });
t("Black box testing", "Check behaviour from outside, without the code.", RUN, { agents: [...FUNCTIONAL_WEB, "api.availability", "api.negative"], tools: ["appium"] });
t("White box testing", "Check the code, its logic and paths.", ["code"], { agents: ["code.risky", "code.tests", "code.maintainability"] });
t("Grey box testing", "Test with part of the inside known (the API file, the login, the roles).", ["app", "api"], { agents: ["app.access", "app.calls", "api.contract", "api.access"] });
t("Static testing", "Review code and files without running them.", ["code", "mobile"], { agents: ["code.secrets", "code.risky", "code.hygiene", "code.database", "code.container", ...ANDROID_STATIC, ...IOS_STATIC], tools: ["opengrep", "gitleaks"] });
t("Dynamic testing", "Run the application and watch what it does.", RUN, { agents: ["web.js-errors", "func.monkey", "api.availability"], tools: ["appium"] });

s("Functional testing");
t("Unit testing", "Test one function or component on its own.", ["code"], { agents: ["code.tests"], rules: ["code:no-tests", "tests:*"], manual: "Unit tests are written by the developers; the code check reads them (focused, skipped, empty tests and coverage)." });
t("Integration testing", "Test the data flow between modules and services.", ["app", "api"], { agents: ["app.calls", "api.scenarios", "api.writes"] });
t("System testing", "Test the whole application against its requirements.", RUN, { platform: "A full test runs every agent for the product type on the whole site, app, API or phone app." });
t("End-to-end testing", "Test a whole business flow across the system.", ["website", "app", "mobile"], { platform: "User journeys (website and CRM) and App journeys (phones) run complete flows such as sign-up or checkout.", rules: ["journey:*", "device:journey-failed"] });
t("Acceptance testing (UAT)", "Confirm the work meets the client's acceptance criteria.", ALL, { manual: "The client signs off; the pass-or-fail gate in master control and the PDF report give them the evidence." });
t("Smoke testing", "Check the critical paths before more testing.", RUN, { agents: ["web.js-errors", "web.resources", "api.availability"], rules: ["page-load-failed", "page-error-status", "api:down"] });
t("Sanity testing", "Focused checks after a small change.", RUN, { platform: "Re-test only the pages of one issue, or run a preset with a few agents from master control." });
t("Regression testing", "Check changes did not break what worked.", ALL, { platform: "Every re-test is compared with the last one: issues that come back are marked as regressions on the issue board.", rules: ["visual:changed"] });
t("Retesting (confirmation)", "Re-run failed checks to confirm a fix.", ALL, { platform: "Mark an issue fixed and re-test: it closes only when the check passes again." });
t("Positive testing", "Valid input and normal use must work.", RUN, { agents: ["func.search", "app.tables", "api.availability", "api.contract", "func.form-fields"] });
t("Negative testing", "Invalid, missing or unexpected input must be handled safely.", RUN, { agents: ["func.form-fields", "api.negative", "api.errors", "func.not-found-page", "web.soft-404"], tools: ["schemathesis"] });
t("Exploratory testing", "Learn and test the app while exploring it.", ["website", "app", "mobile"], { agents: ["func.monkey"], tools: ["appium"], platform: "The app explorer opens every screen and menu it finds on signed-in apps and phones." });
t("Ad-hoc testing", "Informal checks without a script.", ["website", "app", "mobile"], { agents: ["func.monkey"], manual: "Random clicks and taps are automated; a person's own ad-hoc tests are logged as issues." });
t("Alpha testing", "Internal testing before release.", ALL, { manual: "Run on a test copy or staging address (mark the project as a test copy)." });
t("Beta testing", "Real users try a limited release.", ALL, { manual: "Real users take part; the speed snippet (real visitors) and crash reports show how it goes." });
t("Pilot testing", "Release to a small group first.", ALL, { manual: "A release decision; test the pilot address as its own project." });
t("Production testing", "Controlled, authorised checks on the live system.", RUN, { platform: "Website, CRM and API tests are read-only (GET only), so they are safe on the live system; anything heavier needs the client's permission." });

s("Non-functional testing");
t("Performance testing", "Speed, responsiveness and stability.", RUN, { agents: ["web.speed", "perf.images", "perf.network", "perf.slow-network", "rel.repeat", "api.availability"], tools: ["lighthouse", "k6"] });
t("Load testing", "Behaviour under the expected number of users.", ["website", "app", "api"], { tools: ["k6", "jmeter"], rules: ["load:*", "k6:*", "jmeter:*"], manual: "Needs the client's written permission (Permission page)." });
t("Stress testing", "Beyond normal capacity: failure and recovery.", ["website", "app", "api"], { tools: ["k6"], rules: ["load:*", "k6:*"], manual: "Needs the client's written permission; k6 stress mode." });
t("Spike testing", "A sudden jump in users.", ["website", "app", "api"], { tools: ["k6"], rules: ["load:*", "k6:*"], manual: "Needs the client's written permission; k6 spike mode." });
t("Endurance (soak) testing", "Stability under load for a long time.", ["website", "app", "api"], { tools: ["k6"], rules: ["load:*", "k6:*"], manual: "Needs the client's written permission; k6 soak mode (up to 120 minutes)." });
t("Volume testing", "Large amounts of data.", ["app", "api"], { agents: ["api.owasp", "app.tables"], rules: ["api:no-page-limit", "api:huge-*"] });
t("Scalability testing", "Can capacity grow with users and data.", ["website", "app", "api"], { tools: ["k6"], manual: "Load tests at rising user counts (with permission); compare runs on the Trends tab." });
t("Capacity testing", "The most load that still meets targets.", ["website", "app", "api"], { tools: ["k6"], manual: "k6 stress test with the client's permission finds the breaking point." });
t("Concurrency testing", "Simultaneous actions, race conditions.", ["website", "app", "api"], { agents: ["rel.repeat", "api.http"], rules: ["rel:slow-with-five", "api:concurrency"] });
t("Reliability testing", "Consistent operation over time.", ["website", "app", "api"], { agents: ["rel.repeat", "api.http"], platform: "Scheduled tests and the uptime watch repeat the checks every day.", rules: ["rel:*", "api:not-idempotent"] });
t("Recovery testing", "Restore after crashes and outages.", ["code", "mobile"], { agents: ["code.container"], tools: ["appium"], rules: ["compose:no-restart", "k8s:no-probes", "container:no-healthcheck", "device:state-lost"], manual: "Restoring a real server after an outage is done by the operations team." });
t("Usability testing", "Easy to learn and efficient to use.", ["website", "app", "mobile"], { agents: ["ui.readability", "ui.cover", "func.navigation", "web.mobile"], manual: "Real users' opinions need a usability session; the agents catch the measurable problems." });
t("Accessibility testing", "Usable by people with disabilities.", ["website", "app", "mobile"], { agents: A11Y, tools: ["mac-voiceover", "appium"], rules: ["axe:*", "a11y:*"] });
t("Compatibility testing", "Browsers, devices, systems.", ["website", "app", "mobile"], { agents: ["func.browsers", "func.devices", "web.tablet", "web.mobile"], tools: ["mac-safari", "appium"] });
t("Portability testing", "How easily it moves to another platform.", ["code"], { agents: ["code.container"], rules: ["container:unpinned-image"] });
t("Maintainability testing", "How easily the code can be changed and tested.", ["code"], { agents: ["code.maintainability", "code.hygiene", "code.tests"], rules: ["maint:*"] });
t("Interoperability testing", "Exchanging data correctly with other systems.", ["api"], { agents: ["api.contract", "api.http"], tools: ["newman"], platform: "SOAP, gRPC, WebSocket and Pact contract tests (API module)." });
t("Operational testing", "Monitoring, support and deployment readiness.", ["code", "website", "app"], { agents: ["code.container", "code.tests"], platform: "Uptime watch and Grafana dashboards.", rules: ["container:no-healthcheck", "k8s:*", "compose:*", "tests:no-ci"] });

s("Test design techniques");
t("Boundary value analysis", "Values at, just inside and just outside the limits.", ["website", "app", "api"], { agents: ["func.form-fields", "api.negative"], rules: ["form:boundary-refused", "form:below-min-accepted", "form:above-max-accepted", "form:impossible-limits", "api:invalid-input-accepted"] });
t("Equivalence partitioning", "One value from each group of inputs.", ["website", "app", "api"], { agents: ["func.form-fields", "api.negative"], rules: ["form:email-*", "form:phone-*", "form:pincode-letters", "form:url-accepts-anything"] });
t("Decision table testing", "Combinations of business rules.", ["app", "api"], { agents: ["app.access", "api.access"], manual: "Business rules come from the client; write them as journeys or API scenarios." });
t("State transition testing", "Valid and invalid moves between states.", ["website", "app", "mobile"], { agents: ["app.session", "app.two-step", "func.back-forward"], tools: ["appium"] });
t("Use case testing", "Tests from user goals.", ["website", "app", "mobile", "api"], { platform: "User journeys, App journeys and API scenarios are written from the use cases." });
t("Error guessing", "Experience-based likely failures.", RUN, { agents: ["web.content", "content.spelling", "web.exposed-files", "func.not-found-page", "api.errors"] });
t("Pairwise testing", "Every pair of parameter values once.", ["website", "api"], { manual: "Not automatic yet: list the combinations as journeys or API scenarios." });
t("Combinatorial testing", "Selected combinations of many inputs.", ["website", "api"], { tools: ["schemathesis"], manual: "Schemathesis combines API parameters; for forms, list the combinations as journeys." });
t("Cause-effect graphing", "Map input conditions to outputs.", ALL, { manual: "A design technique for writing test cases; record the cases as journeys or scenarios." });
t("Checklist-based testing", "A prepared checklist for consistent coverage.", ALL, { platform: "Each agent is a checklist that runs the same way on every test, and the WCAG tab is the accessibility checklist." });
t("Risk-based testing", "Test what is most likely and most costly first.", ALL, { platform: "Issues are ranked Critical to Low, and the report's \"Fix first\" list puts the riskiest first." });
t("Model-based testing", "Tests from a model of the system.", ["api"], { tools: ["schemathesis"], agents: ["api.contract", "api.negative"], platform: "The API file is the model: calls and checks come from it." });
t("Decision coverage", "Each true/false outcome is run.", ["code"], { agents: ["code.tests"], rules: ["tests:low-branch-coverage"] });
t("Statement coverage", "Which lines the tests run.", ["code"], { agents: ["code.tests"], rules: ["tests:low-coverage"] });
t("Branch coverage", "Each branch is run.", ["code"], { agents: ["code.tests"], rules: ["tests:low-branch-coverage"] });
t("Mutation testing", "Change the code slightly and see if the tests notice.", ["code"], { tools: ["mutation"], rules: ["mutation:*"], manual: "Started by hand in the Mutation testing tab: it runs the project's own tests (npm test or pytest) once per change, on a scratch copy." });
t("Fuzz testing", "Malformed or random input to find crashes.", ["website", "app", "api", "mobile"], { agents: ["func.monkey", "api.negative"], tools: ["schemathesis", "appium"] });
t("Property-based testing", "Many generated inputs checked against general rules.", ["api"], { tools: ["schemathesis"] });

s("Web application testing");
t("UI testing", "Visible elements, controls and layout.", WEB, { agents: ["ui.overlap", "ui.cut-text", "ui.cover", "web.mobile", "web.tablet"] });
t("UX testing", "Workflows are intuitive and efficient.", WEB, { agents: ["func.navigation", "ui.cover", "ui.consent-gate", "func.not-found-page", "ui.readability"], manual: "How it feels to real users needs a usability session." });
t("Cross-browser testing", "Browsers and versions.", WEB, { agents: ["func.browsers"], tools: ["mac-safari", "browser-matrix"], rules: ["matrix:*"] });
t("Responsive testing", "Screen sizes and orientations.", WEB, { agents: ["web.mobile", "web.tablet", "func.devices", "ui.overlap-phone", "a11y.zoom"] });
t("Navigation testing", "Menus, links, breadcrumbs, page changes.", WEB, { agents: ["func.navigation", "web.links", "func.anchors", "seo.link-graph"] });
t("Cookie testing", "Creation, expiry, consent and security flags.", WEB, { agents: ["web.cookies", "web.security-headers", "web.privacy"], rules: ["cookie:*", "privacy:*"] });
t("Cache testing", "Caching, freshness and invalidation.", WEB, { agents: ["web.cache", "perf.network", "app.private-cache"], rules: ["cache:*", "perf:no-cache"] });
t("Session testing", "Session start, expiry, renewal and logout.", ["app"], { agents: ["app.session", "app.tokens", "app.two-step"] });
t("Form validation testing", "Required fields, formats, limits and messages.", WEB, { agents: ["func.form-fields", "web.forms"], rules: ["form:*"] });
t("File upload testing", "Type, size, content and safety of uploads.", ["app"], { agents: ["app.file-upload"], manual: "Changes data: runs on a test copy or with the client's permission." });
t("File download testing", "Downloaded content, name, format and integrity.", WEB, { agents: ["func.downloads"], rules: ["download:*"] });
t("Broken link testing", "Links that lead to errors.", WEB, { agents: ["web.links", "func.anchors", "web.resources"] });
t("Browser back/forward testing", "History and state when going back and forward.", WEB, { agents: ["func.back-forward"], rules: ["nav:back-forward-broken", "perf:bfcache-blocked"] });
t("Localization testing", "Translations, local formats, regional behaviour.", WEB, { agents: ["l10n.language", "l10n.formats", "l10n.locale"] });
t("Globalization testing", "Design supports many locales.", WEB, { agents: ["l10n.locale", "l10n.language"], rules: ["l10n:*", "seo:hreflang-*"] });
t("Visual testing", "Unintended visual differences.", WEB, { platform: "Visual compare: approve a picture once, later tests show the differences.", rules: ["visual:changed"], agents: ["ui.overlap", "ui.cut-text"] });
t("Content testing", "Accuracy, spelling, formatting and completeness.", WEB, { agents: ["web.content", "content.spelling", "seo.thin-content"] });

s("Mobile application testing");
t("Native app testing", "Apps built for Android or iOS.", ["mobile"], { agents: [...ANDROID_STATIC, ...IOS_STATIC], tools: ["appium", "mac-ios-sim"] });
t("Hybrid app testing", "Native apps that show web content.", ["mobile"], { agents: ["android.framework", "ios.framework", "android.code"], tools: ["appium"] });
t("Mobile web testing", "Websites in phone browsers.", WEB, { agents: ["web.mobile", "func.devices", "perf.slow-network", "ui.cover"], tools: ["mac-safari"] });
t("Installation testing", "Install, first launch, uninstall, reinstall.", ["mobile"], { tools: ["appium"], agents: ["android.store", "ios.store", "android.signing"], rules: ["device:crash"] });
t("Device compatibility testing", "Device models and hardware.", ["mobile"], { tools: ["appium"], agents: ["android.native"], platform: "Test phones in the Owner panel: each emulator or phone is a device to run on." });
t("OS compatibility testing", "Supported Android and iOS versions.", ["mobile"], { agents: ["android.manifest", "ios.store"], tools: ["appium"] });
t("Interruption testing", "Calls, messages, notifications, alarms.", ["mobile"], { tools: ["appium"], rules: ["device:state-lost"] });
t("Network testing", "Wi-Fi, mobile data, weak and no connection.", ["mobile", "website", "app"], { tools: ["appium"], agents: ["perf.slow-network", "func.app-install"], rules: ["device:offline-*", "perf:slow-phone-network", "app:offline-broken"] });
t("Real device (phone farm) testing", "Real Android phones and iPhones, used remotely.", ["mobile"], { tools: ["appium"], platform: "Owner > Test phones > Phone farm: GLV's own rack (DeviceFarmer for Android, go-ios for iPhones), no BrowserStack account." });
t("Battery testing", "Battery use and low-battery behaviour.", ["mobile"], { tools: ["appium"], manual: "The phone test runs the app at 4% battery; measuring battery drain needs a real phone over time." });
t("Background/foreground testing", "State kept when the app goes to the background.", ["mobile"], { tools: ["appium"], rules: ["device:state-lost"] });
t("Screen rotation testing", "Portrait and landscape.", ["mobile"], { tools: ["appium"], rules: ["device:crash", "device:landscape-*"] });
t("Push notification testing", "Delivery, display, deep links and actions.", ["mobile"], { agents: ["ios.signing", "android.links", "ios.links"], manual: "Sending a real push needs the app's push keys; the checks cover push setup and deep links." });
t("Gesture testing", "Tap, swipe, pinch and long press.", ["mobile"], { tools: ["appium"], platform: "App journeys tap, type, swipe and go back." });
t("Permission testing", "Grant, deny and revoke camera, location, microphone.", ["mobile"], { agents: ["android.permissions", "ios.permissions"], tools: ["appium"] });
t("Upgrade testing", "Updates keep data and settings.", ["mobile"], { platform: "Each upload is compared with the last one (\"what changed\"); installing over the old version on a test phone needs both builds.", manual: "Install the old build, then the new one, on a test phone." });
t("Mobile accessibility testing", "Screen readers, text size, touch targets.", ["mobile"], { tools: ["appium", "mac-ios-sim"], rules: ["device:unlabeled", "device:small-target", "device:low-contrast", "device:large-text-*", "ios-a11y:*"] });

s("API testing");
t("Functional API testing", "Endpoint logic and expected answers.", ["api"], { agents: ["api.availability", "api.contract", "api.scenarios"] });
t("REST API testing", "Methods, headers and payloads.", ["api"], { agents: ["api.availability", "api.http", "api.transport"], tools: ["schemathesis", "newman"] });
t("SOAP API testing", "SOAP messages, services and contracts.", ["api"], { platform: "SOAP projects in the API module read the WSDL and call each operation." });
t("GraphQL testing", "Queries, schema and errors.", ["api"], { platform: "GraphQL projects in the API module read the schema and run the queries (mutations only on a test server)." });
t("Positive API testing", "Valid requests succeed.", ["api"], { agents: ["api.availability", "api.contract"] });
t("Negative API testing", "Invalid requests get controlled errors.", ["api"], { agents: ["api.negative", "api.errors"], rules: ["api:negative-*", "api:invalid-input-accepted", "api:bad-input-crash", "api:error-leak"] });
t("API integration testing", "APIs and the services they depend on.", ["api"], { agents: ["api.scenarios", "api.writes"] });
t("Contract testing", "Provider and consumer follow the agreed interface.", ["api"], { agents: ["api.contract", "api.changes"], platform: "Pact files can be checked in the API module." });
t("Schema validation testing", "Answer structure, types and required fields.", ["api"], { agents: ["api.contract"], tools: ["schemathesis"] });
t("Authentication testing (API)", "Tokens, keys and credentials.", ["api"], { agents: ["api.auth", "api.tokens", "api.negative"], rules: ["api:invalid-token-accepted", "api:no-auth*", "api:token-*"] });
t("Authorization testing (API)", "Each identity sees only what it may.", ["api"], { agents: ["api.access"] });
t("API security testing", "Access, input, data exposure.", ["api"], { agents: ["api.owasp", "api.exposure", "api.auth", "api.transport"], tools: ["zap", "nuclei"] });
t("API performance testing", "Latency, throughput, load.", ["api"], { agents: ["api.availability", "api.http"], tools: ["k6"] });
t("Rate limit testing", "Quotas, throttling, retry.", ["api"], { agents: ["api.owasp"], rules: ["api:no-rate-limit"] });
t("API version testing", "Behaviour across versions.", ["api"], { agents: ["api.versions", "api.changes"] });
t("Idempotency testing", "Repeated requests do not duplicate effects.", ["api", "code"], { agents: ["api.http", "api.writes", "code.resilience"], rules: ["api:not-idempotent", "res:payment-no-idempotency"] });
t("Webhook testing", "Delivery, retries, signatures and callbacks.", ["code", "app"], { agents: ["code.resilience"], rules: ["res:webhook-unsigned"], platform: "The test inbox receives webhooks during journeys." });
t("Error handling testing", "Status codes, error formats, safe failure.", ["api"], { agents: ["api.errors", "api.negative"], rules: ["api:inconsistent-errors"] });

s("Automation testing");
t("UI automation testing", "Automated user actions and checks.", WEB, { platform: "User journeys, and your own Playwright tests (Bring your own tests)." , tools: ["byo-playwright"] });
t("Web automation testing", "Automated browser flows.", WEB, { platform: "Every website and CRM test is browser automation (Playwright)." });
t("Mobile automation testing", "Automated app flows.", ["mobile"], { tools: ["appium"] });
t("API automation testing", "Automated API requests and checks.", ["api"], { agents: ["api.scenarios"], tools: ["newman", "schemathesis"] });
t("Regression automation", "Repeatable checks of what worked.", ALL, { platform: "Schedules and re-tests; issues that come back are marked as regressions." });
t("Data-driven testing", "One test with many data sets.", ["api", "website"], { agents: ["api.scenarios", "func.form-fields"], platform: "API scenarios reuse values from earlier answers." });
t("Keyword-driven testing", "Tests from reusable action words.", ["website", "app", "mobile"], { platform: "Journeys are written in action words (open, click, type, see; tap, swipe, rotate)." });
t("Hybrid framework testing", "Data- and keyword-driven together.", ALL, { platform: "Journeys (keywords) with saved logins and test data (data)." });
t("BDD", "Behaviour in business-readable scenarios.", ["website", "app", "api"], { platform: "Journeys and API scenarios are written in plain words a client can read." });
t("Cross-browser automation", "Automated tests in many browsers.", WEB, { agents: ["func.browsers"], tools: ["mac-safari", "browser-matrix"] });
t("Self-healing tests", "Steps keep working when a button's words or id change a little.", WEB, { platform: "Journey steps find the closest match by text, label, id and test id, and the report says what was used.", rules: ["journey:healed"] });
t("Plain-English test writing", "Write a test as a sentence, get runnable steps.", WEB, { platform: "Journeys > Write it in plain English: Claude (with an API key) or GLV's own rules turn it into steps." });
t("Record-and-replay API testing", "Recorded real traffic replayed on every release.", ["api", "app"], { tools: ["replay"], rules: ["replay:*"], manual: "Upload a HAR recording in the Record and replay tab." });
t("Visual regression testing", "Compare screenshots to spot changes.", WEB, { platform: "Visual compare against the approved pictures.", rules: ["visual:changed"] });
t("Parallel testing", "Run tests at the same time to save time.", RUN, { platform: "Pages at once (up to 8 browsers) and projects at once." });
t("Continuous testing", "Tests run throughout delivery.", ALL, { platform: "Schedules, the uptime watch, and the CLI for CI pipelines.", agents: ["code.tests"], rules: ["tests:no-ci", "tests:ci-skips-tests"] });

s("Performance testing (advanced)");
t("Baseline testing", "A reference measurement for later comparison.", RUN, { platform: "The first test is the baseline; the Trends tab compares every later test." });
t("Benchmark testing", "Compare with targets or other set-ups.", ["website", "app"], { tools: ["lighthouse"], agents: ["web.speed"], platform: "Pass-or-fail gate thresholds in master control." });
t("Latency testing", "Delay between request and answer.", ["website", "app", "api"], { agents: ["web.speed", "api.availability", "rel.repeat"] });
t("Throughput testing", "Work done per unit of time.", ["website", "app", "api"], { tools: ["k6", "jmeter"], manual: "Needs the client's permission (load test)." });
t("Resource utilization testing", "CPU, memory, disk and network use.", ["mobile", "code"], { tools: ["appium"], agents: ["code.container"], rules: ["device:memory", "device:jank", "k8s:no-limits"], manual: "Server CPU and memory show in Grafana during a load test." });
t("Frontend performance testing", "Page loading, rendering, responsiveness.", WEB, { agents: ["web.speed", "perf.images", "perf.network", "perf.slow-network"], tools: ["lighthouse"] });
t("Database performance testing", "Query speed, indexes, concurrency.", ["code"], { agents: ["code.database"], rules: ["db:select-star"], manual: "Query timings need access to the database server." });
t("Network performance testing", "Bandwidth, latency, packet loss.", WEB, { agents: ["perf.slow-network", "perf.network"] });

s("Security testing (advanced)");
t("Vulnerability assessment", "Find and rank known weaknesses.", ALL, { agents: ["sec.js-libraries", "code.packages", "web.exposed-files"], tools: ["nuclei", "zap", "trivy", "osv-scanner"] });
t("Penetration testing", "Authorised simulated attacks.", ["website", "app", "api"], { tools: ["glv-attack", "zap-active", "glv-probes"], manual: "Needs the client's written permission (Permission page)." });
t("Command injection testing", "Shell commands run through input.", ["website", "app"], { tools: ["glv-attack", "zap-active"], agents: ["code.risky"], rules: ["attack:command-injection"], manual: "Confirmed by timing a harmless sleep; needs the client's written permission (Permission page)." });
t("Template injection testing (SSTI)", "Input evaluated as a template.", ["website", "app"], { tools: ["glv-attack"], rules: ["attack:template-injection"], manual: "Needs the client's written permission (Permission page)." });
t("SSRF testing", "Server made to fetch internal addresses.", ["website", "app", "api"], { tools: ["glv-attack"], agents: ["api.owasp"], rules: ["attack:ssrf"], manual: "Needs the client's written permission (Permission page)." });
t("NoSQL injection testing", "Query operators injected into NoSQL queries.", ["website", "app", "api"], { tools: ["glv-attack"], rules: ["attack:nosql-injection"], manual: "Needs the client's written permission (Permission page)." });
t("CORS testing", "Cross-origin reads of signed-in data.", ["website", "app", "api"], { tools: ["glv-attack"], agents: ["api.owasp"], rules: ["attack:cors-misconfiguration"], manual: "Needs the client's written permission (Permission page)." });
t("Blind (out-of-band) testing", "Holes that only show as a call back to GLV's server.", ["website", "app", "api"], { tools: ["glv-attack"], rules: ["attack:blind-*", "attack:log4shell"], manual: "Needs the client's written permission and OOB_BASE_URL (GLV's public address) or an Interactsh server." });
t("Hacked site and malware testing", "Injected spam links, skimmers, miners, cloaking, web shells.", ["website", "app"], { agents: ["sec.hacked", "sec.cloaking"], tools: ["malware"], rules: ["hack:*", "yara:*", "clamav:*", "server:webshell"] });
t("Email and DNS security testing", "SPF, DKIM, DMARC, MTA-STS, DNSSEC, CAA.", ["website", "app"], { agents: ["sec.email-dns"], rules: ["dns:*"] });
t("Subdomain takeover testing", "Subdomains pointing at services nobody owns.", ["website", "app", "api"], { tools: ["surface"], rules: ["surface:subdomain-takeover", "surface:dangling-cname"] });
t("Attack surface discovery", "Every public host, staging site and open port of the client.", ["website", "app", "api"], { tools: ["surface", "ports"], rules: ["surface:*", "ports:*"], manual: "The port check needs the client's written attack permission." });
t("Mobile dynamic security testing", "The running app: logs, storage, pinning, root checks.", ["mobile"], { tools: ["mobsf", "mobile-runtime"], rules: ["runtime:*", "mobsf:*"], manual: "Runs on a test phone (Owner > Test phones, or the phone farm)." });
t("Insecure deserialization testing", "Objects rebuilt from untrusted input.", ["website", "app"], { tools: ["glv-attack"], rules: ["attack:deserialization-surface"], manual: "Flagged as a surface to review by hand; needs the client's written permission (Permission page)." });
t("SAST", "Analyse code without running it.", ["code", "mobile"], { agents: ["code.risky", "code.secrets", "android.code", "ios.code"], tools: ["opengrep"] });
t("DAST", "Test the running app from outside.", ["website", "app", "api"], { tools: ["zap", "nuclei"], agents: ["web.security-headers", "sec.info-leak", "api.owasp"] });
t("IAST", "Watch the app from inside while it runs.", ["code"], { manual: "Needs an agent installed inside the client's app server." });
t("RASP", "Protection inside the running app.", ["code"], { manual: "A product the client installs; not something a test can do from outside." });
t("SQL injection testing", "Input that changes database queries.", ["website", "app", "api", "code"], { agents: ["code.risky", "api.negative"], tools: ["glv-probes", "zap-active"], rules: ["code:sql-injection", "probe:sqli*", "api:negative-leak"] });
t("XSS testing", "Input that runs script in browsers.", ["website", "app", "code"], { agents: ["code.risky", "web.security-headers", "sec.csp-strength"], tools: ["glv-probes", "zap-active"], rules: ["code:xss", "probe:xss*"] });
t("CSRF testing", "Protection against cross-site requests.", ["app"], { agents: ["app.csrf"] });
t("Authentication testing", "Secure sign-in and credentials.", ["app", "website"], { agents: ["sec.auth-forms", "app.user-enum", "app.two-step", "app.lockout", "app.forgot-password", "app.login-redirect"] });
t("Authorization testing", "Access limits and object permissions.", ["app"], { agents: ["app.access", "app.private-pages", "app.exposed"], tools: ["glv-attack"], rules: ["attack:idor"] });
t("Session management testing", "Session ids, expiry, rotation, logout.", ["app"], { agents: ["app.session", "app.tokens"] });
t("Encryption testing", "Data protected in transit and at rest.", ["website", "app", "api", "code"], { agents: ["web.https", "web.mixed-content", "api.transport", "code.database"], tools: ["testssl"], rules: ["db:password-column-short", "db:sensitive-column"] });
t("Cookie security testing", "Secure, HttpOnly and SameSite.", WEB, { agents: ["web.security-headers", "web.cookies"] });
t("API security (OWASP API Top 10)", "Auth, access, input and data exposure of APIs.", ["api"], { agents: ["api.owasp", "api.audit"] });
t("OWASP Top 10 assessment", "The common web risk categories.", ["website", "app"], { agents: ["web.security-headers", "sec.info-leak", "sec.js-libraries", "app.access", "app.csrf"], tools: ["zap", "nuclei"] });
t("Dependency security testing", "Vulnerable third-party packages.", ["code", "website", "mobile"], { agents: ["code.packages", "sec.js-libraries", "android.libraries", "ios.libraries"], tools: ["osv-scanner", "trivy"] });
t("Container security testing", "Images, runtime settings, configuration.", ["code"], { agents: ["code.container"], tools: ["trivy"], rules: ["container:*", "compose:*", "k8s:*"] });
t("Secrets scanning", "Exposed passwords, tokens and keys.", ["code", "mobile", "website"], { agents: ["code.secrets", "android.secrets", "ios.secrets", "sec.info-leak"], tools: ["gitleaks"] });

s("Database testing");
t("Structural database testing", "Schemas, tables, constraints, indexes.", ["code"], { agents: ["code.database"], rules: ["db:no-primary-key", "db:no-foreign-key"] });
t("Functional database testing", "Database operations and stored rules.", ["api", "app"], { agents: ["api.writes"], manual: "Needs a test copy of the database." });
t("Data integrity testing", "Stored data is accurate and consistent.", ["api", "code"], { agents: ["api.writes", "code.database"], rules: ["db:float-money", "db:no-foreign-key"] });
t("Data validation testing", "Values, formats, ranges, mandatory fields.", ["website", "app", "api"], { agents: ["func.form-fields", "api.negative"] });
t("CRUD testing", "Create, read, update, delete.", ["api", "app"], { agents: ["api.writes", "app.form-fill"], manual: "Changes data: test server or test copy only." });
t("Referential integrity testing", "Relationships and foreign keys.", ["code"], { agents: ["code.database"], rules: ["db:no-foreign-key"] });
t("Stored procedure testing", "Procedures, parameters and outputs.", ["code"], { manual: "Needs a connection to the database." });
t("Trigger testing", "Triggers and their side effects.", ["code"], { manual: "Needs a connection to the database." });
t("Migration testing", "Data and schema moved between systems.", ["code"], { agents: ["code.database"], rules: ["db:destructive-migration", "db:no-down-migration"] });
t("ETL testing", "Extract, transform, load.", ["code"], { manual: "Needs the client's data pipeline and sample data." });
t("Data warehouse testing", "Dimensions, facts and totals.", ["code"], { manual: "Needs access to the warehouse." });
t("Database security testing", "Permissions, encryption, sensitive data.", ["code"], { agents: ["code.database", "code.container", "code.secrets"], rules: ["db:*", "compose:database-published", "code:db-dump"] });
t("Backup & restore testing", "Backups complete and restorable.", ["code"], { manual: "Restore a backup to a test server and run the tests on it." });
t("Data reconciliation testing", "Records and totals match across systems.", ["api"], { manual: "Write API scenarios that compare totals from both systems." });

s("Accessibility testing");
t("Keyboard accessibility", "Everything works without a mouse.", WEB, { agents: ["a11y.keyboard"] });
t("Screen reader testing", "Labels, roles, names and reading order.", ["website", "app", "mobile"], { agents: ["a11y.screen-reader", "web.accessibility"], tools: ["mac-voiceover"] });
t("Colour contrast testing", "Text and controls have enough contrast.", ["website", "app", "mobile"], { agents: ["web.accessibility"], tools: ["appium"], rules: ["axe:color-contrast", "device:low-contrast", "device:dark-mode-low-contrast"] });
t("Alt text testing", "Meaningful text for informative images.", WEB, { agents: ["web.accessibility", "web.seo"], rules: ["axe:image-alt", "seo:img-alt"] });
t("Focus testing", "Visible focus and logical order.", WEB, { agents: ["a11y.keyboard"], rules: ["a11y:focus-*", "a11y:positive-tabindex"] });
t("Form accessibility", "Labels, instructions, errors.", WEB, { agents: ["web.accessibility", "func.form-fields"], rules: ["axe:label", "form:required-not-marked"] });
t("Caption testing", "Captions for video and audio.", WEB, { agents: ["web.accessibility", "a11y.motion"], rules: ["axe:video-caption"], manual: "Whether captions are correct needs a person." });
t("Zoom/reflow testing", "Usable at 200-400% zoom and narrow widths.", WEB, { agents: ["a11y.zoom", "a11y.text-spacing"] });
t("Semantic HTML testing", "Meaningful structure.", WEB, { agents: ["a11y.screen-reader", "web.accessibility"], tools: ["vnu"] });
t("WCAG conformance testing", "WCAG 2.2 A and AA criteria.", WEB, { platform: "The WCAG tab lists every A and AA criterion with its result.", agents: A11Y });

s("SEO testing");
t("On-page SEO testing", "Titles, descriptions, headings, content.", ["website"], { agents: ["web.seo", "seo.audit"] });
t("Technical SEO testing", "Crawlability, indexability, structure.", ["website"], { agents: ["web.crawlability", "seo.redirect-chain", "seo.rendered-html", "web.soft-404"] });
t("Title tag testing", "Good page titles.", ["website"], { agents: ["web.seo", "web.duplicates"], rules: ["seo:title-*", "duplicate-title"] });
t("Meta description testing", "Useful search descriptions.", ["website"], { agents: ["web.seo", "web.duplicates"], rules: ["seo:description-*", "seo:meta-*", "duplicate-description"] });
t("Heading tag testing", "Heading order.", ["website"], { agents: ["web.seo", "a11y.screen-reader"], rules: ["seo:h1-*", "a11y:heading-skip"] });
t("URL testing", "Readable, stable, canonical addresses.", ["website"], { agents: ["seo.urls"] });
t("Sitemap testing", "XML sitemap present with valid addresses.", ["website"], { agents: ["web.crawlability", "seo.orphans"] });
t("Robots.txt testing", "Crawler rules do not block content.", ["website"], { agents: ["web.crawlability"] });
t("Canonical tag testing", "Preferred addresses for duplicates.", ["website"], { agents: ["web.seo"], rules: ["seo:canonical-*"] });
t("Broken link testing (SEO)", "Invalid internal and external links.", ["website"], { agents: ["web.links"] });
t("Indexability testing", "Important pages can be indexed.", ["website"], { agents: ["web.crawlability", "web.seo", "seo.rendered-html"], rules: ["seo:noindex*"] });
t("Structured data testing", "Schema markup for rich results.", ["website"], { agents: ["web.structured-data"] });
t("Mobile SEO testing", "Mobile usability for search.", ["website"], { agents: ["web.mobile", "web.seo"], rules: ["mobile-*", "seo:viewport*"] });
t("Core Web Vitals testing", "Loading, interactivity and stability.", ["website"], { agents: ["web.speed"], tools: ["lighthouse"], platform: "Real visitors' numbers with the speed snippet." });

s("Advanced and specialised testing");
t("Configuration testing", "Supported settings and deployments.", ["code", "website"], { agents: ["code.container", "web.security-headers"] });
t("Failover testing", "Backups take over when the main part fails.", ["code"], { agents: ["code.container"], rules: ["k8s:single-replica"], manual: "Switching off a real server needs the client's operations team." });
t("Disaster recovery testing", "Recovery plans after major disruption.", ["code"], { manual: "A drill by the client's operations team." });
t("Business continuity testing", "Critical services continue during disruption.", ["code"], { manual: "A drill by the client's operations team." });
t("Chaos testing", "Controlled faults to test resilience.", ["mobile", "code"], { tools: ["appium"], manual: "Faults on phones (offline, interruptions) are automatic; server faults need the client's permission and set-up." });
t("Fault tolerance testing", "Keeps working when parts fail.", ["code", "mobile"], { agents: ["code.resilience"], tools: ["appium"], rules: ["res:no-timeout", "res:empty-catch", "device:offline-*"] });
t("Resilience testing", "Withstand and recover from disruption.", ["code", "website", "app"], { agents: ["code.resilience", "rel.repeat", "perf.slow-network"] });
t("Backup testing", "Backups made, kept and restorable.", ["code"], { manual: "Restore a backup to a test server and test it." });
t("Data migration testing", "Moved data is complete and correct.", ["code"], { agents: ["code.database"], rules: ["db:destructive-migration"] });
t("Compliance testing", "Legal and industry requirements.", ALL, { agents: ["web.privacy", "web.cookies", "store.policies", "saas.trust", "app.id-numbers", "code.database", "ios.privacy-manifest"], platform: "WCAG tab for accessibility law." });
t("Time zone testing", "Dates and times across regions.", ["website", "app", "code"], { agents: ["l10n.locale", "l10n.formats", "code.resilience"], rules: ["l10n:*", "res:naive-datetime"] });
t("Currency testing", "Currency formats, rounding, conversion.", ["website", "code"], { agents: ["l10n.formats", "code.database", "code.resilience"], rules: ["l10n:mixed-currency", "db:float-money", "res:float-money"] });
t("Payment gateway testing", "Authorisation, capture, refunds, failures.", ["website", "code"], { agents: ["store.checkout", "code.resilience"], manual: "Real payments need the gateway's test mode and a test copy." });
t("Transaction testing", "Correct, atomic, no duplicates.", ["code", "api"], { agents: ["code.resilience", "api.writes"], rules: ["res:payment-no-idempotency"] });
t("Subscription testing", "Renewals, cancellation, proration.", ["website"], { agents: ["saas.trust"], manual: "Billing cycles need the billing system's test clock." });
t("A/B testing", "Compare variants with outcome measures.", ["website"], { manual: "An experiment run by the marketing team; test each variant's address as its own project." });
t("Canary release testing", "A small share of traffic first.", ["website", "app", "api"], { manual: "Test the canary address as its own project, and compare runs." });
t("Blue-green deployment testing", "Switch between two live environments.", ["website", "app", "api"], { manual: "Test the idle environment's address before switching." });
t("Microservices testing", "Services alone and together.", ["api"], { agents: ["api.contract", "api.scenarios"], platform: "One API project per service; Pact contracts between them." });
t("Distributed system testing", "Behaviour across networked parts and failures.", ["api"], { agents: ["api.http"], manual: "Network faults between services need the client's set-up." });
t("Event-driven testing", "Event publishing, consumption, order, retries.", ["api"], { platform: "WebSocket tests in the API module.", manual: "Queues need access to the broker." });
t("Message queue testing", "Delivery, acknowledgement, dead letters.", ["code"], { manual: "Needs access to the queue (RabbitMQ, Kafka, SQS)." });
t("Snapshot testing", "Output compared with an approved copy.", WEB, { platform: "Visual compare and the API's approved copy (Changes tab).", rules: ["visual:changed", "api:breaking-*"] });
t("Cross-platform testing", "Same behaviour on every platform.", ["website", "mobile"], { agents: ["func.browsers", "func.devices"], tools: ["mac-safari", "appium"] });

s("AI and machine learning testing");
t("Model accuracy testing", "Prediction quality against labelled data.", ["code"], { agents: ["code.ai"], rules: ["ai:no-evals"], manual: "Needs labelled examples from the client." });
t("Model performance testing", "Inference latency, throughput, resources.", ["api"], { agents: ["api.availability"], rules: ["ai:no-output-limit"] });
t("Data quality testing", "Complete, valid, representative input data.", ["code"], { manual: "Needs the training or input data." });
t("Bias testing", "Unfair or systematically different outcomes.", ["code"], { manual: "Needs a test set with the relevant groups." });
t("Robustness testing", "Noisy, incomplete or odd input.", ["api"], { agents: ["api.negative"] });
t("Adversarial testing", "Deliberately manipulated input.", ["code"], { agents: ["code.ai"], rules: ["ai:prompt-injection"] });
t("Prompt injection testing", "Malicious instructions override the rules.", ["code", "website", "app"], { agents: ["code.ai"], tools: ["ai-redteam"], rules: ["ai:prompt-injection", "ai:shell-tool", "ai:inj-*"] });
t("Chatbot red-teaming", "Attack a live chatbot: jailbreaks, leaks, harmful output, risky actions.", ["website", "app", "api"], { tools: ["ai-redteam"], rules: ["ai:jb-*", "ai:sys-*", "ai:leak-*", "ai:out-*", "ai:agency-*", "ai:mis-*", "ai:dos-*", "ai:harm-*", "garak:*"], manual: "Needs the client's written attack permission naming the chatbot's host." });
t("Indirect prompt injection testing", "Instructions hidden in pages, emails or files the AI reads.", ["website", "app", "api"], { tools: ["ai-redteam"], rules: ["ai:ind-*"], manual: "Needs the client's written attack permission; GLV serves the planted page itself." });
t("Hallucination testing", "Made-up or unsupported answers.", ["code", "website", "app"], { agents: ["code.ai"], tools: ["ai-redteam"], rules: ["ai:no-evals", "ai:mis-*"], manual: "Needs evaluation questions with known answers (Promptfoo, DeepEval)." });
t("Toxicity testing", "Harmful or abusive output.", ["code", "website", "app"], { tools: ["ai-redteam"], rules: ["ai:harm-*", "garak:*"], manual: "The chatbot red-team tool sends harmful-content prompts, with the client's permission." });
t("Safety testing", "Follows the defined safety rules.", ["code"], { agents: ["code.ai"], rules: ["ai:output-run-as-code", "ai:key-in-browser"] });
t("Fairness testing", "Fair outcomes across groups.", ["code"], { manual: "Needs a test set with the relevant groups." });
t("Explainability testing", "Outputs can be explained.", ["code"], { manual: "A review of the model and its explanations." });
t("Model drift testing", "Behaviour changes over time.", ["code"], { manual: "Run the same evaluation set on a schedule and compare." });
t("LLM evaluation", "Quality, relevance and correctness of answers.", ["code"], { agents: ["code.ai"], rules: ["ai:no-evals"] });
t("RAG testing", "Retrieval quality and grounded answers.", ["code"], { manual: "Needs the document set and questions with known answers (Ragas)." });
t("Context retention testing", "Conversation context kept correctly.", ["code"], { manual: "Multi-turn evaluation conversations." });
t("Response consistency testing", "Stable answers to the same prompt.", ["code"], { manual: "Run each evaluation prompt several times and compare." });
t("AI regression testing", "Quality after model or prompt changes.", ["code"], { agents: ["code.ai"], rules: ["ai:no-evals"] });
t("Agent testing", "Planning, tool use, permissions of AI agents.", ["code"], { agents: ["code.ai"], rules: ["ai:shell-tool", "ai:output-run-as-code"] });
t("Guardrail testing", "Policy limits on AI output and actions.", ["code"], { agents: ["code.ai"], rules: ["ai:*"] });

s("Methodologies");
t("Agile testing", "Testing throughout each sprint.", ALL, { platform: "Run tests on each release and track issues on the board." });
t("Waterfall testing", "Testing phases in a sequence.", ALL, { manual: "A project-management choice." });
t("Shift-left testing", "Test earlier in development.", ["code"], { agents: ["code.tests", "code.risky", "code.secrets"], platform: "Code tests run on the repository before release." });
t("Shift-right testing", "Learn from production.", ["website", "app"], { platform: "Uptime watch and real visitors' speed." });
t("DevOps testing", "Quality checks in delivery and operations.", ["code"], { agents: ["code.tests", "code.container"], platform: "The CLI runs in CI pipelines." });
t("Continuous integration testing", "Checks when code is merged.", ["code"], { agents: ["code.tests"], rules: ["tests:no-ci", "tests:ci-skips-tests"] });
t("Continuous delivery testing", "Checks throughout the release pipeline.", ALL, { platform: "Pass-or-fail gate (master control) can stop a release." });
t("Test-driven development", "Write the failing test first.", ["code"], { manual: "A developer practice; the code check reads the tests that result." });
t("Acceptance test-driven development", "Acceptance examples before building.", ALL, { platform: "Write the acceptance examples as journeys or scenarios before the work starts." });
t("Pair testing", "Two people test together.", ALL, { manual: "A team practice." });
t("Session-based testing", "Time-boxed exploratory sessions with notes.", ALL, { manual: "Record the session's findings as issues." });

s("Standards and guidelines");
t("WCAG", "Web Content Accessibility Guidelines.", ["website", "app"], { platform: "WCAG tab: every 2.2 A and AA criterion.", agents: A11Y });
t("OWASP Top 10", "Major web security risks.", ["website", "app"], { agents: ["web.security-headers", "sec.info-leak", "app.access", "app.csrf"], tools: ["zap"] });
t("OWASP API Security Top 10", "Common API risks.", ["api"], { agents: ["api.owasp", "api.audit", "api.access"] });
t("GDPR / DPDP Act", "Personal data protection.", ["website", "app", "mobile"], { agents: ["web.privacy", "web.cookies", "app.id-numbers", "app.data-in-url", "india.dpdp", "india.dpdp-forms"], rules: ["privacy:*", "cookie:*", "device:tracking-before-consent", "dpdp:*"] });
t("DPDP Rules 2025 (India)", "Notice items, consent, grievance officer, Board, languages.", ["website", "app"], { agents: ["india.dpdp", "india.dpdp-forms"], rules: ["dpdp:*"] });
t("GIGW 3.0 and IS 17802 (India)", "Indian government website and accessibility rules.", ["website", "app"], { agents: ["india.gigw", ...A11Y], rules: ["gigw:*"], platform: "WCAG tab: IS 17802 criteria shown next to WCAG 2.2." });
t("Dark patterns (CCPA 2023)", "The 13 dark patterns banned in India.", ["website", "app"], { agents: ["ux.dark-patterns", "ux.fake-timer"], rules: ["dark:*"] });
t("OWASP Top 10 for LLM apps (2025)", "Risks of apps built on language models.", ["website", "app", "code"], { agents: ["code.ai"], tools: ["ai-redteam"], rules: ["ai:*", "garak:*"] });
t("OWASP Agentic Top 10 (2026)", "Risks of AI agents that use tools.", ["website", "app", "code"], { agents: ["code.ai"], tools: ["ai-redteam"], rules: ["ai:agency-*", "ai:ind-*", "ai:shell-tool"] });
t("security.txt (RFC 9116)", "Where to report security holes.", ["website", "app"], { agents: ["sec.security-txt"], rules: ["sec:security-txt-*", "sec:no-security-txt"] });
t("PDF/UA and document accessibility", "Tagged, titled, readable PDFs and Office files.", ["website", "app"], { agents: ["a11y.documents"], tools: ["verapdf"], rules: ["doc:*", "verapdf:*"] });
t("GEO / AI search readiness", "Can AI search find, read and quote the site.", ["website"], { agents: ["seo.geo"], rules: ["geo:*"] });
t("PCI DSS", "Card data security.", ["website", "code"], { agents: ["store.checkout", "code.database", "web.https"], rules: ["db:stores-cvv", "db:sensitive-column"] });
t("ISO/IEC 25010", "Software quality model.", ALL, { platform: "The report's categories (functional, performance, security, accessibility, compatibility) follow its quality attributes." });

s("2026 gap report (wave 2)");
t("RAG answer quality", "Correct, sourced answers from the client's own documents, with no made-up facts.", ["website", "app"], { tools: ["ai-eval"], rules: ["aieval:*"] });
t("AI agent and tool-use safety", "An AI agent cannot run tools, send email or change data beyond what it should.", ["website", "app"], { tools: ["ai-redteam"], rules: ["ai:agency-*"] });
t("AI regression and drift", "A fixed question set, run over time; alert when answers get worse after a model or prompt change.", ["website", "app"], { tools: ["ai-eval"], rules: ["aieval:regression", "aieval:low-score"] });
t("MCP server security", "Tool poisoning, over-broad tools and missing auth on MCP servers.", ["api"], { tools: ["mcp-attack"], rules: ["mcp:*"] });
t("Lookalike / typosquat domains", "Typo domains a phisher could register in your name.", ["website", "app"], { tools: ["lookalike"], rules: ["lookalike:*"] });
t("Race conditions", "The same once-only action sent at the exact same instant.", ["website", "app", "api"], { tools: ["race"], rules: ["race:*"] });
t("HTTP smuggling, cache poisoning, host header", "Front-end and back-end read a request differently.", ["website", "app"], { tools: ["glv-attack"], rules: ["attack:request-smuggling", "attack:cache-poisoning", "sec:host-header-*"] });
t("OAuth / OpenID / SAML flaws", "Redirect tricks, missing state/PKCE, unsigned SAML.", ["website", "app"], { agents: ["sec.oauth"], rules: ["oauth:*", "saml:*"] });
t("File upload attacks", "Web shells, script in SVG, huge files, EXIF location in photos.", ["website", "app"], { agents: ["app.file-upload", "privacy.photo-exif"], rules: ["app:upload-runs-code", "privacy:photo-*"] });
t("Business logic (stores)", "Negative prices, fractional or huge quantities, coupon stacking.", ["website"], { tools: ["glv-attack"], rules: ["logic:*"] });
t("Network vulnerability scan", "Known CVEs on every open service of the client's servers.", ["website", "app", "api"], { tools: ["ports"], rules: ["netscan:*"] });
t("Cloud account posture", "Public buckets, open security groups, no MFA, logging off (AWS/GCP/Azure).", ["website", "app", "api", "code"], { tools: ["cloud"], rules: ["cloud:*"] });
t("Server hardening score", "CIS-style audit of Linux servers (firewall, updates, kernel, SSH).", ["website", "app"], { tools: ["conn-ssh"], rules: ["server:*", "certin:*"] });
t("Database health (read-only)", "Missing indexes, no foreign keys, plain-text passwords, slow queries, backups.", ["website", "app"], { tools: ["conn-ssh"], rules: ["db:*"] });
t("Chaos testing", "Kill a service, add network delay, and see if the app survives and recovers.", ["website", "app"], { tools: ["chaos"], rules: ["chaos:*"] });
t("Supply chain depth", "Typosquats, install scripts, unpinned GitHub Actions, risky CI.", ["code"], { agents: ["code.supply-chain"], rules: ["deps:*", "ci:*"] });
t("SAST (more languages)", "Deeper rules for Python, PHP, Go, Java, Kotlin, Swift, Dart.", ["code"], { agents: ["code.sast-languages"], rules: ["sast:*"] });
t("SBOM and licence compliance", "A full SBOM; flag GPL/AGPL in a closed product.", ["code"], { tools: ["sbom"], rules: ["sbom:*"] });
t("Run the client's tests and coverage", "npm test / pytest / phpunit / flutter test in a sandbox, with coverage.", ["code"], { tools: ["unit-tests"], rules: ["tests:*"] });
t("API breaking-change and lint", "Diff two OpenAPI files for breaking changes; style rules.", ["api"], { tools: ["openapi-diff"], rules: ["apidiff:*", "apilint:*"] });
t("API mocks / service virtualisation", "Fake a payment gateway or third-party API for tests.", ["api"], { tools: ["api-mock"] });
t("Payment gateway test flows", "Razorpay, Stripe, PayU, PayPal, UPI test-mode payment, failure and refund.", ["website", "api"], { tools: ["payments"], rules: ["payments:*"] });
t("Email template testing", "HTML email in Gmail/Outlook widths, dark mode, links, unsubscribe, spam score.", ["website", "app"], { tools: ["email-render"], rules: ["email:*"] });
t("Pairwise / combinatorial for forms", "The smallest set of input combinations that covers all value pairs.", RUN, { tools: ["pairwise"], rules: ["pairwise:*"] });
t("Export tests as code", "Download journeys as Playwright / Appium files the client keeps.", RUN, { tools: ["export-code"] });
t("Local SEO", "Consistent name/address/phone, LocalBusiness schema, map, Google Business.", ["website"], { agents: ["seo.local"], rules: ["seo:no-localbusiness-schema", "seo:nap-*", "seo:no-map", "seo:no-gbp-link"] });
t("hreflang / international SEO", "Return links, valid language codes, x-default.", ["website"], { agents: ["seo.hreflang"], rules: ["seo:hreflang-*"] });
t("JavaScript SEO render diff", "What Google sees before vs after JavaScript runs.", ["website"], { agents: ["seo.js-render"], rules: ["seo:content-needs-js", "seo:links-need-js"] });
t("Social preview", "Open Graph / Twitter cards and image for shared links.", ["website"], { agents: ["seo.social"], rules: ["seo:no-og-*", "seo:no-twitter-card"] });
t("Colour-blind and low-vision", "Information shown by colour alone (WCAG 1.4.1).", ["website", "app"], { agents: ["a11y.colour-vision"], rules: ["a11y:links-colour-only"] });
t("WCAG AAA and cognitive", "Reading level, timed refresh, consistent help (COGA).", ["website", "app"], { agents: ["a11y.aaa"], rules: ["a11y:reading-level", "a11y:time-limit", "a11y:inconsistent-help"] });
t("EN 301 549 / VPAT report", "An EU conformance / US VPAT accessibility report.", ["website", "app"], { tools: ["vpat"] });
t("Real screen-reader runs", "VoiceOver (Mac helper) and TalkBack labels on a phone.", ["website", "app", "mobile"], { tools: ["mac-voiceover", "talkback"], rules: ["a11y:app-unlabelled-controls"] });
t("Visual layout breaks", "Layout-aware check for phone side-scroll and off-canvas content.", ["website", "app"], { agents: ["ui.visual-layout"], rules: ["layout:*"] });
t("Testing from other regions", "Speed from Mumbai, Singapore, Frankfurt, US.", RUN, { tools: ["region-speed"], rules: ["region:*"] });
t("Frontend profiling", "Long tasks (INP), JavaScript size, DOM size, layout shift.", ["website", "app"], { agents: ["perf.frontend"], rules: ["perf:long-tasks", "perf:too-much-js", "perf:huge-dom", "perf:layout-shift"] });
t("Backend profiling / slow queries", "The slowest API calls and N+1 patterns while signed in.", ["app"], { agents: ["perf.backend"], rules: ["perf:slow-backend-call", "perf:n-plus-one"] });
t("Flutter / React Native specifics", "Dart/JS bundle secrets, Hermes, OTA (CodePush/Expo) update safety.", ["mobile"], { agents: ["android.ota", "ios.ota"], rules: ["mobile:codepush-unsigned", "mobile:expo-updates-unsigned", "mobile:ota-http"] });
t("App performance on device", "Start time, janky frames, memory, installed size.", ["mobile"], { tools: ["app-perf"], rules: ["appperf:*"] });
t("Maestro flows", "Simple, readable YAML app journeys on a phone.", ["mobile"], { tools: ["maestro"], rules: ["maestro:*"] });
t("Deep links and app links", "Every deep link opens the app, and cannot be hijacked.", ["mobile"], { tools: ["deeplink-run"], agents: ["android.links"], rules: ["deeplink:*"] });
t("In-app and India browsers", "WhatsApp/Instagram/Facebook webviews, Samsung, Opera, UC.", ["website", "app"], { tools: ["inapp-browser"], rules: ["inapp:*"] });
t("Consent proof (GDPR/DPDP)", "Trackers before consent, a real Reject button, Reject actually rejects.", ["website", "app"], { agents: ["privacy.consent-proof"], rules: ["privacy:tracker-before-consent", "privacy:reject-not-honoured", "privacy:no-reject-button"] });
t("PCI DSS 4.0 script controls", "Script inventory and integrity on payment pages (6.4.3, 11.6.1).", ["website"], { agents: ["sec.pci-scripts"], rules: ["pci:*"] });

s("2026 gap report (wave 3)");
t("Model file security", "Unsafe pickle model files (.pkl/.pt) that run code when loaded.", ["code"], { tools: ["model-security"], rules: ["model:*"] });
t("Infrastructure-as-code checks", "Terraform/CloudFormation/Kubernetes/Dockerfile safety rules.", ["code"], { tools: ["iac"], rules: ["iac:*"] });
t("Code fuzzing readiness", "Property-based/fuzz testing (fast-check, Hypothesis, Jazzer).", ["code"], { tools: ["code-fuzz"], rules: ["fuzz:*"] });
t("Browser extension checks", "Over-broad permissions and content-script risks in a manifest.", ["code"], { tools: ["browser-ext"], rules: ["ext:*"] });
t("Desktop app security", "Electron/Tauri webview settings (node integration, context isolation, CSP).", ["code"], { tools: ["desktop-app"], rules: ["desktop:*"] });
t("Print & PDF export layout", "Invoices/tickets print without being cut off; a print stylesheet exists.", ["website", "app"], { tools: ["print-layout"], rules: ["print:*"] });
t("Video, streaming & WebRTC quality", "Start time, buffering, media errors, WebRTC calls.", ["website", "app"], { tools: ["webrtc"], rules: ["webrtc:*"] });
t("Legal page change watch", "A fingerprint of terms/privacy pages to spot later changes.", ["website", "app"], { tools: ["page-watch"], rules: ["watch:*"] });
t("Carbon / sustainability", "Grams of CO2 per page view, from page weight (ESG reports).", ["website", "app"], { agents: ["perf.carbon"], rules: ["carbon:*"] });
t("Image, video & Discover SEO", "VideoObject schema, a large Discover image, image dimensions.", ["website"], { agents: ["seo.image-video"], rules: ["videoseo:*", "news:*", "imgseo:*"] });
t("Video & audio accessibility", "Captions on video, transcripts for audio (WCAG 1.2).", ["website", "app"], { agents: ["a11y.media"], rules: ["mediaa11y:*"] });
t("Second accessibility engine", "A second rule set beside axe (positive tabindex, duplicate ids, moving text).", ["website", "app"], { agents: ["a11y.engine2"], rules: ["a11y2:*"] });
t("HIPAA / health data leakage", "PHI in URLs and sent to third-party trackers.", ["website", "app"], { agents: ["sec.hipaa"], rules: ["hipaa:*"] });
t("Data reconciliation", "A total matches across two systems (CRM vs accounting).", ["api", "app"], { tools: ["reconciliation"], rules: ["recon:*"] });
t("Data quality & ETL", "Nulls, duplicates and out-of-range values in a data export.", ["api", "code"], { tools: ["data-quality"], rules: ["dq:*"] });
t("Message queues & events", "An AsyncAPI spec is complete and valid (Kafka/RabbitMQ/SQS).", ["api", "code"], { tools: ["queues"], rules: ["queue:*"] });
t("Distributed tracing", "A request's trace id propagates across microservices (OpenTelemetry).", ["api"], { tools: ["tracing"], rules: ["trace:*"] });
t("Kubernetes & Docker host", "Privileged pods, rootful Docker, host network (kube-bench/Dockle).", ["website", "app", "api", "code"], { tools: ["k8s"], rules: ["k8s:*"] });
t("Log-file SEO", "What Googlebot really crawls, from the server's access logs.", ["website", "app"], { tools: ["log-seo"], rules: ["logseo:*"] });
t("Backup & DR drill", "Backups are recent and a restore is actually tested.", ["website", "app", "api"], { tools: ["dr-drill"], rules: ["dr:*"] });
t("Database code tests", "Stored procedures and triggers that have no tests (pgTAP/tSQLt).", ["api", "code"], { tools: ["db-code"], rules: ["dbcode:*"] });
t("AI call cost & speed", "Tokens, latency and timeouts of an AI endpoint (runaway-bill guard).", ["website", "app", "api"], { tools: ["ai-cost"], rules: ["aicost:*"] });
t("SMS & WhatsApp messages", "Length, opt-out wording, India DLT ids, variable placeholders.", ["website", "app", "api"], { tools: ["messaging"], rules: ["msg:*"] });
t("Post-quantum readiness", "TLS ML-KEM hybrid key exchange, and weak-crypto in code.", ["website", "app", "api", "code"], { tools: ["pqc"], rules: ["pqc:*"] });
t("SOC 2 / ISO 27001 evidence", "Maps GLV's scans to audit controls as an evidence appendix.", ["website", "app", "api", "code"], { tools: ["soc2"], rules: ["soc2:*"] });
t("Backlink index (Common Crawl)", "Who links to the site, from Common Crawl's open web graph.", ["website"], { tools: ["backlinks"], rules: ["backlink:*"] });
t("Store listing checks", "Data-safety form / privacy labels match the app; size limits.", ["mobile"], { tools: ["store-listing"], rules: ["store:*"] });
t("In-app purchases & subscriptions", "Billing library, server-side receipt validation, buy/restore/cancel/refund.", ["mobile"], { tools: ["iap"], rules: ["iap:*"] });
s("2026 gap report (wave 4)");
t("IAST (interactive app testing)", "Taint scan of request input into dangerous sinks, plus a runtime hook for the client's tests.", ["code"], { tools: ["iast"], rules: ["iast:*"] });
t("Keyword & rank tracking", "Where the client ranks for a keyword, via self-hosted SearXNG or the client's own free Google key.", ["website", "app"], { tools: ["rank-tracking"], rules: ["rank:*"] });
t("AI answer visibility tracking", "Whether an LLM answer mentions the client, via a local model or the client's own key.", ["website", "app"], { tools: ["ai-visibility"], rules: ["aivis:*"] });
t("Windows-only browsers & fonts", "Real Edge on a self-hosted Windows VM (W3C WebDriver) + font availability.", ["website", "app"], { tools: ["windows-browser"], rules: ["winbrowser:*", "winfont:*"] });
t("Wear, watch, TV & Auto", "Watch/TV/Auto screen profiles in bundled Chromium: fit, targets, remote focus.", ["website", "app"], { tools: ["device-matrix"], rules: ["device:*"] });
t("Smart TV, kiosk, POS, IoT, games", "Kiosk/POS/IoT screen profiles + an HTML5 game FPS/WebGL check.", ["website", "app"], { tools: ["device-matrix", "game-test"], rules: ["device:*", "game:*"] });
t("Push notifications end to end", "Sends a test push through the client's own FCM/APNs and checks the deep link.", ["mobile"], { tools: ["push-send"], rules: ["push:*"] });
t("Jira / Linear export", "Pushes a findings file into the client's own Jira/Linear, or a CSV.", RUN, { tools: ["tracker-export"], rules: ["tracker:*"] });
t("Voice-bot / IVR testing", "Speaks prompts (Piper) and transcribes replies (Whisper) to check a voice flow.", ["website", "app", "api"], { tools: ["voice-bot"], rules: ["voice:*"] });
t("Test management & traceability", "Requirements → test cases → results, release sign-off.", ALL, { manual: "Covered by the manual checklists and the master-control pass/fail gate; extend per enterprise client." });

export const HANDBOOK: HandbookType[] = T;

/** Which handbook modules a product type belongs to. */
export function moduleOf(product: ProductType): Module {
  if (product === "api") return "api";
  if (product === "code") return "code";
  if (product === "android" || product === "ios") return "mobile";
  if (product === "webapp" || product === "saas" || product === "crm") return "app";
  return "website";
}

const matches = (rule: string, pattern: string) => (pattern.endsWith("*") ? rule.startsWith(pattern.slice(0, -1)) : rule === pattern);

/** The handbook, type by type, for one test's result. */
export function handbookReport(result: ScanResult, product: ProductType): HandbookReport {
  const mod = moduleOf(product);
  const stats = result.agentStats ?? [];
  const ran = new Map(stats.filter((s) => !s.untested && !s.skipped && (s.runs ?? 1) > 0).map((s) => [s.id, s]));
  const tools = new Map((result.tools ?? []).filter((x) => x.status === "done").map((x) => [x.id, x]));
  const live = result.findings.filter((f) => f.severity !== "info");
  const rows: HandbookRow[] = HANDBOOK.filter((h) => h.modules.includes(mod)).map((h) => {
    const hits: Finding[] = live.filter((f) => (h.rules ?? []).some((r) => matches(f.rule, r)) || (h.agents ?? []).includes(f.agent ?? ""));
    const by = [...(h.agents ?? []).filter((a) => ran.has(a)).map((a) => ran.get(a)!.name), ...(h.tools ?? []).filter((x) => tools.has(x)).map((x) => tools.get(x)!.name)];
    const cases = (h.agents ?? []).reduce((n, a) => n + (ran.get(a)?.cases ?? 0), 0);
    let status: HandbookStatus;
    if (hits.length) status = "fails";
    else if (by.length) status = "passes";
    else if (h.platform && !h.agents?.length && !h.tools?.length) status = "platform";
    else if (h.agents?.length || h.tools?.length) status = h.platform ? "platform" : h.manual ? "manual" : "not-run";
    else if (h.platform) status = "platform";
    else status = "manual";
    return { ...h, status, findings: hits.reduce((n, f) => n + (f.count ?? 1), 0), problems: [...new Set(hits.map((f) => f.title))].slice(0, 4), cases, ranBy: [...new Set(by)] };
  });
  const counts = { fails: 0, passes: 0, platform: 0, "not-run": 0, manual: 0 } as Record<HandbookStatus, number>;
  for (const r of rows) counts[r.status]++;
  const cases = stats.reduce((n, s) => n + (s.cases ?? 0), 0);
  const casesFailed = stats.reduce((n, s) => n + (s.casesFailed ?? 0), 0);
  return { rows, counts, cases, casesFailed, checks: ran.size + tools.size };
}
