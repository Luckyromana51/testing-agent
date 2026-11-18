import { useState } from "react";
import type { PermissionKind } from "../../../src/permission.ts";
import { api, type PermissionDraft, type PermissionView, type ProjectSummary, type ProofCheck } from "../api.ts";

const STATUS: Record<PermissionView["status"], string> = {
  active: "Active",
  "waiting-proof": "Waiting for the proof file",
  scheduled: "Starts later",
  expired: "Ended",
  revoked: "Withdrawn",
};

const KIND: Record<PermissionKind, string> = { load: "Load tests", attack: "Attack tests" };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const dateInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "2026-11-18" as the start (00:00) or end (23:59:59) of that day where the owner is. */
const dayEdge = (value: string, end: boolean) => {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0).toISOString();
};

/**
 * The client's written permission for load and attack tests: what the owner recorded, the
 * proof file the client puts on each address, and where each permission stands.
 */
export function PermissionCard({ project, isOwner, onChanged }: { project: ProjectSummary; isOwner: boolean; onChanged: () => void }) {
  const list = [...(project.permissions ?? [])].reverse();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [checks, setChecks] = useState<Record<string, ProofCheck[]>>({});
  const [busy, setBusy] = useState("");
  // The exact host, www included: the permission covers exactly what the client names.
  const host = (() => {
    try {
      return new URL(project.target.url ?? project.target.specUrl ?? "").host;
    } catch {
      return "";
    }
  })();

  const check = async (pid: string) => {
    setBusy(pid);
    setError("");
    try {
      const res = await api.checkPermission(project.id, pid);
      setChecks((c) => ({ ...c, [pid]: res.checks }));
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card permission-card">
      <p className="muted small permission-intro">
        Load tests (k6, JMeter) and attack tests (ZAP's active scan, GLV's attack probes) send far more than a visitor would. They run only with the
        client's written permission: on the addresses it names, between its dates, within its limits, and while the client keeps a proof file on each
        address. The proof is checked again before every test, and these tests never run on the schedule.
      </p>
      {list.length === 0 && !adding && <div className="muted">No permission yet: the load and attack tools stay off.</div>}
      {list.map((p) => (
        <div className={`permission ${p.status}`} key={p.id}>
          <div className="permission-head">
            <span className={`permit-status ${p.status}`}>{STATUS[p.status]}</span>
            <strong>{p.kinds.map((k, i) => (i ? KIND[k].toLowerCase() : KIND[k])).join(" and ")}</strong>
            <span className="muted small">
              {day(p.from)} to {day(p.until)}
            </span>
            <span className="grow" />
            {p.status !== "revoked" && p.status !== "expired" && (
              <button className="btn small" disabled={busy === p.id} onClick={() => check(p.id)}>
                {busy === p.id ? "Checking…" : "Check the proof"}
              </button>
            )}
            {isOwner && p.status !== "revoked" && (
              <button
                className="btn ghost danger small"
                onClick={async () => {
                  if (!window.confirm("Withdraw this permission? Load and attack tools it covers are turned off for this project.")) return;
                  try {
                    await api.revokePermission(project.id, p.id);
                    onChanged();
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              >
                Withdraw
              </button>
            )}
          </div>
          <dl className="permission-facts">
            <dt>Given by</dt>
            <dd>{p.grantedBy}</dd>
            <dt>In writing</dt>
            <dd>{p.reference}</dd>
            <dt>Limits</dt>
            <dd>
              Up to {p.maxUsers} users at once, {p.maxMinutes} minutes a test{p.writes ? "; test data may be created or changed" : "; reading only (GET)"}
            </dd>
            <dt>Addresses</dt>
            <dd>
              {p.hosts.map((h) => (
                <span key={h} className={`proof-host ${p.proofs[h] ? "ok" : "missing"}`} title={p.proofs[h] ? `Proof found by ${p.proofs[h].method === "dns" ? "DNS record" : "file"} on ${day(p.proofs[h].at)}` : "No proof yet"}>
                  {p.proofs[h] ? "✓" : "✗"} {h}
                </span>
              ))}
            </dd>
            <dt>Recorded by</dt>
            <dd>
              {p.createdBy} on {day(p.createdAt)}
              {p.revokedAt ? ` · withdrawn by ${p.revokedBy} on ${day(p.revokedAt)}` : ""}
            </dd>
          </dl>
          {p.status === "waiting-proof" && (
            <div className="proof-steps">
              <div>
                <strong>Ask the client to add the proof.</strong> On each address, a file at <code>/.well-known/glv-testing.txt</code> holding this line:
              </div>
              <div className="proof-token">
                <code>{p.token}</code>
                <button className="btn ghost small" onClick={() => navigator.clipboard?.writeText(p.token)}>
                  Copy
                </button>
              </div>
              <div className="muted small">
                For example <code>https://{p.hosts.find((h) => !p.proofs[h]) ?? p.hosts[0]}/.well-known/glv-testing.txt</code>. Or a DNS TXT record named{" "}
                <code>_glv-testing.{(p.hosts.find((h) => !p.proofs[h]) ?? p.hosts[0]).replace(/:\d+$/, "")}</code> with the same line. Then press Check the proof.
              </div>
            </div>
          )}
          {checks[p.id] && (
            <ul className="proof-results">
              {checks[p.id].map((c) => (
                <li key={c.host} className={c.ok ? "ok" : "bad"}>
                  {c.ok ? `✓ ${c.host}: found (${c.method === "dns" ? "DNS record" : "file"})` : `✗ ${c.host}: ${c.error}`}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {error && <div className="error">{error}</div>}
      {adding ? (
        <PermissionForm
          projectId={project.id}
          host={host}
          onDone={(saved) => {
            setAdding(false);
            if (saved) {
              setChecks((c) => ({ ...c, [saved.id]: saved.checks }));
              onChanged();
            }
          }}
        />
      ) : isOwner ? (
        <div className="form-actions">
          <button className="btn" onClick={() => setAdding(true)}>
            Add the client's permission
          </button>
        </div>
      ) : (
        <div className="muted small">Only the owner can record a permission.</div>
      )}
    </div>
  );
}

function PermissionForm({ projectId, host, onDone }: { projectId: string; host: string; onDone: (saved?: { id: string; checks: ProofCheck[] }) => void }) {
  const today = new Date();
  const [hosts, setHosts] = useState(host);
  const [kinds, setKinds] = useState<PermissionKind[]>(["load", "attack"]);
  const [grantedBy, setGrantedBy] = useState("");
  const [reference, setReference] = useState("");
  const [from, setFrom] = useState(dateInput(today));
  const [until, setUntil] = useState(dateInput(new Date(today.getTime() + 30 * 86_400_000)));
  const [maxUsers, setMaxUsers] = useState(100);
  const [maxMinutes, setMaxMinutes] = useState(30);
  const [writes, setWrites] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toggle = (k: PermissionKind, on: boolean) => setKinds((ks) => (on ? [...new Set([...ks, k])] : ks.filter((x) => x !== k)));

  return (
    <form
      className="form permission-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const draft: PermissionDraft = {
          hosts: hosts.split(/[\s,]+/).filter(Boolean),
          kinds,
          grantedBy,
          reference,
          writes,
          maxUsers,
          maxMinutes,
          from: dayEdge(from, false),
          until: dayEdge(until, true),
          confirm,
        };
        try {
          const res = await api.addPermission(projectId, draft);
          onDone({ id: res.permissionId, checks: res.checks });
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="form-field">
        <span>Addresses the client allows</span>
        <input className="input" value={hosts} onChange={(e) => setHosts(e.target.value)} placeholder="shop.example.com, www.example.com" />
        <span className="muted small">Exact host names, separated by commas. www.example.com and example.com are different addresses.</span>
      </label>
      <div className="form-field">
        <span>What the client allows</span>
        <label className="check dark">
          <input type="checkbox" checked={kinds.includes("load")} onChange={(e) => toggle("load", e.target.checked)} /> Load tests: many users at once (k6, JMeter)
        </label>
        <label className="check dark">
          <input type="checkbox" checked={kinds.includes("attack")} onChange={(e) => toggle("attack", e.target.checked)} /> Attack tests: security scans that try to break in
          (ZAP active, GLV probes)
        </label>
      </div>
      <div className="form-row">
        <label className="form-field">
          <span>Who gave permission</span>
          <input className="input" value={grantedBy} onChange={(e) => setGrantedBy(e.target.value)} placeholder="Name and role, e.g. Ravi Kumar, CTO" />
        </label>
        <label className="form-field">
          <span>Where it is written down</span>
          <input className="input" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. Email of 18 Nov 2026, or work order WO-12" />
        </label>
      </div>
      <div className="form-row">
        <label className="form-field">
          <span>First day</span>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="form-field">
          <span>Last day</span>
          <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <label className="form-field">
          <span>Most users at once</span>
          <input className="input" type="number" min={1} max={1000} value={maxUsers} onChange={(e) => setMaxUsers(Number(e.target.value))} />
        </label>
        <label className="form-field">
          <span>Longest test (minutes)</span>
          <input className="input" type="number" min={1} max={120} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value))} />
        </label>
      </div>
      <label className="check dark">
        <input type="checkbox" checked={writes} onChange={(e) => setWrites(e.target.checked)} /> The client also allows test data to be created or changed (POST, PUT
        and DELETE in JMeter plans)
      </label>
      <label className="check dark confirm-line">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I have this permission in writing from someone who can give it
        for these addresses
      </label>
      <div className="form-actions">
        <button className="btn primary" disabled={busy || !confirm || kinds.length === 0}>
          {busy ? "Saving…" : "Save permission"}
        </button>
        <button type="button" className="btn ghost" onClick={() => onDone()}>
          Cancel
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    </form>
  );
}
