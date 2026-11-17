import { useMemo, useState } from "react";
import { fixFor } from "../../../src/fixes.ts";
import { groupFindings, type IssueGroup } from "../../../src/group.ts";
import type { Category, Finding, Run, Severity } from "../../../src/types.ts";
import { api } from "../api.ts";
import { CATEGORY_LABEL, go, isMajor, pathOf, plural, scoreTone, SEVERITIES, usePoll } from "../lib.ts";
import { FixBox, Sev } from "../ui.tsx";

/** True for web addresses; code and app findings point at files instead. */
const isUrl = (s: string) => /^https?:\/\//.test(s);

/** What a result's "pages" are: web pages, API endpoints, or files. */
function unitOf(run: Run): { one: string; many: string; tab: string } {
  const label = run.result?.label?.pages;
  if (label === "Endpoints") return { one: "endpoint", many: "endpoints", tab: "Endpoints" };
  if (label === "Files") return { one: "file", many: "files", tab: "Files" };
  return { one: "page", many: "pages", tab: "Pages" };
}

function Place({ at }: { at: string }) {
  return isUrl(at) ? (
    <a href={at} target="_blank" rel="noreferrer">
      {at}
    </a>
  ) : (
    <code>{at}</code>
  );
}

/** Rules whose evidence is a link target, so each item is listed as "link (status) on page". */
const LINK_RULES = new Set(["broken-link", "broken-external-link", "unverified-external-link"]);

export function Report({ id }: { id: string }) {
  const { data: run, error: loadError } = usePoll(
    () => api.run(id),
    [id],
    1500,
    (r) => r.status === "queued" || r.status === "running",
  );
  const [actionError, setError] = useState("");
  const [tab, setTab] = useState<"issues" | "pages" | "agents">("issues");
  const error = loadError || actionError;

  if (error) return <div className="page error big">{error}</div>;
  if (!run || run.id !== id) return <div className="loading">Loading…</div>;

  const header = (
    <header className="run-header">
      <div>
        {run.projectId && (
          <a href={`#/project/${run.projectId}`} className="back">
            ← Project
          </a>
        )}
        <div className="eyebrow">Test report</div>
        <h1 className="run-title">
          {isUrl(run.url) ? (
            <a href={run.url} target="_blank" rel="noreferrer">
              {run.url}
            </a>
          ) : (
            run.url
          )}
        </h1>
        <div className="run-sub">
          {new Date(run.createdAt).toLocaleString()}
          {run.result && unitOf(run).one !== "file" && ` · ${plural(run.result.pages.length, unitOf(run).one)} tested`}
          {run.agents && ` · ${run.agents.length} agents`}
        </div>
      </div>
      <div className="header-actions">
        {run.projectId && run.status !== "running" && run.status !== "queued" && (
          <button
            className="btn"
            onClick={async () => {
              const next = await api.retest(run.projectId!).catch((e: Error) => (setError(e.message), null));
              if (next) go(`#/run/${next.id}`);
            }}
          >
            Re-test
          </button>
        )}
        {run.status !== "running" && run.status !== "queued" && (
          <button
            className="btn ghost"
            onClick={async () => {
              await api.deleteRun(run.id);
              go(run.projectId ? `#/project/${run.projectId}` : "#/projects");
            }}
          >
            Delete
          </button>
        )}
      </div>
    </header>
  );

  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="page run">
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
      <div className="page run">
        {header}
        <div className="error big">The test failed: {run.error}</div>
      </div>
    );
  }

  const { result } = run;
  const groups = groupFindings(result.findings);
  const major = groups.filter((g) => isMajor(g.severity));
  const unit = unitOf(run);
  const categories = (Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => result.scores[c] !== undefined);
  return (
    <div className="page run">
      {header}

      {run.diff && (
        <div className="diff-banner">
          <span className="diff-label">Compared with the last test</span>
          <span className="diff-new">{run.diff.new} new</span>
          <span className="diff-fixed">{run.diff.fixed} fixed and verified</span>
          <span className="diff-reopened">{run.diff.reopened} came back</span>
          <a href={`#/issues?project=${run.projectId}`}>{plural(run.diff.open, "open issue")} on the board →</a>
        </div>
      )}

      <section className="scores">
        <div className={`overall ${scoreTone(result.overallScore)}`}>
          <div className="overall-num">{result.overallScore}</div>
          <div className="overall-label">Overall score</div>
        </div>
        <div className="score-grid">
          {categories.map((c) => {
            const n = groups.filter((g) => g.first.category === c && g.severity !== "info").length;
            const score = result.scores[c] ?? 100;
            return (
              <div className="score-card" key={c}>
                <div className="score-card-top">
                  <span>{CATEGORY_LABEL[c]}</span>
                  <span className={`score-num ${scoreTone(score)}`}>{score}</span>
                </div>
                <div className="bar">
                  <div className={`bar-fill ${scoreTone(score)}`} style={{ width: `${score}%` }} />
                </div>
                <div className="score-card-sub">{n === 0 ? "No issues" : plural(n, "issue")}</div>
              </div>
            );
          })}
        </div>
      </section>

      {result.notes && result.notes.length > 0 && (
        <section className="card notes-card">
          <div className="notes-head">What was tested</div>
          <ul>
            {result.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="major">
        <h2 className="section-title">
          {major.length ? `${plural(major.length, "major issue")} to fix first` : "No major issues"}
        </h2>
        {major.length === 0 && (
          <div className="card good-card">Nothing critical or high was found. The rest of the list below is polish.</div>
        )}
        {major.map((g) => (
          <MajorCard key={g.key} g={g} unit={unit.many} />
        ))}
      </section>

      <AiPanel run={run} />

      <div className="tabs">
        <button className={tab === "issues" ? "active" : ""} onClick={() => setTab("issues")}>
          All issues ({groups.length})
        </button>
        {result.pages.length > 0 && (
          <button className={tab === "pages" ? "active" : ""} onClick={() => setTab("pages")}>
            {unit.tab} ({result.pages.length})
          </button>
        )}
        {result.agentStats && (
          <button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>
            Agents ({result.agentStats.length})
          </button>
        )}
      </div>
      {tab === "issues" && <IssueList groups={groups} categories={categories} unit={unit.many} />}
      {tab === "pages" && <Pages run={run} />}
      {tab === "agents" && <Agents run={run} />}
    </div>
  );
}

function MajorCard({ g, unit }: { g: IssueGroup; unit: string }) {
  const [open, setOpen] = useState(false);
  const f = g.first;
  return (
    <div className={`card major-card sev-border-${g.severity}`}>
      <div className="major-head">
        <Sev s={g.severity} />
        <div className="grow">
          <div className="major-title">{LINK_RULES.has(f.rule) && g.items.length > 1 ? `${f.title} (${g.items.length})` : f.title}</div>
          <div className="muted small">
            {CATEGORY_LABEL[f.category]} · {g.pages.length > 1 ? `${unit === "files" ? "in" : "on"} ${g.pages.length} ${unit}` : pathOf(f.pageUrl)}
          </div>
        </div>
        <button className="btn small" onClick={() => setOpen(!open)}>
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      <p>{f.detail}</p>
      <FixBox fix={fixFor(f)} />
      {open && <Occurrences g={g} unit={unit} />}
    </div>
  );
}

function Occurrences({ g, unit = "pages" }: { g: IssueGroup; unit?: string }) {
  const f = g.first;
  if (LINK_RULES.has(f.rule)) {
    return (
      <ul className="finding-pages">
        {g.items.map((i) => (
          <li key={i.id}>
            <code>{i.evidence}</code>
            <span className="muted">
              {" "}
              · on{" "}
              <a href={i.pageUrl} target="_blank" rel="noreferrer">
                {pathOf(i.pageUrl)}
              </a>
            </span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      {f.evidence && <pre className="evidence">{f.evidence}</pre>}
      <div className="finding-foot">
        Rule <code>{f.rule}</code>
        {f.agent && (
          <>
            {" "}
            · agent <code>{f.agent}</code>
          </>
        )}{" "}
        · {g.pages.length > 1 ? `found in ${g.pages.length} ${unit}:` : `${unit.replace(/s$/, "")}:`}
      </div>
      <ul className="finding-pages">
        {g.pages.map((p) => {
          const items = g.items.filter((i) => i.pageUrl === p);
          const other = items.find((i) => i.title !== f.title);
          const ev = g.pages.length > 1 && !isUrl(p) ? items[0]?.evidence : undefined;
          return (
            <li key={p}>
              <Place at={p} />
              {other && <span className="muted"> · {other.title}</span>}
              {ev && <span className="muted"> · {ev}</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function AiPanel({ run }: { run: Run }) {
  if (!run.ai) {
    return (
      <section className="ai-panel off">
        <div className="ai-head">Claude summary</div>
        <p className="muted">{run.aiError ?? "No summary for this test."}</p>
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

function IssueList({ groups, categories, unit }: { groups: IssueGroup[]; categories: Category[]; unit: string }) {
  const [cat, setCat] = useState<Category | "all">("all");
  const [minSev, setMinSev] = useState<Severity>("low");
  const [open, setOpen] = useState<string | null>(null);

  const shown = useMemo(() => {
    const limit = SEVERITIES.indexOf(minSev);
    return groups.filter((g) => (cat === "all" || g.first.category === cat) && SEVERITIES.indexOf(g.severity) <= limit);
  }, [groups, cat, minSev]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
    for (const g of groups) c[g.severity]++;
    return c;
  }, [groups]);

  return (
    <section>
      <div className="filters">
        <div className="pills">
          {(["all", ...categories] as (Category | "all")[]).map((c) => (
            <button key={c} className={`pill ${cat === c ? "active" : ""}`} onClick={() => setCat(c)}>
              {c === "all" ? "All" : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <select className="input select" value={minSev} onChange={(e) => setMinSev(e.target.value as Severity)}>
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
        <span className="muted">distinct issues</span>
      </div>
      <ul className="findings">
        {shown.length === 0 && <li className="empty">Nothing to show with these filters.</li>}
        {shown.map((g) => {
          const f: Finding = g.first;
          const key = g.key;
          return (
            <li key={key} className={`finding ${open === key ? "open" : ""}`}>
              <button className="finding-row" onClick={() => setOpen(open === key ? null : key)}>
                <Sev s={g.severity} />
                <span className="finding-title">
                  {LINK_RULES.has(f.rule) && g.items.length > 1 ? `${f.title} (${g.items.length})` : f.title}
                </span>
                <span className="finding-cat">{CATEGORY_LABEL[f.category]}</span>
                <span className="finding-page">{g.pages.length > 1 ? `${g.pages.length} ${unit}` : pathOf(f.pageUrl)}</span>
              </button>
              {open === key && (
                <div className="finding-body">
                  <p>{f.detail}</p>
                  <FixBox fix={fixFor(f)} />
                  <Occurrences g={g} unit={unit} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Pages({ run }: { run: Run }) {
  const pages = run.result!.pages;
  return (
    <div className="pages">
      {pages.map((p) => {
        const issues = groupFindings(run.result!.findings.filter((f) => f.pageUrl === p.url && f.severity !== "info")).length;
        return (
          <div className="page-card" key={p.url}>
            <div className="shots">
              {p.screenshot && <img className="shot" src={api.artifact(run.id, p.screenshot)} alt={`Desktop view of ${p.url}`} />}
              {p.mobileScreenshot && (
                <img className="shot mobile" src={api.artifact(run.id, p.mobileScreenshot)} alt={`Phone view of ${p.url}`} />
              )}
            </div>
            <div className="page-info">
              <div className="page-title">{p.title || "(no title)"}</div>
              {isUrl(p.url) && p.url !== p.title && (
                <a className="page-url" href={p.url} target="_blank" rel="noreferrer">
                  {p.url}
                </a>
              )}
              <div className="page-stats">
                {(isUrl(p.url) || p.status !== null) && (
                  <span className={p.status && p.status < 400 ? "ok" : "bad"}>{p.status ? `HTTP ${p.status}` : (p.error ?? "No answer")}</span>
                )}
                {p.metrics?.lcpMs ? (
                  <span title="Largest Contentful Paint: when the main content appears">
                    LCP {(p.metrics.lcpMs / 1000).toFixed(1)} s
                  </span>
                ) : (
                  p.loadMs !== null && <span>{(p.loadMs / 1000).toFixed(1)} s</span>
                )}
                {p.metrics && <span>{(p.metrics.bytes / 1_000_000).toFixed(1)} MB</span>}
                <span>{plural(issues, "issue")}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Agents({ run }: { run: Run }) {
  const stats = [...(run.result!.agentStats ?? [])].sort((a, b) => b.findings - a.findings);
  return (
    <div className="card table-card">
      <table className="table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Findings</th>
            <th>Time</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.id}>
              <td>
                <div className="strong">{s.name}</div>
                <code className="muted small">{s.id}</code>
              </td>
              <td>{s.findings}</td>
              <td>{(s.ms / 1000).toFixed(1)} s</td>
              <td>{s.errors ? <span className="bad">{plural(s.errors, "error")}</span> : <span className="ok">Done</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
