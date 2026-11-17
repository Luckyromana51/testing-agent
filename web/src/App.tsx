import { useCallback, useEffect, useMemo, useState } from "react";
import type { Category, Finding, Run, Severity } from "../../src/types.ts";
import { api, type RunSummary } from "./api.ts";

const CATEGORY_LABEL: Record<Category, string> = {
  functional: "Functional",
  accessibility: "Accessibility",
  seo: "SEO",
  security: "Security",
  performance: "Performance",
  mobile: "Mobile",
};
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "info"];

function scoreTone(score?: number) {
  if (score === undefined) return "muted";
  if (score >= 90) return "good";
  if (score >= 60) return "warn";
  return "bad";
}

function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

function useHashRoute(): [string | null, (id: string | null) => void] {
  const read = () => window.location.hash.replace(/^#\/?run\//, "") || null;
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return [id, (next) => (window.location.hash = next ? `#/run/${next}` : "")];
}

export function App() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [aiOn, setAiOn] = useState<boolean | null>(null);
  const [selected, select] = useHashRoute();

  const refresh = useCallback(
    () =>
      api
        .list()
        .then(setRuns)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    refresh();
    api
      .health()
      .then((h) => setAiOn(h.ai))
      .catch(() => setAiOn(false));
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">GLV</div>
          <div>
            <div className="brand-name">Testing Agent</div>
            <div className="brand-sub">by GLV Infotech Solutions</div>
          </div>
        </div>
        <NewScan
          onCreated={(run) => {
            refresh();
            select(run.id);
          }}
        />
        <div className="section-label">Recent scans</div>
        <ul className="run-list">
          {runs.length === 0 && <li className="empty">No scans yet. Start one above.</li>}
          {runs.map((r) => (
            <li key={r.id}>
              <button
                className={`run-item ${selected === r.id ? "active" : ""}`}
                onClick={() => select(r.id)}
              >
                <span className={`score-chip ${scoreTone(r.overallScore)}`}>
                  {r.status === "done" ? r.overallScore : r.status === "failed" ? "!" : "…"}
                </span>
                <span className="run-meta">
                  <span className="run-url">{r.url.replace(/^https?:\/\//, "")}</span>
                  <span className="run-sub">
                    {r.status === "done"
                      ? `${r.pageCount} pages · ${r.findingCount} findings · ${timeAgo(r.createdAt)}`
                      : r.status === "failed"
                        ? `Failed · ${timeAgo(r.createdAt)}`
                        : (r.lastProgress ?? "Queued")}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className={`ai-status ${aiOn ? "on" : ""}`}>
          {aiOn === null ? "" : aiOn ? "Claude summary is on" : "Claude summary is off (no API key)"}
        </div>
      </aside>
      <main className="main">
        {selected ? (
          <RunView id={selected} key={selected} onDeleted={() => (select(null), refresh())} />
        ) : (
          <Welcome />
        )}
      </main>
    </div>
  );
}

function NewScan({ onCreated }: { onCreated: (run: Run) => void }) {
  const [url, setUrl] = useState("");
  const [maxPages, setMaxPages] = useState(10);
  const [checkLinks, setCheckLinks] = useState(true);
  const [accessibility, setAccessibility] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      onCreated(await api.create({ url, maxPages, checkLinks, accessibility }));
      setUrl("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="new-scan" onSubmit={submit}>
      <label className="field-label" htmlFor="url">
        Website to test
      </label>
      <input
        id="url"
        className="input"
        placeholder="https://example.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        required
      />
      <div className="row">
        <label className="field-label inline" htmlFor="pages">
          Pages
        </label>
        <input
          id="pages"
          className="input small"
          type="number"
          min={1}
          max={100}
          value={maxPages}
          onChange={(e) => setMaxPages(Number(e.target.value))}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={checkLinks} onChange={(e) => setCheckLinks(e.target.checked)} /> Check
        every link
      </label>
      <label className="check">
        <input type="checkbox" checked={accessibility} onChange={(e) => setAccessibility(e.target.checked)} />{" "}
        Accessibility (WCAG 2.2)
      </label>
      <button className="btn primary" disabled={busy}>
        {busy ? "Starting…" : "Start scan"}
      </button>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <h1>Test any website in minutes</h1>
      <p>
        Enter a website address on the left. The agent opens every page in a real browser and checks it the
        way a QA engineer would.
      </p>
      <div className="welcome-grid">
        {[
          ["Functional", "Broken links, 404 pages, JavaScript errors, failed requests"],
          ["Accessibility", "WCAG 2.2 A/AA checks with axe-core: contrast, labels, alt text"],
          ["SEO", "Titles, meta descriptions, headings, canonical, Open Graph"],
          ["Security", "HTTPS, security headers, cookie flags, mixed content (passive only)"],
          ["Performance", "Load time and page weight for every page"],
          ["Mobile", "Phone-width layout, sideways scrolling, tap target size"],
        ].map(([t, d]) => (
          <div className="welcome-card" key={t}>
            <div className="welcome-title">{t}</div>
            <div className="welcome-desc">{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunView({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"findings" | "pages">("findings");

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await api.get(id);
        if (stop) return;
        setRun(r);
        if (r.status === "queued" || r.status === "running") setTimeout(load, 1500);
      } catch (err) {
        setError((err as Error).message);
      }
    };
    load();
    return () => {
      stop = true;
    };
  }, [id]);

  if (error) return <div className="error big">{error}</div>;
  if (!run) return <div className="loading">Loading…</div>;

  const header = (
    <header className="run-header">
      <div>
        <div className="eyebrow">Scan report</div>
        <h1 className="run-title">
          <a href={run.url} target="_blank" rel="noreferrer">
            {run.url}
          </a>
        </h1>
        <div className="run-sub">
          Started {new Date(run.createdAt).toLocaleString()}
          {run.result && ` · ${run.result.pages.length} pages tested`}
        </div>
      </div>
      <button
        className="btn ghost"
        onClick={async () => {
          await api.remove(run.id);
          onDeleted();
        }}
      >
        Delete
      </button>
    </header>
  );

  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="run">
        {header}
        <div className="progress-card">
          <div className="spinner" />
          <div>
            <div className="progress-title">Testing in progress</div>
            <ul className="progress-log">
              {run.progress.slice(-8).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  if (run.status === "failed" || !run.result) {
    return (
      <div className="run">
        {header}
        <div className="error big">The scan failed: {run.error}</div>
      </div>
    );
  }

  const { result } = run;
  return (
    <div className="run">
      {header}
      <section className="scores">
        <div className={`overall ${scoreTone(result.overallScore)}`}>
          <div className="overall-num">{result.overallScore}</div>
          <div className="overall-label">Overall score</div>
        </div>
        <div className="score-grid">
          {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => {
            const n = result.findings.filter((f) => f.category === c && f.severity !== "info").length;
            return (
              <div className="score-card" key={c}>
                <div className="score-card-top">
                  <span>{CATEGORY_LABEL[c]}</span>
                  <span className={`score-num ${scoreTone(result.scores[c])}`}>{result.scores[c]}</span>
                </div>
                <div className="bar">
                  <div
                    className={`bar-fill ${scoreTone(result.scores[c])}`}
                    style={{ width: `${result.scores[c]}%` }}
                  />
                </div>
                <div className="score-card-sub">
                  {n === 0 ? "No issues" : `${n} issue${n > 1 ? "s" : ""}`}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <AiPanel run={run} />

      <div className="tabs">
        <button className={tab === "findings" ? "active" : ""} onClick={() => setTab("findings")}>
          Findings ({result.findings.length})
        </button>
        <button className={tab === "pages" ? "active" : ""} onClick={() => setTab("pages")}>
          Pages ({result.pages.length})
        </button>
      </div>
      {tab === "findings" ? <Findings findings={result.findings} /> : <Pages run={run} />}
    </div>
  );
}

function AiPanel({ run }: { run: Run }) {
  if (!run.ai) {
    return (
      <section className="ai-panel off">
        <div className="ai-head">Claude summary</div>
        <p className="muted">{run.aiError ?? "No summary for this scan."}</p>
      </section>
    );
  }
  return (
    <section className="ai-panel">
      <div className="ai-head">
        Claude summary <span className="model">{run.ai.model}</span>
      </div>
      <p>{run.ai.summary}</p>
      <ol className="fixes">
        {run.ai.topFixes.map((f, i) => (
          <li key={i}>
            <div className="fix-title">{f.title}</div>
            <div className="fix-why">{f.why}</div>
            <div className="fix-how">{f.how}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  const [cat, setCat] = useState<Category | "all">("all");
  const [minSev, setMinSev] = useState<Severity>("low");
  const [open, setOpen] = useState<string | null>(null);

  const shown = useMemo(() => {
    const limit = SEVERITIES.indexOf(minSev);
    return findings
      .filter((f) => (cat === "all" || f.category === cat) && SEVERITIES.indexOf(f.severity) <= limit)
      .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  }, [findings, cat, minSev]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const f of findings) c[f.severity]++;
    return c;
  }, [findings]);

  return (
    <section>
      <div className="filters">
        <div className="pills">
          {(["all", ...Object.keys(CATEGORY_LABEL)] as (Category | "all")[]).map((c) => (
            <button key={c} className={`pill ${cat === c ? "active" : ""}`} onClick={() => setCat(c)}>
              {c === "all" ? "All" : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <select
          className="input select"
          value={minSev}
          onChange={(e) => setMinSev(e.target.value as Severity)}
        >
          {SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s === "info" ? "Show everything" : `${s[0].toUpperCase()}${s.slice(1)} and above`}
            </option>
          ))}
        </select>
      </div>
      <div className="sev-summary">
        {SEVERITIES.map((s) => (
          <span key={s} className={`sev-count sev-${s}`}>
            {counts[s]} {s}
          </span>
        ))}
      </div>
      <ul className="findings">
        {shown.length === 0 && <li className="empty">Nothing to show with these filters.</li>}
        {shown.map((f) => (
          <li key={f.id + f.pageUrl} className={`finding ${open === f.id ? "open" : ""}`}>
            <button className="finding-row" onClick={() => setOpen(open === f.id ? null : f.id)}>
              <span className={`sev sev-${f.severity}`}>{f.severity}</span>
              <span className="finding-title">{f.title}</span>
              <span className="finding-cat">{CATEGORY_LABEL[f.category]}</span>
              <span className="finding-page">{new URL(f.pageUrl).pathname}</span>
            </button>
            {open === f.id && (
              <div className="finding-body">
                <p>{f.detail}</p>
                {f.evidence && <pre className="evidence">{f.evidence}</pre>}
                <div className="finding-foot">
                  Rule <code>{f.rule}</code> · Page{" "}
                  <a href={f.pageUrl} target="_blank" rel="noreferrer">
                    {f.pageUrl}
                  </a>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Pages({ run }: { run: Run }) {
  const pages = run.result!.pages;
  return (
    <div className="pages">
      {pages.map((p) => {
        const issues = run.result!.findings.filter(
          (f) => f.pageUrl === p.url && f.severity !== "info",
        ).length;
        return (
          <div className="page-card" key={p.url}>
            <div className="shots">
              {p.screenshot && (
                <img
                  className="shot"
                  src={api.artifact(run.id, p.screenshot)}
                  alt={`Desktop view of ${p.url}`}
                />
              )}
              {p.mobileScreenshot && (
                <img
                  className="shot mobile"
                  src={api.artifact(run.id, p.mobileScreenshot)}
                  alt={`Phone view of ${p.url}`}
                />
              )}
            </div>
            <div className="page-info">
              <div className="page-title">{p.title || "(no title)"}</div>
              <a className="page-url" href={p.url} target="_blank" rel="noreferrer">
                {p.url}
              </a>
              <div className="page-stats">
                <span className={p.status && p.status < 400 ? "ok" : "bad"}>HTTP {p.status ?? "error"}</span>
                {p.loadMs !== null && <span>{(p.loadMs / 1000).toFixed(1)} s</span>}
                <span>
                  {issues} issue{issues === 1 ? "" : "s"}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
