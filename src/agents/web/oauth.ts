import { X509Certificate } from "node:crypto";
import { finding } from "../../runner/finding.js";
import { WEB_PRODUCTS } from "../../products.js";
import type { Finding, Severity } from "../../types.js";
import type { SiteAgent, SiteContext } from "../types.js";
import { getText } from "./geo.js";

/**
 * Sign-in with OAuth 2.0, OpenID Connect and SAML, read like a visitor: the site's own discovery
 * document (/.well-known/openid-configuration), the "Sign in with…" links on its pages (state, PKCE,
 * implicit flow, redirect over http), and SAML metadata (signing, certificate dates). Nothing is
 * signed in to and no request goes to Google or another identity provider; links are only read.
 */

export type Problem = [rule: string, severity: Severity, title: string, detail: string];

/** Problems in an OpenID / OAuth discovery document. Pure, for tests. */
export function oidcProblems(doc: Record<string, unknown>): Problem[] {
  const out: Problem[] = [];
  const list = (k: string) => (Array.isArray(doc[k]) ? (doc[k] as unknown[]).map(String) : []);
  const types = list("response_types_supported");
  if (types.some((t) => t.split(" ").includes("token")))
    out.push(["oauth:implicit-flow", "medium", "The sign-in server still allows the implicit flow", "response_type=token puts access tokens in the address bar, browser history and logs. OAuth 2.1 and the OAuth security BCP (RFC 9700) drop it: allow only the code flow with PKCE."]);
  const pkce = list("code_challenge_methods_supported");
  if (!pkce.length) out.push(["oauth:no-pkce", "medium", "The sign-in server does not say it supports PKCE", "Without PKCE (code_challenge_methods_supported: S256), a stolen authorization code can be swapped for tokens. Turn on PKCE and require it for public clients (mobile apps, single-page apps)."]);
  else if (pkce.includes("plain") && !pkce.includes("S256")) out.push(["oauth:pkce-plain", "medium", "PKCE only in plain form", "Plain PKCE sends the secret itself; support and require S256."]);
  for (const k of ["authorization_endpoint", "token_endpoint", "userinfo_endpoint", "jwks_uri"]) {
    const v = String(doc[k] ?? "");
    if (v.startsWith("http://") && !/^http:\/\/(localhost|127\.)/.test(v)) out.push(["oauth:endpoint-http", "high", `${k.replace(/_/g, " ")} is plain http`, `${v} sends codes and tokens unencrypted. Serve every sign-in endpoint over HTTPS.`]);
  }
  const algs = list("id_token_signing_alg_values_supported");
  if (algs.includes("none")) out.push(["oauth:alg-none", "critical", 'ID tokens may be unsigned (alg "none")', "Anyone can make an ID token the server accepts. Remove none from the allowed algorithms."]);
  if (list("token_endpoint_auth_methods_supported").includes("none") && !pkce.includes("S256"))
    out.push(["oauth:public-client-no-pkce", "high", "Public clients without PKCE", "Clients without a secret can use the token endpoint, and PKCE (S256) is not offered, so intercepted codes can be used by anyone."]);
  return out;
}

/** Problems in a "Sign in with…" link. Pure, for tests. */
export function authorizeLinkProblems(link: string): Problem[] {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return [];
  }
  const p = u.searchParams;
  if (!p.get("client_id") || !p.get("response_type")) return [];
  const out: Problem[] = [];
  const rt = (p.get("response_type") ?? "").split(" ");
  if (rt.includes("token")) out.push(["oauth:implicit-flow", "medium", "Sign-in link uses the implicit flow", `The link asks for response_type=${p.get("response_type")}: the access token comes back in the address. Use response_type=code with PKCE.`]);
  if (!p.get("state") && !p.get("nonce")) out.push(["oauth:no-state", "medium", "Sign-in link has no state value", "Without a random state (checked on return), an attacker can sign a victim in to the attacker's account (login CSRF). Add a random state per sign-in and check it in the callback."]);
  if (rt.includes("code") && !p.get("code_challenge")) out.push(["oauth:link-no-pkce", "low", "Sign-in link without PKCE", "The link asks for a code without code_challenge. Add PKCE (S256) so an intercepted code is useless."]);
  const redirect = p.get("redirect_uri") ?? "";
  if (redirect.startsWith("http://") && !/^http:\/\/(localhost|127\.)/.test(redirect)) out.push(["oauth:redirect-http", "high", "Sign-in returns to a plain http address", `redirect_uri ${redirect} sends the code unencrypted. Use https.`]);
  return out;
}

/** Problems in SAML metadata. Pure, for tests. */
export function samlProblems(xml: string, now = new Date()): Problem[] {
  const out: Problem[] = [];
  if (/WantAssertionsSigned="false"/i.test(xml)) out.push(["saml:assertions-unsigned", "high", "SAML does not require signed assertions", "WantAssertionsSigned is false, so a changed assertion may be accepted (signature-wrapping attacks). Require signed assertions and validate the signature on the assertion itself."]);
  if (/AuthnRequestsSigned="false"/i.test(xml) && /<(md:)?SPSSODescriptor/i.test(xml)) out.push(["saml:requests-unsigned", "low", "SAML sign-in requests are not signed", "Signing AuthnRequests stops tampered requests; turn it on where the identity provider supports it."]);
  for (const m of xml.matchAll(/<(?:ds:)?X509Certificate>\s*([A-Za-z0-9+/=\s]+?)\s*<\/(?:ds:)?X509Certificate>/g)) {
    try {
      const cert = new X509Certificate(Buffer.from(m[1].replace(/\s+/g, ""), "base64"));
      const ends = new Date(cert.validTo);
      if (ends < now) out.push(["saml:cert-expired", "high", "The SAML signing certificate has expired", `It ended on ${ends.toDateString()}. Sign-ins will fail with strict identity providers; publish a new certificate.`]);
      else if (ends.getTime() - now.getTime() < 30 * 86_400_000) out.push(["saml:cert-expiring", "medium", "The SAML signing certificate ends within 30 days", `It ends on ${ends.toDateString()}. Roll over to a new certificate now and publish both during the change.`]);
      if (/sha1WithRSA/i.test(cert.toString()) || /sha1/i.test((cert as unknown as { signatureAlgorithm?: string }).signatureAlgorithm ?? "")) out.push(["saml:sha1", "medium", "The SAML certificate is signed with SHA-1", "SHA-1 is broken; issue a SHA-256 certificate."]);
    } catch {
      // not a certificate we can read
    }
    break;
  }
  if (/SignatureMethod Algorithm="[^"]*rsa-sha1"/i.test(xml)) out.push(["saml:sha1", "medium", "SAML signatures use SHA-1", "Use rsa-sha256 for SAML signatures."]);
  return out;
}

const SAML_PATHS = ["/saml/metadata", "/saml2/metadata", "/Saml2/metadata", "/sso/saml/metadata", "/auth/saml/metadata", "/simplesaml/module.php/saml/sp/metadata.php/default-sp", "/saml/metadata.xml"];

async function oauthFindings({ browser, origin, linkSources, pageLinks, log }: SiteContext): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const path of ["/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) {
    const got = await getText(browser.request, `${origin}${path}`);
    if (!got || got.status !== 200 || !/json/.test(got.type)) continue;
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(got.text) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const [rule, severity, title, detail] of oidcProblems(doc)) out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: `${origin}${path}`, evidence: got.text.slice(0, 400) }));
    log(`OAuth: read ${path}`);
    break;
  }
  const links = new Set<string>([...linkSources.keys()].filter((l) => /client_id=/.test(l) && /response_type=/.test(l)));
  for (const ls of pageLinks.values()) for (const l of ls) if (/client_id=/.test(l) && /response_type=/.test(l)) links.add(l);
  const seen = new Set<string>();
  for (const link of [...links].slice(0, 20)) {
    for (const [rule, severity, title, detail] of authorizeLinkProblems(link)) {
      const key = `${rule}:${new URL(link).host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: linkSources.get(link) ?? origin, evidence: link.slice(0, 400) }));
    }
  }
  for (const path of SAML_PATHS) {
    const got = await getText(browser.request, `${origin}${path}`);
    if (!got || got.status !== 200 || !/EntityDescriptor/.test(got.text)) continue;
    for (const [rule, severity, title, detail] of samlProblems(got.text)) out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: `${origin}${path}`, evidence: got.text.slice(0, 300) }));
    log(`SAML: read ${path}`);
    break;
  }
  return out;
}

export const oauthAgent: SiteAgent = {
  id: "sec.oauth",
  name: "OAuth, OpenID and SAML sign-in",
  description: "Reads the site's OpenID / OAuth discovery document, its \"Sign in with…\" links and SAML metadata: implicit flow, missing state or PKCE, http redirects, unsigned tokens or assertions, expiring SAML certificates. Nothing is signed in to.",
  category: "security",
  engine: "web",
  products: WEB_PRODUCTS,
  stage: "site",
  run: oauthFindings,
};
