import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LiveCode, LiveScreen } from "../../../src/live.ts";
import type { Fix } from "../../../src/fixes.ts";
import type { Severity } from "../../../src/types.ts";
import { FixBox, Sev } from "../ui.tsx";

/**
 * The code panel beside the live screens: for the screen picked, what the test does to the page
 * (as Playwright code that can be run again), what the page loads and prints, the HTML it shows
 * right now, and what the checks found with the code that fixes it. Shown only when asked for.
 */

type Tab = "steps" | "found" | "network" | "console" | "source" | "calls";
const TABS: { id: Tab; label: string }[] = [
  { id: "steps", label: "Test code" },
  { id: "found", label: "Checks found" },
  { id: "network", label: "Network" },
  { id: "console", label: "Console" },
  { id: "source", label: "Page code" },
];
/** Tests without screens (API, code, apps): the calls they make and what the checks find. */
const SCREENLESS_TABS: { id: Tab; label: string }[] = [
  { id: "calls", label: "API calls" },
  { id: "found", label: "Checks found" },
];

type Of<K extends LiveCode["kind"]> = Extract<LiveCode, { kind: K }>;

const ms = (n?: number) => (n === undefined ? "" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);
const kb = (n?: number) => (!n ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The test's steps on one page as a Playwright script that opens and pictures the page the same way. */
export function scriptOf(lines: LiveCode[]): string {
  const page = lines.find((l): l is Of<"page"> => l.kind === "page");
  const body = lines
    .filter((l): l is Of<"step"> => l.kind === "step" && Boolean(l.code))
    .map((l) => `  ${l.code}`)
    .join("\n");
  return [
    `// GLV Testing Agent: what the test did on ${page?.url ?? "this page"}`,
    "// Run with: npm i playwright && npx playwright install chromium && node glv-steps.mjs",
    'import { chromium } from "playwright";',
    "",
    "const browser = await chromium.launch();",
    "const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });",
    "try {",
    body || "  // No steps yet",
    "} finally {",
    "  await browser.close();",
    "}",
    "",
  ].join("\n");
}

function download(name: string, text: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost small"
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** HTML with tags, attributes and comments coloured. Very large pages are shown plain, so the browser stays quick. */
export function highlightHtml(text: string): ReactNode[] {
  if (text.length > 300_000) return [text];
  const out: ReactNode[] = [];
  const re = /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?>)|(<!DOCTYPE[^>]*>)/gi;
  let last = 0;
  let k = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] || m[5]) out.push(<span key={k++} className="hl-comment">{m[1] ?? m[5]}</span>);
    else {
      out.push(<span key={k++} className="hl-tag">{m[2]}</span>);
      const attrs = m[3];
      const ar = /(\s+)([^\s=>/]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+))?/g;
      for (let a = ar.exec(attrs); a; a = ar.exec(attrs)) {
        out.push(a[1], <span key={k++} className="hl-attr">{a[2]}</span>);
        if (a[3]) out.push(a[3], <span key={k++} className="hl-value">{a[4]}</span>);
      }
      out.push(<span key={k++} className="hl-tag">{m[4]}</span>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function PageSource({ runId, slot, url }: { runId: string; slot: number; url?: string }) {
  const [state, setState] = useState<{ html?: string; error?: string; loading?: boolean }>({});
  const [find, setFind] = useState("");
  const load = () => {
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/runs/${encodeURIComponent(runId)}/live/source/${slot}`)
      .then(async (r) => (r.ok ? setState({ html: await r.text() }) : setState({ error: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Could not read the page." })))
      .catch(() => setState({ error: "Could not reach the server." }));
  };
  // A new page on the screen: read its code again.
  useEffect(load, [runId, slot, url]);
  const matches = useMemo(() => {
    if (!state.html || !find.trim()) return undefined;
    const q = find.toLowerCase();
    return state.html
      .split("\n")
      .map((text, i) => ({ text, n: i + 1 }))
      .filter((l) => l.text.toLowerCase().includes(q))
      .slice(0, 500);
  }, [state.html, find]);
  const shown = useMemo(() => (state.html ? highlightHtml(state.html) : []), [state.html]);
  return (
    <div className="code-tab">
      <div className="code-tools">
        <input className="code-find" type="search" placeholder="Find in the page code" aria-label="Find in the page code" value={find} onChange={(e) => setFind(e.target.value)} />
        <button className="btn ghost small" onClick={load} disabled={state.loading}>
          {state.loading ? "Reading…" : "Read again"}
        </button>
        {state.html && <Copy text={state.html} />}
        {state.html && (
          <button className="btn ghost small" onClick={() => download(`screen-${slot + 1}-page.html`, state.html!, "text/html")}>
            Download
          </button>
        )}
      </div>
      <p className="muted small code-hint">The page as the browser has it now, after its scripts ran. Password, hidden-field and CSRF values are hidden.</p>
      {state.error ? (
        <div className="code-empty">{state.error}</div>
      ) : !state.html ? (
        <div className="code-empty">Reading the page…</div>
      ) : matches ? (
        <pre className="code-pre">
          {matches.length === 0
            ? "Not found on this page."
            : matches.map((l) => (
                <div key={l.n}>
                  <span className="code-ln">{l.n}</span>
                  {l.text.slice(0, 400)}
                </div>
              ))}
        </pre>
      ) : (
        <pre className="code-pre">{shown}</pre>
      )}
    </div>
  );
}

export function CodePanel({
  runId,
  total,
  screens,
  lines,
  phone,
  screenless,
  api,
}: {
  runId: string;
  total: number;
  screens: Record<number, LiveScreen>;
  lines: Record<number, LiveCode[]>;
  phone?: boolean;
  /** A test without screens: only the calls it makes and the checks found. */
  screenless?: boolean;
  /** An API test: the calls tab comes first. */
  api?: boolean;
}) {
  const [tab, setTab] = useState<Tab>(screenless ? (api ? "calls" : "found") : "steps");
  const tabs = screenless ? (api ? SCREENLESS_TABS : SCREENLESS_TABS.slice(1)) : TABS;
  const [picked, setPicked] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [failedOnly, setFailedOnly] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Until the viewer picks a screen, follow the first one that is checking a page.
  const busy = Object.values(screens).find((s) => s.state === "busy")?.slot ?? 0;
  const slot = picked !== null && picked < Math.max(1, total) ? picked : busy;
  const mine = lines[slot] ?? [];
  const of = <K extends LiveCode["kind"]>(k: K) => mine.filter((l): l is Of<K> => l.kind === k);
  const steps = of("step");
  const found = of("found");
  const net = of("net");
  const logs = of("console");
  const calls = of("call");
  const pageLine = mine.find((l): l is Of<"page"> => l.kind === "page");
  const counts: Record<Tab, number | undefined> = { steps: steps.length, found: found.length, network: net.length, console: logs.length, source: undefined, calls: calls.length };
  const badNet = net.filter((n) => n.failed || n.status >= 400).length + calls.filter((c) => c.failed || c.status >= 400).length;
  const errors = logs.filter((l) => l.level === "error").length;

  useEffect(() => {
    if (follow && box.current && tab !== "source") box.current.scrollTop = box.current.scrollHeight;
  }, [mine.length, tab, follow]);

  const list = (() => {
    switch (tab) {
      case "steps":
        return steps.length === 0 ? (
          <div className="code-empty">The test's steps on this page show here as it runs them.</div>
        ) : (
          <ol className="code-list">
            {steps.map((s, i) => (
              <li key={i} className={s.ok === false ? "bad" : ""}>
                <div className="code-row">
                  <span className="code-at">{ms(s.at)}</span>
                  <strong>{s.label}</strong>
                  {s.ms !== undefined && <span className="muted small">{ms(s.ms)}</span>}
                  {s.detail && <span className={`code-detail ${s.ok === false ? "bad" : ""}`}>{s.detail}</span>}
                </div>
                {s.code && <code className="code-line">{s.code}</code>}
              </li>
            ))}
          </ol>
        );
      case "found":
        return found.length === 0 ? (
          <div className="code-empty">Nothing found on this page yet. Each problem shows here the moment a check finds it, with the code that fixes it.</div>
        ) : (
          <ul className="code-list">
            {found.map((f, i) => (
              <li key={i}>
                <details>
                  <summary className="code-row">
                    <Sev s={f.severity as Severity} />
                    <strong>{f.title}</strong>
                    {f.agent && <span className="muted small">{f.agent}</span>}
                  </summary>
                  <p className="small">{f.detail}</p>
                  {f.evidence && (
                    <div className="code-block">
                      <div className="code-label">The code that failed</div>
                      <pre>{f.evidence}</pre>
                    </div>
                  )}
                  {f.fix && <FixBox fix={f.fix as Fix} />}
                  <div className="muted small">Rule: {f.rule}</div>
                </details>
              </li>
            ))}
          </ul>
        );
      case "calls": {
        const rows = failedOnly ? calls.filter((c) => c.failed || c.status >= 400) : calls;
        return rows.length === 0 ? (
          <div className="code-empty">{failedOnly ? "No failed calls yet." : "Each call the test makes shows here as a cURL command you can paste into a terminal. Logins are hidden."}</div>
        ) : (
          <ol className="code-list">
            {rows.map((c, i) => (
              <li key={i} className={c.failed || c.status >= 400 ? "bad" : ""}>
                <div className="code-row">
                  <strong>{c.method}</strong>
                  <span className="code-url">{c.url}</span>
                  <span className={`code-detail ${c.failed || c.status >= 400 ? "bad" : ""}`}>{c.failed ?? c.status}</span>
                  <span className="muted small">{ms(c.ms)}</span>
                </div>
                <code className="code-line curl">{c.curl}</code>
              </li>
            ))}
          </ol>
        );
      }
      case "network": {
        const rows = failedOnly ? net.filter((n) => n.failed || n.status >= 400) : net;
        return rows.length === 0 ? (
          <div className="code-empty">{failedOnly ? "No failed requests on this page." : "Requests the page makes show here."}</div>
        ) : (
          <table className="code-table">
            <thead>
              <tr>
                <th>Method</th>
                <th>Status</th>
                <th>Type</th>
                <th>Address</th>
                <th>Size</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((n, i) => (
                <tr key={i} className={n.failed || n.status >= 400 ? "bad" : ""}>
                  <td>{n.method}</td>
                  <td>{n.failed ? "failed" : n.status || ""}</td>
                  <td>{n.type}</td>
                  <td className="code-url" title={n.failed ? `${n.url} (${n.failed})` : n.url}>
                    {n.url}
                  </td>
                  <td>{kb(n.bytes)}</td>
                  <td>{ms(n.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      case "console":
        return logs.length === 0 ? (
          <div className="code-empty">What the page prints in its console shows here.</div>
        ) : (
          <ul className="code-list">
            {logs.map((l, i) => (
              <li key={i} className={`console-${l.level}`}>
                <div className="code-row">
                  <span className={`code-level ${l.level}`}>{l.level}</span>
                  <code className="code-text">{l.text}</code>
                </div>
                {l.source && <div className="muted small code-url">{l.source}</div>}
              </li>
            ))}
          </ul>
        );
      default:
        return <PageSource runId={runId} slot={slot} url={pageLine?.url} />;
    }
  })();

  return (
    <aside className={`code-panel${phone ? " phone" : ""}`} aria-label="Code of the screen">
      <div className="code-head">
        <strong>Code</strong>
        {screenless ? (
          <span className="muted small">{api ? "Calls and checks as they happen" : "Checks as they happen"}</span>
        ) : total > 1 ? (
          <select className="live-pick" aria-label="Screen whose code is shown" value={slot} onChange={(e) => setPicked(Number(e.target.value))}>
            {Array.from({ length: total }, (_, i) => (
              <option key={i} value={i}>
                Screen {i + 1}
              </option>
            ))}
          </select>
        ) : (
          <span className="muted small">Screen 1</span>
        )}
        {!screenless && picked !== null && (
          <button className="btn ghost small" title="Follow the busy screen again" onClick={() => setPicked(null)}>
            Follow busy
          </button>
        )}
      </div>
      {!screenless && (
        <div className="code-url muted small" title={pageLine?.url}>
          {pageLine?.url ?? screens[slot]?.url ?? "Waiting for a page"}
        </div>
      )}
      <div className="tabs code-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            {t.label}
            {counts[t.id] ? (
              <span className={`tab-count${(t.id === "found" && found.length) || ((t.id === "network" || t.id === "calls") && badNet) || (t.id === "console" && errors) ? " bad" : ""}`}>{counts[t.id]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {tab !== "source" && (
        <div className="code-tools">
          <label className="small">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow new lines
          </label>
          {(tab === "network" || tab === "calls") && (
            <label className="small">
              <input type="checkbox" checked={failedOnly} onChange={(e) => setFailedOnly(e.target.checked)} /> Failed only
            </label>
          )}
          {tab === "steps" && steps.some((s) => s.code) && (
            <>
              <Copy text={scriptOf(mine)} label="Copy as script" />
              <button className="btn ghost small" onClick={() => download("glv-steps.mjs", scriptOf(mine), "text/javascript")}>
                Download script
              </button>
            </>
          )}
        </div>
      )}
      <div className="code-body" ref={box}>
        {list}
      </div>
    </aside>
  );
}

/**
 * The code panel for a running test without screens (API, code, apps): a Show code button, then the
 * calls the test makes and the problems it finds, as they happen.
 */
export function RunCode({ runId, api }: { runId: string; api?: boolean }) {
  const KEY = "glv.runCode";
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  });
  const [lines, setLines] = useState<Record<number, LiveCode[]>>({});
  useEffect(() => {
    if (!open) return;
    setLines({});
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/live?code=1`);
    source.addEventListener("code", (e) => {
      const { items } = JSON.parse((e as MessageEvent).data) as { items: LiveCode[] };
      setLines((all) => {
        const next = { ...all };
        for (const item of items) next[item.slot] = [...(next[item.slot] ?? []).slice(-599), item];
        return next;
      });
    });
    source.addEventListener("end", () => source.close());
    return () => source.close();
  }, [runId, open]);
  const toggle = () => {
    setOpen((o) => {
      try {
        localStorage.setItem(KEY, o ? "0" : "1");
      } catch {
        // Not remembered; still works for this visit.
      }
      return !o;
    });
  };
  return (
    <div className="run-code">
      <button className={`btn small ${open ? "" : "ghost"}`} aria-pressed={open} onClick={toggle}>
        {open ? "Hide code" : "Show code"}
      </button>
      {open && <CodePanel runId={runId} total={1} screens={{}} lines={lines} screenless api={api} />}
    </div>
  );
}
