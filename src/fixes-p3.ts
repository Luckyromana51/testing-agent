import type { Fix } from "./fixes.js";

/**
 * Written fixes for the checks added in wave 3 of the 2026 gap report (the P3 / niche items): model
 * file security, IaC, code fuzzing, browser extensions, desktop apps, print/PDF layout, media
 * quality and accessibility, carbon, image/video/Discover SEO, reconciliation, data quality, queues,
 * tracing, Kubernetes/Docker, log-file SEO, DR/backups, DB code, AI cost, messaging, post-quantum,
 * SOC 2 evidence, backlinks, HIPAA, store listing and in-app purchases.
 */
export const P3_FIXES: Record<string, Fix> = {
  // Model file security
  "model:pickle-format": { steps: "This model file loads with Python pickle, which runs arbitrary code. Convert it to safetensors (torch.save → safetensors save_file) and load with weights_only=True; never load a model from an untrusted source.", effort: "hours" },
  "model:unsafe-operator": { steps: "ModelScan found an unsafe operator in the model. Do not load it; re-create the model from a trusted source and save it as safetensors.", effort: "hours" },

  // Infrastructure-as-code
  "iac:docker-root": { steps: "Add a non-root USER to the Dockerfile so the container does not run as root.", effort: "minutes" },
  "iac:docker-latest": { steps: "Pin the base image to a specific version or digest (FROM image:1.2.3@sha256:…) so builds are reproducible.", effort: "minutes" },
  "iac:docker-no-healthcheck": { steps: "Add a HEALTHCHECK so the orchestrator can detect an unhealthy container.", effort: "minutes" },
  "iac:docker-add-url": { steps: "Replace ADD <url> with COPY of a vendored file, or curl/wget with a checksum.", effort: "minutes" },
  "iac:open-ingress": { steps: "Restrict the security-group/firewall rule from 0.0.0.0/0 to known IP ranges, especially for SSH, RDP and database ports.", effort: "hours" },
  "iac:public-bucket": { steps: "Make the storage bucket private and serve files through signed URLs or a CDN.", effort: "hours" },
  "iac:unencrypted": { steps: "Turn on encryption at rest for the disk, database or bucket.", effort: "minutes" },
  "iac:hardcoded-secret": { steps: "Move the secret out of the IaC file into a secret manager or a variable, and rotate it since it was committed.", effort: "hours" },
  "iac:k8s-privileged": { steps: "Remove privileged: true from the pod and grant only the specific capabilities it needs.", effort: "hours" },
  "iac:k8s-root": { steps: "Set securityContext.runAsNonRoot: true and a runAsUser for the pod.", effort: "minutes" },
  "iac:k8s-latest": { steps: "Pin container image tags or digests instead of :latest.", effort: "minutes" },
  "iac:k8s-no-limits": { steps: "Set CPU and memory requests and limits on the containers.", effort: "minutes" },

  // Code fuzzing
  "fuzz:none": { steps: "Add property-based/fuzz testing: fast-check (JS/TS), Hypothesis (Python) or Jazzer (JVM). Target parsers, validators and any code that handles untrusted input.", effort: "days" },

  // Browser extension
  "ext:manifest-v2": { steps: "Migrate the extension to Manifest V3 (service worker, declarativeNetRequest).", effort: "days" },
  "ext:broad-host": { steps: "Narrow the host permissions from <all_urls> to just the sites the extension needs.", effort: "hours" },
  "ext:sensitive-perms": { steps: "Remove any sensitive permission the extension does not strictly need (cookies, webRequest, scripting, debugger).", effort: "hours" },
  "ext:content-all-urls": { steps: "Restrict content-script matches to the specific pages the extension runs on.", effort: "hours" },
  "ext:unsafe-csp": { steps: "Remove unsafe-eval and unsafe-inline from the extension's content_security_policy.", effort: "hours" },
  "ext:externally-connectable": { steps: "Restrict externally_connectable to specific trusted origins instead of a wildcard.", effort: "hours" },

  // Desktop app
  "desktop:node-integration": { steps: "Set nodeIntegration: false and use a preload script with contextBridge to expose only the APIs the page needs.", effort: "hours" },
  "desktop:no-context-isolation": { steps: "Set contextIsolation: true (the Electron default) and expose APIs via contextBridge.", effort: "hours" },
  "desktop:no-web-security": { steps: "Remove webSecurity: false so same-origin protections stay on.", effort: "minutes" },
  "desktop:remote-module": { steps: "Stop using the Electron remote module; move the logic behind IPC messages.", effort: "hours" },
  "desktop:insecure-content": { steps: "Remove allowRunningInsecureContent and serve all resources over https.", effort: "minutes" },
  "desktop:tauri-allowlist-all": { steps: 'Replace the Tauri allowlist "all": true with only the specific APIs the frontend uses.', effort: "hours" },
  "desktop:tauri-remote-ipc": { steps: "Remove dangerousRemoteDomainIpcAccess unless a remote page genuinely must call Rust commands.", effort: "hours" },
  "desktop:tauri-no-csp": { steps: "Set tauri.security.csp so the webview blocks injected and remote scripts.", effort: "minutes" },

  // Print / PDF layout
  "print:overflow": { steps: "Add a print stylesheet that uses fluid widths and @page margins so content is not cut off on paper/PDF.", effort: "hours" },
  "print:no-print-css": { steps: "Add @media print rules that hide navigation/sidebars and lay the document out for paper.", effort: "hours" },

  // Video / streaming / WebRTC
  "webrtc:slow-start": { steps: "Use adaptive bitrate streaming (HLS/DASH), a low starting quality, a poster image and a CDN near your viewers.", effort: "days" },
  "webrtc:stalls": { steps: "Serve media from a CDN and use adaptive streaming so quality drops instead of buffering.", effort: "hours" },
  "webrtc:media-error": { steps: "Fix the media source: check the URL, codecs and CORS headers.", effort: "hours" },

  // Legal-page watch
  "watch:no-legal-pages": { steps: "Publish terms and a privacy policy (DPDP/GDPR) and link them in the footer.", effort: "hours" },

  // Reconciliation
  "recon:mismatch": { steps: "Find the records in one system but not the other (timing, failed sync, rounding, cancelled items) and fix the sync or the calculation so the two totals agree.", effort: "hours" },

  // Data quality
  "dq:null": { steps: "Fix the source or add a validation/cleaning step so required columns are never empty.", effort: "hours" },
  "dq:duplicate": { steps: "Add a unique constraint or de-duplication step so the column has no duplicates.", effort: "hours" },
  "dq:range": { steps: "Validate the column's range at the source so out-of-range values cannot enter the pipeline.", effort: "hours" },

  // Queues / AsyncAPI
  "queue:not-asyncapi": { steps: "Provide a valid AsyncAPI 2.x/3.x document describing the service's channels and messages.", effort: "hours" },
  "queue:no-channels": { steps: "Declare the channels (topics/queues) the service publishes to and subscribes from in the AsyncAPI spec.", effort: "hours" },
  "queue:channel-no-message": { steps: "Declare each channel's message payload schema so producers and consumers agree.", effort: "hours" },

  // Tracing
  "trace:no-propagation": { steps: "Add OpenTelemetry instrumentation that propagates the W3C traceparent across services, and export traces to Jaeger/Tempo. At minimum, echo a request id.", effort: "days" },

  // Kubernetes / Docker
  "k8s:docker-rootful": { steps: "Run Docker rootless or with user namespaces, and drop container capabilities.", effort: "hours" },
  "k8s:docker-no-seccomp": { steps: "Run containers with the default seccomp profile.", effort: "minutes" },
  "k8s:privileged-pod": { steps: "Remove privileged: true from the pod and grant only the capabilities it needs.", effort: "hours" },
  "k8s:host-network": { steps: "Use a normal pod network instead of hostNetwork: true unless a node agent truly needs the host.", effort: "hours" },
  "k8s:none": { steps: "Run this check from a host that can reach the Docker daemon or the cluster, or install kube-bench/Kubescape there.", effort: "minutes" },

  // Log-file SEO
  "logseo:no-logs": { steps: "Point the check at the correct access-log path, or export the logs so GLV can analyse real crawler behaviour.", effort: "minutes" },
  "logseo:no-googlebot": { steps: "Check robots.txt and Search Console; make sure the site is submitted and not blocked, so Googlebot can crawl it.", effort: "hours" },
  "logseo:high-404": { steps: "Fix internal links and add redirects so crawlers do not waste budget on dead pages.", effort: "hours" },

  // DR / backups
  "dr:no-backups": { steps: "Set up automatic daily backups stored off the server, and alert on failures.", effort: "hours" },
  "dr:stale-backup": { steps: "Fix the backup job so it runs and succeeds daily, and alert when it does not.", effort: "hours" },
  "dr:no-restore-test": { steps: "Schedule a monthly restore of the latest backup to a temporary server and run smoke tests against it.", effort: "hours" },

  // Database code
  "dbcode:untested": { steps: "Add database unit tests for stored procedures and triggers with pgTAP (PostgreSQL) or tSQLt (SQL Server).", effort: "days" },

  // AI cost / speed
  "aicost:timeout": { steps: "Set a hard timeout and a fallback answer, and stream responses so users see words sooner.", effort: "hours" },
  "aicost:slow": { steps: "Stream output, cache common answers, and use a smaller/faster model for easy questions.", effort: "hours" },
  "aicost:expensive": { steps: "Trim the prompt and retrieved context, cap max tokens, and cache answers to repeated questions.", effort: "hours" },

  // Messaging
  "msg:too-long": { steps: "Shorten the message to fit one SMS part (160 GSM / 70 Unicode), or split it intentionally.", effort: "minutes" },
  "msg:no-optout": { steps: "Add opt-out wording (e.g. 'Reply STOP') to marketing messages.", effort: "minutes" },
  "msg:no-dlt": { steps: "Register the template on India's DLT platform and send it with the approved template id.", effort: "hours" },
  "msg:empty-var": { steps: "Give every placeholder a number/name so it is filled correctly.", effort: "minutes" },

  // Post-quantum
  "pqc:no-hybrid-tls": { steps: "Plan to enable an ML-KEM hybrid key exchange (X25519MLKEM768) on the server (OpenSSL 3.5+, recent nginx/BoringSSL) so recorded traffic stays safe against future quantum computers.", effort: "days" },
  "pqc:weak-crypto": { steps: "Replace weak algorithms: SHA-256/BLAKE2 for hashing, AES-GCM for encryption, RSA ≥3072 or ECDSA/Ed25519 for keys. Never use MD5, SHA-1, DES, RC4 or ECB.", effort: "hours" },

  // SOC 2
  "soc2:evidence": { steps: "Run the checks named in the control-evidence report and keep their reports as audit evidence. This supports an audit; it is not a certification.", effort: "days" },

  // Backlinks
  "backlink:unavailable": { steps: "Run the backlink check against a Common Crawl mirror on GLV servers. Google-ranking data and a full paid-index backlink graph cannot be reproduced fully in-house.", effort: "hours" },

  // Carbon
  "carbon:heavy-page": { steps: "Lighten the page: compress and lazy-load images, use AVIF/WebP, remove unused JavaScript, and cache at a CDN.", effort: "hours" },

  // Image / video / Discover SEO
  "videoseo:no-schema": { steps: "Add VideoObject JSON-LD (name, description, thumbnailUrl, uploadDate) so the video can appear in Google video results.", effort: "hours" },
  "news:no-og-image": { steps: "Add an og:image at least 1200px wide so the page can appear in Google Discover and looks right when shared.", effort: "minutes" },
  "news:small-og-image": { steps: "Use a larger og:image (1200px+ wide) and allow max-image-preview:large for Discover.", effort: "minutes" },
  "imgseo:no-dimensions": { steps: "Set explicit width/height on images and use descriptive file names and alt text.", effort: "hours" },

  // Media accessibility
  "mediaa11y:no-captions": { steps: "Add a <track kind=\"captions\"> to each video (generate a draft with Whisper and correct it). WCAG 1.2.2.", effort: "hours" },
  "mediaa11y:no-transcript": { steps: "Publish a transcript next to the audio player. WCAG 1.2.1.", effort: "hours" },

  // Second accessibility engine
  "a11y2:positive-tabindex": { steps: "Use tabindex=\"0\" or rely on DOM order instead of positive tabindex values.", effort: "hours" },
  "a11y2:duplicate-id": { steps: "Make every id attribute unique so label/aria associations work.", effort: "hours" },
  "a11y2:moving-text": { steps: "Remove auto-moving/blinking text or add a pause control (WCAG 2.2.2).", effort: "hours" },
  "a11y2:tiny-font": { steps: "Use at least 12–16px for body text.", effort: "minutes" },
  "a11y2:justified-text": { steps: "Use left-aligned text instead of fully justified text.", effort: "minutes" },

  // HIPAA
  "hipaa:phi-in-url": { steps: "Keep patient/health data out of URLs: use POST bodies or opaque ids, so PHI does not leak into logs, history and the Referer header.", effort: "hours" },
  "hipaa:phi-to-tracker": { steps: "Stop sending PHI to analytics/ad trackers: remove PHI from tracker calls or do not load trackers on health pages. Sending PHI to third parties without a BAA breaches HIPAA.", effort: "hours" },

  // Store listing
  "store:data-safety": { steps: "Fill the Play Data safety form / Apple privacy labels to match the app's sensitive permissions.", effort: "hours" },
  "store:tracker-disclosure": { steps: "Declare the analytics/ad SDKs in the Data safety form / privacy labels, and use App Tracking Transparency on iOS.", effort: "hours" },
  "store:size": { steps: "Ship an Android App Bundle (AAB) with per-device delivery, or use Play Asset Delivery, to stay under the APK size limit.", effort: "hours" },

  // In-app purchases
  "iap:no-receipt-validation": { steps: "Validate purchase receipts server-side (Play Developer API / App Store Server API) so purchases cannot be faked by patched clients.", effort: "hours" },
  "iap:test-flows": { steps: "Test buy, restore on a new device, cancel and refund on Play's test tracks / StoreKit test config.", effort: "hours" },
};

const PATTERN: { test: RegExp; fix: Fix }[] = [
  { test: /^iac:/, fix: { steps: "Fix the flagged infrastructure-as-code setting: close public access, encrypt storage, drop privileges, pin images and move secrets to a secret manager.", effort: "hours" } },
  { test: /^k8s:/, fix: { steps: "Harden the container/cluster: rootless Docker, no privileged or host-network pods, resource limits and pinned images.", effort: "hours" } },
  { test: /^ext:/, fix: { steps: "Reduce the browser extension's permissions and tighten its CSP and content-script matches.", effort: "hours" } },
  { test: /^desktop:/, fix: { steps: "Harden the desktop app's webview settings (context isolation on, node integration off, a strict CSP).", effort: "hours" } },
];

/** A fix for a wave-3 rule matched by its prefix, when there is no exact entry. Pure, for tests. */
export function p3PatternFix(rule: string): Fix | undefined {
  return PATTERN.find((p) => p.test.test(rule))?.fix;
}
