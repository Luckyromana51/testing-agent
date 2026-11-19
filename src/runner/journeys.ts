import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { readOnly } from "../agents/web/guard.js";
import type { Finding, Journey, JourneyResult, JourneyStepResult, Login } from "../types.js";
import { finding } from "./finding.js";

/**
 * User journeys: steps in plain words, one per line, that the test follows like a person would.
 *
 *   open /shop
 *   click Add to cart
 *   fill Email = {{username}}
 *   see Your cart
 *   url has /cart
 *
 * With the test mailbox module (Mailpit) on, {{inbox}} is a fresh address for this journey, and
 *
 *   fill Email = {{inbox}}
 *   click Sign up
 *   email has Welcome
 *   open email link Confirm my account
 *
 * waits for the email the site sent to it, and opens a link in it.
 *
 * Read-only by default: requests that could change data (POST, PUT, DELETE...) are stopped, so a
 * journey can look at a checkout without placing an order. A journey allowed to send forms is only
 * for staging or test sites.
 */

export type StepKind = "open" | "click" | "fill" | "select" | "check" | "uncheck" | "press" | "hover" | "see" | "not-see" | "url-has" | "title-has" | "wait" | "screenshot" | "email-has" | "email-link";

export interface Step {
  line: number;
  text: string;
  kind: StepKind;
  target?: string;
  value?: string;
}

const MAX_STEPS = 40;
export const MAX_JOURNEYS = 10;

const PATTERNS: [RegExp, StepKind][] = [
  [/^(?:open|click)\s+(?:the\s+)?(?:email|mail)\s+link\s+(.+)$/i, "email-link"],
  [/^(?:open|go to|goto|visit)\s+(.+)$/i, "open"],
  [/^(?:click|tap|press button)\s+(.+)$/i, "click"],
  [/^(?:fill|type|enter)\s+(.+?)\s*=\s*(.*)$/i, "fill"],
  [/^(?:select|choose)\s+(.+?)\s*=\s*(.+)$/i, "select"],
  [/^(?:check|tick)\s+(.+)$/i, "check"],
  [/^(?:uncheck|untick)\s+(.+)$/i, "uncheck"],
  [/^press\s+(.+)$/i, "press"],
  [/^hover\s+(.+)$/i, "hover"],
  [/^(?:not see|don'?t see|do not see)\s+(.+)$/i, "not-see"],
  [/^(?:see|expect|should see)\s+(.+)$/i, "see"],
  [/^url\s+(?:has|contains)\s+(.+)$/i, "url-has"],
  [/^title\s+(?:has|contains)\s+(.+)$/i, "title-has"],
  [/^wait\s+(\d+(?:\.\d+)?)\s*s?(?:ec(?:onds?)?)?$/i, "wait"],
  [/^(?:screenshot|picture|snap)$/i, "screenshot"],
  [/^(?:email|mail)\s+(?:has|contains)\s+(.+)$/i, "email-has"],
];

const unquote = (s: string) => s.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Reads a journey's steps. Throws with the line number on a line it does not understand. */
export function parseSteps(text: string): Step[] {
  const steps: Step[] = [];
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const hit = PATTERNS.map(([re, kind]) => [line.match(re), kind] as const).find(([m]) => m);
    if (!hit) {
      throw new Error(
        `Line ${i + 1} ("${line.slice(0, 60)}") is not a step. Start it with open, click, fill … = …, select … = …, check, press, hover, see, not see, url has, title has, wait, screenshot, email has or open email link.`,
      );
    }
    const [m, kind] = hit;
    const step: Step = { line: i + 1, text: line, kind };
    if (kind === "fill" || kind === "select") {
      step.target = unquote(m![1]);
      step.value = unquote(m![2]);
    } else if (kind === "wait") step.value = m![1];
    else if (kind !== "screenshot") step.target = unquote(m![1]);
    steps.push(step);
  }
  if (!steps.length) throw new Error("The journey has no steps.");
  if (steps.length > MAX_STEPS) throw new Error(`A journey can have up to ${MAX_STEPS} steps.`);
  return steps;
}

/** Checks a journey from the dashboard before it is saved. */
export function cleanJourney(input: Partial<Journey>, i: number): Journey {
  const name = String(input.name ?? "").trim().slice(0, 80) || `Journey ${i + 1}`;
  const steps = String(input.steps ?? "").slice(0, 5000);
  try {
    parseSteps(steps);
  } catch (err) {
    throw new Error(`${name}: ${(err as Error).message}`);
  }
  return {
    id: String(input.id ?? "").replace(/[^\w-]/g, "").slice(0, 20) || `j${Date.now().toString(36)}${i}`,
    name,
    steps,
    ...(input.allowWrites ? { allowWrites: true } : {}),
    ...(input.off ? { off: true } : {}),
  };
}

/** {{username}} and {{password}} come from the project's saved login; the password is never shown. {{inbox}} is the journey's test mailbox address. */
function fillValue(value: string, login?: Login, mail?: Mailbox): string {
  if (/\{\{\s*inbox\s*\}\}/i.test(value) && !mail) throw new Error("{{inbox}} needs the test mailbox: turn on \"Test mailbox (Mailpit)\" in Owner panel > Modules.");
  value = value.replace(/\{\{\s*inbox\s*\}\}/gi, mail?.address ?? "");
  return value.replace(/\{\{\s*(username|user|email|password)\s*\}\}/gi, (_, k: string) =>
    k.toLowerCase() === "password" ? (login?.password ?? "") : (login?.username ?? ""),
  );
}

function shownValue(step: Step): string {
  return /\{\{\s*password\s*\}\}/i.test(step.value ?? "") ? step.text.replace(/=.*$/, "= ••••••") : step.text;
}

/** Finds what a person would mean by the words: a button or link with that name, then a field, then any text. */
function find(page: Page, target: string, as: "click" | "field" | "any"): Locator {
  if (/^(css|xpath)=/i.test(target) || /^[#.[]/.test(target)) return page.locator(target.replace(/^css=/i, "")).first();
  const name = { name: target };
  const byText = page.getByText(target, { exact: false });
  if (as === "field") {
    return page.getByLabel(target).or(page.getByPlaceholder(target)).or(page.getByRole("textbox", name)).or(page.getByRole("combobox", name)).first();
  }
  if (as === "click") {
    return page
      .getByRole("button", name)
      .or(page.getByRole("link", name))
      .or(page.getByRole("menuitem", name))
      .or(page.getByRole("tab", name))
      .or(page.getByLabel(target))
      .or(byText)
      .first();
  }
  return byText.first();
}

function resolveUrl(target: string, base: string): string {
  const u = new URL(target, base);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https addresses can be opened.");
  return u.href;
}

const TIMEOUT = 10_000;

/** The journey's own address in the test mailbox, and where Mailpit's API is. */
export interface Mailbox {
  url: string;
  address: string;
}

interface MailMessage {
  ID: string;
  Subject?: string;
  Created?: string;
}

/** Waits for an email to the journey's address (newest first) that has the words. Mailpit's search API. */
export async function waitForEmail(mail: Mailbox, words?: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<{ subject: string; text: string; html: string }> {
  const end = Date.now() + timeoutMs;
  const want = words?.toLowerCase();
  for (;;) {
    signal?.throwIfAborted();
    const q = new URL("/api/v1/search", mail.url);
    q.searchParams.set("query", `to:"${mail.address}"`);
    q.searchParams.set("limit", "20");
    const list = (await fetch(q, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : { messages: [] })).catch(() => ({ messages: [] }))) as { messages?: MailMessage[] };
    for (const m of list.messages ?? []) {
      const full = (await fetch(new URL(`/api/v1/message/${encodeURIComponent(m.ID)}`, mail.url), { signal: AbortSignal.timeout(10_000) })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as { Subject?: string; Text?: string; HTML?: string } | null;
      if (!full) continue;
      const text = `${full.Subject ?? ""}\n${full.Text ?? ""}\n${(full.HTML ?? "").replace(/<[^>]+>/g, " ")}`;
      if (!want || text.toLowerCase().includes(want)) return { subject: full.Subject ?? "", text: full.Text ?? "", html: full.HTML ?? "" };
    }
    if (Date.now() > end) throw new Error(want ? `No email to ${mail.address} has "${words}" (waited ${Math.round(timeoutMs / 1000)} seconds).` : `No email came to ${mail.address}.`);
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** The link in an email whose words (or address) have the text; plain-text emails are searched too. */
export function emailLink(email: { html: string; text: string }, words: string): string | undefined {
  const want = words.toLowerCase();
  for (const m of email.html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decode(m[2]);
    const label = decode(m[3].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().toLowerCase();
    if (/^https?:/i.test(href) && (label.includes(want) || href.toLowerCase().includes(want))) return href;
  }
  // A plain-text email: the first address on the line with the words, or the next line.
  const lines = email.text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!line.toLowerCase().includes(want)) continue;
    const url = (line.match(/https?:\/\/\S+/) ?? lines[i + 1]?.match(/https?:\/\/\S+/))?.[0];
    if (url) return url.replace(/[).,>]+$/, "");
  }
  return undefined;
}

async function runStep(page: Page, step: Step, base: string, login?: Login, mail?: Mailbox, signal?: AbortSignal): Promise<void> {
  const t = step.target ?? "";
  switch (step.kind) {
    case "open":
      await page.goto(resolveUrl(t, base), { waitUntil: "load", timeout: 30_000 });
      return;
    case "click":
      await find(page, t, "click").click({ timeout: TIMEOUT });
      await page.waitForLoadState("load", { timeout: TIMEOUT }).catch(() => {});
      return;
    case "fill":
      await find(page, t, "field").fill(fillValue(step.value ?? "", login, mail), { timeout: TIMEOUT });
      return;
    case "select":
      await find(page, t, "field").selectOption({ label: step.value ?? "" }, { timeout: TIMEOUT });
      return;
    case "check":
      await find(page, t, "field").or(page.getByRole("checkbox", { name: t })).first().check({ timeout: TIMEOUT });
      return;
    case "uncheck":
      await find(page, t, "field").or(page.getByRole("checkbox", { name: t })).first().uncheck({ timeout: TIMEOUT });
      return;
    case "press":
      await page.keyboard.press(t);
      await page.waitForLoadState("load", { timeout: TIMEOUT }).catch(() => {});
      return;
    case "hover":
      await find(page, t, "click").hover({ timeout: TIMEOUT });
      return;
    case "see":
      try {
        await find(page, t, "any").waitFor({ state: "visible", timeout: TIMEOUT });
      } catch {
        throw new Error(`"${t}" is not on the page.`);
      }
      return;
    case "not-see":
      if (await find(page, t, "any").isVisible().catch(() => false)) throw new Error(`"${t}" is on the page, and should not be.`);
      return;
    case "url-has":
      if (!page.url().includes(t)) {
        await page.waitForURL((u) => u.href.includes(t), { timeout: TIMEOUT }).catch(() => {
          throw new Error(`The address is ${page.url()}, which does not have "${t}".`);
        });
      }
      return;
    case "title-has": {
      const title = await page.title();
      if (!title.toLowerCase().includes(t.toLowerCase())) throw new Error(`The page title is "${title}", which does not have "${t}".`);
      return;
    }
    case "wait":
      await page.waitForTimeout(Math.min(Number(step.value) || 1, 15) * 1000);
      return;
    case "screenshot":
      return;
    case "email-has":
    case "email-link": {
      if (!mail) throw new Error('Email steps need the test mailbox: turn on "Test mailbox (Mailpit)" in Owner panel > Modules.');
      if (step.kind === "email-has") {
        await waitForEmail(mail, t, 30_000, signal);
        return;
      }
      const email = await waitForEmail(mail, undefined, 30_000, signal);
      const href = emailLink(email, t);
      if (!href) throw new Error(`The email "${email.subject}" has no link with "${t}".`);
      await page.goto(resolveUrl(href, base), { waitUntil: "load", timeout: 30_000 });
      return;
    }
  }
}

/** Follows each journey in its own tab. Returns the results and a finding for each journey that fails. */
export async function runJourneys(
  context: BrowserContext,
  journeys: Journey[],
  opts: { startUrl: string; artifactsDir: string; login?: Login; loggedIn?: boolean; mailUrl?: string; log?: (m: string) => void; signal?: AbortSignal },
): Promise<{ results: JourneyResult[]; findings: Finding[] }> {
  const log = opts.log ?? (() => {});
  const results: JourneyResult[] = [];
  const findings: Finding[] = [];
  for (const [ji, j] of journeys.filter((x) => !x.off).slice(0, MAX_JOURNEYS).entries()) {
    opts.signal?.throwIfAborted();
    const steps = parseSteps(j.steps);
    log(`Journey "${j.name}": ${steps.length} steps${j.allowWrites ? " (may send forms)" : ""}`);
    const mail: Mailbox | undefined = opts.mailUrl
      ? { url: opts.mailUrl, address: `glv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}-${ji}@${process.env.MAIL_DOMAIN || "inbox.glv.test"}` }
      : undefined;
    const page = await context.newPage();
    const guard = j.allowWrites ? undefined : await readOnly(page, { loggedIn: opts.loggedIn });
    const out: JourneyStepResult[] = [];
    const t0 = Date.now();
    let failedAt: JourneyStepResult | undefined;
    try {
      // The journey starts on the site's first page unless its first step opens another one.
      if (steps[0].kind !== "open") await page.goto(opts.startUrl, { waitUntil: "load", timeout: 30_000 });
      for (const [si, step] of steps.entries()) {
        opts.signal?.throwIfAborted();
        const before = guard?.blocked.length ?? 0;
        const started = Date.now();
        const r: JourneyStepResult = { line: step.line, text: shownValue(step), ok: true, ms: 0 };
        try {
          await runStep(page, step, page.url().startsWith("http") ? page.url() : opts.startUrl, opts.login, mail, opts.signal);
        } catch (err) {
          r.ok = false;
          r.error = (err as Error).message.split("\n")[0].replace(/\s*=+\s*logs\s*=+.*$/i, "").slice(0, 300);
        }
        r.ms = Date.now() - started;
        r.url = page.url();
        const blocked = guard?.blocked.slice(before) ?? [];
        if (blocked.length) r.blocked = blocked.slice(0, 5);
        const shot = `journey-${ji}-${si}.jpg`;
        try {
          await page.screenshot({ path: path.join(opts.artifactsDir, shot), type: "jpeg", quality: 55 });
          r.shot = shot;
        } catch {
          // The page closed; the step's result still counts.
        }
        out.push(r);
        if (!r.ok) {
          failedAt = r;
          break;
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      failedAt = { line: 0, text: "Open the first page", ok: false, ms: Date.now() - t0, error: (err as Error).message.split("\n")[0].slice(0, 300) };
      out.push(failedAt);
    } finally {
      await guard?.off();
      await page.close().catch(() => {});
    }
    const res: JourneyResult = { id: j.id, name: j.name, ok: !failedAt, ms: Date.now() - t0, steps: out, total: steps.length, ...(j.allowWrites ? { allowWrites: true } : {}) };
    results.push(res);
    log(`Journey "${j.name}": ${res.ok ? "passed" : `failed at step ${out.length}`}`);
    if (failedAt) {
      const stopped = out.flatMap((st) => st.blocked ?? []);
      const blockedNote = stopped.length
        ? ` The test stopped ${stopped.length} request${stopped.length === 1 ? "" : "s"} that could change data (${stopped[0]}); if the journey needs to send that form, allow it to send forms (only on a staging or test site).`
        : "";
      findings.push(
        finding({
          category: "functional",
          rule: "journey:failed",
          severity: "high",
          title: `User journey "${j.name}" fails at step ${out.length}`,
          detail: `Step ${out.length}, "${failedAt.text}": ${failedAt.error ?? "failed"}.${blockedNote} Open the journey in the report to see a picture after every step.`,
          pageUrl: failedAt.url && failedAt.url.startsWith("http") ? failedAt.url : opts.startUrl,
          evidence: `${j.name}: ${failedAt.text}`,
          agent: "journeys",
        }),
      );
    }
  }
  return { results, findings };
}
