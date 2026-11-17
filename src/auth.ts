import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { UserStore } from "./store.js";
import type { Role, User } from "./types.js";

const COOKIE = "glv_session";
const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(expected, actual);
}

export function checkPasswordRules(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters for the password.";
  return null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Simple per-address limit on failed logins: 10 tries per 15 minutes. */
const failures = new Map<string, { n: number; until: number }>();
export function tooManyFailures(ip: string): boolean {
  const f = failures.get(ip);
  return Boolean(f && f.until > Date.now() && f.n >= 10);
}
export function recordFailure(ip: string): void {
  const f = failures.get(ip);
  if (!f || f.until < Date.now()) failures.set(ip, { n: 1, until: Date.now() + 15 * 60_000 });
  else f.n++;
}

export class Auth {
  constructor(private users: UserStore) {}

  setupNeeded(): boolean {
    return this.users.count() === 0;
  }

  createUser(input: { email: string; name: string; role: Role; password: string }): User {
    const user: User = {
      id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name.trim() || input.email,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    this.users.create(user, hashPassword(input.password));
    return user;
  }

  /** Creates the owner from OWNER_EMAIL / OWNER_PASSWORD on first start, for servers set up without a browser. */
  bootstrapFromEnv(): void {
    const email = process.env.OWNER_EMAIL;
    const password = process.env.OWNER_PASSWORD;
    if (this.setupNeeded() && email && password) {
      this.createUser({ email, name: "Owner", role: "owner", password });
    }
  }

  login(email: string, password: string): User | undefined {
    const u = this.users.byEmail(email.trim());
    if (!u || !verifyPassword(password, u.passwordHash)) return undefined;
    const { passwordHash: _, ...user } = u;
    return user;
  }

  startSession(reply: FastifyReply, req: FastifyRequest, user: User): void {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000);
    this.users.createSession(sha256(token), user.id, expires.toISOString());
    const secure = req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
    reply.header(
      "set-cookie",
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure ? "; Secure" : ""}`,
    );
  }

  endSession(reply: FastifyReply, req: FastifyRequest): void {
    const token = readCookie(req, COOKIE);
    if (token) this.users.deleteSession(sha256(token));
    reply.header("set-cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  userFor(req: FastifyRequest): User | undefined {
    const token = readCookie(req, COOKIE);
    return token ? this.users.sessionUser(sha256(token)) : undefined;
  }
}
