import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { LiveScreen } from "../../../src/live.ts";

/**
 * The live view of a running web test: what each test browser screen shows right now, side by side,
 * next to what its agents are doing. The screens can be shown 1 to 4 at a time, in different shapes,
 * resized by dragging the lines between them, and swapped by dragging a screen's grip onto another.
 */

type Shape = "single" | "cols" | "rows" | "main" | "grid";
const SHAPES: Record<number, Shape[]> = { 1: ["single"], 2: ["cols", "rows"], 3: ["main", "cols", "rows"], 4: ["grid", "main", "cols", "rows"] };
const SHAPE_LABEL: Record<Shape, string> = { single: "One screen", cols: "Side by side", rows: "Stacked", main: "One big", grid: "Grid" };

type Tree = { pane: number } | { dir: "row" | "col"; key: string; children: Tree[] };

function tiles(from: number, to: number): Tree[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => ({ pane: from + i }));
}

function treeOf(shape: Shape, n: number): Tree {
  if (n <= 1 || shape === "single") return { pane: 0 };
  switch (shape) {
    case "rows":
      return { dir: "col", key: "rows", children: tiles(0, n) };
    case "main":
      return { dir: "row", key: "main", children: [{ pane: 0 }, n === 2 ? { pane: 1 } : { dir: "col", key: "main-side", children: tiles(1, n) }] };
    case "grid":
      return {
        dir: "col",
        key: "grid",
        children: [
          { dir: "row", key: "grid-top", children: tiles(0, 2) },
          { dir: "row", key: "grid-bottom", children: tiles(2, n) },
        ],
      };
    default:
      return { dir: "row", key: "cols", children: tiles(0, n) };
  }
}

interface Layout {
  /** How many screens to show, at most; fewer when the test uses fewer. */
  panes: number;
  shapes: Record<number, Shape>;
  /** Which test screen each place shows. */
  assign: number[];
  /** Share of each part of a split, by "<places>:<split>". */
  sizes: Record<string, number[]>;
  /** Share of the width for the activity panel. */
  side: number;
  height: number;
  panel: boolean;
}

const DEFAULT_LAYOUT: Layout = {
  panes: 4,
  shapes: { 1: "single", 2: "cols", 3: "main", 4: "grid" },
  assign: [0, 1, 2, 3],
  sizes: {},
  side: 0.3,
  height: 560,
  panel: true,
};
const LAYOUT_KEY = "glv.liveLayout.v1";

function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Partial<Layout> | null;
    if (saved && typeof saved === "object") return { ...DEFAULT_LAYOUT, ...saved, shapes: { ...DEFAULT_LAYOUT.shapes, ...saved.shapes } };
  } catch {
    // Private windows and blocked storage: the default layout.
  }
  return DEFAULT_LAYOUT;
}

function saveLayout(layout: Layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // Not saved; the layout still works for this visit.
  }
}

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const m = matchMedia(query);
    const change = () => setOn(m.matches);
    change();
    m.addEventListener("change", change);
    return () => m.removeEventListener("change", change);
  }, [query]);
  return on;
}

/** The newest picture of each screen, handed straight to the <img> elements showing it (never through React state). */
export class Pictures {
  private latest = new Map<number, string>();
  private shown = new Map<number, Set<HTMLImageElement>>();
  onFirst?: (slot: number) => void;

  frame(slot: number, jpegBase64: string) {
    const src = `data:image/jpeg;base64,${jpegBase64}`;
    const first = !this.latest.has(slot);
    this.latest.set(slot, src);
    for (const img of this.shown.get(slot) ?? []) img.src = src;
    if (first) this.onFirst?.(slot);
  }

  attach(slot: number, img: HTMLImageElement): () => void {
    const set = this.shown.get(slot) ?? new Set();
    set.add(img);
    this.shown.set(slot, set);
    const src = this.latest.get(slot);
    if (src) img.src = src;
    else img.removeAttribute("src");
    return () => set.delete(img);
  }
}

/** Moves the line between part i-1 and part i by `d` (a share of the whole), keeping each part at least `min`. */
function moveLine(sizes: number[], i: number, d: number, min = 0.18): number[] {
  const s = sizes.slice();
  const pair = s[i - 1] + s[i];
  const a = Math.max(Math.min(min, pair / 2), Math.min(pair - Math.min(min, pair / 2), s[i - 1] + d));
  s[i - 1] = a;
  s[i] = pair - a;
  return s;
}

function equal(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

/** Parts side by side (row) or one above the other (col), with lines between them that can be dragged or moved with the arrow keys. */
function Split({
  dir,
  sizes,
  onSizes,
  label,
  children,
}: {
  dir: "row" | "col";
  sizes: number[];
  onSizes: (s: number[]) => void;
  label: string;
  children: ReactNode[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const startDrag = (i: number) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !box.current) return;
    e.preventDefault();
    const rect = box.current.getBoundingClientRect();
    const total = dir === "row" ? rect.width : rect.height;
    const from = dir === "row" ? e.clientX : e.clientY;
    const initial = sizes.slice();
    const line = e.currentTarget;
    line.setPointerCapture(e.pointerId);
    document.body.classList.add(dir === "row" ? "dragging-cols" : "dragging-rows");
    const move = (ev: PointerEvent) => onSizes(moveLine(initial, i, ((dir === "row" ? ev.clientX : ev.clientY) - from) / total));
    const end = () => {
      document.body.classList.remove("dragging-cols", "dragging-rows");
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", end);
      line.removeEventListener("pointercancel", end);
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", end);
    line.addEventListener("pointercancel", end);
  };
  const key = (i: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    const back = dir === "row" ? "ArrowLeft" : "ArrowUp";
    const forward = dir === "row" ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== forward && e.key !== "Home") return;
    e.preventDefault();
    if (e.key === "Home") onSizes(equal(sizes.length));
    else onSizes(moveLine(sizes, i, e.key === forward ? 0.04 : -0.04));
  };
  return (
    <div ref={box} className={`split split-${dir}`}>
      {children.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <div
              className="split-line"
              role="separator"
              tabIndex={0}
              aria-orientation={dir === "row" ? "vertical" : "horizontal"}
              aria-label={`Resize ${label}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(sizes.slice(0, i).reduce((a, b) => a + b, 0) * 100)}
              title="Drag to resize, or use the arrow keys. Home makes the parts equal."
              onPointerDown={startDrag(i)}
              onKeyDown={key(i)}
              onDoubleClick={() => onSizes(equal(sizes.length))}
            />
          )}
          <div className="split-part" style={{ flexGrow: sizes[i] ?? 1 }}>
            {child}
          </div>
        </Fragment>
      ))}
    </div>
  );
}

function Picture({ slot, pictures }: { slot: number; pictures: Pictures }) {
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => pictures.attach(slot, img.current!), [slot, pictures]);
  return <img ref={img} alt={`What screen ${slot + 1} shows`} draggable={false} />;
}

const VIEW_LABEL = { desktop: "Desktop 1366 px", phone: "Phone 390 px" } as const;

function ShapeIcon({ shape, n }: { shape: Shape; n: number }) {
  // A small drawing of the shape: one rectangle per screen.
  const rects: [number, number, number, number][] = (() => {
    const W = 22;
    const H = 16;
    if (shape === "single" || n === 1) return [[0, 0, W, H]];
    if (shape === "cols") return tiles(0, n).map((_, i) => [(i * W) / n, 0, W / n, H]);
    if (shape === "rows") return tiles(0, n).map((_, i) => [0, (i * H) / n, W, H / n]);
    if (shape === "grid") return [[0, 0, W / 2, H / 2], [W / 2, 0, W / 2, H / 2], [0, H / 2, W / 2, H / 2], [W / 2, H / 2, W / 2, H / 2]];
    const side = n - 1;
    return [[0, 0, W * 0.62, H], ...tiles(0, side).map((_, i): [number, number, number, number] => [W * 0.62, (i * H) / side, W * 0.38, H / side])];
  })();
  return (
    <svg width="24" height="18" viewBox="-1 -1 24 18" aria-hidden="true">
      {rects.map(([x, y, w, h], i) => (
        <rect key={i} x={x + 0.75} y={y + 0.75} width={Math.max(1, w - 1.5)} height={Math.max(1, h - 1.5)} rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

export function LiveView({ runId, progress }: { runId: string; progress: string[] }) {
  const [count, setCount] = useState<number | null>(null);
  const [screens, setScreens] = useState<Record<number, LiveScreen>>({});
  const [pictured, setPictured] = useState<Record<number, boolean>>({});
  const [log, setLog] = useState<string[]>([]);
  const [link, setLink] = useState<"connecting" | "live" | "again" | "ended">("connecting");
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const [max, setMax] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const phone = useMedia("(max-width: 760px)");
  const pictures = useMemo(() => new Pictures(), []);
  const body = useRef<HTMLDivElement>(null);

  const setLayout = useCallback((change: (l: Layout) => Layout) => {
    setLayoutState((l) => {
      const next = change(l);
      saveLayout(next);
      return next;
    });
  }, []);

  useEffect(() => {
    pictures.onFirst = (slot) => setPictured((p) => ({ ...p, [slot]: true }));
    const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/live`);
    source.onopen = () => setLink("live");
    source.onerror = () => setLink((l) => (l === "ended" ? l : "again"));
    source.addEventListener("screens", (e) => setCount(JSON.parse((e as MessageEvent).data).count));
    source.addEventListener("screen", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as LiveScreen;
      setScreens((all) => ({ ...all, [s.slot]: s }));
    });
    source.addEventListener("frame", (e) => {
      const f = JSON.parse((e as MessageEvent).data) as { slot: number; img: string };
      pictures.frame(f.slot, f.img);
    });
    source.addEventListener("log", (e) => {
      const { line } = JSON.parse((e as MessageEvent).data) as { line: string };
      setLog((l) => [...l.slice(-49), line]);
    });
    source.addEventListener("end", () => {
      // The report replaces this view as soon as the run is saved; never reconnect.
      setLink("ended");
      source.close();
    });
    return () => source.close();
  }, [runId, pictures]);

  const total = count ?? 0;
  const shown = Math.max(1, Math.min(layout.panes, total || 1));
  const shape = SHAPES[shown].includes(layout.shapes[shown]) ? layout.shapes[shown] : SHAPES[shown][0];
  const slotOf = (pane: number) => {
    const s = layout.assign[pane] ?? pane;
    return total ? (s < total ? s : pane % total) : pane;
  };
  const lines = log.length ? log : progress;

  const sizesOf = (key: string, n: number, fallback?: number[]) => {
    const s = layout.sizes[`${shown}:${key}`];
    return s && s.length === n ? s : (fallback ?? equal(n));
  };
  const setSizes = (key: string) => (s: number[]) => setLayout((l) => ({ ...l, sizes: { ...l.sizes, [`${shown}:${key}`]: s } }));

  const swap = (from: number, to: number) => {
    if (from === to) return;
    setLayout((l) => {
      const assign = tiles(0, 4).map((_, i) => slotOf(i));
      [assign[from], assign[to]] = [assign[to], assign[from]];
      return { ...l, assign };
    });
  };
  const choose = (pane: number, slot: number) =>
    setLayout((l) => {
      const assign = tiles(0, 4).map((_, i) => slotOf(i));
      // Choosing a screen that another place shows swaps the two, so no screen is shown twice by accident.
      const other = assign.findIndex((s, i) => s === slot && i !== pane && i < shown);
      if (other >= 0) assign[other] = assign[pane];
      assign[pane] = slot;
      return { ...l, assign };
    });

  const tile = (pane: number) => {
    const slot = slotOf(pane);
    const s = screens[slot];
    const state = s?.state ?? "idle";
    const opening = /^(Opening the page|Waiting its turn)/.test(s?.doing ?? "");
    return (
      <section
        className={`live-tile state-${state}${dragFrom !== null && dragFrom !== pane ? " drop-target" : ""}`}
        aria-label={`Screen ${slot + 1}`}
        onDragOver={(e) => {
          if (dragFrom !== null) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (dragFrom !== null) swap(dragFrom, pane);
          setDragFrom(null);
        }}
      >
        <header className="live-tile-head">
          {!phone && max === null && shown > 1 && (
            <span
              className="live-grip"
              draggable
              title="Drag onto another screen to swap them"
              aria-hidden="true"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(pane));
                setDragFrom(pane);
              }}
              onDragEnd={() => setDragFrom(null)}
            >
              ⠿
            </span>
          )}
          <span className={`live-dot ${state}`} aria-hidden="true" />
          {total > 1 ? (
            <select className="live-pick" aria-label="Screen shown here" value={slot} onChange={(e) => choose(pane, Number(e.target.value))}>
              {tiles(0, total).map((_, i) => (
                <option key={i} value={i}>
                  Screen {i + 1}
                </option>
              ))}
            </select>
          ) : (
            <strong className="live-name">Screen {slot + 1}</strong>
          )}
          {s?.view && <span className="live-badge">{VIEW_LABEL[s.view]}</span>}
          <span className="live-doing">{s?.doing ?? "Starting the browser"}</span>
          {shown > 1 && !phone && (
            <button
              className="live-max"
              aria-label={max === pane ? "Show all screens" : `Make screen ${slot + 1} big`}
              title={max === pane ? "Show all screens" : "Make this screen big"}
              onClick={() => setMax(max === pane ? null : pane)}
            >
              {max === pane ? "⤡" : "⤢"}
            </button>
          )}
        </header>
        <div className="live-url" title={s?.url}>
          {s?.url ?? " "}
        </div>
        <div className={`live-picture${s?.view === "phone" ? " phone" : ""}${opening ? " opening" : ""}`}>
          <Picture slot={slot} pictures={pictures} />
          {!pictured[slot] ? (
            <div className="live-wait">{state === "done" ? "This screen has finished" : s?.url ? "Waiting for the first picture" : "Waiting for a page"}</div>
          ) : (
            // Until the new page paints, the picture is still the last page's: say so.
            opening && <div className="live-wait over">Opening the next page…</div>
          )}
        </div>
      </section>
    );
  };

  const render = (t: Tree): ReactNode => {
    if ("pane" in t) return tile(t.pane);
    const fallback = t.key === "main" ? [0.64, 0.36] : undefined;
    return (
      <Split dir={t.dir} sizes={sizesOf(t.key, t.children.length, fallback)} onSizes={setSizes(t.key)} label="the screens">
        {t.children.map(render)}
      </Split>
    );
  };

  const stage = (
    <div className="live-stage">
      {count === 0 ? (
        <div className="live-wait">This test has no browser screens.</div>
      ) : phone ? (
        <div className="live-stack">{tiles(0, shown).map((_, pane) => <Fragment key={pane}>{tile(pane)}</Fragment>)}</div>
      ) : max !== null && max < shown ? (
        tile(max)
      ) : (
        render(treeOf(shape, shown))
      )}
    </div>
  );

  const busyAgents = Object.values(screens).reduce((n, s) => n + (s.state === "busy" ? (s.agents?.length ?? 0) : 0), 0);
  const panel = (
    <aside className="live-panel" aria-label="What the agents are doing">
      <div className="live-panel-title">
        What the agents are doing
        <span className="muted small">{busyAgents ? ` · ${busyAgents} checking now` : ""}</span>
      </div>
      <ul className="live-screens">
        {tiles(0, total).map((_, slot) => {
          const s = screens[slot];
          return (
            <li key={slot} className={`state-${s?.state ?? "idle"}`}>
              <div className="live-screen-line">
                <span className={`live-dot ${s?.state ?? "idle"}`} aria-hidden="true" />
                <strong>Screen {slot + 1}</strong>
                <span className="muted small">{s?.doing ?? "Starting"}</span>
              </div>
              {s?.url && s.state !== "done" && <div className="live-screen-url">{s.url.replace(/^https?:\/\//, "")}</div>}
              {s?.agents && s.agents.length > 0 && (
                <div className="live-agents">
                  {s.agents.map((a) => (
                    <span key={a} className="live-agent">
                      {a}
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="live-panel-title">Progress</div>
      <ol className="live-log" aria-live="polite">
        {lines.slice(-14).map((l, i) => (
          <li key={`${lines.length - 14 + i}`}>{l}</li>
        ))}
      </ol>
    </aside>
  );

  const startHeightDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !body.current) return;
    e.preventDefault();
    const from = e.clientY;
    const initial = body.current.getBoundingClientRect().height;
    const line = e.currentTarget;
    line.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging-rows");
    const move = (ev: PointerEvent) => setLayout((l) => ({ ...l, height: Math.round(Math.max(320, Math.min(1600, initial + ev.clientY - from))) }));
    const end = () => {
      document.body.classList.remove("dragging-rows");
      line.removeEventListener("pointermove", move);
      line.removeEventListener("pointerup", end);
      line.removeEventListener("pointercancel", end);
    };
    line.addEventListener("pointermove", move);
    line.addEventListener("pointerup", end);
    line.addEventListener("pointercancel", end);
  };

  return (
    <div className="live card">
      <div className="live-toolbar">
        <div className="live-status">
          <span className={`live-signal ${link}`} aria-hidden="true" />
          <strong>{link === "again" ? "Reconnecting…" : link === "ended" ? "Finishing the report…" : "Live"}</strong>
          <span className="muted small">
            {count === null
              ? " · starting the browser"
              : count > 0
                ? ` · ${count === 1 ? "1 page" : `${count} pages`} tested at the same time`
                : ""}
          </span>
        </div>
        {total > 1 && (
          <div className="live-controls">
            <div className="seg" role="group" aria-label="Screens shown">
              {tiles(0, Math.min(4, total)).map((_, i) => (
                <button
                  key={i}
                  className={shown === i + 1 ? "on" : ""}
                  aria-pressed={shown === i + 1}
                  title={`Show ${i + 1} screen${i ? "s" : ""}`}
                  onClick={() => {
                    setMax(null);
                    setLayout((l) => ({ ...l, panes: i + 1 }));
                  }}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            {!phone && SHAPES[shown].length > 1 && (
              <div className="seg" role="group" aria-label="Shape">
                {SHAPES[shown].map((sh) => (
                  <button
                    key={sh}
                    className={shape === sh ? "on" : ""}
                    aria-pressed={shape === sh}
                    aria-label={SHAPE_LABEL[sh]}
                    title={SHAPE_LABEL[sh]}
                    onClick={() => {
                      setMax(null);
                      setLayout((l) => ({ ...l, shapes: { ...l.shapes, [shown]: sh } }));
                    }}
                  >
                    <ShapeIcon shape={sh} n={shown} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="live-controls">
          {!phone && (
            <button className="btn ghost small" aria-pressed={layout.panel} onClick={() => setLayout((l) => ({ ...l, panel: !l.panel }))}>
              {layout.panel ? "Hide activity" : "Show activity"}
            </button>
          )}
          <button
            className="btn ghost small"
            title="Back to the first layout"
            onClick={() => {
              setMax(null);
              setLayout(() => DEFAULT_LAYOUT);
            }}
          >
            Reset layout
          </button>
        </div>
      </div>
      {phone ? (
        <div className="live-body phone">
          {stage}
          {panel}
        </div>
      ) : (
        <>
          <div className="live-body" ref={body} style={{ height: layout.height }}>
            {layout.panel ? (
              <Split
                dir="row"
                sizes={[1 - layout.side, layout.side]}
                onSizes={(s) => setLayout((l) => ({ ...l, side: Math.max(0.18, Math.min(0.5, s[1])) }))}
                label="the activity panel"
              >
                {[stage, panel]}
              </Split>
            ) : (
              stage
            )}
          </div>
          <div
            className="live-height"
            role="separator"
            tabIndex={0}
            aria-orientation="horizontal"
            aria-label="Resize the height of the live view"
            title="Drag to make the live view taller or shorter"
            onPointerDown={startHeightDrag}
            onKeyDown={(e) => {
              if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
              e.preventDefault();
              setLayout((l) => ({ ...l, height: Math.max(320, Math.min(1600, l.height + (e.key === "ArrowDown" ? 40 : -40))) }));
            }}
          />
        </>
      )}
      <p className="live-note muted small">
        Pictures are sent only while this view is open, so nobody watching means a test at full speed. Nothing is recorded.
      </p>
    </div>
  );
}
