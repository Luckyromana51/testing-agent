import type { Cookie } from "playwright";
import type { Finding } from "../../types.js";
import { finding } from "../finding.js";

/**
 * Passive security checks only: they read what the server already sends.
 * Nothing here sends attack payloads, so it is safe to run against any site
 * the client has authorised us to test.
 */
export function headerFindings(url: string, headers: Record<string, string>): Finding[] {
  const out: Finding[] = [];
  const h = (name: string) => headers[name.toLowerCase()];
  const isHttps = url.startsWith("https://");
  const add = (
    rule: string,
    severity: Finding["severity"],
    title: string,
    detail: string,
    evidence?: string,
  ) => out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: url, evidence }));

  if (!isHttps) {
    add(
      "sec:no-https",
      "critical",
      "Page is served over plain HTTP",
      "Traffic can be read or changed by anyone on the network. Serve the site over HTTPS and redirect HTTP to HTTPS.",
    );
  } else if (!h("strict-transport-security")) {
    add(
      "sec:hsts-missing",
      "medium",
      "Missing Strict-Transport-Security header",
      "HSTS tells browsers to always use HTTPS. Add: Strict-Transport-Security: max-age=31536000; includeSubDomains",
    );
  }

  const csp = h("content-security-policy");
  if (!csp) {
    add(
      "sec:csp-missing",
      "medium",
      "Missing Content-Security-Policy header",
      "A CSP limits which scripts can run and is the main defence against cross-site scripting (XSS).",
    );
  }
  if (!h("x-frame-options") && !(csp && /frame-ancestors/i.test(csp))) {
    add(
      "sec:clickjacking",
      "medium",
      "Page can be embedded in other sites (clickjacking)",
      "Add X-Frame-Options: DENY or a CSP frame-ancestors rule.",
    );
  }
  if ((h("x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
    add(
      "sec:nosniff-missing",
      "low",
      "Missing X-Content-Type-Options: nosniff",
      "Stops browsers from guessing file types, which can turn uploads into scripts.",
    );
  }
  if (!h("referrer-policy")) {
    add(
      "sec:referrer-policy",
      "low",
      "Missing Referrer-Policy header",
      "Without it, full URLs (which may contain tokens) can leak to other sites. Use strict-origin-when-cross-origin.",
    );
  }
  const server = h("server");
  const powered = h("x-powered-by");
  for (const [name, value] of [
    ["Server", server],
    ["X-Powered-By", powered],
  ] as const) {
    if (value && /\d/.test(value)) {
      add(
        "sec:version-disclosure",
        "low",
        `${name} header reveals software version`,
        "Attackers use exact versions to look up known vulnerabilities. Hide the version number.",
        `${name}: ${value}`,
      );
    }
  }
  return out;
}

export function cookieFindings(url: string, cookies: Cookie[]): Finding[] {
  const out: Finding[] = [];
  const host = new URL(url).hostname;
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, "");
    if (!host.endsWith(domain)) continue; // only first-party cookies
    const problems: string[] = [];
    if (url.startsWith("https://") && !c.secure) problems.push("Secure");
    if (!c.httpOnly && /sess|auth|token|sid|jwt/i.test(c.name)) problems.push("HttpOnly");
    if (c.sameSite === "None" && !c.secure) problems.push("SameSite=None needs Secure");
    if (problems.length) {
      out.push(
        finding({
          category: "security",
          rule: "sec:cookie-flags",
          severity: problems.includes("HttpOnly") ? "high" : "medium",
          title: `Cookie "${c.name}" is missing ${problems.join(", ")}`,
          detail:
            "Session cookies should be Secure (HTTPS only) and HttpOnly (not readable by JavaScript) to prevent theft.",
          pageUrl: url,
          evidence: c.name,
        }),
      );
    }
  }
  return out;
}

export function mixedContentFinding(pageUrl: string, insecureUrls: string[]): Finding[] {
  if (!pageUrl.startsWith("https://") || insecureUrls.length === 0) return [];
  return [
    finding({
      category: "security",
      rule: "sec:mixed-content",
      severity: "high",
      title: `${insecureUrls.length} resource(s) loaded over HTTP on an HTTPS page`,
      detail:
        "Mixed content can be tampered with and makes browsers show a warning. Load every resource over HTTPS.",
      pageUrl,
      evidence: insecureUrls.slice(0, 20).join("\n"),
    }),
  ];
}
