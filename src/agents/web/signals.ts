import type { Page } from "playwright";
import { mixedContentFinding } from "../../runner/checks/security.js";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding } from "../../types.js";
import type { PageAgent, PageSignals } from "../types.js";

/** Starts recording console errors, crashes and requests. Call before the page loads. */
export function listen(page: Page): PageSignals {
  const s: PageSignals = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    badResponses: [],
    insecure: [],
    requests: [],
  };
  // The page's own address (and its redirects) is reported by the crawler, not as a resource.
  const isMainDocument = (req: { isNavigationRequest(): boolean; frame(): unknown }) => {
    try {
      return req.isNavigationRequest() && req.frame() === page.mainFrame();
    } catch {
      return false;
    }
  };
  page.on("console", (msg) => {
    if (msg.type() === "error") s.consoleErrors.push({ text: msg.text().slice(0, 300), source: msg.location().url });
  });
  page.on("pageerror", (err) => s.pageErrors.push(err.message.slice(0, 300)));
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "failed";
    if (reason.includes("ERR_ABORTED")) return; // navigation away, not a real failure
    if (isMainDocument(req)) return; // the page itself failing is reported once, by the crawler
    s.failedRequests.push(`${req.url()} (${reason})`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400 && !isMainDocument(res.request())) s.badResponses.push(`${res.status()} ${res.url()}`);
  });
  page.on("request", (req) => {
    s.requests.push(req.url());
    if (req.url().startsWith("http://") && !isMainDocument(req)) s.insecure.push(req.url());
  });
  return s;
}

function group(
  url: string,
  items: string[],
  rule: string,
  severity: Finding["severity"],
  title: string,
  detail: string,
  category: Finding["category"] = "functional",
): Finding[] {
  const unique = [...new Set(items)];
  if (!unique.length) return [];
  return [
    finding({
      category,
      rule,
      severity,
      title: `${unique.length} ${title}`,
      detail,
      pageUrl: url,
      evidence: unique.slice(0, 15).join("\n"),
      count: unique.length,
    }),
  ];
}

export const jsErrorsAgent: PageAgent = {
  id: "web.js-errors",
  name: "JavaScript errors",
  description:
    "Catches crashes, scripts blocked by a wrong integrity hash, security-policy blocks and console errors, keeping your own code apart from third-party widgets.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  run({ url, signals: s }) {
    // "Failed to load resource" lines repeat what the resources agent already reports.
    const consoleErrors = s.consoleErrors.filter((c) => !/^Failed to load resource/i.test(c.text));
    const sri = consoleErrors.filter((c) => /integrity/i.test(c.text) && /block/i.test(c.text));
    const csp = consoleErrors.filter((c) => /Content Security Policy/i.test(c.text));
    const rest = consoleErrors.filter((c) => !sri.includes(c) && !csp.includes(c));
    const pageOrigin = new URL(url).origin;
    const isThirdParty = (source: string) => {
      try {
        return Boolean(source) && new URL(source).origin !== pageOrigin;
      } catch {
        return false;
      }
    };
    return [
      ...group(
        url,
        s.pageErrors,
        "js-exception",
        "high",
        "uncaught JavaScript error(s)",
        "Uncaught errors can break buttons, forms and other features on the page.",
      ),
      ...group(
        url,
        sri.map((c) => c.text),
        "sri-blocked",
        "high",
        "script(s) or style(s) blocked by an integrity check",
        "The browser refused to run a file because its content does not match the integrity hash the page gave for it, so that feature does not work. This usually happens after a deploy when the file changed but the hash did not, or when the hash was copied wrongly.",
      ),
      ...group(
        url,
        csp.map((c) => c.text),
        "csp-violation",
        "medium",
        "Content-Security-Policy violation(s)",
        "The site's own security policy blocked something the page tried to load or run. Either the policy is too strict for a feature you use, or something unexpected was injected.",
        "security",
      ),
      ...group(
        url,
        rest.filter((c) => !isThirdParty(c.source)).map((c) => c.text),
        "console-error",
        "medium",
        "console error(s)",
        "Errors logged in the browser console often point to broken scripts or missing files.",
      ),
      ...group(
        url,
        rest.filter((c) => isThirdParty(c.source)).map((c) => `${c.text} (from ${c.source})`),
        "console-error-third-party",
        "low",
        "console error(s) from third-party scripts",
        "These come from code loaded from other sites (chat widgets, analytics, ads). They rarely break your page but are worth a look.",
      ),
    ];
  },
};

export const resourcesAgent: PageAgent = {
  id: "web.resources",
  name: "Missing files",
  description: "Finds images, scripts, styles and fonts that fail to load or answer with an error.",
  category: "functional",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  run({ url, signals: s }) {
    return [
      ...group(
        url,
        s.badResponses,
        "broken-resource",
        "medium",
        "resource(s) returned an error status",
        "Images, scripts or styles the page needs could not be loaded.",
      ),
      ...group(
        url,
        s.failedRequests,
        "failed-request",
        "medium",
        "request(s) failed to load",
        "The browser could not fetch these files at all (DNS, network or blocked).",
      ),
    ];
  },
};

export const mixedContentAgent: PageAgent = {
  id: "web.mixed-content",
  name: "Mixed content",
  description: "Finds files loaded over plain HTTP on secure HTTPS pages.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "end",
  run({ url, signals }) {
    return mixedContentFinding(url, [...new Set(signals.insecure)]);
  },
};
