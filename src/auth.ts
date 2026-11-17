import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
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

/**
 * AUTH_DISABLED=1 turns login off while GLV is still building and testing the system on its own
 * computers: no owner account, no sign-in, everyone is the owner. Never use it on a server.
 */
export function loginTurnedOff(): boolean {
  return process.env.AUTH_DISABLED === "1";
}

/** This computer or its local network, including Docker's own network between the host and the container. */
export function isLocalAddress(raw: string | undefined): boolean {
  let ip = String(raw ?? "").trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (isIPv6(ip)) return ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  return false;
}

/** True when the visit, or any proxy it passed through, comes from outside this computer and its local network. */
export function fromOutside(req: FastifyRequest): boolean {
  const forwarded = [req.headers["x-forwarded-for"], req.headers["x-real-ip"]]
    .flat()
    .filter(Boolean)
    .flatMap((h) => String(h).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  return !isLocalAddress(req.ip) || forwarded.some((ip) => !isLocalAddress(ip));
}

/** Stands in for the owner while login is off and no owner account has been made yet. */
const LOCAL_OWNER: User = { id: "local-owner", email: "owner@localhost", name: "Owner", role: "owner", createdAt: "2026-01-01T00:00:00.000Z" };

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

  /** Who uses the dashboard while login is off: the first owner account if one exists, otherwise a stand-in owner. */
  localOwner(): User {
    return this.users.list().find((u) => u.role === "owner") ?? LOCAL_OWNER;
  }

  userFor(req: FastifyRequest): User | undefined {
    const token = readCookie(req, COOKIE);
    return token ? this.users.sessionUser(sha256(token)) : undefined;
  }
}
