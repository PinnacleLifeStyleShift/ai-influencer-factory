import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Character bible: published versions + reference gallery with rights.
 *
 * WHY here and not in the edit form: the form edits the draft; publishing,
 * reference promotion and rights are separate, deliberate actions with their
 * own confirmations, and their state must survive a reload (it is read back
 * from the server, never kept only in component state).
 */
const card = "bg-[#13131a] border border-[#2a2a3a] rounded-xl p-4 mb-6";
const small = "text-[10px] text-zinc-500";
const link = "text-[10px] text-[#C8FF00] hover:underline disabled:opacity-50";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100";
const BASES = [
  ["owned_original", "Our original work"],
  ["generated_synthetic", "Generated (provider terms apply)"],
  ["licensed", "Licensed"],
  ["consented_likeness", "Real person, with consent"],
];
const USES = [["provider_input", "Send to a generation provider"], ["publication", "Publish"], ["training", "Training"]];
const EMPTY_RIGHTS = { basis: "owned_original", holder: "", permittedUses: ["provider_input"], likenessOfRealPerson: false, consentReference: "", licenseReference: "" };

function RightsForm({ imageId, onSaved, onCancel }) {
  const [f, setF] = useState(EMPTY_RIGHTS);
  const [error, setError] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const toggleUse = (u) => set("permittedUses", f.permittedUses.includes(u) ? f.permittedUses.filter((x) => x !== u) : [...f.permittedUses, u]);
  const save = async () => {
    setError("");
    try {
      const body = { ...f };
      if (!body.consentReference) delete body.consentReference;
      if (!body.licenseReference) delete body.licenseReference;
      await api.characterImages.recordRights(imageId, body);
      onSaved();
    } catch (e) {
      setError(e.details?.fields ? Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join("; ") : e.message);
    }
  };
  return (
    <div className="mt-2 space-y-1 w-56" role="group" aria-label="Rights record">
      <label className={small}>Basis
        <select className={input} value={f.basis} onChange={(e) => set("basis", e.target.value)}>
          {BASES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <label className={small}>Rights holder
        <input className={input} value={f.holder} onChange={(e) => set("holder", e.target.value)} />
      </label>
      <fieldset className={small}><legend>Permitted uses</legend>
        {USES.map(([u, l]) => (
          <label key={u} className="block"><input type="checkbox" checked={f.permittedUses.includes(u)} onChange={() => toggleUse(u)} /> {l}</label>
        ))}
      </fieldset>
      <label className={`${small} block`}>
        <input type="checkbox" checked={f.likenessOfRealPerson} onChange={(e) => set("likenessOfRealPerson", e.target.checked)} /> Shows a real person
      </label>
      {(f.likenessOfRealPerson || f.basis === "consented_likeness") && (
        <label className={small}>Where the signed consent is kept
          <input className={input} value={f.consentReference} onChange={(e) => set("consentReference", e.target.value)} />
        </label>
      )}
      {f.basis === "licensed" && (
        <label className={small}>License reference
          <input className={input} value={f.licenseReference} onChange={(e) => set("licenseReference", e.target.value)} />
        </label>
      )}
      {error && <div className="text-[10px] text-red-400" role="alert">{error}</div>}
      <div className="flex gap-2"><button className={link} onClick={save}>Save rights record</button><button className={small} onClick={onCancel}>Cancel</button></div>
    </div>
  );
}

export default function CharacterBible({ character, refreshKey, onCharacterChange }) {
  const [versions, setVersions] = useState({ versions: [], draftChanged: false });
  const [images, setImages] = useState([]);
  const [editingRights, setEditingRights] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const [v, i] = await Promise.all([
      api.characters.versions(character.id).catch(() => ({ versions: [], draftChanged: false })),
      api.characters.images(character.id).catch(() => ({ images: [] })),
    ]);
    setVersions(v);
    setImages(i.images || []);
  }, [character.id]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const act = async (fn, okMessage) => {
    setBusy(true); setMessage("");
    try { await fn(); setMessage(okMessage); await load(); } catch (e) { setMessage(e.message); } finally { setBusy(false); }
  };
  const publish = () => act(async () => {
    const note = window.prompt("Note for this version (optional):") || undefined;
    const r = await api.characters.publishVersion(character.id, note ? { note } : {});
    if (r.unchanged) throw new Error(`No changes since version ${r.version.version}`);
  }, "Version published");
  const restore = (n) => {
    if (!window.confirm(`Replace the draft with version ${n}? The draft's unpublished edits are lost; published versions are not affected.`)) return;
    act(async () => { const r = await api.characters.restoreVersion(character.id, n); onCharacterChange?.(r.character); }, `Draft restored from version ${n}`);
  };
  const promote = (img) => {
    const has = Boolean(character.reference_image_url);
    if (has && !window.confirm("Replace the current reference image? The current one is kept in history. Published versions keep the reference they were published with.")) return;
    act(async () => {
      const r = await api.characters.setReferenceImage(character.id, { imageId: img.id, replaceReference: has });
      onCharacterChange?.(r.character);
    }, "Reference image updated");
  };
  const approve = (img) => act(() => api.characterImages.approveRights(img.id, img.rights.id), "Rights approved");

  return (
    <>
      <section className={card} aria-label="Published versions">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs text-zinc-400">
            Published versions {versions.draftChanged && <span className="text-amber-300">· the draft has unpublished changes</span>}
          </div>
          <button className={link} disabled={busy} onClick={publish}>Publish draft as new version</button>
        </div>
        {versions.versions.length === 0 ? <div className={small}>Not published yet. Content pins a published version.</div> : (
          <table className="w-full text-[11px] text-zinc-400">
            <thead><tr className="text-left text-zinc-600"><th>Version</th><th>Published</th><th>References</th><th>Note</th><th /></tr></thead>
            <tbody>
              {versions.versions.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}{v.id === versions.publishedVersionId && " (current)"}</td>
                  <td>{new Date(v.publishedAt).toLocaleString()}</td>
                  <td>{(v.references || []).length}</td>
                  <td>{v.note || "—"}</td>
                  <td><button className={link} disabled={busy} onClick={() => restore(v.version)}>Restore into draft</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className={card} aria-label="Reference gallery">
        <div className="text-xs text-zinc-400 mb-3">Reference gallery: the reference changes only when you choose an image; rights decide whether a provider may receive it.</div>
        {images.length === 0 && <div className={small}>No images yet.</div>}
        <div className="flex gap-4 overflow-x-auto">
          {images.map((img) => (
            <div key={img.id} className="flex-shrink-0 w-32">
              <img src={img.imageUrl} alt={`${img.status} image`} className="w-32 h-32 object-cover rounded-lg border border-[#2a2a3a]" />
              <div className={small}>{img.status === "reference" ? "Current reference" : img.status === "replaced_reference" ? "Previous reference" : "Candidate"} · {img.source}</div>
              <div className={`text-[10px] ${img.providerInput?.cleared ? "text-green-400" : "text-amber-300"}`}>
                {img.providerInput?.cleared ? "Cleared for providers" : `Not cleared: ${(img.providerInput?.missing || []).join(", ")}`}
              </div>
              {img.status !== "reference" && img.imageUrl !== character.reference_image_url && (
                <button className={`${link} block`} disabled={busy} onClick={() => promote(img)}>Use as reference</button>
              )}
              {editingRights === img.id
                ? <RightsForm imageId={img.id} onSaved={() => { setEditingRights(null); load(); }} onCancel={() => setEditingRights(null)} />
                : <button className={`${link} block`} onClick={() => setEditingRights(img.id)}>Record rights</button>}
              {img.rights && !img.rights.approvedAt && (
                <button className={`${link} block`} disabled={busy} onClick={() => approve(img)}>Approve rights (owner)</button>
              )}
            </div>
          ))}
        </div>
      </section>
      {message && <div className="text-xs text-zinc-400 mb-4" role="status">{message}</div>}
    </>
  );
}
