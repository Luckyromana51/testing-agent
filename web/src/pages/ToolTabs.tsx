import { useState } from "react";
import type { AgentInfo } from "../../../src/agents/types.ts";
import type { ToolChoice } from "../../../src/tools/types.ts";
import type { ProductType } from "../../../src/types.ts";
import type { Meta, MetaTool } from "../api.ts";
import { CATEGORY_LABEL } from "../lib.ts";

/** Which tools are on, and their options, while the tester is choosing. */
export type ToolDraft = Record<string, { on: boolean; options: Record<string, string> }>;

export function toolsForType(meta: Meta, type: ProductType): MetaTool[] {
  return meta.tools.filter((t) => t.products.includes(type));
}

/**
 * The starting choice: a project's saved tools, or else every safe tool that is installed here
 * (the same default the server uses).
 */
export function toolDraft(meta: Meta, type: ProductType, saved?: ToolChoice[]): ToolDraft {
  const draft: ToolDraft = {};
  for (const t of toolsForType(meta, type)) {
    const s = saved?.find((c) => c.id === t.id);
    draft[t.id] = {
      on: saved ? Boolean(s) : t.ready && t.safety === "safe",
      options: Object.fromEntries((t.options ?? []).map((o) => [o.id, s?.options?.[o.id] ?? o.default])),
    };
  }
  return draft;
}

export function toolChoices(meta: Meta, draft: ToolDraft): ToolChoice[] {
  return Object.entries(draft)
    .filter(([, d]) => d.on)
    .map(([id, d]) => {
      const tool = meta.tools.find((t) => t.id === id);
      const options = Object.fromEntries(Object.entries(d.options).filter(([k, v]) => tool?.options?.find((o) => o.id === k)?.default !== v));
      return { id, ...(Object.keys(options).length ? { options } : {}) };
    });
}

/**
 * One tab for the platform's own checks, then one tab per outside tool that fits the product
 * type: what it checks, whether it is safe, its options, and a switch to run it.
 */
export function ToolTabs({
  meta,
  type,
  agents,
  draft,
  onChange,
}: {
  meta: Meta;
  type: ProductType;
  agents: AgentInfo[];
  draft: ToolDraft;
  onChange: (d: ToolDraft) => void;
}) {
  const tools = toolsForType(meta, type);
  const [active, setActive] = useState("glv");
  const tool = tools.find((t) => t.id === active);
  const set = (id: string, patch: Partial<ToolDraft[string]>) => onChange({ ...draft, [id]: { ...draft[id], ...patch } });

  return (
    <div className="tool-tabs-wrap">
      <div className="tool-tabs" role="tablist" aria-label="Tests to run">
        <button type="button" role="tab" aria-selected={active === "glv"} className={active === "glv" ? "active" : ""} onClick={() => setActive("glv")}>
          <span className="tool-dot on" />
          GLV checks <span className="tab-count">{agents.length}</span>
        </button>
        {tools.map((t) => (
          <button
            type="button"
            role="tab"
            key={t.id}
            aria-selected={active === t.id}
            className={active === t.id ? "active" : ""}
            onClick={() => setActive(t.id)}
            title={draft[t.id]?.on ? `${t.name} is on` : `${t.name} is off`}
          >
            <span className={`tool-dot ${draft[t.id]?.on ? "on" : t.ready ? "off" : "missing"}`} />
            {t.name}
          </button>
        ))}
      </div>

      <div className="tool-panel" role="tabpanel">
        {!tool ? (
          <>
            <div className="tool-head">
              <div className="grow">
                <div className="tool-name">GLV checks</div>
                <div className="muted small">The platform's own specialist agents · always on</div>
              </div>
              <span className="safety safe">Safe</span>
            </div>
            <div className="agent-chips">
              {agents.map((a) => (
                <div className="agent-chip" key={a.id} title={a.description}>
                  <span className={`cat-dot cat-${a.category}`} />
                  {a.name}
                  <span className="muted"> · {CATEGORY_LABEL[a.category]}</span>
                </div>
              ))}
            </div>
            {tools.length > 0 && <p className="muted small">The other tabs add outside tools to the same test. Their findings join this report and the Issues board.</p>}
          </>
        ) : (
          <>
            <div className="tool-head">
              <div className="grow">
                <div className="tool-name">{tool.name}</div>
                <div className="muted small">
                  {tool.maker} · {tool.licence} · {tool.takes}
                </div>
              </div>
              <span className={`safety ${tool.safety}`}>{tool.safety === "safe" ? "Safe: no attacks" : "Needs permission"}</span>
            </div>
            <p className="tool-desc">{tool.description}</p>
            <ul className="tool-checks">
              {tool.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="muted small">
              {tool.signedIn === "uses-login"
                ? "With a saved login, it tests the signed-in pages too, using the same session."
                : "Tests what anyone on the internet can reach; it does not use the saved login."}{" "}
              Findings count towards {CATEGORY_LABEL[tool.category]}.
            </div>
            {(tool.options ?? []).length > 0 && (
              <div className="form-row tool-options">
                {tool.options!.map((o) => (
                  <label className="form-field" key={o.id}>
                    <span>{o.label}</span>
                    <select
                      className="input"
                      value={draft[tool.id]?.options[o.id] ?? o.default}
                      disabled={!tool.ready}
                      onChange={(e) => set(tool.id, { options: { ...draft[tool.id].options, [o.id]: e.target.value } })}
                    >
                      {o.choices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            {!tool.ready && <div className="tool-missing">Not available on this server: {tool.notReady}</div>}
            <div className="tool-foot">
              <label className="check dark">
                <input type="checkbox" checked={Boolean(draft[tool.id]?.on)} disabled={!tool.ready && !draft[tool.id]?.on} onChange={(e) => set(tool.id, { on: e.target.checked })} /> Run{" "}
                {tool.name} in this test
              </label>
              <a href={tool.homepage} target="_blank" rel="noreferrer" className="small">
                About {tool.name} ↗
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
