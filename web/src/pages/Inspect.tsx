import { useEffect, useMemo, useState } from "react";
import type { InspectData, InspectRequest } from "../../../src/runner/inspect.ts";
import type { PageResult, Run, VisualResult } from "../../../src/types.ts";
import { api } from "../api.ts";

/**
 * The inspect screen for one tested page, laid out like the browser's developer tools and
 * Playwright's trace viewer: steps, network waterfall, console, the page's HTML, the keyboard's
 * tab order and the outline drawn over the picture, unused code, and the visual compare.
 */
type Tab = "steps" | "network" | "console" | "elements" | "layout" | "coverage" | "visual";

const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${Math.round(n / 1000)} kB` : `${n} B`);
const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`);
const shortName = (url: string) => {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return (last ?? u.host) + u.search.slice(0, 30);
  } catch {
    return url.slice(0, 60);
  }
};

export function Inspect({ run, index, onClose, onRunChange }: { run: Run; index: number; onClose: () => void; onRunChange?: (r: Run) => void }) {
  const page = run.result!.pages[index];
  const [data, setData] = useState<InspectData | null>(null);
  const [error, setError] = useState("");
  const hasVisual = Boolean(page.visual?.desktop || page.visual?.phone);
  const [tab, setTab] = useState<Tab>(page.inspect ? "steps" : "visual");

  useEffect(() => {
    if (!page.inspect) return;
    let live = true;
    fetch(api.artifact(run.id, page.inspect.file))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Could not load the recording (${r.status})`))))
      .then((d) => live && setData(d as InspectData))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [run.id, page.inspect]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const tabs: [Tab, string][] = [];
  if (page.inspect) {
    tabs.push(["steps", `Steps${data ? ` (${data.steps.length})` : ""}`]);
    tabs.push(["network", `Network${data ? ` (${data.network.length})` : ""}`]);
    const errs = data?.console.filter((c) => c.type === "error" || c.type === "exception").length ?? 0;
    tabs.push(["console", `Console${data ? ` (${data.console.length}${errs ? `, ${errs} errors` : ""})` : ""}`]);
    tabs.push(["elements", "Elements"]);
    tabs.push(["layout", "Tab order and outline"]);
    if (data?.coverage?.length) tabs.push(["coverage", "Unused code"]);
  }
  if (hasVisual) tabs.push(["visual", "Visual compare"]);

  return (
    <div className="inspect-backdrop" onClick={onClose}>
      <div className="inspect" role="dialog" aria-label={`Inspect ${page.url}`} onClick={(e) => e.stopPropagation()}>
        <div className="inspect-head">
          <div className="grow">
            <div className="eyebrow">Inspect page {index + 1}</div>
            <div className="strong inspect-url">{page.url}</div>
          </div>
          {page.inspect && (
            <>
              <a className="btn ghost small" href={api.artifact(run.id, page.inspect.har)} download>
                Download HAR
              </a>
              {page.inspect.dom && (
                <a className="btn ghost small" href={api.artifact(run.id, page.inspect.dom)} target="_blank" rel="noreferrer">
                  Page HTML
                </a>
              )}
            </>
          )}
          <button className="btn ghost small" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>
        <div className="tabs inspect-tabs">
          {tabs.map(([t, label]) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
        <div className="inspect-body">
          {error && <div className="error">{error}</div>}
          {!page.inspect && !hasVisual && <p className="muted">This test did not record the inspect screen. Turn on the Inspect screen module in the owner panel.</p>}
          {page.inspect && !data && !error && tab !== "visual" && <div className="loading">Loading the recording…</div>}
          {data && tab === "steps" && <Steps data={data} />}
          {data && tab === "network" && <Network data={data} />}
          {data && tab === "console" && <Console data={data} />}
          {tab === "elements" && page.inspect?.dom && <Elements run={run} file={page.inspect.dom} />}
          {data && tab === "layout" && <Layout data={data} run={run} page={page} />}
          {data && tab === "coverage" && <Coverage data={data} />}
          {tab === "visual" && <VisualCompare run={run} index={index} onRunChange={onRunChange} />}
        </div>
      </div>
    </div>
  );
}

/** A timeline of what the test did on the page, like a trace viewer's action list. */
function Steps({ data }: { data: InspectData }) {
  const end = Math.max(1, ...data.steps.map((s) => s.at + (s.ms ?? 0)));
  return (
    <div className="steps">
      {data.steps.map((s, i) => (
        <div className={`step-row${s.ok === false ? " bad" : ""}`} key={i}>
          <span className="step-at muted small">{ms(s.at)}</span>
          <span className="step-label">
            {s.ok === false ? "✗ " : ""}
            {s.label}
            {s.detail && <span className="muted small"> · {s.detail}</span>}
          </span>
          <span className="step-track">
            <span className="step-bar" style={{ left: `${(s.at / end) * 100}%`, width: `${Math.max(0.5, ((s.ms ?? 0) / end) * 100)}%` }} />
          </span>
          <span className="step-ms muted small">{s.ms !== undefined ? ms(s.ms) : ""}</span>
        </div>
      ))}
    </div>
  );
}

const TYPES = ["all", "document", "script", "stylesheet", "image", "font", "fetch", "xhr", "other"] as const;

/** Every request, as a waterfall; click one for its headers and timing. */
function Network({ data }: { data: InspectData }) {
  const [type, setType] = useState<(typeof TYPES)[number]>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<InspectRequest | null>(null);
  const rows = useMemo(
    () =>
      data.network.filter((r) => {
        const t = TYPES.includes(r.type as never) ? r.type : "other";
        return (type === "all" || t === type) && (!q || r.url.toLowerCase().includes(q.toLowerCase()));
      }),
    [data, type, q],
  );
  const end = Math.max(1, ...data.network.map((r) => r.end));
  const total = rows.reduce((n, r) => n + r.bytes, 0);
  const failed = rows.filter((r) => r.failed || r.status >= 400).length;
  return (
    <div className="network">
      <div className="net-filters">
        <input className="input small" placeholder="Filter by address" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pills">
          {TYPES.map((t) => (
            <button key={t} className={`pill${type === t ? " active" : ""}`} onClick={() => setType(t)}>
              {t === "all" ? "All" : t === "xhr" ? "XHR" : t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <span className="muted small">
          {rows.length} requests · {kb(total)} · {failed} failed · finished at {ms(end)}
        </span>
      </div>
      <div className="net-split">
        <div className="net-table" role="table">
          <div className="net-row head" role="row">
            <span>Name</span>
            <span>Status</span>
            <span>Type</span>
            <span>Size</span>
            <span>Time</span>
            <span>Waterfall</span>
          </div>
          {rows.map((r, i) => (
            <button
              key={i}
              role="row"
              className={`net-row${open === r ? " active" : ""}${r.failed || r.status >= 400 ? " bad" : ""}`}
              onClick={() => setOpen(open === r ? null : r)}
              title={r.url}
            >
              <span className="net-name">{shortName(r.url)}</span>
              <span>{r.failed ? "failed" : r.status}</span>
              <span>{r.type}</span>
              <span>{kb(r.bytes)}</span>
              <span>{ms(r.end - r.start)}</span>
              <span className="net-track">
                <span
                  className={`net-bar t-${r.type}`}
                  style={{ left: `${(r.start / end) * 100}%`, width: `${Math.max(0.4, ((r.end - r.start) / end) * 100)}%` }}
                />
              </span>
            </button>
          ))}
        </div>
        {open && <RequestDetail r={open} onClose={() => setOpen(null)} />}
      </div>
    </div>
  );
}

function RequestDetail({ r, onClose }: { r: InspectRequest; onClose: () => void }) {
  const t = r.timing;
  return (
    <div className="net-detail">
      <div className="row">
        <div className="strong grow">
          {r.method} {r.failed ? `failed: ${r.failed}` : r.status}
        </div>
        <button className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <code className="net-url">{r.url}</code>
      {t && (
        <>
          <h4>Timing</h4>
          <table className="kv">
            <tbody>
              {(
                [
                  ["Looking up the name (DNS)", t.dns],
                  ["Connecting", t.connect],
                  ["Secure connection (TLS)", t.ssl],
                  ["Waiting for the server (TTFB)", t.wait],
                  ["Downloading", t.receive],
                ] as [string, number][]
              )
                .filter(([, v]) => v >= 0)
                .map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{ms(v)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </>
      )}
      <h4>Response headers</h4>
      <Headers h={r.responseHeaders} />
      <h4>Request headers</h4>
      <Headers h={r.requestHeaders} />
      <p className="muted small">Cookies and login headers are hidden: they never leave the test.</p>
    </div>
  );
}

function Headers({ h }: { h: Record<string, string> }) {
  const list = Object.entries(h).sort(([a], [b]) => a.localeCompare(b));
  if (!list.length) return <p className="muted small">None</p>;
  return (
    <table className="kv">
      <tbody>
        {list.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Console({ data }: { data: InspectData }) {
  const [level, setLevel] = useState<"all" | "error" | "warning" | "other">("all");
  const rows = data.console.filter((c) => {
    const l = c.type === "exception" || c.type === "error" ? "error" : c.type === "warning" ? "warning" : "other";
    return level === "all" || level === l;
  });
  return (
    <div>
      <div className="pills">
        {(["all", "error", "warning", "other"] as const).map((l) => (
          <button key={l} className={`pill${level === l ? " active" : ""}`} onClick={() => setLevel(l)}>
            {l === "all" ? "All" : l === "error" ? "Errors" : l === "warning" ? "Warnings" : "Logs"}
          </button>
        ))}
      </div>
      {!rows.length && <p className="muted">Nothing written to the console.</p>}
      <div className="console">
        {rows.map((c, i) => (
          <div key={i} className={`console-row c-${c.type}`}>
            <span className="muted small">{ms(c.at)}</span>
            <span className="console-type">{c.type}</span>
            <pre>{c.text}</pre>
            {c.source && <span className="muted small console-src">{shortName(c.source)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The page's HTML at the end of the test: drawn without scripts, and as source. */
function Elements({ run, file }: { run: Run; file: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [view, setView] = useState<"source" | "page">("source");
  useEffect(() => {
    fetch(api.artifact(run.id, file))
      .then((r) => r.text())
      .then(setHtml)
      .catch(() => setHtml(""));
  }, [run.id, file]);
  if (html === null) return <div className="loading">Loading the page's HTML…</div>;
  const lines = html.split("\n");
  return (
    <div>
      <div className="pills">
        <button className={`pill${view === "source" ? " active" : ""}`} onClick={() => setView("source")}>
          Source ({lines.length} lines)
        </button>
        <button className={`pill${view === "page" ? " active" : ""}`} onClick={() => setView("page")}>
          Snapshot (no scripts)
        </button>
      </div>
      {view === "page" ? (
        // An empty sandbox: the copy cannot run scripts or reach the dashboard.
        <iframe className="dom-frame" sandbox="" srcDoc={html} title="Snapshot of the page" />
      ) : (
        <pre className="dom-source">
          {lines.slice(0, 5000).map((l, i) => (
            <div key={i}>
              <span className="ln">{i + 1}</span>
              {l}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}

/** The keyboard's tab order (numbered) and the headings and landmarks, over the desktop picture. */
function Layout({ data, run, page }: { data: InspectData; run: Run; page: PageResult }) {
  const [show, setShow] = useState({ tab: true, heading: true, landmark: false });
  const [hover, setHover] = useState<string>("");
  const W = data.viewport.width;
  const H = data.viewport.height;
  const inView = (b: { y: number; h: number }) => b.y < H && b.y + b.h > 0;
  if (!page.screenshot) return <p className="muted">No picture of this page.</p>;
  const tabs = data.tabOrder.filter(inView);
  const outline = data.outline.filter(inView);
  return (
    <div className="layout-view">
      <div className="pills">
        {(
          [
            ["tab", `Tab order (${data.tabOrder.length})`],
            ["heading", `Headings (${data.outline.filter((o) => o.kind === "heading").length})`],
            ["landmark", `Landmarks (${data.outline.filter((o) => o.kind === "landmark").length})`],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`pill${show[k] ? " active" : ""}`} onClick={() => setShow({ ...show, [k]: !show[k] })}>
            {label}
          </button>
        ))}
        <span className="muted small">{hover || "Point at a box to see what it is. Only the top of the page is in the picture."}</span>
      </div>
      <div className="overlay-wrap">
        <img src={api.artifact(run.id, page.screenshot)} alt={`Desktop view of ${page.url}`} />
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="overlay">
          {show.landmark &&
            outline
              .filter((o) => o.kind === "landmark")
              .map((o, i) => (
                <rect key={`l${i}`} className="ov-landmark" x={o.x} y={o.y} width={o.w} height={o.h} onMouseEnter={() => setHover(o.label)} />
              ))}
          {show.heading &&
            outline
              .filter((o) => o.kind === "heading")
              .map((o, i) => (
                <g key={`h${i}`} onMouseEnter={() => setHover(o.label)}>
                  <rect className="ov-heading" x={o.x} y={o.y} width={o.w} height={o.h} />
                  <text className="ov-heading-label" x={o.x} y={o.y > 16 ? o.y - 4 : o.y + o.h + 13}>
                    H{o.level}
                  </text>
                </g>
              ))}
          {show.tab && (
            <>
              <polyline className="ov-path" points={tabs.map((b) => `${b.x + b.w / 2},${b.y + b.h / 2}`).join(" ")} />
              {tabs.map((b) => (
                <g key={`t${b.n}`} onMouseEnter={() => setHover(`${b.n}. ${b.label}`)}>
                  <rect className="ov-tab" x={b.x} y={b.y} width={b.w} height={b.h} />
                  <circle className="ov-num" cx={b.x} cy={b.y} r={11} />
                  <text className="ov-num-label" x={b.x} y={b.y + 4}>
                    {b.n}
                  </text>
                </g>
              ))}
            </>
          )}
        </svg>
      </div>
      {show.tab && data.tabOrder.length > 0 && (
        <ol className="tab-list">
          {data.tabOrder.slice(0, 60).map((b) => (
            <li key={b.n}>{b.label}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Coverage({ data }: { data: InspectData }) {
  const rows = data.coverage ?? [];
  const total = rows.reduce((n, r) => n + r.totalBytes, 0);
  const unused = rows.reduce((n, r) => n + r.unusedBytes, 0);
  return (
    <div>
      <p className="muted">
        {kb(unused)} of {kb(total)} JavaScript and CSS ({total ? Math.round((unused / total) * 100) : 0}%) was not used while the page
        loaded and was tested. Splitting or removing it makes the page faster. Sizes are before compression.
      </p>
      <div className="net-table">
        <div className="net-row cov head">
          <span>File</span>
          <span>Type</span>
          <span>Size</span>
          <span>Unused</span>
          <span>Unused share</span>
        </div>
        {rows.map((r) => (
          <div className="net-row cov" key={r.url + r.type} title={r.url}>
            <span className="net-name">{shortName(r.url)}</span>
            <span>{r.type.toUpperCase()}</span>
            <span>{kb(r.totalBytes)}</span>
            <span>{kb(r.unusedBytes)}</span>
            <span className="cov-track">
              <span className="cov-used" style={{ width: `${100 - (r.unusedBytes / Math.max(1, r.totalBytes)) * 100}%` }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<VisualResult["status"], string> = {
  new: "First picture: saved as the approved one",
  same: "Same as the approved picture",
  changed: "Changed",
  approved: "Approved as the new picture",
};

/** Old, new and the changes in red, with a slider between old and new, and Approve. */
export function VisualCompare({ run, index, onRunChange }: { run: Run; index: number; onRunChange?: (r: Run) => void }) {
  const page = run.result!.pages[index];
  const [view, setView] = useState<"desktop" | "phone">(page.visual?.desktop?.status === "changed" || !page.visual?.phone ? "desktop" : "phone");
  const [mode, setMode] = useState<"side" | "slider" | "diff">("side");
  const [split, setSplit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const v = page.visual?.[view];
  const shot = view === "desktop" ? page.screenshot : page.mobileScreenshot;
  const approve = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.approvePicture(run.id, index, view);
      const pages = run.result!.pages.map((p, i) => (i === index ? { ...p, visual: r.visual } : p));
      onRunChange?.({ ...run, result: { ...run.result!, pages } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="visual">
      <div className="row">
        <div className="pills">
          {(["desktop", "phone"] as const)
            .filter((x) => page.visual?.[x])
            .map((x) => (
              <button key={x} className={`pill${view === x ? " active" : ""}`} onClick={() => setView(x)}>
                {x === "desktop" ? "Desktop" : "Phone"}
                {page.visual?.[x]?.status === "changed" ? ` · ${page.visual[x]!.changed}% changed` : ""}
              </button>
            ))}
        </div>
        {v?.baseline && (
          <div className="pills">
            {(["side", "slider", "diff"] as const).map((m) => (
              <button key={m} className={`pill${mode === m ? " active" : ""}`} onClick={() => setMode(m)}>
                {m === "side" ? "Side by side" : m === "slider" ? "Slider" : "Changes only"}
              </button>
            ))}
          </div>
        )}
      </div>
      {v && (
        <p className={v.status === "changed" ? "visual-status bad" : "visual-status"}>
          {STATUS_TEXT[v.status]}
          {v.status === "changed" && v.changed !== undefined ? `: ${v.changed}% of the picture` : ""}
          {v.approvedAt ? ` · approved picture from ${v.approvedAt.slice(0, 10)}` : ""}
        </p>
      )}
      {error && <div className="error">{error}</div>}
      {v && shot && !v.baseline && <img className="visual-img" src={api.artifact(run.id, shot)} alt="This test's picture" />}
      {v?.baseline && shot && mode === "side" && (
        <div className={`visual-grid${v.diff ? " three" : ""}`}>
          <figure>
            <figcaption>Approved</figcaption>
            <img src={api.artifact(run.id, v.baseline)} alt="Approved picture" />
          </figure>
          <figure>
            <figcaption>This test</figcaption>
            <img src={api.artifact(run.id, shot)} alt="This test's picture" />
          </figure>
          {v.diff && (
            <figure>
              <figcaption>Changes in red</figcaption>
              <img src={api.artifact(run.id, v.diff)} alt="Changed parts in red" />
            </figure>
          )}
        </div>
      )}
      {v?.baseline && shot && mode === "slider" && (
        <div className="slider-wrap">
          <img src={api.artifact(run.id, shot)} alt="This test's picture" />
          <div className="slider-old" style={{ width: `${split}%` }}>
            <img src={api.artifact(run.id, v.baseline)} alt="Approved picture" />
          </div>
          <input
            type="range"
            min={0}
            max={100}
            value={split}
            onChange={(e) => setSplit(Number(e.target.value))}
            aria-label="Move between the approved picture (left) and this test (right)"
          />
        </div>
      )}
      {v?.baseline && mode === "diff" && (v.diff ? <img className="visual-img" src={api.artifact(run.id, v.diff)} alt="Changed parts in red" /> : <p className="muted">No changes.</p>)}
      {v?.status === "changed" && (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={approve}>
            {busy ? "Saving…" : "Approve: this is the new look"}
          </button>
          <span className="muted small">Not wanted? Leave it: the issue stays open until the page looks like the approved picture again.</span>
        </div>
      )}
    </div>
  );
}
