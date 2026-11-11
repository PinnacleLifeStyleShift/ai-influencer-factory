import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Campaign money: planned, invoiced and received, kept apart.
 * WHY: an offered payout is a plan and an invoice is a claim; only money
 * actually received (with a reference and evidence) is income. Wrong records
 * are voided or reversed, never deleted.
 */
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const label = "block text-[11px] text-zinc-400";
const ghost = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-200 disabled:opacity-50 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
export const money = (micros, cur) => `${(Number(micros || 0) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
const today = () => new Date().toISOString().slice(0, 10);

export function MoneyStates({ summary }) {
  const entries = Object.entries(summary || {});
  if (!entries.length) return <span className="text-zinc-500">No amounts yet</span>;
  return entries.map(([cur, s]) => (
    <span key={cur} className="mr-3 whitespace-nowrap">
      <span className="text-zinc-500">planned</span> {money(s.plannedMicros, cur)} · <span className="text-zinc-500">invoiced</span> {money(s.invoicedMicros, cur)} · <span className="text-zinc-500">received</span> <span className="text-[#C8FF00]">{money(s.receivedMicros, cur)}</span>
      {s.outstandingMicros > 0 && <> · <span className="text-amber-300">outstanding {money(s.outstandingMicros, cur)}</span></>}
      {s.overpaidMicros > 0 && <> · <span className="text-red-400">overpaid {money(s.overpaidMicros, cur)}</span></>}
    </span>
  ));
}

export default function CampaignMoney({ campaignId, currency = "USD", onChanged }) {
  const [data, setData] = useState(null);
  const [inv, setInv] = useState({ number: "", amount: "", currency, issuedAt: today(), dueAt: "" });
  const [rec, setRec] = useState({ invoiceId: "", amount: "", currency, receivedAt: today(), reference: "", evidence: "" });
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => setData(await api.campaignMoney.get(campaignId)), [campaignId]);
  useEffect(() => { load().catch((e) => setMessage(e.message)); }, [load]);
  // One money write at a time from this panel; the server also refuses a
  // second receipt for the same payment (DUPLICATE_RECEIPT) and duplicate
  // invoice numbers, so a double click cannot double-count.
  const act = async (fn, done, after) => {
    if (busy) return;
    setMessage(""); setBusy(true);
    try { await fn(); after?.(); setMessage(done); await load(); onChanged?.(); } catch (e) {
      setMessage(e.details?.fields ? Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join("; ") : e.message);
    } finally { setBusy(false); }
  };
  if (!data) return <div className="text-xs text-zinc-500">{message || "Loading…"}</div>;
  const live = data.invoices.filter((i) => !i.voidedAt);
  return (
    <div className="mt-3 border-t border-[#2a2a3a] pt-3 text-[11px] text-zinc-300" role="group" aria-label="Campaign money">
      <div className="mb-2"><MoneyStates summary={data.summary} /></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-zinc-400 font-semibold mb-1">Invoices issued</div>
          {data.invoices.map((i) => (
            <div key={i.id} className={i.voidedAt ? "line-through text-zinc-600" : ""}>
              {i.number}: {money(i.amountMicros, i.currency)} issued {i.issuedAt.slice(0, 10)}{i.dueAt ? `, due ${i.dueAt.slice(0, 10)}` : ""}
              {!i.voidedAt && <button className="underline ml-2" onClick={() => { const r = window.prompt("Why void this invoice?"); if (r) act(() => api.campaignMoney.voidInvoice(campaignId, i.id, r), "Invoice voided"); }}>Void</button>}
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2 mt-2">
            <label className={label}>Invoice number<input className={input} value={inv.number} onChange={(e) => setInv({ ...inv, number: e.target.value })} /></label>
            <label className={label}>Amount<input className={input} inputMode="decimal" value={inv.amount} onChange={(e) => setInv({ ...inv, amount: e.target.value })} /></label>
            <label className={label}>Currency<input className={input} value={inv.currency} onChange={(e) => setInv({ ...inv, currency: e.target.value.toUpperCase() })} /></label>
            <label className={label}>Issued<input type="date" className={input} value={inv.issuedAt} onChange={(e) => setInv({ ...inv, issuedAt: e.target.value })} /></label>
          </div>
          <button className={`${ghost} mt-2`} disabled={busy} aria-busy={busy} onClick={() => act(() => api.campaignMoney.addInvoice(campaignId, { ...inv, dueAt: inv.dueAt || undefined }), "Invoice recorded", () => setInv({ ...inv, number: "", amount: "", dueAt: "" }))}>Record invoice</button>
        </div>
        <div>
          <div className="text-zinc-400 font-semibold mb-1">Money received</div>
          {data.receipts.map((r) => (
            <div key={r.id} className={r.reversedAt ? "line-through text-zinc-600" : ""}>
              {money(r.amountMicros, r.currency)} on {r.receivedAt.slice(0, 10)} · ref {r.reference}
              {!r.reversedAt && <button className="underline ml-2" onClick={() => { const x = window.prompt("Why reverse this receipt?"); if (x) act(() => api.campaignMoney.reverseReceipt(campaignId, r.id, x), "Receipt reversed"); }}>Reverse</button>}
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2 mt-2">
            <label className={label}>For invoice
              <select className={input} value={rec.invoiceId} onChange={(e) => setRec({ ...rec, invoiceId: e.target.value })}>
                <option value="">None</option>{live.map((i) => <option key={i.id} value={i.id}>{i.number}</option>)}
              </select>
            </label>
            <label className={label}>Amount<input className={input} inputMode="decimal" value={rec.amount} onChange={(e) => setRec({ ...rec, amount: e.target.value })} /></label>
            <label className={label}>Currency<input className={input} value={rec.currency} onChange={(e) => setRec({ ...rec, currency: e.target.value.toUpperCase() })} /></label>
            <label className={label}>Received<input type="date" className={input} value={rec.receivedAt} onChange={(e) => setRec({ ...rec, receivedAt: e.target.value })} /></label>
            <label className={label}>Payment reference<input className={input} value={rec.reference} onChange={(e) => setRec({ ...rec, reference: e.target.value })} /></label>
            <label className={label}>Evidence<input className={input} value={rec.evidence} onChange={(e) => setRec({ ...rec, evidence: e.target.value })} placeholder="e.g. bank statement line, date" /></label>
          </div>
          <button className={`${ghost} mt-2`} disabled={busy} aria-busy={busy} onClick={() => act(() => api.campaignMoney.addReceipt(campaignId, { ...rec, invoiceId: rec.invoiceId || undefined }), "Receipt recorded", () => setRec({ ...rec, amount: "", reference: "", evidence: "" }))}>Record money received</button>
        </div>
      </div>
      {message && <div className="mt-2 text-zinc-300" role="status">{message}</div>}
    </div>
  );
}
