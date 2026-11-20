import { useEffect, useState } from "react";
import type { Login, RoleSummary } from "../../../src/types.ts";
import { api, type HookMessageView, type Meta, type ProjectSummary } from "../api.ts";
import { describeLogin, LoginFields, type LoginDraft } from "./LoginFields.tsx";
import { TestCopyCard } from "./WebExtras.tsx";

/**
 * The project page's "Signed-in app" tab: the other accounts the access grid tests with (roles,
 * a user of another company), the webhook inbox and the step recorder.
 */
export function AppSetup({ project, onChanged, meta }: { project: ProjectSummary; onChanged: () => void; meta: Meta }) {
  const hooksOn = meta.modules.some((m) => m.id === "webhooks" && m.on);
  return (
    <>
      <h2 className="section-title">Test copy or live app</h2>
      <TestCopyCard project={project} onChanged={onChanged} />
      <h2 className="section-title">Which system it is</h2>
      <SystemCard project={project} meta={meta} onChanged={onChanged} />
      <h2 className="section-title">Other accounts (roles)</h2>
      <RolesCard project={project} onChanged={onChanged} />
      {hooksOn && (
        <>
          <h2 className="section-title">Webhook inbox</h2>
          <HooksCard projectId={project.id} />
        </>
      )}
      <h2 className="section-title">Step recorder</h2>
      <div className="card">
        <p>
          A small Chrome extension made by GLV. Press Record, use the client's app, then copy the steps into a journey. Passwords are
          written as <code>{"{{password}}"}</code>, so no secret ends up in the steps. Nothing leaves your browser.
        </p>
        <ol className="small muted">
          <li>Download and unzip it.</li>
          <li>
            In Chrome open <code>chrome://extensions</code>, turn on Developer mode, press <b>Load unpacked</b> and pick the{" "}
            <code>glv-recorder</code> folder.
          </li>
          <li>Open the app, press the GLV icon, then Record. Alt+click a text to add a "see" check.</li>
        </ol>
        <a className="btn" href="/api/recorder/download">
          Download the step recorder
        </a>
      </div>
    </>
  );
}

/** The test spots the system on its own; this picks it when it cannot (a custom domain, an in-house app). */
function SystemCard({ project, meta, onChanged }: { project: ProjectSummary; meta: Meta; onChanged: () => void }) {
  const [value, setValue] = useState(project.target.system ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saved = project.target.system ?? "";
  const kinds = meta.systemKinds.filter((k) => meta.systems.some((s) => s.kind === k.id));
  return (
    <div className="card">
      <p className="small">
        The test spots well-known systems on its own (Salesforce, Zoho, HubSpot, Odoo, ERPNext, WordPress admin, Moodle and {meta.systems.length - 7}{" "}
        more) and then uses that system's sign-in fields, its menus and its list of links never to open. If the client's system is on a
        custom address and is not spotted, choose it here. Anything else is tested with the general rules.
      </p>
      <div className="row">
        <select className="input" style={{ maxWidth: 460 }} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Which system it is">
          <option value="">Spot it on its own (recommended)</option>
          {kinds.map((k) => (
            <optgroup key={k.id} label={k.name}>
              {meta.systems
                .filter((s) => s.kind === k.id)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        {value !== saved && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api.updateProject(project.id, { system: value });
                onChanged();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function RolesCard({ project, onChanged }: { project: ProjectSummary; onChanged: () => void }) {
  const [editing, setEditing] = useState<RoleSummary | "new" | null>(null);
  const roles = project.roles ?? [];
  const kind = project.type === "api" ? "api" : "web";
  if (!project.login || project.login.kind !== kind) {
    if (kind === "api") {
      return (
        <div className="card muted">
          Save the API's main key or token on the Overview tab first. Then add the keys of other accounts here (a user of another
          client company, a staff or read-only role), and every test checks who can read what.
        </div>
      );
    }
    return (
      <div className="card muted">
        Save the main login on the Overview tab first. Then add the other accounts here (sales staff, a viewer, a user of another
        client company), and every test checks who can open which screen.
      </div>
    );
  }
  return (
    <div className="card roles-card">
      <p className="muted small">
        {kind === "api"
          ? "Each account below calls every endpoint the main key read, with the same record ids. The report's access grid shows who can read what. A user of another company must never get this company's records (BOLA / IDOR), and a lower role must never use admin endpoints."
          : "Each account below signs in in its own browser and opens every screen and app call the main account reached. The report's access grid then shows who can open what."}{" "}
        {kind === "web" && (
          <>
            A user of <b>another company</b> must never see this company's records.
          </>
        )}
      </p>
      {roles.length > 0 && (
        <table className="table roles-table">
          <thead>
            <tr>
              <th>Role</th>
              <th>Signs in as</th>
              <th>Must never open</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr className="muted">
              <td>{project.login.roleName || "Main account"}</td>
              <td>{kind === "api" ? describeLogin(project.login) : project.login.username}</td>
              <td>–</td>
              <td />
            </tr>
            {roles.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.name} {r.otherCompany && <span className="badge warn">another company</span>}
                  {r.login.unreadable && <span className="badge bad">enter again</span>}
                  {r.lockoutTest && <span className="badge">lockout check</span>}
                </td>
                <td>
                  {kind === "api" ? describeLogin(r.login) : r.login.username}
                  {r.login.hasTotp && <span className="muted small"> · two-step</span>}
                </td>
                <td className="small">{r.mustNotOpen ? r.mustNotOpen.split(/\n/).join(", ") : <span className="muted">–</span>}</td>
                <td className="right">
                  <button className="btn ghost small" onClick={() => setEditing(r)}>
                    Change
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing ? (
        <RoleForm
          key={editing === "new" ? "new" : editing.id}
          projectId={project.id}
          role={editing === "new" ? undefined : editing}
          mainLoginUrl={project.login.loginUrl}
          kind={kind}
          onDone={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : (
        roles.length < 6 && (
          <button className="btn" onClick={() => setEditing("new")}>
            + Add an account
          </button>
        )
      )}
    </div>
  );
}

function RoleForm({ projectId, role, mainLoginUrl, onDone, kind = "web" }: { projectId: string; role?: RoleSummary; mainLoginUrl?: string; onDone: () => void; kind?: "web" | "api" }) {
  const [name, setName] = useState(role?.name ?? "");
  const [otherCompany, setOtherCompany] = useState(Boolean(role?.otherCompany));
  const [mustNotOpen, setMustNotOpen] = useState(role?.mustNotOpen ?? "");
  const [lockoutTest, setLockoutTest] = useState(Boolean(role?.lockoutTest));
  const [login, setLogin] = useState<LoginDraft>(() => {
    if (!role) return kind === "api" ? { authType: "bearer" } : { loginUrl: mainLoginUrl };
    const { hasPassword: _p, hasToken: _t, hasTotp: _h, unreadable: _u, updatedAt: _d, ...rest } = role.login;
    return rest as Partial<Login>;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="role-form">
      <div className="form-row">
        <label className="form-field grow">
          <span>Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sales staff, Viewer, Other company" />
        </label>
        <label className="check dark">
          <input type="checkbox" checked={otherCompany} onChange={(e) => setOtherCompany(e.target.checked)} /> A user of another client company
        </label>
      </div>
      <LoginFields kind={kind} value={login} onChange={setLogin} saved={role?.login} />
      {!otherCompany && (
        <label className="form-field">
          <span>{kind === "api" ? "Endpoints this account must never use (paths, one per line, * for anything)" : "Addresses this role must never open (one per line, * for anything)"}</span>
          <textarea className="input code" rows={3} value={mustNotOpen} onChange={(e) => setMustNotOpen(e.target.value)} placeholder={kind === "api" ? "/admin*\n/users/*/salary\n/reports/finance" : "/admin\n/settings/billing\n/api/users/*"} spellCheck={false} />
        </label>
      )}
      {kind === "web" && (
        <label className="check dark small">
          <input type="checkbox" checked={lockoutTest} onChange={(e) => setLockoutTest(e.target.checked)} /> A spare account for the lockout check: the
          test may type wrong passwords on it until the app locks it (it may stay locked for a while). Never tick this for a real person's account.
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api.saveRole(projectId, { id: role?.id, name, otherCompany, mustNotOpen: otherCompany ? "" : mustNotOpen, lockoutTest, login });
              onDone();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save account"}
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
        <div className="grow" />
        {role && (
          <button
            className="btn ghost danger"
            onClick={async () => {
              if (!window.confirm(`Remove the account ${role.name}?`)) return;
              await api.deleteRole(projectId, role.id).catch((err: Error) => setError(err.message));
              onDone();
            }}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function HooksCard({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ address: string | null; messages: HookMessageView[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () => api.hooks(projectId).then(setData, () => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [projectId]);
  if (!data) return <div className="card muted">Loading…</div>;
  if (!data.address) {
    return (
      <div className="card">
        <p>
          Give the client's app an address on this server to send its webhooks to (WhatsApp CRM messages, new lead, payment
          notifications). Every message shows here, and a journey can wait for one with <code>webhook has lead.created</code>.
        </p>
        <button className="btn" onClick={() => api.openHooks(projectId).then(setData)}>
          Open the webhook inbox
        </button>
      </div>
    );
  }
  return (
    <div className="card hooks-card">
      <div className="row">
        <code className="grow hook-address">{data.address}</code>
        <button
          className="btn small"
          onClick={async () => {
            await navigator.clipboard?.writeText(data.address!).catch(() => {});
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="btn ghost small" onClick={() => api.openHooks(projectId, { clear: true }).then(setData)}>
          Clear
        </button>
        <button
          className="btn ghost small"
          onClick={() => window.confirm("Make a new address? The old one stops working.") && api.openHooks(projectId, { fresh: true, clear: true }).then(setData)}
        >
          New address
        </button>
        <button className="btn ghost small danger" onClick={() => window.confirm("Close the inbox and delete its messages?") && api.closeHooks(projectId).then(load)}>
          Close
        </button>
      </div>
      <p className="muted small">
        Anyone with this address can send to it, so treat it like a password. Set PUBLIC_URL in .env to this server's address as the
        client's app sees it.
      </p>
      {data.messages.length === 0 ? (
        <div className="muted">No webhooks yet. This list updates by itself.</div>
      ) : (
        <ul className="hook-list">
          {data.messages.map((m) => (
            <li key={m.id}>
              <button className="hook-row" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id}>
                <span className="badge">{m.method}</span>
                <span className="grow mono small">{m.body.slice(0, 120) || "(empty)"}</span>
                <span className="muted small">{new Date(m.at).toLocaleTimeString()}</span>
              </button>
              {open === m.id && (
                <div className="hook-detail">
                  <pre className="code-block">{prettyBody(m.body)}</pre>
                  <table className="kv small">
                    <tbody>
                      {Object.entries(m.headers).map(([k, v]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td className="mono">{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function prettyBody(b: string): string {
  try {
    return JSON.stringify(JSON.parse(b), null, 2);
  } catch {
    return b;
  }
}
