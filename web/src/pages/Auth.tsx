import { useState } from "react";
import type { User } from "../../../src/types.ts";
import { api } from "../api.ts";

export function AuthScreen({ setupNeeded, onSignedIn }: { setupNeeded: boolean; onSignedIn: (u: User) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { user } = setupNeeded ? await api.setup({ name, email, password }) : await api.login({ email, password });
      onSignedIn(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand dark">
          <div className="logo">GLV</div>
          <div>
            <div className="brand-name">Testing Agent</div>
            <div className="brand-sub">by GLV Infotech Solutions</div>
          </div>
        </div>
        <h1>{setupNeeded ? "Create the owner account" : "Sign in"}</h1>
        {setupNeeded && (
          <p className="muted">
            This is the first start. The account you create now controls the owner panel: agents, team and settings.
          </p>
        )}
        {setupNeeded && (
          <label className="form-field">
            <span>Your name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="form-field">
          <span>Email</span>
          <input
            className="input"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="form-field">
          <span>Password{setupNeeded ? " (at least 10 characters)" : ""}</span>
          <input
            className="input"
            type="password"
            required
            minLength={setupNeeded ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setupNeeded ? "new-password" : "current-password"}
          />
        </label>
        <button className="btn primary" disabled={busy}>
          {busy ? "Please wait…" : setupNeeded ? "Create account" : "Sign in"}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
