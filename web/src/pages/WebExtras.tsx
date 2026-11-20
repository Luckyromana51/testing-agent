import { useEffect, useState } from "react";
import type { RumSummary } from "../../../src/types.ts";
import { api, type ProjectSummary, type RumView, type Upload } from "../api.ts";
import { timeAgo } from "../lib.ts";
import { FilePicker } from "./Home.tsx";

/*
 * Project page extras for websites and apps: the test-copy switch (checks that change data),
 * real-visitor speed, the SEO audit's input, and the repository Claude opens fix pull requests on.
 */

type Props = { project: ProjectSummary; onChanged: () => void };

const PUBLIC = ["website", "ecommerce", "webapp", "saas"];

export function GrowthTab({ project, onChanged }: Props) {
  return (
    <>
      <h2 className="section-title">Speed from real visitors</h2>
      <RumCard project={project} />
      {PUBLIC.includes(project.type) && (
        <>
          <h2 className="section-title">SEO audit: keywords and backlinks</h2>
          <SeoCard project={project} onChanged={onChanged} />
        </>
      )}
    </>
  );
}

/** Whether checks that change data (lockout, uploads, mass assignment, form filling) may run. */
export function TestCopyCard({ project, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const on = Boolean(project.target.testServer);
  return (
    <div className="card">
      <label className="check dark">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={async (e) => {
            setBusy(true);
            setError("");
            try {
              await api.updateProject(project.id, { testServer: e.target.checked });
              onChanged();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />{" "}
        This is a <b>test copy</b> of the app (staging, a sandbox), not the live one
      </label>
      <p className="muted small">
        Some checks change data: account lockout (wrong passwords on a spare account), file upload safety (harmless marker files), mass
        assignment (extra fields on a save, then put back), forgot-password, the Salesforce guest check and Claude filling forms. They run only on a
        test copy, or on a client's app while a signed <b>"Checks that change data"</b> permission is active (Overview tab). Never on scheduled
        re-tests. What they make is removed, and anything left is listed in the report.
      </p>
      <div className={project.writes.allowed ? "ok small" : "warn small"}>{project.writes.allowed ? "These checks will run: " : "These checks will be skipped: "}{project.writes.why}</div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Where Claude opens fix pull requests, and the token it uses (saved in the vault). */
export function FixRepoCard({ project, onChanged }: Props) {
  const isCode = project.type === "code";
  const [repo, setRepo] = useState(project.target.fixRepoUrl ?? "");
  const [branch, setBranch] = useState(project.target.fixBranch ?? "");
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const t = project.repoToken;
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setSaved(msg);
      setTimeout(() => setSaved(""), 2500);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <p className="muted small">
        On an issue, press <b>Ask Claude to fix</b>: Claude reads the code, writes the smallest change, and opens a pull request on a new branch
        (glv-fix/…). Nothing is merged: your developers review it. Works with GitHub and GitLab. Needs ANTHROPIC_API_KEY in the server's .env.
      </p>
      {!isCode && (
        <div className="form-row">
          <label className="form-field grow">
            <span>Repository of this {project.type === "website" ? "website" : "app"}'s code (https)</span>
            <input className="input" placeholder="https://github.com/company/site" value={repo} onChange={(e) => setRepo(e.target.value)} />
          </label>
          <label className="form-field">
            <span>Base branch</span>
            <input className="input" placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
        </div>
      )}
      {!isCode && (repo !== (project.target.fixRepoUrl ?? "") || branch !== (project.target.fixBranch ?? "")) && (
        <button className="btn primary" disabled={busy} onClick={() => run(() => api.updateProject(project.id, { fixRepoUrl: repo, fixBranch: branch }), "Repository saved.")}>
          Save repository
        </button>
      )}
      <div className="stat-label">Access token</div>
      {t.saved ? (
        <div className="small">
          {t.fromGitLogin ? "Uses the token saved with the project's Git login." : `Saved${t.username ? ` for ${t.username}` : ""}${t.updatedAt ? `, ${timeAgo(t.updatedAt)}` : ""}.`}{" "}
          {!t.fromGitLogin && (
            <button className="btn ghost small danger" disabled={busy} onClick={() => run(() => api.deleteRepoToken(project.id), "Token removed.")}>
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="muted small">None yet. Make a token that can push branches and open pull requests (GitHub: fine-grained, Contents and Pull requests read and write).</div>
      )}
      <div className="form-row">
        <label className="form-field">
          <span>User name (GitLab, optional)</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </label>
        <label className="form-field grow">
          <span>{t.saved ? "New token" : "Token"}</span>
          <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="new-password" />
        </label>
      </div>
      {token && (
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.saveRepoToken(project.id, { username: username || undefined, token });
              setToken("");
            }, "Token saved in the vault.")
          }
        >
          Save token
        </button>
      )}
      {saved && <span className="ok small"> {saved}</span>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

const fmt = {
  lcp: (v?: number) => (v === undefined ? "–" : `${(v / 1000).toFixed(1)} s`),
  inp: (v?: number) => (v === undefined ? "–" : `${Math.round(v)} ms`),
  cls: (v?: number) => (v === undefined ? "–" : v.toFixed(2)),
  ttfb: (v?: number) => (v === undefined ? "–" : `${Math.round(v)} ms`),
  fcp: (v?: number) => (v === undefined ? "–" : `${(v / 1000).toFixed(1)} s`),
};
const grade = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], ttfb: [800, 1800], fcp: [1800, 3000] } as const;
const toneOf = (k: keyof typeof grade, v?: number) => (v === undefined ? "muted" : v <= grade[k][0] ? "ok" : v <= grade[k][1] ? "warn" : "bad");

function P75Row({ label, visits, p }: { label: string; visits: number; p: RumSummary["p75"] }) {
  return (
    <tr>
      <td className="mono small">{label}</td>
      <td>{visits}</td>
      {(["lcp", "inp", "cls", "ttfb", "fcp"] as const).map((k) => (
        <td key={k} className={toneOf(k, p[k])}>
          {fmt[k](p[k])}
        </td>
      ))}
    </tr>
  );
}

function RumCard({ project }: { project: ProjectSummary }) {
  const [view, setView] = useState<RumView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let stop = false;
    const load = () => api.rum(project.id).then((v) => !stop && setView(v)).catch((e: Error) => !stop && setError(e.message));
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [project.id]);
  const set = async (b: { on?: boolean; clear?: boolean; fresh?: boolean }) => {
    setBusy(true);
    setError("");
    try {
      setView(await api.setRum(project.id, b));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const s = view?.summary;
  return (
    <div className="card">
      <p className="muted small">
        A small script for the site's pages. Each visitor's browser measures how fast the page really was for them (LCP, INP, CLS, TTFB, FCP)
        and sends only those numbers, the page path and the screen kind to this server. No cookies, no names, no IP addresses kept. Numbers are
        the 75th percentile of the last 28 days, as Google's Core Web Vitals use. Reports flag slow pages once 20 visits have come in.
      </p>
      {!view ? (
        <div className="muted small">Loading…</div>
      ) : !view.on ? (
        <button className="btn" disabled={busy} onClick={() => set({ on: true })}>
          Turn on real-visitor speed
        </button>
      ) : (
        <>
          <div className="stat-label">Put this before &lt;/body&gt; on every page</div>
          <pre className="code small">{view.snippet}</pre>
          <div className="row">
            <button className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(view.snippet ?? "")}>
              Copy snippet
            </button>
            <button className="btn ghost small" disabled={busy} onClick={() => set({ on: true, fresh: true })}>
              New address
            </button>
            <button className="btn ghost small" disabled={busy} onClick={() => window.confirm("Delete the visits collected so far?") && set({ clear: true })}>
              Clear data
            </button>
            <button className="btn ghost small danger" disabled={busy} onClick={() => set({ on: false })}>
              Turn off
            </button>
          </div>
          {!s || !s.visits ? (
            <div className="muted small">No visits yet. They show here a few seconds after someone opens a page with the snippet.</div>
          ) : (
            <table className="table small">
              <thead>
                <tr>
                  <th>Pages (since {new Date(s.since).toLocaleDateString()})</th>
                  <th>Visits</th>
                  <th>Main content (LCP)</th>
                  <th>Response to taps (INP)</th>
                  <th>Layout shift (CLS)</th>
                  <th>Server (TTFB)</th>
                  <th>First paint (FCP)</th>
                </tr>
              </thead>
              <tbody>
                <P75Row label="All pages" visits={s.visits} p={s.p75} />
                {s.byDevice.map((d) => (
                  <P75Row key={d.device} label={`On ${d.device}s`} visits={d.visits} p={d.p75} />
                ))}
                {s.pages.slice(0, 20).map((pg) => (
                  <P75Row key={pg.path} label={pg.path} visits={pg.visits} p={pg.p75} />
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function SeoCard({ project, onChanged }: Props) {
  const [keywords, setKeywords] = useState(project.seo?.keywords ?? "");
  const [backlinks, setBacklinks] = useState(project.seo?.backlinks ?? "");
  const [gsc, setGsc] = useState<Upload | null>(project.seo?.gscFile ? { file: project.seo.gscFile, fileName: project.seo.gscFileName ?? project.seo.gscFile, size: 0 } : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const changed = keywords !== (project.seo?.keywords ?? "") || backlinks !== (project.seo?.backlinks ?? "") || (gsc?.file ?? "") !== (project.seo?.gscFile ?? "");
  return (
    <div className="card">
      <div className="note small">
        <b>What this can and cannot do.</b> GLV's server reads your own pages, the backlink pages you list and your Search Console export. It
        cannot find every site on the web that links to you, or see Google rankings by itself: that needs a web-wide crawl (what Ahrefs and
        Semrush sell) or Google's own data. So: list the backlinks you know of (from Search Console's Links report, outreach, partners) and
        upload the Search Console export for positions and clicks.
      </div>
      <label className="form-field">
        <span>Target keywords, one page a line: page | keyword, keyword</span>
        <textarea className="input code" rows={4} value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={"/ | testing agent, website testing\n/pricing | testing tool price india"} spellCheck={false} />
      </label>
      <label className="form-field">
        <span>Backlinks you know of: the address of each page that links to this site, one a line</span>
        <textarea className="input code" rows={4} value={backlinks} onChange={(e) => setBacklinks(e.target.value)} placeholder={"https://partner.example.com/tools\nhttps://blog.example.org/best-testing-tools"} spellCheck={false} />
      </label>
      <FilePicker accept=".csv" label="Search Console export (optional)" hint="Performance → Export → CSV: the Queries.csv or Pages.csv file" value={gsc} onChange={setGsc} />
      <div className="row">
        {changed && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                await api.saveSeo(project.id, { keywords, backlinks, gscFile: gsc?.file ?? "", gscFileName: gsc?.fileName });
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
                onChanged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        )}
        {saved && <span className="ok small">Saved. The next test checks them.</span>}
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}
