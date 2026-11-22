import { useEffect, useMemo, useState } from "react";
import type { ControlField, LiveAction, Preset, RunControl, SectionId, Size } from "../../../src/control.ts";
import type { Category } from "../../../src/types.ts";
import { api, type ControlMeta, type Meta, type PermissionView, type ProjectDetail, type RunDetail } from "../api.ts";
import { CATEGORY_LABEL, go, plural } from "../lib.ts";
import { Icon, Toggle } from "../ui.tsx";
import { toolChoices, toolDraft, toolsForType, usablePermission, type ToolDraft } from "./ToolTabs.tsx";

/** Common screen sizes, for the size fields. */
const SIZES: Record<"desktop" | "tablet" | "phone", [string, Size][]> = {
  desktop: [["Laptop 1280 × 800", { width: 1280, height: 800 }], ["Laptop 1366 × 900", { width: 1366, height: 900 }], ["Laptop 1440 × 900", { width: 1440, height: 900 }], ["Full HD 1920 × 1080", { width: 1920, height: 1080 }], ["2K 2560 × 1440", { width: 2560, height: 1440 }], ["4K 3840 × 2160", { width: 3840, height: 2160 }]],
  tablet: [["iPad mini 768 × 1024", { width: 768, height: 1024 }], ["iPad Air 820 × 1180", { width: 820, height: 1180 }], ["Galaxy Tab 800 × 1280", { width: 800, height: 1280 }], ["iPad Pro 1024 × 1366", { width: 1024, height: 1366 }]],
  phone: [["Small Android 360 × 640", { width: 360, height: 640 }], ["Galaxy S 360 × 780", { width: 360, height: 780 }], ["iPhone SE 375 × 667", { width: 375, height: 667 }], ["iPhone 15 393 × 852", { width: 393, height: 852 }], ["iPhone 15 Pro Max 430 × 932", { width: 430, height: 932 }], ["Pixel 8 412 × 915", { width: 412, height: 915 }]],
};

type Path = ControlField["id"];

function getAt(c: RunControl, id: Path): unknown {
  const [a, b] = id.split(".") as [keyof RunControl, string?];
  const v = c[a];
  return b ? (v as Record<string, unknown> | undefined)?.[b] : v;
}

function setAt(c: RunControl, id: Path, value: unknown): RunControl {
  const [a, b] = id.split(".") as [keyof RunControl, string?];
  const next = { ...c } as Record<string, unknown>;
  if (b) {
    const inner = { ...((next[a] as Record<string, unknown>) ?? {}) };
    if (value === undefined) delete inner[b];
    else inner[b] = value;
    if (Object.keys(inner).length) next[a] = inner;
    else delete next[a];
  } else if (value === undefined) delete next[a];
  else next[a] = value;
  return next as RunControl;
}

/** How many settings in a section differ from normal. */
function changedIn(c: RunControl, fields: ControlField[], section: SectionId): number {
  if (section === "scope") return (c.categories?.length ? 1 : 0) + (c.allAgents ? 1 : 0) + Object.keys(c.agents ?? {}).length + (c.tools ? 1 : 0);
  return fields.filter((f) => f.section === section && getAt(c, f.id) !== undefined).length;
}

export function MasterControl({ projectId, meta }: { projectId: string; meta: Meta }) {
  const [detail, setDetail] = useState<ProjectDetail>();
  const [cm, setCm] = useState<ControlMeta>();
  const [draft, setDraft] = useState<RunControl>({});
  const [preset, setPreset] = useState<string>();
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<string[]>([]);
  const [checkError, setCheckError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [presetName, setPresetName] = useState("");
  const [open, setOpen] = useState<SectionId>("scope");

  useEffect(() => {
    Promise.all([api.project(projectId), api.control()])
      .then(([d, c]) => {
        setDetail(d);
        setCm(c);
        setDraft(d.project.control ?? {});
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId]);

  // The server checks the settings as they change, and says in words what they change.
  useEffect(() => {
    if (!detail) return;
    const t = setTimeout(() => {
      api
        .checkControl(projectId, draft)
        .then((r) => {
          setSummary(r.summary);
          setCheckError("");
        })
        .catch((e: Error) => setCheckError(e.message));
    }, 350);
    return () => clearTimeout(t);
  }, [draft, detail, projectId]);

  if (error) return <div className="page error big">{error}</div>;
  if (!detail || !cm) return <div className="loading">Loading…</div>;
  const p = detail.project;
  const type = p.type;
  const fields = cm.fields.filter((f) => f.products.includes(type));
  const sections = cm.sections.filter((s) => s.id === "scope" || fields.some((f) => f.section === s.id));
  const change = (next: RunControl) => {
    setDraft(next);
    setPreset(undefined);
    setNote("");
  };
  const changed = sections.reduce((n, s) => n + changedIn(draft, fields, s.id), 0);

  const start = async () => {
    setBusy(true);
    setNote("");
    try {
      const run = await api.startControlled(p.id, draft, preset);
      go(`#/run/${run.id}`);
    } catch (e) {
      setNote((e as Error).message);
      setBusy(false);
    }
  };
  const saveDefault = async () => {
    try {
      const r = await api.saveProjectControl(p.id, draft);
      setNote(r.control ? "Saved: every test of this project, scheduled ones too, now starts with these settings." : "Cleared: this project's tests use the normal settings again.");
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const savePreset = async () => {
    try {
      const saved = await api.savePreset({ name: presetName, control: draft });
      setCm({ ...cm, presets: [...cm.presets, saved] });
      setPreset(saved.id);
      setPresetName("");
      setNote(`Saved the preset "${saved.name}" for every project of this kind.`);
    } catch (e) {
      setNote((e as Error).message);
    }
  };
  const removePreset = async (x: Preset) => {
    try {
      await api.deletePreset(x.id);
      setCm({ ...cm, presets: cm.presets.filter((y) => y.id !== x.id) });
    } catch (e) {
      setNote((e as Error).message);
    }
  };

  return (
    <div className="page mc-page">
      <a href={`#/project/${p.id}`} className="back">
        ← {p.name}
      </a>
      <div className="page-head">
        <span className="product-icon big mc-icon">
          <Icon name="control" size={26} />
        </span>
        <div className="grow">
          <div className="eyebrow">Master control · {meta.products.find((x) => x.type === type)?.name}</div>
          <h1>Every setting for the next test</h1>
          <div className="muted">Change anything below for one test, save it as this project's default, or keep it as a preset for other projects. Left empty, a setting keeps its normal value.</div>
        </div>
      </div>

      <div className="mc-presets" role="group" aria-label="Presets">
        {cm.presets.map((x) => (
          <span key={x.id} className={`mc-preset ${preset === x.id ? "active" : ""}`}>
            <button
              type="button"
              title={x.about}
              onClick={() => {
                setDraft(x.control);
                setPreset(x.id);
                setNote("");
              }}
            >
              <strong>{x.name}</strong>
              <span className="muted small">{x.about || (x.by ? `Saved by ${x.by}` : "")}</span>
            </button>
            {!x.builtIn && (
              <button type="button" className="mc-preset-x" aria-label={`Delete the preset ${x.name}`} onClick={() => removePreset(x)}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      <div className="mc-layout">
        <nav className="mc-nav" aria-label="Sections">
          {sections.map((s) => {
            const n = changedIn(draft, fields, s.id);
            return (
              <button key={s.id} type="button" className={open === s.id ? "active" : ""} onClick={() => setOpen(s.id)}>
                <span>{s.name}</span>
                {n > 0 && <span className="tab-count">{n}</span>}
              </button>
            );
          })}
          <button type="button" className={open === ("safety" as SectionId) ? "active" : ""} onClick={() => setOpen("safety" as SectionId)}>
            <span>Safety gates</span>
            <span className="tag" title="Set on the project page by the owner">owner</span>
          </button>
        </nav>

        <div className="mc-main">
          {sections
            .filter((s) => s.id === open)
            .map((s) => (
              <section key={s.id} className="card mc-section">
                <div className="mc-section-head">
                  <div>
                    <h2>{s.name}</h2>
                    <div className="muted small">{s.about}</div>
                  </div>
                  {changedIn(draft, fields, s.id) > 0 && (
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => {
                        let next = { ...draft };
                        if (s.id === "scope") {
                          delete next.categories;
                          delete next.agents;
                          delete next.allAgents;
                          delete next.tools;
                        } else for (const f of fields.filter((x) => x.section === s.id)) next = setAt(next, f.id, undefined);
                        change(next);
                      }}
                    >
                      Reset this section
                    </button>
                  )}
                </div>
                {s.id === "scope" ? (
                  <Scope meta={meta} detail={detail} draft={draft} onChange={change} />
                ) : (
                  <div className="mc-fields">
                    {fields
                      .filter((f) => f.section === s.id)
                      .map((f) => (
                        <FieldRow key={f.id} f={f} value={getAt(draft, f.id)} onChange={(v) => change(setAt(draft, f.id, v))} />
                      ))}
                  </div>
                )}
              </section>
            ))}
          {open === ("safety" as SectionId) && <Safety detail={detail} />}
        </div>

        <aside className="card mc-summary">
          <div className="section-label">This test</div>
          <div className="mc-count">{changed ? plural(changed, "setting") + " changed" : "Normal settings"}</div>
          {preset && <div className="muted small">Preset: {cm.presets.find((x) => x.id === preset)?.name}</div>}
          {checkError ? (
            <div className="error small">{checkError}</div>
          ) : summary.length ? (
            <ul className="mc-list">
              {summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : (
            <div className="muted small">Everything runs the way the owner and the project set it.</div>
          )}
          <div className="mc-safe small">
            <Icon name="owner" size={14} /> Load and attack tools, and checks that change data, run once the owner unlocks them on the project page.
          </div>
          <button type="button" className="btn primary mc-go" disabled={busy || Boolean(checkError) || p.busy} onClick={start}>
            {p.busy ? "A test is running" : busy ? "Starting…" : "Start test with these settings"}
          </button>
          <button type="button" className="btn ghost" onClick={saveDefault} disabled={Boolean(checkError)}>
            {changed ? "Save as this project's default" : "Clear the project's default"}
          </button>
          <div className="mc-save-preset">
            <input className="input" placeholder="Preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} aria-label="Preset name" />
            <button type="button" className="btn ghost" disabled={!presetName.trim() || Boolean(checkError)} onClick={savePreset}>
              Save preset
            </button>
          </div>
          {changed > 0 && (
            <button type="button" className="link small" onClick={() => change({})}>
              Reset everything to normal
            </button>
          )}
          {note && <div className="note small">{note}</div>}
        </aside>
      </div>
    </div>
  );
}

/** Kinds of checks, every agent, and the outside tools. */
function Scope({ meta, detail, draft, onChange }: { meta: Meta; detail: ProjectDetail; draft: RunControl; onChange: (c: RunControl) => void }) {
  const p = detail.project;
  const agents = meta.agents.filter((a) => a.products.includes(p.type));
  const cats = [...new Set(agents.map((a) => a.category))] as Category[];
  const [filter, setFilter] = useState("");
  const tools = toolsForType(meta, p.type);
  const tdraft: ToolDraft = useMemo(() => toolDraft(meta, p.type, draft.tools ?? p.tools), [meta, p.type, draft.tools, p.tools]);
  const setTools = (d: ToolDraft) => onChange({ ...draft, tools: toolChoices(meta, d) });
  const isOn = (id: string, enabled: boolean) => draft.agents?.[id] ?? (draft.allAgents || enabled);
  const catOn = (c: Category) => !draft.categories?.length || draft.categories.includes(c);
  const setAgents = (patch: Record<string, boolean>) => {
    const next = { ...(draft.agents ?? {}), ...patch };
    // Back to the owner's choice: not stored.
    for (const a of agents) if (next[a.id] === (draft.allAgents || a.enabled)) delete next[a.id];
    const c: RunControl = { ...draft, agents: next };
    if (!Object.keys(next).length) delete c.agents;
    onChange(c);
  };
  const shown = agents.filter((a) => catOn(a.category) && (!filter || `${a.name} ${a.description}`.toLowerCase().includes(filter.toLowerCase())));
  const onCount = agents.filter((a) => catOn(a.category) && isOn(a.id, a.enabled)).length;

  return (
    <div className="mc-scope">
      <div className="field-label">Kinds of checks</div>
      <div className="mc-chips">
        {cats.map((c) => (
          <button
            key={c}
            type="button"
            className={`mc-chip ${catOn(c) ? "on" : ""}`}
            aria-pressed={catOn(c)}
            onClick={() => {
              const now = draft.categories?.length ? draft.categories : cats;
              const next = now.includes(c) ? now.filter((x) => x !== c) : [...now, c];
              const c2: RunControl = { ...draft };
              if (next.length === cats.length || !next.length) delete c2.categories;
              else c2.categories = next;
              onChange(c2);
            }}
          >
            <span className={`cat-dot cat-${c}`} /> {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>

      <div className="mc-agents-head">
        <div className="field-label">
          GLV agents · {onCount} of {agents.length} on
        </div>
        <input className="input mc-filter" placeholder="Find an agent" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find an agent" />
        <button type="button" className="btn ghost small" onClick={() => setAgents(Object.fromEntries(shown.map((a) => [a.id, true])))}>
          All on
        </button>
        <label className="small mc-inline">
          <Toggle
            on={Boolean(draft.allAgents)}
            onChange={(v) => {
              const c: RunControl = { ...draft };
              if (v) c.allAgents = true;
              else delete c.allAgents;
              onChange(c);
            }}
            label="Every agent, also the ones off by default"
          />
          Every agent
        </label>
        <button type="button" className="btn ghost small" onClick={() => setAgents(Object.fromEntries(shown.map((a) => [a.id, false])))}>
          All off
        </button>
      </div>
      <div className="mc-agents">
        {shown.map((a) => (
          <div key={a.id} className={`mc-agent ${draft.agents?.[a.id] !== undefined ? "changed" : ""}`}>
            <Toggle on={isOn(a.id, a.enabled)} onChange={(v) => setAgents({ [a.id]: v })} label={a.name} />
            <div className="grow">
              <div className="strong small">
                <span className={`cat-dot cat-${a.category}`} /> {a.name}
                {a.needsConsent && <span className="mc-lock">needs test copy or permission</span>}
                {a.needsLogin && <span className="tag">signed-in</span>}
              </div>
              <div className="muted small">{a.description}</div>
            </div>
          </div>
        ))}
      </div>

      {tools.length > 0 && (
        <>
          <div className="mc-agents-head">
            <div className="field-label">Outside tools {draft.tools ? "· chosen for this test" : "· the project's choice"}</div>
            {draft.tools && (
              <button
                type="button"
                className="btn ghost small"
                onClick={() => {
                  const c = { ...draft };
                  delete c.tools;
                  onChange(c);
                }}
              >
                Use the project's tools
              </button>
            )}
          </div>
          <div className="mc-agents">
            {tools.map((t) => {
              const permit = usablePermission(p.permissions, t);
              const locked = (t.safety === "permission" && !permit) || !t.ready;
              const d = tdraft[t.id];
              return (
                <div key={t.id} className={`mc-agent ${locked ? "locked" : ""}`}>
                  <Toggle on={Boolean(d?.on) && !locked} onChange={(v) => !locked && setTools({ ...tdraft, [t.id]: { ...d, on: v } })} label={t.name} />
                  <div className="grow">
                    <div className="strong small">
                      {t.name} <span className="muted">· {t.maker}</span>
                      {t.safety === "permission" &&
                        (permit ? (
                          <span className="mc-ok">{permit.own ? "own system" : "allowed"} until {new Date(permit.until).toLocaleDateString()}</span>
                        ) : (
                          <a className="mc-unlock" href={`#/project/${p.id}?tab=permission`} title="Optional. The rest of the test runs without it.">
                            Optional · unlock
                          </a>
                        ))}
                      {!t.ready && <span className="tag">not installed</span>}
                    </div>
                    <div className="muted small">{t.description}</div>
                    {d?.on && !locked && (t.options ?? []).filter((o) => o.kind !== "file").length > 0 && (
                      <div className="mc-tool-options">
                        {(t.options ?? [])
                          .filter((o) => o.kind !== "file")
                          .map((o) =>
                            o.kind === "text" ? (
                              <label key={o.id} className="small">
                                {o.label}
                                <input className="input" value={d.options[o.id] ?? o.default} placeholder={o.placeholder} maxLength={o.maxLength ?? 500} onChange={(e) => setTools({ ...tdraft, [t.id]: { ...d, options: { ...d.options, [o.id]: e.target.value } } })} />
                              </label>
                            ) : (
                            <label key={o.id} className="small">
                              {o.label}
                              <select className="select" value={d.options[o.id] ?? o.default} onChange={(e) => setTools({ ...tdraft, [t.id]: { ...d, options: { ...d.options, [o.id]: e.target.value } } })}>
                                {o.choices.map((ch) => {
                                  const over = permit && ((t.limits?.users === o.id && Number(ch.value) > permit.maxUsers) || (t.limits?.minutes === o.id && Number(ch.value) > permit.maxMinutes));
                                  return (
                                    <option key={ch.value} value={ch.value} disabled={Boolean(over)}>
                                      {ch.label}
                                      {over ? " (over the permission)" : ""}
                                    </option>
                                  );
                                })}
                              </select>
                            </label>
                            ),
                          )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** One setting. Empty means normal. */
function FieldRow({ f, value, onChange }: { f: ControlField; value: unknown; onChange: (v: unknown) => void }) {
  const changed = value !== undefined;
  const [text, setText] = useState(() => toText(f, value));
  useEffect(() => setText(toText(f, value)), [value, f]);
  let input;
  if (f.kind === "toggle") {
    const v = value as boolean | undefined;
    input = (
      <div className="mc-seg" role="radiogroup" aria-label={f.label}>
        {(
          [
            [undefined, `Normal${f.normal ? ` (${f.normal})` : ""}`],
            [true, "On"],
            [false, "Off"],
          ] as [boolean | undefined, string][]
        ).map(([x, label]) => (
          <button key={label} type="button" role="radio" aria-checked={v === x} className={v === x ? "on" : ""} onClick={() => onChange(x)}>
            {label}
          </button>
        ))}
      </div>
    );
  } else if (f.kind === "select") {
    input = (
      <select className="select" value={(value as string) ?? ""} onChange={(e) => onChange(e.target.value || undefined)} aria-label={f.label}>
        <option value="">Normal{f.normal ? ` (${f.normal})` : ""}</option>
        {f.choices?.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  } else if (f.kind === "number") {
    input = (
      <div className="mc-num">
        <input
          className="input"
          type="number"
          min={f.min}
          max={f.max}
          value={value === undefined ? "" : String(value)}
          placeholder={f.normal ?? "Normal"}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          aria-label={f.label}
        />
        {f.unit && <span className="muted">{f.unit}</span>}
        {f.min !== undefined && f.max !== undefined && (
          <span className="muted small">
            {f.min} to {f.max}
          </span>
        )}
      </div>
    );
  } else if (f.kind === "size") {
    const s = value as Size | undefined;
    const kind = f.id as "desktop" | "tablet" | "phone";
    input = (
      <div className="mc-size">
        <select
          className="select"
          value={s ? (SIZES[kind].find(([, x]) => x.width === s.width && x.height === s.height)?.[0] ?? "custom") : ""}
          onChange={(e) => {
            const hit = SIZES[kind].find(([l]) => l === e.target.value);
            onChange(e.target.value === "" ? undefined : hit ? hit[1] : (s ?? SIZES[kind][0][1]));
          }}
          aria-label={f.label}
        >
          <option value="">Normal{f.normal ? ` (${f.normal})` : ""}</option>
          {SIZES[kind].map(([l]) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
          <option value="custom">Custom size</option>
        </select>
        {s && (
          <>
            <input className="input" type="number" value={s.width} onChange={(e) => onChange({ ...s, width: Number(e.target.value) })} aria-label={`${f.label} width`} />
            <span className="muted">×</span>
            <input className="input" type="number" value={s.height} onChange={(e) => onChange({ ...s, height: Number(e.target.value) })} aria-label={`${f.label} height`} />
          </>
        )}
      </div>
    );
  } else if (f.kind === "text") {
    input = <input className="input" value={(value as string) ?? ""} placeholder={f.normal ?? "Normal"} onChange={(e) => onChange(e.target.value || undefined)} aria-label={f.label} />;
  } else {
    input = (
      <textarea
        className="input mc-text"
        rows={3}
        value={text}
        placeholder={f.kind === "headers" ? "X-Test-Run: glv" : "One per line"}
        onChange={(e) => {
          setText(e.target.value);
          onChange(fromText(f, e.target.value));
        }}
        aria-label={f.label}
      />
    );
  }
  return (
    <div className={`mc-field ${changed ? "changed" : ""}`}>
      <div className="mc-field-label">
        <div className="strong small">{f.label}</div>
        {f.hint && <div className="muted small">{f.hint}</div>}
      </div>
      <div className="mc-field-input">{input}</div>
    </div>
  );
}

function toText(f: ControlField, v: unknown): string {
  if (v === undefined) return "";
  if (f.kind === "headers") return Object.entries(v as Record<string, string>).map(([k, x]) => `${k}: ${x}`).join("\n");
  if (Array.isArray(v)) return v.join("\n");
  return String(v);
}

function fromText(f: ControlField, t: string): unknown {
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  if (f.kind === "headers") {
    const out: Record<string, string> = {};
    for (const l of lines) {
      const i = l.indexOf(":");
      if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    return Object.keys(out).length ? out : undefined;
  }
  return lines;
}

/** What master control cannot change: shown so testers know why a check or tool stays off. */
function Safety({ detail }: { detail: ProjectDetail }) {
  const p = detail.project;
  const active = ((p.permissions ?? []) as PermissionView[]).filter((x) => x.status === "active");
  return (
    <section className="card mc-section">
      <div className="mc-section-head">
        <div>
          <h2>Safety gates</h2>
          <div className="muted small">The owner opens these once on the project page (for our own systems, or with a client's permission). Master control can then use them.</div>
        </div>
      </div>
      <div className="mc-gates">
        <div className="mc-gate">
          <div className="strong">Checks that change data</div>
          <div className={p.writes.allowed ? "ok small" : "muted small"}>{p.writes.allowed ? `Allowed: ${p.writes.why}` : `Off: ${p.writes.why}`}</div>
          <div className="muted small">Account lockout, file uploads, mass assignment, forgot password, the Salesforce guest check, filling forms. Only on a test copy, on our own system, or with the client's written permission.</div>
          {!p.writes.allowed && (
            <a className="btn small ghost gate-btn" href={`#/project/${p.id}?tab=permission`}>
              Unlock on the project page
            </a>
          )}
        </div>
        <div className="mc-gate">
          <div className="strong">Load and attack tools</div>
          <div className={active.length ? "ok small" : "muted small"}>
            {active.length
              ? `Unlocked: ${plural(active.length, "permission")} on file, up to ${Math.max(...active.map((x) => x.maxUsers))} users for ${Math.max(...active.map((x) => x.maxMinutes))} minutes`
              : "Not unlocked yet. These optional tools stay off; every other check still runs."}
          </div>
          <div className="muted small">k6, JMeter, ZAP's attack scan, GLV's probes and the hack agent. Checked again just before each one runs, and never on a schedule.</div>
          {!active.length && (
            <a className="btn small primary gate-btn" href={`#/project/${p.id}?tab=permission`}>
              Unlock load and attack tools
            </a>
          )}
        </div>
        <div className="mc-gate">
          <div className="strong">Saved logins</div>
          <div className="muted small">Master control cannot send Cookie or Authorization headers. Logins stay encrypted in the vault and are never shown.</div>
        </div>
      </div>
      <a className="btn ghost" href={`#/project/${p.id}`}>
        Open the project page
      </a>
    </section>
  );
}

/** Master control while a test runs: pause, resume, skip pages, finish now. */
export function LiveControlBar({ run, onChange, screens }: { run: RunDetail; onChange: () => void; screens: number }) {
  const actions = run.liveActions ?? [];
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (run.status !== "running" || !actions.length) return null;
  const g = run.gateState;
  const act = async (action: LiveAction, slot?: number) => {
    setBusy(true);
    setError("");
    try {
      await api.liveControl(run.id, action, slot);
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`card mc-livebar ${g?.paused ? "paused" : ""}`} role="toolbar" aria-label="Master control">
      <span className="mc-livebar-title">
        <Icon name="control" size={16} /> Master control
      </span>
      <span className="mc-livebar-state small">
        {g?.finishing ? `Finishing: ${g.finishing}` : g?.paused ? `Paused${g.pausedBy ? ` by ${g.pausedBy}` : ""}` : "Running"}
        {g?.skipped ? ` · ${plural(g.skipped, "page")} skipped` : ""}
      </span>
      {g?.paused ? (
        <button type="button" className="btn primary small" disabled={busy} onClick={() => act("resume")}>
          Resume
        </button>
      ) : (
        <button type="button" className="btn small" disabled={busy || Boolean(g?.finishing)} onClick={() => act("pause")}>
          Pause
        </button>
      )}
      {actions.includes("skip") && (
        <>
          <button type="button" className="btn ghost small" disabled={busy || Boolean(g?.finishing)} onClick={() => act("skip")} title="Every open page stops its checks at the next step; the test goes on with the next pages">
            Skip open pages
          </button>
          {screens > 1 && (
            <select
              className="select small"
              value=""
              aria-label="Skip the page on one screen"
              onChange={(e) => e.target.value !== "" && act("skip", Number(e.target.value))}
              disabled={busy || Boolean(g?.finishing)}
            >
              <option value="">Skip one screen…</option>
              {Array.from({ length: screens }, (_, i) => (
                <option key={i} value={i}>
                  Screen {i + 1}
                </option>
              ))}
            </select>
          )}
        </>
      )}
      {actions.includes("finish") && (
        <button type="button" className="btn ghost small" disabled={busy || Boolean(g?.finishing)} onClick={() => act("finish")} title="No new pages: the site-wide checks run and the pages tested so far are scored">
          Finish now
        </button>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}

/** On the report: pass or fail, and the settings master control changed for this test. */
export function ControlCard({ run }: { run: RunDetail }) {
  if (!run.verdict && !run.controlSummary?.length) return null;
  const v = run.verdict;
  return (
    <section className={`card mc-report ${v ? (v.passed ? "pass" : "fail") : ""}`}>
      {v && (
        <div className="mc-verdict">
          <span className={`mc-verdict-badge ${v.passed ? "pass" : "fail"}`}>{v.passed ? "PASS" : "FAIL"}</span>
          <span>{v.passed ? "Every pass-or-fail rule was met." : v.reasons.join(" · ")}</span>
        </div>
      )}
      {run.controlSummary && run.controlSummary.length > 0 && (
        <details>
          <summary className="small">
            Master control: {plural(run.controlSummary.length, "setting")} changed
            {run.controlBy?.preset ? ` · preset "${run.controlBy.preset}"` : ""}
            {run.controlBy?.name ? ` · started by ${run.controlBy.name}` : ""}
          </summary>
          <ul className="mc-list">
            {run.controlSummary.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
