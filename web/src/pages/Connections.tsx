import { useEffect, useState } from "react";
import { api, type ConnectionDraft, type ConnectionKind, type ConnectionsInfo, type ConnectionView, type ProjectSummary } from "../api.ts";
import { timeAgo } from "../lib.ts";
import { PasswordInput, Toggle } from "../ui.tsx";

const ABOUT: Record<ConnectionKind, { title: string; what: string; secret: string }> = {
  ssh: {
    title: "SSH server",
    what: "Signs in to the client's server. Every test then reads the server's health and safety (read-only), and can test a private site through the server.",
    secret: "Private key (or password)",
  },
  hostinger: {
    title: "Hostinger account",
    what: "The client's Hostinger API token (hPanel > Profile > API). Every test reads their servers, websites and domains. Only reads.",
    secret: "Hostinger API token",
  },
  mcp: {
    title: "MCP server",
    what: "The client's own MCP server (the tools their AI assistant uses). Every test checks it for missing sign-in, HTTPS, Origin checks and poisoned tools. Tools are never called.",
    secret: "Bearer token (if it has one)",
  },
};

const SECRET_STATE: Record<ConnectionView["secret"], string> = {
  saved: "Secret saved (encrypted)",
  reference: "Secret kept in the server's .env or key folder",
  none: "No secret",
  unreadable: "Secret unreadable: enter it again",
};

/**
 * The Connections tab: how GLV's servers reach the client's own system. The owner adds a connection,
 * presses Test, and from then on every test of the project uses it.
 */
export function ConnectionsCard({ project, isOwner, onUseAddress }: { project: ProjectSummary; isOwner: boolean; onUseAddress: (url: string) => void }) {
  const [info, setInfo] = useState<ConnectionsInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [form, setForm] = useState<{ kind: ConnectionKind; edit?: ConnectionView; prefill?: ConnectionDraft } | null>(null);
  const [newToken, setNewToken] = useState("");

  const load = () => api.connections(project.id).then(setInfo, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [project.id]);

  const act = async (key: string, fn: () => Promise<ConnectionsInfo>) => {
    setBusy(key);
    setError("");
    try {
      setInfo(await fn());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  if (!info) return <div className="loading">{error || "Loading…"}</div>;
  const isWeb = ["website", "ecommerce", "webapp", "saas", "crm"].includes(project.type);

  return (
    <div className="connections">
      <div className="card">
        <p className="muted small">
          Everything runs on GLV's servers. A connection is how they reach the client's own system. Secrets are kept encrypted on this server (or in its
          .env) and never come back to this page. Connection checks only read; load and attack tests still need the Load and attack tab, and start only by hand.
        </p>
        {info.connections.length === 0 && !form && <div className="muted">No connections yet. Tests reach the project's public address as usual.</div>}
        {info.connections.map((c) => (
          <div className={`connection ${c.lastTest ? (c.lastTest.ok ? "conn-good" : "conn-fail") : ""}`} key={c.id}>
            <div className="connection-head">
              <strong>{c.name}</strong>
              <span className="badge">{c.label}</span>
              <span className="muted small">
                {c.kind === "ssh" ? `${c.username}@${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ""}` : c.kind === "mcp" ? c.url : "API token"}
              </span>
            </div>
            <div className="muted small">
              {SECRET_STATE[c.secret]}
              {c.secretRef ? ` (${c.secretRef})` : ""}. {c.checks ? "Checked on every test." : "Not checked in tests."}
              {c.tunnel && c.siteUrl ? ` Tests open ${c.siteUrl} through this server.` : ""}
              {c.hostKey ? ` Server key ${c.hostKey}.` : ""}
            </div>
            {c.lastTest && (
              <div className={`connection-test ${c.lastTest.ok ? "conn-good" : "conn-fail"}`}>
                <div>
                  {c.lastTest.ok ? "✓" : "✗"} {c.lastTest.message} <span className="muted small">{timeAgo(c.lastTest.at)}</span>
                </div>
                {c.lastTest.details?.length ? (
                  <details>
                    <summary className="small">What the test saw</summary>
                    <ul className="small">
                      {c.lastTest.details.map((d, i) => (
                        <li key={i}>{d}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {isOwner && c.lastTest.sites?.length ? (
                  <div className="small connection-sites">
                    Use as this project's address:{" "}
                    {c.lastTest.sites.slice(0, 12).map((u) => (
                      <button key={u} type="button" className="link" disabled={project.target.url === u} onClick={() => onUseAddress(u)}>
                        {u.replace(/^https:\/\/|\/$/g, "")}
                      </button>
                    ))}
                  </div>
                ) : null}
                {isOwner && c.lastTest.servers?.length ? (
                  <div className="small connection-sites">
                    Add an SSH connection to:{" "}
                    {c.lastTest.servers.map((s) => (
                      <button key={s.ip} type="button" className="link" onClick={() => setForm({ kind: "ssh", prefill: { name: s.name, host: s.ip, username: "root" } })}>
                        {s.name} ({s.ip})
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            <div className="form-actions">
              <button className="btn primary" disabled={busy === c.id} onClick={() => act(c.id, () => api.testConnection(project.id, c.id))}>
                {busy === c.id ? "Testing…" : "Test the connection"}
              </button>
              {isOwner && (
                <>
                  <button className="btn" onClick={() => setForm({ kind: c.kind, edit: c })}>
                    Change
                  </button>
                  <button className="btn" disabled={busy === `del-${c.id}`} onClick={() => act(`del-${c.id}`, () => api.deleteConnection(project.id, c.id))}>
                    Remove
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
        {error && <div className="error">{error}</div>}
        {form ? (
          <ConnectionForm
            key={form.edit?.id ?? `${form.kind}-${form.prefill?.host ?? ""}`}
            projectId={project.id}
            kind={form.kind}
            edit={form.edit}
            prefill={form.prefill}
            isWeb={isWeb}
            onDone={(next) => {
              setForm(null);
              if (next) setInfo(next);
            }}
          />
        ) : isOwner ? (
          <div className="form-actions">
            {(["ssh", "hostinger", "mcp"] as ConnectionKind[]).map((k) => (
              <button key={k} className="btn" onClick={() => setForm({ kind: k })}>
                Add {ABOUT[k].title}
              </button>
            ))}
          </div>
        ) : (
          <div className="muted small">Only the owner can add or change a connection. Anyone can test one.</div>
        )}
      </div>

      <h3 className="section-title connections-mcp-title">Let the client's AI assistant read this project (GLV's MCP server)</h3>
      <div className="card">
        <p className="muted small">
          The client adds GLV's MCP server to their AI assistant (Claude, or any MCP client) with a token made here. It can read this project's status,
          open issues and latest report, and start a normal test (never load or attack tools). It sees only this project.
        </p>
        <div className="small">
          Address: <code>{info.glvMcpUrl}</code>
        </div>
        {newToken && (
          <div className="token-once">
            <strong>Copy this token now. It is shown only once.</strong>
            <PasswordInput readOnly value={newToken} onFocus={(e) => e.currentTarget.select()} aria-label="New MCP token" />
            <span className="muted small">The client puts it in their assistant as a bearer token: Authorization: Bearer {"<token>"}.</span>
          </div>
        )}
        {info.mcpTokens.length ? (
          <ul className="token-list">
            {info.mcpTokens.map((t) => (
              <li key={t.id}>
                <strong>{t.name}</strong> <span className="muted small">made by {t.createdBy} {timeAgo(t.createdAt)}{t.lastUsed ? `, last used ${timeAgo(t.lastUsed)}` : ", never used"}</span>
                {isOwner && (
                  <button className="btn small" onClick={() => act(`tok-${t.id}`, () => api.deleteMcpToken(project.id, t.id))}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted small">No tokens yet.</div>
        )}
        {isOwner && <McpTokenForm projectId={project.id} onMade={(res) => { setInfo(res); setNewToken(res.token); }} />}
      </div>
    </div>
  );
}

/** A private key box: hidden like a password until the eye is pressed (keys have several lines). */
function SecretArea({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="password-box secret-area">
      <textarea
        className={`input mono${shown ? "" : " masked"}`}
        rows={4}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
      />
      <button type="button" className="eye-btn" aria-label={shown ? "Hide key" : "Show key"} aria-pressed={shown} title={shown ? "Hide" : "Show"} onClick={() => setShown((x) => !x)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
          <circle cx="12" cy="12" r="2.8" />
          {shown && <path d="M4 4l16 16" />}
        </svg>
      </button>
    </span>
  );
}

function McpTokenForm({ projectId, onMade }: { projectId: string; onMade: (res: ConnectionsInfo & { token: string }) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="form-actions"
      onSubmit={async (e) => {
        e.preventDefault();
        setError("");
        try {
          onMade(await api.addMcpToken(projectId, name || "Client AI"));
          setName("");
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Who it is for (Acme's Claude)" aria-label="Token name" />
      <button className="btn">Make a token</button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function ConnectionForm({
  projectId,
  kind,
  edit,
  prefill,
  isWeb,
  onDone,
}: {
  projectId: string;
  kind: ConnectionKind;
  edit?: ConnectionView;
  prefill?: ConnectionDraft;
  isWeb: boolean;
  onDone: (next?: ConnectionsInfo) => void;
}) {
  const start = { ...prefill, ...(edit ?? {}) } as ConnectionDraft;
  const [d, setD] = useState<ConnectionDraft>({
    name: start.name ?? "",
    host: start.host ?? "",
    port: start.port ?? 22,
    username: start.username ?? "",
    auth: start.auth ?? "key",
    tunnel: start.tunnel ?? false,
    siteUrl: start.siteUrl ?? "",
    url: start.url ?? "",
    secretRef: start.secretRef ?? "",
    checks: start.checks ?? true,
  });
  const [where, setWhere] = useState<"here" | "ref">(edit?.secretRef ? "ref" : "here");
  const [key, setKey] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<ConnectionDraft>) => setD((x) => ({ ...x, ...patch }));
  const keep = edit && edit.secret !== "none" ? " (leave empty to keep the saved one)" : "";

  return (
    <form
      className="form connection-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const body: ConnectionDraft = {
          ...d,
          kind,
          secretRef: where === "ref" ? d.secretRef : "",
          ...(where === "here" && key ? { key } : {}),
          ...(where === "here" && password ? { password } : {}),
          ...(where === "here" && token ? { token } : {}),
        };
        try {
          onDone(edit ? await api.updateConnection(projectId, edit.id, body) : await api.addConnection(projectId, body));
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="own-head">
        <strong>{edit ? `Change ${edit.name}` : `Add ${ABOUT[kind].title}`}</strong>
        <span className="muted small">{ABOUT[kind].what}</span>
      </div>
      <label className="form-field">
        <span>Name</span>
        <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder={`Acme ${ABOUT[kind].title}`} />
      </label>
      {kind === "ssh" && (
        <>
          <div className="form-row">
            <label className="form-field">
              <span>Server address</span>
              <input className="input" value={d.host} onChange={(e) => set({ host: e.target.value })} placeholder="203.0.113.7 or server.acme.com" required />
            </label>
            <label className="form-field narrow">
              <span>Port</span>
              <input className="input" type="number" min={1} max={65535} value={d.port} onChange={(e) => set({ port: e.target.value })} />
            </label>
            <label className="form-field">
              <span>User</span>
              <input className="input" value={d.username} onChange={(e) => set({ username: e.target.value })} placeholder="deploy" required />
            </label>
          </div>
          <div className="form-field">
            <span>Sign in with</span>
            <label className="check dark">
              <input type="radio" checked={d.auth === "key"} onChange={() => set({ auth: "key" })} /> A key (best: ask the client to add GLV's public key for a user with no sudo)
            </label>
            <label className="check dark">
              <input type="radio" checked={d.auth === "password"} onChange={() => set({ auth: "password" })} /> A password
            </label>
          </div>
        </>
      )}
      {kind === "mcp" && (
        <label className="form-field">
          <span>MCP server address</span>
          <input className="input" value={d.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://mcp.acme.com/mcp" required />
        </label>
      )}
      <div className="form-field">
        <span>{ABOUT[kind].secret}</span>
        <label className="check dark">
          <input type="radio" checked={where === "here"} onChange={() => setWhere("here")} /> Paste it here (kept encrypted with SECRET_KEY)
        </label>
        <label className="check dark">
          <input type="radio" checked={where === "ref"} onChange={() => setWhere("ref")} /> It is in the server's .env or key folder
        </label>
        {where === "ref" ? (
          <>
            <input className="input" value={d.secretRef} onChange={(e) => set({ secretRef: e.target.value })} placeholder={kind === "ssh" ? "file:acme.pem or env:CONN_ACME_KEY" : "env:CONN_ACME_TOKEN"} />
            <span className="muted small">
              {kind === "ssh" ? "file:name reads a key file from the server's SSH key folder (SSH_KEYS_DIR). " : ""}env:CONN_NAME reads that line of the .env (only names that start with CONN_).
            </span>
          </>
        ) : kind === "ssh" && d.auth === "key" ? (
          <>
            <SecretArea value={key} onChange={setKey} placeholder={`-----BEGIN OPENSSH PRIVATE KEY-----${keep}`} label="Private key" />
            <PasswordInput className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Key passphrase, if it has one" autoComplete="off" aria-label="Key passphrase" />
          </>
        ) : kind === "ssh" ? (
          <PasswordInput className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`SSH password${keep}`} autoComplete="off" aria-label="SSH password" />
        ) : (
          <PasswordInput className="input" value={token} onChange={(e) => setToken(e.target.value)} placeholder={`${ABOUT[kind].secret}${keep}`} autoComplete="off" aria-label={ABOUT[kind].secret} />
        )}
      </div>
      {kind === "ssh" && isWeb && (
        <div className="form-field">
          <span className="toggle-row">
            <Toggle on={Boolean(d.tunnel)} onChange={(v) => set({ tunnel: v })} label="Test the site through this server" />
            <span>Test the site through this server (for a private test site)</span>
          </span>
          {d.tunnel && (
            <>
              <input className="input" value={d.siteUrl} onChange={(e) => set({ siteUrl: e.target.value })} placeholder="http://localhost:8080 or http://staging.internal" />
              <span className="muted small">The site's address as the client's server sees it. The test's browser goes through the server; outside tools (Lighthouse, ZAP...) are left out of those tests.</span>
            </>
          )}
        </div>
      )}
      <span className="toggle-row">
        <Toggle on={d.checks !== false} onChange={(v) => set({ checks: v })} label="Check this connection on every test" />
        <span>Check this connection on every test</span>
      </span>
      {error && <div className="error">{error}</div>}
      <div className="form-actions">
        <button className="btn primary" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" className="btn" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
