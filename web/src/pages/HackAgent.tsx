import { useMemo, useState } from "react";
import { api, type HackState, type HackTarget, type Meta, type MetaTool } from "../api.ts";
import { timeAgo, usePoll } from "../lib.ts";
import { Icon, Toggle } from "../ui.tsx";

const STATE: Record<HackState, { label: string; tone: string }> = {
  ready: { label: "Ready", tone: "ok" },
  busy: { label: "Testing now", tone: "info" },
  "waiting-proof": { label: "Proof file missing", tone: "warn" },
  "not-unlocked": { label: "Not unlocked", tone: "muted" },
  "no-address": { label: "No address", tone: "muted" },
  "not-supported": { label: "Not a web target", tone: "muted" },
};

/**
 * The hack agent: choose systems, choose attack tools, start them all at once. Only systems
 * unlocked for attacks (own system or client's permission, proof in place) can be chosen.
 */
export function HackAgent({ meta }: { meta: Meta }) {
  const { data, error, reload } = usePoll(() => api.hack(), [], 5000);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [toolOn, setToolOn] = useState<Record<string, boolean>>({});
  const [options, setOptions] = useState<Record<string, Record<string, string>>>({});
  const [pages, setPages] = useState(30);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.startHack>> | null>(null);
  const [startError, setStartError] = useState("");

  const tools: MetaTool[] = useMemo(() => meta.tools.filter((t) => data?.tools.includes(t.id)), [meta, data]);
  const isToolOn = (t: MetaTool) => t.ready && (toolOn[t.id] ?? true);
  const targets = data?.targets ?? [];
  const ready = targets.filter((t) => t.state === "ready");
  const locked = targets.filter((t) => t.state !== "ready" && t.state !== "not-supported");
  const picked = ready.filter((t) => chosen.has(t.projectId));
  const pickedTools = tools.filter(isToolOn);
  const usable = picked.filter((t) => t.tools.some((id) => pickedTools.some((p) => p.id === id)));

  const toggle = (id: string, on: boolean) =>
    setChosen((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  async function start() {
    setBusy(true);
    setStartError("");
    try {
      const res = await api.startHack({
        projectIds: usable.map((t) => t.projectId),
        tools: pickedTools.map((t) => ({ id: t.id, ...(options[t.id] ? { options: options[t.id] } : {}) })),
        maxPages: pages,
      });
      setResult(res);
      setChosen(new Set());
      reload();
    } catch (err) {
      setStartError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="page error big">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;

  return (
    <div className="page hack-page">
      <header className="hack-head">
        <div className="hack-mark" aria-hidden="true">
          <Icon name="hack" size={26} />
        </div>
        <div>
          <h1>Hack agent</h1>
          <p className="muted">
            Run the attack agent, GLV's probes and ZAP's attack scan on many of your systems at once. Choose the systems, choose the tools, press Start.
          </p>
        </div>
      </header>

      <div className="hack-grid">
        <section className="card hack-systems" aria-labelledby="hack-ready">
          <div className="hack-list-head">
            <h2 id="hack-ready">Systems ready to attack</h2>
            {ready.length > 1 && (
              <div className="row">
                <button type="button" className="btn ghost small" onClick={() => setChosen(new Set(ready.map((t) => t.projectId)))}>
                  Choose all {ready.length}
                </button>
                {chosen.size > 0 && (
                  <button type="button" className="btn ghost small" onClick={() => setChosen(new Set())}>
                    Clear
                  </button>
                )}
              </div>
            )}
          </div>
          {ready.length === 0 ? (
            <div className="hack-empty">
              <strong>No system is unlocked for attacks yet.</strong>
              <span className="muted small">
                Open one of the projects below and unlock it on its Load and attack tab: as our own system, or with a client's written permission. It shows
                up here once its proof file is in place.
              </span>
            </div>
          ) : (
            <ul className="hack-rows">
              {ready.map((t) => (
                <li key={t.projectId} className={`hack-row ${chosen.has(t.projectId) ? "picked" : ""}`}>
                  <label className="hack-pick">
                    <input type="checkbox" checked={chosen.has(t.projectId)} onChange={(e) => toggle(t.projectId, e.target.checked)} />
                    <span className="hack-name">
                      <strong>{t.name}</strong>
                      <span className="muted small">{t.host}</span>
                    </span>
                  </label>
                  <Target t={t} />
                </li>
              ))}
            </ul>
          )}

          {locked.length > 0 && (
            <>
              <h3 className="hack-sub">Not ready yet ({locked.length})</h3>
              <ul className="hack-rows locked">
                {locked.map((t) => (
                  <li key={t.projectId} className="hack-row">
                    <span className="hack-pick">
                      <input type="checkbox" disabled aria-label={`${t.name} cannot be chosen yet`} />
                      <span className="hack-name">
                        <strong>{t.name}</strong>
                        <span className="muted small">{t.why}</span>
                      </span>
                    </span>
                    <Target t={t} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="card hack-run" aria-label="Run settings">
          <h2>Attack tools</h2>
          <div className="hack-tools">
            {tools.map((t) => (
              <div key={t.id} className={`hack-tool ${isToolOn(t) ? "" : "off"}`}>
                <div className="hack-tool-head">
                  <Toggle on={isToolOn(t)} onChange={(v) => t.ready && setToolOn({ ...toolOn, [t.id]: v })} label={t.name} />
                  <span className="grow">
                    <strong className="small">{t.name}</strong>
                    {!t.ready && <span className="muted small"> · not on this server</span>}
                  </span>
                </div>
                {isToolOn(t) &&
                  (t.options ?? [])
                    .filter((o) => o.kind !== "file")
                    .map((o) =>
                      o.kind === "toggles" ? (
                        <details key={o.id} className="hack-families">
                          <summary className="small">{o.label}</summary>
                          <div className="toggle-grid">
                            {o.choices.map((c) => {
                              const on = (options[t.id]?.[o.id] ?? o.default).split(",").filter(Boolean);
                              return (
                                <label key={c.value} className="check small">
                                  <input
                                    type="checkbox"
                                    checked={on.includes(c.value)}
                                    onChange={(e) => {
                                      const next = new Set(on);
                                      if (e.target.checked) next.add(c.value);
                                      else next.delete(c.value);
                                      const value = o.choices.map((ch) => ch.value).filter((v) => next.has(v)).join(",");
                                      setOptions({ ...options, [t.id]: { ...options[t.id], [o.id]: value } });
                                    }}
                                  />{" "}
                                  {c.label}
                                </label>
                              );
                            })}
                          </div>
                        </details>
                      ) : o.kind === "text" ? (
                        <label key={o.id} className="hack-option small">
                          {o.label}
                          <input
                            className="input"
                            value={options[t.id]?.[o.id] ?? o.default}
                            placeholder={o.placeholder}
                            maxLength={o.maxLength ?? 500}
                            onChange={(e) => setOptions({ ...options, [t.id]: { ...options[t.id], [o.id]: e.target.value } })}
                          />
                        </label>
                      ) : (
                        <label key={o.id} className="hack-option small">
                          {o.label}
                          <select
                            className="input"
                            value={options[t.id]?.[o.id] ?? o.default}
                            onChange={(e) => setOptions({ ...options, [t.id]: { ...options[t.id], [o.id]: e.target.value } })}
                          >
                            {o.choices.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </label>
                      ),
                    )}
              </div>
            ))}
          </div>
          <label className="form-field">
            <span>Pages to explore on each system</span>
            <input className="input" type="number" min={1} max={20000} value={pages} onChange={(e) => setPages(Number(e.target.value))} />
            <div className="muted small">The attack tools try the parameters and forms of the pages found.</div>
          </label>
          <button className="btn primary hack-start" disabled={busy || usable.length === 0 || pickedTools.length === 0} onClick={start}>
            {busy
              ? "Starting…"
              : usable.length
                ? `Start on ${usable.length} system${usable.length === 1 ? "" : "s"}`
                : "Choose systems to start"}
          </button>
          {startError && <div className="error">{startError}</div>}
          <ul className="hack-rules muted small">
            <li>Starts only when you press Start, never on a schedule.</li>
            <li>Read-only: it tries to get in, but changes and deletes nothing.</li>
            <li>The permission and its proof file are checked again just before each tool runs.</li>
            <li>Tests at the same time as the owner's limit allows; the others wait their turn on the Live page.</li>
          </ul>
        </aside>
      </div>

      {result && (
        <section className="card hack-result" role="status">
          <h2>
            {result.started.length ? `Started on ${result.started.length} system${result.started.length === 1 ? "" : "s"}` : "Nothing started"}
          </h2>
          <ul>
            {result.started.map((s) => (
              <li key={s.runId}>
                <a href={`#/run/${s.runId}`}>{s.name}</a> <span className="muted small">· watch it live</span>
              </li>
            ))}
            {result.skipped.map((s) => (
              <li key={s.projectId} className="muted">
                {s.name}: {s.why}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Target({ t }: { t: HackTarget }) {
  const s = STATE[t.state];
  return (
    <span className="hack-target">
      <span className={`hack-state ${s.tone}`}>{t.state === "ready" && t.own ? "Own system" : s.label}</span>
      {t.last && (
        <a className="small" href={`#/run/${t.last.runId}`} title={`Last hack run, ${t.last.status}`}>
          Last run {timeAgo(t.last.at)}
          {t.last.findings !== undefined ? ` · ${t.last.findings} found` : ""}
        </a>
      )}
      {(t.state === "not-unlocked" || t.state === "waiting-proof") && (
        <a className="btn small" href={`#/project/${t.projectId}?tab=permission`}>
          {t.state === "waiting-proof" ? "Check the proof" : "Unlock"}
        </a>
      )}
    </span>
  );
}
