import { useState } from "react";
import type { Journey, RoleSummary } from "../../../src/types.ts";

const EXAMPLE = `# One step per line. Lines starting with # are notes.
open /
click Shop
click Add to cart
see Your cart
url has /cart`;

const HELP: [string, string][] = [
  ["open /pricing", "Open an address (or a path on the site)"],
  ["click Add to cart", "Click a button, link, tab or text with these words"],
  ["fill Email = {{username}}", "Type into a field found by its label or placeholder"],
  ["fill Password = {{password}}", "The saved login's password, never shown in the report"],
  ["select Country = India", "Pick an option in a list"],
  ["check I agree", "Tick a box (uncheck to clear it)"],
  ["press Enter", "Press a key"],
  ["hover Products", "Point at a menu"],
  ["see Order total", "The words must be on the page (waits up to 10 s)"],
  ["not see Error", "The words must not be on the page"],
  ["url has /thank-you", "The address must contain this"],
  ["title has Checkout", "The page title must contain this"],
  ["wait 2", "Wait 2 seconds"],
  ["click css=#buy", "Use a CSS selector when words are not enough"],
  ["fill Email = {{inbox}}", "Test mailbox module: a fresh email address for this journey"],
  ["email has Welcome", "Test mailbox module: an email to {{inbox}} has these words (waits up to 30 s)"],
  ["open email link Confirm", "Test mailbox module: open the link in that email with these words"],
  ["fill Name = Test {{random}}", "A made-up word, the same for the whole journey: name a test record, then find it again"],
  ["fill Date = {{today}}", "Today's date (2026-11-19)"],
  ["fill Code = {{code}}", "The two-step code from the saved secret"],
  ["fill Webhook URL = {{webhook}}", "Webhook inbox: the project's own address that catches webhooks"],
  ["webhook has lead.created", "Webhook inbox: a webhook with these words came in (waits up to 30 s)"],
  ["fill Phone = {{phone}}", "Test data: a column of the journey's table. The journey runs once per row"],
];

/** A record test on a test server: add a record, find it, change it, then remove it in the clean-up. */
const RECORD_TEST = `open /contacts
click New contact
fill Name = Test {{random}}
fill Email = {{random}}@example.com
click Save
see Test {{random}}
fill Search = {{random}}
see Test {{random}}`;
const RECORD_CLEANUP = `open /contacts
fill Search = {{random}}
click Test {{random}}
click Delete
click Yes, delete`;

/** The project's user journeys: written in plain words, followed on every test. */
export function JourneysEditor({ journeys, onSave, roles = [], signedIn = false }: { journeys: Journey[]; onSave: (j: Journey[]) => Promise<void>; roles?: RoleSummary[]; signedIn?: boolean }) {
  const [draft, setDraft] = useState<Journey[]>(journeys);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(journeys);
  const set = (i: number, patch: Partial<Journey>) => setDraft(draft.map((j, k) => (k === i ? { ...j, ...patch } : j)));
  return (
    <div className="card form journeys-editor">
      <p className="muted small">
        Steps a person takes on the site, like signing in, searching or reaching the checkout. They run after the pages on every test,
        with a picture after each step. A journey that breaks becomes a high issue. Journeys are read-only unless you allow one to send
        forms: then use a staging or test site only.{" "}
        <button className="link" onClick={() => setHelp(!help)}>
          {help ? "Hide the steps" : "Show all steps"}
        </button>
      </p>
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
            <label className="check" title="Only for staging or test sites. The saves it makes are also sent again as the project's other accounts, to see who can change what.">
              <input type="checkbox" checked={Boolean(j.allowWrites)} onChange={(e) => set(i, { allowWrites: e.target.checked })} /> May send forms
            </label>
            <button className="btn ghost small danger" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>
              Remove
            </button>
          </div>
          {roles.length > 0 && (
            <label className="inline-field">
              <span>Signed in as</span>
              <select className="input" value={j.role ?? ""} onChange={(e) => set(i, { role: e.target.value || undefined })}>
                <option value="">{signedIn ? "The main account" : "No login"}</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <textarea className="input code" rows={Math.min(14, Math.max(5, j.steps.split("\n").length + 1))} value={j.steps} onChange={(e) => set(i, { steps: e.target.value })} aria-label={`Steps of ${j.name}`} spellCheck={false} />
          <details className="journey-cleanup" open={Boolean(j.cleanup)}>
            <summary>Clean-up steps (always run at the end, even when the journey fails)</summary>
            <textarea
              className="input code"
              rows={Math.min(10, Math.max(3, (j.cleanup ?? "").split("\n").length + 1))}
              value={j.cleanup ?? ""}
              placeholder={"open /contacts\nclick Test {{random}}\nclick Delete"}
              onChange={(e) => set(i, { cleanup: e.target.value || undefined })}
              aria-label={`Clean-up steps of ${j.name}`}
              spellCheck={false}
            />
          </details>
          <details className="journey-cleanup" open={Boolean(j.data)}>
            <summary>Test data (the journey runs once per row, up to 20 rows)</summary>
            <p className="muted small">
              A small table, comma between values, the first line names the columns. Use a column in a step as {"{{name}}"}, like{" "}
              <code>fill Phone = {"{{phone}}"}</code>. Good for phone formats, long names and Hindi text.
            </p>
            <textarea
              className="input code"
              rows={Math.min(10, Math.max(3, (j.data ?? "").split("\n").length + 1))}
              value={j.data ?? ""}
              placeholder={"name,phone\nAsha Verma,98450 11111\nरवि कुमार,+91 98450 22222"}
              onChange={(e) => set(i, { data: e.target.value || undefined })}
              aria-label={`Test data of ${j.name}`}
              spellCheck={false}
            />
          </details>
        </div>
      ))}
      <div className="row">
        {draft.length < 10 && (
          <button className="btn ghost" onClick={() => setDraft([...draft, { id: "", name: `Journey ${draft.length + 1}`, steps: EXAMPLE }])}>
            + Add a journey
          </button>
        )}
        {draft.length < 10 && (
          <button
            className="btn ghost"
            title="Add a record, find it, then delete it in the clean-up. Only for a test server."
            onClick={() => setDraft([...draft, { id: "", name: "Record test", steps: RECORD_TEST, cleanup: RECORD_CLEANUP, allowWrites: true }])}
          >
            + Record test (test server)
          </button>
        )}
        <a className="btn ghost" href="/api/recorder/download" title="A Chrome extension that turns your clicks into steps">
          Record steps in Chrome
        </a>
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
