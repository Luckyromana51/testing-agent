import type { Browser, BrowserContext, Page } from "playwright";
import type { SiteAgent } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { LoginError, signIn } from "../runner/login.js";
import type { Finding, Login } from "../types.js";
import { APPS } from "./calls.js";

/**
 * Sign-in checks from the OWASP testing guide (WSTG-ATHN): a two-step code that can be skipped by
 * opening the app straight after the password, a used code that works a second time, and a sign-in
 * page that sends people on to any website afterwards (an open redirect). Each runs in its own fresh
 * browser; the main test's session is never touched.
 */

const ONE_TIME_CODE = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="2fa" i], input[name*="totp" i], input[id*="otp" i]';
const EVIL_HOST = "glv-redirect-check.example";
const EVIL = `https://${EVIL_HOST}/signed-in`;
const RETURN_PARAMS = /^(next|return_?url|return_?to|redirect(_?to|_?url|_?uri)?|continue|goto|go|dest(ination)?|back_?url|target|r|url|from|callback)$/i;

const fresh = (b: Browser): Promise<BrowserContext> => b.newContext({ viewport: { width: 1366, height: 900 } });

/** Signed in on this screen: not the sign-in page, no password or code field. */
async function looksSignedIn(page: Page, loginPath: string, codePath: string, login: Login): Promise<boolean> {
  const path = new URL(page.url()).pathname;
  if (path === loginPath || path === codePath) return false;
  if (await page.locator('input[type="password"]').first().isVisible().catch(() => false)) return false;
  if (await page.locator(ONE_TIME_CODE).first().isVisible().catch(() => false)) return false;
  if (login.successText) return page.getByText(login.successText).first().isVisible().catch(() => false);
  if (login.username && (await page.getByText(login.username).first().isVisible().catch(() => false))) return true;
  const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  return text.trim().length > 40 && !/\b(sign|log)\s?in\b/i.test(text.slice(0, 300));
}

export const twoStepAgent: SiteAgent = {
  id: "app.two-step",
  name: "Two-step sign-in safety",
  description:
    "For a login with two-step verification: after the password, opens the app before typing the code (it must not open), and signs in a second time with the code already used (it must be refused).",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, startUrl, log }) {
    const real = browser.browser();
    const login = site.login;
    if (!real || !login?.loginUrl || !login.totpSecret || login.codeFrom === "email") return [];
    const out: Finding[] = [];
    const loginPath = new URL(login.loginUrl).pathname;
    let usedCode: string | undefined;
    let skipped = false;
    let codePath = "";
    const a = await fresh(real);
    try {
      const done = await signIn(a, login, log, {
        signal: site.signal,
        beforeCode: async (codePage) => {
          codePath = new URL(codePage.url()).pathname;
          // The password is in, the code is not: does the app open anyway?
          const p = await a.newPage();
          try {
            const res = await p.goto(startUrl, { waitUntil: "load", timeout: 20_000 }).catch(() => null);
            await p.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
            skipped = Boolean(res && res.status() < 400) && (await looksSignedIn(p, loginPath, codePath, login));
          } finally {
            await p.close().catch(() => {});
          }
        },
      });
      usedCode = done.code;
    } catch (err) {
      if (site.signal?.aborted) throw err;
      log(`Two-step check: could not sign in (${(err as Error).message.split("\n")[0]})`);
      return out;
    } finally {
      await a.close().catch(() => {});
    }
    if (skipped) {
      out.push(
        finding({
          category: "security",
          rule: "app:two-step-skippable",
          severity: "critical",
          title: "The two-step code can be skipped",
          detail: `After the password, the site asks for the code, but opening ${startUrl} straight away shows the app signed in, without the code. A stolen password is enough to get in. Mark the session as signed in only after the code is checked, and make every page check that.`,
          pageUrl: startUrl,
          evidence: `Password typed, code not typed → ${startUrl} opens signed in`,
          agent: "app.two-step",
        }),
      );
    }
    if (usedCode) {
      const b = await fresh(real);
      try {
        await signIn(b, login, () => {}, { signal: site.signal, fixedCode: usedCode });
        out.push(
          finding({
            category: "security",
            rule: "app:two-step-code-reused",
            severity: "medium",
            title: "A two-step code works twice",
            detail: "The test signed in, then signed in again in another browser with the same code, and the site accepted it. Someone who sees a code (over the shoulder, a screen share, a phishing page) can use it again within its 30 seconds. Remember the last code used for each account and refuse it a second time (RFC 6238, section 5.2).",
            pageUrl: login.loginUrl,
            evidence: "Same 6-digit code accepted in a second sign-in",
            agent: "app.two-step",
          }),
        );
      } catch (err) {
        if (site.signal?.aborted) throw err;
        if (!(err instanceof LoginError)) log(`Two-step check: ${(err as Error).message.split("\n")[0]}`);
      } finally {
        await b.close().catch(() => {});
      }
    }
    return out;
  },
};

/** The address parameter the sign-in page uses to send people back where they were going. */
async function returnParam(real: Browser, startUrl: string, loginPath: string): Promise<string | undefined> {
  const ctx = await fresh(real);
  try {
    const p = await ctx.newPage();
    await p.goto(startUrl, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
    const u = new URL(p.url());
    if (u.pathname !== loginPath && !(await p.locator('input[type="password"]').first().isVisible().catch(() => false))) return undefined;
    const start = new URL(startUrl);
    for (const [k, v] of u.searchParams) {
      if (RETURN_PARAMS.test(k) || v.includes(start.pathname)) return k;
    }
    return undefined;
  } finally {
    await ctx.close().catch(() => {});
  }
}

export const loginRedirectAgent: SiteAgent = {
  id: "app.login-redirect",
  name: "Sign-in that sends people to another site",
  description:
    "Signs in through a sign-in address whose return parameter (?next=, ?returnUrl=...) points at an outside website, and checks the site does not send the browser there afterwards (an open redirect, used for phishing).",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, startUrl, log }) {
    const real = browser.browser();
    const login = site.login;
    if (!real || !login?.loginUrl || login.steps?.trim()) return [];
    const loginPath = new URL(login.loginUrl).pathname;
    const found = await returnParam(real, startUrl, loginPath);
    const params = found ? [found] : ["next", "returnUrl"];
    for (const param of params) {
      // A known parameter gets the "//host" trick too; a guessed one only the plain address.
      for (const target of found ? [EVIL, `//${EVIL_HOST}/signed-in`] : [EVIL]) {
        site.signal?.throwIfAborted();
        const ctx = await fresh(real);
        let reached = "";
        ctx.on("request", (r) => {
          try {
            if (new URL(r.url()).hostname === EVIL_HOST) reached ||= r.url();
          } catch {
            // not an address
          }
        });
        // Never really load the outside site.
        await ctx.route(`**://${EVIL_HOST}/**`, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Outside site</title><p>Outside site</p>" }));
        try {
          const url = new URL(login.loginUrl);
          url.searchParams.set(param, target);
          await signIn(ctx, { ...login, loginUrl: url.href }, () => {}, { mailUrl: site.mailUrl, signal: site.signal }).catch((err: Error) => {
            if (site.signal?.aborted) throw err;
          });
          if (reached) {
            log(`Sign-in redirect: ?${param}= sent the browser to an outside site`);
            return [
              finding({
                category: "security",
                rule: "app:login-open-redirect",
                severity: "high",
                title: "After sign-in, the site sends people to any website",
                detail: `Signing in through ${url.pathname}?${param}=${target} sends the browser to ${EVIL_HOST} once the password is in. A phishing email can use the company's real sign-in link to land users on a fake page that asks for their password again. Only follow return addresses that are a path on the same site (start with one "/", not "//"), or keep a list of allowed addresses.`,
                pageUrl: url.href,
                evidence: `?${param}=${target} → browser went to ${reached}`,
                agent: "app.login-redirect",
              }),
            ];
          }
        } finally {
          await ctx.close().catch(() => {});
        }
      }
    }
    return [];
  },
};
