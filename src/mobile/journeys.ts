/*
 * App journeys: steps written in plain words for a mobile app, one per line, run on the test phone
 * on every test. The tester writes them, so they may tap anything (Pay, Delete): run them on a
 * test copy of the app's server.
 *
 *   tap "Sign in"            tap id:login_button
 *   type "Email" {{username}}  type "Password" {{password}}  type "Search" "shoes"
 *   see "Welcome"            not see "Error"
 *   back   swipe up   wait 2   rotate   relaunch
 */
import type { AppJourney } from "../types.js";
import { sleep, type AppRunner } from "./runner.js";
import type { UiElement, UiScreen } from "./screen.js";

export type JourneyStep =
  | { kind: "tap"; target: string; byId: boolean }
  | { kind: "type"; field: string; value: string }
  | { kind: "see" | "not-see"; text: string }
  | { kind: "back" | "relaunch" | "rotate" }
  | { kind: "swipe"; dir: "up" | "down" | "left" | "right" }
  | { kind: "wait"; seconds: number };

export const MAX_APP_JOURNEYS = 20;
export const MAX_APP_STEPS = 40;

const quoted = /"((?:[^"\\]|\\.)*)"/g;

/** Reads one journey's lines. Throws with the line number on a line it does not understand. */
export function parseJourney(text: string): JourneyStep[] {
  const steps: JourneyStep[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  lines.forEach((line, i) => {
    if (!line || line.startsWith("#")) return;
    const fail = (why: string) => {
      throw new Error(`Line ${i + 1} ("${line.slice(0, 40)}"): ${why}`);
    };
    const words = [...line.matchAll(quoted)].map((m) => m[1].replace(/\\"/g, '"'));
    const verb = line.split(/\s+/)[0].toLowerCase();
    if (verb === "tap" || verb === "click" || verb === "press") {
      const id = line.match(/\bid:([\w.:/-]+)/)?.[1];
      if (id) steps.push({ kind: "tap", target: id, byId: true });
      else if (words[0]) steps.push({ kind: "tap", target: words[0], byId: false });
      else fail('say what to tap in quotes, e.g. tap "Sign in"');
    } else if (verb === "type" || verb === "enter" || verb === "fill") {
      const field = words[0];
      const value = words[1] ?? line.match(/\{\{(username|password)\}\}/)?.[0];
      if (!field || value === undefined) fail('write the field and the text, e.g. type "Email" "a@b.com" or type "Password" {{password}}');
      steps.push({ kind: "type", field: field!, value: value! });
    } else if (verb === "see" || verb === "expect" || verb === "check") {
      if (!words[0]) fail('say what text to see in quotes, e.g. see "Welcome"');
      steps.push({ kind: "see", text: words[0] });
    } else if (/^not\s+(see|expect)\b/i.test(line)) {
      if (!words[0]) fail('say what text must not show, e.g. not see "Error"');
      steps.push({ kind: "not-see", text: words[0] });
    } else if (verb === "back") steps.push({ kind: "back" });
    else if (verb === "relaunch" || verb === "restart") steps.push({ kind: "relaunch" });
    else if (verb === "rotate") steps.push({ kind: "rotate" });
    else if (verb === "swipe" || verb === "scroll") {
      const dir = (line.split(/\s+/)[1] ?? "up").toLowerCase();
      if (!["up", "down", "left", "right"].includes(dir)) fail("swipe up, down, left or right");
      steps.push({ kind: "swipe", dir: dir as "up" });
    } else if (verb === "wait") {
      const n = Number(line.split(/\s+/)[1] ?? 1);
      if (!(n > 0 && n <= 30)) fail("wait 1 to 30 seconds");
      steps.push({ kind: "wait", seconds: n });
    } else fail("start the line with tap, type, see, not see, back, swipe, wait, rotate or relaunch");
  });
  if (!steps.length) throw new Error("The journey has no steps.");
  if (steps.length > MAX_APP_STEPS) throw new Error(`A journey can have up to ${MAX_APP_STEPS} steps.`);
  return steps;
}

/** Checks journeys sent from the dashboard. */
export function cleanAppJourneys(input: unknown): AppJourney[] {
  if (!Array.isArray(input)) throw new Error("App journeys must be a list.");
  if (input.length > MAX_APP_JOURNEYS) throw new Error(`A project can have up to ${MAX_APP_JOURNEYS} app journeys.`);
  return input.map((raw, i) => {
    const j = (raw ?? {}) as Record<string, unknown>;
    const name = typeof j.name === "string" ? j.name.trim().slice(0, 80) : "";
    const steps = typeof j.steps === "string" ? j.steps.slice(0, 8000) : "";
    if (!name) throw new Error(`App journey ${i + 1} needs a name.`);
    try {
      parseJourney(steps);
    } catch (err) {
      throw new Error(`${name}: ${(err as Error).message}`);
    }
    return { id: typeof j.id === "string" && /^[\w-]{1,40}$/.test(j.id) ? j.id : `aj_${i}_${Date.now().toString(36)}`, name, steps, ...(j.off === true ? { off: true } : {}) };
  });
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

function byText(s: UiScreen, text: string, want: (e: UiElement) => boolean): UiElement | undefined {
  const t = norm(text);
  const els = s.elements.filter(want);
  return els.find((e) => norm(e.spoken) === t || norm(e.text) === t || norm(e.desc) === t || norm(e.hint) === t) ?? els.find((e) => norm(`${e.spoken} ${e.hint}`).includes(t));
}

/** The text field a label points at: by its hint or label, else the field just below a text that says it. */
function fieldFor(s: UiScreen, label: string): UiElement | undefined {
  const direct = byText(s, label, (e) => e.editable) ?? s.elements.find((e) => e.editable && norm(e.id.replace(/_/g, " ")).includes(norm(label)));
  if (direct) return direct;
  const caption = byText(s, label, (e) => !e.editable && Boolean(e.text));
  if (!caption) return undefined;
  return s.elements.filter((e) => e.editable && e.y >= caption.y).sort((a, b) => a.y - b.y)[0];
}

export interface JourneyRun {
  name: string;
  ok: boolean;
  steps: number;
  passed: number;
  /** The step that failed, and why. */
  failed?: { step: number; line: string; why: string };
  screenshot?: string;
}

const stepText = (s: JourneyStep) =>
  s.kind === "tap" ? `tap ${s.byId ? `id:${s.target}` : `"${s.target}"`}` : s.kind === "type" ? `type "${s.field}"` : s.kind === "see" ? `see "${s.text}"` : s.kind === "not-see" ? `not see "${s.text}"` : s.kind === "swipe" ? `swipe ${s.dir}` : s.kind === "wait" ? `wait ${s.seconds}` : s.kind;

/** Runs one journey from a fresh start of the app. */
export async function runJourney(r: AppRunner, j: AppJourney, login: { username?: string; password?: string } | undefined, shot: (label: string) => Promise<string | undefined>): Promise<JourneyRun> {
  const steps = parseJourney(j.steps);
  const res: JourneyRun = { name: j.name, ok: true, steps: steps.length, passed: 0 };
  await r.relaunch();
  let screen = await r.settle();
  let rotated = false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const failStep = async (why: string) => {
      res.ok = false;
      res.failed = { step: i + 1, line: stepText(s), why };
      res.screenshot = await shot(`${j.name}: step ${i + 1} failed`);
    };
    try {
      if (s.kind === "tap") {
        const el = s.byId ? screen.elements.find((e) => e.id === s.target || e.id.endsWith(`/${s.target}`)) : byText(screen, s.target, (e) => e.clickable || Boolean(e.text || e.desc));
        if (!el) {
          await failStep(`nothing called "${s.target}" on the screen`);
          break;
        }
        await r.driver.tap(el.x + el.width / 2, el.y + el.height / 2);
      } else if (s.kind === "type") {
        const field = fieldFor(screen, s.field);
        if (!field) {
          await failStep(`no text field called "${s.field}"`);
          break;
        }
        const value = s.value === "{{username}}" ? (login?.username ?? "") : s.value === "{{password}}" ? (login?.password ?? "") : s.value;
        if ((s.value === "{{username}}" || s.value === "{{password}}") && !value) {
          await failStep("the project has no saved login for {{username}} / {{password}}");
          break;
        }
        await r.driver.tap(field.x + field.width / 2, field.y + field.height / 2);
        const active = await r.driver.find(r.platform === "android" ? "//*[@focused='true']" : "//*[@hasKeyboardFocus='true' or @focused='true']");
        if (!active) {
          await failStep(`could not type into "${s.field}"`);
          break;
        }
        await r.driver.clear(active);
        await r.driver.type(active, value);
      } else if (s.kind === "see" || s.kind === "not-see") {
        const want = s.kind === "see";
        let found = Boolean(byText(screen, s.text, (e) => Boolean(e.text || e.desc)));
        // Waits up to 5 seconds for the text to show (see), or to go away (not see).
        for (let t = 0; t < 10 && found !== want; t++) {
          await sleep(500, r.signal);
          screen = await r.screen();
          found = Boolean(byText(screen, s.text, (e) => Boolean(e.text || e.desc)));
        }
        if (s.kind === "see" && !found) {
          await failStep(`"${s.text}" did not show within 5 seconds`);
          break;
        }
        if (s.kind === "not-see" && found) {
          await failStep(`"${s.text}" is on the screen`);
          break;
        }
      } else if (s.kind === "back") await r.driver.back();
      else if (s.kind === "relaunch") await r.relaunch();
      else if (s.kind === "rotate") {
        rotated = !rotated;
        await r.driver.setOrientation(rotated ? "LANDSCAPE" : "PORTRAIT");
      } else if (s.kind === "swipe") {
        const { width: w, height: h } = r.win;
        const c = { x: w / 2, y: h / 2 };
        const d = { up: { x: w / 2, y: h * 0.2 }, down: { x: w / 2, y: h * 0.8 }, left: { x: w * 0.15, y: h / 2 }, right: { x: w * 0.85, y: h / 2 } }[s.dir];
        await r.driver.swipe(s.dir === "up" ? { x: w / 2, y: h * 0.75 } : s.dir === "down" ? { x: w / 2, y: h * 0.25 } : c, d);
      } else if (s.kind === "wait") await sleep(s.seconds * 1000, r.signal);
      screen = await r.settle();
      if (!(await r.inApp(screen))) {
        const crash = (await r.crashes(`journey "${j.name}", step ${i + 1}`))[0];
        await failStep(crash ? `the app crashed: ${crash.reason}` : "the app closed");
        break;
      }
      res.passed++;
    } catch (err) {
      if (r.signal?.aborted) throw err;
      await failStep((err as Error).message.split("\n")[0]);
      break;
    }
  }
  if (rotated) await r.driver.setOrientation("PORTRAIT").catch(() => {});
  return res;
}
