import { createHash } from "node:crypto";
import type { Browser, BrowserContext, Cookie } from "playwright";
import type { PageAgent, SiteAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { LoginError, signIn } from "../runner/login.js";
import type { Finding, Login } from "../types.js";
import { APPS } from "./calls.js";

/**
 * Session safety, the checks Burp Suite, ZAP and Invicti run on signed-in apps: a new session after
 * signing in, signing out really ending the session, very long sessions, login tokens readable by
 * scripts, weak JWTs, forms without CSRF protection, sign-in messages that tell whether an account
 * exists, and ID numbers shown in full. Each check that signs in uses its own fresh browser, so the
 * main test's session is never touched.
 */

const SESSION_COOKIE = /sess|sid|auth|token|jwt|login|remember|connect\.sid|PHPSESSID|JSESSIONID|ASP\.NET_SessionId|\.AspNetCore|laravel_session|_session$|wordpress_logged_in|MoodleSession/i;
const LOGOUT_SELECTORS = [
  'a[href*="logout" i]',
  'a[href*="log-out" i]',
  'a[href*="signout" i]',
  'a[href*="sign-out" i]',
  'a[href*="logoff" i]',
  'button:has-text("Log out")',
  'button:has-text("Logout")',
  'button:has-text("Sign out")',
  '[role=menuitem]:has-text("Log out")',
  '[role=menuitem]:has-text("Sign out")',
  'a:has-text("Log out")',
  'a:has-text("Logout")',
  'a:has-text("Sign out")',
];
const USER_MENU = '[aria-label*="account" i], [aria-label*="profile" i], [aria-label*="user" i], .user-menu, .avatar, [data-toggle=dropdown], [data-bs-toggle=dropdown], .dropdown-toggle';

async function freshContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1366, height: 900 } });
}

const sessionCookies = (list: Cookie[]) => list.filter((c) => SESSION_COOKIE.test(c.name));

export const sessionAgent: SiteAgent = {
  id: "app.session",
  name: "Session safety",
  description:
    "Signs in again in its own browser to check the session: a new session id after signing in (no session fixation), signing out really ends the session on the server, and sessions do not last for weeks.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, log }) {
    const real = browser.browser();
    const login = site.login;
    if (!real || !login?.loginUrl) return [];
    const out: Finding[] = [];
    const ctx = await freshContext(real);
    try {
      const page = await ctx.newPage();
      await page.goto(login.loginUrl, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
      const before = sessionCookies(await ctx.cookies());
      await page.close();
      const landed = await signIn(ctx, login, log, { mailUrl: site.mailUrl, signal: site.signal });
      const after = sessionCookies(await ctx.cookies());
      const kept = after.filter((a) => before.some((b) => b.name === a.name && b.value === a.value && b.domain === a.domain));
      if (kept.length && before.length) {
        out.push(
          finding({
            category: "security",
            rule: "app:session-fixation",
            severity: "high",
            title: "The session id stays the same after signing in",
            detail: `The cookie ${kept.map((c) => c.name).join(", ")} has the same value before and after signing in. Someone who plants a session id in a user's browser (on a shared computer, or through a link) is signed in as that user once they log in. Make a new session id when the user signs in (session_regenerate_id, request.session.cycle_key(), req.session.regenerate).`,
            pageUrl: login.loginUrl,
            evidence: `Same value before and after sign-in: ${kept.map((c) => c.name).join(", ")}`,
            agent: "app.session",
          }),
        );
      }
      const now = Date.now() / 1000;
      const long = after.filter((c) => c.expires > 0 && c.expires - now > 30 * 86400);
      if (long.length) {
        const days = Math.round((Math.max(...long.map((c) => c.expires)) - now) / 86400);
        out.push(
          finding({
            category: "security",
            rule: "app:long-session",
            severity: days > 365 ? "medium" : "low",
            title: `Signed-in sessions last ${days} days`,
            detail: `The session cookie ${long.map((c) => c.name).join(", ")} keeps the user signed in for ${days} days. On a shared or lost computer the account stays open that long. For a business system, end sessions after a few hours without use, and keep "remember me" short (14 to 30 days) and optional.`,
            pageUrl: landed.landedUrl,
            evidence: long.map((c) => `${c.name}: ${Math.round((c.expires - now) / 86400)} days`).join("\n"),
            agent: "app.session",
          }),
        );
      }

      // Sign out in this browser, then try the old cookies in another one.
      const saved = await ctx.cookies();
      const p = await ctx.newPage();
      await p.goto(landed.landedUrl, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
      let clicked = false;
      for (const attempt of [0, 1]) {
        if (attempt === 1) await p.locator(USER_MENU).first().click({ timeout: 2_000 }).catch(() => {});
        for (const sel of LOGOUT_SELECTORS) {
          const el = p.locator(sel).first();
          if (await el.isVisible().catch(() => false)) {
            clicked = await el.click({ timeout: 5_000 }).then(() => true, () => false);
            if (clicked) break;
          }
        }
        if (clicked) break;
      }
      if (!clicked) {
        log("Session safety: no sign-out link or button found, so signing out was not checked");
        return out;
      }
      await p.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
      await p.waitForTimeout(1_000);
      const replay = await freshContext(real);
      try {
        await replay.addCookies(saved);
        const q = await replay.newPage();
        const res = await q.goto(landed.landedUrl, { waitUntil: "load", timeout: 20_000 }).catch(() => null);
        const loginPath = new URL(login.loginUrl).pathname;
        const stillIn =
          res &&
          res.status() < 400 &&
          new URL(q.url()).pathname !== loginPath &&
          !(await q.locator('input[type="password"]').first().isVisible().catch(() => false)) &&
          (!login.successText || (await q.getByText(login.successText).first().isVisible().catch(() => false)));
        if (stillIn) {
          out.push(
            finding({
              category: "security",
              rule: "app:logout-keeps-session",
              severity: "high",
              title: "Signing out does not end the session on the server",
              detail: `After signing out, the old session cookie still opens ${landed.landedUrl} signed in. Anyone who copied the cookie (a shared computer, malware, a log) stays signed in after the user leaves. On sign-out, delete the session on the server (session.invalidate(), Auth::logout() with session()->invalidate(), req.session.destroy()), and revoke tokens.`,
              pageUrl: landed.landedUrl,
              evidence: "Old cookies after sign-out: still signed in",
              agent: "app.session",
            }),
          );
        }
      } finally {
        await replay.close().catch(() => {});
      }
    } catch (err) {
      if (err instanceof LoginError) log(`Session safety: could not sign in again (${err.message})`);
      else throw err;
    } finally {
      await ctx.close().catch(() => {});
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

const JWT = /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]*/g;

function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | undefined {
  const [h, p] = token.split(".");
  try {
    return { header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")), payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) };
  } catch {
    return undefined;
  }
}

/** A short, stable name for a token in evidence: never the token itself. */
const tokenName = (t: string) => `token ${createHash("sha256").update(t).digest("hex").slice(0, 8)}`;

export const tokensAgent: SiteAgent = {
  id: "app.tokens",
  name: "Login tokens and JWTs",
  description:
    "Looks for login tokens kept where any script can read them (localStorage, sessionStorage, cookies without HttpOnly), and checks every JWT the app uses: no signing (alg none), no end date, very long life, and passwords or ID numbers inside.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  async run({ browser, pages, site }) {
    const first = pages.find((p) => !p.error && (p.status ?? 0) < 400);
    if (!first) return [];
    const out: Finding[] = [];
    const page = await browser.newPage();
    let storage: { where: string; key: string; value: string }[] = [];
    try {
      await page.goto(first.url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
      storage = (await page
        .evaluate(() => {
          const items: { where: string; key: string; value: string }[] = [];
          for (const [where, s] of [
            ["localStorage", window.localStorage],
            ["sessionStorage", window.sessionStorage],
          ] as const) {
            try {
              for (let i = 0; i < s.length; i++) {
                const key = s.key(i) ?? "";
                items.push({ where, key, value: (s.getItem(key) ?? "").slice(0, 5000) });
              }
            } catch {
              /* blocked */
            }
          }
          return items;
        })
        .catch(() => [])) as { where: string; key: string; value: string }[];
    } finally {
      await page.close().catch(() => {});
    }
    const inStorage = storage.filter((s) => JWT.test(s.value) || (/token|jwt|auth|session|bearer/i.test(s.key) && s.value.length >= 20));
    JWT.lastIndex = 0;
    if (inStorage.length) {
      out.push(
        finding({
          category: "security",
          rule: "app:token-in-storage",
          severity: "medium",
          title: "The login token is kept where any script can read it",
          detail: `The app keeps its login token in ${[...new Set(inStorage.map((s) => s.where))].join(" and ")} (${inStorage.map((s) => s.key).slice(0, 4).join(", ")}). One bad script on any screen (an XSS hole, a hacked library) can copy it and use the account from anywhere. Keep the session in an HttpOnly, Secure, SameSite cookie instead, or keep tokens short-lived with a refresh cookie.`,
          pageUrl: first.url,
          evidence: inStorage.map((s) => `${s.where}: ${s.key}`).slice(0, 6).join("\n"),
          agent: "app.tokens",
        }),
      );
    }
    // Every JWT the app uses: in storage, in cookies, and in the login header of its calls.
    const cookies = await browser.cookies().catch(() => []);
    const tokens = new Set<string>();
    const add = (text: string) => {
      for (const m of text.match(JWT) ?? []) tokens.add(m);
    };
    for (const s of storage) add(s.value);
    for (const c of cookies) add(c.value);
    for (const c of site.calls ?? []) for (const v of Object.values(c.auth ?? {})) add(v);
    const now = Date.now() / 1000;
    for (const t of [...tokens].slice(0, 10)) {
      const jwt = decodeJwt(t);
      if (!jwt) continue;
      const alg = String(jwt.header.alg ?? "").toLowerCase();
      const exp = Number(jwt.payload.exp);
      const iat = Number(jwt.payload.iat) || now;
      const name = tokenName(t);
      if (alg === "none" || !t.split(".")[2]) {
        out.push(
          finding({
            category: "security",
            rule: "app:jwt-not-signed",
            severity: "critical",
            title: "The app's login token (JWT) is not signed",
            detail: "The token says alg none (or has no signature). Anyone can write their own token, with any user id or role, and the server may accept it. Sign tokens (RS256 or HS256 with a long secret) and refuse alg none on the server.",
            pageUrl: first.url,
            evidence: `${name}: alg ${alg || "missing"}`,
            agent: "app.tokens",
          }),
        );
      }
      if (!exp) {
        out.push(
          finding({
            category: "security",
            rule: "app:jwt-no-expiry",
            severity: "medium",
            title: "The app's login token (JWT) never ends",
            detail: "The token has no exp (end time), so a copied token works forever, even after the user changes their password. Give tokens a short life (15 to 60 minutes) and renew them with a refresh token.",
            pageUrl: first.url,
            evidence: `${name}: no exp`,
            agent: "app.tokens",
          }),
        );
      } else if (exp - Math.min(iat, now) > 30 * 86400) {
        out.push(
          finding({
            category: "security",
            rule: "app:jwt-long-life",
            severity: "low",
            title: `The app's login token (JWT) lasts ${Math.round((exp - Math.min(iat, now)) / 86400)} days`,
            detail: "A copied token keeps working that long. Keep access tokens short (minutes to hours) and use a refresh token that the server can revoke.",
            pageUrl: first.url,
            evidence: `${name}: ${Math.round((exp - Math.min(iat, now)) / 86400)} days`,
            agent: "app.tokens",
          }),
        );
      }
      const secretClaims = Object.keys(jwt.payload).filter((k) => /pass|pwd|secret|aadhaar|aadhar|pan_?(no|number)|ssn|card|cvv|otp/i.test(k));
      if (secretClaims.length) {
        out.push(
          finding({
            category: "security",
            rule: "app:jwt-secret-claims",
            severity: "high",
            title: "The app's login token carries secret data",
            detail: `A JWT is only encoded, not encrypted: anyone holding it can read ${secretClaims.join(", ")}. Keep only the user id and role in the token and look the rest up on the server.`,
            pageUrl: first.url,
            evidence: `${name}: ${secretClaims.join(", ")}`,
            agent: "app.tokens",
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------

export const csrfAgent: PageAgent = {
  id: "app.csrf",
  name: "Forms protected against CSRF",
  description:
    "Checks signed-in forms that change data (method POST) carry a CSRF token, or that the session cookie is SameSite, so another website cannot send the form in the user's name. Nothing is sent.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "page",
  skipErrorPages: true,
  needsLogin: true,
  async run({ page, url, browser }) {
    const forms = (await page.evaluate(`(function () {
      var out = [];
      var meta = document.querySelector('meta[name="csrf-token"], meta[name="_csrf"], meta[name="csrf-param"], meta[name="X-CSRF-TOKEN"], meta[name="__RequestVerificationToken"]');
      var fs = document.querySelectorAll("form");
      for (var i = 0; i < fs.length && i < 30; i++) {
        var f = fs[i];
        if ((f.getAttribute("method") || "get").toLowerCase() !== "post") continue;
        var act = f.getAttribute("action") || "";
        try { if (act && new URL(act, location.href).origin !== location.origin) continue; } catch (e) {}
        var token = f.querySelector('input[type=hidden][name*="csrf" i], input[type=hidden][name*="token" i], input[type=hidden][name="_token"], input[type=hidden][name="authenticity_token"], input[type=hidden][name="__RequestVerificationToken"], input[type=hidden][name="csrfmiddlewaretoken"], input[type=hidden][name*="nonce" i], input[type=hidden][name="sesskey"], input[name="__VIEWSTATE"]');
        if (token || meta) continue;
        var name = f.getAttribute("id") || f.getAttribute("name") || f.getAttribute("action") || "form " + (i + 1);
        out.push(name.slice(0, 80));
      }
      return out;
    })()`)) as string[];
    if (!forms.length) return [];
    const cookies = await browser.cookies(url).catch(() => [] as Cookie[]);
    const sess = sessionCookies(cookies);
    const weak = sess.some((c) => c.sameSite === "None");
    return [
      finding({
        category: "security",
        rule: "app:csrf-missing",
        severity: weak ? "high" : "low",
        title: "A form that changes data has no CSRF token",
        detail: `${forms.length} form${forms.length === 1 ? "" : "s"} on this signed-in screen send data with POST but carry no CSRF token. ${weak ? "The session cookie is SameSite=None, so any other website can send these forms in the signed-in user's name." : "Browsers' SameSite=Lax default blocks most attacks, but older browsers and same-site subdomains do not."} Add the framework's CSRF token to every form (@csrf in Laravel, {% csrf_token %} in Django, csurf/lusca in Node).`,
        pageUrl: url,
        evidence: forms.slice(0, 6).join("\n"),
        agent: "app.csrf",
      }),
    ];
  },
};

// ---------------------------------------------------------------------------------------------

const TELLS = /no (such )?(user|account)|(user|account|email)( name)? (does not|doesn'?t) exist|not (found|registered)|isn'?t registered|unknown (user|email|account)|no account (found|with)|could not find (your|an|that) account|(email|user ?name) (is )?(not|un)recogni[sz]ed|not a (registered|valid) (user|email)/i;

export const userEnumAgent: SiteAgent = {
  id: "app.user-enum",
  name: "Sign-in does not reveal accounts",
  description:
    "Tries to sign in once with a made-up account (never the real one, so no account gets locked) and checks the message does not say the account does not exist. Also catches a sign-in that lets a made-up account in.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, log }) {
    const real = browser.browser();
    const login = site.login;
    if (!real || !login?.loginUrl) return [];
    const host = new URL(login.loginUrl).hostname;
    const made = createHash("sha1").update(host).digest("hex").slice(0, 8);
    const fake: Login = {
      ...login,
      username: login.username?.includes("@") || !login.username ? `glv-nobody-${made}@example.invalid` : `glvnobody${made}`,
      password: `Not-a-real-password-${made}!`,
      totpSecret: undefined,
      codeFrom: undefined,
    };
    const ctx = await freshContext(real);
    try {
      await signIn(ctx, fake, () => {}, { signal: site.signal });
      return [
        finding({
          category: "security",
          rule: "app:fake-login-works",
          severity: "critical",
          title: "A made-up account can sign in",
          detail: `Signing in as ${fake.username} with a made-up password worked. The sign-in check lets anyone in. Check the password comparison on the server.`,
          pageUrl: login.loginUrl,
          evidence: `${fake.username}: signed in`,
          agent: "app.user-enum",
        }),
      ];
    } catch (err) {
      if (!(err instanceof LoginError)) {
        if (site.signal?.aborted) throw err;
        return [];
      }
      const said = err.message.match(/The page says: "([^"]+)"/)?.[1] ?? "";
      log(`Sign-in with a made-up account was refused${said ? `: "${said}"` : ""}`);
      if (!TELLS.test(said)) return [];
      return [
        finding({
          category: "security",
          rule: "app:user-enumeration",
          severity: "medium",
          title: "The sign-in page says whether an account exists",
          detail: `For a made-up account the page says "${said}". Attackers use this to find which emails have accounts, then guess their passwords or send them targeted phishing. Show the same message for a wrong email and a wrong password: "Wrong email or password."`,
          pageUrl: login.loginUrl,
          evidence: `Made-up account: "${said}"`,
          agent: "app.user-enum",
        }),
      ];
    } finally {
      await ctx.close().catch(() => {});
    }
  },
};

// ---------------------------------------------------------------------------------------------

/** Verhoeff check digit, which every real Aadhaar number passes. */
function verhoeff(num: string): boolean {
  const d = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
    [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
    [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
    [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
    [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
    [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
    [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
    [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
    [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
  ];
  const p = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
    [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
    [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
    [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
    [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
    [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
    [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
  ];
  let c = 0;
  const digits = num.split("").reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = d[c][p[i % 8][digits[i]]];
  return c === 0;
}

function luhn(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = Number(num[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const mask = (s: string) => s.replace(/[\dA-Z](?=[\dA-Z\s-]{4})/g, "•");

/** Full Aadhaar, PAN and card numbers in a screen's text. */
export function idNumbers(text: string): { kind: string; shown: string }[] {
  const out: { kind: string; shown: string }[] = [];
  for (const m of text.matchAll(/(?<![\d-])([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?![\d-])/g)) {
    const n = m[1] + m[2] + m[3];
    if (verhoeff(n)) out.push({ kind: "Aadhaar number", shown: mask(m[0]) });
  }
  for (const m of text.matchAll(/\b([A-Z]{3}[PCHFATBLJG][A-Z]\d{4}[A-Z])\b/g)) out.push({ kind: "PAN", shown: mask(m[1]) });
  for (const m of text.matchAll(/(?<![\d-])((?:\d[ -]?){12,18}\d)(?![\d-])/g)) {
    const n = m[1].replace(/\D/g, "");
    if (n.length >= 13 && n.length <= 19 && /^[3-6]/.test(n) && luhn(n) && !/^(\d)\1+$/.test(n)) out.push({ kind: "card number", shown: mask(m[1]) });
  }
  return out.slice(0, 20);
}

export const idNumbersAgent: PageAgent = {
  id: "app.id-numbers",
  name: "ID and card numbers masked",
  description: "Reads each signed-in screen for full Aadhaar numbers (checked with their check digit), PAN numbers and card numbers (checked with the Luhn digit). Screens should show only the last 4 digits.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "page",
  skipErrorPages: true,
  needsLogin: true,
  async run({ page, url }) {
    const text = await page.evaluate(() => (document.body?.innerText ?? "").slice(0, 200_000)).catch(() => "");
    const found = idNumbers(text);
    if (!found.length) return [];
    const kinds = [...new Set(found.map((f) => f.kind))];
    return [
      finding({
        category: "security",
        rule: "app:id-numbers-shown",
        severity: kinds.includes("card number") || kinds.includes("Aadhaar number") ? "high" : "medium",
        title: `Full ${kinds.join(", ")} shown on screen`,
        detail: `This screen shows ${found.length} full ${kinds.join(" / ")}. Anyone who sees the screen (or a screenshot, or a staff member with lower access) gets the whole number. Aadhaar rules ask to show only the last 4 digits, and card rules (PCI DSS) forbid showing more than the first 6 and last 4. Mask them on the server: XXXX XXXX 1234.`,
        pageUrl: url,
        evidence: found.map((f) => `${f.kind}: ${f.shown}`).slice(0, 6).join("\n"),
        agent: "app.id-numbers",
      }),
    ];
  },
};
