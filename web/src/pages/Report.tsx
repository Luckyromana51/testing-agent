import { AppReport } from "./AppReport.tsx";
import { ApiReport } from "./ApiReport.tsx";
import { ChangesTab, SeoTab } from "./ReportExtras.tsx";
import { useMemo, useState } from "react";
import { fixFor } from "../../../src/fixes.ts";
import { groupFindings, type IssueGroup } from "../../../src/group.ts";
import type { Category, Finding, PageResult, Run, Severity } from "../../../src/types.ts";
import { api } from "../api.ts";
import { CATEGORY_LABEL, go, isMajor, pathOf, plural, scoreTone, SEVERITIES, usePoll } from "../lib.ts";
import { FixBox, Sev } from "../ui.tsx";
import { LiveView } from "./LiveView.tsx";
import { RunCode } from "./LiveCode.tsx";
import { Inspect, VisualCompare } from "./Inspect.tsx";
import { wcagReport, type CriterionStatus } from "../../../src/wcag.ts";

/** Products tested in a browser, which can be watched live. */
const BROWSER_PRODUCTS = new Set(["website", "webapp", "saas", "crm", "ecommerce"]);

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

/** "45 s" or "3 min" between two times. */
function duration(from: string, to: string): string {
  const s = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/** Rules whose evidence is a link target, so each item is listed as "link (status) on page". */
const LINK_RULES = new Set(["broken-link", "broken-external-link", "unverified-external-link"]);

export function Report({ id }: { id: string }) {
  const { data: run, error: loadError, reload } = usePoll(
    () => api.run(id),
    [id],
    1500,
    (r) => r.status === "queued" || r.status === "running",
  );
  const [actionError, setError] = useState("");
  const [tab, setTab] = useState<"summary" | "issues" | "pages" | "api" | "app" | "journeys" | "visual" | "wcag" | "cookies" | "changes" | "seo" | "agents" | "tools">("summary");
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
          {run.startedAt ? (
            <>
              Tested {new Date(run.startedAt).toLocaleString()}
              {run.finishedAt && ` · took ${duration(run.startedAt, run.finishedAt)}`}
            </>
          ) : (
            `Queued ${new Date(run.createdAt).toLocaleString()}`
          )}
          {run.result && unitOf(run).one !== "file" && ` · ${plural(run.result.pages.length, unitOf(run).one)} tested`}
          {run.agents && ` · ${run.agents.length} agents`}
          {run.tools && run.tools.length > 0 && ` · ${plural(run.tools.length, "tool")}`}
        </div>
      </div>
      <div className="header-actions">
        {(run.status === "running" || run.status === "queued") && (
          <button
            className="btn ghost danger"
            onClick={async () => {
              await api.cancelRun(run.id).catch((e: Error) => setError(e.message));
            }}
          >
            Cancel test
          </button>
        )}
        {run.result && (
          <details className="download-menu">
            <summary className="btn ghost">Download</summary>
            <div className="download-list">
              <a href={`/api/runs/${run.id}/report.pdf`} download>
                <strong>PDF report</strong>
                <span className="muted small">For the client: scores, major issues with fixes, WCAG table, cookies</span>
              </a>
              <a href={`/api/runs/${run.id}/report.html`} target="_blank" rel="noreferrer">
                <strong>Printable page</strong>
                <span className="muted small">The same report as a web page, to read or print</span>
              </a>
              <a href={`/api/runs/${run.id}/report.sarif`} download>
                <strong>SARIF</strong>
                <span className="muted small">For GitHub code scanning, GitLab, Azure DevOps and security dashboards</span>
              </a>
              <a href={`/api/runs/${run.id}/report.junit.xml`} download>
                <strong>JUnit XML</strong>
                <span className="muted small">For CI test reports: Jenkins, GitLab, GitHub Actions</span>
              </a>
            </div>
          </details>
        )}
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

  if (run.status === "running" && BROWSER_PRODUCTS.has(run.product ?? "website")) {
    return (
      <div className="page run wide">
        {header}
        <LiveView runId={run.id} progress={run.progress} />
      </div>
    );
  }

  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="page run">
        {header}
        <div className="progress-card">
          <div className="spinner" />
          <div>
            <div className="progress-title">{run.status === "queued" ? "Waiting to start: other tests are running" : "Testing in progress"}</div>
            <ul className="progress-log">
              {run.progress.slice(-8).map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
        {run.status === "running" && <RunCode runId={run.id} api={run.product === "api"} />}
      </div>
    );
  }

  if (run.status === "failed" || !run.result) {
    return (
      <div className="page run">
        {header}
        {run.status === "cancelled" ? (
          <div className="card not-tested-card">
            <div className="not-tested-title">Cancelled</div>
            <p>{run.error}</p>
          </div>
        ) : run.error?.startsWith("Could not test") ? (
          <div className="card not-tested-card">
            <div className="not-tested-title">Not tested</div>
            <p>{run.error}</p>
            <p className="muted small">
              Nothing was scored and no issues were changed, because the agents could not look at it. Fix what is
              described above, then press Re-test.
            </p>
          </div>
        ) : (
          <div className="error big">The test failed: {run.error}</div>
        )}
      </div>
    );
  }

  const { result } = run;
  const groups = groupFindings(result.findings);
  const major = groups.filter((g) => isMajor(g.severity));
  const unit = unitOf(run);
  const notTested = result.notTested ?? {};
  const categories = (Object.keys(CATEGORY_LABEL) as Category[]).filter((c) => result.scores[c] !== undefined || c in notTested);
  const untestedIn = (c: Category) => (result.agentStats ?? []).filter((s) => s.category === c && s.untested).length;
  return (
    <div className="page run">
      {header}

      {run.diff && (
        <div className="diff-banner">
          <span className="diff-label">Compared with the last test</span>
          <span className="diff-new">{run.diff.new - (run.diff.firstChecked ?? 0)} new</span>
          {(run.diff.firstChecked ?? 0) > 0 && (
            <span className="muted" title="Found by a check that could not run or finish in the test before, so they are new to the board, not new on the site">
              {run.diff.firstChecked} checked for the first time
            </span>
          )}
          <span className="diff-fixed">{run.diff.fixed} fixed and verified</span>
          <span className="diff-reopened">{run.diff.reopened} came back</span>
          <a href={`#/issues?project=${run.projectId}`}>{plural(run.diff.open, "open issue")} on the board →</a>
        </div>
      )}

      {result.incomplete && result.incomplete.length > 0 && (
        <section className="card incomplete-card">
          <div className="incomplete-title">Incomplete test: {plural(result.incomplete.length, "check")} could not run</div>
          <ul>
            {result.incomplete.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          <div className="muted small">
            These are not counted as passed, and issues they found before stay open until a test can check them again.
          </div>
        </section>
      )}

      <section className="scores">
        <div className={`overall ${scoreTone(result.overallScore)}`}>
          <div className="overall-num">{result.overallScore}</div>
          <div className="overall-label">{result.incomplete?.length ? "Overall score (incomplete)" : "Overall score"}</div>
        </div>
        <div className="score-grid">
          {categories.map((c) => {
            const n = groups.filter((g) => g.first.category === c && g.severity !== "info").length;
            const score = result.scores[c];
            if (score === undefined) {
              return (
                <div className="score-card not-tested" key={c} title={notTested[c]}>
                  <div className="score-card-top">
                    <span>{CATEGORY_LABEL[c]}</span>
                    <span className="score-num">–</span>
                  </div>
                  <div className="bar" />
                  <div className="score-card-sub">Not tested</div>
                </div>
              );
            }
            const missing = untestedIn(c);
            return (
              <div className="score-card" key={c}>
                <div className="score-card-top">
                  <span>{CATEGORY_LABEL[c]}</span>
                  <span className={`score-num ${scoreTone(score)}`}>{score}</span>
                </div>
                <div className="bar">
                  <div className={`bar-fill ${scoreTone(score)}`} style={{ width: `${score}%` }} />
                </div>
                <div className="score-card-sub">
                  {n === 0 ? "No issues" : plural(n, "issue")}
                  {missing > 0 && <span className="partial"> · {plural(missing, "check")} not tested</span>}
                </div>
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

      <div className="tabs sticky-tabs">
        <button className={tab === "summary" ? "active" : ""} onClick={() => setTab("summary")}>
          Fix first {major.length > 0 && <span className="tab-count bad">{major.length}</span>}
        </button>
        <button className={tab === "issues" ? "active" : ""} onClick={() => setTab("issues")}>
          All issues ({groups.length})
        </button>
        {result.api && (
          <button className={tab === "api" ? "active" : ""} onClick={() => setTab("api")}>
            API ({result.api.calls.length} calls)
          </button>
        )}
        {result.pages.length > 0 && !result.api && (
          <button className={tab === "pages" ? "active" : ""} onClick={() => setTab("pages")}>
            {unit.tab} ({result.pages.length})
          </button>
        )}
        {(result.screens?.length || result.access || result.calls?.length) && (
          <button className={tab === "app" ? "active" : ""} onClick={() => setTab("app")}>
            Signed-in app ({result.screens?.length ?? 0} screens)
          </button>
        )}
        {result.journeys && result.journeys.length > 0 && (
          <button className={tab === "journeys" ? "active" : ""} onClick={() => setTab("journeys")}>
            Journeys ({result.journeys.filter((j) => j.ok).length}/{result.journeys.length} pass)
          </button>
        )}
        {result.pages.some((p) => p.visual) && (
          <button className={tab === "visual" ? "active" : ""} onClick={() => setTab("visual")}>
            Visual ({result.pages.filter((p) => p.visual?.desktop?.status === "changed" || p.visual?.phone?.status === "changed").length} changed)
          </button>
        )}
        {result.pages.length > 0 && isUrl(result.pages[0].url) && result.scores.accessibility !== undefined && (
          <button className={tab === "wcag" ? "active" : ""} onClick={() => setTab("wcag")}>
            WCAG 2.2
          </button>
        )}
        {result.cookies && result.cookies.length > 0 && (
          <button className={tab === "cookies" ? "active" : ""} onClick={() => setTab("cookies")}>
            Cookies ({result.cookies.length})
          </button>
        )}
        {(result.changes || (result.forms && result.forms.length > 0)) && (
          <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
            Checks that change data {result.changes?.leftOver.length ? <span className="tab-count bad">{result.changes.leftOver.length} left</span> : null}
          </button>
        )}
        {(result.seo || result.rum) && (
          <button className={tab === "seo" ? "active" : ""} onClick={() => setTab("seo")}>
            {result.seo ? "SEO" : "Real visitors"}
            {result.seo && result.rum ? " and visitors" : ""}
          </button>
        )}
        {result.agentStats && (
          <button className={tab === "agents" ? "active" : ""} onClick={() => setTab("agents")}>
            Agents ({result.agentStats.filter((s) => !s.id.startsWith("tool.")).length})
          </button>
        )}
        {result.tools && result.tools.length > 0 && (
          <button className={tab === "tools" ? "active" : ""} onClick={() => setTab("tools")}>
            Tools ({result.tools.length})
          </button>
        )}
      </div>
      {tab === "summary" && (
        <>
          <section className="major">
            <h2 className="section-title">
              {major.length ? `${plural(major.length, "major issue")} to fix first` : "No major issues"}
            </h2>
            {major.length === 0 && (
              <div className="card good-card">Nothing critical or high was found. The other issues are in All issues, and are polish.</div>
            )}
            {major.map((g) => (
              <MajorCard key={g.key} g={g} unit={unit.many} />
            ))}
            {groups.length > major.length && (
              <button className="btn ghost see-all" onClick={() => setTab("issues")}>
                See all {groups.length} issues →
              </button>
            )}
          </section>
          <AiPanel run={run} />
        </>
      )}
      {tab === "issues" && <IssueList groups={groups} categories={categories} unit={unit.many} />}
      {tab === "pages" && <Pages run={run} onRunChange={reload} />}
      {tab === "api" && <ApiReport run={run} onRunChange={reload} />}
      {tab === "app" && <AppReport result={result} />}
      {tab === "journeys" && <Journeys run={run} />}
      {tab === "visual" && <VisualTab run={run} onRunChange={reload} />}
      {tab === "wcag" && <WcagTab run={run} />}
      {tab === "cookies" && <CookiesTab run={run} />}
      {tab === "changes" && <ChangesTab run={run} />}
      {tab === "seo" && <SeoTab result={result} />}
      {tab === "agents" && <Agents run={run} />}
      {tab === "tools" && <Tools run={run} />}
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
            · {f.agent.startsWith("tool.") ? "found by " : "agent "}
            <code>{f.agent.startsWith("tool.") ? f.agent.slice(5) : f.agent}</code>
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

function AiPanel({ run: initial }: { run: Run }) {
  const [run, setRun] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!run.ai) {
    const write = async () => {
      setBusy(true);
      setError("");
      try {
        setRun(await api.summarise(run.id));
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <section className="ai-panel off">
        <div className="ai-head">Claude summary</div>
        <p className="muted">{error || run.aiError || "No summary for this test."}</p>
        <button className="btn small" onClick={write} disabled={busy}>
          {busy ? "Claude is writing the summary…" : "Write summary"}
        </button>
      </section>
    );
  }
  return (
    <section className="ai-panel">
      <div className="ai-head">
        Claude summary <span className="model">{run.ai.model}</span>
        {run.ai.reusedFrom ? (
          <span className="ai-cost" title="This test found the same issues as an earlier one, so its summary was reused.">
            Same issues as the test of {new Date(run.ai.reusedFrom.at).toLocaleDateString()}: summary reused, no credits used
          </span>
        ) : (
          run.ai.tokens && (
            <span className="ai-cost">{(run.ai.tokens.input + run.ai.tokens.output).toLocaleString("en-IN")} tokens</span>
          )
        )}
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

function Pages({ run, onRunChange }: { run: Run; onRunChange: () => void }) {
  const pages = run.result!.pages;
  const [inspect, setInspect] = useState<number | null>(null);
  return (
    <div className="pages">
      {inspect !== null && <Inspect run={run} index={inspect} onClose={() => setInspect(null)} onRunChange={onRunChange} />}
      {pages.map((p, pi) => {
        const issues = groupFindings(run.result!.findings.filter((f) => f.pageUrl === p.url && f.severity !== "info")).length;
        return (
          <div className="page-card" key={p.url}>
            <div className="shots">
              {p.screenshot && <img className="shot" src={api.artifact(run.id, p.screenshot)} alt={`Desktop view of ${p.url}`} />}
              {p.tabletScreenshot && <img className="shot tablet" src={api.artifact(run.id, p.tabletScreenshot)} alt={`Tablet view of ${p.url}`} />}
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
                <VisualBadge p={p} />
              </div>
              {(p.inspect || p.visual) && (
                <div className="row">
                  <button className="btn small" onClick={() => setInspect(pi)}>
                    Inspect page
                  </button>
                  {p.inspect && (
                    <a className="btn ghost small" href={api.artifact(run.id, p.inspect.har)} download>
                      HAR
                    </a>
                  )}
                </div>
              )}
              {p.files && p.files.length > 0 && (
                <div className="page-files">
                  {p.files.map((f) => (
                    <a key={f.file} href={api.artifact(run.id, f.file)} target="_blank" rel="noreferrer">
                      {f.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VisualBadge({ p }: { p: PageResult }) {
  const v = [p.visual?.desktop, p.visual?.phone].filter(Boolean);
  if (!v.length) return null;
  const changed = v.filter((x) => x!.status === "changed");
  if (changed.length) return <span className="bad">Looks different ({Math.max(...changed.map((x) => x!.changed ?? 0))}%)</span>;
  if (v.every((x) => x!.status === "new")) return <span className="muted">First picture saved</span>;
  return <span className="ok">Looks the same</span>;
}

const shortPath = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

/** Each journey with a picture after every step, like a test runner's command log. */
function Journeys({ run }: { run: Run }) {
  const list = run.result!.journeys ?? [];
  const [open, setOpen] = useState<string | null>(list.find((j) => !j.ok)?.id ?? list[0]?.id ?? null);
  const [big, setBig] = useState<string | null>(null);
  return (
    <div className="journeys">
      {big && (
        <div className="inspect-backdrop" onClick={() => setBig(null)}>
          <img className="big-shot" src={api.artifact(run.id, big)} alt="Picture after the step" />
        </div>
      )}
      {list.map((j) => (
        <div className={`card journey${j.ok ? "" : " failed"}`} key={j.id}>
          <button className="journey-head" onClick={() => setOpen(open === j.id ? null : j.id)} aria-expanded={open === j.id}>
            <span className={j.ok ? "ok strong" : "bad strong"}>{j.ok ? "✓ Passed" : "✗ Failed"}</span>
            <span className="strong grow">{j.name}</span>
            <span className="muted small">
              {j.role ? `as ${j.role} · ` : ""}
              {j.steps.filter((s) => s.ok).length} of {j.total} steps · {(j.ms / 1000).toFixed(1)} s{j.allowWrites ? " · may send forms" : " · read-only"}
            </span>
          </button>
          {open === j.id && (
            <ol className="journey-steps">
              {j.steps.map((s, i) => (
                <li key={i} className={s.ok ? "" : "bad"}>
                  {s.shot && (
                    <button className="thumb" onClick={() => setBig(s.shot!)} aria-label={`Picture after step ${i + 1}`}>
                      <img src={api.artifact(run.id, s.shot)} alt="" />
                    </button>
                  )}
                  <div className="grow">
                    {s.cleanup && <span className="badge">clean-up</span>} <code>{s.text}</code> <span className="muted small">{(s.ms / 1000).toFixed(1)} s</span>
                    {s.error && <div className="bad small">{s.error}</div>}
                    {s.calls && s.calls.length > 0 && (
                      <details className="step-calls">
                        <summary className="small">
                          {s.calls.length} app call{s.calls.length === 1 ? "" : "s"}
                          {s.calls.some((c) => c.status >= 400 || c.status === 0) ? <span className="bad"> · {s.calls.filter((c) => c.status >= 400 || c.status === 0).length} failed</span> : ""}
                        </summary>
                        <table className="kv small">
                          <tbody>
                            {s.calls.map((c, k) => (
                              <tr key={k}>
                                <td className={c.status >= 400 || c.status === 0 ? "bad" : ""}>{c.status || "failed"}</td>
                                <td className="mono">
                                  {c.method} {shortPath(c.url)}
                                </td>
                                <td className="muted">{c.ms} ms</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </details>
                    )}
                    {s.blocked && <div className="muted small">Stopped (could change data): {s.blocked.join(", ")}</div>}
                    {s.url && <div className="muted small">{s.url}</div>}
                  </div>
                </li>
              ))}
              {j.steps.length < j.total && <li className="muted">{j.total - j.steps.length} more steps not run</li>}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

/** Pages whose picture changed first, each with the compare view. */
function VisualTab({ run, onRunChange }: { run: Run; onRunChange: () => void }) {
  const pages = run.result!.pages.map((p, i) => ({ p, i })).filter(({ p }) => p.visual);
  const changed = (x: (typeof pages)[number]) => x.p.visual?.desktop?.status === "changed" || x.p.visual?.phone?.status === "changed";
  const sorted = [...pages.filter(changed), ...pages.filter((x) => !changed(x))];
  const [open, setOpen] = useState<number | null>(sorted.find(changed)?.i ?? null);
  return (
    <div className="journeys">
      {sorted.map(({ p, i }) => (
        <div className="card journey" key={p.url}>
          <button className="journey-head" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
            <span className="strong grow">{p.title || p.url}</span>
            <VisualBadge p={p} />
          </button>
          {open === i && <VisualCompare run={run} index={i} onRunChange={onRunChange} />}
        </div>
      ))}
    </div>
  );
}

const WCAG_TEXT: Record<CriterionStatus, string> = { fails: "Fails", passes: "No problems found", manual: "Check by hand", "not-tested": "Not tested" };

/** WCAG 2.2 A and AA, criterion by criterion, like a VPAT / accessibility conformance report. */
function WcagTab({ run }: { run: Run }) {
  const report = useMemo(() => wcagReport(run.result!), [run.result]);
  const [show, setShow] = useState<CriterionStatus | "all">("all");
  const [level, setLevel] = useState<"A" | "AA" | "all">("all");
  const rows = report.results.filter((r) => (show === "all" || r.status === show) && (level === "all" || r.level === level));
  return (
    <div>
      <div className="wcag-summary">
        {(["fails", "passes", "manual", "not-tested"] as CriterionStatus[]).map((s) => (
          <button key={s} className={`card wcag-tile st-${s}${show === s ? " active" : ""}`} onClick={() => setShow(show === s ? "all" : s)}>
            <b>{report.counts[s]}</b>
            <span>{WCAG_TEXT[s]}</span>
          </button>
        ))}
      </div>
      <p className="muted small">
        WCAG 2.2 level A and AA ({report.results.length} criteria). Automatic checks find about a third to a half of accessibility problems; the
        criteria marked "Check by hand" need a person with a keyboard and a screen reader. The PDF report includes this table.
      </p>
      <div className="pills">
        {(["all", "A", "AA"] as const).map((l) => (
          <button key={l} className={`pill${level === l ? " active" : ""}`} onClick={() => setLevel(l)}>
            {l === "all" ? "A and AA" : `Level ${l}`}
          </button>
        ))}
      </div>
      <div className="card table-card">
        <table className="table wcag-table">
          <thead>
            <tr>
              <th>Criterion</th>
              <th>Level</th>
              <th>Result</th>
              <th>Problems found</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`https://www.w3.org/WAI/WCAG22/Understanding/${c.id}`} target="_blank" rel="noreferrer">
                    {c.id}
                  </a>{" "}
                  {c.name}
                </td>
                <td>{c.level}</td>
                <td className={`st-${c.status}`}>{WCAG_TEXT[c.status]}</td>
                <td className="small">
                  {c.problems.join(" · ")}
                  {c.pages > 0 && <span className="muted"> ({plural(c.pages, "page")})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Every cookie the site set (never the values), with its security flags. */
function CookiesTab({ run }: { run: Run }) {
  const list = run.result!.cookies ?? [];
  const third = list.filter((c) => !c.firstParty).length;
  return (
    <div>
      <p className="muted">
        {plural(list.length, "cookie")} set during the test, {third} by other websites. Values are never stored. Session and login cookies should be
        Secure and HttpOnly; cookies from other sites usually need consent first (GDPR, India's DPDP Act).
      </p>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Set by</th>
              <th>Secure</th>
              <th>HttpOnly</th>
              <th>SameSite</th>
              <th>Ends</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={`${c.domain}|${c.path}|${c.name}`}>
                <td>
                  <code>{c.name}</code>
                </td>
                <td>
                  {c.domain} {!c.firstParty && <span className="tag muted">other site</span>}
                </td>
                <td className={c.secure ? "ok" : "bad"}>{c.secure ? "Yes" : "No"}</td>
                <td className={c.httpOnly ? "ok" : /sess|auth|token|sid|jwt/i.test(c.name) ? "bad" : "muted"}>{c.httpOnly ? "Yes" : "No"}</td>
                <td>{c.sameSite}</td>
                <td className="small">{c.expires ? new Date(c.expires).toLocaleDateString() : "When the browser closes"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Agents({ run }: { run: Run }) {
  const rank = (s: { untested?: string; skipped?: string }) => (s.untested ? 0 : s.skipped ? 2 : 1);
  const stats = [...(run.result!.agentStats ?? [])].filter((s) => !s.id.startsWith("tool.")).sort((a, b) => rank(a) - rank(b) || b.findings - a.findings);
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
              <td>
                {s.untested ? (
                  <span className="bad" title={s.untested}>
                    Not tested: {s.untested}
                  </span>
                ) : s.skipped ? (
                  <span className="muted">Skipped: {s.skipped}</span>
                ) : s.errors ? (
                  <span className="bad">{plural(s.errors, "error")}</span>
                ) : (
                  <span className="ok">Done</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What each outside tool did: its scores or summary, findings, and its own report to open. */
function Tools({ run }: { run: Run }) {
  const tools = run.result!.tools ?? [];
  return (
    <div className="tool-results">
      {tools.map((t) => (
        <div className={`card tool-result ${t.status}`} key={t.id}>
          <div className="tool-head">
            <div className="grow">
              <div className="tool-name">{t.name}</div>
              <div className="muted small">
                {t.tested ?? (t.status === "untested" ? "Could not run" : "")} · {(t.ms / 1000).toFixed(1)} s
              </div>
            </div>
            {t.status === "done" ? (
              <span className={t.findings === 0 && !t.merged ? "ok" : "muted"}>
                {t.findings ? plural(t.findings, "new finding") : t.merged ? "Nothing new" : "No problems"}
              </span>
            ) : (
              <span className="bad">Not tested</span>
            )}
          </div>
          {t.untested && <div className="tool-missing">{t.untested}</div>}
          {t.summary && t.summary.length > 0 && (
            <ul className="tool-summary">
              {t.summary.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
          {t.table && t.table.rows.length > 0 && (
            <div className="tool-table-wrap">
              <div className="stat-label">{t.table.title}</div>
              <table className="table tool-table">
                <thead>
                  <tr>
                    {t.table.columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.table.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {t.permit && (
            <div className="permit-note ok small">
              Ran with the written permission of <strong>{t.permit.grantedBy}</strong> ({t.permit.reference}) for {t.permit.hosts.join(", ")}, valid until{" "}
              {new Date(t.permit.until).toLocaleDateString()}, recorded by {t.permit.recordedBy}.
            </div>
          )}
          {t.merged ? (
            <div className="muted small">
              {plural(t.merged, "problem")} {t.merged === 1 ? "was" : "were"} already found by the platform's own checks, so {t.merged === 1 ? "it is" : "they are"} shown once.
            </div>
          ) : null}
          {t.images && t.images.length > 0 && (
            <div className="tool-images">
              {t.images.map((im) => (
                <a key={im.file} href={api.artifact(run.id, im.file)} target="_blank" rel="noreferrer" className="tool-image">
                  <img src={api.artifact(run.id, im.file)} alt={im.label} loading="lazy" />
                  <span className="muted small">{im.label}</span>
                </a>
              ))}
            </div>
          )}
          {t.reports && t.reports.length > 0 && (
            <div className="tool-reports">
              {t.reports.map((r) => (
                <a key={r.file} href={`/api/runs/${run.id}/artifacts/${r.file}`} target="_blank" rel="noreferrer" className="btn ghost small">
                  {r.label} ↗
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
