import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Publishing panel for one approved item.
 *
 * WHY so many named states: "posted and confirmed", "simulated", "the
 * platform is still processing", "we sent it but never heard back" and
 * "cancelled before sending" lead to different actions, and only a
 * platform-confirmed post may ever be called published. Live publishing is
 * disabled until an account, official API access and scopes are approved; the
 * panel says exactly what is missing per destination.
 */
const DESTINATIONS = ["TikTok", "Instagram", "YouTube"];
const sub = "text-xs text-zinc-400 font-semibold mb-2";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const btn = "text-xs px-3 py-1.5 rounded-lg bg-[#C8FF00] text-black font-semibold disabled:opacity-40 focus:outline focus:outline-2 focus:outline-white";
const ghost = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-200 disabled:opacity-50 focus:outline focus:outline-2 focus:outline-[#C8FF00]";

export const DELIVERY_STATE = {
  pending: ["Not sent yet", "text-zinc-400"],
  submitting: ["Sending…", "text-blue-300"],
  processing: ["Platform is still processing (not confirmed)", "text-amber-300"],
  published: ["Posted, confirmed by the platform", "text-green-400"],
  resolved_published: ["Posted (confirmed by the owner)", "text-green-400"],
  simulated: ["Simulated: nothing was posted", "text-sky-300"],
  failed: ["Refused before sending (can retry)", "text-amber-300"],
  outcome_unknown: ["Outcome unknown: may have been posted", "text-red-400"],
  resolved_not_published: ["Not posted (confirmed by the owner)", "text-zinc-300"],
  cancelled: ["Cancelled before sending", "text-zinc-500"],
};
const UNCERTAIN = ["outcome_unknown", "processing", "submitting"];

function ResolveForm({ delivery, onDone }) {
  const [f, setF] = useState({ resolution: "not_published", evidence: "", remotePostId: "", permalink: "" });
  const [error, setError] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const submit = async () => {
    setError("");
    if (!window.confirm("Record this outcome? It is permanent; 'not posted' allows one new attempt.")) return;
    try {
      await api.publishing.resolve(delivery.id, f.resolution === "published" ? f : { resolution: f.resolution, evidence: f.evidence });
      onDone();
    } catch (e) { setError(e.details?.fields ? Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join("; ") : e.message); }
  };
  return (
    <div role="group" aria-label={`Resolve ${delivery.platform}`} className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
      <label className="text-[11px] text-zinc-400">What the {delivery.platform} account shows
        <select className={input} value={f.resolution} onChange={(e) => set("resolution", e.target.value)}>
          <option value="not_published">Not posted</option>
          <option value="published">Posted</option>
        </select>
      </label>
      {f.resolution === "published" && (<>
        <label className="text-[11px] text-zinc-400">Post id<input className={input} value={f.remotePostId} onChange={(e) => set("remotePostId", e.target.value)} /></label>
        <label className="text-[11px] text-zinc-400 sm:col-span-2">Post link<input className={input} value={f.permalink} onChange={(e) => set("permalink", e.target.value)} placeholder="https://…" /></label>
      </>)}
      <label className="text-[11px] text-zinc-400 sm:col-span-2">Evidence (what you checked)
        <textarea className={input} rows={2} value={f.evidence} onChange={(e) => set("evidence", e.target.value)} />
      </label>
      {error && <div className="text-[11px] text-red-400 sm:col-span-2" role="alert">{error}</div>}
      <div><button className={ghost} onClick={submit}>Record outcome</button></div>
    </div>
  );
}

export default function Publishing({ item, onChanged }) {
  const [policy, setPolicy] = useState([]);
  const [jobs, setJobs] = useState([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolving, setResolving] = useState(null);
  const destinations = [item.platform, ...(item.crossPostDestinations || [])].filter(Boolean);
  const contentId = item.contentId;

  const load = useCallback(async () => {
    setPolicy(await api.publishing.policy());
    setJobs(contentId ? await api.publishing.jobs({ contentId }) : []);
  }, [contentId]);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load, item.revision, item.stage]);

  const act = async (fn, done) => {
    setBusy(true); setMessage("");
    // Reload before announcing, so "finished" never sits beside stale rows.
    try { await fn(); await load().catch(() => {}); setMessage(done); } catch (e) {
      setMessage(e.details?.missing ? `${e.message}. Missing: ${e.details.missing.join("; ")}` : e.message);
    } finally { setBusy(false); await load().catch(() => {}); onChanged?.(); }
  };
  const editable = !["scheduled", "published"].includes(item.stage);
  const toggle = (d) => act(() => api.pipeline.update(item.id, {
    revision: item.revision,
    crossPostDestinations: (item.crossPostDestinations || []).includes(d) ? item.crossPostDestinations.filter((x) => x !== d) : [...(item.crossPostDestinations || []), d],
  }), "Destinations saved. Approval was cleared.");

  const job = jobs[0];
  const byPlatform = Object.fromEntries((job?.deliveries || []).map((d) => [d.platform, d]));
  const due = item.scheduledAt && new Date(item.scheduledAt) <= new Date();
  const ready = destinations.every((d) => policy.find((p) => p.platform === d)?.ready);
  // Something left to send: no job yet, or a destination not sent / provably refused.
  const sendable = !job || job.deliveries.some((d) => ["pending", "failed", "resolved_not_published"].includes(d.state));
  const canPublish = sendable && contentId && ["scheduled"].includes(item.stage) && item.approvalCurrent && due && ready && !UNCERTAIN.some((s) => (job?.deliveries || []).some((d) => d.state === s));

  return (
    <section className="border-t border-[#2a2a3a] pt-4 mt-4 min-w-0" aria-label="Publishing">
      <div className={sub}>Publishing (one original; each destination tracked separately)</div>
      <fieldset className="mb-3 text-[11px] text-zinc-300">
        <legend className="mb-1 text-zinc-400">Also post this original to (part of the approval)</legend>
        <div className="flex flex-wrap gap-3">
          {DESTINATIONS.filter((d) => d !== item.platform).map((d) => (
            <label key={d} className="flex items-center gap-1">
              <input type="checkbox" disabled={!editable || busy} checked={(item.crossPostDestinations || []).includes(d)} onChange={() => toggle(d)} />{d}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-[11px] text-zinc-300">
          <thead><tr className="text-left text-zinc-500"><th>Destination</th><th>Publisher</th><th>Delivery</th><th>Post</th><th /></tr></thead>
          <tbody>
            {destinations.map((d) => {
              const p = policy.find((x) => x.platform === d);
              const del = byPlatform[d];
              const [label, cls] = del ? DELIVERY_STATE[del.state] || [del.state, ""] : ["Not started", "text-zinc-500"];
              return (
                <tr key={d} className="align-top border-t border-[#2a2a3a]">
                  <td className="py-1">{d}{d === item.platform ? " (primary)" : ""}</td>
                  <td className={p?.ready ? (p.simulated ? "text-sky-300" : "text-green-400") : "text-zinc-500"}>
                    {!p ? "…" : p.ready ? (p.simulated ? "Simulation only" : "Enabled") : (<span title={p.missing.join("\n")}>Disabled: {p.missing[0]}{p.missing.length > 1 ? ` (+${p.missing.length - 1})` : ""}</span>)}
                  </td>
                  <td className={cls}>{label}{del?.errorCode ? ` (${del.errorCode})` : ""}</td>
                  <td className="break-all">
                    {del?.remotePostId || "—"}
                    {del?.permalink && <> · <a className="underline" href={del.permalink} target="_blank" rel="noopener noreferrer">{del.simulated ? "simulated link" : "open post"}</a></>}
                  </td>
                  <td className="whitespace-nowrap">
                    {del && UNCERTAIN.includes(del.state) && (<>
                      <button className={ghost} disabled={busy} onClick={() => act(() => api.publishing.check(del.id), `Asked ${d}`)}>Check</button>{" "}
                      <button className={ghost} onClick={() => setResolving(resolving === del.id ? null : del.id)}>Resolve…</button>
                    </>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {(job?.deliveries || []).map((del) => (
        <div key={del.id}>
          {resolving === del.id && <ResolveForm delivery={del} onDone={() => { setResolving(null); load(); setMessage("Outcome recorded"); }} />}
          {(del.reconciliations || []).map((r) => (
            <div key={r.id} className="text-[11px] text-zinc-500 mt-1">{del.platform}: {r.method === "operator" ? "resolved by" : "checked by"} {r.resolvedBy} as {r.resolution.replaceAll("_", " ")}: “{r.evidence}”</div>
          ))}
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3 mt-3">
        <button className={btn} disabled={busy || !canPublish} onClick={() => {
          if (!window.confirm(`Post this approved original to ${destinations.join(", ")}? Posting cannot be undone.`)) return;
          act(() => api.publishing.publish(contentId), "Publish run finished; see each destination");
        }}>Publish now</button>
        <span className="text-[11px] text-zinc-500">
          {job ? `Job: ${job.state.replaceAll("_", " ")}${sendable ? "" : " · nothing left to send"}` : !contentId ? "Schedule the approved item first." : !due ? "Available at the approved time." : !ready ? "Publishing is not enabled for every destination." : ""}
        </span>
      </div>
      {message && <div className="text-xs text-zinc-300 mt-2" role="status">{message}</div>}
    </section>
  );
}
