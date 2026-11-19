import { createHash, createHmac } from "node:crypto";
import { finding } from "../../runner/finding.js";
import type { Finding } from "../../types.js";
import type { ApiCall } from "./context.js";
import type { ApiAgent } from "./shared.js";

/*
 * Checks of the API's login token, like Burp's JWT Editor and 42Crunch: what the saved token
 * holds (signing, end time, data inside), whether its signing key is a well-known one, and
 * whether the API still accepts it after its signature is changed or removed. Only GET calls.
 */

const JWT = /^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]*$/;

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  const [h, p] = token.split(".");
  try {
    return { header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")), payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) };
  } catch {
    return undefined;
  }
}

/** Signing keys found in tutorials, sample apps and default settings. */
export const WEAK_SECRETS = [
  "secret",
  "secretkey",
  "secret_key",
  "jwt_secret",
  "jwtsecret",
  "jwt-secret",
  "your-256-bit-secret",
  "your_jwt_secret",
  "your-secret-key",
  "changeme",
  "change_me",
  "password",
  "123456",
  "12345678",
  "admin",
  "test",
  "key",
  "mysecret",
  "supersecret",
  "s3cr3t",
  "default",
  "development",
  "shhhhh",
  "keyboard cat",
  "hello",
  "token",
  "qwerty",
];

/** The weak key that signed this HS256/384/512 token, if any. */
export function weakSecret(token: string): string | undefined {
  const [h, p, sig] = token.split(".");
  const jwt = decodeJwt(token);
  const alg = String(jwt?.header.alg ?? "");
  const hash = { HS256: "sha256", HS384: "sha384", HS512: "sha512" }[alg];
  if (!hash || !sig) return undefined;
  for (const s of WEAK_SECRETS) {
    if (createHmac(hash, s).update(`${h}.${p}`).digest("base64url") === sig) return s;
  }
  return undefined;
}

const name = (t: string) => `token ${createHash("sha256").update(t).digest("hex").slice(0, 8)}`;
const good = (c: ApiCall) => c.status !== null && c.status >= 200 && c.status < 300;

export const apiTokensAgent: ApiAgent = {
  engine: "api",
  products: ["api"],
  id: "api.tokens",
  name: "Login token checks",
  description:
    "Reads the saved token when it is a JWT: no signing, no end time, a very long life, secrets inside, and a signing key from a list of well-known ones. Then calls an endpoint that needs a login with the token's signature changed, and with no signature, to check the API refuses both. Keys sent in the address are flagged too.",
  category: "security",
  async run({ token, login, calls, send, specUrl }) {
    const out: Finding[] = [];
    if (login?.authType === "query") {
      out.push(
        finding({
          category: "security",
          rule: "api:key-in-address",
          severity: "low",
          title: "The API key goes in the address",
          detail: `The key is sent as ?${login.paramName}=... Addresses are kept in server and proxy logs and browser history, so the key leaks. Accept it in a header (X-API-Key) instead.`,
          pageUrl: specUrl,
          evidence: `query parameter ${login.paramName}`,
        }),
      );
    }
    if (!token || !JWT.test(token)) return out;
    const jwt = decodeJwt(token);
    if (!jwt) return out;
    const t = name(token);
    const alg = String(jwt.header.alg ?? "");
    const add = (rule: string, severity: Finding["severity"], title: string, detail: string, evidence: string) =>
      out.push(finding({ category: "security", rule, severity, title, detail, pageUrl: specUrl, evidence }));
    if (/^none$/i.test(alg) || !token.split(".")[2]) {
      add("api:jwt-not-signed", "critical", "The API's login token (JWT) is not signed", "Anyone can write a token with any user id or role. Sign tokens (RS256, or HS256 with a long random key) and refuse alg none.", `${t}: alg ${alg || "missing"}`);
    }
    const now = Date.now() / 1000;
    const exp = Number(jwt.payload.exp);
    const iat = Number(jwt.payload.iat) || now;
    if (!exp) {
      add("api:jwt-no-expiry", "medium", "The API's login token (JWT) never ends", "A copied token works forever, even after a password change. Give access tokens a short life (15 to 60 minutes) and renew them with a refresh token.", `${t}: no exp`);
    } else if (exp - Math.min(iat, now) > 30 * 86400) {
      add("api:jwt-long-life", "low", "The API's login token (JWT) lasts more than 30 days", "A copied token keeps working that long. Keep access tokens short and use a refresh token that the server can revoke.", `${t}: more than 30 days`);
    }
    const secretClaims = Object.keys(jwt.payload).filter((k) => /pass|pwd|secret|aadhaar|aadhar|pan_?(no|number)|ssn|card|cvv|otp/i.test(k)).sort();
    if (secretClaims.length) {
      add("api:jwt-secret-claims", "high", "The API's login token carries secret data", `A JWT is only encoded, not encrypted: anyone holding it can read ${secretClaims.join(", ")}. Keep only the user id and role in it.`, `${t}: ${secretClaims.join(", ")}`);
    }
    const weak = weakSecret(token);
    if (weak) {
      add(
        "api:jwt-weak-key",
        "critical",
        "The API's tokens are signed with a well-known key",
        `The token's signature checks out with a key from public sample code ("${weak.slice(0, 2)}..."). Anyone can make tokens for any user or role. Use a long random key (32 bytes or more) kept in the server's secrets, and change it now: every token signed with the old key must stop working.`,
        `${t}: ${alg} with a key from the common-keys list`,
      );
    }

    // Does the API check the signature at all? Change it, then remove it.
    const target = calls.find((c) => c.op.secured && good(c));
    if (!target) return out;
    const [h, p, sig] = token.split(".");
    const flipped = sig ? `${h}.${p}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}` : `${h}.${p}.AAAA`;
    const none = `${Buffer.from(JSON.stringify({ ...jwt.header, alg: "none" })).toString("base64url")}.${p}.`;
    const anon = await send({ url: target.url ?? target.op.url, as: false }, target.op);
    // When the endpoint answers strangers anyway, a forged token proves nothing.
    if (good(anon)) return out;
    for (const [forged, what] of [
      [flipped, "its signature changed"],
      [none, 'alg set to "none" and no signature'],
    ] as const) {
      const c = await send({ url: target.url ?? target.op.url, as: false, headers: { authorization: `Bearer ${forged}` } }, target.op);
      if (good(c)) {
        out.push(
          finding({
            category: "security",
            rule: "api:jwt-forged-accepted",
            severity: "critical",
            title: "The API accepts login tokens it did not sign",
            detail: `GET ${target.op.path} answered ${c.status} to the saved token with ${what}. Anyone can make a token for any user (or admin) and the API will believe it. Verify the signature on every request with a fixed algorithm list (never "none"), using your JWT library's verify function, not decode.`,
            pageUrl: target.op.url,
            evidence: `Token with ${what} -> HTTP ${c.status}`,
          }),
        );
        break;
      }
    }
    return out;
  },
};
