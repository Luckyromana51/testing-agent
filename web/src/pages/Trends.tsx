import { useState } from "react";
import type { FlakyIssue, TrendPoint } from "../../../src/trends.ts";
import type { Category } from "../../../src/types.ts";
import { CATEGORY_LABEL } from "../lib.ts";
import { Sev } from "../ui.tsx";

const CAT_COLOR: Record<Category, string> = {
  functional: "#2563eb",
  accessibility: "#7c3aed",
  seo: "#16a34a",
  security: "#dc2626",
  performance: "#d97706",
  mobile: "#0891b2",
};

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Scores over time (overall and per area), and issues found and fixed per test. */
export function TrendsCard({ points, flaky }: { points: TrendPoint[]; flaky: FlakyIssue[] }) {
  const cats = (Object.keys(CAT_COLOR) as Category[]).filter((c) => points.some((p) => p.scores[c] !== undefined));
  const [shown, setShown] = useState<Set<string>>(new Set(["overall"]));
  const pts = points.slice(-30);
  if (pts.length < 2) {
    return (
      <div className="card">
        <p className="muted">Trends appear after the second test of this project.</p>
      </div>
    );
  }
  const W = 760;
  const H = 220;
  const L = 34;
  const R = 10;
  const T = 10;
  const B = 26;
  const x = (i: number) => L + (i * (W - L - R)) / (pts.length - 1);
  const y = (s: number) => T + ((H - T - B) * (100 - s)) / 100;
  const line = (get: (p: TrendPoint) => number | undefined) =>
    pts
      .map((p, i) => [i, get(p)] as const)
      .filter(([, v]) => v !== undefined)
      .map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v!).toFixed(1)}`)
      .join(" ");
  const maxBar = Math.max(1, ...pts.map((p) => Math.max(p.new, p.fixed)));
  const BH = 90;
  const bw = Math.max(3, Math.min(14, (W - L - R) / pts.length / 2.6));
  const toggle = (k: string) => {
    const n = new Set(shown);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    setShown(n);
  };
  const last = pts.at(-1)!;
  const first = pts[0];
  const change = last.score - first.score;
  return (
    <div className="card trends">
      <p className="trend-lead">
        Score <b>{last.score}</b> now,{" "}
        <span className={change >= 0 ? "ok" : "bad"}>
          {change >= 0 ? "up" : "down"} {Math.abs(change)} points
        </span>{" "}
        over the last {pts.length} tests ({day(first.at)} to {day(last.at)}).
      </p>
      <div className="pills">
        <button className={`pill${shown.has("overall") ? " active" : ""}`} onClick={() => toggle("overall")}>
          Overall
        </button>
        {cats.map((c) => (
          <button key={c} className={`pill${shown.has(c) ? " active" : ""}`} onClick={() => toggle(c)} style={shown.has(c) ? { background: CAT_COLOR[c], borderColor: CAT_COLOR[c] } : {}}>
            {CATEGORY_LABEL[c]}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-chart" role="img" aria-label="Scores over time">
        {[0, 50, 90, 100].map((g) => (
          <g key={g}>
            <line x1={L} x2={W - R} y1={y(g)} y2={y(g)} className={g === 90 ? "grid good" : "grid"} />
            <text x={L - 6} y={y(g) + 4} className="axis" textAnchor="end">
              {g}
            </text>
          </g>
        ))}
        {cats.filter((c) => shown.has(c)).map((c) => (
          <path key={c} d={line((p) => p.scores[c])} fill="none" stroke={CAT_COLOR[c]} strokeWidth={2} />
        ))}
        {shown.has("overall") && <path d={line((p) => p.score)} className="trend-line big" />}
        {pts.map((p, i) => (
          <g key={p.runId}>
            {shown.has("overall") && (
              <a href={`#/run/${p.runId}`}>
                <circle cx={x(i)} cy={y(p.score)} r={4} className="trend-dot-big">
                  <title>
                    {new Date(p.at).toLocaleString()}: score {p.score}, {p.new} new, {p.fixed} fixed
                  </title>
                </circle>
              </a>
            )}
            {(i === 0 || i === pts.length - 1 || i % Math.ceil(pts.length / 6) === 0) && (
              <text x={x(i)} y={H - 8} className="axis" textAnchor="middle">
                {day(p.at)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="stat-label">Issues found and fixed per test</div>
      <svg viewBox={`0 0 ${W} ${BH + 20}`} className="trend-chart" role="img" aria-label="New and fixed issues per test">
        <line x1={L} x2={W - R} y1={BH} y2={BH} className="grid" />
        {pts.map((p, i) => {
          const hn = (p.new / maxBar) * (BH - 10);
          const hf = (p.fixed / maxBar) * (BH - 10);
          return (
            <g key={p.runId}>
              <rect x={x(i) - bw - 1} y={BH - hn} width={bw} height={hn} className="bar-new">
                <title>{p.new} new or came back</title>
              </rect>
              <rect x={x(i) + 1} y={BH - hf} width={bw} height={hf} className="bar-fixed">
                <title>{p.fixed} fixed</title>
              </rect>
            </g>
          );
        })}
        <text x={L} y={BH + 16} className="axis">
          <tspan className="legend-new">■</tspan> new or came back <tspan className="legend-fixed">■</tspan> fixed
        </text>
      </svg>
      {(last.journeys || last.visualChanged !== undefined) && (
        <p className="muted small">
          Last test: {last.journeys ? `${last.journeys.passed} of ${last.journeys.total} journeys passed` : ""}
          {last.journeys && last.visualChanged !== undefined ? " · " : ""}
          {last.visualChanged !== undefined ? `${last.visualChanged} page${last.visualChanged === 1 ? "" : "s"} looked different` : ""}
          {last.seconds ? ` · took ${Math.round(last.seconds)} s` : ""}
        </p>
      )}
      <h3 className="sub-title">Flaky issues</h3>
      {flaky.length ? (
        <>
          <p className="muted small">These come and go between tests. Check them by hand before trusting a red or green result: often a slow server, a timer, or content that changes.</p>
          <table className="kv">
            <tbody>
              {flaky.map((f) => (
                <tr key={f.id}>
                  <td>
                    <a href={`#/issues/${f.id}`}>{f.key}</a> <Sev s={f.severity} />
                  </td>
                  <td>
                    {f.title}
                    <div className="muted small">
                      Came back {f.cameBack} time{f.cameBack === 1 ? "" : "s"} · found in {f.seenIn} of the last {f.checked} tests
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="muted small">None: every issue has stayed found or stayed fixed.</p>
      )}
    </div>
  );
}
