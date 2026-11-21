import { useState, type ReactNode } from "react";
import type { Fix } from "../../src/fixes.ts";
import type { IssueStatus, ProductType, Severity } from "../../src/types.ts";
import { scoreTone, STATUS_LABEL } from "./lib.ts";

const ICON_PATHS: Record<ProductType | "issues" | "owner" | "control" | "projects" | "new" | "logout" | "upload" | "live" | "checklist", string> = {
  checklist: "M9 6h11M9 12h11M9 18h11M4 5.5l1.2 1.2L7.5 4.5M4 11.5l1.2 1.2 2.3-2.2M4.5 18h2",
  live: "M4.5 6.5h15A1.5 1.5 0 0 1 21 8v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V8a1.5 1.5 0 0 1 1.5-1.5ZM10 10v5l4.5-2.5L10 10ZM8 3.5l4 3 4-3",
  website:
    "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9m0-18c-2.5 2.6-3.8 5.6-3.8 9s1.3 6.4 3.8 9M3.5 9h17M3.5 15h17",
  ecommerce: "M3 4h2l2.4 11.2a1.5 1.5 0 0 0 1.5 1.2h8.7a1.5 1.5 0 0 0 1.4-1.1L21 8H6.2M10 20.5h.01M17 20.5h.01",
  webapp: "M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5v-13ZM3 9h18M6.5 6.5h.01M9 6.5h.01",
  saas: "M7 18.5a4.5 4.5 0 1 1 .8-8.9 6 6 0 0 1 11.4 2.4A3.3 3.3 0 0 1 18.5 18.5H7Z",
  crm: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.3M15.5 4.6a3.5 3.5 0 0 1 0 6.8",
  api: "M8 4H6.5A1.5 1.5 0 0 0 5 5.5v4L3 12l2 2.5v4A1.5 1.5 0 0 0 6.5 20H8M16 4h1.5A1.5 1.5 0 0 1 19 5.5v4l2 2.5-2 2.5v4a1.5 1.5 0 0 1-1.5 1.5H16",
  code: "m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14",
  android: "M7 3.5h10A1.5 1.5 0 0 1 18.5 5v14a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5ZM11 17.5h2",
  ios: "M8 3.5h8A2.5 2.5 0 0 1 18.5 6v12a2.5 2.5 0 0 1-2.5 2.5H8A2.5 2.5 0 0 1 5.5 18V6A2.5 2.5 0 0 1 8 3.5ZM10.5 6h3",
  issues: "M9 5H7.5A1.5 1.5 0 0 0 6 6.5v12A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 16.5 5H15M9 5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v0a1.5 1.5 0 0 1-1.5 1.5h-3A1.5 1.5 0 0 1 9 5ZM9 12l2 2 4-4",
  owner: "M12 3 4.5 6v5.5c0 4.5 3.2 8.4 7.5 9.5 4.3-1.1 7.5-5 7.5-9.5V6L12 3Z",
  projects: "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v9a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V7Z",
  new: "M12 5v14M5 12h14",
  control: "M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4",
  upload: "M12 15.5V4M7.5 8.5 12 4l4.5 4.5M4.5 14.5v4A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5v-4",
  logout: "M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10",
};

export function Icon({ name, size = 20 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

export function ScoreChip({ score, status }: { score?: number; status?: string }) {
  const text = status === "failed" ? "!" : status === "queued" || status === "running" ? "…" : (score ?? "–");
  return <span className={`score-chip ${scoreTone(score)}`}>{text}</span>;
}

export const Sev = ({ s }: { s: Severity }) => <span className={`sev sev-${s}`}>{s}</span>;

export const StatusBadge = ({ s }: { s: IssueStatus }) => <span className={`status status-${s}`}>{STATUS_LABEL[s]}</span>;

export function OpenCounts({ open }: { open: Record<Severity, number> }) {
  const parts = (["critical", "high", "medium", "low"] as Severity[]).filter((s) => open[s] > 0);
  if (!parts.length) return <span className="muted">No open issues</span>;
  return (
    <span className="open-counts">
      {parts.map((s) => (
        <span key={s} className={`sev-count sev-${s}`}>
          {open[s]} {s}
        </span>
      ))}
    </span>
  );
}

export function FixBox({ fix }: { fix: Fix }) {
  const [copied, setCopied] = useState<number | null>(null);
  return (
    <div className="fix-box">
      <div className="fix-box-head">
        How to fix <span className="effort">{fix.effort === "minutes" ? "Quick fix" : fix.effort === "hours" ? "A few hours" : "Bigger job"}</span>
      </div>
      <p>{fix.steps}</p>
      {fix.code?.map((c, i) => (
        <div className="code-block" key={i}>
          <div className="code-label">
            {c.label}
            <button
              className="copy"
              onClick={() => {
                navigator.clipboard?.writeText(c.snippet).catch(() => {});
                setCopied(i);
                setTimeout(() => setCopied(null), 1500);
              }}
            >
              {copied === i ? "Copied" : "Copy"}
            </button>
          </div>
          <pre>{c.snippet}</pre>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-title">{title}</div>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span className="knob" />
    </button>
  );
}

/** Score history as a small line chart. */
export function Trend({ points }: { points: { score: number; at: string }[] }) {
  if (points.length < 2) return <div className="muted small">The score trend appears after the second test.</div>;
  const w = 320;
  const h = 80;
  const pts = points.slice(-20);
  const x = (i: number) => 8 + (i * (w - 16)) / (pts.length - 1);
  const y = (s: number) => h - 8 - ((h - 16) * s) / 100;
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");
  return (
    <svg className="trend" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Score trend, latest ${pts.at(-1)!.score}`}>
      <line x1="8" x2={w - 8} y1={y(90)} y2={y(90)} className="trend-guide" />
      <path d={d} className="trend-line" />
      {pts.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.score)} r="3" className={`trend-dot ${scoreTone(p.score)}`}>
          <title>
            {new Date(p.at).toLocaleString()}: {p.score}
          </title>
        </circle>
      ))}
    </svg>
  );
}
