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
              <thead><tr className="text-left text-zinc-500"><th>What</th><th>Package</th><th>Age</th><th>Last safe state</th><th>Next permitted action</th><th>Money</th></tr></thead>
              <tbody>{view.rows.map((r) => (
                <tr key={`${r.type}-${r.id}`} className="align-top border-t border-[#2a2a3a]">
                  <td>{r.type.replaceAll("_", " ")}{r.platform ? ` · ${r.platform}` : ""}{r.provider ? ` · ${r.provider}` : ""}</td>
                  <td className="font-mono">{r.package.id.slice(0, 12)}</td>
                  <td>{age(r.ageSec)}</td>
                  <td>{r.lastSafeState}</td>
                  <td>{r.nextAction}</td>
                  <td>{r.money ? `${money(r.money.reservedMicros, r.money.currency)} (${r.money.state.replaceAll("_", " ")})` : "—"}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {message && <div className="text-xs text-zinc-300" role="status">{message}</div>}
    </div>
  );
}
