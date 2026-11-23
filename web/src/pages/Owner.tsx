import { useEffect, useMemo, useState } from "react";
import type { Category, User } from "../../../src/types.ts";
import { api, type DeviceView, type HelperView, type Meta } from "../api.ts";
import type { FarmPhone } from "../../../src/mobile/farm.ts";
import { CATEGORY_LABEL, go, plural, timeAgo, usePoll } from "../lib.ts";
import { CrawlNote, MAX_PAGES, OpenCounts, PasswordInput, Toggle } from "../ui.tsx";

type Tab = "overview" | "agents" | "modules" | "team" | "macs" | "devices" | "settings";
const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["agents", "Agents"],
  ["modules", "Modules"],
  ["team", "Team"],
  ["macs", "Mac helpers"],
  ["devices", "Test phones"],
  ["settings", "Settings"],
];

export function Owner({
  tab,
  meta,
  reloadMeta,
  user,
  loginOff,
}: {
  tab?: string;
  meta: Meta;
  reloadMeta: () => void;
  user: User;
  loginOff: boolean;
}) {
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
      {current === "modules" && <ModulesTab meta={meta} reloadMeta={reloadMeta} />}
      {current === "team" && <TeamTab me={user} />}
      {current === "macs" && <MacsTab />}
      {current === "devices" && <DevicesTab />}
      {current === "settings" && <SettingsTab meta={meta} reloadMeta={reloadMeta} loginOff={loginOff} />}
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
                  {p.available ? plural(p.projects, "project") : "Coming soon"}
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

const ENGINE_LABEL: Record<string, string> = {
  web: "Websites and web apps (real browser)",
  api: "APIs (OpenAPI / Swagger)",
  code: "Source code (offline)",
  mobile: "Android apps (APK)",
};

function AgentsTab({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const byEngine = useMemo(() => {
    const m = new Map<string, Meta["agents"]>();
    for (const a of meta.agents) m.set(a.engine, [...(m.get(a.engine) ?? []), a]);
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
        are not changed.
      </p>
      {error && <div className="error">{error}</div>}
      {byEngine.map(([engine, agents]) => (
        <div key={engine} className="agent-group">
          <h2 className="section-title">
            {ENGINE_LABEL[engine] ?? engine} <span className="muted">· {plural(agents.length, "agent")}</span>
          </h2>
          <div className="card agent-list">
            {agents.map((a) => (
              <div className="agent-row" key={a.id}>
                <div className="grow">
                  <div className="strong">
                    <span className={`cat-dot cat-${a.category}`} /> {a.name}{" "}
                    <span className="muted small">· {CATEGORY_LABEL[a.category]}</span>
                  </div>
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

/** Optional modules: open-source parts of the system the owner switches on or off. */
function ModulesTab({ meta, reloadMeta }: { meta: Meta; reloadMeta: () => void }) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const set = async (id: string, on: boolean, needsRestart?: boolean) => {
    setPending(id);
    setError("");
    try {
      await api.updateSettings({ modules: { [id]: on } });
      if (needsRestart) setRestart(true);
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
        Optional parts of the system. Each is open source and runs on this server: nothing is sent to an outside service. A
        module that is off costs no time in a test. Changes apply from the next test.
      </p>
      {restart && <div className="notice">Restart the server for the own checks folder to load or unload (docker compose restart).</div>}
      {error && <div className="error">{error}</div>}
      <div className="card agent-list">
        {meta.modules.map((m) => (
          <div className="agent-row" key={m.id}>
            <div className="grow">
              <div className="strong">
                {m.name} {m.defaultOn ? <span className="tag">On by default</span> : <span className="tag muted">Optional</span>}
              </div>
              <div className="muted small">{m.description}</div>
              <div className="muted small">
                Built on {m.builtOn} · licence {m.license}
                {m.needsRestart ? " · needs a restart" : ""}
              </div>
              {!m.ready && m.profile && (
                <div className="notice small module-setup">
                  Not installed on this server yet. Start it with <code>docker compose --profile {m.profile} up -d</code>, add{" "}
                  <code>{m.env}=…</code> to <code>.env</code> (see <code>.env.example</code>) and run <code>docker compose up -d</code>.
                </div>
              )}
            </div>
            {m.ready ? (
              <Toggle on={m.on} label={`${m.name} on or off`} onChange={(v) => pending !== m.id && set(m.id, v, m.needsRestart)} />
            ) : (
              <span className="tag muted">Not installed</span>
            )}
          </div>
        ))}
      </div>
      <h2 className="section-title">Write your own check</h2>
      <div className="card">
        <p className="muted small">
          Turn on <b>Own checks folder</b>, put a file like this in <code>data/modules/</code> (in Docker: the agent-data volume,{" "}
          <code>/data/modules/</code>) and restart. It runs on every page, next to the GLV agents, and its findings show in the
          report and on the Issues board.
        </p>
        <pre className="code-block">{`// data/modules/no-whatsapp-button.mjs
export default {
  id: "no-whatsapp-button",
  name: "WhatsApp button",
  description: "Every page should have our WhatsApp chat button.",
  category: "functional",
  async run({ page, url }) {
    const has = await page.locator('a[href*="wa.me"], a[href*="whatsapp"]').count();
    return has ? [] : [{
      rule: "no-whatsapp-button", severity: "low", category: "functional",
      title: "No WhatsApp button on the page",
      detail: "Clients reach us on WhatsApp; add the chat button.",
      pageUrl: url,
    }];
  },
};`}</pre>
      </div>
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
          <PasswordInput
            className="input"
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

const KIND_LABEL: Record<string, string> = { safari: "Safari", voiceover: "VoiceOver", "ios-app": "iOS apps" };

function MacsTab() {
  const { data, error, reload } = usePoll(() => api.helpers(), [], 10_000);
  const [name, setName] = useState("");
  const [paired, setPaired] = useState<{ name: string; token: string } | null>(null);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const commands = paired ? `cd glv-helper\nnode glv-helper.mjs pair ${window.location.origin} ${paired.token}\ncaffeinate -i node glv-helper.mjs` : "";

  return (
    <>
      <p className="muted">
        A Mac helper lets tests use a real Mac: Safari on the Mac and in the iPhone and iPad Simulator, VoiceOver reading pages
        aloud, and the iOS Simulator to install an app and run Apple's accessibility audit. The Mac asks this server for work, so
        nothing has to be opened on the Mac's network. Turn these tests on per test, in the Tools step.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="two-col">
        <div className="card">
          <div className="stat-label">
            Paired Macs{" "}
            {data && data.queued > 0 && <span className="muted">· {plural(data.queued, "test")} waiting for a Mac</span>}
          </div>
          {data && !data.helpers.length && <p className="muted small">No Mac is paired yet. Pair one with the form on the right.</p>}
          <ul className="user-list helper-list">
            {data?.helpers.map((h) => (
              <HelperRow
                key={h.id}
                h={h}
                onRemove={async () => {
                  if (!window.confirm(`Unpair ${h.name}? It stops getting tests; pair it again to use it.`)) return;
                  await api.removeHelper(h.id).catch((e: Error) => setErr(e.message));
                  reload();
                }}
              />
            ))}
          </ul>
        </div>
        <form
          className="card form"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr("");
            setCopied(false);
            try {
              const r = await api.addHelper(name);
              setPaired({ name: r.helper.name, token: r.token });
              setName("");
              reload();
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
        >
          <div className="stat-label">Pair a Mac</div>
          <label className="form-field">
            <span>Name of the Mac</span>
            <input className="input" required maxLength={60} placeholder="Lucky's MacBook" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn primary">Make a pairing token</button>
          {err && <div className="error">{err}</div>}
          {paired && (
            <div className="helper-token">
              <div className="strong">Run this in Terminal on {paired.name}, in the folder where you unzipped the helper:</div>
              <div className="code-block">
                <div className="code-label">
                  Terminal
                  <button
                    type="button"
                    className="copy"
                    onClick={() => {
                      navigator.clipboard?.writeText(commands);
                      setCopied(true);
                    }}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre>{commands}</pre>
              </div>
              <div className="muted small">
                The token is shown only this once. It lets the Mac pick up tests and send back what it saw; it cannot sign in to
                the dashboard. <code>caffeinate -i</code> keeps the Mac awake while the helper runs.
              </div>
            </div>
          )}
        </form>
      </div>
      <div className="card helper-setup">
        <div className="stat-label">Set up the Mac (once)</div>
        <ol>
          <li>
            <a href={api.helperDownload} download>
              Download the Mac helper
            </a>{" "}
            and unzip it. It needs Node.js 22 or newer on the Mac (check with <code>node -v</code>).
          </li>
          <li>
            <strong>Safari:</strong> run <code>safaridriver --enable</code> in Terminal once (it asks for the Mac's password). For
            iPhone and iPad Safari, the iOS Simulator from Xcode is used.
          </li>
          <li>
            <strong>VoiceOver:</strong> open VoiceOver Utility &gt; General and tick "Allow VoiceOver to be controlled with
            AppleScript". On the first test, macOS asks to let Terminal control VoiceOver and Safari: allow it (System Settings &gt;
            Privacy &amp; Security &gt; Automation).
          </li>
          <li>
            <strong>iOS apps:</strong> install Xcode from the App Store, open it once, and add an iOS 17 or newer Simulator in
            Xcode &gt; Settings &gt; Components. The first app test builds GLV's audit runner, which takes a few minutes.
          </li>
          <li>
            Optional: <code>node glv-helper.mjs devices on</code> also uses iPhones and iPads connected by cable, for Development
            and Ad Hoc builds. The app is installed on that phone, so use a test phone.
          </li>
          <li>
            <code>node glv-helper.mjs check</code> shows what the Mac can do, with the step that fixes anything missing. The same
            appears here once the Mac connects.
          </li>
        </ol>
      </div>
    </>
  );
}

function HelperRow({ h, onRemove }: { h: HelperView; onRemove: () => void }) {
  const info = h.info;
  const versions = [
    info?.macos && `macOS ${info.macos}`,
    info?.xcode && `Xcode ${info.xcode}`,
    info?.safari && `Safari ${info.safari}`,
    info && `helper ${info.version}`,
  ].filter(Boolean);
  const sims = info?.simulators ?? [];
  const devices = info?.devices ?? [];
  return (
    <li>
      <div className="grow">
        <div className="strong">
          <span className={`helper-dot ${h.online ? "on" : ""}`} aria-hidden /> {h.name}{" "}
          <span className="muted small">
            · {h.online ? "Online" : h.lastSeen ? `Offline, last seen ${timeAgo(h.lastSeen)}` : "Not connected yet"}
          </span>
        </div>
        {h.busy && (
          <div className="small">
            Running {h.busy.label}, since {timeAgo(h.busy.since)}
          </div>
        )}
        {versions.length > 0 && <div className="muted small">{versions.join(" · ")}</div>}
        {info && (
          <div className="helper-kinds">
            {(["safari", "voiceover", "ios-app"] as const).map((k) => {
              const ok = info.kinds.includes(k);
              return (
                <span key={k} className={`helper-kind ${ok ? "ok" : "bad"}`} title={info.problems?.[k] ?? ""}>
                  {ok ? "✓" : "✗"} {KIND_LABEL[k]}
                </span>
              );
            })}
          </div>
        )}
        {info?.problems &&
          Object.entries(info.problems).map(([k, why]) => (
            <div key={k} className="muted small">
              {KIND_LABEL[k] ?? k}: {why}
            </div>
          ))}
        {info && (sims.length > 0 || devices.length > 0) && (
          <div className="muted small">
            {plural(sims.filter((s) => s.type === "iphone").length, "iPhone simulator")} ·{" "}
            {plural(sims.filter((s) => s.type === "ipad").length, "iPad simulator")}
            {devices.length > 0 && ` · connected: ${devices.map((d) => d.name).join(", ")}`}
          </div>
        )}
        <div className="muted small">
          Paired by {h.createdBy} {timeAgo(h.createdAt)}
        </div>
      </div>
      <button className="btn small ghost" onClick={onRemove}>
        Unpair
      </button>
    </li>
  );
}

function SettingsTab({ meta, reloadMeta, loginOff }: { meta: Meta; reloadMeta: () => void; loginOff: boolean }) {
  const [pages, setPages] = useState(meta.defaultMaxPages);
  const [together, setTogether] = useState(meta.parallelPages);
  const [projectsAtOnce, setProjectsAtOnce] = useState(meta.parallelProjects);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [pw, setPw] = useState({ current: "", password: "" });
  // The vault count changes as projects get logins: refresh it whenever this tab opens.
  useEffect(reloadMeta, [reloadMeta]);
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
            max={MAX_PAGES}
            value={pages}
            onChange={(e) => setPages(Number(e.target.value))}
            onBlur={() => pages !== meta.defaultMaxPages && save({ defaultMaxPages: pages })}
          />
          <CrawlNote pages={pages} parallel={meta.parallelPages} />
        </label>
        <label className="form-field">
          <span>Projects tested at the same time</span>
          <input
            className="input"
            type="number"
            min={1}
            max={meta.maxParallelProjects}
            value={projectsAtOnce}
            onChange={(e) => setProjectsAtOnce(Number(e.target.value))}
            onBlur={() => {
              const n = Math.min(Math.max(Math.round(projectsAtOnce) || 1, 1), meta.maxParallelProjects);
              setProjectsAtOnce(n);
              if (n !== meta.parallelProjects) save({ parallelProjects: n });
            }}
          />
          <span className="field-hint">
            How many tests run together (1 to {meta.maxParallelProjects}). Others wait for a free slot and start on their own; the
            sidebar shows how many are running. Each test uses about 1 to 2 CPU cores and 1 to 2 GB of memory, so on an 8 GB
            computer 2 or 3 is a good limit.
          </span>
        </label>
        <label className="form-field">
          <span>Pages tested at the same time</span>
          <input
            className="input"
            type="number"
            min={1}
            max={meta.maxParallel}
            value={together}
            onChange={(e) => setTogether(Number(e.target.value))}
            onBlur={() => {
              const n = Math.min(Math.max(Math.round(together) || 1, 1), meta.maxParallel);
              setTogether(n);
              if (n !== meta.parallelPages) save({ parallelPages: n });
            }}
          />
          <span className="field-hint">
            Each page gets its own browser screen, with all its agents checking it together. More is faster, up to what the
            site and this server can take (1 to {meta.maxParallel}). Sites that answer "too many requests" are tested one page at a
            time on their own.
          </span>
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
      {loginOff ? (
        <div className="card form">
          <div className="stat-label">Login is off</div>
          <p className="muted small">
            The server runs with AUTH_DISABLED=1, so there is no sign-in and everyone who opens the dashboard is the owner. It
            only accepts visits from this computer and its local network.
          </p>
          <p className="muted small">
            Before you put it on a server, set AUTH_DISABLED=0 in the .env file and restart. The dashboard then asks for the owner
            account (or uses OWNER_EMAIL and OWNER_PASSWORD from .env).
          </p>
        </div>
      ) : (
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
            <PasswordInput
              className="input"
              autoComplete="current-password"
              value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })}
            />
          </label>
          <label className="form-field">
            <span>New password</span>
            <PasswordInput
              className="input"
              minLength={10}
              autoComplete="new-password"
              value={pw.password}
              onChange={(e) => setPw({ ...pw, password: e.target.value })}
            />
          </label>
          <button className="btn">Change password</button>
        </form>
      )}
      <div className="card form">
        <div className="stat-label">Login vault</div>
        <p className="muted small">
          {meta.vault.saved === 1 ? "1 project has a saved login" : `${meta.vault.saved} projects have a saved login`} (website
          sign-ins, API keys and Git tokens), encrypted with AES-256-GCM. Secrets are never shown again or put in reports.
        </p>
        {meta.vault.source === "env" ? (
          <p className="muted small">The key comes from SECRET_KEY in the server's .env file.</p>
        ) : (
          <p className="muted small">
            The key is kept in the data folder, which is fine on your own computer. On a server, set SECRET_KEY in .env
            (make one with <code>openssl rand -base64 32</code>) and restart: saved logins move to it on their own.
          </p>
        )}
        {meta.vault.unreadable > 0 && (
          <div className="error">
            {meta.vault.unreadable} saved login(s) were encrypted with a different SECRET_KEY. Enter them again on their
            project pages.
          </div>
        )}
      </div>
    </div>
  );
}

const EMPTY_DEVICE = { name: "", platform: "android", kind: "phone", appiumUrl: "http://", udid: "", deviceName: "", platformVersion: "", serverAddress: "" };
type DeviceForm = typeof EMPTY_DEVICE;

/** GLV's phone farm: real phones on DeviceFarmer (Android) and go-ios (iPhones), taken as test phones. */
function FarmCard({ onTaken }: { onTaken: () => void }) {
  const [farm, setFarm] = useState<{ phones: FarmPhone[]; notes: string[] } | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const load = async () => {
    try {
      setFarm(await api.farm());
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, []);
  return (
    <div className="card farm-card">
      <div className="stat-label">
        Phone farm{" "}
        <button className="btn small ghost" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="muted small">
        GLV's own rack of real phones: Android through DeviceFarmer (STF), iPhones on USB through go-ios. Take one to use it as a test
        phone; remove it from the list to give it back.
      </p>
      {err && <div className="error small">{err}</div>}
      {farm?.notes.map((n) => (
        <div key={n} className="muted small">
          {n}
        </div>
      ))}
      <ul className="user-list helper-list">
        {farm?.phones.map((p) => (
          <li key={`${p.source}:${p.serial}`}>
            <div className="grow">
              <div className="strong">
                <span className={`helper-dot ${p.available ? "on" : ""}`} aria-hidden /> {p.name}{" "}
                <span className="muted small">
                  · {p.platform === "ios" ? "iOS" : "Android"} {p.version ?? ""}
                  {p.battery !== undefined ? ` · battery ${p.battery}%` : ""}
                </span>
              </div>
              <div className="muted small">
                {p.serial}
                {p.usedBy ? ` · in use by ${p.usedBy}` : ""}
              </div>
            </div>
            <button
              className="btn small"
              disabled={!p.available || busy === p.serial}
              onClick={async () => {
                setBusy(p.serial);
                setErr("");
                try {
                  await api.useFarmPhone(p.source, p.serial);
                  onTaken();
                  await load();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === p.serial ? "Taking…" : "Use as test phone"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DevicesTab() {
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState("");
  const [form, setForm] = useState<DeviceForm>(EMPTY_DEVICE);
  const [editing, setEditing] = useState<string | null>(null);
  const load = async (check: boolean) => {
    if (check) setChecking(true);
    try {
      setDevices((await api.devices(check)).devices);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    load(true);
  }, []);
  const set = (k: keyof DeviceForm) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  return (
    <>
      <p className="muted">
        A test phone is an Appium server with a phone, emulator or Simulator behind it. A test of an Android or iOS app then
        installs the app there, opens every screen it can reach, taps buttons (never ones like Buy, Delete or Log out), and
        looks for crashes, screens a screen reader cannot use, slow starts, and what the app sends over the network. Turn it on
        per project, in its What runs tab: "Run on a test phone (Appium)".
      </p>
      {err && <div className="error">{err}</div>}
      <div className="two-col">
        <div className="card">
          <div className="stat-label">
            Test phones{" "}
            <button className="btn small ghost" disabled={checking} onClick={() => load(true)}>
              {checking ? "Checking…" : "Check again"}
            </button>
          </div>
          {devices && !devices.length && (
            <p className="muted small">
              No test phone yet. Start the built-in Android emulator with <code>docker compose --profile android up -d</code>, or
              add an Appium server with the form.
            </p>
          )}
          <ul className="user-list helper-list">
            {devices?.map((d) => (
              <li key={d.id}>
                <div className="grow">
                  <div className="strong">
                    <span className={`helper-dot ${d.checked && !d.status ? "on" : ""}`} aria-hidden /> {d.name}{" "}
                    <span className="muted small">
                      · {d.platform === "ios" ? "iOS" : "Android"} {d.kind}
                      {d.builtIn ? " · from .env" : ""}
                    </span>
                  </div>
                  <div className="muted small">
                    {d.appiumUrl}
                    {d.udid ? ` · ${d.udid}` : ""}
                    {d.deviceName ? ` · ${d.deviceName}` : ""}
                    {d.platformVersion ? ` · ${d.platformVersion}` : ""}
                  </div>
                  {d.checked && <div className={`small ${d.status ? "error-text" : ""}`}>{d.status ? `Not ready: ${d.status}` : "Ready"}</div>}
                </div>
                {!d.builtIn && (
                  <>
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        setEditing(d.id);
                        setForm({ ...EMPTY_DEVICE, ...Object.fromEntries(Object.entries(d).filter(([, v]) => typeof v === "string")) } as DeviceForm);
                      }}
                    >
                      Change
                    </button>
                    <button
                      className="btn small ghost"
                      onClick={async () => {
                        if (!window.confirm(`Remove ${d.name}?`)) return;
                        await (d.farm ? api.releaseFarmPhone(d.id) : api.removeDevice(d.id)).catch((e: Error) => setErr(e.message));
                        load(false);
                      }}
                    >
                      Remove
                    </button>
                  </>
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
            try {
              const input = { ...form, platform: form.platform as "android" | "ios", kind: form.kind as DeviceView["kind"] };
              if (editing) await api.updateDevice(editing, input);
              else await api.addDevice(input);
              setForm(EMPTY_DEVICE);
              setEditing(null);
              load(true);
            } catch (e2) {
              setErr((e2 as Error).message);
            }
          }}
        >
          <div className="stat-label">{editing ? "Change test phone" : "Add a test phone"}</div>
          <label className="form-field">
            <span>Name</span>
            <input className="input" required maxLength={60} placeholder="Pixel 8 on Lucky's laptop" value={form.name} onChange={set("name")} />
          </label>
          <div className="form-row">
            <label className="form-field">
              <span>Platform</span>
              <select className="input" value={form.platform} onChange={set("platform")}>
                <option value="android">Android</option>
                <option value="ios">iOS</option>
              </select>
            </label>
            <label className="form-field">
              <span>Kind</span>
              <select className="input" value={form.kind} onChange={set("kind")}>
                <option value="phone">Real phone</option>
                <option value="emulator">Android emulator</option>
                <option value="simulator">iOS Simulator</option>
              </select>
            </label>
          </div>
          <label className="form-field">
            <span>Appium address</span>
            <input className="input" required placeholder="http://192.168.1.20:4723" value={form.appiumUrl} onChange={set("appiumUrl")} />
          </label>
          <label className="form-field">
            <span>{form.platform === "ios" ? "Device UDID (real iPhone only)" : "adb serial (optional)"}</span>
            <input className="input" placeholder={form.platform === "ios" ? "00008110-…" : "emulator-5554"} value={form.udid} onChange={set("udid")} />
          </label>
          {form.platform === "ios" && (
            <label className="form-field">
              <span>Simulator name</span>
              <input className="input" placeholder="iPhone 16" value={form.deviceName} onChange={set("deviceName")} />
            </label>
          )}
          <label className="form-field">
            <span>OS version (optional)</span>
            <input className="input" placeholder={form.platform === "ios" ? "18.1" : "14"} value={form.platformVersion} onChange={set("platformVersion")} />
          </label>
          <label className="form-field">
            <span>This server's address, as that machine sees it</span>
            <input className="input" placeholder="http://192.168.1.10:4000" value={form.serverAddress} onChange={set("serverAddress")} />
            <span className="muted small">Appium downloads the app from here, and the phone's traffic goes through this host.</span>
          </label>
          <div className="form-row">
            <button className="btn primary">{editing ? "Save" : "Add test phone"}</button>
            {editing && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  setEditing(null);
                  setForm(EMPTY_DEVICE);
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>
      <FarmCard onTaken={() => load(true)} />
      <div className="card helper-setup">
        <div className="stat-label">Set up Appium (once per machine)</div>
        <ol>
          <li>
            <strong>Built-in Android emulator:</strong> on the server, run <code>docker compose --profile android up -d</code>, add{" "}
            <code>ANDROID_DEVICE=android:5555</code> and <code>APP_SERVER_ADDRESS=http://testing-agent:4000</code> to .env, then run{" "}
            <code>docker compose up -d</code> again. It needs hardware virtualisation (<code>/dev/kvm</code>); on Windows, that is WSL 2
            with virtualisation on. It appears here as "Android emulator (built in)".
          </li>
          <li>
            <strong>Real Android phone:</strong> on a laptop with the phone plugged in and USB debugging on, run{" "}
            <code>npx appium@3.9.1 driver install uiautomator2</code> once, then{" "}
            <code>npx appium@3.9.1 --address 0.0.0.0 --allow-insecure=*:adb_shell</code>.
          </li>
          <li>
            <strong>iPhone Simulator or iPhone:</strong> on the Mac with Xcode, run <code>npx appium@3.9.1 driver install xcuitest</code>{" "}
            once, then <code>npx appium@3.9.1 --address 0.0.0.0</code>. A real iPhone needs a Development build signed for it.
          </li>
          <li>
            Without <code>--allow-insecure=*:adb_shell</code>, crash, screen-reader and touch checks still run; speed, dark mode,
            large text, tablet, offline and network checks are skipped.
          </li>
        </ol>
      </div>
    </>
  );
}
