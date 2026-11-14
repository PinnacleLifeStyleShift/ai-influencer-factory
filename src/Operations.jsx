import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Operations (owner): the generation switch and every open obligation.
 *
 * WHY: when something looks wrong the owner needs one place that says what
 * may have been charged or posted, what was paid but not applied, and what
 * the next permitted action is, and a switch that stops NEW provider
 * submissions without touching the reconciliation of earlier work.
 * Rows carry ids and states only, never tokens or provider payloads.
 */
const card = "bg-[#13131a] border border-[#2a2a3a] rounded-xl p-4 mb-4";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const ghost = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-200 disabled:opacity-50 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const age = (s) => (s < 120 ? `${s} s` : s < 7200 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`);
const money = (m, c) => `${(m / 1e6).toFixed(2)} ${c}`;

export default function Operations() {
  const [view, setView] = useState(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setView(await api.system.operations()), []);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load]);

  const toggle = async (paused) => {
    if (!window.confirm(paused ? "Pause all new generation? Work already accepted can still be checked and resolved." : "Resume generation?")) return;
    setBusy(true); setMessage("");
    try { await api.system.setGenerationPause(paused, reason); setReason(""); setMessage(paused ? "New generation paused" : "Generation resumed"); }
    catch (e) { setMessage(e.message); } finally { setBusy(false); await load().catch(() => {}); }
  };
  if (!view) return <div className="p-6 text-sm text-zinc-500">{message || "Loading…"}</div>;
  const g = view.generation;
  const s = view.summary;
  return (
    <div className="p-3 sm:p-6 max-w-[1200px] mx-auto">
      <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-3xl text-zinc-100">Operations</h1>
      <p className="text-zinc-500 text-sm mb-4">Open obligations and the generation switch. Nothing here is erased by pausing.</p>

      <section className={card} aria-label="Generation switch">
        <div className={`text-sm font-semibold ${g.paused ? "text-red-300" : "text-green-400"}`}>
          {g.paused ? `New generation is paused: ${g.reason}` : "New generation is allowed (subject to the spending gate)"}
        </div>
        <div className="flex flex-wrap gap-2 items-end mt-2">
          <label className="text-[11px] text-zinc-400 flex-1 min-w-[200px]">Reason (recorded)
            <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          {g.paused
            ? <button className={ghost} disabled={busy || reason.trim().length < 3} onClick={() => toggle(false)}>Resume generation</button>
            : <button className={`${ghost} text-red-300`} disabled={busy || reason.trim().length < 3} onClick={() => toggle(true)}>Pause new generation</button>}
        </div>
      </section>

      <section className={card} aria-label="Summary">
        <dl className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
          {[["Open obligations", s.openObligations], ["Oldest", s.openObligations ? age(s.oldestAgeSec) : "—"], ["Unknown outcomes", s.unknownOutcomes],
            ["Failed settlements", s.failedSettlements], ["Paid, not applied", s.unappliedResults]].map(([k, v]) => (
            <div key={k}><dt className="text-zinc-500">{k}</dt><dd className="text-zinc-100 text-lg">{v}</dd></div>
          ))}
        </dl>
        <div className="text-[11px] text-zinc-400 mt-2">
          Retained money: {Object.keys(s.retainedReservations).length
            ? Object.entries(s.retainedReservations).map(([c, x]) => `${money(x.outcomeUnknownMicros, c)} uncertain, ${money(x.reservedMicros, c)} reserved`).join("; ")
            : "none"}
        </div>
      </section>

      <section className={card} aria-label="Open obligations">
        {view.rows.length === 0 ? <div className="text-xs text-zinc-500">Nothing open.</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[11px] text-zinc-300">
              <thead><tr className="text-left text-zinc-500"><th>What</th><th>Package</th><th>Age</th><th>Last safe state</th><th>Next permitted action</th><th>Owner</th><th>Money</th></tr></thead>
              <tbody>{view.rows.map((r) => (
                <tr key={`${r.type}-${r.id}`} className="align-top border-t border-[#2a2a3a]">
                  <td>{r.type.replaceAll("_", " ")}{r.platform ? ` · ${r.platform}` : ""}{r.provider ? ` · ${r.provider}` : ""}</td>
                  <td className="font-mono">{r.package.id.slice(0, 12)}</td>
                  <td>{age(r.ageSec)}</td>
                  <td>{r.lastSafeState}</td>
                  <td>{r.nextAction}</td>
                  <td>{r.evidenceOwner || "owner"}</td>
                  <td>{r.money ? `${money(r.money.reservedMicros, r.money.currency)} (${r.money.state.replaceAll("_", " ")})` : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      <Capabilities />
      <TeamAccess />
      {message && <div className="text-xs text-zinc-300" role="status">{message}</div>}
    </div>
  );
}

/**
 * Team access: single-use, expiring invites for editors and reviewers.
 * The code is shown once here and nowhere else (the server keeps a hash).
 * Off unless the owner sets ROLE_INVITES=enabled; then the panel says so.
 */
function TeamAccess() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState({ role: "reviewer", label: "", ttlHours: 24 });
  const [issued, setIssued] = useState(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setData(await api.invites.list()), []);
  useEffect(() => { load().catch((e) => setStatus(e.message)); }, [load]);
  const create = async (e) => {
    e.preventDefault();
    setBusy(true); setStatus(""); setIssued(null);
    try {
      const r = await api.invites.create({ role: form.role, label: form.label, ttlHours: Number(form.ttlHours) });
      setIssued(r); setForm((f) => ({ ...f, label: "" })); setStatus("Invite created");
    } catch (err) { setStatus(err.message); } finally { setBusy(false); await load().catch(() => {}); }
  };
  const revoke = async (id) => {
    if (!window.confirm("Revoke this invite? Anyone signed in with it is signed out.")) return;
    try { const r = await api.invites.revoke(id); setStatus(`Invite revoked; ${r.sessionsRevoked} session(s) ended`); } catch (err) { setStatus(err.message); }
    await load().catch(() => {});
  };
  const state = (i) => (i.revokedAt ? "revoked" : i.usedAt ? "used" : new Date(i.expiresAt) <= new Date() ? "expired" : "unused");
  return (
    <section className={card} aria-label="Team access">
      <h2 className="text-sm text-zinc-200 mb-1">Team access</h2>
      <p className="text-[11px] text-zinc-500 mb-3">A single-use code for an editor or reviewer. It works once, expires, and can be revoked. Owners sign in only with the owner token.</p>
      {data && !data.enabled && <div className="text-[11px] text-amber-300 mb-2" role="note">Invites are off. Issuing credentials is an owner decision: set ROLE_INVITES=enabled on the API to allow them.</div>}
      <form onSubmit={create} className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
        <label className="text-[11px] text-zinc-400">Role
          <select className={input} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="reviewer">Reviewer (read, approve)</option>
            <option value="editor">Editor (edit, references, schedule, export)</option>
          </select>
        </label>
        <label className="text-[11px] text-zinc-400 sm:col-span-2">Who it is for
          <input className={input} value={form.label} maxLength={80} onChange={(e) => setForm({ ...form, label: e.target.value })} required />
        </label>
        <label className="text-[11px] text-zinc-400">Valid for (hours)
          <input className={input} type="number" min={1} max={72} value={form.ttlHours} onChange={(e) => setForm({ ...form, ttlHours: e.target.value })} />
        </label>
        <button type="submit" className={ghost} disabled={busy || !data?.enabled}>{busy ? "Creating…" : "Create invite"}</button>
      </form>
      {issued && (
        <div className="mt-3 text-[11px] text-zinc-300" role="alert">
          Code for {issued.invite.label} ({issued.invite.role}), shown once. Send it privately; it expires {new Date(issued.invite.expiresAt).toLocaleString()}.
          <input readOnly aria-label="Invite code" className={`${input} font-mono mt-1`} value={issued.code} onFocus={(e) => e.target.select()} />
        </div>
      )}
      {data?.invites?.length > 0 && (
        <div className="overflow-x-auto mt-3">
          <table className="w-full min-w-[560px] text-[11px] text-zinc-300" aria-label="Invites">
            <thead><tr className="text-left text-zinc-500"><th>For</th><th>Role</th><th>State</th><th>Expires</th><th></th></tr></thead>
            <tbody>{data.invites.map((i) => (
              <tr key={i.id} className="border-t border-[#2a2a3a]">
                <td>{i.label}</td><td>{i.role}</td><td>{state(i)}</td><td>{new Date(i.expiresAt).toLocaleString()}</td>
                <td>{!i.revokedAt && <button className="underline" onClick={() => revoke(i.id)}>Revoke</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {status && <div className="text-[11px] text-zinc-300 mt-2" role="status">{status}</div>}
    </section>
  );
}

/**
 * What is built, configured, switched on and verified, per live capability.
 * A green build or a configured key is not "live"; this says which is which.
 * The server sends setting names only, never values.
 */
function Capabilities() {
  const [caps, setCaps] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { api.system.capabilities().then((r) => setCaps(r.capabilities)).catch((e) => setError(e.message)); }, []);
  const yes = (v, on, off) => <span className={v ? "text-green-400" : "text-zinc-400"}>{v ? `✓ ${on}` : `✗ ${off}`}</span>;
  return (
    <section className={card} aria-label="Capabilities">
      <h2 className="text-sm text-zinc-200 mb-1">Capabilities</h2>
      <p className="text-[11px] text-zinc-500 mb-3">Built is not configured, configured is not switched on, and switched on is not verified with a real provider.</p>
      {error && <div className="text-[11px] text-zinc-300" role="status">{error}</div>}
      {!caps && !error && <div className="text-[11px] text-zinc-500">Loading…</div>}
      {caps && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-[11px] text-zinc-300" aria-label="Capability states">
            <thead><tr className="text-left text-zinc-500"><th>Capability</th><th>Built</th><th>Configured</th><th>Switched on</th><th>Verified by</th><th>Needs</th></tr></thead>
            <tbody>{caps.map((c) => (
              <tr key={c.key} className="align-top border-t border-[#2a2a3a]">
                <td className="pr-2">{c.label}</td>
                <td className="pr-2">{c.built}</td>
                <td className="pr-2">{c.missing.length || c.configured ? yes(c.configured, "yes", `missing ${c.missing.join(", ")}`) : <span className="text-zinc-400">not applicable</span>}</td>
                <td className="pr-2">{yes(c.enabled, "on", "off")}</td>
                <td className="pr-2">{c.verifiedBy}</td>
                <td>{c.needs}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
