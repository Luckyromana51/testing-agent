import { useState } from "react";
import type { AppJourney } from "../../../src/types.ts";

const EXAMPLE = `# One step per line. Lines starting with # are notes.
tap "Sign in"
type "Email" {{username}}
type "Password" {{password}}
tap "Log in"
see "Home"`;

const HELP: [string, string][] = [
  ['tap "Cart"', "Tap a button or text with these words (or its screen-reader label)"],
  ["tap id:login_button", "Tap by the element's id when there are no words"],
  ['type "Email" {{username}}', "Type into a field found by its hint or the label above it"],
  ['type "Password" {{password}}', "The saved app login's password, never shown in the report"],
  ['type "Search" "shoes"', "Type your own words"],
  ['see "Order placed"', "The words must be on the screen (waits up to 10 s)"],
  ['not see "Error"', "The words must not be on the screen"],
  ["back", "Press Back (Android) or the back button (iOS)"],
  ["swipe up", "Swipe up, down, left or right"],
  ["wait 2", "Wait 2 seconds"],
  ["rotate", "Turn the phone sideways, or back"],
  ["relaunch", "Close the app and open it again"],
];

/** A mobile project's app journeys: steps on the test phone, in plain words, run on every test. */
export function AppJourneysEditor({ journeys, onSave, hasDevice }: { journeys: AppJourney[]; onSave: (j: AppJourney[]) => Promise<void>; hasDevice: boolean }) {
  const [draft, setDraft] = useState<AppJourney[]>(journeys);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(journeys);
  const set = (i: number, patch: Partial<AppJourney>) => setDraft(draft.map((j, k) => (k === i ? { ...j, ...patch } : j)));
  return (
    <div className="card form journeys-editor">
      <p className="muted small">
        Steps a person takes in the app, like signing in, searching or reaching the cart. They run on the test phone after it has
        explored the app, with a picture after each step. A journey that breaks becomes a high issue. Journeys tap whatever you write,
        so use a test copy of the app's server when they buy, send or delete.{" "}
        <button className="link" onClick={() => setHelp(!help)}>
          {help ? "Hide the steps" : "Show all steps"}
        </button>
      </p>
      {!hasDevice && (
        <p className="small warn">
          No test phone is set up yet. Add one in Owner panel &gt; Test phones, then turn on "Run on a test phone" in What runs.
        </p>
      )}
      {help && (
        <table className="kv steps-help">
          <tbody>
            {HELP.map(([k, v]) => (
              <tr key={k}>
                <td>
                  <code>{k}</code>
                </td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {draft.map((j, i) => (
        <div className="journey-edit" key={j.id || i}>
          <div className="row">
            <input className="input grow" value={j.name} placeholder="Name, like Add to cart" onChange={(e) => set(i, { name: e.target.value })} aria-label="Journey name" />
            <label className="check">
              <input type="checkbox" checked={!j.off} onChange={(e) => set(i, { off: !e.target.checked })} /> Runs
            </label>
            <button className="btn ghost small danger" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>
              Remove
            </button>
          </div>
          <textarea className="input code" rows={Math.min(14, Math.max(5, j.steps.split("\n").length + 1))} value={j.steps} onChange={(e) => set(i, { steps: e.target.value })} aria-label={`Steps of ${j.name}`} spellCheck={false} />
        </div>
      ))}
      <div className="row">
        {draft.length < 20 && (
          <button className="btn ghost" onClick={() => setDraft([...draft, { id: "", name: `Journey ${draft.length + 1}`, steps: EXAMPLE }])}>
            + Add a journey
          </button>
        )}
        <div className="grow" />
        {changed && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(draft);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save journeys"}
          </button>
        )}
      </div>
    </div>
  );
}
