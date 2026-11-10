import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Review, schedule and export of one pipeline item.
 *
 * WHY the schedule lives inside the approval: what a reviewer approves is
 * "this media, caption and disclosure, to this destination, at this instant in
 * this time zone". Changing the time clears approval (the server enforces it;
 * this screen only explains it). Scheduling is a plan, never a publication,
 * and an export is a download, never a post.
 */
const sub = "text-xs text-zinc-400 font-semibold mb-2";
const label = "block text-[11px] text-zinc-400 mb-1";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const btn = "text-xs px-3 py-1.5 rounded-lg bg-[#C8FF00] text-black font-semibold disabled:opacity-50 focus:outline focus:outline-2 focus:outline-white";
const ghost = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-200 disabled:opacity-50 focus:outline focus:outline-2 focus:outline-[#C8FF00]";

const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const ZONES = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC"]; } })();
/** "Tue, Dec 9, 2026, 5:00 PM GMT-8" in the given zone. */
const fmt = (iso, zone) => new Date(iso).toLocaleString("en-US", {
  timeZone: zone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "shortOffset",
});

function ScheduleEditor({ item, disabled, onSave }) {
  const [local, setLocal] = useState(item.scheduleLocal || "");
  const [zone, setZone] = useState(item.scheduleTimezone || viewerZone());
  const [choice, setChoice] = useState(null); // ambiguous-time options from the server
  const [error, setError] = useState("");
  useEffect(() => { setLocal(item.scheduleLocal || ""); setZone(item.scheduleTimezone || viewerZone()); setChoice(null); }, [item.revision]);

  const save = async (ambiguity) => {
    setError("");
    try {
      await onSave({ schedule: { local, timezone: zone, ...(ambiguity ? { ambiguity } : {}) } });
      setChoice(null);
    } catch (e) {
      if (e.code === "SCHEDULE_TIME_AMBIGUOUS") { setChoice(e.details.options); setError(e.message); } else setError(e.message);
    }
  };
  return (
    <div role="group" aria-label="Destination schedule">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className={label}>Date and time at the destination
          <input type="datetime-local" className={input} value={local} disabled={disabled} onChange={(e) => setLocal(e.target.value)} />
        </label>
        <label className={label}>Destination time zone (IANA)
          <input className={input} list="tz-list" value={zone} disabled={disabled} onChange={(e) => setZone(e.target.value)} />
          <datalist id="tz-list">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
      </div>
      {choice && (
        <fieldset className="mt-2 text-[11px] text-zinc-300">
          <legend className="mb-1">This time happens twice. Which one?</legend>
          {choice.map((o) => (
            <button key={o.ambiguity} className={`${ghost} mr-2`} onClick={() => save(o.ambiguity)}>
              {o.ambiguity === "earlier" ? "First" : "Second"} ({o.offset}, {o.utc.slice(11, 16)} UTC)
            </button>
          ))}
        </fieldset>
      )}
      {error && <div className="text-[11px] text-red-400 mt-1" role="alert">{error}</div>}
      <div className="flex flex-wrap gap-2 mt-2">
        <button className={ghost} disabled={disabled || !local || !zone} onClick={() => save()}>Save schedule (clears approval)</button>
        {item.scheduledAt && <button className={ghost} disabled={disabled} onClick={() => onSave({ schedule: null })}>Remove time</button>}
      </div>
    </div>
  );
}

export default function ReviewExport({ item, hasShots, onChanged }) {
  const [exportsList, setExports] = useState([]);
  const [result, setResult] = useState(null); // { ok, export? , failures?, message }
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const scheduled = item.stage === "scheduled";

  const loadExports = useCallback(async () => setExports(await api.pipeline.exports(item.id)), [item.id]);
  useEffect(() => { loadExports().catch(() => {}); }, [loadExports, item.revision]);

  const run = async (fn, done) => {
    setBusy(true); setMessage("");
    try { await fn(); if (done) setMessage(done); } catch (e) { setMessage(e.message); throw e; } finally { setBusy(false); onChanged?.(); }
  };
  const quiet = (p) => p.catch(() => {});

  const saveSchedule = (patch) => run(() => api.pipeline.update(item.id, { ...patch, revision: item.revision }), "Schedule saved. Approval was cleared: review and approve again.");
  const approve = () => quiet(run(() => api.pipeline.approve(item.id, { revision: item.revision, snapshotHash: item.snapshotHash }), "Approved this exact version"));
  const schedule = () => quiet(run(() => api.pipeline.schedule(item.id), "Added to the calendar as a plan (nothing is published)"));
  const cancel = () => {
    if (!window.confirm("Cancel this schedule? The calendar entry can never be delivered, and the item returns to review.")) return;
    quiet(run(() => api.pipeline.cancelSchedule(item.id, reason), "Schedule cancelled").then(() => setReason("")));
  };
  const measure = () => quiet(run(() => api.pipeline.measureMedia(item.id), "Clip lengths measured from the files. Approval was cleared."));
  const doExport = async () => {
    setResult(null);
    setBusy(true);
    try {
      // The exact version on screen; a change meanwhile is a conflict, not a surprise export.
      const r = await api.pipeline.createExport(item.id, { expectedRevision: item.revision, approvedHash: item.approvedHash });
      setResult({ ok: true, export: r.export, replayed: r.replayed });
    } catch (e) {
      setResult({ ok: false, message: e.message, failures: e.details?.failures || [] });
    } finally { setBusy(false); await loadExports().catch(() => {}); }
  };
  const download = async (exp, format) => {
    try {
      const { blob, filename } = await api.pipeline.downloadExport(item.id, exp.id, format);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setMessage(e.message); }
  };

  const zone = viewerZone();
  return (
    <section className="border-t border-[#2a2a3a] pt-4 mt-4 min-w-0" aria-label="Review, schedule and export">
      {item.rightsHoldAt && (
        <div className="mb-3 p-3 rounded-lg border border-red-400/40 text-[11px] text-red-300" role="alert">
          <div className="font-semibold">On hold: {item.rightsHoldReason}</div>
          <div className="text-zinc-400">Approval, scheduling, export and publishing stop until the owner reviews this item.</div>
          <button className={`${ghost} mt-2`} disabled={busy} onClick={() => {
            const note = window.prompt("What did you review (e.g. regenerated without the revoked reference)?");
            if (note) quiet(run(() => api.pipeline.clearRightsHold(item.id, note), "Hold cleared"));
          }}>Clear hold after review (owner)</button>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 [&>div]:min-w-0">
        <div>
          <div className={sub}>Review</div>
          <div className="text-[11px] text-zinc-300 mb-2" aria-live="polite">
            {item.approvalCurrent
              ? <span className="text-green-400">✓ Revision {item.revision} approved by {item.approvedBy}. The approval covers media, caption, disclosure, destination and time.</span>
              : <span className="text-amber-300">Not approved{item.stage === "review" ? " (in review)" : ` (stage: ${item.stage})`}.</span>}
          </div>
          {item.stage === "review" && <button className={btn} disabled={busy} onClick={approve}>Approve this exact version</button>}
        </div>

        <div>
          <div className={sub}>Schedule (a plan, not a publication)</div>
          {item.scheduledAt ? (
            <dl className="text-[11px] text-zinc-300 mb-2 grid grid-cols-[auto,minmax(0,1fr)] gap-x-2 [&_dd]:break-words" aria-label="Scheduled time">
              <dt className="text-zinc-500">Destination</dt><dd>{fmt(item.scheduledAt, item.scheduleTimezone)} · {item.scheduleTimezone}</dd>
              <dt className="text-zinc-500">UTC</dt><dd>{new Date(item.scheduledAt).toISOString().replace(".000Z", "Z")}</dd>
              {zone !== item.scheduleTimezone && (<><dt className="text-zinc-500">Your time</dt><dd>{fmt(item.scheduledAt, zone)} · {zone}</dd></>)}
            </dl>
          ) : <div className="text-[11px] text-zinc-500 mb-2">No time set. Set one before approval to schedule.</div>}
          {scheduled ? (
            <div className="text-[11px] text-zinc-300">
              <div className="text-[#C8FF00] mb-2">On the calendar · planned only, not published</div>
              <label className={label}>Reason for cancelling
                <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <button className={ghost} disabled={busy || reason.trim().length < 3} onClick={cancel}>Cancel schedule</button>
            </div>
          ) : (
            <>
              <ScheduleEditor item={item} disabled={busy} onSave={saveSchedule} />
              {item.stage === "approved" && item.approvalCurrent && item.scheduledAt && (
                <button className={`${btn} mt-2`} disabled={busy} onClick={schedule}>Add to calendar at the approved time</button>
              )}
            </>
          )}
        </div>

        <div>
          <div className={sub}>Export (a download; nothing is posted)</div>
          {hasShots && !scheduled && <button className={`${ghost} mb-2 mr-2`} disabled={busy} onClick={measure}>Measure clip lengths from files</button>}
          {hasShots && !scheduled && (
            <button className={`${ghost} mb-2 mr-2`} disabled={busy}
              onClick={() => quiet(run(() => api.pipeline.assemble(item.id), "Rendered into one video from the measured clips. Approval was cleared: review the rendered file."))}>
              Render one video from the clips
            </button>
          )}
          {item.renderedAssetId && <div className="text-[11px] text-zinc-400 mb-2">Distributed as the rendered file (its hash is part of the approval).</div>}
          <button className={btn} disabled={busy || !item.approvalCurrent} onClick={doExport}
            title={item.approvalCurrent ? "" : "Only the current approved version can be exported"}>
            Export approved version
          </button>
          {result?.ok && (
            <div className="mt-2 text-[11px] text-green-400" role="status">
              ✓ Export verified{result.replayed ? " (identical to an earlier export)" : ""}: {result.export.manifest.media.length} file(s) checked, manifest {result.export.manifestHash.slice(0, 12)}…
            </div>
          )}
          {result && !result.ok && (
            <div className="mt-2 text-[11px] text-red-400" role="alert">
              Export failed: {result.message}
              {result.failures.length > 0 && (
                <ul className="list-disc ml-4">{result.failures.map((f, i) => <li key={i}>{f.shotIndex !== undefined ? `Shot ${f.shotIndex + 1}: ` : ""}{f.problems.join("; ")}</li>)}</ul>
              )}
            </div>
          )}
          {exportsList.length > 0 && (
            <ul className="mt-3 text-[11px] text-zinc-300" aria-label="Exports">
              {exportsList.map((e) => (
                <li key={e.id} className="mb-1">
                  <span className={e.current ? "text-green-400" : "text-zinc-500"}>{e.current ? "Current" : "Superseded"}</span>{" "}
                  · revision {e.revision} · {e.manifestHash.slice(0, 10)}…{" "}
                  <button className="underline focus:outline focus:outline-2 focus:outline-[#C8FF00]" onClick={() => download(e, "json")}>JSON</button>{" "}
                  <button className="underline focus:outline focus:outline-2 focus:outline-[#C8FF00]" onClick={() => download(e, "text")}>Readable</button>{" "}
                  <button className="underline focus:outline focus:outline-2 focus:outline-[#C8FF00]" onClick={async () => {
                    try {
                      const v = await api.pipeline.verifyExport(item.id, e.id);
                      setMessage(v.intact ? "All files present and unchanged" : `Incomplete: ${v.missing.length} missing, ${v.changed.length} changed`);
                    } catch (err) { setMessage(err.message); }
                  }}>Verify files</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {message && <div className="text-xs text-zinc-300 mt-3" role="status">{message}</div>}
    </section>
  );
}
