import path from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import { readOnly } from "../agents/web/guard.js";
import { totp } from "../app/totp.js";
import type { WriteCall } from "../agents/types.js";
import { safeRead } from "../app/reads.js";
import type { Finding, HookInbox, Journey, JourneyResult, JourneyStepResult, Login } from "../types.js";
import { finding } from "./finding.js";
import { healLocator } from "./heal.js";

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

export type StepKind = "open" | "click" | "fill" | "select" | "check" | "uncheck" | "press" | "hover" | "see" | "not-see" | "url-has" | "title-has" | "wait" | "screenshot" | "email-has" | "email-link" | "webhook-has";

export interface Step {
  line: number;
  text: string;
  kind: StepKind;
  target?: string;
  value?: string;
}

const MAX_STEPS = 40;
export const MAX_JOURNEYS = 10;
/** Rows of test data a journey runs with, and runs in all. */
export const MAX_ROWS = 20;
const MAX_RUNS = 40;
const DATA_KEY = /^[a-z][\w]{0,30}$/i;
const RESERVED = /^(username|user|email|password|inbox|webhook|code|random|today|role)$/i;

/** Reads a small CSV table: the first row names the columns. Quotes allow commas inside a value. */
export function parseTable(text: string): { columns: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      if (row.some((c) => c)) lines.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) lines.push(row);
  if (!lines.length) return { columns: [], rows: [] };
  const columns = lines[0].map((c) => c.replace(/^\{\{\s*|\s*\}\}$/g, ""));
  for (const c of columns) {
    if (!DATA_KEY.test(c)) throw new Error(`Test data: the column name "${c}" can only have letters, numbers and _ (like phone or lead_name).`);
    if (RESERVED.test(c)) throw new Error(`Test data: "${c}" is already a word journeys use; name the column differently.`);
  }
  const rows = lines.slice(1).map((l) => Object.fromEntries(columns.map((c, i) => [c.toLowerCase(), (l[i] ?? "").slice(0, 500)])));
  if (rows.length > MAX_ROWS) throw new Error(`Test data: up to ${MAX_ROWS} rows (it has ${rows.length}).`);
  return { columns, rows };
}

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
  [/^webhook\s+(?:has|contains)\s+(.+)$/i, "webhook-has"],
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
        `Line ${i + 1} ("${line.slice(0, 60)}") is not a step. Start it with open, click, fill … = …, select … = …, check, press, hover, see, not see, url has, title has, wait, screenshot, email has, open email link or webhook has.`,
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
  const role = String(input.role ?? "").replace(/[^\w-]/g, "").slice(0, 20);
  const cleanup = String(input.cleanup ?? "").slice(0, 3000).trim();
  const data = String(input.data ?? "").slice(0, 20_000).trim();
  if (data) {
    try {
      const t = parseTable(data);
      if (!t.rows.length) throw new Error("Test data: add at least one row under the column names.");
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`);
    }
  }
  if (cleanup) {
    try {
      parseSteps(cleanup);
    } catch (err) {
      throw new Error(`${name}, clean-up: ${(err as Error).message}`);
    }
  }
  return {
    id: String(input.id ?? "").replace(/[^\w-]/g, "").slice(0, 20) || `j${Date.now().toString(36)}${i}`,
    name,
    steps,
    ...(input.allowWrites ? { allowWrites: true } : {}),
    ...(input.off ? { off: true } : {}),
    ...(role ? { role } : {}),
    ...(cleanup ? { cleanup } : {}),
    ...(data ? { data } : {}),
  };
}

/**
 * Words in {{ }} that a step can use:
 * {{username}} and {{password}} come from the saved login (the password is never shown), {{code}} is
 * the two-step code made from the saved secret, {{inbox}} the journey's test mailbox address,
 * {{webhook}} the project's webhook inbox address, {{random}} a short made-up word that is the
 * same for the whole journey (to name a test record and find it again), {{today}} today's date.
 */
export interface StepVars {
  login?: Login;
  mail?: Mailbox;
  hook?: HookInbox;
  random: string;
  role?: string;
  /** This run's row of test data, by column name (lower case). */
  data?: Record<string, string>;
}

export const newVars = (v: Omit<StepVars, "random">): StepVars => ({ ...v, random: `glv${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}` });

export function fillValue(value: string, v: StepVars): string {
  if (/\{\{\s*inbox\s*\}\}/i.test(value) && !v.mail) throw new Error("{{inbox}} needs the test mailbox: turn on \"Test mailbox (Mailpit)\" in Owner panel > Modules.");
  if (/\{\{\s*webhook\s*\}\}/i.test(value) && !v.hook) throw new Error("{{webhook}} needs the webhook inbox: open it on the project page first.");
  if (/\{\{\s*code\s*\}\}/i.test(value) && !v.login?.totpSecret) throw new Error("{{code}} needs the two-step secret in the saved login.");
  if (v.data) value = value.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => v.data![k.toLowerCase()] ?? all);
  return value.replace(/\{\{\s*(username|user|email|password|inbox|webhook|code|random|today|role)\s*\}\}/gi, (_, k: string) => {
    switch (k.toLowerCase()) {
      case "password":
        return v.login?.password ?? "";
      case "inbox":
        return v.mail?.address ?? "";
      case "webhook":
        return v.hook?.address ?? "";
      case "code":
        return totp(v.login!.totpSecret!);
      case "random":
        return v.random;
      case "today":
        return new Date().toISOString().slice(0, 10);
      case "role":
        return v.role ?? v.login?.roleName ?? "";
      default:
        return v.login?.username ?? "";
    }
  });
}

/** Fills the words a step looks for or clicks: test data columns and {{random}}, {{today}}, {{role}}, {{username}}. Never a password or code. */
export function fillTarget(target: string, v: StepVars): string {
  if (!target.includes("{{")) return target;
  if (v.data) target = target.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => v.data![k.toLowerCase()] ?? all);
  return target.replace(/\{\{\s*(username|user|email|random|today|role)\s*\}\}/gi, (_, k: string) => {
    switch (k.toLowerCase()) {
      case "random":
        return v.random;
      case "today":
        return new Date().toISOString().slice(0, 10);
      case "role":
        return v.role ?? v.login?.roleName ?? "";
      default:
        return v.login?.username ?? "";
    }
  });
}

function shownValue(step: Step, vars?: StepVars): string {
  if (/\{\{\s*(password|code)\s*\}\}/i.test(step.value ?? "")) return step.text.replace(/=.*$/, "= ••••••");
  if (!vars || !(/\{\{\s*(random|today|role|inbox|webhook)\s*\}\}/i.test(step.text) || (vars.data && /\{\{\s*\w+\s*\}\}/.test(step.text)))) return step.text;
  try {
    return fillValue(step.text, { ...vars, login: vars.login ? { ...vars.login, password: "••••••" } : undefined });
  } catch {
    return step.text;
  }
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
    // Buttons and links first, in that order: a heading with the same words must not win.
    const kinds = [
      page.getByRole("button", name),
      page.getByRole("link", name),
      page.getByRole("menuitem", name),
      page.getByRole("tab", name),
      page.getByLabel(target),
    ];
    return kinds.reduce<Locator>((all, k) => all.or(k), byText).first();
  }
  return byText.first();
}

/** A button or link with the words, in that order of preference; any text with them only when there is none. */
async function findClick(page: Page, target: string): Promise<Locator> {
  if (/^(css|xpath)=/i.test(target) || /^[#.[]/.test(target)) return find(page, target, "click");
  const name = { name: target };
  for (const k of [page.getByRole("button", name), page.getByRole("link", name), page.getByRole("menuitem", name), page.getByRole("tab", name), page.getByLabel(target)]) {
    const first = k.first();
    if (await first.isVisible().catch(() => false)) return first;
  }
  // Nothing yet: wait for any of them (the screen may still be drawing).
  return find(page, target, "click");
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

/**
 * Runs an action on the step's element; when the element is not found the usual way, the closest
 * match is used instead (self-healing) and noted in `healed`, so the journey can be updated.
 */
async function withHeal(page: Page, t: string, kind: "click" | "field", first: () => Promise<Locator>, action: (l: Locator) => Promise<unknown>, healed?: string[]): Promise<void> {
  const primary = await first();
  try {
    await action(primary);
  } catch (err) {
    if (!healed || !/Timeout|not found|waiting for|strict mode/i.test((err as Error).message)) throw err;
    const alt = await healLocator(page, t, kind);
    if (!alt) throw err;
    await action(alt.locator);
    healed.push(`"${t}" was not found; used ${alt.how} instead`);
  }
}

export async function runStep(page: Page, step: Step, base: string, vars: StepVars, signal?: AbortSignal, since = new Date().toISOString(), healed?: string[]): Promise<void> {
  const mail = vars.mail;
  const t = fillTarget(step.target ?? "", vars);
  switch (step.kind) {
    case "open":
      await page.goto(resolveUrl(t, base), { waitUntil: "load", timeout: 30_000 });
      return;
    case "click":
      await withHeal(page, t, "click", () => findClick(page, t), (l) => l.click({ timeout: TIMEOUT }), healed);
      await page.waitForLoadState("load", { timeout: TIMEOUT }).catch(() => {});
      return;
    case "fill":
      await withHeal(page, t, "field", async () => find(page, t, "field"), (l) => l.fill(fillValue(step.value ?? "", vars), { timeout: TIMEOUT }), healed);
      return;
    case "select":
      await withHeal(page, t, "field", async () => find(page, t, "field"), (l) => l.selectOption({ label: step.value ?? "" }, { timeout: TIMEOUT }), healed);
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
      await withHeal(page, t, "click", () => findClick(page, t), (l) => l.hover({ timeout: TIMEOUT }), healed);
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
    case "webhook-has": {
      if (!vars.hook) throw new Error("Webhook steps need the webhook inbox: open it on the project page first.");
      const want = t.toLowerCase();
      const end = Date.now() + 30_000;
      for (;;) {
        signal?.throwIfAborted();
        if (vars.hook.since(since).some((m) => `${m.method} ${m.body}`.toLowerCase().includes(want))) return;
        if (Date.now() > end) throw new Error(`No webhook with "${t}" came to the inbox (waited 30 seconds).`);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
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

/** A browser signed in as one of the project's roles, for journeys that run as that role. */
export type RoleSession = { context: BrowserContext; login: Login; name: string };

const isAppCall = (type: string) => type === "fetch" || type === "xhr";

/** Follows each journey in its own tab. Returns the results and a finding for each journey that fails. */
export async function runJourneys(
  context: BrowserContext,
  journeys: Journey[],
  opts: {
    startUrl: string;
    artifactsDir: string;
    login?: Login;
    loggedIn?: boolean;
    mailUrl?: string;
    hook?: HookInbox;
    log?: (m: string) => void;
    signal?: AbortSignal;
    /** Signs in as a role, for journeys with `role`. */
    roleSession?: (roleId: string) => Promise<RoleSession>;
  },
): Promise<{ results: JourneyResult[]; findings: Finding[]; writes: WriteCall[] }> {
  const log = opts.log ?? (() => {});
  const results: JourneyResult[] = [];
  const findings: Finding[] = [];
  const writes: WriteCall[] = [];
  const startHost = (() => {
    try {
      return new URL(opts.startUrl).host;
    } catch {
      return "";
    }
  })();
  // A journey with test data runs once per row.
  const runs: { j: Journey; row?: number; data?: Record<string, string> }[] = [];
  for (const j of journeys.filter((x) => !x.off).slice(0, MAX_JOURNEYS)) {
    const rows = j.data ? parseTable(j.data).rows : [];
    if (!rows.length) runs.push({ j });
    else for (const [i, data] of rows.entries()) runs.push({ j: { ...j, name: `${j.name} (row ${i + 1}${Object.values(data)[0] ? `: ${Object.values(data)[0].slice(0, 30)}` : ""})` }, row: i + 1, data });
  }
  for (const [ji, { j, row, data }] of runs.slice(0, MAX_RUNS).entries()) {
    opts.signal?.throwIfAborted();
    const steps = parseSteps(j.steps);
    const cleanup = j.cleanup?.trim() ? parseSteps(j.cleanup) : [];
    let ctx = context;
    let login = opts.login;
    let roleName: string | undefined;
    const t0 = Date.now();
    if (j.role && opts.roleSession) {
      try {
        const r = await opts.roleSession(j.role);
        ctx = r.context;
        login = r.login;
        roleName = r.name;
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const error = (err as Error).message.split("\n")[0].slice(0, 300);
        results.push({ id: row ? `${j.id}-r${row}` : j.id, name: j.name, ok: false, ms: Date.now() - t0, steps: [{ line: 0, text: "Sign in as the role", ok: false, ms: 0, error }], total: steps.length, role: j.role });
        findings.push(
          finding({
            category: "functional",
            rule: "journey:failed",
            severity: "high",
            title: `User journey "${j.name}" could not sign in as its role`,
            detail: `${error} Check the role's login on the project page.`,
            pageUrl: opts.startUrl,
            evidence: `${j.name}: sign in as the role`,
            agent: "journeys",
          }),
        );
        continue;
      }
    }
    log(`Journey "${j.name}"${roleName ? ` as ${roleName}` : ""}: ${steps.length} steps${cleanup.length ? ` and ${cleanup.length} clean-up steps` : ""}${j.allowWrites ? " (may send forms)" : ""}`);
    const mail: Mailbox | undefined = opts.mailUrl
      ? { url: opts.mailUrl, address: `glv-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}-${ji}@${process.env.MAIL_DOMAIN || "inbox.glv.test"}` }
      : undefined;
    const vars = newVars({ login, mail, hook: opts.hook, role: roleName, ...(data ? { data } : {}) });
    const since = new Date().toISOString();
    const page = await ctx.newPage();
    const guard = j.allowWrites ? undefined : await readOnly(page, { loggedIn: opts.loggedIn || Boolean(roleName) });
    // The app's own calls while each step runs, for the step-by-step replay.
    let stepCalls: NonNullable<JourneyStepResult["calls"]> = [];
    const onCall = async (req: import("playwright").Request) => {
      if (!isAppCall(req.resourceType())) return;
      const res = await req.response().catch(() => null);
      const t = req.timing();
      if (stepCalls.length < 20) stepCalls.push({ method: req.method(), url: req.url().slice(0, 300), status: res?.status() ?? 0, ms: Math.max(0, Math.round(t.responseEnd)) });
    };
    page.on("requestfinished", onCall);
    page.on("requestfailed", onCall);
    // On a test server, the saves this journey makes are kept, to try them again as the other accounts.
    let inCleanup = false;
    // Kept when the answer's headers arrive: a save whose body never finishes loading still counts.
    const onWrite = (res: import("playwright").Response) => {
      const req = res.request();
      const method = req.method();
      if (inCleanup || method === "GET" || method === "HEAD" || method === "OPTIONS" || writes.length >= 30) return;
      let u: URL;
      try {
        u = new URL(req.url());
      } catch {
        return;
      }
      if (u.host !== startHost || /\b(log_?in|log_?out|sign_?in|sign_?out|session|auth|oauth|token|2fa|otp|password)\b/i.test(u.pathname)) return;
      const body = req.postData() ?? undefined;
      const type = req.headers()["content-type"] ?? "";
      if (safeRead(method, req.url(), body, type)) return;
      let pageUrl = page.url();
      try {
        pageUrl = req.frame().url();
      } catch {
        // A worker's call: the page's address will do.
      }
      writes.push({ method, url: req.url(), status: res.status(), ...(body && body.length <= 20_000 ? { body, contentType: type } : {}), pageUrl, journey: j.name });
    };
    if (j.allowWrites) page.on("response", onWrite);
    const out: JourneyStepResult[] = [];
    let failedAt: JourneyStepResult | undefined;
    const doStep = async (step: Step, n: number, isCleanup: boolean): Promise<JourneyStepResult> => {
      inCleanup = isCleanup;
      const before = guard?.blocked.length ?? 0;
      const started = Date.now();
      stepCalls = [];
      const r: JourneyStepResult = { line: step.line, text: shownValue(step, vars), ok: true, ms: 0, ...(isCleanup ? { cleanup: true } : {}) };
      const healedNotes: string[] = [];
      try {
        await runStep(page, step, page.url().startsWith("http") ? page.url() : opts.startUrl, vars, opts.signal, since, healedNotes);
        if (healedNotes.length) {
          r.healed = healedNotes[0];
          findings.push(
            finding({
              category: "functional",
              rule: "journey:healed",
              severity: "low",
              title: `Journey "${j.name}" healed a step: update it`,
              detail: `Step "${step.text}" no longer matched the page, so the journey found the closest button or field instead and went on. ${healedNotes[0]}. If that is the right one, change the step's words so it matches exactly; if not, the page changed and the journey may test the wrong thing.`,
              pageUrl: page.url().startsWith("http") ? page.url() : opts.startUrl,
              evidence: `${j.name}, line ${step.line}: ${healedNotes[0]}`,
              agent: "journeys",
            }),
          );
        }
        // Let the screen's own calls finish, so they count towards this step.
        await page.waitForLoadState("networkidle", { timeout: 2_000 }).catch(() => {});
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        r.ok = false;
        r.error = (err as Error).message.split("\n")[0].replace(/\s*=+\s*logs\s*=+.*$/i, "").slice(0, 300);
      }
      r.ms = Date.now() - started;
      r.url = page.url();
      const blocked = guard?.blocked.slice(before) ?? [];
      if (blocked.length) r.blocked = blocked.slice(0, 5);
      if (stepCalls.length) r.calls = stepCalls;
      const shot = `journey-${ji}-${n}.jpg`;
      try {
        await page.screenshot({ path: path.join(opts.artifactsDir, shot), type: "jpeg", quality: 55 });
        r.shot = shot;
      } catch {
        // The page closed; the step's result still counts.
      }
      out.push(r);
      return r;
    };
    try {
      try {
        // The journey starts on the site's first page unless its first step opens another one.
        if (steps[0].kind !== "open") await page.goto(opts.startUrl, { waitUntil: "load", timeout: 30_000 });
        for (const [si, step] of steps.entries()) {
          opts.signal?.throwIfAborted();
          const r = await doStep(step, si, false);
          if (!r.ok) {
            failedAt = r;
            break;
          }
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        failedAt = { line: 0, text: "Open the first page", ok: false, ms: Date.now() - t0, error: (err as Error).message.split("\n")[0].slice(0, 300) };
        out.push(failedAt);
      }
      // Clean-up always runs, so a failed journey does not leave its test record behind.
      for (const [ci, step] of cleanup.entries()) {
        opts.signal?.throwIfAborted();
        const r = await doStep(step, steps.length + ci, true);
        if (!r.ok) {
          findings.push(
            finding({
              category: "functional",
              rule: "journey:cleanup-failed",
              severity: "medium",
              title: `Clean-up of journey "${j.name}" fails`,
              detail: `Clean-up step "${r.text}": ${r.error ?? "failed"}. The test data it should remove may still be in the app; remove it by hand.`,
              pageUrl: r.url && r.url.startsWith("http") ? r.url : opts.startUrl,
              evidence: `${j.name}: ${r.text}`,
              agent: "journeys",
            }),
          );
          break;
        }
      }
    } finally {
      page.off("requestfinished", onCall);
      page.off("requestfailed", onCall);
      page.off("response", onWrite);
      await guard?.off();
      await page.close().catch(() => {});
    }
    const res: JourneyResult = {
      id: row ? `${j.id}-r${row}` : j.id,
      name: j.name,
      ok: !failedAt,
      ms: Date.now() - t0,
      steps: out,
      total: steps.length + cleanup.length,
      ...(j.allowWrites ? { allowWrites: true } : {}),
      ...(roleName ? { role: roleName } : {}),
      ...(row ? { row } : {}),
    };
    results.push(res);
    const failedNo = failedAt ? out.indexOf(failedAt) + 1 : 0;
    log(`Journey "${j.name}": ${res.ok ? "passed" : `failed at step ${failedNo}`}`);
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
          title: `User journey "${j.name}"${roleName ? ` (as ${roleName})` : ""} fails at step ${failedNo}`,
          detail: `Step ${failedNo}, "${failedAt.text}": ${failedAt.error ?? "failed"}.${blockedNote} Open the journey in the report to replay it step by step.`,
          pageUrl: failedAt.url && failedAt.url.startsWith("http") ? failedAt.url : opts.startUrl,
          evidence: `${j.name}: ${failedAt.text}`,
          agent: "journeys",
        }),
      );
    }
  }
  return { results, findings, writes };
}
