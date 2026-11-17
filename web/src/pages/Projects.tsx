import { useState } from "react";
import type { Schedule, User } from "../../../src/types.ts";
import { api, type Meta, type ProjectSummary } from "../api.ts";
import { CATEGORY_LABEL, go, hostOf, plural, timeAgo, usePoll } from "../lib.ts";
import { Empty, Icon, OpenCounts, ScoreChip, Trend } from "../ui.tsx";

const SCHEDULE_LABEL: Record<Schedule, string> = { off: "Manual", daily: "Daily re-test", weekly: "Weekly re-test" };

export function Projects({ meta }: { meta: Meta }) {
  const { data, error } = usePoll(() => api.projects(), [], 4000);
  const productName = (t: string) => meta.products.find((p) => p.type === t)?.name ?? t;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Projects</div>
          <h1>Everything you are testing</h1>
        </div>
        <a className="btn primary" href="#/">
          New test
        </a>
      </div>
      {error && <div className="error">{error}</div>}
      {data && data.length === 0 && (
        <Empty title="No projects yet">
          Start with <a href="#/">a new test</a>. Each website or app you test becomes a project with its own issue list.
        </Empty>
      )}
      <div className="project-grid">
        {data?.map((p) => (
          <ProjectCard key={p.id} p={p} productName={productName(p.type)} />
        ))}
      </div>
    </div>
  );
}

function ProjectCard({ p, productName }: { p: ProjectSummary; productName: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="card project-card" onClick={() => go(`#/project/${p.id}`)} role="link" tabIndex={0}>
      <div className="project-card-top">
        <span className={`product-icon pi-${p.type}`}>
          <Icon name={p.type} />
        </span>
        <div className="project-card-name">
          <div className="strong">{p.name}</div>
          <div className="muted small">
            {productName} · {hostOf(p.target.url)}
          </div>
        </div>
        <ScoreChip score={p.lastScore} status={p.busy ? "running" : p.lastRun?.status} />
      </div>
      <OpenCounts open={p.counts.open} />
      <div className="project-card-foot">
        <span className="muted small">
          {p.busy ? "Testing now…" : `Tested ${timeAgo(p.lastRunAt)}`} · {SCHEDULE_LABEL[p.schedule]}
        </span>
        <button
          className="btn small"
          disabled={p.busy || busy}
          onClick={async (e) => {
            e.stopPropagation();
            setBusy(true);
            try {
              const run = await api.retest(p.id);
              go(`#/run/${run.id}`);
            } catch {
              setBusy(false);
            }
          }}
        >
          Re-test
        </button>
      </div>
    </div>
  );
}

export function ProjectView({ id, meta, user }: { id: string; meta: Meta; user: User }) {
  const { data, error, reload } = usePoll(() => api.project(id), [id], 3000, (d) => d.project.busy);
  const [actionError, setActionError] = useState("");
  const [saved, setSaved] = useState(false);
  if (error) return <div className="page error big">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const { project: p, runs, trend, agents } = data;
  const product = meta.products.find((x) => x.type === p.type);

  const save = async (patch: Parameters<typeof api.updateProject>[1]) => {
    setActionError("");
    try {
      await api.updateProject(p.id, patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      reload();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  return (
    <div className="page">
      <a href="#/projects" className="back">
        ← Projects
      </a>
      <div className="page-head">
        <span className={`product-icon big pi-${p.type}`}>
          <Icon name={p.type} size={26} />
        </span>
        <div className="grow">
          <div className="eyebrow">
            {product?.name} · issue key {p.key}
          </div>
          <h1>{p.name}</h1>
          <a href={p.target.url} target="_blank" rel="noreferrer" className="muted">
            {p.target.url}
          </a>
        </div>
        <button
          className="btn primary"
          disabled={p.busy}
          onClick={async () => {
            try {
              const run = await api.retest(p.id);
              go(`#/run/${run.id}`);
            } catch (err) {
              setActionError((err as Error).message);
            }
          }}
        >
          {p.busy ? "Testing now…" : "Re-test now"}
        </button>
      </div>
      {actionError && <div className="error">{actionError}</div>}

      <div className="project-top">
        <div className="card stat-card">
          <div className="stat-label">Latest score</div>
          <div className="stat-row">
            <ScoreChip score={p.lastScore} status={p.lastRun?.status} />
            <Trend points={trend} />
          </div>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Open issues</div>
          <OpenCounts open={p.counts.open} />
          <div className="muted small">
            {p.counts.byStatus.verified} verified fixed · {p.counts.byStatus.reopened} came back ·{" "}
            {p.counts.byStatus.fixed} waiting for re-test
          </div>
          <a href={`#/issues?project=${p.id}`} className="small">
            Open the issue board →
          </a>
        </div>
        <div className="card stat-card">
          <div className="stat-label">Settings {saved && <span className="saved">Saved</span>}</div>
          <label className="inline-field">
            <span>Re-test</span>
            <select className="input" value={p.schedule} onChange={(e) => save({ schedule: e.target.value as Schedule })}>
              <option value="off">Only when I ask</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
            </select>
          </label>
          <label className="inline-field">
            <span>Pages</span>
            <input
              className="input"
              type="number"
              min={1}
              max={200}
              defaultValue={p.target.maxPages ?? meta.defaultMaxPages}
              onBlur={(e) => Number(e.target.value) !== p.target.maxPages && save({ maxPages: Number(e.target.value) })}
            />
          </label>
          <label className="check dark small">
            <input
              type="checkbox"
              checked={p.target.checkLinks !== false}
              onChange={(e) => save({ checkLinks: e.target.checked })}
            />{" "}
            Check every link
          </label>
        </div>
      </div>

      <h2 className="section-title">Test runs</h2>
      <div className="card table-card">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Started by</th>
              <th>Score</th>
              <th>Pages</th>
              <th>Compared with the test before</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} onClick={() => go(`#/run/${r.id}`)} className="clickable">
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td className="muted">{r.trigger === "schedule" ? "Schedule" : r.trigger === "retest" ? "Re-test" : "Manual"}</td>
                <td>
                  <ScoreChip score={r.overallScore} status={r.status} />
                </td>
                <td>{r.pageCount ?? (r.status === "failed" ? "Failed" : r.lastProgress)}</td>
                <td>
                  {r.diff ? (
                    <span className="diff">
                      {r.diff.new > 0 && <span className="diff-new">{r.diff.new} new</span>}
                      {r.diff.fixed > 0 && <span className="diff-fixed">{r.diff.fixed} fixed</span>}
                      {r.diff.reopened > 0 && <span className="diff-reopened">{r.diff.reopened} came back</span>}
                      <span className="muted">{plural(r.diff.open, "open issue")}</span>
                    </span>
                  ) : (
                    <span className="muted">–</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="section-title">{agents.length} agents test this project</h2>
      <div className="agent-chips">
        {agents.map((a) => (
          <div className="agent-chip" key={a.id} title={a.description}>
            <span className={`cat-dot cat-${a.category}`} />
            {a.name}
            <span className="muted"> · {CATEGORY_LABEL[a.category]}</span>
          </div>
        ))}
      </div>

      {user.role === "owner" && (
        <div className="danger-zone">
          <button
            className="btn ghost danger"
            onClick={async () => {
              if (!window.confirm(`Delete ${p.name} with all its test runs and issues?`)) return;
              try {
                await api.deleteProject(p.id);
                go("#/projects");
              } catch (err) {
                setActionError((err as Error).message);
              }
            }}
          >
            Delete project
          </button>
        </div>
      )}
    </div>
  );
}
