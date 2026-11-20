import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import type { SiteAgent } from "../agents/types.js";
import { aiEnabled } from "../ai/triage.js";
import { finding } from "../runner/finding.js";
import type { Finding, FormFill } from "../types.js";
import { APPS } from "./calls.js";
import { change } from "./changes.js";
import { DANGER_WORDS } from "./explore.js";

/*
 * Claude filling forms by itself, on a test copy only: on each screen the explorer found, the
 * test reads the forms (labels, types, required fields, choices), Claude picks realistic values
 * that fit them (an Indian phone number for a phone field, a GST number for a GSTIN field...),
 * the form is sent, and the result is read: saved, refused with the form's own message, or a
 * server error. Without an API key the built-in filler picks the values. Every text value starts
 * with "GLV test", so the records the test makes are easy to find and delete.
 */

export interface FormField {
  /** CSS selector of the field inside the form. */
  selector: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  pattern?: string;
  min?: string;
  max?: string;
  maxLength?: number;
  placeholder?: string;
}

export interface FoundForm {
  /** Selector of the form on the page. */
  selector: string;
  /** What the form is, from its heading or button. */
  name: string;
  fields: FormField[];
  /** The button that sends it. */
  submit?: string;
  method: string;
  hasFile: boolean;
}

/** Marks every form and field on the page and reads them (labels, types, rules). */
export const FORMS_JS = `(function () {
  function labelOf(el) {
    var l = "";
    if (el.id) { var f = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (f) l = f.innerText; }
    if (!l && el.closest("label")) l = el.closest("label").innerText;
    if (!l) l = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "";
    return l.replace(/\\s+/g, " ").trim().slice(0, 80);
  }
  function shown(el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; }
  var out = [];
  var forms = document.querySelectorAll("form");
  for (var i = 0; i < forms.length && out.length < 10; i++) {
    var form = forms[i];
    if (!shown(form)) continue;
    form.setAttribute("data-glv-form", String(i));
    var fields = [], n = 0, hasFile = false;
    var els = form.querySelectorAll("input, select, textarea");
    for (var j = 0; j < els.length && fields.length < 40; j++) {
      var el = els[j];
      var type = (el.tagName === "INPUT" ? (el.getAttribute("type") || "text") : el.tagName.toLowerCase()).toLowerCase();
      if (/^(hidden|submit|button|reset|image)$/.test(type)) continue;
      if (type === "file") hasFile = true;
      if (!shown(el) && type !== "file") continue;
      if (el.disabled || el.readOnly) continue;
      el.setAttribute("data-glv-field", String(n));
      var f = { selector: '[data-glv-field="' + n + '"]', name: el.getAttribute("name") || el.id || "", label: labelOf(el), type: type, required: el.required || el.getAttribute("aria-required") === "true" };
      n++;
      if (el.tagName === "SELECT") f.options = Array.from(el.options).map(function (o) { return o.value; }).filter(function (v) { return v !== ""; }).slice(0, 30);
      if (type === "radio") { if (fields.some(function (x) { return x.type === "radio" && x.name === f.name; })) continue; f.options = Array.from(form.querySelectorAll('input[type=radio][name="' + CSS.escape(f.name) + '"]')).map(function (r) { return r.value; }).slice(0, 20); }
      if (el.getAttribute("pattern")) f.pattern = el.getAttribute("pattern");
      if (el.getAttribute("min")) f.min = el.getAttribute("min");
      if (el.getAttribute("max")) f.max = el.getAttribute("max");
      if (el.maxLength > 0) f.maxLength = el.maxLength;
      if (el.getAttribute("placeholder")) f.placeholder = el.getAttribute("placeholder").slice(0, 60);
      fields.push(f);
    }
    var btn = form.querySelector('button[type=submit], input[type=submit], button:not([type])');
    if (btn) btn.setAttribute("data-glv-submit", String(i));
    var head = form.querySelector("h1, h2, h3, legend");
    var name = ((head && head.innerText) || (btn && (btn.innerText || btn.value)) || form.getAttribute("aria-label") || form.getAttribute("name") || form.id || ("Form " + (i + 1))).replace(/\\s+/g, " ").trim().slice(0, 60);
    out.push({ selector: '[data-glv-form="' + i + '"]', name: name, fields: fields, submit: btn ? '[data-glv-submit="' + i + '"]' : undefined, method: (form.getAttribute("method") || "get").toLowerCase(), hasFile: hasFile, button: btn ? (btn.innerText || btn.value || "").trim().slice(0, 40) : "" });
  }
  return out;
})()`;

export async function readForms(page: Page | Frame): Promise<(FoundForm & { button?: string })[]> {
  return ((await page.evaluate(FORMS_JS).catch(() => [])) as (FoundForm & { button?: string })[]) ?? [];
}

/** A form worth filling: it saves something (not search, sign-in, sign-out or a dangerous action). */
export function fillable(f: FoundForm & { button?: string }): boolean {
  if (f.fields.length === 0) return false;
  if (f.fields.some((x) => x.type === "password")) return false;
  if (f.method === "get" && !f.fields.some((x) => x.required)) return false;
  if (f.fields.length === 1 && /search|find|filter|q$/i.test(`${f.fields[0].name} ${f.fields[0].label}`)) return false;
  return !DANGER_WORDS.test(`${f.name} ${f.button ?? ""}`.replace(/\b(save|submit|send)\b/gi, "")) && !/\b(sign|log)\s?(in|out)\b/i.test(`${f.name} ${f.button ?? ""}`);
}

const stamp = () => new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");

/** The built-in filler: a value that fits each field's type, name and rules. */
export function fillerValue(f: FormField, n: number): string {
  const key = `${f.name} ${f.label} ${f.placeholder ?? ""}`.toLowerCase();
  if (f.options?.length) return f.options[Math.min(1, f.options.length - 1)] ?? f.options[0];
  switch (f.type) {
    case "email":
      return `glv.test+${stamp()}${n}@example.com`;
    case "tel":
      return "+91 98765 43210";
    case "number":
    case "range": {
      const min = Number(f.min ?? 1);
      const max = Number(f.max ?? min + 100);
      return String(Math.max(min, Math.min(max, Number.isFinite(min) ? min + 1 : 1)));
    }
    case "date":
      return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    case "datetime-local":
      return new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16);
    case "time":
      return "10:30";
    case "url":
      return "https://example.com/glv-test";
    case "checkbox":
      return "on";
    case "color":
      return "#3366ff";
  }
  if (/e-?mail/.test(key)) return `glv.test+${stamp()}${n}@example.com`;
  if (/phone|mobile|whatsapp|contact no/.test(key)) return "+91 98765 43210";
  if (/gst/.test(key)) return "27AAPFU0939F1ZV";
  if (/\bpan\b/.test(key)) return "AAAPA1234A";
  if (/pin ?code|postal|zip/.test(key)) return "160104";
  if (/city/.test(key)) return "Zirakpur";
  if (/state/.test(key)) return "Punjab";
  if (/country/.test(key)) return "India";
  if (/company|organi[sz]ation|business/.test(key)) return "GLV test company";
  if (/first ?name/.test(key)) return "GLV test";
  if (/last ?name|surname/.test(key)) return "Asha";
  if (/amount|price|cost|qty|quantity/.test(key)) return "1";
  if (/website|url/.test(key)) return "https://example.com/glv-test";
  const text = f.type === "textarea" ? `GLV test: made by the testing agent on ${new Date().toISOString().slice(0, 10)}. Safe to delete.` : `GLV test ${f.label || f.name || "value"}`.slice(0, 60);
  return f.maxLength ? text.slice(0, f.maxLength) : text;
}

const ValuesSchema = z.object({
  values: z.array(z.object({ field: z.number().describe("The field's number from the list."), value: z.string() })),
});

/** Claude picks realistic values for a form's fields. */
export async function claudeValues(form: FoundForm, pageTitle: string): Promise<string[] | undefined> {
  if (!aiEnabled()) return undefined;
  const client = new Anthropic();
  const list = form.fields
    .map((f, i) => `${i}. ${f.label || f.name} (type ${f.type}${f.required ? ", required" : ""}${f.options ? `, choices: ${f.options.slice(0, 15).join(" | ")}` : ""}${f.pattern ? `, pattern ${f.pattern}` : ""}${f.maxLength ? `, at most ${f.maxLength} characters` : ""}${f.min ? `, min ${f.min}` : ""}${f.max ? `, max ${f.max}` : ""})`)
    .join("\n");
  const response = await client.beta.messages.parse({
    model: process.env.CLAUDE_MODEL || "claude-opus-5-5",
    max_tokens: 4000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(ValuesSchema) },
    messages: [
      {
        role: "user",
        content: `A testing tool fills a form on a test copy of a business app (screen: "${pageTitle.slice(0, 80)}", form: "${form.name}"). Give one realistic, valid value per field, as a real user in India would enter it. Every free-text value must start with "GLV test" so test records are easy to find. Use example.com for emails, and only choices from the list for choice fields. For checkboxes give "on" or "off".\n\nFields:\n${list}`,
      },
    ],
  });
  if (response.stop_reason === "refusal" || !response.parsed_output) return undefined;
  const out = form.fields.map((f, i) => fillerValue(f, i));
  for (const v of response.parsed_output.values) if (v.field >= 0 && v.field < out.length) out[v.field] = v.value.slice(0, 500);
  return out;
}

/** Puts the values in the form's fields. */
export async function fillForm(scope: Page | Frame, form: FoundForm, values: string[]): Promise<void> {
  for (const [i, f] of form.fields.entries()) {
    const v = values[i];
    const el: Locator = scope.locator(`${form.selector} ${f.selector}`).first();
    try {
      if (f.type === "file") continue;
      if (f.type === "checkbox") {
        if (v !== "off" && (f.required || v === "on")) await el.check({ timeout: 2_000 });
      } else if (f.type === "radio") {
        await scope.locator(`${form.selector} input[type=radio][name="${f.name.replace(/"/g, '\\"')}"][value="${v.replace(/"/g, '\\"')}"]`).first().check({ timeout: 2_000 });
      } else if (f.type === "select") {
        await el.selectOption(v, { timeout: 2_000 });
      } else {
        await el.fill(v, { timeout: 2_000 });
      }
    } catch {
      // A field that will not take the value: the form says so when it is sent.
    }
  }
}

export interface SendResult {
  status?: number;
  outcome: FormFill["outcome"];
  message?: string;
}

const ERROR_TEXT = /\b(internal server error|server error|something went wrong|exception|traceback|stack trace|fatal error|500)\b/i;
const MESSAGE = '[role="alert"], .error, .errors, .alert-danger, .alert-error, .invalid-feedback, .text-danger, .help-block.error, .field-error, .is-invalid ~ *, .toast, .notification, .alert-success, .alert, .flash';

/** Sends the form and reads what happened: the answer to the send, the address, and the message shown. */
export async function sendForm(page: Page, scope: Page | Frame, form: FoundForm): Promise<SendResult> {
  const before = page.url();
  let status: number | undefined;
  const watch = (r: import("playwright").Response) => {
    const m = r.request().method();
    if (m !== "GET" && m !== "HEAD" && ["document", "fetch", "xhr"].includes(r.request().resourceType())) status = r.status();
  };
  page.on("response", watch);
  try {
    const btn = form.submit ? scope.locator(form.submit).first() : undefined;
    if (btn && (await btn.isVisible().catch(() => false))) await btn.click({ timeout: 5_000 });
    else await scope.locator(form.selector).first().evaluate((f) => (f as HTMLFormElement).requestSubmit()).catch(() => {});
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    await page.waitForTimeout(500);
  } finally {
    page.off("response", watch);
  }
  const msgEl = page.locator(MESSAGE).first();
  const message = (await msgEl.isVisible().catch(() => false)) ? (await msgEl.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200) : undefined;
  const body = (await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).slice(0, 4000);
  const invalid = await scope.locator(`${form.selector} :invalid`).count().catch(() => 0);
  if ((status ?? 0) >= 500 || (ERROR_TEXT.test(body) && !ERROR_TEXT.test(message ?? "__") && /server error|exception|traceback|fatal error/i.test(body))) return { status, outcome: "server-error", message: message ?? body.match(ERROR_TEXT)?.[0] };
  if (invalid > 0 && status === undefined) return { status, outcome: "refused", message: message ?? `${invalid} field(s) the browser itself would not accept` };
  if ((status ?? 0) >= 400 || (message && /\b(error|invalid|required|must|cannot|failed|not valid|wrong)\b/i.test(message))) return { status, outcome: "refused", message };
  if (status !== undefined || page.url() !== before || (message && /\b(saved|created|added|success|thank|submitted|updated)\b/i.test(message))) return { status, outcome: "saved", message };
  return { status, outcome: "no-change", message };
}

export const formFillAgent: SiteAgent = {
  id: "app.form-fill",
  needsConsent: true,
  name: "Claude fills the forms (test copy)",
  description:
    "On a test copy only: reads each form on the screens the explorer found, has Claude (or the built-in filler, without an API key) choose realistic values, sends it, and reports forms that fail with a server error, refuse valid values, or do nothing. Text values start with \"GLV test\" so the records are easy to delete.",
  category: "functional",
  engine: "web",
  products: APPS,
  stage: "site",
  needsLogin: true,
  runsLast: "signed-in",
  async run(ctx) {
    const { site, browser, pages, log, artifactsDir } = ctx;
    const c = change(site, "Claude filling forms");
    if (!c) return [];
    if (!site.consent?.testCopy) {
      c.skip("Only on a project marked as a test copy: forms make real records.");
      return [];
    }
    const out: Finding[] = [];
    const screens = [...new Set([...(site.screens ?? []).map((s) => s.url), ...pages.filter((p) => !p.error && (p.status ?? 0) < 400).map((p) => p.url)])].slice(0, 25);
    const fills: FormFill[] = (site.forms ??= []);
    let made = 0;
    const page = await browser.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => {}));
    page.on("popup", (p) => void p.close().catch(() => {}));
    try {
      for (const url of screens) {
        if (fills.length >= 8) break;
        site.signal?.throwIfAborted();
        await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
        const forms = (await readForms(page)).filter(fillable).filter((f) => !f.hasFile);
        for (const form of forms.slice(0, 2)) {
          if (fills.length >= 8) break;
          const key = `${new URL(url).pathname}|${form.name}`;
          if (fills.some((x) => `${new URL(x.pageUrl).pathname}|${x.form}` === key)) continue;
          // The page may have changed since the forms were read: read them again.
          await page.goto(url, { waitUntil: "load", timeout: 20_000 }).catch(() => {});
          const again = (await readForms(page)).find((f) => f.name === form.name) ?? form;
          let by: FormFill["by"] = "filler";
          let values = again.fields.map((f, i) => fillerValue(f, i));
          try {
            const ai = await claudeValues(again, await page.title());
            if (ai) {
              values = ai;
              by = "claude";
            }
          } catch (err) {
            log(`Claude could not choose values (${(err as Error).message.split("\n")[0]}); using the built-in filler`);
          }
          log(`Filling "${again.name}" on ${new URL(url).pathname} (${by === "claude" ? "values by Claude" : "built-in filler"})`);
          await fillForm(page, again, values);
          const sent = await sendForm(page, page, again);
          const shot = `form-${fills.length + 1}.jpg`;
          await page.screenshot({ path: path.join(artifactsDir, shot), type: "jpeg", quality: 60 }).catch(() => {});
          fills.push({ pageUrl: url, form: again.name, by, fields: again.fields.map((f, i) => ({ name: f.name, label: f.label, type: f.type, value: f.type === "password" ? "••••" : values[i] })), status: sent.status, outcome: sent.outcome, message: sent.message, shot });
          if (sent.outcome === "saved") made++;
          const evidence = again.fields.slice(0, 8).map((f, i) => `${f.label || f.name}: ${values[i]}`).join("\n") + (sent.message ? `\nThe screen said: ${sent.message}` : "");
          if (sent.outcome === "server-error") {
            out.push(finding({ category: "functional", rule: "app:form-server-error", severity: "high", title: `"${again.name}" fails with a server error`, detail: `The form was filled with realistic values${by === "claude" ? " chosen by Claude" : ""} and sent; the app answered with a server error${sent.status ? ` (HTTP ${sent.status})` : ""}. Users who enter the same kind of data cannot save. The server's log at the time of the test shows the cause.`, pageUrl: url, evidence, agent: "app.form-fill" }));
          } else if (sent.outcome === "no-change") {
            out.push(finding({ category: "functional", rule: "app:form-no-response", severity: "low", title: `"${again.name}" does nothing when sent`, detail: "The form was filled and its button pressed, but nothing was sent, no message appeared and the screen did not change. Users cannot tell whether it worked. Check the button's click handler and show a message after saving.", pageUrl: url, evidence, agent: "app.form-fill" }));
          } else if (sent.outcome === "refused" && by === "claude") {
            out.push(finding({ category: "functional", rule: "app:form-refuses-valid", severity: "info", title: `"${again.name}" refused values that look valid`, detail: `Claude filled it with values that fit each field's label and rules, and the form refused them${sent.message ? `: "${sent.message}"` : ""}. Check the rule is right (a phone with +91, a 6-digit PIN code), or show which field is wrong.`, pageUrl: url, evidence, agent: "app.form-fill" }));
          }
        }
      }
    } finally {
      await page.close().catch(() => {});
    }
    c.ran();
    if (made) c.left(`${made} record${made === 1 ? "" : "s"} saved by forms, with text starting "GLV test": search for "GLV test" in the app to delete them.`);
    return out;
  },
};
