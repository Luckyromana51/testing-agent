import { useEffect, useRef, useState } from "react";
import type { LiveScreen } from "../../../src/live.ts";
import type { QueueOverview } from "../api.ts";
import { hostOf, timeAgo } from "../lib.ts";
import { Pictures } from "./LiveView.tsx";

interface RunLive {
  count: number;
  screens: Record<number, LiveScreen>;
  pictured: Record<number, boolean>;
  log: string[];
}

function Thumb({ slot, pictures }: { slot: number; pictures: Pictures }) {
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => pictures.attach(slot, img.current!), [slot, pictures]);
  return <img ref={img} alt={`What screen ${slot + 1} shows`} draggable={false} />;
}

/**
 * Every running test on one page, with what each of its browser screens shows. One stream for all
 * tests (a browser allows only six open streams to one server), so ten tests at once still show.
 */
export function LiveBoard({ isOwner }: { isOwner: boolean }) {
  const [queue, setQueue] = useState<QueueOverview | null>(null);
  const [runs, setRuns] = useState<Record<string, RunLive>>({});
  const [link, setLink] = useState<"connecting" | "live" | "again">("connecting");
  const pictures = useRef(new Map<string, Pictures>());
  const picsOf = (id: string) => {
    let p = pictures.current.get(id);
    if (!p) {
      p = new Pictures();
      p.onFirst = (slot) => setRuns((all) => ({ ...all, [id]: { ...blank(), ...all[id], pictured: { ...all[id]?.pictured, [slot]: true } } }));
      pictures.current.set(id, p);
    }
    return p;
  };

  useEffect(() => {
    const source = new EventSource("/api/live");
    source.onopen = () => setLink("live");
    source.onerror = () => setLink("again");
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    const update = (id: string, change: (r: RunLive) => RunLive) => setRuns((all) => ({ ...all, [id]: change({ ...blank(), ...all[id] }) }));
    source.addEventListener("runs", (e) => {
      const q = data(e) as QueueOverview;
      setQueue(q);
      const ids = new Set(q.running.map((r) => r.runId));
      setRuns((all) => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
      for (const id of [...pictures.current.keys()]) if (!ids.has(id)) pictures.current.delete(id);
    });
    source.addEventListener("screens", (e) => {
      const d = data(e) as { runId: string; count: number };
      update(d.runId, (r) => ({ ...r, count: d.count }));
    });
    source.addEventListener("screen", (e) => {
      const s = data(e) as LiveScreen & { runId: string };
      update(s.runId, (r) => ({ ...r, screens: { ...r.screens, [s.slot]: s } }));
    });
    source.addEventListener("frame", (e) => {
      const f = data(e) as { runId: string; slot: number; img: string };
      picsOf(f.runId).frame(f.slot, f.img);
    });
    source.addEventListener("log", (e) => {
      const d = data(e) as { runId: string; line: string };
      update(d.runId, (r) => ({ ...r, log: [...r.log.slice(-4), d.line] }));
    });
    return () => source.close();
  }, []);

  const running = queue?.running ?? [];
  const waiting = queue?.waiting ?? [];
  return (
    <div className="page wide">
      <div className="page-head">
        <div className="grow">
          <div className="eyebrow">Live</div>
          <h1>Tests running now</h1>
          <div className="muted">
            {queue ? (
              <>
                {running.length} of {queue.limit} at the same time · {waiting.length} waiting
                {isOwner && (
                  <>
                    {" · "}
                    <a href="#/owner/settings">Change the limit</a>
                  </>
                )}
              </>
            ) : (
              "Connecting…"
            )}
          </div>
        </div>
        <span className={`live-link ${link}`}>{link === "live" ? "● Live" : link === "again" ? "Reconnecting…" : "Connecting…"}</span>
      </div>

      {queue && !running.length && <div className="card muted">No test is running. Start one from New test or a project's Re-test button.</div>}

      <div className="live-board">
        {running.map((r) => {
          const live = runs[r.runId] ?? blank();
          const slots = Array.from({ length: Math.max(1, live.count) }, (_, i) => i);
          return (
            <section className="card live-card" key={r.runId}>
              <div className="live-card-head">
                <div className="grow">
                  <div className="strong">{r.name}</div>
                  <div className="muted small">
                    {hostOf(r.url)}
                    {r.startedAt ? ` · started ${timeAgo(r.startedAt)}` : ""}
                  </div>
                </div>
                <a className="btn small" href={`#/run/${r.runId}`}>
                  Full view
                </a>
              </div>
              <div className={`live-thumbs n${Math.min(slots.length, 4)}`}>
                {slots.slice(0, 8).map((slot) => {
                  const s = live.screens[slot];
                  return (
                    <div className="live-thumb" key={slot}>
                      <Thumb slot={slot} pictures={picsOf(r.runId)} />
                      {!live.pictured[slot] && <div className="live-thumb-wait">{s?.doing ?? "Starting the browser…"}</div>}
                      <div className="live-thumb-cap">
                        Screen {slot + 1}
                        {s?.url ? ` · ${hostOf(s.url) === hostOf(r.url) ? new URL(s.url).pathname : s.url}` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
              {slots.length > 8 && <div className="muted small">and {slots.length - 8} more screens in the full view</div>}
              <div className="live-card-log muted small">{live.log.at(-1) ?? "Waiting for the first step…"}</div>
            </section>
          );
        })}
      </div>

      {waiting.length > 0 && (
        <>
          <h2 className="section-title">Waiting for a free slot ({waiting.length})</h2>
          <div className="card table-card">
            <table className="table">
              <tbody>
                {waiting.map((w, i) => (
                  <tr key={w.runId} className="clickable" onClick={() => (window.location.hash = `#/run/${w.runId}`)}>
                    <td className="muted">#{i + 1}</td>
                    <td className="strong">{w.name}</td>
                    <td className="muted">{hostOf(w.url)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const blank = (): RunLive => ({ count: 0, screens: {}, pictured: {}, log: [] });
