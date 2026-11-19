import { createHmac } from "node:crypto";

/**
 * One-time codes for two-step sign-in, made the same way as Google Authenticator and other
 * authenticator apps (RFC 6238, TOTP): from the secret under the QR code and the current time.
 * Our own code, so test accounts with two-step verification work without any outside service.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Reads a base32 secret ("JBSW Y3DP EHPK 3PXP"), spaces, dashes and lower case allowed. */
export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!clean) throw new Error("The two-step secret is empty.");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error("The two-step secret has letters that are not allowed (only A to Z and 2 to 7). Copy the text shown under the QR code.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A secret may be pasted as the otpauth:// address from the QR code: take its secret, digits and period. */
export function parseSecret(input: string): { secret: Buffer; digits: number; period: number; algorithm: "sha1" | "sha256" | "sha512" } {
  const raw = input.trim();
  if (/^otpauth:\/\//i.test(raw)) {
    const u = new URL(raw);
    const algo = (u.searchParams.get("algorithm") ?? "SHA1").toLowerCase();
    return {
      secret: base32Decode(u.searchParams.get("secret") ?? ""),
      digits: Number(u.searchParams.get("digits")) || 6,
      period: Number(u.searchParams.get("period")) || 30,
      algorithm: algo === "sha256" || algo === "sha512" ? algo : "sha1",
    };
  }
  return { secret: base32Decode(raw), digits: 6, period: 30, algorithm: "sha1" };
}

export function hotp(secret: Buffer, counter: number, digits = 6, algorithm: "sha1" | "sha256" | "sha512" = "sha1"): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(msg).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[off] & 0x7f) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** The code an authenticator app would show now. */
export function totp(input: string, at = Date.now()): string {
  const s = parseSecret(input);
  return hotp(s.secret, Math.floor(at / 1000 / s.period), s.digits, s.algorithm);
}

/** Seconds until the code changes; a code about to change is not worth typing. */
export function secondsLeft(input: string, at = Date.now()): number {
  const { period } = parseSecret(input);
  return period - (Math.floor(at / 1000) % period);
}

/** The one-time code in an email: the first group of 4 to 8 digits near words like "code" or "OTP". */
export function codeInEmail(text: string): string | undefined {
  const near = text.match(/(?:code|otp|one[- ]time|verification|passcode|pin)[^0-9]{0,40}(\d{4,8})\b/i);
  if (near) return near[1];
  return text.match(/\b(\d{6})\b/)?.[1];
}
