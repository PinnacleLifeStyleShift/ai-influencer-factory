import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "./api.js";
import ReviewExport from "./ReviewExport.jsx";
import Publishing from "./Publishing.jsx";

/**
 * Content package: storyboard, script (versioned), media per shot, caption,
 * disclosure, destination, export settings, duration and claims checks.
 *
 * WHY everything is re-read from the server after each action: the package
 * must survive refreshes and errors, and background jobs can change it; the
 * screen never shows a state the server does not hold.
 */
const card = "bg-[#13131a] border border-[#2a2a3a] rounded-xl p-4 mb-4";
const label = "block text-[11px] text-zinc-500 mb-1";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100";
const btn = "text-xs px-3 py-1.5 rounded-lg bg-[#C8FF00] text-black font-semibold disabled:opacity-50";
const ghost = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-300 disabled:opacity-50";
const ok = (b) => (b ? "text-green-400" : "text-amber-300");

function Check({ title, good, children }) {
  return (
    <div className="mb-2">
      <div className={`text-xs font-semibold ${ok(good)}`}>{good ? "✓" : "!"} {title}</div>
      <div className="text-[11px] text-zinc-400">{children}</div>
    </div>
  );
}

export default function ContentPackage({ itemId, onClose, onChanged }) {
  const [pkg, setPkg] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const p = await api.pipeline.package(itemId);
    setPkg(p);
    setDraft(p.script ? { ...p.script, evidence: p.script.evidence || [] } : null);
  }, [itemId]);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load]);
  // Focus moves into the panel when it opens, so keyboard and screen-reader
  // users land on what they opened; Escape closes it (focus then returns).
  const panelRef = useRef(null);
  const focusedOnce = useRef(false);
  useEffect(() => { if (pkg && !focusedOnce.current && panelRef.current) { focusedOnce.current = true; panelRef.current.focus(); } });
  // Escape closes the panel even after an action removed the focused control
  // (e.g. the Approve button disappears once approved). Not while typing in a field.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (fn, done) => {
    setBusy(true); setMessage("");
    try { await fn(); setMessage(done); } catch (e) {
      setMessage(e.details?.fields ? `${e.message}: ${Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join("; ")}` : e.message);
    } finally {
      setBusy(false);
      await load().catch(() => {});
      onChanged?.();
    }
  };

  if (!pkg) return <div className={card}><div className="text-xs text-zinc-500">{message || "Loading package…"}</div></div>;
  const { item, storyboard, duration, claims } = pkg;
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const setEvidence = (i, k, v) => set("evidence", draft.evidence.map((e, j) => (j === i ? { ...e, [k]: v } : e)));

  const saveScript = () => act(async () => {
    const r = await api.pipeline.updateScript(pkg.script.id, {
      expectedVersion: pkg.script.version, hook: draft.hook, body: draft.body, callToAction: draft.callToAction,
      speakingPaceWpm: Number(draft.speakingPaceWpm), targetDurationSec: Number(draft.targetDurationSec),
      evidence: draft.evidence.filter((e) => e.claim),
    });
    if (r.unchanged) throw new Error("No changes to save");
  }, "Saved as a new script version. Approval (if any) was cleared.");
  const savePackage = (patch, done) => act(() => api.pipeline.update(item.id, { ...patch, revision: item.revision }), done);
  const generateShot = (index) => act(
    () => api.pipeline.generateContent({ pipelineItemId: item.id, type: "video", shotIndex: index },
      { idempotencyKey: api.newIdempotencyKey() }),
    `Clip for shot ${index + 1} generated`);

  return (
    <section className={card} aria-label="Content package" ref={panelRef} tabIndex={-1}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm text-zinc-100 font-semibold">Content package · {item.character?.name}</div>
          <div className="text-[11px] text-zinc-500">
            Revision {item.revision} · stage {item.stage} · script v{pkg.script?.version ?? "—"} · character v{pkg.characterVersion?.version ?? "—"}
            {item.generationInProgress && " · generation in progress"}
          </div>
        </div>
        <button className={ghost} onClick={onClose}>Close</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
        <div>
          <Check title="Planned length" good={duration?.planned.withinTolerance}>
            {duration?.planned.actualSec}s planned for a {duration?.planned.targetSec}s target (±{duration?.planned.toleranceSec}s)
          </Check>
          <Check title="Measured length" good={duration?.measured.complete && duration?.measured.verified && duration?.measured.withinTolerance}>
            {duration?.measured.actualSec}s from attached clips ·{" "}
            {duration?.measured.complete ? "all shots covered" : "shots missing or too short"} ·{" "}
            {duration?.measured.verified ? "lengths reported or measured" : "lengths not verified"}
          </Check>
        </div>
        <div>
          <Check title="Claims" good={claims?.ok}>
            {claims?.ok ? "Every flagged line has a source or fiction framing." : (
              <ul className="list-disc ml-4">{claims?.unsupported.map((u, i) => <li key={i}>“{u.text}” needs {u.need}</li>)}</ul>
            )}
          </Check>
        </div>
        <div>
          <label className={label}>Synthetic-persona disclosure (exported with the content)
            <input className={input} defaultValue={pkg.disclosure || ""} key={`d${item.revision}`}
              onBlur={(e) => e.target.value !== (pkg.disclosure || "") && savePackage({ disclosure: e.target.value }, "Disclosure saved")} />
          </label>
          <div className="text-[11px] text-zinc-500 mb-1">Destination: {pkg.destination || "not chosen"}</div>
          <div className="flex gap-2">
            <label className={label}>Format
              <select className={input} value={pkg.exportSettings?.format || "mp4"}
                onChange={(e) => savePackage({ exportSettings: { ...pkg.exportSettings, format: e.target.value } }, "Export settings saved")}>
                <option>mp4</option><option>mov</option>
              </select>
            </label>
            <label className={label}>Aspect
              <select className={input} value={pkg.exportSettings?.aspectRatio || "9:16"}
                onChange={(e) => savePackage({ exportSettings: { ...pkg.exportSettings, aspectRatio: e.target.value } }, "Export settings saved")}>
                <option>9:16</option><option>1:1</option><option>16:9</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <ReviewExport item={item} hasShots={(item.shotMedia || []).length > 0} onChanged={() => { load().catch(() => {}); onChanged?.(); }} />
      <Publishing item={item} onChanged={() => { load().catch(() => {}); onChanged?.(); }} />

      <div className="text-xs text-zinc-400 mb-2 mt-4">Storyboard</div>
      <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-[11px] text-zinc-300 mb-4">
        <thead><tr className="text-left text-zinc-600">
          <th>#</th><th>Length</th><th>Scene / action</th><th>Dialogue</th><th>Caption</th><th>Audio</th><th>Clip</th><th />
        </tr></thead>
        <tbody>
          {storyboard.map((s) => (
            <tr key={s.index} className="align-top border-t border-[#2a2a3a]">
              <td>{s.index + 1}</td>
              <td title={`speech ${s.speechSec}s + hold ${s.holdSec}s`}>{s.durationSec}s</td>
              <td>{s.scene}<div className="text-zinc-500">{s.visualAction}</div></td>
              <td>{s.dialogue}</td>
              <td className="text-zinc-400">{s.caption}</td>
              <td className="text-zinc-500">{s.audio.kind}; music {s.audio.music}</td>
              <td className={s.mediaStatus?.status === "ok" ? "text-green-400" : "text-amber-300"}>
                {s.media ? `${s.media.durationSec}s (${{ provider_reported: "reported", measured: "measured from file" }[s.media.durationSource] || "requested"})` : "none"}
                {s.mediaStatus?.shortBySec > 0 && <div>short by {s.mediaStatus.shortBySec}s</div>}
              </td>
              <td><button className={ghost} disabled={busy} onClick={() => generateShot(s.index)}>{s.media ? "Regenerate" : "Generate clip"}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {draft && (
        <div>
          <div className="text-xs text-zinc-400 mb-2">Script (version {pkg.script.version}; saving creates version {pkg.script.version + 1})</div>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>Hook<textarea className={input} rows={2} value={draft.hook || ""} onChange={(e) => set("hook", e.target.value)} /></label>
            <label className={label}>Call to action<textarea className={input} rows={2} value={draft.callToAction || ""} onChange={(e) => set("callToAction", e.target.value)} /></label>
          </div>
          <label className={label}>Body<textarea className={input} rows={4} value={draft.body || ""} onChange={(e) => set("body", e.target.value)} /></label>
          <div className="flex gap-3">
            <label className={label}>Speaking pace (words/min)<input type="number" className={input} value={draft.speakingPaceWpm} onChange={(e) => set("speakingPaceWpm", e.target.value)} /></label>
            <label className={label}>Target length (s)<input type="number" className={input} value={draft.targetDurationSec} onChange={(e) => set("targetDurationSec", e.target.value)} /></label>
          </div>
          <div className="text-[11px] text-zinc-500 mt-2 mb-1">Evidence for factual lines (a source URL), or mark a line as fiction</div>
          {draft.evidence.map((e, i) => (
            <div key={i} className="flex gap-2 mb-1">
              <input className={input} placeholder="Exact line or claim" value={e.claim || ""} onChange={(ev) => setEvidence(i, "claim", ev.target.value)} />
              <select className={input} style={{ maxWidth: 110 }} value={e.basis} onChange={(ev) => setEvidence(i, "basis", ev.target.value)}>
                <option value="source">Source</option><option value="fictional">Fiction</option>
              </select>
              {e.basis === "source" && <input className={input} placeholder="https://source" value={e.sourceUrl || ""} onChange={(ev) => setEvidence(i, "sourceUrl", ev.target.value)} />}
              <button className={ghost} onClick={() => set("evidence", draft.evidence.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
          <div className="flex gap-2 mt-2">
            <button className={ghost} onClick={() => set("evidence", [...draft.evidence, { claim: "", basis: "source", sourceUrl: "" }])}>Add evidence</button>
            <button className={btn} disabled={busy} onClick={saveScript}>Save script as new version</button>
          </div>
        </div>
      )}
      {message && <div className="text-xs text-zinc-300 mt-3" role="status">{message}</div>}
    </section>
  );
}
