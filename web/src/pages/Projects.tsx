import { useState } from "react";
import type { ToolChoice } from "../../../src/tools/types.ts";
import type { Schedule, User } from "../../../src/types.ts";
import { api, type Meta, type ProjectDetail, type ProjectSummary } from "../api.ts";
import { go, plural, targetHref, targetLabel, timeAgo, usePoll } from "../lib.ts";
import { FilePicker } from "./Home.tsx";
import { loginKind, ProjectLogin } from "./LoginFields.tsx";
import { PermissionCard } from "./Permission.tsx";
import { JourneysEditor } from "./Journeys.tsx";
import { AppSetup } from "./AppSetup.tsx";
import { ApiSetup } from "./ApiSetup.tsx";
import { FixRepoCard, GrowthTab } from "./WebExtras.tsx";

const PUBLIC_TYPES = ["website", "ecommerce", "webapp", "saas"];
import { TrendsCard } from "./Trends.tsx";
import { WatchCard } from "./Watch.tsx";
import { ToolTabs, toolChoices, toolDraft, type ToolDraft } from "./ToolTabs.tsx";
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
            {productName} · {targetLabel(p.target)}
          </div>
        </div>
        <ScoreChip score={p.lastScore} status={p.busy ? (p.waiting ? "queued" : "running") : p.lastRun?.status} />
      </div>
      <OpenCounts open={p.counts.open} />
      <div className="project-card-foot">
        <span className="muted small">
          {p.busy ? (p.waiting ? "Waiting to start…" : "Testing now…") : `Tested ${timeAgo(p.lastRunAt)}`} · {SCHEDULE_LABEL[p.schedule]}
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

type ProjectTab = "overview" | "app" | "api" | "growth" | "fixes" | "trends" | "watch" | "journeys" | "tests";

export function ProjectView({ id, meta, user }: { id: string; meta: Meta; user: User }) {
  const { data, error, reload } = usePoll(() => api.project(id), [id], 3000, (d) => d.project.busy);
  const [actionError, setActionError] = useState("");
  const [saved, setSaved] = useState(false);
  const [allRuns, setAllRuns] = useState(false);
  const [tab, setTabState] = useState<ProjectTab>(() => {
    try {
      return (localStorage.getItem("glv.projectTab") as ProjectTab) || "overview";
    } catch {
      return "overview";
    }
  });
  const setTab = (t: ProjectTab) => {
    setTabState(t);
    try {
      localStorage.setItem("glv.projectTab", t);
    } catch {
      // Private window: the tab is just not remembered.
    }
  };
  if (error) return <div className="page error big">{error}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const { project: p, runs, trend, agents, trends, flaky, watch } = data;
  const product = meta.products.find((x) => x.type === p.type);
  const isWeb = ["website", "ecommerce", "webapp", "saas", "crm"].includes(p.type);

  const journeysOn = isWeb && meta.modules.some((m) => m.id === "journeys" && m.on);
  const hasPermissionTools = meta.tools.some((t) => t.safety === "permission" && t.products.includes(p.type));
  const isApp = ["webapp", "saas", "crm"].includes(p.type);
  const tabs: [ProjectTab, string, string?][] = [
    ["overview", "Overview"],
    ...(isApp ? ([["app", "Signed-in app", p.roles?.length ? `${p.roles.length + 1} accounts` : undefined]] as [ProjectTab, string, string?][]) : []),
    ...(p.type === "api" ? ([["api", "API setup", p.apiScenarios?.length ? `${p.apiScenarios.length} scenario${p.apiScenarios.length === 1 ? "" : "s"}` : undefined]] as [ProjectTab, string, string?][]) : []),
    ...(isWeb ? ([["growth", PUBLIC_TYPES.includes(p.type) ? "Visitors and SEO" : "Real visitors", p.rumSnippet ? "on" : undefined]] as [ProjectTab, string, string?][]) : []),
    ...(isWeb || p.type === "code" ? ([["fixes", "Claude fixes", p.fixPrs?.length ? String(p.fixPrs.length) : undefined]] as [ProjectTab, string, string?][]) : []),
    ["trends", "Trends", flaky.length ? `${flaky.length} flaky` : undefined],
    ...(watch && (p.target.url || p.type === "api") ? ([["watch", p.type === "api" ? "API watch" : "Uptime and SSL", watch.down ? "down" : p.watch?.on ? "on" : undefined]] as [ProjectTab, string, string?][]) : []),
    ...(journeysOn ? ([["journeys", "User journeys", String(p.journeys?.length ?? 0)]] as [ProjectTab, string, string?][]) : []),
    ["tests", "What runs"],
  ];
  const current = tabs.some(([t]) => t === tab) ? tab : "overview";

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
          {targetHref(p.target) ? (
            <a href={targetHref(p.target)} target="_blank" rel="noreferrer" className="muted">
              {targetLabel(p.target)}
            </a>
          ) : (
            <span className="muted">{targetLabel(p.target)}</span>
          )}
        </div>
        {p.busy && !p.waiting && p.lastRun && (
          <a className="btn live-btn" href={`#/run/${p.lastRun.id}`}>
            ● Watch live
          </a>
        )}
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
          {p.busy ? (p.waiting ? "Waiting to start…" : "Testing now…") : "Re-test now"}
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
          {isWeb ? (
            <>
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
            </>
          ) : (
            p.target.file && (
              <FilePicker
                accept={p.type === "android" ? ".apk" : p.type === "ios" ? ".ipa,.zip" : p.type === "code" ? ".zip" : ".json,.yaml,.yml"}
                label={p.type === "android" || p.type === "ios" ? "New build to test" : "Replace the file"}
                hint="then press Re-test"
                value={{ file: p.target.file, fileName: p.target.fileName ?? p.target.file, size: 0 }}
                onChange={(u) => u && save({ file: u.file, fileName: u.fileName })}
              />
            )
          )}
        </div>
      </div>

      <div className="tabs sticky-tabs project-tabs">
        {tabs.map(([t, label, count]) => (
          <button key={t} className={current === t ? "active" : ""} onClick={() => setTab(t)}>
            {label}
            {count && <span className={`tab-count ${count === "down" ? "bad" : ""}`}>{count}</span>}
          </button>
        ))}
      </div>

      {current === "trends" && <TrendsCard points={trends} flaky={flaky} />}

      {current === "app" && isApp && <AppSetup project={p} onChanged={reload} meta={meta} />}

      {current === "api" && p.type === "api" && <ApiSetup project={p} onChanged={reload} />}

      {current === "growth" && isWeb && <GrowthTab project={p} onChanged={reload} />}

      {current === "fixes" && (
        <>
          <h2 className="section-title">Where Claude opens fix pull requests</h2>
          <FixRepoCard project={p} onChanged={reload} />
          {(p.fixPrs?.length ?? 0) > 0 && (
            <>
              <h2 className="section-title">Pull requests Claude opened</h2>
              <div className="card table-card">
                <table className="table">
                  <tbody>
                    {p.fixPrs!.map((x) => (
                      <tr key={x.id}>
                        <td className="mono small">{x.issue}</td>
                        <td>{x.title}</td>
                        <td>{x.status === "opened" && x.url ? <a href={x.url} target="_blank" rel="noreferrer">Open the pull request</a> : <span className="bad small">{x.error ?? "Failed"}</span>}</td>
                        <td className="muted small">{timeAgo(x.at)} · {x.by}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {current === "watch" && watch && (
        <WatchCard key={JSON.stringify(p.watch ?? null)} api={p.type === "api"} hasJourneys={(p.type === "api" ? Boolean(p.apiScenarios?.some((x) => !x.off)) : Boolean(p.journeys?.some((j) => !j.off && !j.allowWrites))) && meta.modules.some((m) => m.id === "journey-watch" && m.on)} projectId={p.id} config={p.watch} summary={watch} onSave={(w) => save({ watch: w })} onChanged={reload} />
      )}

      {current === "overview" && (
      <>
      {loginKind(p.type) && <ProjectLogin projectId={p.id} kind={loginKind(p.type)!} saved={p.login} onSaved={reload} />}

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
            {(allRuns ? runs : runs.slice(0, 20)).map((r) => (
              <tr key={r.id} onClick={() => go(`#/run/${r.id}`)} className="clickable">
                <td>{new Date(r.startedAt ?? r.createdAt).toLocaleString()}</td>
                <td className="muted">{r.trigger === "schedule" ? "Schedule" : r.trigger === "retest" ? "Re-test" : "Manual"}</td>
                <td>
                  <ScoreChip score={r.overallScore} status={r.status} />
                </td>
                <td>{r.pageCount ?? (r.status === "failed" ? "Failed" : r.status === "cancelled" ? "Cancelled" : r.lastProgress)}</td>
                <td>
                  {r.diff ? (
                    <span className="diff">
                      {r.diff.new - (r.diff.firstChecked ?? 0) > 0 && <span className="diff-new">{r.diff.new - (r.diff.firstChecked ?? 0)} new</span>}
                      {(r.diff.firstChecked ?? 0) > 0 && (
                        <span className="muted" title="Found by a check that could not run or finish in the test before">
                          {r.diff.firstChecked} checked for the first time
                        </span>
                      )}
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
        {runs.length > 20 && (
          <button className="btn ghost show-more" onClick={() => setAllRuns((a) => !a)}>
            {allRuns ? "Show the latest 20" : `Show all ${runs.length} test runs`}
          </button>
        )}
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
      </>
      )}

      {current === "tests" && (
        <>
          <ProjectTools key={JSON.stringify(p.tools ?? null)} meta={meta} project={p} agents={agents} onSave={(tools) => save({ tools })} />
          {hasPermissionTools && (
            <>
              <h2 className="section-title">Load and attack tests</h2>
              <PermissionCard project={p} isOwner={user.role === "owner"} onChanged={reload} />
            </>
          )}
        </>
      )}

      {current === "journeys" && journeysOn && (
        <JourneysEditor key={JSON.stringify(p.journeys ?? [])} journeys={p.journeys ?? []} roles={p.roles ?? []} signedIn={Boolean(p.login)} onSave={(journeys) => save({ journeys })} />
      )}
    </div>
  );
}

/** The tool tabs for a saved project: changes apply from the next test. */
function ProjectTools({
  meta,
  project,
  agents,
  onSave,
}: {
  meta: Meta;
  project: ProjectSummary;
  agents: ProjectDetail["agents"];
  onSave: (tools: ToolChoice[]) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ToolDraft>(() => toolDraft(meta, project.type, project.tools));
  const [busy, setBusy] = useState(false);
  const before = JSON.stringify(toolChoices(meta, toolDraft(meta, project.type, project.tools)));
  const changed = JSON.stringify(toolChoices(meta, draft)) !== before;
  return (
    <div className="card form">
      <ToolTabs meta={meta} type={project.type} agents={agents} draft={draft} onChange={setDraft} permissions={project.permissions ?? []} />
      {changed && (
        <div className="form-actions">
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(toolChoices(meta, draft));
              setBusy(false);
            }}
          >
            {busy ? "Saving…" : "Save tools for the next tests"}
          </button>
          <button className="btn ghost" onClick={() => setDraft(toolDraft(meta, project.type, project.tools))}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}
