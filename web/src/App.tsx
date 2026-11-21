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
import { MasterControl } from "./pages/MasterControl.tsx";
import { HackAgent } from "./pages/HackAgent.tsx";
import { ManualHome, ManualProject, ManualRoundView } from "./pages/Manual.tsx";
import { setView, useView } from "./view.ts";
import { Icon, ScoreChip } from "./ui.tsx";

/** Shorter names for the phone's bottom bar. */
const SHORT: Record<string, string> = { "Manual tests": "Manual", "Owner panel": "Owner", "Hack agent": "Hack" };

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

  // [address, name, icon, active, kept in the phone's bottom bar]
  const nav: [string, string, Parameters<typeof Icon>[0]["name"], boolean, boolean][] = [
    ["#/", "New test", "new", route.name === "home" || route.name === "new", true],
    ["#/live", "Live", "live", route.name === "live", true],
    ["#/projects", "Projects", "projects", route.name === "projects" || route.name === "project" || route.name === "control", true],
    ["#/hack", "Hack agent", "hack", route.name === "hack", true],
    ["#/issues", "Issues", "issues", route.name === "issues", true],
    ["#/manual", "Manual tests", "checklist", route.name === "manual" || route.name === "round", false],
  ];
  if (user.role === "owner") nav.push(["#/owner", "Owner panel", "owner", route.name === "owner", false]);

  let page = <div className="loading">Loading…</div>;
  if (meta) {
    if (route.name === "home") page = <Home meta={meta} />;
    else if (route.name === "new") page = <NewProject meta={meta} type={route.id as ProductType} key={route.id} />;
    else if (route.name === "projects") page = <Projects meta={meta} />;
    else if (route.name === "project" && route.id) page = <ProjectView id={route.id} meta={meta} user={user} key={route.id} />;
    else if (route.name === "run" && route.id) page = <Report id={route.id} key={route.id} />;
    else if (route.name === "control" && route.id) page = <MasterControl projectId={route.id} meta={meta} key={route.id} />;
    else if (route.name === "manual" && route.id) page = <ManualProject id={route.id} key={route.id} />;
    else if (route.name === "manual") page = <ManualHome meta={meta} />;
    else if (route.name === "round" && route.id) page = <ManualRoundView id={route.id} key={route.id} />;
    else if (route.name === "live") page = <LiveBoard isOwner={user.role === "owner"} />;
    else if (route.name === "hack") page = <HackAgent meta={meta} />;
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
              <div className="brand-sub">GLV Infotech Solutions</div>
            </div>
          </a>
          <ThemeToggle />
          <button className="menu-btn" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            {menuOpen ? "Close" : "More"}
          </button>
        </div>
        <nav className="nav" aria-label="Main">
          {nav.map(([href, label, icon, active, inBar]) => (
            <a key={href} href={href} className={`nav-item ${active ? "active" : ""} ${inBar ? "" : "not-in-bar"}`}>
              <Icon name={icon} size={18} />
              <span className="nav-text">{label}</span>
              <span className="nav-short">{SHORT[label] ?? label}</span>
              {href === "#/live" && queue && queue.running.length > 0 && <span className="nav-live">{queue.running.length}</span>}
            </a>
          ))}
        </nav>
        <nav className="more-nav phone-more" aria-label="More">
          {nav
            .filter(([, , , , inBar]) => !inBar)
            .map(([href, label, icon, active]) => (
              <a key={href} href={href} className={`nav-item ${active ? "active" : ""}`}>
                <Icon name={icon} size={18} />
                <span>{label}</span>
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
          <div className="side-projects phone-more">
            <div className="section-label">
              Projects <span className="side-count">{projects.length}</span>
            </div>
            {projects.length > 8 && (
              <input
                className="sidebar-filter"
                placeholder="Find a project"
                aria-label="Find a project"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            )}
            <ul className="run-list">
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
          </div>
        )}
        <div className="sidebar-foot phone-more">
          <ViewSwitch />
          <div className="me">
            <span className="me-avatar" aria-hidden="true">
              {(user.name || "?").trim().charAt(0).toUpperCase()}
            </span>
            <div className="me-text">
              <div className="me-name">{user.name}</div>
              <div className="me-role">
                {user.role === "owner" ? "Owner" : "Team member"}
                {meta && (
                  <span className={`ai-dot ${meta.ai && meta.aiSummary ? "on" : ""}`} title={meta.ai && meta.aiSummary ? "Claude summary is on" : "Claude summary is off"}>
                    {" "}
                    · Claude {meta.ai && meta.aiSummary ? "on" : "off"}
                  </span>
                )}
              </div>
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

/** What the page shows now: the saved choice, or the computer's own setting. */
const effectiveTheme = (t: Theme): "light" | "dark" =>
  t !== "system" ? t : typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";

/** A small light/dark switch. It starts with the computer's own setting and remembers a choice in this browser. */
function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">(() => effectiveTheme(readTheme()));
  const flip = () => {
    const t = theme === "dark" ? "light" : "dark";
    setTheme(t);
    applyTheme(t);
    try {
      localStorage.setItem("glv.theme", t);
    } catch {
      // Private window: the choice lasts until the tab closes.
    }
  };
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      className={`theme-toggle ${dark ? "dark" : ""}`}
      onClick={flip}
      title={dark ? "Dark colours: switch to light" : "Light colours: switch to dark"}
      aria-label="Dark colours"
    >
      <span className="theme-knob">
        <Icon name={dark ? "moon" : "sun"} size={12} />
      </span>
    </button>
  );
}

/** Simple view (the default) keeps each screen short; full view shows every agent, tool and setting. */
export function ViewSwitch() {
  const view = useView();
  return (
    <div className="view-switch" title={view === "simple" ? "Simple view: only what most tests need" : "Full view: every agent, tool and setting"}>
      <div className="theme-switch" role="group" aria-label="How much to show">
        {(
          [
            ["simple", "Simple"],
            ["full", "Full"],
          ] as const
        ).map(([v, label]) => (
          <button key={v} className={view === v ? "active" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
            {label}
          </button>
        ))}
      </div>

    </div>
  );
}
