import { useMemo, useState } from "react";
import type { Category, User } from "../../../src/types.ts";
import { api, type Meta } from "../api.ts";
import { CATEGORY_LABEL, go, plural, usePoll } from "../lib.ts";
import { OpenCounts, Toggle } from "../ui.tsx";

type Tab = "overview" | "agents" | "team" | "settings";
const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["agents", "Agents"],
  ["team", "Team"],
  ["settings", "Settings"],
];

export function Owner({ tab, meta, reloadMeta, user }: { tab?: string; meta: Meta; reloadMeta: () => void; user: User }) {
  const current = (TABS.find(([t]) => t === tab)?.[0] ?? "overview") as Tab;
  if (user.role !== "owner") {
    return (
      <div className="page">
        <h1>Owner panel</h1>
        <p className="muted">Only the owner can open this panel.</p>
      </div>
    );
  }
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Owner panel</div>
          <h1>Control the testing system</h1>
        </div>
      </div>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={current === t ? "active" : ""} onClick={() => go(`#/owner/${t}`)}>
            {label}
          </button>
        ))}
      </div>
      {current === "overview" && <OverviewTab />}
      {current === "agents" && <AgentsTab meta={meta} reloadMeta={reloadMeta} />}
      {current === "team" && <TeamTab me={user} />}
      {current === "settings" && <SettingsTab meta={meta} reloadMeta={reloadMeta} />}
    </div>
  );
}

function OverviewTab() {
  const { data: o, error } = usePoll(() => api.overview(), [], 5000);
  if (error) return <div className="error">{error}</div>;
  if (!o) return <div className="loading">Loading…</div>;
  const tiles: [string, string | number, string][] = [
    ["Projects", o.projects, `${o.scheduled} re-tested on a schedule`],
    ["Tests this week", o.runsThisWeek, `${o.runsTotal} in total`],
    ["Fixed this week", o.fixedThisWeek, "verified by a re-test"],
    ["Agents on", `${o.agents.on} / ${o.agents.total}`, "switch them in the Agents tab"],
    ["Running now", o.queue.active, `${o.queue.waiting} waiting · ${o.queue.concurrency} at a time`],
    ["Team", o.users, plural(o.users, "account")],
  ];
  return (
    <>
      <div className="tile-grid">
        {tiles.map(([label, value, sub]) => (
          <div className="card tile" key={label}>
            <div className="stat-label">{label}</div>
            <div className="tile-value">{value}</div>
            <div className="muted small">{sub}</div>
          </div>
        ))}
      </div>
      <div className="two-col">
        <div className="card">
          <div className="stat-label">Open issues across all projects</div>
          <OpenCounts open={o.issues.open} />
          <div className="muted small">
            {o.issues.byStatus.reopened} came back after a fix · {o.issues.byStatus.fixed} waiting for re-test ·{" "}
            {o.issues.byStatus.verified} verified fixed
          </div>
          <a href="#/issues" className="small">
            Open the issue board →
          </a>
        </div>
        <div className="card">
          <div className="stat-label">Product engines</div>
          <ul className="engine-list">
            {o.products.map((p) => (
              <li key={p.type}>
                <span>{p.name}</span>
                <span className={p.available ? "ok" : "muted"}>
                  {p.available ? plural(p.projects, "project") : "Next update"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className={`card ai-line ${o.ai ? "on" : ""}`}>
        {o.ai
          ? "Claude summaries are available: an API key is set on the server."
          : "Claude summaries are off: add ANTHROPIC_API_KEY to the server's .env file and restart."}
      </div>
    </>
  );
}

function AgentsTab({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const byCategory = useMemo(() => {
    const m = new Map<Category, Meta["agents"]>();
    for (const a of meta.agents) m.set(a.category, [...(m.get(a.category) ?? []), a]);
    return [...m.entries()];
  }, [meta]);
  const on = meta.agents.filter((a) => a.enabled).length;

  const set = async (id: string, enabled: boolean) => {
    setPending(id);
    setError("");
    try {
      await api.updateSettings({ agents: { [id]: enabled } });
      reloadMeta();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <p className="muted">
        {on} of {meta.agents.length} specialist agents are on. Turned-off agents skip every new test; reports already made
        are not changed. API, code and Android agents arrive with their engines.
      </p>
      {error && <div className="error">{error}</div>}
      {byCategory.map(([cat, agents]) => (
        <div key={cat} className="agent-group">
          <h2 className="section-title">
            <span className={`cat-dot cat-${cat}`} /> {CATEGORY_LABEL[cat]}
          </h2>
          <div className="card agent-list">
            {agents.map((a) => (
              <div className="agent-row" key={a.id}>
                <div className="grow">
                  <div className="strong">{a.name}</div>
                  <div className="muted small">{a.description}</div>
                  <code className="muted small">{a.id}</code>
                </div>
                <Toggle on={a.enabled} label={`${a.name} on or off`} onChange={(v) => pending !== a.id && set(a.id, v)} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function TeamTab({ me }: { me: User }) {
  const { data: users, error, reload } = usePoll(() => api.users(), [], 0, () => false);
  const [form, setForm] = useState({ name: "", email: "", password: "", role: "member" as "owner" | "member" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  return (
    <div className="two-col">
      <div className="card">
        <div className="stat-label">Accounts</div>
        {error && <div className="error">{error}</div>}
        <ul className="user-list">
          {users?.map((u) => (
            <li key={u.id}>
              <div className="grow">
                <div className="strong">
                  {u.name} {u.id === me.id && <span className="muted">(you)</span>}
                </div>
                <div className="muted small">
                  {u.email} · {u.role === "owner" ? "Owner" : "Team member"}
                </div>
              </div>
              {u.id !== me.id && (
                <button
                  className="btn small ghost"
                  onClick={async () => {
                    if (!window.confirm(`Remove ${u.name}?`)) return;
                    await api.removeUser(u.id).catch((e: Error) => setErr(e.message));
                    reload();
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          setMsg("");
          try {
            await api.addUser(form);
            setMsg(`${form.name || form.email} can now sign in.`);
            setForm({ name: "", email: "", password: "", role: "member" });
            reload();
          } catch (e2) {
            setErr((e2 as Error).message);
          }
        }}
      >
        <div className="stat-label">Add a team member</div>
        <p className="muted small">Team members can run tests and work on issues. Only owners open this panel.</p>
        <label className="form-field">
          <span>Name</span>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="form-field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span>Temporary password (at least 10 characters)</span>
          <input
            className="input"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span>Role</span>
          <select
            className="input"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as "owner" | "member" })}
          >
            <option value="member">Team member</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <button className="btn primary">Add account</button>
        {msg && <div className="ok small">{msg}</div>}
        {err && <div className="error">{err}</div>}
      </form>
    </div>
  );
}

function SettingsTab({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const [pages, setPages] = useState(meta.defaultMaxPages);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pw, setPw] = useState({ current: "", password: "" });
  const save = async (patch: Parameters<typeof api.updateSettings>[0]) => {
    setErr("");
    try {
      await api.updateSettings(patch);
      reloadMeta();
      setMsg("Saved");
      setTimeout(() => setMsg(""), 1500);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="two-col">
      <div className="card form">
        <div className="stat-label">Testing {msg && <span className="saved">{msg}</span>}</div>
        <label className="form-field">
          <span>Default pages per test</span>
          <input
            className="input"
            type="number"
            min={1}
            max={200}
            value={pages}
            onChange={(e) => setPages(Number(e.target.value))}
            onBlur={() => pages !== meta.defaultMaxPages && save({ defaultMaxPages: pages })}
          />
        </label>
        <div className="agent-row">
          <div className="grow">
            <div className="strong">Claude summary on reports</div>
            <div className="muted small">
              {meta.ai
                ? "An API key is set. Each finished test gets a plain-English summary and top fixes."
                : "Needs ANTHROPIC_API_KEY in the server's .env file."}
            </div>
          </div>
          <Toggle on={meta.aiSummary && meta.ai} label="Claude summary on or off" onChange={(v) => save({ aiSummary: v })} />
        </div>
        {err && <div className="error">{err}</div>}
      </div>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr("");
          try {
            await api.changePassword(pw);
            setPw({ current: "", password: "" });
            setMsg("Password changed");
          } catch (e2) {
            setErr((e2 as Error).message);
          }
        }}
      >
        <div className="stat-label">Change my password</div>
        <label className="form-field">
          <span>Current password</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={pw.current}
            onChange={(e) => setPw({ ...pw, current: e.target.value })}
          />
        </label>
        <label className="form-field">
          <span>New password</span>
          <input
            className="input"
            type="password"
            minLength={10}
            autoComplete="new-password"
            value={pw.password}
            onChange={(e) => setPw({ ...pw, password: e.target.value })}
          />
        </label>
        <button className="btn">Change password</button>
      </form>
    </div>
  );
}
