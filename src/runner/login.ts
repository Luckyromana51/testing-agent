import type { BrowserContext, Locator, Page } from "playwright";
import type { Login } from "../types.js";
import { codeInEmail, secondsLeft, totp } from "../app/totp.js";
import { newVars, parseSteps, runStep, waitForEmail } from "./journeys.js";
import { validateTarget } from "./urls.js";

/** Fields that usually hold the user name or email, best guesses first. */
const USER_FIELDS = [
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  'input[type="email"]',
  'input[name*="email" i]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[id*="email" i]',
  'input[id*="user" i]',
  'input[id*="login" i]',
  'input[type="text"]',
  "input:not([type])",
  'input[type="tel"]',
];
const PASSWORD = 'input[type="password"]';
const FORM_SUBMIT = ['button[type="submit"]', 'input[type="submit"]', "button:not([type])"];
const SUBMIT_NAME = /^\s*(log\s?in|sign\s?in|continue|next|submit|enter|go)\b/i;
const CAPTCHA =
  'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile';
const ONE_TIME_CODE =
  'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="2fa" i], input[name*="totp" i], input[id*="otp" i]';
const MESSAGE = '[role="alert"], .error, .alert-danger, .alert-error, .invalid-feedback, .text-danger, .notice-error, #login_error';

/** A sign-in that did not work. The message says what to change; it never holds the password. */
export class LoginError extends Error {}

async function firstVisible(scope: Page | Locator, selectors: string[]): Promise<Locator | undefined> {
  for (const sel of selectors) {
    const all = scope.locator(sel);
    const n = Math.min(await all.count(), 10);
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      if (await el.isVisible().catch(() => false)) return el;
    }
  }
  return undefined;
}

async function visibleWithin(page: Page, selector: string, ms: number): Promise<Locator | undefined> {
  const el = page.locator(selector).first();
  try {
    await el.waitFor({ state: "visible", timeout: ms });
    return el;
  } catch {
    return undefined;
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
}

/** Presses the form's sign-in button, or Enter in the field when there is none. */
async function submit(page: Page, scope: Page | Locator, login: Login, field: Locator): Promise<void> {
  let button: Locator | undefined;
  if (login.submitSelector) {
    button = await visibleWithin(page, login.submitSelector, 5_000);
    if (!button) throw new LoginError(`The sign-in button "${login.submitSelector}" was not found on the page.`);
  } else if (scope !== page) {
    button = await firstVisible(scope, FORM_SUBMIT);
  } else {
    const byName = page.getByRole("button", { name: SUBMIT_NAME });
    button = (await byName.count()) ? byName.first() : undefined;
  }
  if (button) await button.click({ timeout: 10_000 });
  else await field.press("Enter");
}

/** What the page says after a failed sign-in, to help fix the saved login. */
async function explain(page: Page, fallback: string): Promise<LoginError> {
  if (await page.locator(CAPTCHA).count().catch(() => 0)) {
    return new LoginError(
      "The sign-in page has a CAPTCHA, which stops automated sign-in. Use a test account or test server without CAPTCHA, or allow-list this server's address.",
    );
  }
  const message = await firstVisible(page, [MESSAGE]);
  const said = message ? (await message.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return new LoginError(`${fallback}${said ? ` The page says: "${said}".` : ""} Check the user name and password in the login settings.`);
}

export interface SignedIn {
  /** Where the site went after signing in. */
  landedUrl: string;
  /** The sign-in page's path, to notice when the site signs the agent out during the test. */
  loginPath: string;
  /** The two-step code typed, when the site asked for one. */
  code?: string;
}

export interface SignInOptions {
  mailUrl?: string;
  signal?: AbortSignal;
  hints?: { username?: string; password?: string; submit?: string };
  /** Called when the site asks for the two-step code, before it is typed (to try skipping it). */
  beforeCode?: (page: Page) => Promise<void>;
  /** Type this code instead of a new one (to check a used code is refused). */
  fixedCode?: string;
}

/**
 * Signs in through the site's own sign-in form in this browser context, so every page and agent
 * afterwards runs with the session. Handles one-page and two-step (email, then password) forms.
 */
export async function signIn(
  context: BrowserContext,
  login: Login,
  log: (m: string) => void = () => {},
  opts: SignInOptions = {},
): Promise<SignedIn> {
  if (!login.loginUrl || !login.username || (!login.password && !login.steps)) {
    throw new LoginError("The saved login is missing the sign-in page, user name or password.");
  }
  const loginUrl = validateTarget(login.loginUrl);
  const page = await context.newPage();
  const startedAt = new Date().toISOString();
  try {
    log(`Signing in at ${loginUrl} as ${login.username}`);
    if (login.steps?.trim()) {
      await signInWithSteps(page, loginUrl, login, opts.signal);
      await settle(page);
      const code = await twoStep(page, login, log, opts, startedAt);
      await confirmSignedIn(page, login);
      log(`Signed in with the sign-in steps; the site opened ${page.url().split("?")[0]}`);
      return { landedUrl: page.url(), loginPath: new URL(loginUrl).pathname, ...(code ? { code } : {}) };
    }
    const res = await page.goto(loginUrl, { waitUntil: "load", timeout: 30_000 }).catch((err: Error) => {
      throw new LoginError(`Could not open the sign-in page: ${err.message.split("\n")[0]}`);
    });
    if (res && res.status() >= 400) throw new LoginError(`The sign-in page answered HTTP ${res.status()}.`);
    await settle(page);

    let password = login.passwordSelector
      ? await visibleWithin(page, login.passwordSelector, 10_000)
      : await firstVisible(page, [...(opts.hints?.password ? [opts.hints.password] : []), PASSWORD]);
    if (login.passwordSelector && !password) throw new LoginError(`The password field "${login.passwordSelector}" was not found on the sign-in page.`);
    const form = password?.locator("xpath=ancestor::form[1]");
    const scope: Page | Locator = form && (await form.count()) ? form : page;

    const user = login.usernameSelector
      ? await visibleWithin(page, login.usernameSelector, 10_000)
      : await firstVisible(scope, [...(opts.hints?.username ? [opts.hints.username] : []), ...USER_FIELDS]);
    if (!user) {
      throw new LoginError(
        login.usernameSelector
          ? `The user name field "${login.usernameSelector}" was not found on the sign-in page.`
          : "Could not find the user name or email field on the sign-in page. Add its CSS selector in the login settings.",
      );
    }
    await user.fill(login.username);

    if (!password) {
      // Two-step sign-in: the email first, then the password on the next screen.
      await submit(page, page, login, user);
      await settle(page);
      password = await visibleWithin(page, PASSWORD, 10_000);
      if (!password) throw await explain(page, "No password field appeared on the sign-in page.");
    }
    await password.fill(login.password ?? "");
    const passwordScope: Page | Locator = (await password.locator("xpath=ancestor::form[1]").count())
      ? password.locator("xpath=ancestor::form[1]")
      : page;
    await submit(page, passwordScope, login, password);
    await settle(page);

    const code = await twoStep(page, login, log, opts, startedAt);
    await confirmSignedIn(page, login);
    log(`Signed in; the site opened ${page.url().split("?")[0]}`);
    return { landedUrl: page.url(), loginPath: new URL(loginUrl).pathname, ...(code ? { code } : {}) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** The saved sign-in steps, in journey words, with {{username}}, {{password}} and {{code}}. Forms may be sent. */
async function signInWithSteps(page: Page, loginUrl: string, login: Login, signal?: AbortSignal): Promise<void> {
  let steps;
  try {
    steps = parseSteps(login.steps!);
  } catch (err) {
    throw new LoginError(`The sign-in steps: ${(err as Error).message}`);
  }
  await page.goto(loginUrl, { waitUntil: "load", timeout: 30_000 }).catch((err: Error) => {
    throw new LoginError(`Could not open the sign-in page: ${err.message.split("\n")[0]}`);
  });
  const vars = newVars({ login });
  for (const step of steps) {
    signal?.throwIfAborted();
    try {
      await runStep(page, step, page.url(), vars, signal);
    } catch (err) {
      const text = /\{\{\s*(password|code)\s*\}\}/i.test(step.text) ? step.text.replace(/=.*$/, "= ••••••") : step.text;
      throw new LoginError(`Sign-in step ${step.line} ("${text}") did not work: ${(err as Error).message.split("\n")[0].slice(0, 200)}`);
    }
  }
}

/**
 * Two-step verification: when the site asks for a one-time code, type the code made from the saved
 * secret (like an authenticator app), or the code emailed to the test mailbox.
 */
async function twoStep(page: Page, login: Login, log: (m: string) => void, opts: SignInOptions, since: string): Promise<string | undefined> {
  const field = await firstVisible(page, [ONE_TIME_CODE]);
  if (!field) return undefined;
  await opts.beforeCode?.(page);
  let code: string | undefined;
  if (opts.fixedCode) {
    code = opts.fixedCode;
  } else if (login.totpSecret && login.codeFrom !== "email") {
    // A code about to change may be refused by the time it arrives.
    if (secondsLeft(login.totpSecret) < 3) await page.waitForTimeout(3_500);
    code = totp(login.totpSecret);
    log("The site asks for a two-step code: typing the code made from the saved secret");
  } else if (login.codeFrom === "email") {
    if (!opts.mailUrl) throw new LoginError('The sign-in sends a code by email, but the test mailbox is off. Turn on "Test mailbox (Mailpit)" in Owner panel > Modules, and give the test account an address the mailbox catches.');
    log(`The site asks for a code: waiting for the email to ${login.username}`);
    const email = await waitForEmail({ url: opts.mailUrl, address: login.username! }, undefined, 60_000, opts.signal).catch(() => {
      throw new LoginError(`No email with a code came to ${login.username} within a minute.`);
    });
    code = codeInEmail(`${email.subject}\n${email.text}\n${email.html.replace(/<[^>]+>/g, " ")}`);
    if (!code) throw new LoginError(`The email "${email.subject}" has no code in it.`);
    void since;
  } else {
    throw new LoginError(
      "The site asks for a one-time code (two-step verification) after the password. Save the account's two-step secret (the text under the QR code) in the login settings, choose \"code by email\" with the test mailbox, or use a test account without two-step verification.",
    );
  }
  await field.fill(code);
  const form = field.locator("xpath=ancestor::form[1]");
  const scope: Page | Locator = (await form.count()) ? form : page;
  const button = scope === page ? undefined : await firstVisible(scope, FORM_SUBMIT);
  const byName = page.getByRole("button", { name: /^\s*(verify|confirm|continue|submit|sign\s?in|log\s?in|next)\b/i });
  if (button) await button.click({ timeout: 10_000 });
  else if (await byName.count()) await byName.first().click({ timeout: 10_000 });
  else await field.press("Enter");
  await settle(page);
  if (await page.locator(ONE_TIME_CODE).first().isVisible().catch(() => false)) {
    throw await explain(page, "The site did not accept the two-step code. Check the saved secret, and that the server's clock is right.");
  }
  return code;
}

async function confirmSignedIn(page: Page, login: Login): Promise<void> {
  if (login.successText) {
    const found = await page
      .getByText(login.successText, { exact: false })
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (!found) throw await explain(page, `After signing in, the page does not show "${login.successText}".`);
  } else if (await visibleWithin(page, PASSWORD, 1_000)) {
    throw await explain(page, "The sign-in form is still showing after submitting it, so the sign-in did not work.");
  }
}
