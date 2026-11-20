import type { RumSummary, Run, ScanResult } from "../../../src/types.ts";
import { api } from "../api.ts";

/*
 * Report tabs for the checks that change data (what ran, what was put back, what was left) and the
 * SEO audit with real-visitor speed.
 */

const OUTCOME: Record<string, [string, string]> = {
  saved: ["Saved", "ok"],
  refused: ["The form refused it", "warn"],
  "server-error": ["Server error", "bad"],
  "no-change": ["Nothing happened", "warn"],
  blocked: ["Not sent", "muted"],
};

export function ChangesTab({ run }: { run: Run }) {
  const r = run.result!;
  const c = r.changes;
  return (
    <>
      {c && (
        <section className="card">
          <div className={c.allowed ? "ok" : "warn"}>{c.allowed ? "Allowed: " : "Not allowed, so they were skipped: "}{c.why}</div>
          {c.ran.length > 0 && (
            <>
              <h3 className="drawer-sub">Ran</h3>
              <ul>
                {c.ran.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
          {c.skipped.length > 0 && (
            <>
              <h3 className="drawer-sub">Skipped</h3>
              <ul className="small">
                {c.skipped.map((x) => (
                  <li key={x.check}>
                    <b>{x.check}</b>: {x.why}
                  </li>
                ))}
              </ul>
            </>
          )}
          {c.cleanedUp.length > 0 && (
            <>
              <h3 className="drawer-sub">Made and put back</h3>
              <ul className="small mono">
                {c.cleanedUp.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </>
          )}
          {c.leftOver.length > 0 && (
            <div className="warn">
              <b>Left behind: please remove these by hand.</b>
              <ul className="small mono">
                {c.leftOver.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      {r.forms && r.forms.length > 0 && (
        <>
          <h2 className="section-title">Forms Claude filled</h2>
          <div className="card table-card">
            <table className="table">
              <thead>
                <tr>
                  <th>Form</th>
                  <th>Values</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {r.forms.map((f, i) => (
                  <tr key={`${f.pageUrl}${f.form}${i}`}>
                    <td>
                      <div>{f.form}</div>
                      <div className="muted small mono">{f.pageUrl}</div>
                      <div className="muted small">Values by {f.by === "claude" ? "Claude" : "the built-in filler (no API key)"}</div>
                    </td>
                    <td className="small">
                      <ul className="form-fill-fields">
                        {f.fields.map((x) => (
                          <li key={x.name}>
                            {x.label || x.name}: <span className="mono">{x.value}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <span className={OUTCOME[f.outcome]?.[1]}>{OUTCOME[f.outcome]?.[0] ?? f.outcome}</span>
                      {f.status ? <span className="muted small"> · HTTP {f.status}</span> : null}
                      {f.message && <div className="small">{f.message}</div>}
                      {f.shot && <img className="shot" style={{ maxHeight: 120, marginTop: 6 }} src={api.artifact(run.id, f.shot)} alt={`After sending ${f.form}`} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

const ms = (v?: number) => (v === undefined ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

function RumTable({ rum }: { rum: RumSummary }) {
  const row = (label: string, visits: number, p: RumSummary["p75"]) => (
    <tr key={label}>
      <td className="mono small">{label}</td>
      <td>{visits}</td>
      <td className={p.lcp === undefined ? "" : p.lcp <= 2500 ? "ok" : p.lcp <= 4000 ? "warn" : "bad"}>{ms(p.lcp)}</td>
      <td className={p.inp === undefined ? "" : p.inp <= 200 ? "ok" : p.inp <= 500 ? "warn" : "bad"}>{ms(p.inp)}</td>
      <td className={p.cls === undefined ? "" : p.cls <= 0.1 ? "ok" : p.cls <= 0.25 ? "warn" : "bad"}>{p.cls === undefined ? "–" : p.cls.toFixed(2)}</td>
      <td>{ms(p.ttfb)}</td>
    </tr>
  );
  return (
    <div className="card table-card">
      <table className="table small">
        <thead>
          <tr>
            <th>75% of visits (since {new Date(rum.since).toLocaleDateString()})</th>
            <th>Visits</th>
            <th>LCP</th>
            <th>INP</th>
            <th>CLS</th>
            <th>TTFB</th>
          </tr>
        </thead>
        <tbody>
          {row("All pages", rum.visits, rum.p75)}
          {rum.byDevice.map((d) => row(`On ${d.device}s`, d.visits, d.p75))}
          {rum.pages.slice(0, 15).map((p) => row(p.path, p.visits, p.p75))}
        </tbody>
      </table>
    </div>
  );
}

export function SeoTab({ result }: { result: ScanResult }) {
  const seo = result.seo;
  return (
    <>
      {result.rum && (
        <>
          <h2 className="section-title">Speed from real visitors</h2>
          <RumTable rum={result.rum} />
        </>
      )}
      {seo && (
        <>
          <div className="note small">
            <b>What this audit can and cannot see.</b>
            <ul>
              {seo.limits.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
          {seo.keywords.length > 0 && (
            <>
              <h2 className="section-title">Keywords</h2>
              <div className="card table-card">
                <table className="table small">
                  <thead>
                    <tr>
                      <th>Page</th>
                      <th>Keyword</th>
                      <th>Title</th>
                      <th>Main heading</th>
                      <th>Address</th>
                      <th>Description</th>
                      <th>Times on page</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seo.keywords.map((k) => (
                      <tr key={`${k.page}${k.keyword}`}>
                        <td className="mono">{k.page}</td>
                        <td>{k.keyword}</td>
                        {[k.inTitle, k.inH1, k.inUrl, k.inDescription].map((v, i) => (
                          <td key={i} className={v ? "ok" : "muted"}>
                            {v ? "Yes" : "No"}
                          </td>
                        ))}
                        <td>{k.count}</td>
                        <td className={k.score >= 70 ? "ok" : k.score >= 40 ? "warn" : "bad"}>{k.score}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {seo.backlinks.length > 0 && (
            <>
              <h2 className="section-title">Backlinks you listed</h2>
              <div className="card table-card">
                <table className="table small">
                  <thead>
                    <tr>
                      <th>Linking page</th>
                      <th>Answer</th>
                      <th>Still links here</th>
                      <th>To</th>
                      <th>Anchor text</th>
                      <th>rel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seo.backlinks.map((b) => (
                      <tr key={b.from}>
                        <td className="mono">{b.from}</td>
                        <td className={b.status && b.status < 400 ? "" : "bad"}>{b.status ?? "none"}</td>
                        <td className={b.linked ? "ok" : "bad"}>{b.linked ? "Yes" : "No"}</td>
                        <td className="mono">{b.to ?? "–"}</td>
                        <td>{b.anchor ?? "–"}</td>
                        <td className={b.rel && /nofollow|sponsored|ugc/.test(b.rel) ? "warn" : ""}>{b.rel || "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {seo.searchConsole && (
            <>
              <h2 className="section-title">Search Console ({seo.searchConsole.kind}): {seo.searchConsole.nearTop} just off page one</h2>
              <div className="card table-card">
                <table className="table small">
                  <thead>
                    <tr>
                      <th>{seo.searchConsole.kind === "queries" ? "Query" : "Page"}</th>
                      <th>Clicks</th>
                      <th>Impressions</th>
                      <th>CTR</th>
                      <th>Position</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seo.searchConsole.rows.slice(0, 50).map((r) => (
                      <tr key={r.key}>
                        <td>{r.key}</td>
                        <td>{r.clicks}</td>
                        <td>{r.impressions}</td>
                        <td>{r.ctr.toFixed(1)}%</td>
                        <td className={r.position <= 10 ? "ok" : r.position <= 20 ? "warn" : ""}>{r.position.toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h2 className="section-title">Links to other sites</h2>
          <div className="card small">
            {seo.outbound.total} links to {seo.outbound.domains} other sites · {seo.outbound.nofollow} nofollow · {seo.outbound.sponsored} sponsored
            {seo.outbound.broken.length > 0 && (
              <div className="bad">
                Broken:
                <ul className="mono">
                  {seo.outbound.broken.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
