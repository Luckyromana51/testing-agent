import { useState } from "react";
import type { AccessCell, ScanResult } from "../../../src/types.ts";

const CELL: Record<AccessCell, { text: string; tone: string; title: string }> = {
  opens: { text: "Opens", tone: "ok", title: "This account opened it" },
  blocked: { text: "Blocked", tone: "muted", title: "Refused, sent to sign-in, or sent elsewhere" },
  error: { text: "Error", tone: "warn", title: "The server failed or did not answer" },
  "same-data": { text: "Same data", tone: "bad", title: "The same data as the main account" },
  "other-data": { text: "Own data", tone: "ok", title: "Opened, with this account's own data" },
  "not-tried": { text: "–", tone: "muted", title: "Not tried: the account could not sign in" },
};

const short = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}${x.hash}`;
  } catch {
    return u;
  }
};

/** The report's signed-in app tab: the system, the screens found, who can open what, and the app's calls. */
export function AppReport({ result }: { result: ScanResult }) {
  const [part, setPart] = useState<"screens" | "access" | "calls">(result.access ? "access" : "screens");
  const screens = result.screens ?? [];
  const calls = result.calls ?? [];
  const sockets = result.sockets ?? [];
  const grid = result.access;
  return (
    <div className="app-report">
      {result.system && (
        <div className="card system-card">
          <div className="stat-label">System</div>
          <div className="strong">
            {result.system.name}
            {result.system.framework && <span className="muted"> on {result.system.framework}</span>}
          </div>
          <div className="muted small">Recognised by its {result.system.by.join(", ")}. The test used what it knows about this system: its sign-in fields, its menus, and the links it uses for actions.</div>
          {result.system.tip && <div className="small">{result.system.tip}</div>}
        </div>
      )}
      <div className="pills">
        <button className={`pill${part === "screens" ? " active" : ""}`} onClick={() => setPart("screens")}>
          Screens ({screens.length})
        </button>
        {grid && (
          <button className={`pill${part === "access" ? " active" : ""}`} onClick={() => setPart("access")}>
            Who can see what ({grid.roles.length} accounts)
          </button>
        )}
        <button className={`pill${part === "calls" ? " active" : ""}`} onClick={() => setPart("calls")}>
          App calls ({calls.length}{sockets.length ? ` + ${sockets.length} live` : ""})
        </button>
      </div>

      {part === "screens" && (
        <div className="card table-card">
          <p className="muted small pad">
            Every screen of the app the test reached: through links, and by clicking the menus, dropdowns and tabs (screens with no
            ordinary link). Menu items that would change data (delete, send, log out...) were never clicked.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Screen</th>
                <th>How it was found</th>
                <th>Tabs inside</th>
                <th>Tested</th>
              </tr>
            </thead>
            <tbody>
              {screens.map((s) => (
                <tr key={s.url}>
                  <td className="mono small">{short(s.url)}</td>
                  <td>{s.via ?? <span className="muted">A link</span>}</td>
                  <td className="small">{s.parts?.join(", ") ?? <span className="muted">–</span>}</td>
                  <td>{s.tested ? <span className="ok">✓</span> : <span className="muted" title="Over the page limit: raise Pages on the project page">Not this time</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {part === "access" && grid && (
        <div className="card table-card">
          <p className="muted small pad">
            Each account signed in in its own browser and opened every screen and app call the main account reached, and the system's
            admin screens by their address. Red cells are the ones to fix: another company getting the same data, an account opening what
            it must never open or an admin screen, or anyone getting data with no login. Orange: it opens although the account's menu
            hides it. A screen in an account's own menu is marked ☰.
            {grid.rows.some((r) => r.kind === "change") &&
              ' "Save" rows are saves a journey made on the test server, sent again as each account: "Works" means the server accepted it (this may leave extra test records on the test server).'}
          </p>
          {grid.roles.some((r) => r.error) && (
            <div className="error pad">
              {grid.roles
                .filter((r) => r.error)
                .map((r) => `${r.name}: ${r.error}`)
                .join(" ")}
            </div>
          )}
          <div className="grid-scroll">
            <table className="table access-grid">
              <thead>
                <tr>
                  <th>Screen or call</th>
                  {grid.roles.map((r) => (
                    <th key={r.id}>
                      {r.name}
                      {r.otherCompany && !/compan/i.test(r.name) && <div className="muted small">another company</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map((row) => (
                  <tr key={`${row.kind}${row.method ?? ""}${row.url}${row.what ?? ""}`}>
                    <td className="mono small">
                      <span className={`badge${row.kind === "change" ? " warn" : ""}`}>{row.kind === "call" ? "call" : row.kind === "change" ? "save" : row.known ? "admin" : "screen"}</span>{" "}
                      {row.method && row.method !== "GET" ? `${row.method} ` : ""}
                      {short(row.url)}
                      {row.what && <div className="muted small">{row.kind === "change" ? `journey "${row.what}"` : row.what}</div>}
                    </td>
                    {grid.roles.map((r) => {
                      const c = row.cells[r.id] ?? "not-tried";
                      const info = CELL[c];
                      const inMenu = r.id === "main" ? row.inMenu : row.menuOf?.includes(r.id);
                      const flag = row.flags?.[r.id];
                      const bad = flag === "forbidden" || flag === "other-company" || flag === "admin" || flag === "no-login" || (c === "same-data" && r.id === "anon") || (row.kind === "change" && r.id === "anon" && c === "opens");
                      const tone = bad ? "bad" : flag === "hidden" ? "warn" : c === "same-data" ? "ok" : info.tone;
                      const title =
                        flag === "forbidden"
                          ? "This account must never open it"
                          : flag === "hidden"
                            ? "Not in this account's menu, but it opens"
                            : flag === "other-company"
                              ? "Another company got this company's data"
                              : flag === "admin"
                                ? "An admin screen opens for this account"
                                : row.kind === "change"
                                  ? c === "opens"
                                    ? "The server accepted this save from this account"
                                    : "The server refused this save"
                                  : info.title;
                      const text = row.kind === "change" ? (c === "opens" ? "Works" : c === "blocked" ? "Refused" : info.text) : c === "same-data" && !bad ? "Opens" : info.text;
                      return (
                        <td key={r.id} className={`cell-${tone}`} title={title}>
                          {text}
                          {inMenu && row.kind === "screen" ? " ☰" : ""}
                          {flag === "hidden" ? " (hidden)" : flag === "forbidden" ? " (never)" : flag === "admin" ? " (admin)" : ""}
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

      {part === "calls" && (
        <div className="card table-card">
          <p className="muted small pad">
            The calls the screens made to the app's server (fetch and XHR), slowest first. "No login" shows what the same call answered
            with no login: "Same data" means anyone can read it.
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Call</th>
                <th>Answer</th>
                <th>Time</th>
                <th>Size</th>
                <th>No login</th>
              </tr>
            </thead>
            <tbody>
              {[...calls]
                .sort((a, b) => b.ms - a.ms)
                .map((c) => (
                  <tr key={`${c.method}${c.url}${c.what ?? ""}`}>
                    <td className="mono small">
                      {c.method} {short(c.url)}
                      {c.bearer && <span className="muted"> · login header</span>}
                      {c.what && <div className="muted small">{c.what} (only reads)</div>}
                    </td>
                    <td className={c.status >= 500 || c.status === 0 ? "bad" : c.status >= 400 ? "warn" : ""}>{c.status || "none"}</td>
                    <td className={c.ms >= 3000 ? "bad" : c.ms >= 1000 ? "warn" : ""}>{c.ms} ms</td>
                    <td className="muted">{c.bytes ? `${Math.max(1, Math.round(c.bytes / 1024))} KB` : "–"}</td>
                    <td className={c.anon === "same" ? "bad" : "muted"}>{c.anon === undefined ? "–" : c.anon === "same" ? "Same data" : `Refused (${c.anon})`}</td>
                  </tr>
                ))}
            </tbody>
          </table>
          {sockets.length > 0 && (
            <>
              <h3 className="sub-title pad">Live connections (WebSocket)</h3>
              <table className="table">
                <thead>
                  <tr>
                    <th>Address (login values hidden)</th>
                    <th>Opened by</th>
                  </tr>
                </thead>
                <tbody>
                  {sockets.map((s) => (
                    <tr key={s.url}>
                      <td className="mono small">{s.url}</td>
                      <td className="mono small">{short(s.pageUrl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
