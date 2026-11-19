import { useCallback, useEffect, useState } from "react";
import type { ProductType, User } from "../../src/types.ts";
import { api, UNAUTHORIZED, type AuthState, type Meta } from "./api.ts";
import { go, hostOf, useRoute, usePoll } from "./lib.ts";
import { AuthScreen } from "./pages/Auth.tsx";
import { Home, NewProject } from "./pages/Home.tsx";
import { Issues } from "./pages/Issues.tsx";
import { Owner } from "./pages/Owner.tsx";
import { Projects, ProjectView } from "./pages/Projects.tsx";
import { LiveBoard } from "./pages/LiveBoard.tsx";
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

/** Shows on every screen while a watched site is down. */
function DownBanner() {
  const { data } = usePoll(() => api.watchOverview(), [], 60_000, () => true);
  if (!data?.down.length) return null;
  return (
    <div className="down-banner" role="alert">
      {data.down.map((d) => (
        <a key={d.id} href={`#/project/${d.id}`}>
          <b>{d.name} is down</b> since {new Date(d.since).toLocaleTimeString()}
          {d.url ? ` (${hostOf(d.url)})` : ""}
        </a>
      ))}
    </div>
  );
}

function Shell({ user, loginOff, onSignedOut }: { user: User; loginOff: boolean; onSignedOut: () => void }) {
  const route = useRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  // On a phone the menu closes when a page opens.
  useEffect(() => setMenuOpen(false), [route.name, route.id]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const reloadMeta = useCallback(() => {
    api.meta().then(setMeta).catch(() => {});
  }, []);
  useEffect(reloadMeta, [reloadMeta]);
  const projects = usePoll(() => api.projects(), [], 5000).data;
  const queue = usePoll(() => api.queue(), [], 3000, () => true).data;
  const [filter, setFilter] = useState("");
  const liveRun = new Map((queue?.running ?? []).map((r) => [r.projectId, r.runId]));

  const nav: [string, string, Parameters<typeof Icon>[0]["name"], boolean][] = [
    ["#/", "New test", "new", route.name === "home" || route.name === "new"],
    ["#/live", "Live", "live", route.name === "live"],
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
    else if (route.name === "live") page = <LiveBoard isOwner={user.role === "owner"} />;
    else if (route.name === "issues") page = <Issues projectId={route.query.get("project") ?? undefined} openId={route.id} />;
    else if (route.name === "owner") page = <Owner tab={route.id} meta={meta} reloadMeta={reloadMeta} user={user} loginOff={loginOff} />;
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand-row">
          <a className="brand" href="#/">
            <div className="logo">GLV</div>
            <div>
              <div className="brand-name">Testing Agent</div>
              <div className="brand-sub">by GLV Infotech Solutions</div>
            </div>
          </a>
          <button className="menu-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? "Close" : "More"}
          </button>
        </div>
        <nav className="nav">
          {nav.map(([href, label, icon, active]) => (
            <a key={href} href={href} className={`nav-item ${active ? "active" : ""}`}>
              <Icon name={icon} size={18} />
              {label}
              {href === "#/live" && queue && queue.running.length > 0 && <span className="nav-live">{queue.running.length}</span>}
            </a>
          ))}
        </nav>
        {queue && (
          <a className="queue-strip" href="#/live" title="Tests that run at the same time. The owner sets the limit in Owner panel > Settings.">
            <span className="queue-dots" aria-hidden="true">
              {Array.from({ length: queue.limit }, (_, i) => (
                <span key={i} className={i < queue.running.length ? "on" : ""} />
              ))}
            </span>
            <span>
              Testing {queue.running.length} of {queue.limit} at once
              {queue.waiting.length > 0 && ` · ${queue.waiting.length} waiting`}
            </span>
          </a>
        )}
        {projects && projects.length > 0 && (
          <>
            <div className="section-label phone-more">
              Projects ({projects.length})
            </div>
            {projects.length > 8 && (
              <input
                className="sidebar-filter phone-more"
                placeholder="Find a project"
                aria-label="Find a project"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            <ul className="run-list phone-more">
              {projects
                .filter((p) => !filter || `${p.name} ${p.target.url ?? ""}`.toLowerCase().includes(filter.toLowerCase()))
                .map((p) => (
                <li key={p.id}>
                  <button
                    className={`run-item ${route.name === "project" && route.id === p.id ? "active" : ""}`}
                    onClick={() => go(`#/project/${p.id}`)}
                  >
                    <ScoreChip score={p.lastScore} status={p.busy ? (p.waiting ? "queued" : "running") : p.lastRun?.status} />
                    <span className="run-meta">
                      <span className="run-url">{p.name}</span>
                      <span className="run-sub">
                        {p.busy ? (p.waiting ? `Waiting for a free slot…` : "Testing now…") : hostOf(p.target.url)}
                        {p.counts.open.critical + p.counts.open.high > 0 &&
                          ` · ${p.counts.open.critical + p.counts.open.high} major`}
                      </span>
                    </span>
                  </button>
                  {liveRun.get(p.id) && (
                    <a className="live-pill" href={`#/run/${liveRun.get(p.id)}`} title="Watch this test live">
                      ● Live
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="sidebar-foot phone-more">
          <ThemeSwitch />
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
      <main className="main">
        <DownBanner />
        {page}
      </main>
    </div>
  );
}

type Theme = "system" | "light" | "dark";
const readTheme = (): Theme => {
  try {
    const t = localStorage.getItem("glv.theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
};
/** Applied before React starts too (main.tsx), so the page never flashes the wrong colours. */
export function applyTheme(t: Theme = readTheme()) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
}

/** Light, dark, or the computer's own setting. Remembered in this browser. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const pick = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
    try {
      if (t === "system") localStorage.removeItem("glv.theme");
      else localStorage.setItem("glv.theme", t);
    } catch {
      // Private window: the choice lasts until the tab closes.
    }
  };
  return (
    <div className="theme-switch" role="group" aria-label="Colours">
      {(
        [
          ["system", "Auto"],
          ["light", "Light"],
          ["dark", "Dark"],
        ] as [Theme, string][]
      ).map(([t, label]) => (
        <button key={t} className={theme === t ? "active" : ""} aria-pressed={theme === t} onClick={() => pick(t)}>
          {label}
        </button>
      ))}
    </div>
  );
}
