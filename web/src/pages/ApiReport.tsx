import { Fragment, useState } from "react";
import type { ApiCallView, Run } from "../../../src/types.ts";
import { api } from "../api.ts";

/*
 * The report's API tab: every call with its request and answer (and Copy as cURL), what was not
 * called and why, the scenarios, the changes since the approved API file, who can read what, and
 * the API file audit. Like the request panes of Postman and Insomnia, and the diff of oasdiff.
 */

type Part = "endpoints" | "scenarios" | "changes" | "access" | "writes" | "contract";

const SOURCE: Record<string, string> = { openapi: "API file", found: "API file (found)", postman: "Postman collection", har: "HAR recording", curl: "cURL commands", graphql: "GraphQL schema", soap: "SOAP WSDL", grpc: "gRPC services", websocket: "WebSocket messages", pact: "Pact contract" };
const PROTOCOL: Record<string, string> = { soap: "SOAP service", grpc: "gRPC", websocket: "WebSocket" };

const tone = (s: number | null) => (s === null || s >= 500 ? "bad" : s >= 400 ? "warn" : "ok");

/** The call as a cURL command; the login stays out (it shows as [hidden] and is left off). */
export function curlFor(c: ApiCallView): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${c.method} ${q(c.url)}`];
  for (const [k, v] of Object.entries(c.requestHeaders).sort(([a], [b]) => a.localeCompare(b))) {
    parts.push(v === "[hidden]" ? `-H ${q(`${k}: $TOKEN`)}` : `-H ${q(`${k}: ${v}`)}`);
  }
  if (c.requestBody) parts.push(`--data ${q(c.requestBody)}`);
  return parts.join(" \\\n  ");
}

const pretty = (body: string) => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function Headers({ h }: { h: Record<string, string> }) {
  const rows = Object.entries(h).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return <div className="muted small">None</div>;
  return (
    <table className="kv small">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="mono">{k}</td>
            <td className="mono">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CallDetail({ c }: { c: ApiCallView }) {
  const curl = curlFor(c);
  return (
    <div className="api-call-detail">
      {c.error && <div className="error">{c.error}</div>}
      {c.problems?.length ? (
        <div className="api-problems">
          <div className="stat-label">Differs from the API file</div>
          <ul>
            {c.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.extra?.length ? (
        <div className="small muted">
          Fields the file does not list: <span className="mono">{c.extra.join(", ")}</span>
        </div>
      ) : null}
      {c.idFrom && <div className="small muted">The id in the address came from {c.idFrom}.</div>}
      {c.guessed?.length ? <div className="small warn">Guessed values in the address: {c.guessed.join(", ")}. Add an example to the API file for a real test.</div> : null}
      <div className="api-panes">
        <div>
          <div className="stat-label">Request</div>
          <Headers h={c.requestHeaders} />
          {c.requestBody && (
            <div className="code-block">
              <div className="code-label">
                Body <Copy text={c.requestBody} />
              </div>
              <pre>{pretty(c.requestBody)}</pre>
            </div>
          )}
          <div className="code-block">
            <div className="code-label">
              cURL <Copy text={curl} />
            </div>
            <pre>{curl}</pre>
          </div>
        </div>
        <div>
          <div className="stat-label">
            Answer {c.status ?? "none"} · {c.contentType || "no type"} · {c.bytes ? `${Math.max(1, Math.round(c.bytes / 1024))} KB` : "empty"}
          </div>
          <Headers h={c.responseHeaders} />
          {c.body && (
            <div className="code-block">
              <div className="code-label">
                Body (first 8 KB) <Copy text={c.body} />
              </div>
              <pre>{pretty(c.body)}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function ApiReport({ run, onRunChange }: { run: Run; onRunChange: () => void }) {
  const report = run.result!.api!;
  const [part, setPart] = useState<Part>("endpoints");
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cov = report.coverage;
  const scenarios = report.scenarios ?? [];
  const changes = report.changes;
  const breaking = changes?.list.filter((c) => c.kind === "breaking").length ?? 0;
  const calls = report.calls.filter((c) => !filter || `${c.method} ${c.path}`.toLowerCase().includes(filter.toLowerCase()));

  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      await api.approveApiFile(run.id);
      onRunChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-report api-report">
      <div className="api-stats">
        <div className="card">
          <div className="stat-label">Endpoints called</div>
          <div className="strong">
            {cov.called} of {cov.documented}
          </div>
          <div className="muted small">{cov.passed} answered as the file says</div>
        </div>
        {report.audit && (
          <div className="card">
            <div className="stat-label">API file audit</div>
            <div className={`strong ${report.audit.score >= 80 ? "ok" : report.audit.score >= 50 ? "warn" : "bad"}`}>{report.audit.score}/100</div>
            <div className="muted small">
              {report.audit.failed} of {report.audit.rules} rules broken (in All issues)
            </div>
          </div>
        )}
        {report.graphql && (
          <div className="card">
            <div className="stat-label">GraphQL</div>
            <div className="strong">{report.graphql.queries} queries</div>
            <div className="muted small">
              {report.graphql.mutations} changes (never sent) · {report.graphql.types} types · schema {report.graphql.introspection ? "open" : "closed"}
            </div>
          </div>
        )}
        <div className="card">
          <div className="stat-label">Where the endpoints came from</div>
          <div className="strong">{SOURCE[report.source] ?? report.source}</div>
          {report.foundAt && <div className="muted small mono">{report.foundAt}</div>}
        </div>
        {report.protocol && (
          <div className="card">
            <div className="stat-label">{PROTOCOL[report.protocol.kind]}</div>
            <div className="strong">{report.protocol.service}</div>
            <div className="muted small">
              {report.protocol.operations} {report.protocol.kind === "websocket" ? "messages" : "operations"} · {report.protocol.called} calls made
              {report.protocol.notCalled ? ` · ${report.protocol.notCalled} not called (they change data)` : ""}
              {report.protocol.detail ? ` · ${report.protocol.detail}` : ""}
            </div>
          </div>
        )}
        {report.contract && (
          <div className="card">
            <div className="stat-label">Contract ({report.contract.consumer} → {report.contract.provider})</div>
            {(() => {
              const sent = report.contract.interactions.filter((x) => !x.skipped);
              const ok = sent.filter((x) => x.ok).length;
              return <div className={`strong ${ok === sent.length ? "ok" : "bad"}`}>{ok} of {sent.length} kept</div>;
            })()}
            <div className="muted small">Pact {report.contract.spec} · details in Contract</div>
          </div>
        )}
        {!["graphql", "soap", "grpc", "websocket"].includes(report.source) && (
          <div className="card">
            <div className="stat-label">Postman</div>
            <a className="btn small" href={api.postmanUrl(run.id)}>
              Download collection
            </a>
            <div className="muted small">The tested calls with status checks. The token is a variable, never saved.</div>
          </div>
        )}
      </div>

      <div className="pills">
        <button className={`pill${part === "endpoints" ? " active" : ""}`} onClick={() => setPart("endpoints")}>
          Endpoints ({report.calls.length})
        </button>
        {scenarios.length > 0 && (
          <button className={`pill${part === "scenarios" ? " active" : ""}`} onClick={() => setPart("scenarios")}>
            Scenarios ({scenarios.filter((s) => s.ok).length}/{scenarios.length} pass)
          </button>
        )}
        {(changes || report.baselineSaved) && (
          <button className={`pill${part === "changes" ? " active" : ""}`} onClick={() => setPart("changes")}>
            Changes {changes ? `(${breaking} breaking)` : ""}
          </button>
        )}
        {report.access && (
          <button className={`pill${part === "access" ? " active" : ""}`} onClick={() => setPart("access")}>
            Who can read what ({report.access.accounts.length} accounts)
          </button>
        )}
        {report.writes && (
          <button className={`pill${part === "writes" ? " active" : ""}`} onClick={() => setPart("writes")}>
            Write tests
          </button>
        )}
        {report.contract && (
          <button className={`pill${part === "contract" ? " active" : ""}`} onClick={() => setPart("contract")}>
            Contract ({report.contract.interactions.filter((x) => !x.skipped && !x.ok).length} broken)
          </button>
        )}
      </div>

      {part === "endpoints" && (
        <div className="card table-card">
          <div className="pad api-filter">
            <input placeholder="Filter, e.g. GET /users" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <span className="muted small">Times are the median of the calls made (95% time in brackets). Click a row for the request and answer.</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Answer</th>
                <th>Time</th>
                <th>Fits the file</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => {
                const key = `${c.method} ${c.path} ${c.step ?? ""} ${i}`;
                const isOpen = open === key;
                return (
                  <Fragment key={key}>
                    <tr className="api-row" onClick={() => setOpen(isOpen ? null : key)} aria-expanded={isOpen}>
                      <td className="mono small">
                        <span className="badge">{c.method}</span> {c.path}
                        {c.step && <span className="tag muted">{c.step}</span>}
                        {c.deprecated && <span className="tag muted">deprecated</span>}
                      </td>
                      <td className={tone(c.status)}>{c.status ?? "none"}</td>
                      <td className={c.ms >= 3000 ? "bad" : c.ms >= 1000 ? "warn" : ""}>
                        {c.ms} ms{c.p95 !== undefined && c.samples && c.samples > 1 ? <span className="muted"> ({c.p95})</span> : null}
                      </td>
                      <td className={c.problems?.length ? "bad" : "ok"}>{c.problems?.length ? `${c.problems.length} difference${c.problems.length === 1 ? "" : "s"}` : "Yes"}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={4}>
                          <CallDetail c={c} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {cov.skipped.length > 0 && (
            <details className="pad">
              <summary>Not called ({cov.skipped.length})</summary>
              <ul className="small">
                {cov.skipped.map((s) => (
                  <li key={`${s.method} ${s.path}`}>
                    <span className="mono">
                      {s.method} {s.path}
                    </span>
                    : {s.why}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {part === "scenarios" && (
        <div className="api-scenarios">
          {scenarios.map((s) => (
            <div key={s.id} className="card">
              <div className="row between">
                <strong>{s.name}</strong>
                <span className={s.ok ? "ok" : "bad"}>
                  {s.ok ? "Pass" : "Fail"} · {s.ms} ms
                </span>
              </div>
              {s.error && <div className="error small">{s.error}</div>}
              {s.blocked?.length ? (
                <div className="warn small">Not sent, because the project is not a test server: {s.blocked.join(", ")}</div>
              ) : null}
              <ol className="scenario-steps">
                {s.steps.map((st) => (
                  <li key={`${st.line}-${st.cleanup ? "c" : ""}`} className={st.ok ? "" : "bad"}>
                    <span className="mono small">
                      {st.cleanup ? "clean-up · " : ""}Line {st.line}: {st.text}
                    </span>
                    {st.call && (
                      <span className={`small ${tone(st.call.status)}`}>
                        {" "}
                        → {st.call.status ?? "none"} in {st.call.ms} ms
                      </span>
                    )}
                    {st.error && <div className="error small">{st.error}</div>}
                    {st.checks?.map((ch) => (
                      <div key={ch.line} className={`small ${ch.ok ? "ok" : "bad"}`}>
                        {ch.ok ? "✓" : "✗"} {ch.text}
                        {!ch.ok && ch.actual !== undefined && <span className="muted"> (got {ch.actual})</span>}
                      </div>
                    ))}
                    {st.call && (
                      <details className="step-calls">
                        <summary>Request and answer</summary>
                        <CallDetail c={st.call} />
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <p className="muted small">Add or change scenarios on the project page, in the API tab.</p>
        </div>
      )}

      {part === "changes" && (
        <div className="card">
          {!changes && report.baselineSaved && <p>This was the first test, so its API file is now the approved version. The next test lists what changed since.</p>}
          {changes && (
            <>
              <p className="muted small">
                Compared with the API file approved {new Date(changes.since).toLocaleString()}. Breaking changes stop existing apps working: an
                endpoint or field removed, a field made required, a type changed.
              </p>
              {changes.list.length === 0 && <p className="ok">No changes.</p>}
              {changes.list.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Where</th>
                      <th>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.list.map((c) => (
                      <tr key={`${c.kind}${c.where}${c.text}`}>
                        <td className={c.kind === "breaking" ? "bad" : "muted"}>{c.kind === "breaking" ? "Breaking" : "Safe"}</td>
                        <td className="mono small">{c.where}</td>
                        <td>{c.text}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="row api-approve">
                {changes.approvedAt ? (
                  <span className="ok">Approved as the new version {new Date(changes.approvedAt).toLocaleString()}.</span>
                ) : (
                  changes.list.length > 0 && (
                    <button className="btn primary" disabled={busy} onClick={approve}>
                      {busy ? "Approving…" : "Approve as the new version"}
                    </button>
                  )
                )}
                {error && <span className="error">{error}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {part === "access" && report.access && (
        <div className="card table-card">
          <p className="muted small pad">
            Each account called every endpoint the main login could read. Red cells are the ones to fix: another company getting the same
            record, an account opening what it must not, or data with no login.
          </p>
          <div className="grid-scroll">
            <table className="table access-grid">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  {report.access.accounts.map((a) => (
                    <th key={a}>{a}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.access.rows.map((row) => (
                  <tr key={`${row.method} ${row.path}`}>
                    <td className="mono small">
                      <span className="badge">{row.method}</span> {row.path}
                    </td>
                    {report.access!.accounts.map((a) => {
                      const c = row.cells[a];
                      if (!c) return <td key={a} className="cell-muted">–</td>;
                      const t = c.bad ? "bad" : c.status !== null && c.status < 300 ? "ok" : "muted";
                      return (
                        <td key={a} className={`cell-${t}`} title={c.bad ?? (c.same ? "Same record as the main login" : "")}>
                          {c.status ?? "none"}
                          {c.same ? " same" : ""}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {part === "writes" && report.writes && (
        <div className="card">
          {!report.writes.ran ? (
            <p className="muted">{report.writes.why ?? "Write tests did not run."}</p>
          ) : (
            <>
              <p>
                Made {report.writes.created} test records and removed {report.writes.cleanedUp}. The calls are in Endpoints, marked with their step.
              </p>
              {report.writes.leftOver.length > 0 && (
                <div className="warn">
                  Left on the test server (remove by hand):
                  <ul className="mono small">
                    {report.writes.leftOver.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {part === "contract" && report.contract && (
        <div className="card table-card">
          <p className="pad muted small">
            What {report.contract.consumer} expects from {report.contract.provider}, from its Pact file. Each request was sent and the answer checked with the
            file's matching rules. Extra fields in the answer are fine.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Interaction</th>
                <th>Request</th>
                <th>Answer</th>
                <th>Kept</th>
              </tr>
            </thead>
            <tbody>
              {report.contract.interactions.map((x, i) => (
                <tr key={`${x.description}${i}`}>
                  <td>
                    {x.description}
                    {x.state && <div className="muted small">Provider state: {x.state}</div>}
                  </td>
                  <td className="mono small">
                    <span className="badge">{x.method}</span> {x.path}
                  </td>
                  <td className={x.skipped ? "muted" : tone(x.status ?? null)}>{x.skipped ? "not sent" : (x.status ?? "none")}</td>
                  <td className={x.skipped ? "muted small" : x.ok ? "ok" : "bad"}>
                    {x.skipped ? x.skipped : x.ok ? "Yes" : (
                      <ul className="small mono">
                        {x.problems.map((p) => (
                          <li key={p}>{p}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
