import { useEffect, useState } from "react";
import type { ApiScenario } from "../../../src/types.ts";
import { api, type MockView, type ProjectSummary } from "../api.ts";
import { timeAgo } from "../lib.ts";
import { RolesCard } from "./AppSetup.tsx";

/*
 * The project's API tab: test-server mode, other accounts (roles, another company), scenarios
 * written in plain words, and the mock server.
 */

const EXAMPLE = `GET /orders
expect status 200
expect time < 800
save id = $[0].id
GET /orders/{{id}}
expect status 200
expect $.id == {{id}}`;

export function ApiSetup({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  return (
    <div className="api-setup">
      <TestServerCard project={project} onChanged={onChanged} />
      <ScenariosCard project={project} onChanged={onChanged} />
      <RolesCard project={project} onChanged={onChanged} />
      <MockCard project={project} onChanged={onChanged} />
    </div>
  );
}

function TestServerCard({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = Boolean(project.target.testServer);
  return (
    <div className="card">
      <h3 className="sub-title">Test server</h3>
      <label className="check dark">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            setError("");
            try {
              await api.updateProject(project.id, { testServer: e.target.checked });
              onChanged();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />{" "}
        This API is a test server, so tests may add, change and delete data
      </label>
      <p className="muted small">
        {on
          ? "The test makes its own records (create, read back, change, delete), sends wrong input, tries fields a user must not set, and removes what it made. Scenarios may use POST, PUT, PATCH and DELETE."
          : "Off: only GET calls are sent, so a live API is never changed. Turn this on only for a staging or test copy."}
      </p>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ScenariosCard({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  const [list, setList] = useState<ApiScenario[]>(project.apiScenarios ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => setList(project.apiScenarios ?? []), [JSON.stringify(project.apiScenarios ?? [])]);
  const changed = JSON.stringify(list) !== JSON.stringify(project.apiScenarios ?? []);
  const edit = (i: number, patch: Partial<ApiScenario>) => setList(list.map((s, j) => (j === i ? { ...s, ...patch } : s)));

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await api.updateProject(project.id, { apiScenarios: list });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3 className="sub-title">Scenarios</h3>
      <p className="muted small">
        Tests in plain words, one step a line, run in every test of this API. Steps: a request (<code>GET /path</code>), <code>header Name: value</code>,{" "}
        <code>body {"{...}"}</code>, <code>as Role name</code> (or <code>as nobody</code>), <code>save name = $.path</code>, <code>set name = value</code>,{" "}
        <code>wait 500</code>, and checks: <code>expect status 200</code>, <code>expect time &lt; 800</code>, <code>expect schema</code>,{" "}
        <code>expect header Content-Type contains json</code>, <code>expect $.total &gt; 0</code>. Use a saved value as <code>{"{{name}}"}</code>. Clean-up
        steps always run at the end.
      </p>
      {list.map((s, i) => (
        <div key={s.id} className="scenario-editor">
          <div className="row">
            <input className="input grow" value={s.name} onChange={(e) => edit(i, { name: e.target.value })} aria-label="Scenario name" />
            <label className="check dark small">
              <input type="checkbox" checked={!s.off} onChange={(e) => edit(i, { off: e.target.checked ? undefined : true })} /> On
            </label>
            <button className="btn ghost small" onClick={() => setList(list.filter((_, j) => j !== i))}>
              Remove
            </button>
          </div>
          <textarea className="input" value={s.steps} onChange={(e) => edit(i, { steps: e.target.value })} aria-label="Steps" spellCheck={false} />
          <details className="journey-cleanup" open={Boolean(s.cleanup)}>
            <summary>Clean-up steps (run even when a step fails)</summary>
            <textarea className="input" value={s.cleanup ?? ""} placeholder="DELETE /orders/{{id}}" onChange={(e) => edit(i, { cleanup: e.target.value || undefined })} spellCheck={false} />
          </details>
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn ghost" onClick={() => setList([...list, { id: `s${Date.now().toString(36)}`, name: `Scenario ${list.length + 1}`, steps: EXAMPLE }])}>
          Add a scenario
        </button>
        {changed && (
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? "Saving…" : "Save scenarios"}
          </button>
        )}
        {saved && <span className="ok small">Saved. They run in the next test.</span>}
      </div>
    </div>
  );
}

function MockCard({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  const [mock, setMock] = useState<MockView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = Boolean(project.mockAddress);
  useEffect(() => {
    if (!on) return setMock(null);
    let stop = false;
    const load = () =>
      api
        .mock(project.id)
        .then((m) => !stop && setMock(m))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [project.id, on]);

  const set = async (value: boolean | "new") => {
    setBusy(true);
    setError("");
    try {
      await api.updateProject(project.id, { mock: value });
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3 className="sub-title">Mock server</h3>
      <p className="muted small">
        An address on this server that answers like the API, from its API file: the examples in the file, or made-up data that fits. It checks
        what it is sent (required fields, types) and answers 400 with the reasons. Front-end developers can build against it before the API is
        ready. It holds no real data.
      </p>
      {!on ? (
        <button className="btn" disabled={busy} onClick={() => set(true)}>
          Turn on the mock
        </button>
      ) : (
        <>
          <div className="hook-address mono small">{project.mockAddress}</div>
          {mock && !mock.ready && <div className="warn small">Run a test of this API first: the mock answers from its API file.</div>}
          {mock?.ready && <div className="muted small">Answers {mock.endpoints} endpoints. Add the path after the address, like {project.mockAddress}/users.</div>}
          <div className="row">
            <button className="btn ghost small" disabled={busy} onClick={() => void navigator.clipboard?.writeText(project.mockAddress ?? "")}>
              Copy address
            </button>
            <button className="btn ghost small" disabled={busy} onClick={() => set("new")}>
              New address
            </button>
            <button className="btn ghost small danger" disabled={busy} onClick={() => set(false)}>
              Turn off
            </button>
          </div>
          {mock && mock.calls.length > 0 && (
            <>
              <div className="stat-label">Last calls</div>
              <table className="table small">
                <tbody>
                  {mock.calls.map((c, i) => (
                    <tr key={`${c.at}${i}`}>
                      <td className="muted">{timeAgo(c.at)}</td>
                      <td className="mono">
                        {c.method} {c.path}
                      </td>
                      <td className={c.status >= 400 ? "warn" : "ok"}>{c.status}</td>
                      <td className="small">{c.problems?.join("; ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
