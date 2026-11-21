import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import type { SiteAgent, SiteState } from "../agents/types.js";
import { finding } from "../runner/finding.js";
import { emailLink, waitForEmail } from "../runner/journeys.js";
import { LoginError, signIn } from "../runner/login.js";
import type { Finding, Login } from "../types.js";
import { APPS } from "./calls.js";
import { fillForm, fillerValue, readForms, sendForm } from "./forms.js";

/*
 * The signed-in app checks that change data. They run only with consent: the project is marked
 * as a test copy, or the client gave written permission for "checks that change data" (with the
 * proof file on the host, checked before the test). Each records in the report what it did, what
 * it put back or removed, and anything left that someone must delete by hand.
 */

/** Notes one check in the report's "Checks that change data" box. Returns undefined (and notes why) without consent. */
export function change(site: SiteState, name: string) {
  const r = (site.changes ??= {
    allowed: Boolean(site.consent?.allowed),
    why: site.consent?.why ?? "Checks that change data were not asked for.",
    ran: [],
    skipped: [],
    cleanedUp: [],
    leftOver: [],
  });
  const skip = (why: string) => {
    if (!r.skipped.some((s) => s.check === name)) r.skipped.push({ check: name, why });
  };
  if (!site.consent?.allowed) {
    skip(site.consent?.why ?? "Not allowed: mark the project as a test copy, or record the client's written permission for checks that change data.");
    return undefined;
  }
  return {
    ran: () => void (r.ran.includes(name) || r.ran.push(name)),
    skip,
    cleaned: (what: string) => void r.cleanedUp.push(what),
    left: (what: string) => void r.leftOver.push(what),
  };
}

const fresh = (b: Browser): Promise<BrowserContext> => b.newContext({ viewport: { width: 1366, height: 900 } });
const visibleText = (p: Page) => p.evaluate(() => document.body?.innerText ?? "").catch(() => "");

// ---------------------------------------------------------------------------------------------
// Account lockout (OWASP WSTG-ATHN-03): wrong passwords on a spare account, until the site stops.

/** How many wrong passwords the check tries. NIST 800-63B allows at most 100; most apps lock after 5 to 10. */
export const LOCKOUT_TRIES = 10;
const STOPPED = /\b(locked|lock(ed)? out|too many|try again (later|in)|temporarily|blocked|suspended|wait \d+|captcha|slow down)\b/i;
const CAPTCHA = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], .g-recaptcha, .h-captcha, .cf-turnstile';

export const lockoutAgent: SiteAgent = {
  id: "app.lockout",
  needsConsent: true,
  name: "Account lockout",
  description: `On a spare account you mark for it: types a wrong password ${LOCKOUT_TRIES} times, then the right one. The site should slow down, ask for a CAPTCHA or lock the account; if the right password still works at once, password guessing is not stopped. Needs consent (a test copy or the client's permission).`,
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, log }) {
    const c = change(site, "Account lockout");
    if (!c) return [];
    const real = browser.browser();
    const role = site.roles?.find((r) => r.lockoutTest && r.login.kind === "web");
    if (!role) {
      c.skip('Mark a spare account "may be locked by the lockout check" on the Signed-in app tab: the check never uses the main account.');
      return [];
    }
    if (!real || !role.login.loginUrl) return [];
    const login = role.login;
    const wrong: Login = { ...login, password: `Glv-wrong-${randomBytes(6).toString("hex")}`, totpSecret: undefined, steps: undefined };
    log(`Lockout check: ${LOCKOUT_TRIES} wrong passwords for the spare account "${role.name}"`);
    let stoppedAt = 0;
    let said = "";
    for (let i = 1; i <= LOCKOUT_TRIES && !stoppedAt; i++) {
      site.signal?.throwIfAborted();
      const ctx = await fresh(real);
      let status = 0;
      ctx.on("response", (r) => {
        if (r.request().method() === "POST") status = r.status();
      });
      try {
        await signIn(ctx, wrong, () => {}, { signal: site.signal });
        // Signed in with a wrong password: the sign-in check itself is broken; leave it to the other checks.
        c.ran();
        return [finding({ category: "security", rule: "app:login-any-password", severity: "critical", title: "The sign-in accepts a wrong password", detail: `The spare account "${role.name}" signed in with a made-up password. Check the password comparison on the server.`, pageUrl: login.loginUrl!, agent: "app.lockout" })];
      } catch (err) {
        if (site.signal?.aborted) throw err;
        const msg = (err as Error).message;
        const page = ctx.pages()[0];
        const captcha = page ? await page.locator(CAPTCHA).count().catch(() => 0) : 0;
        if (status === 429 || captcha || STOPPED.test(msg)) {
          stoppedAt = i;
          said = status === 429 ? "HTTP 429 Too Many Requests" : captcha ? "a CAPTCHA appeared" : (msg.match(/"([^"]+)"/)?.[1] ?? msg).slice(0, 160);
        }
      } finally {
        await ctx.close().catch(() => {});
      }
    }
    c.ran();
    // Now the right password.
    const ctx = await fresh(real);
    let rightWorks = false;
    try {
      await signIn(ctx, login, () => {}, { signal: site.signal, mailUrl: site.mailUrl });
      rightWorks = true;
    } catch (err) {
      if (site.signal?.aborted) throw err;
      if (!(err instanceof LoginError)) throw err;
    } finally {
      await ctx.close().catch(() => {});
    }
    if (!rightWorks) c.left(`The spare account "${role.name}" is now locked (or behind a CAPTCHA). It unlocks after the site's lock time, or an admin unlocks it.`);
    if (!stoppedAt && rightWorks) {
      return [
        finding({
          category: "security",
          rule: "app:no-lockout",
          severity: "high",
          title: `${LOCKOUT_TRIES} wrong passwords in a row, and the account still signs in at once`,
          detail: `The test typed ${LOCKOUT_TRIES} wrong passwords for "${role.name}" and the site never slowed down, asked for a CAPTCHA or locked the account; then the right password worked straight away. Anyone can keep guessing passwords. After 5 to 10 failures, slow down sign-ins for that account (a growing delay) or ask for a CAPTCHA, tell the account's owner by email, and rate-limit sign-ins per IP address. Do not lock for ever: that lets anyone lock real users out.`,
          pageUrl: login.loginUrl!,
          evidence: `${LOCKOUT_TRIES} wrong passwords: no slow-down, CAPTCHA or lock message → right password signed in`,
          agent: "app.lockout",
        }),
      ];
    }
    if (stoppedAt) log(`Lockout check: the site stopped the guessing after ${stoppedAt} tries (${said})`);
    return [];
  },
};

// ---------------------------------------------------------------------------------------------
// File upload safety (OWASP WSTG-BUSL-08/09): harmless test files sent through the app's own upload
// forms. The HTML file only changes its own page title, so it shows whether the site would run
// what users upload; it does nothing else.

const MARK = "glv-upload-check";
export const TEST_FILES = [
  { name: `${MARK}.html`, mimeType: "text/html", body: `<!doctype html><title>${MARK}</title><p>GLV Testing Agent: a harmless test file. Safe to delete.</p><script>document.title = "${MARK}-ran"</script>` },
  { name: `${MARK}.svg`, mimeType: "image/svg+xml", body: `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>${MARK}</title><script>document.title = "${MARK}-ran"</script><rect width="10" height="10"/></svg>` },
];

/** Where an uploaded file is now served: a link or image on the page, or an address in the answer. */
async function findUploaded(page: Page, name: string, answers: string[]): Promise<string | undefined> {
  const onPage = (await page
    .$$eval("a[href], img[src], object[data], iframe[src]", (els, n) => els.map((e) => (e as HTMLAnchorElement).href || (e as HTMLImageElement).src || e.getAttribute("data") || "").find((u) => u.includes(n)), name)
    .catch(() => undefined)) as string | undefined;
  if (onPage) return onPage;
  for (const a of answers) {
    const m = a.match(new RegExp(`"(?:url|path|location|file|href|src)"\\s*:\\s*"([^"]*${name.replace(/\./g, "\\.")}[^"]*)"`, "i"));
    if (m) return new URL(m[1].replace(/\\\//g, "/"), page.url()).href;
  }
  return undefined;
}

/** Tries to remove a test file through the app: a Delete/Remove control next to its name. */
async function removeUploaded(page: Page, name: string): Promise<boolean> {
  page.once("dialog", (d) => void d.accept().catch(() => {}));
  const row = page.locator(`tr:has-text("${name}"), li:has-text("${name}"), [class*=file]:has-text("${name}"), [class*=attachment]:has-text("${name}")`).first();
  if (!(await row.count().catch(() => 0))) return false;
  const del = row.locator('button, a, [role=button]').filter({ hasText: /delete|remove|trash|×/i }).first();
  if (!(await del.count().catch(() => 0))) return false;
  await del.click({ timeout: 3_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
  return !(await page.getByText(name).first().isVisible().catch(() => false));
}

export const uploadAgent: SiteAgent = {
  id: "app.file-upload",
  needsConsent: true,
  name: "File upload safety",
  description:
    "Sends two harmless test files (an HTML page and an SVG picture that only change their own title) through the app's upload forms, then opens them where the app serves them. If the browser runs them on the app's own site, any user can upload a page that steals other users' sessions. Removes the files after, where the app has a delete button. Needs consent.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, pages, log, origin }) {
    const c = change(site, "File upload safety");
    if (!c) return [];
    const out: Finding[] = [];
    const screens = [...new Set([...(site.screens ?? []).map((s) => s.url), ...pages.filter((p) => !p.error && (p.status ?? 0) < 400).map((p) => p.url)])].slice(0, 30);
    const page = await browser.newPage();
    page.on("popup", (p) => void p.close().catch(() => {}));
    let tried = 0;
    try {
      for (const url of screens) {
        if (tried >= 2) break;
        await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
        const forms = (await readForms(page)).filter((f) => f.hasFile && !f.fields.some((x) => x.type === "password"));
        if (!forms.length) continue;
        tried++;
        c.ran();
        for (const file of TEST_FILES) {
          site.signal?.throwIfAborted();
          await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
          const form = (await readForms(page)).find((f) => f.hasFile);
          if (!form) break;
          const input = page.locator(`${form.selector} input[type=file]`).first();
          await input.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.body) }).catch(() => {});
          // Other fields the form needs, filled with the built-in filler.
          const others = { ...form, fields: form.fields.filter((f) => f.type !== "file") };
          await fillForm(page, others, others.fields.map((f, i) => fillerValue(f, i)));
          const answers: string[] = [];
          const grab = async (r: import("playwright").Response) => {
            if (r.request().method() !== "GET") answers.push((await r.text().catch(() => "")).slice(0, 20_000));
          };
          page.on("response", grab);
          const sent = await sendForm(page, page, form);
          await page.waitForTimeout(300);
          page.off("response", grab);
          log(`Upload check: ${file.name} on ${new URL(url).pathname}: ${sent.outcome}${sent.status ? ` (HTTP ${sent.status})` : ""}`);
          if (sent.outcome !== "saved") continue;
          await page.reload({ waitUntil: "load" }).catch(() => {});
          const where = await findUploaded(page, MARK, answers);
          let ran = false;
          let served = "";
          if (where) {
            const res = await page.context().request.get(where, { failOnStatusCode: false, timeout: 15_000 }).catch(() => undefined);
            const h = res?.headers() ?? {};
            served = `${res?.status() ?? "?"} ${h["content-type"] ?? ""}${h["content-disposition"] ? `; ${h["content-disposition"]}` : ""}`;
            const viewer = await page.context().newPage();
            try {
              await viewer.goto(where, { waitUntil: "load", timeout: 15_000 }).catch(() => {});
              await viewer.waitForTimeout(500);
              ran = (await viewer.title().catch(() => "")) === `${MARK}-ran`;
            } finally {
              await viewer.close().catch(() => {});
            }
            const sameSite = new URL(where).origin === origin;
            if (ran && sameSite) {
              out.push(
                finding({
                  category: "security",
                  rule: "app:upload-runs-on-site",
                  severity: "critical",
                  title: `An uploaded ${file.name.endsWith(".svg") ? "SVG picture" : "HTML file"} runs as a page on the app's own site`,
                  detail: `The test uploaded a harmless ${file.name} through "${form.name}" and opened it where the app serves it: the browser ran its script on ${new URL(where).host}, with the signed-in user's session. Any user could upload a page that reads other users' data or acts as them (stored cross-site scripting). Serve uploads with Content-Disposition: attachment and X-Content-Type-Options: nosniff, from a separate domain (like a storage bucket), and allow only the file types the feature needs, checked by content, not by name.`,
                  pageUrl: url,
                  evidence: `Uploaded ${file.name} → ${where}\nServed as: ${served}\nIts script ran`,
                  agent: "app.file-upload",
                }),
              );
            } else if (/text\/html|image\/svg/.test(served) && !/attachment/i.test(served) && sameSite) {
              out.push(finding({ category: "security", rule: "app:upload-served-inline", severity: "medium", title: "Uploaded web files are served as pages from the app's own site", detail: `${file.name} was accepted and is served as ${served.split(" ")[1] || "a web page"} from ${new URL(where).host}. Its script did not run this time, but serving uploads inline on the app's own domain is one browser quirk away from stored cross-site scripting. Serve uploads as attachments from a separate domain.`, pageUrl: url, evidence: `${where}\n${served}`, agent: "app.file-upload" }));
            }
          }
          if (!where) {
            out.push(finding({ category: "security", rule: "app:upload-any-type", severity: "low", title: `The upload form accepts ${file.name.endsWith(".svg") ? "SVG" : "HTML"} files`, detail: `"${form.name}" saved ${file.name}. The test could not find where it is served, so it could not check it is safe to open. Allow only the file types the feature needs (check the content, not just the name).`, pageUrl: url, evidence: `${file.name}: ${sent.message ?? "saved"}`, agent: "app.file-upload" }));
          }
          await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
          if (await removeUploaded(page, MARK)) c.cleaned(`Removed the test file ${file.name} from ${new URL(url).pathname}`);
          else c.left(`Test file ${file.name}, uploaded on ${new URL(url).pathname}${where ? ` (${where})` : ""}: delete it in the app.`);
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
    if (!tried) c.skip("No upload form was found on the screens the test reached.");
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Mass assignment (OWASP API6 / WSTG-INPV-20): a save the app really makes, sent again with extra
// fields a user must never set, then read back. What it changed is put back.

export const PRIVILEGE_FIELDS: Record<string, unknown> = {
  role: "admin",
  is_admin: true,
  isAdmin: true,
  admin: true,
  is_staff: true,
  is_superuser: true,
  email_verified: true,
  verified: true,
  account_type: "admin",
};

const isJson = (t?: string) => /json/i.test(t ?? "");
const isForm = (t?: string) => /x-www-form-urlencoded/i.test(t ?? "");

/** The body with the extra fields added, in the body's own format. */
export function withExtraFields(body: string, contentType: string | undefined, extra: Record<string, unknown>): string | undefined {
  if (isJson(contentType)) {
    try {
      const obj = JSON.parse(body);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
      return JSON.stringify({ ...obj, ...extra });
    } catch {
      return undefined;
    }
  }
  if (isForm(contentType)) {
    const p = new URLSearchParams(body);
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v === true ? 1 : v));
    return p.toString();
  }
  return undefined;
}

/** The extra fields the answer (or the record read back) shows with the value the test sent. */
export function stuckFields(answer: unknown, extra: Record<string, unknown>): string[] {
  const out: string[] = [];
  const look = (o: unknown, depth: number) => {
    if (!o || typeof o !== "object" || depth > 3) return;
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (k in extra && (v === extra[k] || (extra[k] === true && (v === 1 || v === "1" || v === "true")))) out.push(k);
      else if (v && typeof v === "object") look(v, depth + 1);
    }
  };
  look(answer, 0);
  return [...new Set(out)];
}

const parse = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

export const massAssignAgent: SiteAgent = {
  id: "app.mass-assignment",
  needsConsent: true,
  name: "Fields a user must not set (mass assignment)",
  description:
    "Takes a save the app really made in a journey (allowed to send forms), sends it again with extra fields like role=admin or is_admin=true, and reads the record back. If the field stuck, any user can make themselves admin. What changed is put back, and records made are deleted where the app allows. Needs consent.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, log }) {
    const c = change(site, "Mass assignment");
    if (!c) return [];
    const saves = (site.writes ?? []).filter((w) => w.body && (isJson(w.contentType) || isForm(w.contentType)) && w.status < 400).slice(0, 5);
    if (!saves.length) {
      c.skip('No save to replay: add a journey that saves a form (for example "edit my profile") and tick "May send forms".');
      return [];
    }
    c.ran();
    const out: Finding[] = [];
    const req = browser.request;
    for (const w of saves) {
      site.signal?.throwIfAborted();
      const extra = { ...PRIVILEGE_FIELDS };
      const sent = withExtraFields(w.body!, w.contentType, extra);
      if (!sent) continue;
      // The record before, to put back what changes (PUT and PATCH change a record in place).
      const inPlace = w.method === "PUT" || w.method === "PATCH";
      const before = inPlace ? parse(await (await req.get(w.url, { failOnStatusCode: false, timeout: 15_000 }).catch(() => undefined))?.text().catch(() => "") ?? "") : undefined;
      log(`Mass assignment: ${w.method} ${new URL(w.url).pathname} again with ${Object.keys(extra).length} extra fields`);
      const res = await req.fetch(w.url, { method: w.method, data: sent, headers: { "content-type": w.contentType! }, failOnStatusCode: false, timeout: 20_000 }).catch(() => undefined);
      if (!res) continue;
      const answer = parse(await res.text().catch(() => ""));
      let stuck = res.status() < 400 ? stuckFields(answer, extra) : [];
      let readBack = "";
      if (res.status() < 400 && inPlace) {
        const after = parse(await (await req.get(w.url, { failOnStatusCode: false, timeout: 15_000 }).catch(() => undefined))?.text().catch(() => "") ?? "");
        const fromRead = stuckFields(after, extra);
        if (fromRead.length) readBack = " (read back from the record)";
        stuck = [...new Set([...stuck, ...fromRead])];
      }
      // Clean up: a new record is deleted; a changed one gets its old values back.
      const id = answer && typeof answer === "object" ? (answer as Record<string, unknown>).id ?? ((answer as Record<string, { id?: unknown }>).data?.id) : undefined;
      if (w.method === "POST" && res.status() < 400 && (typeof id === "string" || typeof id === "number")) {
        const del = await req.delete(`${w.url.replace(/\/+$/, "")}/${encodeURIComponent(String(id))}`, { failOnStatusCode: false, timeout: 15_000 }).catch(() => undefined);
        if (del && del.status() < 400) c.cleaned(`Deleted the record the replayed ${w.method} ${new URL(w.url).pathname} made (id ${id})`);
        else c.left(`Record id ${id} made by ${w.method} ${new URL(w.url).pathname} during the mass assignment check: delete it in the app.`);
      } else if (w.method === "POST" && res.status() < 400) {
        c.left(`A copy of what "${w.journey}" saves (${w.method} ${new URL(w.url).pathname}), made again by the mass assignment check: delete it in the app.`);
      } else if (inPlace && res.status() < 400) {
        const restore: Record<string, unknown> = {};
        if (before && typeof before === "object") for (const k of Object.keys(extra)) if (k in (before as object)) restore[k] = (before as Record<string, unknown>)[k];
        const back = isJson(w.contentType) ? JSON.stringify({ ...(parse(w.body!) ?? {}), ...restore }) : withExtraFields(w.body!, w.contentType, restore);
        const put = await req.fetch(w.url, { method: w.method, data: back, headers: { "content-type": w.contentType! }, failOnStatusCode: false, timeout: 20_000 }).catch(() => undefined);
        const unknownBefore = stuck.filter((k) => !(before && typeof before === "object" && k in (before as object)));
        if (put && put.status() < 400 && !unknownBefore.length) c.cleaned(`Put back the record at ${new URL(w.url).pathname} as it was`);
        else c.left(`${new URL(w.url).pathname}: ${unknownBefore.length ? `the fields ${unknownBefore.join(", ")} were not there before; set them back by hand` : "could not save the old values back; check the record"}.`);
      }
      if (stuck.length) {
        out.push(
          finding({
            category: "security",
            rule: "app:mass-assignment",
            severity: stuck.some((k) => /admin|role|staff|superuser|account_type/.test(k)) ? "critical" : "high",
            title: `A save accepts ${stuck.join(", ")}: users can give themselves rights`,
            detail: `"${w.journey}" saves with ${w.method} ${new URL(w.url).pathname}. Sent again with extra fields, the app kept ${stuck.join(", ")}${readBack}. A user who adds these to the request (in the browser's developer tools) becomes admin or skips checks. Save only the fields the form is meant to change: an allow-list ($fillable in Laravel, strong parameters in Rails, a DTO or serializer with fixed fields elsewhere).`,
            pageUrl: w.pageUrl,
            evidence: `${w.method} ${w.url}\nExtra fields sent: ${Object.keys(extra).join(", ")}\nKept: ${stuck.join(", ")}`,
            agent: "app.mass-assignment",
          }),
        );
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Forgot password (OWASP WSTG-ATHN-09): whether the reset page tells strangers which accounts
// exist, and, with the test mailbox, whether the reset link is long, on the site's own address,
// and leaks to other websites. The password itself is never changed.

const RESET_LINK = /forgot|reset|lost|recover|can't sign in|trouble signing in/i;
const RESET_PATHS = ["/forgot-password", "/password/reset", "/password/forgot", "/users/password/new", "/account/forgot-password", "/accounts/password/reset/", "/web/reset_password", "/wp-login.php?action=lostpassword", "/auth/forgot-password", "/reset-password", "/admin/authentication/forgot_password"];

async function resetPage(ctx: BrowserContext, loginUrl: string): Promise<string | undefined> {
  const page = await ctx.newPage();
  try {
    await page.goto(loginUrl, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
    const links = (await page.$$eval("a[href]", (as) => as.map((a) => [(a as HTMLAnchorElement).href, (a as HTMLElement).innerText])).catch(() => [])) as [string, string][];
    const hit = links.find(([href, text]) => RESET_LINK.test(text) || /forgot|reset|lostpassword|recover/i.test(href));
    if (hit && /^https?:/.test(hit[0])) return hit[0];
    for (const p of RESET_PATHS) {
      const url = new URL(p, loginUrl).href;
      const res = await page.goto(url, { waitUntil: "load", timeout: 10_000 }).catch(() => null);
      if (res && res.status() < 400 && (await page.locator('input[type=email], input[name*=email i], input[name*=user i], input[name*=login i]').first().isVisible().catch(() => false))) return page.url();
    }
    return undefined;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Asks for a reset for one address; returns what the page said (with the address taken out) and the status. */
async function askReset(ctx: BrowserContext, url: string, who: string): Promise<{ said: string; status?: number }> {
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    const form = (await readForms(page)).find((f) => f.fields.some((x) => /email|user|login|phone/i.test(`${x.type} ${x.name} ${x.label}`)));
    if (!form) return { said: "" };
    await fillForm(page, form, form.fields.map((f) => (/email|user|login/i.test(`${f.type} ${f.name} ${f.label}`) ? who : fillerValue(f, 0))));
    const sent = await sendForm(page, page, form);
    const text = (sent.message ?? (await visibleText(page)).slice(0, 600)).split(who).join("[address]");
    return { said: text.replace(/\s+/g, " ").replace(/\d+/g, "#").trim().slice(0, 300), status: sent.status };
  } finally {
    await page.close().catch(() => {});
  }
}

export const forgotPasswordAgent: SiteAgent = {
  id: "app.forgot-password",
  needsConsent: true,
  name: "Forgot password",
  description:
    "Asks for a password reset for the test account and for an address that does not exist, and compares the answers (they must be the same, or strangers learn who has an account). With the test mailbox, opens the reset email: the link must be long and random, use the site's own address, and not leak to other websites. Never changes the password. Needs consent (it sends a reset email).",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run({ browser, site, log }) {
    const c = change(site, "Forgot password");
    if (!c) return [];
    const real = browser.browser();
    const login = site.login;
    if (!real || !login?.loginUrl || !login.username) return [];
    const ctx = await fresh(real);
    const out: Finding[] = [];
    try {
      const url = await resetPage(ctx, login.loginUrl);
      if (!url) {
        c.skip("No forgot-password page was found from the sign-in page.");
        return [];
      }
      c.ran();
      const since = new Date().toISOString();
      const nobody = `glv-nobody-${randomBytes(4).toString("hex")}@example.com`;
      const a = await askReset(ctx, url, nobody);
      const b = await askReset(ctx, url, login.username);
      c.cleaned(`Asked for a password reset for ${login.username} (the password was not changed; the email can be ignored)`);
      log(`Forgot password: ${url}`);
      if (a.said && b.said && (a.said !== b.said || a.status !== b.status)) {
        out.push(finding({ category: "security", rule: "app:reset-user-enum", severity: "medium", title: "The forgot-password page tells strangers which accounts exist", detail: "Asking for a reset gives a different answer for a real account than for an address that has none. Attackers use it to build a list of real users' emails for password guessing and phishing. Show the same message either way: \"If an account exists for this address, we have sent a link.\"", pageUrl: url, evidence: `Unknown address: "${a.said.slice(0, 140)}"${a.status ? ` (${a.status})` : ""}\nReal account: "${b.said.slice(0, 140)}"${b.status ? ` (${b.status})` : ""}`, agent: "app.forgot-password" }));
      }
      if (site.mailUrl && /@/.test(login.username)) {
        const email = await waitForEmail({ url: site.mailUrl, address: login.username }, undefined, 25_000, site.signal).catch(() => undefined);
        const link = email ? (emailLink(email, "reset") ?? emailLink(email, "password") ?? emailLink(email, "http")) : undefined;
        if (email && link) {
          const site0 = new URL(login.loginUrl);
          const u = new URL(link);
          if (u.protocol !== "https:" && site0.protocol === "https:") out.push(finding({ category: "security", rule: "app:reset-link-http", severity: "medium", title: "The password reset link is not https", detail: "The link in the reset email starts with http://, so anyone on the same network can read the token and reset the password. Build links with https.", pageUrl: url, evidence: link.replace(/([?&/=])[\w-]{12,}/g, "$1[token]"), agent: "app.forgot-password" }));
          if (u.hostname !== site0.hostname && !u.hostname.endsWith(`.${site0.hostname.split(".").slice(-2).join(".")}`)) out.push(finding({ category: "security", rule: "app:reset-link-host", severity: "high", title: "The reset link points at another website", detail: `The reset email links to ${u.host}, not the app's own ${site0.host}. If the host comes from the request's Host header, an attacker can make the app email users a link to the attacker's site and catch the token. Build links from a fixed setting (APP_URL), never from the request.`, pageUrl: url, evidence: `${u.host} vs ${site0.host}`, agent: "app.forgot-password" }));
          const tokens = [...u.pathname.split("/"), ...u.searchParams.values()].filter((t) => /^[\w-]{6,}$/.test(t) && /\d/.test(t + "0"));
          const longest = tokens.sort((x, y) => y.length - x.length)[0] ?? "";
          if (longest && longest.length < 16) out.push(finding({ category: "security", rule: "app:reset-token-short", severity: "high", title: "The password reset token is short enough to guess", detail: `The longest code in the reset link has ${longest.length} characters. Short codes can be guessed by trying them all. Use at least 128 random bits (22+ characters from a secure random source), valid for one use and a short time.`, pageUrl: url, evidence: `${longest.length} characters`, agent: "app.forgot-password" }));
          // Open the link (it only shows the "new password" form) and see what other sites it loads.
          const p = await ctx.newPage();
          const outside: string[] = [];
          p.on("request", (r) => {
            try {
              const h = new URL(r.url()).host;
              if (h !== u.host && r.headers().referer?.includes(longest || "@@")) outside.push(h);
            } catch {
              /* not an address */
            }
          });
          await p.goto(link, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
          await p.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
          await p.close().catch(() => {});
          if (outside.length) out.push(finding({ category: "security", rule: "app:reset-token-leak", severity: "medium", title: "The reset page sends its token to other websites", detail: `The page the reset link opens loads things from ${[...new Set(outside)].join(", ")}, and the browser sends them the full address, token included (the Referer header). They could reset the user's password. Add Referrer-Policy: no-referrer to the reset page and keep outside scripts off it.`, pageUrl: url, evidence: [...new Set(outside)].join("\n"), agent: "app.forgot-password" }));
        } else if (email === undefined) {
          log(`Forgot password: no reset email reached the test mailbox for ${login.username} since ${since.slice(11, 19)}`);
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------
// Salesforce Experience Cloud guest access: the Aura endpoint of a public community answers
// record lists to visitors who are not signed in when the guest user's sharing is too wide.
// The check asks, without signing in, for a page of records of common objects (it only reads).

export const SF_OBJECTS = ["Account", "Contact", "Lead", "Opportunity", "Case", "User", "ContentDocument"];

/** The Aura message that reads one page of records of an object, as a guest. */
export function auraGetItems(entity: string): string {
  return JSON.stringify({
    actions: [
      {
        id: "1;a",
        descriptor: "serviceComponent://ui.force.components.controllers.lists.selectableListDataProvider.SelectableListDataProviderController/ACTION$getItems",
        callingDescriptor: "UNKNOWN",
        params: { entityNameOrId: entity, layoutType: "FULL", pageSize: 10, currentPage: 0, useTimeout: false, getCount: true, enableRowActions: false },
      },
    ],
  });
}

/** Records and the total in an Aura getItems answer. */
export function auraRecords(text: string): { count: number; sample: string[] } | undefined {
  const json = parse(text.replace(/^\s*while\(1\);/, ""));
  const action = json?.actions?.[0];
  if (!action || action.state !== "SUCCESS") return undefined;
  const v = action.returnValue ?? {};
  const rows: Record<string, unknown>[] = v.result ?? v.records ?? [];
  const count = Number(v.totalCount ?? v.count ?? rows.length) || rows.length;
  if (!count) return undefined;
  return { count, sample: rows.slice(0, 3).map((r) => Object.keys((r as { record?: object }).record ?? r).slice(0, 6).join(", ")) };
}

export const salesforceGuestAgent: SiteAgent = {
  id: "app.salesforce-guest",
  needsConsent: true,
  name: "Salesforce guest data",
  description:
    "For Salesforce Experience Cloud sites: asks the site's Aura endpoint, without signing in, for a page of Accounts, Contacts, Leads, Cases, Users and files. If any come back, the guest user's sharing exposes the CRM's records to anyone on the internet. Only reads. Runs with consent, as the client asked.",
  category: "security",
  engine: "web",
  products: APPS,
  stage: "site",
  runsLast: true,
  async run({ browser, site, startUrl, log }) {
    const isSf = site.system?.id === "salesforce" || /\.my\.site\.com|\.force\.com/.test(startUrl) || /\/s(\/|$)/.test(new URL(startUrl).pathname);
    if (!isSf) return [];
    const c = change(site, "Salesforce guest data");
    if (!c) return [];
    const real = browser.browser();
    if (!real) return [];
    const ctx = await fresh(real);
    const out: Finding[] = [];
    try {
      const u = new URL(startUrl);
      // The community's base: everything before /s/.
      const path = u.pathname.endsWith("/s") ? `${u.pathname}/` : u.pathname;
      const prefix = path.includes("/s/") ? path.slice(0, path.indexOf("/s/")) : "";
      const home = `${u.origin}${prefix}/s/`;
      const page = await ctx.newPage();
      await page.goto(home, { waitUntil: "load", timeout: 25_000 }).catch(() => {});
      const html = await page.content().catch(() => "");
      await page.close().catch(() => {});
      const fwuid = html.match(/"fwuid"\s*:\s*"([^"]+)"/)?.[1] ?? decodeURIComponent(html.match(/fwuid%22%3A%22([^%]+)/)?.[1] ?? "");
      const app = html.match(/"app"\s*:\s*"([^"]+)"/)?.[1] ?? "siteforce:communityApp";
      if (!fwuid) {
        c.skip("No Aura (Lightning) community found at the site's /s/ address.");
        return [];
      }
      c.ran();
      const endpoint = `${u.origin}${prefix}/s/sfsites/aura?r=1&ui-force-components-controllers-lists-selectableListDataProvider.SelectableListDataProvider.getItems=1`;
      const context = JSON.stringify({ mode: "PROD", fwuid, app, loaded: {}, dn: [], globals: {}, uad: false });
      for (const entity of SF_OBJECTS) {
        site.signal?.throwIfAborted();
        const form = new URLSearchParams({ message: auraGetItems(entity), "aura.context": context, "aura.pageURI": `${prefix}/s/`, "aura.token": "null" });
        const res = await ctx.request.post(endpoint, { data: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }, failOnStatusCode: false, timeout: 20_000 }).catch(() => undefined);
        const got = res ? auraRecords(await res.text().catch(() => "")) : undefined;
        if (got) {
          log(`Salesforce guest check: ${entity} records answered to a visitor who is not signed in`);
          out.push(
            finding({
              category: "security",
              rule: "app:sf-guest-records",
              severity: entity === "User" || entity === "ContentDocument" ? "high" : "critical",
              title: `Anyone can read ${entity} records from the Salesforce site without signing in`,
              detail: `The community's Aura endpoint answered a visitor who is not signed in with ${got.count} ${entity} record${got.count === 1 ? "" : "s"}. The site's guest user can see these records, so anyone on the internet can list them. In Setup > Digital Experiences > the site > Builder > Settings > General > Guest User Profile: remove read access to ${entity}, set the org-wide default for external access to Private, remove guest sharing rules that open it, and turn on "Secure guest user record access".`,
              pageUrl: home,
              evidence: `POST ${new URL(endpoint).pathname} getItems(${entity}) as guest → ${got.count} records${got.sample.length ? `\nFields: ${got.sample[0]}` : ""}`,
              agent: "app.salesforce-guest",
            }),
          );
        }
      }
    } finally {
      await ctx.close().catch(() => {});
    }
    return out;
  },
};
