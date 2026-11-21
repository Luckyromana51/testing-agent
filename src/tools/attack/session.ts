import { createHmac, timingSafeEqual } from "node:crypto";
import type { AttackFinding, Family, FamilyContext } from "./types.js";

/** Common weak signing secrets, so a token signed with one can be shown to be forgeable. */
const WEAK_SECRETS = [
  "secret",
  "secretkey",
  "secret_key",
  "password",
  "changeme",
  "change_me",
  "jwt",
  "jwtsecret",
  "jwt_secret",
  "key",
  "private",
  "token",
  "admin",
  "test",
  "123456",
  "0000",
  "qwerty",
  "your-256-bit-secret",
  "your_jwt_secret",
  "supersecret",
  "default",
  "example",
];

const b64urlToBuf = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
const b64url = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export interface JwtReport {
  severity: AttackFinding["severity"];
  title: string;
  reason: string;
  fix: string;
}

/** A string that looks like a JSON Web Token (three base64url parts). */
export const JWT_RE = /\b(ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{0,})\b/g;

/** Finds the JWTs in a cookie header (and anywhere else token-like text appears). */
export function findJwts(text: string | undefined): string[] {
  if (!text) return [];
  return [...new Set((text.match(JWT_RE) ?? []).filter((t) => t.split(".").length === 3))];
}

/**
 * Reads a token offline and reports the ways it is unsafe: not signed at all ("alg": "none"),
 * signed with a guessable secret (so anyone can forge one), or never expiring. Nothing is sent to
 * the site: a forged token is never used, only shown to be possible.
 */
export function analyzeJwt(token: string, now = Date.now()): JwtReport[] {
  const parts = token.split(".");
  if (parts.length !== 3) return [];
  let header: { alg?: string; typ?: string };
  let payload: { exp?: number; iat?: number; [k: string]: unknown };
  try {
    header = JSON.parse(b64urlToBuf(parts[0]).toString("utf8")) as typeof header;
    payload = JSON.parse(b64urlToBuf(parts[1]).toString("utf8")) as typeof payload;
  } catch {
    return [];
  }
  if (!header || typeof header.alg !== "string") return [];
  const out: JwtReport[] = [];
  const alg = header.alg.toLowerCase();

  if (alg === "none") {
    out.push({
      severity: "critical",
      title: "Session token is not signed (JWT alg \"none\")",
      reason: "The session token says it is signed with \"none\": it carries no signature, so anyone can write a token for any user, including an admin.",
      fix: "Sign tokens with a strong algorithm (RS256, or HS256 with a long random secret), and refuse any token whose alg is \"none\" or does not match what you expect.",
    });
  } else if (alg.startsWith("hs")) {
    const signed = `${parts[0]}.${parts[1]}`;
    const want = b64urlToBuf(parts[2]);
    const bits = alg === "hs384" ? "sha384" : alg === "hs512" ? "sha512" : "sha256";
    const weak = WEAK_SECRETS.find((s) => {
      const got = createHmac(bits, s).update(signed).digest();
      return got.length === want.length && timingSafeEqual(got, want);
    });
    if (weak) {
      out.push({
        severity: "critical",
        title: "Session token is signed with a guessable secret",
        reason: `The token is signed with the secret "${weak}", a common default. Anyone who guesses it (as this check did) can forge a token for any user.`,
        fix: "Change the signing secret to a long random value kept out of the code, and rotate it; every existing token becomes invalid, which is the point.",
      });
    }
  }

  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  if (exp === undefined && alg !== "none") {
    out.push({
      severity: "medium",
      title: "Session token never expires (no \"exp\")",
      reason: "The token has no expiry, so a token that leaks (in a log, a shared computer, a proxy) works forever.",
      fix: "Add a short expiry (exp) to tokens and a way to revoke them (a server-side session id or a token version).",
    });
  } else if (exp !== undefined) {
    const life = exp * 1000 - now;
    if (life > 400 * 86_400_000) {
      out.push({
        severity: "low",
        title: "Session token lasts far too long",
        reason: `The token expires in about ${Math.round(life / 86_400_000)} days, so a leaked token stays useful for a long time.`,
        fix: "Shorten the expiry to hours or days and use a refresh token for longer sessions.",
      });
    }
  }
  return out;
}

export { b64url };

export const sessionFamily: Family = {
  id: "jwt",
  label: "Session token (JWT) weaknesses",
  hint: "The signed-in token is read offline: unsigned tokens, guessable secrets, and tokens that never expire. Nothing is sent to the site.",
  async run(fc: FamilyContext): Promise<AttackFinding[]> {
    const { surface, ctx, log } = fc;
    if (!surface.signedIn) return [];
    const tokens = findJwts(ctx.cookie);
    const found: AttackFinding[] = [];
    const seenReasons = new Set<string>();
    const startPage = surface.pages[0] ?? ctx.startUrl;
    for (const token of tokens) {
      for (const r of analyzeJwt(token)) {
        if (seenReasons.has(r.title)) continue;
        seenReasons.add(r.title);
        found.push({
          rule: `attack:jwt`,
          severity: r.severity,
          tag: "injection",
          title: r.title,
          detail: `${r.reason} (CWE-347/CWE-613). How to reproduce: read the session cookie's JWT and check its header and signature offline. How to fix: ${r.fix}`,
          pageUrl: startPage,
          evidence: `JWT header/payload: ${token.split(".").slice(0, 2).map((p) => decode(p)).join(" · ")}`,
          key: `jwt:${r.title}`,
        });
      }
    }
    if (found.length) log(`Session token: ${found.length} finding${found.length === 1 ? "" : "s"}`);
    return found;
  },
};

const decode = (part: string) => {
  try {
    return b64urlToBuf(part).toString("utf8").slice(0, 200);
  } catch {
    return part.slice(0, 40);
  }
};
