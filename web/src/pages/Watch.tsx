import { useState } from "react";
import type { WatchConfig } from "../../../src/types.ts";
import type { WatchSummary } from "../../../src/watch.ts";
import { api } from "../api.ts";
import { timeAgo } from "../lib.ts";
import { Toggle } from "../ui.tsx";

const pct = (n: number | null) => (n === null ? "–" : `${n}%`);
const tone = (n: number | null) => (n === null ? "" : n >= 99.9 ? "ok" : n >= 99 ? "warn" : "bad");

/** Uptime and SSL watch: settings, uptime, response times, certificate and outages. */
export function WatchCard({
  projectId,
  config,
  summary,
  onSave,
  onChanged,
}: {
  projectId: string;
  config?: WatchConfig;
  summary: WatchSummary;
  onSave: (w: WatchConfig) => Promise<void>;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<WatchConfig>(config ?? { on: false, everyMin: 5, sslWarnDays: 21 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const changed = JSON.stringify(draft) !== JSON.stringify(config ?? { on: false, everyMin: 5, sslWarnDays: 21 });
  const s = summary;
  const W = 760;
  const H = 110;
  const pts = s.recent;
  const max = Math.max(200, ...pts.map((c) => c.ms));
  const x = (i: number) => (pts.length < 2 ? W / 2 : 8 + (i * (W - 16)) / (pts.length - 1));
  const y = (ms: number) => H - 14 - ((H - 24) * ms) / max;
  const ssl = s.ssl;
  return (
    <div className="card watch">
      <div className="row watch-head">
        <div className="grow">
          <div className="strong">
            {s.down ? <span className="bad">● Down now</span> : s.last ? (s.last.ok ? <span className="ok">● Up</span> : <span className="warn">● Last check failed</span>) : <span className="muted">● Not checked yet</span>}
            {s.last && <span className="muted small"> · checked {timeAgo(s.last.at)}{s.last.status ? `, HTTP ${s.last.status}` : ""}, {s.last.ms} ms</span>}
          </div>
          {s.last?.error && <div className="bad small">{s.last.error}</div>}
        </div>
        <Toggle on={draft.on} label="Watch this site" onChange={(on) => setDraft({ ...draft, on })} />
        <span className="small">{draft.on ? "Watching" : "Off"}</span>
      </div>
      <div className="watch-tiles">
        {(
          [
            ["Last 24 hours", s.uptime.day],
            ["Last 7 days", s.uptime.week],
            ["Last 30 days", s.uptime.month],
          ] as const
        ).map(([label, v]) => (
          <div className="watch-tile" key={label}>
            <div className={`watch-num ${tone(v)}`}>{pct(v)}</div>
            <div className="muted small">uptime, {label.toLowerCase()}</div>
          </div>
        ))}
        <div className="watch-tile">
          <div className="watch-num">{s.avgMs === null ? "–" : `${s.avgMs} ms`}</div>
          <div className="muted small">average answer, 24 hours</div>
        </div>
        <div className="watch-tile">
          <div className={`watch-num ${ssl && !ssl.error ? (ssl.daysLeft <= (draft.sslWarnDays ?? 21) ? "bad" : "ok") : ""}`}>
            {ssl ? (ssl.error ? "Error" : `${ssl.daysLeft} days`) : "–"}
          </div>
          <div className="muted small">{ssl ? (ssl.error ? ssl.error : `SSL certificate left${ssl.issuer ? `, ${ssl.issuer}` : ""}`) : "SSL certificate (https only)"}</div>
        </div>
      </div>
      {pts.length > 1 && (
        <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart" role="img" aria-label="Response time over the last 24 hours">
          <line x1={8} x2={W - 8} y1={H - 14} y2={H - 14} className="grid" />
          <path d={pts.map((c, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(c.ms).toFixed(1)}`).join(" ")} className="trend-line" />
          {pts.map((c, i) => !c.ok && <rect key={i} x={x(i) - 2} y={8} width={4} height={H - 22} className="down-mark"><title>{new Date(c.at).toLocaleString()}: {c.error}</title></rect>)}
          <text x={8} y={H - 2} className="axis">
            Response time, last 24 hours (max {max} ms). Red: failed checks.
          </text>
        </svg>
      )}
      <div className="watch-form">
        <label className="inline-field">
          <span>Check every</span>
          <select className="input" value={draft.everyMin} onChange={(e) => setDraft({ ...draft, everyMin: Number(e.target.value) })}>
            <option value={1}>1 minute</option>
            <option value={5}>5 minutes</option>
            <option value={15}>15 minutes</option>
            <option value={60}>hour</option>
          </select>
        </label>
        <label className="inline-field">
          <span>Page must show</span>
          <input className="input" placeholder="optional, like Add to cart" value={draft.expectText ?? ""} onChange={(e) => setDraft({ ...draft, expectText: e.target.value })} />
        </label>
        <label className="inline-field">
          <span>Warn before SSL ends</span>
          <input className="input" type="number" min={1} max={90} value={draft.sslWarnDays ?? 21} onChange={(e) => setDraft({ ...draft, sslWarnDays: Number(e.target.value) })} />
          <span className="muted small">days</span>
        </label>
        <label className="inline-field wide">
          <span>Alert webhook</span>
          <input className="input" placeholder="optional: your Slack, Teams or Google Chat webhook (https)" value={draft.webhook ?? ""} onChange={(e) => setDraft({ ...draft, webhook: e.target.value })} />
        </label>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row">
        {changed && (
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onSave(draft);
              } finally {
                setBusy(false);
              }
            }}
          >
            Save watch settings
          </button>
        )}
        <button
          className="btn ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await api.watchCheck(projectId);
              onChanged();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Check now
        </button>
        <span className="muted small grow">Checks run from this server. Two failed checks in a row count as down; alerts show in the dashboard{draft.webhook ? " and go to the webhook" : ""}.</span>
      </div>
      <h3 className="sub-title">Outages</h3>
      {s.incidents.length ? (
        <table className="kv">
          <tbody>
            {s.incidents.map((i) => (
              <tr key={i.id}>
                <td>{new Date(i.startedAt).toLocaleString()}</td>
                <td>
                  {i.endedAt ? `Down for ${Math.max(1, Math.round((new Date(i.endedAt).getTime() - new Date(i.startedAt).getTime()) / 60000))} min` : <b className="bad">Still down</b>} · {i.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No outages recorded.</p>
      )}
    </div>
  );
}
