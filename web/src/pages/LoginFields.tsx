import { useState } from "react";
import type { ApiAuthType, Login, LoginKind, LoginSummary, ProductType } from "../../../src/types.ts";
import { api } from "../api.ts";

export type LoginDraft = Partial<Login>;

const WEB_TYPES: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];

export function loginKind(type: ProductType): LoginKind | undefined {
  if (WEB_TYPES.includes(type)) return "web";
  if (type === "api") return "api";
  if (type === "code") return "git";
  return undefined;
}

/** The question that turns the login section on, per product. */
export const LOGIN_QUESTION: Record<LoginKind, string> = {
  web: "Sign in first and test the pages behind the login",
  api: "The API needs a key or token",
  git: "The repository is private (needs an access token)",
};

/** One line on what is saved, for the project page. Never shows a secret. */
export function describeLogin(l: LoginSummary): string {
  if (l.kind === "web") return `Signs in as ${l.username} at ${l.loginUrl}`;
  if (l.kind === "git") return `Uses an access token${l.username ? ` for ${l.username}` : ""}`;
  if (l.authType === "basic") return `Basic login as ${l.username}`;
  if (l.authType === "header") return `Sends a key in the ${l.paramName} header`;
  if (l.authType === "query") return `Sends a key in the ${l.paramName} query parameter`;
  return "Sends a bearer token";
}

const SECRET_NOTE =
  "Kept encrypted on GLV's server. It is only unlocked while a test runs, never shown again, and hidden from reports.";

/** The login fields for a product: a sign-in form, an API key or token, or a Git access token. */
export function LoginFields({
  kind,
  value,
  onChange,
  saved,
}: {
  kind: LoginKind;
  value: LoginDraft;
  onChange: (v: LoginDraft) => void;
  saved?: LoginSummary | null;
}) {
  const set = (patch: LoginDraft) => onChange({ ...value, ...patch });
  const keep = saved && saved.kind === kind && !saved.unreadable ? saved : undefined;
  const field = (key: keyof Login, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="form-field">
      <span>{label}</span>
      <input
        className="input"
        value={(value[key] as string | undefined) ?? ""}
        onChange={(e) => set({ [key]: e.target.value })}
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
    </label>
  );
  const secret = (key: "password" | "token", label: string, isSaved: boolean | undefined, placeholder = "") =>
    field(key, label, {
      type: "password",
      autoComplete: "new-password",
      placeholder: isSaved ? "Saved. Leave empty to keep it" : placeholder,
    });

  if (kind === "web") {
    return (
      <div className="login-fields">
        {field("loginUrl", "Sign-in page address", { placeholder: "https://app.example.com/login" })}
        <div className="form-row">
          <div className="grow">{field("username", "User name or email", { placeholder: "tester@client.com" })}</div>
          <div className="grow">{secret("password", "Password", keep?.hasPassword)}</div>
        </div>
        {field("successText", "Text that shows once signed in (optional)", { placeholder: "Sign out, or the user's name" })}
        <details className="login-advanced" open={Boolean(value.usernameSelector || value.passwordSelector || value.submitSelector)}>
          <summary>Unusual sign-in form? Point at the fields</summary>
          <div className="form-row">
            <div className="grow">{field("usernameSelector", "User name field (CSS)", { placeholder: "#email" })}</div>
            <div className="grow">{field("passwordSelector", "Password field (CSS)", { placeholder: "#password" })}</div>
            <div className="grow">{field("submitSelector", "Sign-in button (CSS)", { placeholder: "button.login" })}</div>
          </div>
        </details>
        <div className="note">
          Use a test account, not a real customer's. Two-step codes and CAPTCHAs stop automated sign-in. While signed in,
          the agents only look: they never press buttons or open log-out, delete or cancel links. {SECRET_NOTE}
        </div>
      </div>
    );
  }

  if (kind === "api") {
    const type = (value.authType ?? "bearer") as ApiAuthType;
    const sameType = keep?.authType === type;
    return (
      <div className="login-fields">
        <label className="form-field">
          <span>How the API key is sent</span>
          <select className="input" value={type} onChange={(e) => set({ authType: e.target.value as ApiAuthType })}>
            <option value="bearer">Bearer token (Authorization: Bearer …)</option>
            <option value="header">In a header (like X-API-Key)</option>
            <option value="query">In the address (like ?api_key=…)</option>
            <option value="basic">User name and password (basic)</option>
          </select>
        </label>
        {type === "basic" ? (
          <div className="form-row">
            <div className="grow">{field("username", "User name")}</div>
            <div className="grow">{secret("password", "Password", sameType && keep?.hasPassword)}</div>
          </div>
        ) : (
          <div className="form-row">
            {(type === "header" || type === "query") && (
              <div>{field("paramName", type === "header" ? "Header name" : "Parameter name", { placeholder: type === "header" ? "X-API-Key" : "api_key" })}</div>
            )}
            <div className="grow">{secret("token", type === "bearer" ? "Token" : "Key", sameType && keep?.hasToken)}</div>
          </div>
        )}
        <div className="note">
          Still only read-only GET requests. The endpoints that need a login are also called once without it, to check
          they refuse strangers. {SECRET_NOTE}
        </div>
      </div>
    );
  }

  return (
    <div className="login-fields">
      <div className="form-row">
        <div className="grow">{secret("token", "Access token", keep?.hasToken, "ghp_… or glpat-…")}</div>
        <div>{field("username", "User name (optional)", { placeholder: "for Bitbucket" })}</div>
      </div>
      <div className="note">
        Make a read-only token: on GitHub a fine-grained token with Contents: Read for this repository; on GitLab a
        project token with read_repository. It is sent only to the repository's own host. {SECRET_NOTE}
      </div>
    </div>
  );
}

/** The login card on a project page: what is saved, and a form to add, change or remove it. */
export function ProjectLogin({
  projectId,
  kind,
  saved,
  onSaved,
}: {
  projectId: string;
  kind: LoginKind;
  saved: LoginSummary | null;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LoginDraft>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const start = () => {
    const { hasPassword: _p, hasToken: _t, unreadable: _u, updatedAt: _d, ...rest } = saved ?? ({} as LoginSummary);
    setDraft(saved && !saved.unreadable ? rest : {});
    setError("");
    setEditing(true);
  };
  const send = async (login: LoginDraft | null) => {
    setBusy(true);
    setError("");
    try {
      await api.updateProject(projectId, { login: login && { ...login, kind } });
      setEditing(false);
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card login-card">
      <div className="login-head">
        <div className="grow">
          <div className="stat-label">Login</div>
          {saved ? (
            saved.unreadable ? (
              <div className="error-text">
                Saved with a different SECRET_KEY, so it cannot be unlocked. Enter it again.
              </div>
            ) : (
              <div>
                {describeLogin(saved)}
                <span className="muted small"> · saved {new Date(saved.updatedAt).toLocaleDateString()}</span>
              </div>
            )
          ) : (
            <div className="muted">
              {kind === "web"
                ? "No login: the agents test what visitors see without signing in."
                : kind === "api"
                  ? "No key: the endpoints are called without logging in."
                  : "No token: only public repositories can be opened."}
            </div>
          )}
        </div>
        {!editing && (
          <div className="login-actions">
            <button className="btn" onClick={start}>
              {saved ? "Change" : "Add a login"}
            </button>
            {saved && (
              <button
                className="btn ghost danger"
                disabled={busy}
                onClick={() => window.confirm("Remove the saved login from this project?") && send(null)}
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {editing && (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <LoginFields kind={kind} value={draft} onChange={setDraft} saved={saved} />
          <div className="form-actions">
            <button className="btn primary" disabled={busy}>
              {busy ? "Saving…" : "Save login"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {error && <div className="error">{error}</div>}
          </div>
        </form>
      )}
    </div>
  );
}
