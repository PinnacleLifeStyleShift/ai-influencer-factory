import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Generation jobs and reconciliation.
 *
 * WHY separate, named states: "the provider may have charged us and we do not
 * know" (outcome unknown), "we were charged but could not record it"
 * (settlement failed), "we have the result but could not apply it"
 * (application failed) and "the result arrived after newer work" (superseded)
 * need different actions, so they are never shown as one generic "failed".
 * Reading is open; checking, resolving and recovery are owner actions
 * enforced by the server.
 */
const STATE_INFO = {
  pending: ["Waiting", "text-zinc-400"],
  reserved: ["Money reserved, not sent", "text-zinc-300"],
  submitting: ["Sending to provider", "text-blue-300"],
  accepted: ["Accepted by provider", "text-blue-300"],
  succeeded: ["Paid, result stored, not applied yet", "text-amber-300"],
  applied: ["Applied", "text-green-400"],
  replayed: ["Reused an earlier result (no charge)", "text-green-400"],
  not_submitted: ["Never sent (money released)", "text-zinc-400"],
  outcome_unknown: ["Outcome unknown: may have been charged", "text-red-400"],
  settlement_failed: ["Charged but not recorded", "text-red-400"],
  application_failed: ["Paid result not applied", "text-amber-300"],
  superseded: ["Result arrived after newer work (kept, not applied)", "text-amber-300"],
  resolved_not_charged: ["Resolved: not charged", "text-zinc-300"],
  resolved_charged_no_result: ["Resolved: charged, no result", "text-zinc-300"],
  resolved_charged_with_result: ["Resolved: charged, result recovered", "text-green-300"],
};
const JOB_STATES = ["", "awaiting_reconciliation", "awaiting_application", "running", "succeeded", "failed"];
const UNCERTAIN = ["outcome_unknown", "settlement_failed", "submitting", "accepted"];
const money = (micros, currency) => (micros === null || micros === undefined ? "—" : `${(micros / 1e6).toFixed(2)} ${currency || ""}`);
const card = "bg-[#13131a] border border-[#2a2a3a] rounded-xl p-4 mb-3";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100";
const btn = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-200 disabled:opacity-50";

function ResolveForm({ step, onDone }) {
  const [f, setF] = useState({ resolution: "not_charged", evidence: "", actualCost: "", resultUrl: "" });
  const [error, setError] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setError("");
    if (!window.confirm("Record this resolution? It is permanent and decides whether the money stays counted.")) return;
    try {
      const body = { resolution: f.resolution, evidence: f.evidence };
      if (f.actualCost) body.actualCost = f.actualCost;
      if (f.resolution === "charged_with_result") body.resultUrl = f.resultUrl;
      await api.generationJobs.resolve(step.id, body);
      onDone();
    } catch (e) {
      setError(e.details?.fields ? Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join("; ") : e.message);
    }
  };
  return (
    <div className="mt-2 grid grid-cols-2 gap-2" role="group" aria-label="Resolve step">
      <label className="text-[11px] text-zinc-500">What the provider shows
        <select className={input} value={f.resolution} onChange={(e) => set("resolution", e.target.value)}>
          <option value="not_charged">Not charged (nothing ran)</option>
          <option value="charged_no_result">Charged, no usable result</option>
          <option value="charged_with_result">Charged, result available</option>
        </select>
      </label>
      <label className="text-[11px] text-zinc-500">Actual cost (optional)
        <input className={input} value={f.actualCost} onChange={(e) => set("actualCost", e.target.value)} placeholder="0.80" />
      </label>
      {f.resolution === "charged_with_result" && (
        <label className="text-[11px] text-zinc-500 col-span-2">Result URL
          <input className={input} value={f.resultUrl} onChange={(e) => set("resultUrl", e.target.value)} placeholder="https://…" />
        </label>
      )}
      <label className="text-[11px] text-zinc-500 col-span-2">Evidence (what you checked, e.g. the dashboard entry)
        <textarea className={input} rows={2} value={f.evidence} onChange={(e) => set("evidence", e.target.value)} />
      </label>
      {error && <div className="text-[11px] text-red-400 col-span-2" role="alert">{error}</div>}
      <div className="col-span-2"><button className={btn} onClick={submit}>Record resolution</button></div>
    </div>
  );
}

export default function GenerationJobs() {
  const [jobs, setJobs] = useState([]);
  const [filter, setFilter] = useState("");
  const [resolving, setResolving] = useState(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setJobs(await api.generationJobs.list(filter ? { state: filter } : {}));
  }, [filter]);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load]);

  const act = async (fn, done) => {
    setBusy(true); setMessage("");
    try { await fn(); setMessage(done); } catch (e) { setMessage(e.message); } finally { setBusy(false); await load().catch(() => {}); }
  };

  return (
    <div className="p-6 max-w-[1200px] mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-3xl text-zinc-100">Generation jobs</h1>
          <p className="text-zinc-500 text-sm">Every paid request, step by step. Uncertain charges stay counted until someone resolves them.</p>
        </div>
        <div className="flex gap-2 items-center">
          <select className={input} aria-label="Filter by state" value={filter} onChange={(e) => setFilter(e.target.value)}>
            {JOB_STATES.map((s) => <option key={s} value={s}>{s ? s.replaceAll("_", " ") : "All jobs"}</option>)}
          </select>
          <button className={btn} disabled={busy} onClick={() => act(() => api.generationJobs.recover(), "Recovery checked abandoned jobs")}>Recover abandoned jobs</button>
        </div>
      </div>
      {message && <div className="text-xs text-zinc-300 mb-3" role="status">{message}</div>}
      {jobs.length === 0 && <div className="text-sm text-zinc-500">No jobs.</div>}
      {jobs.map((job) => (
        <section key={job.id} className={card} aria-label={`Job ${job.id}`}>
          <div className="flex justify-between text-xs text-zinc-400 mb-2">
            <span><span className="text-zinc-100">{job.kind}</span> · {job.targetType} {job.targetId.slice(0, 10)}… · {new Date(job.createdAt).toLocaleString()}</span>
            <span className="font-semibold">{job.state.replaceAll("_", " ")}{job.errorCode ? ` (${job.errorCode})` : ""}</span>
          </div>
          <table className="w-full text-[11px] text-zinc-300">
            <thead><tr className="text-left text-zinc-600"><th>Step</th><th>Provider</th><th>State</th><th>Reserved</th><th>Actual</th><th>Money</th><th>Provider request</th><th /></tr></thead>
            <tbody>
              {job.steps.map((s) => {
                const [label, cls] = STATE_INFO[s.state] || [s.state, "text-zinc-300"];
                return (
                  <tr key={s.id} className="align-top border-t border-[#2a2a3a]">
                    <td>{s.index + 1} · {s.kind}</td>
                    <td>{s.provider}:{s.model}</td>
                    <td className={cls}>{label}</td>
                    <td>{money(s.reservation?.amountMicros, s.reservation?.currency)}</td>
                    <td>{money(s.reservation?.actualMicros, s.reservation?.currency)}</td>
                    <td>{s.reservation?.state || "—"}{s.reservation?.priceVersion ? ` · ${s.reservation.priceVersion}` : ""}</td>
                    <td>{s.providerRequestId || "—"}</td>
                    <td className="whitespace-nowrap">
                      {UNCERTAIN.includes(s.state) && (
                        <>
                          <button className={btn} disabled={busy} onClick={() => act(() => api.generationJobs.check(s.id), "Asked the provider")}>Check with provider</button>{" "}
                          <button className={btn} onClick={() => setResolving(resolving === s.id ? null : s.id)}>Resolve…</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {job.steps.map((s) => (
            <div key={`r-${s.id}`}>
              {resolving === s.id && <ResolveForm step={s} onDone={() => { setResolving(null); load(); setMessage("Resolution recorded"); }} />}
              {(s.reconciliations || []).map((r) => (
                <div key={r.id} className="text-[11px] text-zinc-500 mt-1">
                  Step {s.index + 1}: {r.method === "operator" ? "resolved by" : "checked by"} {r.resolvedBy} on {new Date(r.resolvedAt).toLocaleString()} as {r.resolution.replaceAll("_", " ")}: “{r.evidence}”
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
