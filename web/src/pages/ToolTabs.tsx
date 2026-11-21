import { useState } from "react";
import type { AgentInfo } from "../../../src/agents/types.ts";
import type { ToolChoice } from "../../../src/tools/types.ts";
import type { ProductType } from "../../../src/types.ts";
import { api, type Meta, type MetaTool, type PermissionView } from "../api.ts";
import { CATEGORY_LABEL } from "../lib.ts";

const WEB_PRODUCTS: ProductType[] = ["website", "ecommerce", "webapp", "saas", "crm"];

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
    const needsFile = (t.options ?? []).some((o) => o.required);
    draft[t.id] = {
      // Tools on the Mac helper take over a Mac's screen (VoiceOver speaks): only when chosen.
      on: saved ? Boolean(s) : t.ready && t.safety === "safe" && !needsFile && !t.needsMac && !t.needsDevice,
      options: Object.fromEntries(
        (t.options ?? []).flatMap((o) => [
          [o.id, s?.options?.[o.id] ?? o.default],
          ...(o.kind === "file" && s?.options?.[`${o.id}:name`] ? [[`${o.id}:name`, s.options[`${o.id}:name`]]] : []),
        ]),
      ),
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
/** The client's permission a load or attack tool can use: not withdrawn and not over (the server checks the proof again before each test). */
export function usablePermission(permissions: PermissionView[] | undefined, tool: MetaTool): PermissionView | undefined {
  if (tool.safety !== "permission") return undefined;
  const now = Date.now();
  return (permissions ?? [])
    .filter((p) => p.kinds.includes(tool.permission ?? "attack") && !p.revokedAt && Date.parse(p.until) >= now)
    .sort((a, b) => b.maxUsers - a.maxUsers)[0];
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function ToolTabs({
  meta,
  type,
  agents,
  draft,
  onChange,
  permissions,
}: {
  meta: Meta;
  type: ProductType;
  agents: AgentInfo[];
  draft: ToolDraft;
  onChange: (d: ToolDraft) => void;
  /** The project's permissions for load and attack tests; undefined before the project exists. */
  permissions?: PermissionView[];
}) {
  const tools = toolsForType(meta, type);
  const [active, setActive] = useState("glv");
  const tool = tools.find((t) => t.id === active);
  const set = (id: string, patch: Partial<ToolDraft[string]>) => onChange({ ...draft, [id]: { ...draft[id], ...patch } });
  const [uploading, setUploading] = useState<string>();
  const [uploadError, setUploadError] = useState<string>();
  const missingFile = tool ? (tool.options ?? []).some((o) => o.required && !draft[tool.id]?.options[o.id]) : false;
  const permit = tool ? usablePermission(permissions, tool) : undefined;
  const needsPermit = tool?.safety === "permission" && !permit;
  const overLimit = (o: { id: string }, value: string) =>
    Boolean(permit && tool && ((tool.limits?.users === o.id && Number(value) > permit.maxUsers) || (tool.limits?.minutes === o.id && Number(value) > permit.maxMinutes)));
  const loginNote = (t: MetaTool) =>
    t.needsDevice
      ? "Runs on a test phone from Owner panel > Test phones. With a saved app login, it signs in and tests the screens behind it too."
      : t.needsMac
      ? `Runs on GLV's Mac helper: the Mac opens ${type === "ios" ? "the app" : "the pages"} and sends back what it saw.${WEB_PRODUCTS.includes(type) ? " It tests what anyone can reach, without the saved login." : ""}`
      : WEB_PRODUCTS.includes(type)
      ? t.signedIn === "uses-login"
        ? "With a saved login, it tests the signed-in pages too, using the same session."
        : "Tests what anyone on the internet can reach; it does not use the saved login."
      : type === "api"
        ? t.signedIn === "uses-login"
          ? "Uses the project's saved API login."
          : "Does not use the saved login."
        : t.signedIn === "uses-login"
          ? "Reads the code on this server; uses the saved Git token only to download more history."
          : "Reads the code on this server; nothing is sent to the client's systems.";

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
              {tool.needsMac && <span className="safety mac">Mac helper</span>}
              {tool.needsDevice && <span className="safety mac">Test phone</span>}
              <span className={`safety ${tool.safety}`}>{tool.safety === "safe" ? "Safe: no attacks" : "Needs permission"}</span>
            </div>
            <p className="tool-desc">{tool.description}</p>
            <ul className="tool-checks">
              {tool.checks.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <div className="muted small">
              {loginNote(tool)} Findings count towards {CATEGORY_LABEL[tool.category]}.
            </div>
            {(tool.options ?? []).length > 0 && (
              <div className="form-row tool-options">
                {tool.options!.map((o) =>
                  o.kind === "file" ? (
                    <div className="form-field tool-file" key={o.id}>
                      <span>{o.label}</span>
                      <label className={`btn ${draft[tool.id]?.options[o.id] ? "" : "primary"} small`}>
                        {uploading === o.id ? "Uploading…" : draft[tool.id]?.options[o.id] ? "Replace file" : `Upload ${o.accept ?? ""} file`}
                        <input
                          type="file"
                          accept={o.accept}
                          hidden
                          disabled={!tool.ready || needsPermit || uploading === o.id}
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            e.target.value = "";
                            if (!file) return;
                            setUploading(o.id);
                            setUploadError(undefined);
                            try {
                              const up = await api.upload(file);
                              set(tool.id, { on: true, options: { ...draft[tool.id].options, [o.id]: up.file, [`${o.id}:name`]: up.fileName } });
                            } catch (err) {
                              setUploadError((err as Error).message);
                            } finally {
                              setUploading(undefined);
                            }
                          }}
                        />
                      </label>
                      <span className="small">
                        {draft[tool.id]?.options[o.id] ? (
                          <>
                            Using <strong>{draft[tool.id].options[`${o.id}:name`] ?? "the uploaded file"}</strong>
                          </>
                        ) : (
                          "Nothing uploaded yet."
                        )}
                      </span>
                      {o.hint && <span className="muted small">{o.hint}</span>}
                      {uploadError && <span className="error-text small">{uploadError}</span>}
                    </div>
                  ) : o.kind === "toggles" ? (
                    <div className="form-field tool-toggles" key={o.id}>
                      <span>{o.label}</span>
                      <div className="toggle-grid">
                        {o.choices.map((c) => {
                          const on = (draft[tool.id]?.options[o.id] ?? o.default).split(",").map((s) => s.trim()).filter(Boolean);
                          const checked = on.includes(c.value);
                          return (
                            <label className="check" key={c.value}>
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!tool.ready}
                                onChange={(e) => {
                                  const next = new Set(on);
                                  if (e.target.checked) next.add(c.value);
                                  else next.delete(c.value);
                                  const ordered = o.choices.map((ch) => ch.value).filter((v) => next.has(v));
                                  set(tool.id, { options: { ...draft[tool.id].options, [o.id]: ordered.join(",") } });
                                }}
                              />{" "}
                              {c.label}
                            </label>
                          );
                        })}
                      </div>
                      {o.hint && <span className="muted small">{o.hint}</span>}
                    </div>
                  ) : (
                  <label className="form-field" key={o.id}>
                    <span>{o.label}</span>
                    <select
                      className="input"
                      value={draft[tool.id]?.options[o.id] ?? o.default}
                      disabled={!tool.ready}
                      onChange={(e) => set(tool.id, { options: { ...draft[tool.id].options, [o.id]: e.target.value } })}
                    >
                      {o.choices.map((c) => (
                        <option key={c.value} value={c.value} disabled={overLimit(o, c.value)}>
                          {c.label}
                          {overLimit(o, c.value) ? " (over the client's limit)" : ""}
                        </option>
                      ))}
                    </select>
                    {o.hint && <span className="muted small">{o.hint}</span>}
                  </label>
                  ),
                )}
              </div>
            )}
            {tool.safety === "permission" &&
              (permit ? (
                <div className={`permit-note ${permit.status === "active" ? "ok" : ""}`}>
                  <strong>Allowed by {permit.grantedBy}</strong> until {day(permit.until)}: up to {permit.maxUsers} users, {permit.maxMinutes} minutes.{" "}
                  {permit.status === "active"
                    ? "The proof is in place; it is checked again before each test."
                    : permit.status === "scheduled"
                      ? `It starts on ${day(permit.from)}.`
                      : "Waiting for the client's proof file: the test will not run until it is in place."}{" "}
                  Runs only when someone starts a test, never on the schedule.
                </div>
              ) : (
                <div className="tool-missing">
                  Needs the client's written permission for {tool.permission === "load" ? "load tests" : "attack tests"}.{" "}
                  {permissions === undefined
                    ? "Create the project first; then the owner adds the permission on the project page."
                    : "The owner adds it under \"Load and attack tests\" on this page."}
                </div>
              ))}
            {!tool.ready && <div className="tool-missing">Not available on this server: {tool.notReady}</div>}
            <div className="tool-foot">
              <label className="check dark">
                <input
                  type="checkbox"
                  checked={Boolean(draft[tool.id]?.on)}
                  disabled={(!tool.ready || missingFile || needsPermit) && !draft[tool.id]?.on}
                  onChange={(e) => set(tool.id, { on: e.target.checked })}
                />{" "}
                Run {tool.name} in this test{missingFile && !draft[tool.id]?.on ? " (upload the file first)" : ""}
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
