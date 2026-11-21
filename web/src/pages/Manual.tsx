import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type ManualCase,
  type ManualProjectView,
  type ManualResult,
  type ManualRound,
  type ManualStatus,
  type Meta,
  type RoundCounts,
} from "../api.ts";
import { go, timeAgo, usePoll } from "../lib.ts";
import { Icon } from "../ui.tsx";

/*
 * Manual tests: checklists a person works through by hand.
 * #/manual            every project, with its checklist and last round
 * #/manual/<project>  the project's checklist (switch cases on or off, add your own) and its rounds
 * #/round/<round>     one round: pass, fail or skip each case, with notes and screenshots
 */

const STATUS_WORD: Record<ManualStatus | "todo", string> = { pass: "Passed", fail: "Failed", skip: "Skipped", todo: "Not tested" };
const SOURCE_WORD: Record<ManualCase["source"], string> = { written: "Ready-made", project: "From this project", handbook: "Testing handbook", own: "Your own" };

/** A bar of pass / fail / skip / not tested, in proportion. */
export function RoundBar({ counts, big }: { counts: RoundCounts; big?: boolean }) {
  const parts: [keyof RoundCounts, string][] = [
    ["pass", "pass"],
    ["fail", "fail"],
    ["skip", "skip"],
    ["todo", "todo"],
  ];
  const done = counts.total - counts.todo;
  return (
    <div className={`mt-bar ${big ? "big" : ""}`} role="img" aria-label={`${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped, ${counts.todo} not tested`}>
      <div className="mt-bar-track">
        {parts.map(([k, cls]) => (counts[k] ? <span key={k} className={`mt-seg ${cls}`} style={{ flexGrow: counts[k] as number }} /> : null))}
      </div>
      {big && (
        <div className="mt-bar-legend">
          <span className="mono">{done}/{counts.total}</span> done
          <span className="mt-key pass">{counts.pass} passed</span>
          <span className="mt-key fail">{counts.fail} failed</span>
          <span className="mt-key skip">{counts.skip} skipped</span>
        </div>
      )}
    </div>
  );
}

/** Every project, with how far its manual testing has got. */
export function ManualHome({ meta }: { meta: Meta }) {
  const { data, error } = usePoll(() => api.manualOverview(), [], 15_000);
  if (error) return <div className="page error big">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Manual tests</h1>
          <p className="muted">
            Checklists you work through by hand. Each case has steps and what should happen: press <b>Pass</b>, <b>Fail</b> or <b>Skip</b>,
            add a note or a screenshot, and send failures to the issue board.
          </p>
        </div>
      </div>
      {data.length === 0 ? (
        <div className="empty-state">
          <div className="empty-title">No projects yet</div>
          <p className="muted">A checklist is made for each project. Start a test first, then come back here.</p>
          <a className="btn primary" href="#/">
            Start a test
          </a>
        </div>
      ) : (
        <div className="mt-projects">
          {data.map((p) => (
            <a key={p.id} className="card mt-project" href={`#/manual/${p.id}`}>
              <div className="mt-project-top">
                <span className={`product-icon pi-${p.type}`}>
                  <Icon name={p.type} size={18} />
                </span>
                <div className="grow">
                  <div className="strong">{p.name}</div>
                  <div className="muted small">
                    {meta.products.find((x) => x.type === p.type)?.name} · {p.on} of {p.cases} cases on
                  </div>
                </div>
              </div>
              {p.last ? (
                <>
                  <RoundBar counts={p.last.counts} />
                  <div className="muted small">
                    {p.last.name}: {p.last.counts.pass} passed, {p.last.counts.fail} failed, {p.last.counts.todo} to do · {timeAgo(p.last.createdAt)}
                  </div>
                </>
              ) : (
                <div className="muted small">No rounds yet. Open it to start the first one.</div>
              )}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** A project's checklist and its rounds. */
export function ManualProject({ id }: { id: string }) {
  const { data, error, reload, setData } = usePoll(() => api.manual(id), [id], 60_000);
  const [tab, setTab] = useState<"rounds" | "cases">("rounds");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [build, setBuild] = useState("");
  const [env, setEnv] = useState("");
  const [name, setName] = useState("");

  if (error) return <div className="page error big">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const on = data.cases.filter((c) => c.on).length;
  const last = data.rounds[0];

  async function start(only?: "failed") {
    setBusy(true);
    setMsg("");
    try {
      const r = await api.manualStart(id, { name: name || undefined, build: build || undefined, env: env || undefined, only });
      go(`#/round/${r.id}`);
    } catch (err) {
      setMsg((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <a href="#/manual" className="back">
        ← Manual tests
      </a>
      <div className="page-head">
        <div className="grow">
          <h1>{data.project.name}: manual tests</h1>
          <p className="muted">
            {on} of {data.cases.length} cases are on. New cases are on by default; turn off any that do not apply under <b>Cases</b>.
          </p>
        </div>
        <a className="btn" href={`#/project/${id}`}>
          Open the project
        </a>
      </div>

      <form
        className="card mt-start"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <div className="mt-start-head">
          <h2 className="sub-title">Start a round</h2>
          <span className="muted small">One pass through the checklist, for one build.</span>
        </div>
        <div className="form-row">
          <label className="form-field grow">
            <span>Build or version (optional)</span>
            <input className="input" placeholder="1.4.2, or today's staging" value={build} onChange={(e) => setBuild(e.target.value)} />
          </label>
          <label className="form-field grow">
            <span>Where you test (optional)</span>
            <input className="input" placeholder="Chrome on Windows, iPhone 15" value={env} onChange={(e) => setEnv(e.target.value)} />
          </label>
          <label className="form-field grow">
            <span>Name (optional)</span>
            <input className="input" placeholder={`Round ${data.rounds.length + 1}`} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div className="form-actions">
          <button className="btn primary" disabled={busy || on === 0}>
            {busy ? "Starting…" : `Start a round with ${on} cases`}
          </button>
          {last && last.counts.total - last.counts.pass - last.counts.skip > 0 && (
            <button type="button" className="btn" disabled={busy} onClick={() => start("failed")}>
              Re-check the {last.counts.total - last.counts.pass - last.counts.skip} failed or unfinished from {last.name}
            </button>
          )}
          {msg && <div className="error">{msg}</div>}
        </div>
      </form>

      <div className="tabs sticky-tabs">
        <button className={tab === "rounds" ? "active" : ""} onClick={() => setTab("rounds")}>
          Rounds <span className="tab-count">{data.rounds.length}</span>
        </button>
        <button className={tab === "cases" ? "active" : ""} onClick={() => setTab("cases")}>
          Cases <span className="tab-count">{on}/{data.cases.length}</span>
        </button>
      </div>

      {tab === "rounds" &&
        (data.rounds.length === 0 ? (
          <div className="empty-state">
            <div className="empty-title">No rounds yet</div>
            <p className="muted">Press “Start a round” above. You can stop at any time and carry on later.</p>
          </div>
        ) : (
          <div className="card table-card">
            <table className="table mt-rounds">
              <thead>
                <tr>
                  <th>Round</th>
                  <th>Result</th>
                  <th>Tester</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {data.rounds.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => go(`#/round/${r.id}`)}>
                    <td>
                      <a href={`#/round/${r.id}`} className="strong">
                        {r.name}
                      </a>
                      <div className="muted small">
                        {[r.build, r.env].filter(Boolean).join(" · ") || "No build given"}
                        {r.finishedAt ? " · finished" : " · in progress"}
                      </div>
                    </td>
                    <td className="mt-rounds-result">
                      <RoundBar counts={r.counts} />
                      <span className="small">
                        <span className="ok">{r.counts.pass} passed</span>, <span className={r.counts.fail ? "bad" : "muted"}>{r.counts.fail} failed</span>, <span className="muted">{r.counts.todo} to do</span>
                      </span>
                    </td>
                    <td>{r.tester}</td>
                    <td className="muted small">{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {tab === "cases" && <CaseSwitches data={data} onChanged={reload} setData={setData} />}
    </div>
  );
}

/** Small dots: this case's results in the last rounds, oldest on the left. */
function HistoryDots({ list }: { list?: (ManualStatus | null)[] }) {
  if (!list?.length) return null;
  const shown = [...list].reverse();
  return (
    <span className="mt-dots" title={`Last rounds, oldest first: ${shown.map((s) => STATUS_WORD[s ?? "todo"]).join(", ")}`}>
      {shown.map((s, i) => (
        <span key={i} className={`mt-dot ${s ?? "todo"}`} />
      ))}
    </span>
  );
}

function CaseSwitches({ data, onChanged, setData }: { data: ManualProjectView; onChanged: () => void; setData: (d: ManualProjectView) => void }) {
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [adding, setAdding] = useState(false);
  const groups = useMemo(() => {
    const m = new Map<string, ManualProjectView["cases"]>();
    for (const c of data.cases) {
      if (q && !`${c.title} ${c.section}`.toLowerCase().includes(q.toLowerCase())) continue;
      m.set(c.section, [...(m.get(c.section) ?? []), c]);
    }
    return [...m.entries()];
  }, [data.cases, q]);

  const flip = async (ids: string[], on: boolean) => {
    setErr("");
    // Show the change at once; the server answer confirms it.
    setData({ ...data, cases: data.cases.map((c) => (ids.includes(c.id) ? { ...c, on } : c)) });
    try {
      await api.manualSwitch(data.project.id, on ? { on: ids } : { off: ids });
    } catch (e) {
      setErr((e as Error).message);
      onChanged();
    }
  };
  const all = async (on: boolean) => {
    setData({ ...data, cases: data.cases.map((c) => ({ ...c, on })) });
    await api.manualSwitch(data.project.id, { all: on }).catch((e) => setErr((e as Error).message));
    onChanged();
  };

  return (
    <div className="mt-cases">
      <div className="filters">
        <input className="input search" placeholder="Find a case" aria-label="Find a case" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="row">
          <button className="btn small" onClick={() => all(true)}>
            Turn all on
          </button>
          <button className="btn small ghost" onClick={() => all(false)}>
            Turn all off
          </button>
          <button className="btn small primary" onClick={() => setAdding((a) => !a)}>
            {adding ? "Close" : "Add your own case"}
          </button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {adding && (
        <OwnCaseForm
          projectId={data.project.id}
          onSaved={() => {
            setAdding(false);
            onChanged();
          }}
        />
      )}
      {groups.map(([section, cases]) => {
        const onCount = cases.filter((c) => c.on).length;
        return (
          <details key={section} className="card mt-group" open={!section.startsWith("Handbook") || Boolean(q)}>
            <summary>
              <span className="strong grow">{section}</span>
              <span className="muted small">
                {onCount} of {cases.length} on
              </span>
              <button
                type="button"
                className={`toggle ${onCount === cases.length ? "on" : ""}`}
                role="switch"
                aria-checked={onCount === cases.length}
                aria-label={`All of ${section}`}
                onClick={(e) => {
                  e.preventDefault();
                  flip(
                    cases.map((c) => c.id),
                    onCount !== cases.length,
                  );
                }}
              >
                <span className="knob" />
              </button>
            </summary>
            <ul className="mt-switch-list">
              {cases.map((c) => (
                <li key={c.id} className={c.on ? "" : "off"}>
                  <label className="check dark">
                    <input type="checkbox" checked={c.on} onChange={(e) => flip([c.id], e.target.checked)} />
                    <span>
                      {c.title}
                      {c.key && <span className="tag">Do first</span>}
                    </span>
                  </label>
                  <HistoryDots list={data.history[c.id]} />
                  <span className="muted small mt-source">{SOURCE_WORD[c.source]}</span>
                  {c.source === "own" && (
                    <button
                      className="btn small ghost danger"
                      onClick={async () => {
                        await api.manualDeleteCase(data.project.id, c.id).catch((e) => setErr((e as Error).message));
                        onChanged();
                      }}
                    >
                      Delete
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      {groups.length === 0 && <div className="empty-state">No case matches “{q}”.</div>}
    </div>
  );
}

function OwnCaseForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState("");
  const [expected, setExpected] = useState("");
  const [section, setSection] = useState("");
  const [err, setErr] = useState("");
  return (
    <form
      className="card form mt-own"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr("");
        try {
          await api.manualAddCase(projectId, { title, steps, expected, section: section || undefined });
          onSaved();
        } catch (er) {
          setErr((er as Error).message);
        }
      }}
    >
      <label className="form-field">
        <span>What to test</span>
        <input className="input" placeholder="Print an invoice" value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
      </label>
      <label className="form-field">
        <span>Steps, one a line</span>
        <textarea className="input" placeholder={"Open an invoice\nPress Print"} value={steps} onChange={(e) => setSteps(e.target.value)} required />
      </label>
      <label className="form-field">
        <span>What should happen</span>
        <input className="input" placeholder="A one-page PDF with the logo and the right total" value={expected} onChange={(e) => setExpected(e.target.value)} />
      </label>
      <label className="form-field">
        <span>Group (optional)</span>
        <input className="input" placeholder="Our own cases" value={section} onChange={(e) => setSection(e.target.value)} />
      </label>
      <div className="form-actions">
        <button className="btn primary">Add the case</button>
        {err && <div className="error">{err}</div>}
      </div>
    </form>
  );
}

type Filter = "all" | "todo" | "fail" | "pass" | "skip";

/** One round: work through the cases. */
export function ManualRoundView({ id }: { id: string }) {
  const [round, setRound] = useState<ManualRound | null>(null);
  const [counts, setCounts] = useState<RoundCounts | null>(null);
  const [project, setProject] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [keyOnly, setKeyOnly] = useState(false);
  const [q, setQ] = useState("");
  const [openCase, setOpenCase] = useState<string | null>(null);

  useEffect(() => {
    api
      .manualRound(id)
      .then((d) => {
        setRound(d.round);
        setCounts(d.counts);
        setProject(d.project);
      })
      .catch((e) => setError((e as Error).message));
  }, [id]);

  const groups = useMemo(() => {
    if (!round) return [];
    const m = new Map<string, ManualCase[]>();
    for (const c of round.cases) {
      const s = round.results[c.id]?.status ?? "todo";
      if (filter !== "all" && s !== filter) continue;
      if (keyOnly && !c.key) continue;
      if (q && !`${c.title} ${c.section} ${c.steps.join(" ")}`.toLowerCase().includes(q.toLowerCase())) continue;
      m.set(c.section, [...(m.get(c.section) ?? []), c]);
    }
    return [...m.entries()];
  }, [round, filter, keyOnly, q]);

  if (error) return <div className="page error big">{error}</div>;
  if (!round || !counts || !project) return <div className="loading">Loading…</div>;
  const locked = Boolean(round.finishedAt);

  const update = (caseId: string, result: ManualResult | null, c?: RoundCounts) => {
    setRound((r) => {
      if (!r) return r;
      const results = { ...r.results };
      if (result) results[caseId] = result;
      else delete results[caseId];
      return { ...r, results };
    });
    if (c) setCounts(c);
  };

  /** After a mark, open the next case that is not tested yet, so a tester can keep going. */
  const next = (after: string) => {
    const flat = groups.flatMap(([, cs]) => cs);
    const i = flat.findIndex((c) => c.id === after);
    const n = flat.slice(i + 1).find((c) => !round.results[c.id]);
    setOpenCase(n?.id ?? null);
  };

  return (
    <div className="page">
      <a href={`#/manual/${project.id}`} className="back">
        ← {project.name}: manual tests
      </a>
      <div className="page-head">
        <div className="grow">
          <h1>{round.name}</h1>
          <p className="muted">
            {round.tester}
            {round.build ? ` · build ${round.build}` : ""}
            {round.env ? ` · ${round.env}` : ""} · started {timeAgo(round.createdAt)}
            {locked ? ` · finished ${timeAgo(round.finishedAt)}` : ""}
          </p>
        </div>
        <div className="header-actions">
          <a className="btn" href={`/api/manual/rounds/${round.id}/export`} download>
            Download CSV
          </a>
          <a className="btn" href={`/api/manual/rounds/${round.id}/export?format=md`} download>
            Download Markdown
          </a>
          <button
            className={`btn ${locked ? "" : "primary"}`}
            onClick={async () => {
              const d = await api.manualUpdateRound(round.id, { finished: !locked });
              setRound(d.round);
              setCounts(d.counts);
            }}
          >
            {locked ? "Reopen the round" : "Finish the round"}
          </button>
        </div>
      </div>

      <div className="card mt-progress">
        <RoundBar counts={counts} big />
        {counts.todo === 0 && !locked && <div className="note">Every case has a result. Press “Finish the round” to lock it.</div>}
        {locked && <div className="note">This round is finished and locked. Reopen it to change a result.</div>}
      </div>

      <div className="filters mt-filters">
        <div className="pills" role="group" aria-label="Show">
          {(
            [
              ["all", `All ${counts.total}`],
              ["todo", `Not tested ${counts.todo}`],
              ["fail", `Failed ${counts.fail}`],
              ["pass", `Passed ${counts.pass}`],
              ["skip", `Skipped ${counts.skip}`],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} className={`pill ${filter === f ? "active" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <div className="row">
          <label className="check dark small">
            <input type="checkbox" checked={keyOnly} onChange={(e) => setKeyOnly(e.target.checked)} /> Only “Do first” cases
          </label>
          <input className="input search" placeholder="Find a case" aria-label="Find a case" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      {groups.length === 0 && (
        <div className="empty-state">
          <div className="empty-title">{filter === "todo" ? "Nothing left to test" : "No case matches"}</div>
          <p className="muted">{filter === "todo" ? "Every case has a result." : "Change the filter above to see more."}</p>
        </div>
      )}
      {groups.map(([section, cases]) => {
        const done = cases.filter((c) => round.results[c.id]).length;
        return (
          <section key={section} className="mt-section">
            <h2 className="mt-section-title">
              <span>{section}</span>
              <span className="muted small">
                {done} of {cases.length} done
              </span>
            </h2>
            <ul className="mt-case-list">
              {cases.map((c) => (
                <CaseRow
                  key={c.id}
                  round={round}
                  c={c}
                  locked={locked}
                  open={openCase === c.id}
                  onToggle={() => setOpenCase((o) => (o === c.id ? null : c.id))}
                  onResult={(r, cnt, advance) => {
                    update(c.id, r, cnt);
                    if (advance) next(c.id);
                  }}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const readAsDataUrl = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("Could not read the picture."));
    r.readAsDataURL(f);
  });

function CaseRow({
  round,
  c,
  locked,
  open,
  onToggle,
  onResult,
}: {
  round: ManualRound;
  c: ManualCase;
  locked: boolean;
  open: boolean;
  onToggle: () => void;
  onResult: (r: ManualResult | null, counts?: RoundCounts, advance?: boolean) => void;
}) {
  const res = round.results[c.id];
  const [note, setNote] = useState(res?.note ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [severity, setSeverity] = useState("medium");
  const rowRef = useRef<HTMLLIElement>(null);
  useEffect(() => setNote(res?.note ?? ""), [res?.note]);
  useEffect(() => {
    if (open) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [open]);

  const mark = async (status: ManualStatus | null) => {
    setErr("");
    try {
      const d = await api.manualMark(round.id, c.id, { status: res?.status === status ? null : status, note: status ? note : undefined });
      // Passing or skipping moves on; a failure stays open for the note and screenshot.
      onResult(d.result, d.counts, status !== "fail" && res?.status !== status);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const saveNote = async () => {
    if ((res?.note ?? "") === note || !res) return;
    try {
      const d = await api.manualMark(round.id, c.id, { note });
      onResult(d.result, d.counts);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const addShot = async (f: Blob | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setErr("Choose a picture (PNG, JPEG, WebP or GIF).");
    setBusy(true);
    setErr("");
    try {
      const d = await api.manualShot(round.id, c.id, await readAsDataUrl(f));
      onResult(d.result);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const status = res?.status ?? "todo";
  return (
    <li
      ref={rowRef}
      className={`mt-case ${status} ${open ? "open" : ""}`}
      onPaste={(e) => {
        if (locked) return;
        const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
        if (item) {
          e.preventDefault();
          addShot(item.getAsFile());
        }
      }}
    >
      <div className="mt-case-head">
        <button className="mt-case-title" aria-expanded={open} onClick={onToggle}>
          <span className={`mt-mark ${status}`} aria-hidden="true" />
          <span className="grow">
            {c.title}
            {c.key && <span className="tag">Do first</span>}
          </span>
          <span className="sr-only">{STATUS_WORD[status]}</span>
        </button>
        <div className="mt-choice" role="group" aria-label={`Result for ${c.title}`}>
          {(["pass", "fail", "skip"] as ManualStatus[]).map((s) => (
            <button key={s} className={`mt-btn ${s} ${status === s ? "active" : ""}`} aria-pressed={status === s} disabled={locked} onClick={() => mark(s)}>
              {s === "pass" ? "Pass" : s === "fail" ? "Fail" : "Skip"}
            </button>
          ))}
        </div>
      </div>
      {open && (
        <div className="mt-case-body">
          <div className="mt-steps">
            <div className="field-label">Steps</div>
            <ol>
              {c.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            <div className="field-label">Should happen</div>
            <p>{c.expected}</p>
            {c.alsoAuto && <p className="muted small">Also checked automatically: {c.alsoAuto}.</p>}
          </div>
          <div className="mt-evidence">
            <label className="form-field">
              <span>Note {status === "fail" ? "(what happened instead)" : "(optional)"}</span>
              <textarea
                className="input"
                value={note}
                disabled={locked || !res}
                placeholder={res ? "What you saw. Paste a screenshot here too (Ctrl+V)." : "Press Pass, Fail or Skip first."}
                onChange={(e) => setNote(e.target.value)}
                onBlur={saveNote}
              />
            </label>
            <div className="mt-shots">
              {(res?.shots ?? []).map((f) => (
                <figure key={f} className="mt-shot">
                  <a href={`/api/manual/rounds/${round.id}/files/${f}`} target="_blank" rel="noreferrer">
                    <img src={`/api/manual/rounds/${round.id}/files/${f}`} alt={`Screenshot for ${c.title}`} />
                  </a>
                  {!locked && (
                    <button
                      className="icon-btn"
                      aria-label="Remove this screenshot"
                      onClick={async () => {
                        await api.manualDeleteShot(round.id, c.id, f).catch((e) => setErr((e as Error).message));
                        onResult({ ...res!, shots: res!.shots!.filter((x) => x !== f) });
                      }}
                    >
                      ×
                    </button>
                  )}
                </figure>
              ))}
              {!locked && (
                <label className="btn small mt-add-shot">
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => addShot(e.target.files?.[0])} hidden />
                  <Icon name="upload" size={16} /> {busy ? "Adding…" : "Add a screenshot"}
                </label>
              )}
            </div>
            {status === "fail" &&
              (res?.issue ? (
                <div className="small">
                  On the issue board as{" "}
                  <a href={`#/issues/${res.issue}?project=${round.projectId}`} className="mono">
                    {res.issue}
                  </a>
                </div>
              ) : (
                <div className="row mt-issue">
                  <select className="input select" value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="How serious">
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        const d = await api.manualIssue(round.id, c.id, severity);
                        onResult({ ...res!, issue: d.key });
                      } catch (e) {
                        setErr((e as Error).message);
                      }
                    }}
                  >
                    Send to the issue board
                  </button>
                </div>
              ))}
            {res && <div className="muted small">{STATUS_WORD[status]} by {res.by}, {timeAgo(res.at)}</div>}
            {err && <div className="error">{err}</div>}
          </div>
        </div>
      )}
    </li>
  );
}
