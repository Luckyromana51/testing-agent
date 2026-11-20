import type { Page } from "playwright";
import type { LiveInput, LiveSink } from "../live.js";

/*
 * The sign-in in the live view: its page is shown on screen 1 from the moment it opens, and when
 * the sign-in cannot finish by itself (a CAPTCHA, a code with no saved secret, a form the test
 * cannot send), the screen is handed to the person watching: they click and type on the picture
 * and press Done. Nobody watching: the sign-in fails as before, with its reason.
 */

const PASSWORD = 'input[type="password"]';
const CODE = 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="2fa" i], input[name*="totp" i], input[id*="otp" i]';

/** How long a person has to finish the sign-in by hand. */
export const HAND_OVER_MS = 5 * 60_000;
/** How long to wait for someone to open the live view, when nobody watches yet. */
const WAIT_FOR_VIEWER_MS = 20_000;

type Cast = (page: Page, slot: number, live: LiveSink) => Promise<() => Promise<void>>;

/** True when no frame of the page shows a password or code field any more. */
async function formGone(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    if (f.isDetached()) continue;
    for (const sel of [PASSWORD, CODE]) {
      const all = f.locator(sel);
      const n = Math.min(await all.count().catch(() => 0), 5);
      for (let i = 0; i < n; i++) if (await all.nth(i).isVisible().catch(() => false)) return false;
    }
  }
  return true;
}

/** Applies one viewer action to the page. x and y are fractions of the visible page. */
export async function applyInput(page: Page, input: LiveInput): Promise<void> {
  const size = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
  switch (input.type) {
    case "click":
      await page.mouse.click(Math.round(input.x * size.width), Math.round(input.y * size.height));
      break;
    case "type":
      await page.keyboard.type(input.text, { delay: 20 });
      break;
    case "key":
      await page.keyboard.press(input.key === "Space" ? " " : input.key);
      break;
    case "scroll":
      await page.mouse.wheel(0, input.dy);
      break;
    default:
      break;
  }
}

export function liveSignIn(live: LiveSink | undefined, cast: Cast, signal?: AbortSignal, slot = 0) {
  if (!live) return {};
  return {
    onPage: async (page: Page) => {
      live.screen({ slot, view: "desktop", doing: "Signing in", agents: [], state: "busy", url: undefined });
      page.on("framenavigated", (f) => {
        if (f === page.mainFrame()) live.screen({ slot, url: f.url(), state: "busy" });
      });
      return cast(page, slot, live);
    },
    handOver: async (page: Page, why: string): Promise<boolean> => {
      if (!live.control) return false;
      if (!live.watching()) {
        // The live view usually opens with the test; give a viewer a moment to arrive.
        const t0 = Date.now();
        while (!live.watching() && Date.now() - t0 < WAIT_FOR_VIEWER_MS) {
          signal?.throwIfAborted();
          await page.waitForTimeout(500);
        }
        if (!live.watching()) return false;
      }
      const reason = why.split(" Check the user name")[0].slice(0, 300);
      live.screen({ slot, doing: "Your turn: finish the sign-in here, then press Done", handOver: reason, state: "busy" });
      let done = false;
      live.control(slot, async (input) => {
        if (input.type === "done") done = true;
        else await applyInput(page, input);
      });
      try {
        const until = Date.now() + HAND_OVER_MS;
        let goneSince = 0;
        while (Date.now() < until && !page.isClosed()) {
          signal?.throwIfAborted();
          if (done) return true;
          // Signed in without pressing Done: the form stayed away for 3 seconds.
          if (await formGone(page)) {
            goneSince ||= Date.now();
            if (Date.now() - goneSince > 3000) return true;
          } else goneSince = 0;
          if (!live.watching()) return false;
          await page.waitForTimeout(500);
        }
        return false;
      } finally {
        live.control(slot, undefined);
        live.screen({ slot, handOver: "", doing: "Signing in", state: "busy" });
      }
    },
  };
}
