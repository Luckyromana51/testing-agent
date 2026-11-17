import { useMemo, useState } from "react";
import { fixFor } from "../../../src/fixes.ts";
import type { IssueStatus, Severity } from "../../../src/types.ts";
import { api, type IssueSummary } from "../api.ts";
import { CATEGORY_LABEL, go, isMajor, pathOf, SEVERITIES, STATUS_LABEL, timeAgo, usePoll } from "../lib.ts";
import { Empty, FixBox, Sev, StatusBadge } from "../ui.tsx";

const COLUMNS: { title: string; statuses: IssueStatus[]; hint: string }[] = [
  { title: "Open", statuses: ["reopened", "open"], hint: "New problems, and ones that came back" },
  { title: "In progress", statuses: ["in_progress"], hint: "Someone is working on it" },
  { title: "Fixed", statuses: ["fixed"], hint: "Waiting for a re-test to confirm" },
  { title: "Verified", statuses: ["verified"], hint: "A re-test confirmed the fix" },
];

const sevRank = (s: Severity) => SEVERITIES.indexOf(s);

export function Issues({ projectId, openId }: { projectId?: string; openId?: string }) {
  const { data, error, reload } = usePoll(() => api.issues(), [], 5000);
  const projects = usePoll(() => api.projects(), [], 30000).data;
  const [majorOnly, setMajorOnly] = useState(false);
  const [showWontFix, setShowWontFix] = useState(false);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);

  const filtered = useMemo(
    () =>
      (data ?? [])
        .filter((i) => !projectId || i.projectId === projectId)
        .filter((i) => !majorOnly || isMajor(i.severity))
        .filter((i) => !search || `${i.key} ${i.title}`.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.updatedAt.localeCompare(a.updatedAt)),
    [data, projectId, majorOnly, search],
  );

  const setProject = (id: string) => go(id ? `#/issues?project=${id}` : "#/issues");
  const open = (id: string | null) =>
    go(`#/issues${id ? `/${id}` : ""}${projectId ? `?project=${projectId}` : ""}`);

  return (
    <div className="page wide">
      <div className="page-head">
        <div>
          <div className="eyebrow">Issue board</div>
          <h1>Issues</h1>
          <p className="muted">
            Every distinct problem the agents found, tracked across tests. A re-test moves fixed issues to Verified, and
            moves them back to Open if they return.
          </p>
        </div>
      </div>
      <div className="filters">
        <div className="pills">
          <select className="input select" value={projectId ?? ""} onChange={(e) => setProject(e.target.value)}>
            <option value="">All projects</option>
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className={`pill ${majorOnly ? "active" : ""}`} onClick={() => setMajorOnly(!majorOnly)}>
            Major only
          </button>
          <button className={`pill ${showWontFix ? "active" : ""}`} onClick={() => setShowWontFix(!showWontFix)}>
            Won't fix
          </button>
        </div>
        <input
          className="input search"
          placeholder="Search issues"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && <div className="error">{error}</div>}
      {data && data.length === 0 && (
        <Empty title="No issues yet">Issues appear here after the first test of a project.</Empty>
      )}
      <div className="board">
        {[...COLUMNS, ...(showWontFix ? [{ title: "Won't fix", statuses: ["wont_fix" as IssueStatus], hint: "Accepted as is" }] : [])].map(
          (col) => {
            const items = filtered.filter((i) => col.statuses.includes(i.status));
            // Long columns show the worst 12 first; the rest are one click away.
            const limit = expanded.includes(col.title) ? 500 : 12;
            const shown = items.slice(0, limit);
            return (
              <div className="column" key={col.title}>
                <div className="column-head">
                  <span>{col.title}</span>
                  <span className="count">{items.length}</span>
                </div>
                <div className="muted small column-hint">{col.hint}</div>
                {shown.map((i) => (
                  <IssueCard key={i.id} i={i} onOpen={() => open(i.id)} showProject={!projectId} />
                ))}
                {items.length > shown.length && (
                  <button className="btn small" onClick={() => setExpanded([...expanded, col.title])}>
                    Show {items.length - shown.length} more
                  </button>
                )}
              </div>
            );
          },
        )}
      </div>
      {openId && <IssueDrawer id={openId} onClose={() => open(null)} onChanged={reload} />}
    </div>
  );
}

function IssueCard({ i, onOpen, showProject }: { i: IssueSummary; onOpen: () => void; showProject: boolean }) {
  return (
    <button className={`issue-card sev-border-${i.severity}`} onClick={onOpen}>
      <div className="issue-card-top">
        <span className="issue-key">{i.key}</span>
        <Sev s={i.severity} />
      </div>
      <div className="issue-title">{i.title}</div>
      <div className="muted small">
        {i.status === "reopened" && <span className="came-back">Came back · </span>}
        {showProject && `${i.projectName} · `}
        {CATEGORY_LABEL[i.category]} · {i.occurrences.length > 1 ? `${i.occurrences.length} places` : pathOf(i.occurrences[0]?.pageUrl ?? "")}
        {i.assignee && ` · ${i.assignee}`}
      </div>
    </button>
  );
}

function IssueDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: issue, error, setData } = usePoll(() => api.issue(id), [id], 0, () => false);
  const [comment, setComment] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");

  const update = async (patch: Parameters<typeof api.updateIssue>[1]) => {
    setBusy(true);
    setActionError("");
    try {
      setData(await api.updateIssue(id, patch));
      onChanged();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Issue details">
        <button className="drawer-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        {error && <div className="error">{error}</div>}
        {!issue ? (
          <div className="loading">Loading…</div>
        ) : (
          <>
            <div className="eyebrow">
              {issue.key} · {issue.projectName}
            </div>
            <h2 className="drawer-title">{issue.title}</h2>
            <div className="drawer-badges">
              <Sev s={issue.severity} />
              <StatusBadge s={issue.status} />
              <span className="muted small">
                {CATEGORY_LABEL[issue.category]} · first seen {timeAgo(issue.firstSeenAt)} · last seen {timeAgo(issue.lastSeenAt)}
              </span>
            </div>

            <div className="status-actions">
              {(["open", "in_progress", "fixed", "wont_fix"] as IssueStatus[]).map((s) => (
                <button
                  key={s}
                  className={`btn small ${issue.status === s ? "primary" : ""}`}
                  disabled={busy || issue.status === s}
                  onClick={() => update({ status: s })}
                >
                  {s === "fixed" ? "Mark fixed" : s === "wont_fix" ? "Won't fix" : STATUS_LABEL[s]}
                </button>
              ))}
              <button
                className="btn small"
                disabled={busy}
                onClick={async () => {
                  try {
                    const run = await api.retest(issue.projectId);
                    go(`#/run/${run.id}`);
                  } catch (err) {
                    setActionError((err as Error).message);
                  }
                }}
              >
                Re-test now
              </button>
            </div>
            {issue.status === "fixed" && (
              <div className="note">Run a re-test to confirm the fix. If the problem is gone it moves to Verified.</div>
            )}
            {actionError && <div className="error">{actionError}</div>}

            <label className="inline-field">
              <span>Assigned to</span>
              <input
                className="input"
                placeholder="Name of the developer"
                value={assignee ?? issue.assignee ?? ""}
                onChange={(e) => setAssignee(e.target.value)}
                onBlur={() => assignee !== null && assignee !== (issue.assignee ?? "") && update({ assignee })}
              />
            </label>

            <p>{issue.detail}</p>
            <FixBox fix={fixFor(issue)} />

            <h3 className="drawer-sub">Where ({issue.occurrences.length})</h3>
            <ul className="finding-pages">
              {issue.occurrences.slice(0, 20).map((o, n) => (
                <li key={n}>
                  <a href={o.pageUrl} target="_blank" rel="noreferrer">
                    {o.pageUrl}
                  </a>
                  {o.evidence && <code className="muted small"> {o.evidence.slice(0, 140)}</code>}
                </li>
              ))}
            </ul>

            <h3 className="drawer-sub">History</h3>
            <ol className="timeline">
              {[...issue.history].reverse().map((h, n) => (
                <li key={n} className={`tl-${h.type}`}>
                  <div>
                    {h.text}
                    {h.runId && (
                      <>
                        {" "}
                        <a href={`#/run/${h.runId}`}>(report)</a>
                      </>
                    )}
                  </div>
                  <div className="muted small">
                    {h.by ? `${h.by} · ` : ""}
                    {new Date(h.at).toLocaleString()}
                  </div>
                </li>
              ))}
            </ol>
            <form
              className="comment-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (comment.trim()) update({ comment }).then(() => setComment(""));
              }}
            >
              <textarea
                className="input"
                rows={2}
                placeholder="Add a note for the team"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
              <button className="btn small" disabled={busy || !comment.trim()}>
                Add note
              </button>
            </form>
          </>
        )}
      </aside>
    </div>
  );
}
