import { readFile } from "node:fs/promises";
import path from "node:path";
import { WEB_PRODUCTS } from "../products.js";
import type { Severity } from "../types.js";
import { lastLine, runProcess, which } from "./process.js";
import type { Tool, ToolContext, ToolFinding, ToolOutput } from "./types.js";

interface TestsslItem {
  id: string;
  ip?: string;
  port?: string;
  severity: string;
  finding: string;
  cve?: string;
  cwe?: string;
}

const SEVERITY: Record<string, Severity> = { LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" };

const PROTOCOLS: Record<string, string> = { SSLv2: "SSL 2", SSLv3: "SSL 3", TLS1: "TLS 1.0", TLS1_1: "TLS 1.1", TLS1_2: "TLS 1.2", TLS1_3: "TLS 1.3" };

/** The platform's own rules for the same problem, so a problem found twice is counted once. */
const SAME_AS: Record<string, string[]> = {
  HSTS: ["sec:hsts-missing"],
  cert_expirationStatus: ["sec:cert-expired", "sec:cert-expiring"],
  cert_chain_of_trust: ["sec:cert-invalid", "sec:cert-chain"],
  cert_trust: ["sec:cert-invalid"],
  banner_server: ["sec:version-disclosure"],
  banner_application: ["sec:version-disclosure"],
  cookie_secure: ["sec:cookie-flags"],
  cookie_httponly: ["sec:cookie-flags"],
};

/**
 * Items left out: one line per cipher (the cipher lists sum them up), the end date (the expiry
 * status covers it), the grade (shown in the summary), and HTTP headers (the platform's own
 * security checks test those on every page).
 */
const SKIP = /^(cipher-|cipher_x|cert_notAfter|cert_notBefore|overall_grade|grade_cap|security_headers|banner_reverseproxy|HTTP_|clientsimulation|engine_problem)/;

const CERT: Record<string, string> = {
  cert_chain_of_trust: "The HTTPS certificate is not trusted",
  cert_trust: "The certificate does not properly match the address",
  cert_subjectAltName: "The certificate has no Subject Alternative Name, which browsers require",
  cert_expirationStatus: "The HTTPS certificate expires soon or has expired",
  cert_revocation: "The certificate cannot be checked for revocation (no CRL or OCSP address)",
  cert_signatureAlgorithm: "The certificate uses a weak signature algorithm",
  cert_keySize: "The certificate key is too short",
  cert_validityPeriod: "The certificate is valid for longer than browsers accept",
  OCSP_stapling: "OCSP stapling is off",
  DNS_CAArecord: "No CAA record limits who can issue certificates for this domain",
};

const CIPHERS: Record<string, string> = {
  cipherlist_NULL: "no encryption (NULL ciphers)",
  cipherlist_aNULL: "no authentication (anonymous ciphers)",
  cipherlist_EXPORT: "export-grade ciphers",
  cipherlist_LOW: "low-strength ciphers",
  cipherlist_3DES_IDEA: "3DES or IDEA ciphers",
  cipherlist_OBSOLETED: "obsolete CBC ciphers",
  cipherlist_STRONG_NOFS: "strong ciphers without forward secrecy",
  RC4: "RC4 ciphers",
};

function describe(item: TestsslItem): { title: string; detail: string } {
  const id = item.id;
  const finding = item.finding.replace(/\s+/g, " ").trim();
  const ref = [item.cve && `CVE: ${item.cve}`, item.cwe && `${item.cwe}`].filter(Boolean).join(", ");
  const tail = ref ? ` (${ref})` : "";
  if (id === "HSTS") {
    return {
      title: "HSTS is not turned on",
      detail: `Without HSTS, a browser can be tricked into opening the site over plain HTTP the first time (${finding}). Send Strict-Transport-Security with max-age of at least 180 days.${tail}`,
    };
  }
  if (CERT[id]) {
    return {
      title: CERT[id],
      detail: `testssl.sh: ${finding}. Fix it with the certificate provider or in the server's certificate settings.${tail}`,
    };
  }
  if (CIPHERS[id]) {
    return {
      title: `The server offers ${CIPHERS[id]}`,
      detail: `The server accepts encryption that is too weak or too old (${finding}). Use Mozilla's "intermediate" settings (ssl-config.mozilla.org) for the web server or CDN.${tail}`,
    };
  }
  if (id in PROTOCOLS) {
    const name = PROTOCOLS[id];
    const offered = /not offered/i.test(finding) ? false : /offered/i.test(finding);
    return offered
      ? {
          title: `The server still allows ${name}`,
          detail: `${name} is old and has known weaknesses (${finding}). Turn it off in the web server, load balancer or CDN; every current browser uses TLS 1.2 or 1.3.${tail}`,
        }
      : {
          title: `The server does not offer ${name}`,
          detail: `${name} is ${finding}. Turning on TLS 1.3 makes connections faster and safer.${tail}`,
        };
  }
  if (id.startsWith("cipherlist_") || id === "RC4" || id === "FS" || id.startsWith("cipher_")) {
    return {
      title: `Weak HTTPS ciphers: ${id.replace(/^cipherlist_/, "").replace(/_/g, " ")} ${finding}`.slice(0, 160),
      detail: `The server accepts encryption that is too weak or too old (${finding}). Use Mozilla's "intermediate" settings (ssl-config.mozilla.org) for the web server.${tail}`,
    };
  }
  if (id.startsWith("cert") || id.startsWith("OCSP") || id === "DNS_CAArecord") {
    return {
      title: `HTTPS certificate: ${id.replace(/^cert_?/, "").replace(/_/g, " ")} ${finding}`.slice(0, 160),
      detail: `testssl.sh found a problem with the HTTPS certificate or how it is served: ${finding}. Fix it with the certificate provider or in the server's certificate settings.${tail}`,
    };
  }
  if (/^[A-Z][A-Z0-9_-]+$/.test(id)) {
    // Named TLS attacks: LUCKY13, ROBOT, BEAST, SWEET32...
    return {
      title: `Possible ${id.replace(/_/g, " ")} weakness: ${finding}`.slice(0, 160),
      detail: `testssl.sh found the server may be open to the ${id} attack on TLS (${finding}). Update the server's TLS library (for example OpenSSL) and remove the ciphers or features the attack needs.${tail}`,
    };
  }
  return {
    title: `HTTPS setup: ${id.replace(/_/g, " ")} ${finding}`.slice(0, 160),
    detail: `testssl.sh reports "${finding}" for ${id}. Update the server's TLS settings.${tail}`,
  };
}

/** Turns testssl.sh's flat JSON into findings. */
export function readTestssl(items: TestsslItem[], pageUrl: string): ToolFinding[] {
  const seen = new Set<string>();
  const out: ToolFinding[] = [];
  for (const item of items) {
    let severity = SEVERITY[item.severity];
    if (!severity || seen.has(item.id) || SKIP.test(item.id)) continue;
    seen.add(item.id);
    // BREACH only applies to pages that echo secrets in compressed answers: usually a false alarm.
    if (item.id === "BREACH" && severity !== "low") severity = "low";
    const { title, detail } = describe(item);
    out.push({
      category: "security",
      rule: `testssl:${item.id}`,
      severity,
      title,
      detail: `${detail} (testssl.sh)`,
      pageUrl,
      evidence: `${item.id}: ${item.finding}`,
      ...(SAME_AS[item.id] ? { sameAs: SAME_AS[item.id] } : {}),
    });
  }
  return out;
}

const isLocal = (host: string) => /^(localhost|127\.|\[::1\]|::1)/.test(host);

/** How long testssl.sh may take: TESTSSL_MINUTES, else 15. */
export function testsslMinutes(): number {
  const n = Number(process.env.TESTSSL_MINUTES || 15);
  return Number.isFinite(n) && n >= 1 ? Math.min(60, n) : 15;
}

export const testsslTool: Tool = {
  id: "testssl",
  name: "TLS check (testssl.sh)",
  maker: "testssl.sh project",
  description: "Checks the HTTPS setup of the server in depth: which TLS versions and ciphers it allows, the certificate, and known TLS attacks.",
  checks: [
    "Old SSL and TLS versions still switched on",
    "Weak ciphers and missing forward secrecy",
    "Certificate chain, expiry, key size and OCSP",
    "Known attacks: Heartbleed, ROBOT, POODLE, SWEET32 and more",
  ],
  products: [...WEB_PRODUCTS, "api"],
  category: "security",
  safety: "safe",
  takes: "1 to 10 minutes",
  licence: "GPL-2.0, free",
  homepage: "https://testssl.sh",
  signedIn: "public",

  async ready() {
    const bin = process.env.TESTSSL_PATH || (await which("testssl")) || (await which("testssl.sh"));
    return bin && (await which(bin)) ? null : "testssl.sh is not installed on this server.";
  },

  async run(ctx: ToolContext): Promise<ToolOutput> {
    const url = new URL(ctx.startUrl);
    if (url.protocol !== "https:") {
      return { findings: [], summary: ["The address does not use HTTPS, so there is no TLS setup to check."], tested: "Nothing to check" };
    }
    const bin = process.env.TESTSSL_PATH || (await which("testssl")) || (await which("testssl.sh"))!;
    const target = `${url.hostname}:${url.port || 443}`;
    const json = path.join(ctx.workDir, "testssl.json");
    const html = path.join(ctx.outDir, "tool-testssl.html");
    const proxy = (process.env.HTTPS_PROXY || process.env.https_proxy) && !isLocal(url.hostname);
    ctx.log(`TLS check: ${target}`);
    const res = await runProcess(
      bin,
      [
        "--quiet",
        "--color",
        "0",
        "--warnings",
        "off",
        "--ip",
        "one",
        "--sneaky",
        "--connect-timeout",
        "10",
        "--openssl-timeout",
        "10",
        "--overwrite",
        "--jsonfile",
        json,
        "--htmlfile",
        html,
        ...(proxy ? ["--proxy", "auto"] : []),
        target,
      ],
      // Seven minutes was too short for some servers (many ciphers, a slow handshake), and a check
      // that stops half way makes its problems look new the next time it finishes.
      { signal: ctx.signal, timeoutMs: testsslMinutes() * 60_000, cwd: ctx.workDir },
    );
    let items: TestsslItem[];
    try {
      items = JSON.parse(await readFile(json, "utf8")) as TestsslItem[];
    } catch {
      throw new Error(`testssl.sh did not finish: ${lastLine(res.stdout + res.stderr) || `exit code ${res.code}`}`);
    }
    const fatal = items.find((i) => i.id === "scanProblem" && i.severity === "FATAL");
    if (fatal) throw new Error(`testssl.sh could not test ${target}: ${fatal.finding}`);
    const findings = readTestssl(items, `${url.origin}/`);
    const offered = Object.entries(PROTOCOLS)
      .filter(([id]) => items.some((i) => i.id === id && /offered/i.test(i.finding) && !/not offered/i.test(i.finding)))
      .map(([, name]) => name);
    const grade = items.find((i) => i.id === "overall_grade")?.finding;
    return {
      findings,
      summary: [
        ...(grade ? [grade === "T" ? "Grade T: the certificate is not trusted" : `Grade ${grade} (A+ is best)`] : []),
        offered.length ? `Allows ${offered.join(", ")}` : "No TLS version information",
        `${findings.length} problem${findings.length === 1 ? "" : "s"} rated low or worse`,
      ],
      reports: [{ file: "tool-testssl.html", label: "testssl.sh report" }],
      tested: `Tested ${target}`,
    };
  },
};
