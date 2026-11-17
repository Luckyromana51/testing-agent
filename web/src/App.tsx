import { useCallback, useEffect, useState } from "react";
import type { ProductType, User } from "../../src/types.ts";
import { api, UNAUTHORIZED, type AuthState, type Meta } from "./api.ts";
import { go, hostOf, useRoute, usePoll } from "./lib.ts";
import { AuthScreen } from "./pages/Auth.tsx";
import { Home, NewProject } from "./pages/Home.tsx";
import { Issues } from "./pages/Issues.tsx";
import { Owner } from "./pages/Owner.tsx";
import { Projects, ProjectView } from "./pages/Projects.tsx";
import { Report } from "./pages/Report.tsx";
import { Icon, ScoreChip } from "./ui.tsx";

export function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const checkAuth = useCallback(() => {
    api
      .authState()
      .then(setAuth)
      .catch(() => setAuth({ setupNeeded: false, user: null }));
  }, []);
  useEffect(() => {
    checkAuth();
    window.addEventListener(UNAUTHORIZED, checkAuth);
    return () => window.removeEventListener(UNAUTHORIZED, checkAuth);
  }, [checkAuth]);

  if (!auth) return <div className="loading">Loading…</div>;
  if (!auth.user) {
    return <AuthScreen setupNeeded={auth.setupNeeded} onSignedIn={(user) => setAuth({ setupNeeded: false, user })} />;
  }
  return <Shell user={auth.user} loginOff={Boolean(auth.loginOff)} onSignedOut={() => setAuth({ setupNeeded: false, user: null })} />;
}

function Shell({ user, loginOff, onSignedOut }: { user: User; loginOff: boolean; onSignedOut: () => void }) {
  const route = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const reloadMeta = useCallback(() => {
    api.meta().then(setMeta).catch(() => {});
  }, []);
  useEffect(reloadMeta, [reloadMeta]);
  const projects = usePoll(() => api.projects(), [], 5000).data;

  const nav: [string, string, Parameters<typeof Icon>[0]["name"], boolean][] = [
    ["#/", "New test", "new", route.name === "home" || route.name === "new"],
    ["#/projects", "Projects", "projects", route.name === "projects" || route.name === "project"],
    ["#/issues", "Issues", "issues", route.name === "issues"],
  ];
  if (user.role === "owner") nav.push(["#/owner", "Owner panel", "owner", route.name === "owner"]);

  let page = <div className="loading">Loading…</div>;
  if (meta) {
    if (route.name === "home") page = <Home meta={meta} />;
    else if (route.name === "new") page = <NewProject meta={meta} type={route.id as ProductType} key={route.id} />;
    else if (route.name === "projects") page = <Projects meta={meta} />;
    else if (route.name === "project" && route.id) page = <ProjectView id={route.id} meta={meta} user={user} key={route.id} />;
    else if (route.name === "run" && route.id) page = <Report id={route.id} key={route.id} />;
    else if (route.name === "issues") page = <Issues projectId={route.query.get("project") ?? undefined} openId={route.id} />;
    else if (route.name === "owner") page = <Owner tab={route.id} meta={meta} reloadMeta={reloadMeta} user={user} loginOff={loginOff} />;
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#/">
          <div className="logo">GLV</div>
          <div>
            <div className="brand-name">Testing Agent</div>
            <div className="brand-sub">by GLV Infotech Solutions</div>
          </div>
        </a>
        <nav className="nav">
          {nav.map(([href, label, icon, active]) => (
            <a key={href} href={href} className={`nav-item ${active ? "active" : ""}`}>
              <Icon name={icon} size={18} />
              {label}
            </a>
          ))}
        </nav>
        {projects && projects.length > 0 && (
          <>
            <div className="section-label">Recent projects</div>
            <ul className="run-list">
              {projects.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <button
                    className={`run-item ${route.name === "project" && route.id === p.id ? "active" : ""}`}
                    onClick={() => go(`#/project/${p.id}`)}
                  >
                    <ScoreChip score={p.lastScore} status={p.busy ? (p.waiting ? "queued" : "running") : p.lastRun?.status} />
                    <span className="run-meta">
                      <span className="run-url">{p.name}</span>
                      <span className="run-sub">
                        {p.busy ? (p.waiting ? "Waiting to start…" : "Testing now…") : hostOf(p.target.url)}
                        {p.counts.open.critical + p.counts.open.high > 0 &&
                          ` · ${p.counts.open.critical + p.counts.open.high} major`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="sidebar-foot">
          <div className={`ai-status ${meta?.ai && meta.aiSummary ? "on" : ""}`}>
            {meta ? (meta.ai && meta.aiSummary ? "Claude summary is on" : "Claude summary is off") : ""}
          </div>
          <div className="me">
            <div>
              <div className="me-name">{user.name}</div>
              <div className="me-role">{user.role === "owner" ? "Owner" : "Team member"}</div>
            </div>
            {!loginOff && (
              <button
                className="icon-btn"
                title="Sign out"
                aria-label="Sign out"
                onClick={async () => {
                  await api.logout().catch(() => {});
                  onSignedOut();
                }}
              >
                <Icon name="logout" size={18} />
              </button>
            )}
          </div>
          {loginOff && (
            <div className="login-off" title="AUTH_DISABLED=1 is set. Set AUTH_DISABLED=0 in .env and restart before putting this on a server.">
              Login is off for local use
            </div>
          )}
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}
