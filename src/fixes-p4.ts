import type { Fix } from "./fixes.js";

/**
 * Written fixes for the checks added in wave 4 of the 2026 gap report (the previously-deferred P3
 * items, now built in-house / free): IAST taint paths, keyword rank, AI-answer visibility,
 * Windows browsers & fonts, Wear/TV/Auto/kiosk/IoT device profiles, HTML5 games, push send,
 * Jira/Linear export and voice-bot testing.
 */
export const P4_FIXES: Record<string, Fix> = {
  // IAST — untrusted input reaching a sink
  "iast:taint-eval": { steps: "Never pass request input to eval/Function/vm. Parse it as data and use a fixed set of actions or a safe interpreter.", effort: "hours" },
  "iast:taint-exec": { steps: "Use execFile with a fixed command and an argument array (never a shell string), and allow-list the argument values.", effort: "hours" },
  "iast:taint-sql": { steps: "Use parameterised queries / prepared statements ($1, ?) instead of building SQL by concatenation.", effort: "hours" },
  "iast:taint-fs": { steps: "Resolve file paths against a fixed base directory and reject '..'; never require() a value built from input.", effort: "hours" },
  "iast:taint-redirect": { steps: "Allow-list redirect targets, or only allow same-origin relative paths.", effort: "hours" },
  "iast:taint-html": { steps: "Escape output or set textContent; for HTML, sanitise with a library like DOMPurify before inserting it.", effort: "hours" },

  // Keyword / rank tracking
  "rank:not-found": { steps: "Strengthen the page targeting this keyword (title, headings, content depth, internal links) and earn links to it. Re-check over time.", effort: "days" },
  "rank:low": { steps: "Improve the matching page and its backlinks to climb above the target position; track the trend.", effort: "days" },

  // AI-answer visibility
  "aivis:absent": { steps: "Publish clear, factual, well-structured pages (who you are, what you do, for whom), add Organization schema, and earn mentions on sites AI models trust.", effort: "days" },
  "aivis:low-coverage": { steps: "Strengthen the pages behind the missed questions and your off-site presence so more AI answers mention you.", effort: "days" },

  // Windows browsers & fonts
  "winbrowser:overflow": { steps: "Fix the Windows-specific overflow: account for the Windows scrollbar width and font fallback, and use responsive widths.", effort: "hours" },
  "winfont:missing": { steps: "Self-host the font as a @font-face web font (woff2) instead of relying on it being installed on Windows.", effort: "hours" },

  // Wear / TV / Auto / kiosk / IoT
  "device:overflow": { steps: "Use a responsive layout that fits the small/large device screen; test at the device's exact width.", effort: "hours" },
  "device:tiny-target": { steps: "Make primary controls at least 44×44px (48×48 on TV/Auto, which use a remote).", effort: "hours" },
  "device:no-focus": { steps: "Add a clear :focus-visible outline so remote/D-pad users can see what is selected on TV and Auto.", effort: "hours" },

  // HTML5 games
  "game:no-canvas": { steps: "Point the game check at the page after the game has started, or confirm the game uses a <canvas>.", effort: "minutes" },
  "game:low-fps": { steps: "Profile the render loop, cut per-frame allocations and draw calls, and drive animation with requestAnimationFrame.", effort: "days" },
  "game:webgl-lost": { steps: "Handle webglcontextlost/restored, recreate GPU resources, and reduce memory pressure so the context is not lost.", effort: "hours" },
  "game:js-errors": { steps: "Open the console and fix the errors thrown during play; they can break input or rendering.", effort: "hours" },

  // Push notifications
  "push:bad-payload": { steps: "Give a valid device token and a title/body before sending the test push.", effort: "minutes" },
  "push:no-deeplink": { steps: "Add a data payload (e.g. a route) to the push and handle it on open so the push lands on the right screen.", effort: "hours" },
  "push:send-failed": { steps: "Check the device token is current, the project id/key is right, and the OAuth token/JWT has the messaging scope; then resend.", effort: "hours" },

  // Tracker export
  "tracker:export-failed": { steps: "Check the tracker token, the project/team id and the required issue fields, then re-run the export.", effort: "minutes" },

  // Voice-bot
  "voice:wrong-reply": { steps: "Fix the intent and response for this utterance so the voice bot answers with the expected information.", effort: "hours" },
};
