import { useState, useEffect, useCallback } from "react";
import * as api from "./api.js";

/**
 * Measurement: period reports and readings with provenance.
 *
 * WHY the screen is built this way: every number shows where it came from
 * (manual reading, platform API, or fixture) and when; sources sit side by
 * side and are never added; a counter "as of" a time is not activity in a
 * period; the report states its period, time zone, refresh time and what it
 * does not cover. There is no revenue here: campaign money is separate.
 */
const card = "bg-[#13131a] border border-[#2a2a3a] rounded-xl p-4 mb-4";
const label = "block text-[11px] text-zinc-400 mb-1";
const input = "w-full bg-[#0d0d12] border border-[#2a2a3a] rounded px-2 py-1 text-xs text-zinc-100 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const btn = "text-xs px-3 py-1.5 rounded-lg bg-[#C8FF00] text-black font-semibold disabled:opacity-40 focus:outline focus:outline-2 focus:outline-white";
const ghost = "text-xs px-3 py-1.5 rounded-lg border border-[#2a2a3a] text-zinc-200 disabled:opacity-50 focus:outline focus:outline-2 focus:outline-[#C8FF00]";
const SOURCE = { manual: ["Manual reading", "text-zinc-200"], api: ["Platform API", "text-green-400"], fixture: ["Fixture (not real)", "text-sky-300"] };
const viewerZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const ZONES = (() => { try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC"]; } })();
const isoDay = (d) => d.toISOString().slice(0, 10);
const fmt = (iso, zone) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: zone, dateStyle: "medium", timeStyle: "short" }) : "—");
const num = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-US"));
const hours = (a, b) => Math.round((new Date(b) - new Date(a)) / 36e5);

function RecordForm({ subjects, onDone }) {
  const [f, setF] = useState({ subject: "", metric: "views", kind: "cumulative", value: "", observedAt: "", periodStart: "", periodEnd: "", source: "manual", sourceDetail: "", platform: "Instagram" });
  const [error, setError] = useState("");
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const [type, id] = f.subject.split(":");
  const metrics = subjects?.metrics?.[type] || [];
  const toIso = (local) => (local ? new Date(local).toISOString() : undefined); // browser-local -> UTC
  const submit = async () => {
    setError("");
    try {
      await api.metrics.record({
        subjectType: type, subjectId: id, ...(type === "account" ? { platform: f.platform } : {}),
        metric: f.metric, kind: f.kind, value: Number.isFinite(Number(f.value)) && f.value !== "" ? Number(f.value) : f.value,
        source: f.source, sourceDetail: f.sourceDetail || undefined,
        ...(f.kind === "cumulative" ? { observedAt: toIso(f.observedAt) } : { periodStart: toIso(f.periodStart), periodEnd: toIso(f.periodEnd) }),
      });
      set("value", "");
      onDone("Reading recorded");
    } catch (e) { setError(e.details?.fields ? Object.entries(e.details.fields).map(([k, v]) => `${k} ${v}`).join("; ") : e.message); }
  };
  return (
    <div role="group" aria-label="Record a reading" className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <label className={`${label} sm:col-span-2`}>What was measured
        <select className={input} value={f.subject} onChange={(e) => { set("subject", e.target.value); set("metric", e.target.value.startsWith("account") ? "followers" : "views"); }}>
          <option value="">Choose a post or account…</option>
          <optgroup label="Confirmed posts">
            {(subjects?.posts || []).map((p) => <option key={p.id} value={`post:${p.id}`}>{p.platform} post {p.remotePostId}</option>)}
          </optgroup>
          <optgroup label="Character accounts">
            {(subjects?.characters || []).map((c) => <option key={c.id} value={`account:${c.id}`}>{c.name} account</option>)}
          </optgroup>
        </select>
      </label>
      {type === "account" && (
        <label className={label}>Platform
          <select className={input} value={f.platform} onChange={(e) => set("platform", e.target.value)}>{["TikTok", "Instagram", "YouTube"].map((p) => <option key={p}>{p}</option>)}</select>
        </label>
      )}
      <label className={label}>Metric
        <select className={input} value={f.metric} onChange={(e) => set("metric", e.target.value)}>{metrics.map((m) => <option key={m}>{m}</option>)}</select>
      </label>
      <label className={label}>Kind
        <select className={input} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
          <option value="cumulative">Running total, as of a time</option>
          <option value="period">Activity during a period</option>
        </select>
      </label>
      <label className={label}>Value<input className={input} inputMode="numeric" value={f.value} onChange={(e) => set("value", e.target.value)} /></label>
      {f.kind === "cumulative" ? (
        <label className={label}>Read at (your time)<input type="datetime-local" className={input} value={f.observedAt} onChange={(e) => set("observedAt", e.target.value)} /></label>
      ) : (<>
        <label className={label}>Period start (your time)<input type="datetime-local" className={input} value={f.periodStart} onChange={(e) => set("periodStart", e.target.value)} /></label>
        <label className={label}>Period end (your time)<input type="datetime-local" className={input} value={f.periodEnd} onChange={(e) => set("periodEnd", e.target.value)} /></label>
      </>)}
      <label className={label}>Source
        <select className={input} value={f.source} onChange={(e) => set("source", e.target.value)}>
          <option value="manual">Manual reading</option>
          <option value="fixture">Fixture (test data, not real)</option>
        </select>
      </label>
      <label className={`${label} sm:col-span-2`}>Where the number was read
        <input className={input} value={f.sourceDetail} onChange={(e) => set("sourceDetail", e.target.value)} placeholder="e.g. Instagram Insights, post screen" />
      </label>
      {error && <div className="text-[11px] text-red-400 sm:col-span-3" role="alert">{error}</div>}
      <div><button className={btn} disabled={!f.subject} onClick={submit}>Record reading</button></div>
    </div>
  );
}

export default function Measurement() {
  const today = new Date();
  const [q, setQ] = useState({ from: isoDay(new Date(today - 29 * 864e5)), to: isoDay(today), timezone: viewerZone(), platform: "", includeFixtures: false });
  const [report, setReport] = useState(null);
  const [subjects, setSubjects] = useState(null);
  const [providers, setProviders] = useState(null);
  const [readings, setReadings] = useState([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const params = { from: q.from, to: q.to, timezone: q.timezone, includeFixtures: String(q.includeFixtures), ...(q.platform ? { platform: q.platform } : {}) };
      const [r, s, p, o] = await Promise.all([api.metrics.report(params), api.metrics.subjects(), api.metrics.providers(), api.metrics.observations()]);
      setReport(r); setSubjects(s); setProviders(p); setReadings(o);
    } catch (e) { setError(e.details?.fields ? Object.values(e.details.fields).join("; ") : e.message); }
  }, [q]);
  useEffect(() => { load(); }, [load]);
  const set = (k, v) => setQ((p) => ({ ...p, [k]: v }));
  const postName = (id) => { const p = report?.posts.find((x) => x.id === id); return p ? `${p.platform} ${p.remotePostId}` : id.slice(0, 8); };
  const sources = report ? Object.keys(report.totals) : [];

  return (
    <div className="p-3 sm:p-6 max-w-[1200px] mx-auto">
      <h1 style={{ fontFamily: "'Bebas Neue', sans-serif", letterSpacing: "0.1em" }} className="text-3xl text-zinc-100">Measurement</h1>
      <p className="text-zinc-500 text-sm mb-4">Readings with their source and time. Sources are shown side by side and never added. No revenue is attributed to posts.</p>

      <section className={card} aria-label="Report period">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
          <label className={label}>From<input type="date" className={input} value={q.from} onChange={(e) => set("from", e.target.value)} /></label>
          <label className={label}>To (inclusive)<input type="date" className={input} value={q.to} onChange={(e) => set("to", e.target.value)} /></label>
          <label className={label}>Time zone
            <input className={input} list="m-tz" value={q.timezone} onChange={(e) => set("timezone", e.target.value)} />
            <datalist id="m-tz">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
          </label>
          <label className={label}>Platform
            <select className={input} value={q.platform} onChange={(e) => set("platform", e.target.value)}><option value="">All</option>{["TikTok", "Instagram", "YouTube"].map((p) => <option key={p}>{p}</option>)}</select>
          </label>
          <label className="text-[11px] text-zinc-400 flex items-center gap-1"><input type="checkbox" checked={q.includeFixtures} onChange={(e) => set("includeFixtures", e.target.checked)} />Include fixtures</label>
        </div>
        {error && <div className="text-xs text-red-400 mt-2" role="alert">{error}</div>}
        {report && (
          <dl className="text-[11px] text-zinc-300 mt-3 grid grid-cols-[auto,minmax(0,1fr)] gap-x-3 gap-y-1" aria-label="Report facts">
            <dt className="text-zinc-500">Period</dt>
            <dd>{report.period.from} to {report.period.to} in {report.period.timezone} = {report.period.startUtc.replace(".000Z", "Z")} → {report.period.endUtc.replace(".000Z", "Z")} ({hours(report.period.startUtc, report.period.endUtc)} h){report.period.complete ? "" : " · period not finished"}</dd>
            <dt className="text-zinc-500">Last refreshed</dt>
            <dd>{Object.keys(report.refreshedAt).length ? Object.entries(report.refreshedAt).map(([s, t]) => `${SOURCE[s][0]}: ${fmt(t, report.period.timezone)}`).join(" · ") : "No readings yet"}</dd>
            <dt className="text-zinc-500">Content</dt>
            <dd>{report.counts.originals} original(s) posted as {report.counts.posts} post(s)</dd>
            <dt className="text-zinc-500">Not covered</dt>
            <dd className={report.missingCoverage.postsWithoutReadings.length ? "text-amber-300" : ""}>
              {report.missingCoverage.postsWithoutReadings.length ? `${report.missingCoverage.postsWithoutReadings.length} post(s) without any reading: ${report.missingCoverage.postsWithoutReadings.map((p) => `${p.platform} ${p.remotePostId}`).join(", ")}` : "Every post has at least one reading"}
              {report.missingCoverage.note ? ` · ${report.missingCoverage.note}` : ""}
            </dd>
          </dl>
        )}
      </section>

      {report && (
        <section className={card} aria-label="Totals by source">
          <div className="text-xs text-zinc-400 font-semibold mb-2">Totals by source (never combined)</div>
          {sources.length === 0 ? <div className="text-xs text-zinc-500">No post readings in this period.</div> : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {sources.map((s) => (
                <div key={s} className="border border-[#2a2a3a] rounded-lg p-3">
                  <div className={`text-xs font-semibold mb-1 ${SOURCE[s][1]}`}>{SOURCE[s][0]}</div>
                  <table className="w-full text-[11px] text-zinc-300">
                    <thead><tr className="text-left text-zinc-500"><th>Metric</th><th>Activity in period</th><th>Latest totals</th></tr></thead>
                    <tbody>{Object.entries(report.totals[s]).map(([m, t]) => (
                      <tr key={m}><td>{m}</td><td>{t.postsWithPeriodReadings ? `${num(t.periodActivity)} (${t.postsWithPeriodReadings} post)` : "—"}</td><td>{t.postsWithSnapshots ? `${num(t.latestSnapshotsSum)} (${t.postsWithSnapshots} post)` : "—"}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {report && report.series.length > 0 && (
        <section className={card} aria-label="Per post and account">
          <div className="text-xs text-zinc-400 font-semibold mb-2">Per post and account</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[11px] text-zinc-300">
              <thead><tr className="text-left text-zinc-500"><th>Subject</th><th>Metric</th><th>Source</th><th>Total as of period end</th><th>Change between readings</th><th>Activity in period</th></tr></thead>
              <tbody>{report.series.map((s, i) => (
                <tr key={i} className="align-top border-t border-[#2a2a3a]">
                  <td>{s.subjectType === "post" ? postName(s.subjectId) : `${(subjects?.characters || []).find((c) => c.id === s.subjectId)?.name || "Account"} · ${s.platform}`}</td>
                  <td>{s.metric}</td>
                  <td className={SOURCE[s.source][1]}>{SOURCE[s.source][0]}</td>
                  <td>{s.asOfEnd ? <>{num(s.asOfEnd.value)} <span className="text-zinc-500">as of {fmt(s.asOfEnd.observedAt, report.period.timezone)}</span></> : "—"}{s.anomaly && <div className="text-amber-300">{s.anomaly}</div>}</td>
                  <td>{s.snapshotChange ? <>{s.snapshotChange.change >= 0 ? "+" : ""}{num(s.snapshotChange.change)} <span className="text-zinc-500">({fmt(s.snapshotChange.from.observedAt, report.period.timezone)} → {fmt(s.snapshotChange.to.observedAt, report.period.timezone)})</span></> : "—"}</td>
                  <td>{s.periodActivity ? <>{num(s.periodActivity.value)} <span className={s.periodActivity.coveredFraction < 1 ? "text-amber-300" : "text-zinc-500"}>covers {Math.round(s.periodActivity.coveredFraction * 100)}% of the period</span></> : "—"}
                    {s.excludedPartialReadings > 0 && <div className="text-zinc-500">{s.excludedPartialReadings} reading(s) crossing the period edge not counted</div>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </section>
      )}

      <section className={card} aria-label="Readings">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="text-xs text-zinc-400 font-semibold">Record a reading</div>
          <div className="flex items-center gap-2 text-[11px] text-zinc-500">
            {providers && (providers.enabled && providers.providers.some((p) => p.implemented) ? "Platform analytics connected" : "Platform analytics: not connected (needs an approved account and official API access)")}
            <button className={ghost} onClick={async () => { try { await api.metrics.refresh(); setMessage("Refreshed from the platform"); load(); } catch (e) { setMessage(e.message); } }}>Refresh from platform</button>
          </div>
        </div>
        <RecordForm subjects={subjects} onDone={(m) => { setMessage(m); load(); }} />
        {message && <div className="text-xs text-zinc-300 mt-2" role="status">{message}</div>}
        {readings.length > 0 && (
          <div className="overflow-x-auto mt-3">
            <table className="w-full min-w-[640px] text-[11px] text-zinc-300" aria-label="Recent readings">
              <thead><tr className="text-left text-zinc-500"><th>Read at</th><th>Subject</th><th>Metric</th><th>Value</th><th>Source</th><th /></tr></thead>
              <tbody>{readings.slice(0, 30).map((o) => (
                <tr key={o.id} className={`border-t border-[#2a2a3a] ${o.retractedAt ? "line-through text-zinc-600" : ""}`}>
                  <td>{o.kind === "period" ? `${fmt(o.periodStart, q.timezone)} → ${fmt(o.periodEnd, q.timezone)}` : fmt(o.observedAt, q.timezone)}</td>
                  <td>{o.subjectType === "post" ? postName(o.subjectId) : `account · ${o.platform}`}</td>
                  <td>{o.metric} ({o.kind})</td>
                  <td>{num(o.value)}</td>
                  <td className={SOURCE[o.source][1]}>{SOURCE[o.source][0]}{o.sourceDetail ? `: ${o.sourceDetail}` : ""}</td>
                  <td>{!o.retractedAt && <button className="underline" onClick={async () => {
                    const reason = window.prompt("Why is this reading wrong?");
                    if (!reason) return;
                    try { await api.metrics.retract(o.id, reason); setMessage("Reading retracted"); load(); } catch (e) { setMessage(e.message); }
                  }}>Retract</button>}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
      {report && <ul className="text-[11px] text-zinc-500 list-disc ml-5">{report.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}
