import crypto from "crypto";
import { ApiError } from "../lib/errors.js";
import { DESTINATIONS } from "../lib/revision.js";
import { resolveLocal, isScheduleZone } from "../lib/zonedTime.js";

/**
 * Measurement: readings with provenance, and honest period reports.
 *
 * WHY these rules:
 *  - Source is part of every number (manual / api / fixture). Sources are
 *    never added together: a manual reading of an API-reported count would
 *    double it. Fixtures are excluded unless asked for, and labelled.
 *  - "Cumulative" (a counter as of a moment) and "period" (activity within a
 *    window) are different questions. A report never turns one into the
 *    other silently: activity comes only from period readings that lie fully
 *    inside the window, or from the change between two snapshots, shown with
 *    both timestamps.
 *  - Period readings are selected by the activity interval they describe
 *    (half-open, in the report's time zone), never by when they were read or
 *    recorded: a day read off the platform a week later still counts for
 *    that day. Cumulative snapshots keep snapshot-time selection.
 *  - One window of one series (subject, platform, metric, source, interval)
 *    has one effective value. Reading it again with the same value changes
 *    nothing; a different value supersedes the earlier reading, which is kept
 *    as history. Overlapping windows of one series are never added: the
 *    activity is reported as a conflict instead of a wrong number.
 *  - Every report states its window, time zone, refresh time and what is not
 *    covered. Revenue is never attributed to posts or metrics.
 */
export const SOURCES = ["manual", "api", "fixture"];
export const METRICS = {
  post: ["views", "likes", "comments", "shares", "saves", "watch_time_sec"],
  account: ["followers", "profile_views"],
};
const CUMULATIVE_ONLY = new Set(["followers"]);
const MAX_VALUE = 1e12;
const invalid = (fields) => new ApiError("VALIDATION_FAILED", 400, "Observation is invalid", { fields });

function parseTime(v) {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Validates and records one reading. `source: "api"` is only for provider ingestion. */
export async function recordObservation(prisma, input, { by, allowApi = false, now = new Date() }) {
  const { subjectType, subjectId, metric, kind, value, source, sourceDetail } = input || {};
  const fields = {};
  if (!["post", "account"].includes(subjectType)) fields.subjectType = "must be post or account";
  if (typeof subjectId !== "string" || !subjectId) fields.subjectId = "is required";
  if (!SOURCES.includes(source) || (source === "api" && !allowApi)) fields.source = allowApi ? "must be manual, api or fixture" : "must be manual or fixture (api readings come only from a connected provider)";
  if (subjectType && METRICS[subjectType] && !METRICS[subjectType].includes(metric)) fields.metric = `must be one of ${(METRICS[subjectType] || []).join(", ")}`;
  if (!["cumulative", "period"].includes(kind)) fields.kind = "must be cumulative or period";
  if (kind === "period" && CUMULATIVE_ONLY.has(metric)) fields.kind = `${metric} is a running total; record it as cumulative`;
  if (!Number.isInteger(value) || value < 0 || value > MAX_VALUE) fields.value = "must be a whole number from 0";
  if (source === "manual" && (typeof sourceDetail !== "string" || sourceDetail.trim().length < 5)) fields.sourceDetail = "is required for manual readings: where the number was read (e.g. Instagram Insights, 10 Nov 09:00)";
  if (sourceDetail !== undefined && sourceDetail !== null && (typeof sourceDetail !== "string" || sourceDetail.length > 500)) fields.sourceDetail = "must be at most 500 characters";

  let observedAt = parseTime(input?.observedAt);
  let periodStart = null; let periodEnd = null;
  if (kind === "period") {
    periodStart = parseTime(input?.periodStart); periodEnd = parseTime(input?.periodEnd);
    if (!periodStart || !periodEnd || periodStart >= periodEnd) fields.period = "periodStart and periodEnd (ISO times, start before end) are required";
    else if (periodEnd > now) fields.period = "a period reading can only cover time that has passed";
    observedAt = observedAt || periodEnd;
  }
  if (!observedAt) fields.observedAt = "is required (ISO time the number was read)";
  else if (observedAt.getTime() > now.getTime() + 5 * 60_000) fields.observedAt = "cannot be in the future";
  if (Object.keys(fields).length) throw invalid(fields);

  // The subject must exist; a post must be a real (not simulated) confirmed post.
  let platform;
  if (subjectType === "post") {
    const d = await prisma.publishDelivery.findUnique({ where: { id: subjectId } });
    if (!d) throw new ApiError("NOT_FOUND", 404, "Post not found");
    if (d.simulated || !["published", "resolved_published"].includes(d.state)) {
      throw new ApiError("NOT_A_POST", 409, "Metrics can only be recorded for platform-confirmed posts (not simulated or unconfirmed ones)");
    }
    if (d.confirmedAt && observedAt < d.confirmedAt) throw invalid({ observedAt: "is before the post was confirmed" });
    platform = d.platform;
  } else {
    const c = await prisma.character.findUnique({ where: { id: subjectId } });
    if (!c) throw new ApiError("NOT_FOUND", 404, "Character not found");
    if (!DESTINATIONS.includes(input.platform)) throw invalid({ platform: `must be one of ${DESTINATIONS.join(", ")}` });
    platform = input.platform;
  }

  const data = {
    subjectType, subjectId, platform, metric, kind, value: BigInt(value), observedAt, periodStart, periodEnd,
    source, sourceDetail: sourceDetail?.trim() || null, recordedBy: by,
  };
  if (kind === "period") return recordPeriodReading(prisma, data);

  const key = [subjectType, subjectId, platform, metric, kind, source, observedAt.toISOString(), "", ""].join("|");
  const dedupeKey = crypto.createHash("sha256").update(key).digest("hex");
  const existing = await prisma.metricObservation.findUnique({ where: { dedupeKey } });
  if (existing) {
    if (Number(existing.value) !== value) {
      throw new ApiError("OBSERVATION_CONFLICT", 409, "A different value was already recorded for this exact reading; retract it first if it was wrong", { existingId: existing.id });
    }
    return { observation: existing, replayed: true };
  }
  try {
    return { observation: await prisma.metricObservation.create({ data: { ...data, dedupeKey } }), replayed: false };
  } catch (err) {
    if (err?.code === "P2002") return { observation: await prisma.metricObservation.findUnique({ where: { dedupeKey } }), replayed: true };
    throw err;
  }
}

/** The identity of one window of one measurement series (not when it was read). */
export function intervalIdentity(o) {
  return [o.subjectType, o.subjectId, o.platform, o.metric, o.source, new Date(o.periodStart).toISOString(), new Date(o.periodEnd).toISOString()].join("|");
}

/**
 * One effective value per window. Serialised per window with a transaction
 * advisory lock, so concurrent writers cannot both become effective.
 */
async function recordPeriodReading(prisma, data) {
  const identity = intervalIdentity(data);
  const sameWindow = { subjectType: data.subjectType, subjectId: data.subjectId, platform: data.platform, metric: data.metric, source: data.source, kind: "period", periodStart: data.periodStart, periodEnd: data.periodEnd };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${identity}, 0))`;
    const effective = await tx.metricObservation.findMany({ where: { ...sameWindow, retractedAt: null, supersededAt: null }, orderBy: { recordedAt: "asc" } });
    const same = effective.find((o) => o.value === data.value);
    if (same && effective.length === 1) return { observation: same, replayed: true };
    // A new reading of the window: kept, and the effective one(s) it corrects
    // are marked superseded (legacy duplicates included), never deleted.
    const dedupeKey = crypto.createHash("sha256").update(`${identity}|${data.observedAt.toISOString()}|${data.value}|${crypto.randomUUID()}`).digest("hex");
    const observation = await tx.metricObservation.create({ data: { ...data, dedupeKey } });
    if (effective.length) {
      await tx.metricObservation.updateMany({ where: { id: { in: effective.map((o) => o.id) } }, data: { supersededAt: new Date(), supersededById: observation.id } });
    }
    return { observation, replayed: false, supersedes: effective.length === 1 ? effective[0].id : effective.length ? effective.map((o) => o.id) : null };
  });
}

/**
 * Dry run over existing period readings: windows of one series with more than
 * one effective reading (possible only for rows stored before one-value-per-
 * window). Reads only; changes and deletes nothing.
 */
export async function classifyLegacyPeriodReadings(prisma) {
  const rows = await prisma.metricObservation.findMany({ where: { kind: "period", retractedAt: null, supersededAt: null }, orderBy: { recordedAt: "asc" } });
  const byWindow = new Map();
  for (const o of rows) {
    const k = intervalIdentity(o);
    if (!byWindow.has(k)) byWindow.set(k, []);
    byWindow.get(k).push(o);
  }
  const groups = [...byWindow.values()].filter((l) => l.length > 1).map((l) => {
    const distinct = new Set(l.map((o) => String(o.value))).size;
    return {
      subjectType: l[0].subjectType, subjectId: l[0].subjectId, platform: l[0].platform, metric: l[0].metric, source: l[0].source,
      periodStart: l[0].periodStart.toISOString(), periodEnd: l[0].periodEnd.toISOString(),
      readings: l.length, distinctValues: distinct, observationIds: l.map((o) => o.id),
      classification: distinct === 1 ? "identical_repeats" : "conflicting_values",
      effect: distinct === 1 ? "counted once in reports" : "activity for this window is reported as a conflict until a corrected reading is recorded",
    };
  });
  return { dryRun: true, periodReadings: rows.length, groups };
}

/** Midnight at the start of a local date, as a UTC instant (DST-safe). */
function localMidnight(date, zone) {
  for (const t of ["00:00", "01:00", "02:00", "03:00"]) { // a zone may skip midnight
    const r = resolveLocal(`${date}T${t}`, zone);
    if (r.status === "ok" || r.status === "ambiguous") return r.instants[0];
  }
  return null;
}
const nextDate = (date) => new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1)).toISOString().slice(0, 10);

/** Builds the report window from inclusive local dates in a zone. */
export function reportWindow({ from, to, timezone }) {
  const fields = {};
  const D = /^\d{4}-\d{2}-\d{2}$/;
  if (!D.test(from || "")) fields.from = "must be YYYY-MM-DD";
  if (!D.test(to || "")) fields.to = "must be YYYY-MM-DD";
  if (!isScheduleZone(timezone)) fields.timezone = "must be an IANA time zone, e.g. America/Los_Angeles";
  if (Object.keys(fields).length) throw new ApiError("VALIDATION_FAILED", 400, "Report period is invalid", { fields });
  if (to < from) throw new ApiError("VALIDATION_FAILED", 400, "Report period is invalid", { fields: { to: "must not be before from" } });
  const start = localMidnight(from, timezone); const end = localMidnight(nextDate(to), timezone);
  if (!start || !end) throw new ApiError("VALIDATION_FAILED", 400, "Report period is invalid", { fields: { from: "is not a valid date" } });
  if (end - start > 400 * 86400_000) throw new ApiError("VALIDATION_FAILED", 400, "Report period is invalid", { fields: { to: "the period can be at most 400 days" } });
  return { from, to, timezone, startUtc: start, endUtc: end };
}

/** Covered length of [start,end) by a set of intervals, plus the gaps. */
function coverage(intervals, start, end) {
  const sorted = intervals.map(([a, b]) => [Math.max(a, start), Math.min(b, end)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let covered = 0; let cursor = start; const gaps = [];
  for (const [a, b] of sorted) {
    if (a > cursor) gaps.push([cursor, a]);
    if (b > cursor) { covered += b - Math.max(a, cursor); cursor = b; }
  }
  if (cursor < end) gaps.push([cursor, end]);
  return { fraction: Math.round((covered / (end - start)) * 1000) / 1000, gaps: gaps.map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString() })) };
}

/**
 * Activity from the effective period readings fully inside [start,end).
 * Repeats of one window count once; one window with differing values, or
 * windows that overlap each other, make the value unavailable (a conflict)
 * rather than a sum. Coverage is computed from the same set that is counted.
 */
function periodActivityOf(inside, start, end) {
  const warnings = [];
  if (!inside.length) return { result: null, warnings };
  const byWindow = new Map();
  for (const o of inside) {
    const k = `${o.periodStart.getTime()}|${o.periodEnd.getTime()}`;
    if (!byWindow.has(k)) byWindow.set(k, []);
    byWindow.get(k).push(o);
  }
  const windows = [...byWindow.values()].map((l) => ({ start: l[0].periodStart.getTime(), end: l[0].periodEnd.getTime(), values: [...new Set(l.map((o) => Number(o.value)))], readings: l.length }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const repeated = windows.filter((x) => x.readings > 1 && x.values.length === 1).length;
  if (repeated) warnings.push(`${repeated} window(s) have a repeated reading (stored before one value per window); counted once`);
  const cov = coverage(windows.map((x) => [x.start, x.end]), start, end);
  const base = { readings: windows.length, coveredFraction: cov.fraction, gaps: cov.gaps };
  const iso = (t) => new Date(t).toISOString();
  const differing = windows.filter((x) => x.values.length > 1);
  if (differing.length) {
    warnings.push("one window has different values; record a corrected reading to resolve it");
    return { result: { ...base, value: null, conflict: "conflicting_values_for_one_window", windows: differing.map((x) => ({ start: iso(x.start), end: iso(x.end), values: x.values })) }, warnings };
  }
  const overlaps = [];
  let reach = null;
  for (const x of windows) {
    if (reach && x.start < reach.end) overlaps.push({ first: { start: iso(reach.start), end: iso(reach.end) }, second: { start: iso(x.start), end: iso(x.end) } });
    if (!reach || x.end > reach.end) reach = x;
  }
  if (overlaps.length) {
    warnings.push("readings of this series cover overlapping windows (e.g. a day and the week containing it); they are not added");
    return { result: { ...base, value: null, conflict: "overlapping_readings", overlaps }, warnings };
  }
  return { result: { ...base, value: windows.reduce((n, x) => n + x.values[0], 0) }, warnings };
}

/**
 * Period report. Per subject, metric and SOURCE (never mixed):
 *  - asOfEnd: latest cumulative reading at or before the window end
 *  - snapshotChange: change between the first and last cumulative readings
 *    inside the window (with both times), when there are two
 *  - periodActivity: sum of the effective period readings whose activity
 *    interval lies fully inside the window, with the share of the window
 *    they cover and the gaps, or a conflict when windows overlap; partly
 *    overlapping readings are counted as excluded (they cannot be split
 *    honestly) and named in warnings
 */
export async function buildReport(prisma, { from, to, timezone, platform, characterId, includeFixtures = false, now = new Date() }) {
  const w = reportWindow({ from, to, timezone });
  const start = w.startUtc.getTime(); const end = w.endUtc.getTime();
  const sources = includeFixtures ? SOURCES : ["manual", "api"];

  // Confirmed, real posts that existed before the window ended.
  const deliveries = await prisma.publishDelivery.findMany({
    where: { simulated: false, state: { in: ["published", "resolved_published"] }, confirmedAt: { lt: w.endUtc }, ...(platform ? { platform } : {}) },
    include: { job: true },
  });
  const contents = deliveries.length
    ? await prisma.content.findMany({ where: { id: { in: [...new Set(deliveries.map((d) => d.job.contentId))] } }, select: { id: true, title: true, characterId: true } })
    : [];
  const contentById = new Map(contents.map((c) => [c.id, c]));
  const posts = deliveries.filter((d) => !characterId || contentById.get(d.job.contentId)?.characterId === characterId);

  const obs = await prisma.metricObservation.findMany({
    where: {
      retractedAt: null, supersededAt: null, source: { in: sources },
      AND: [
        { OR: [
          { subjectType: "post", subjectId: { in: posts.map((p) => p.id) } },
          { subjectType: "account", ...(characterId ? { subjectId: characterId } : {}) },
        ] },
        // Snapshots by when they were taken; period readings by the activity
        // interval they describe (overlapping the window at all).
        { OR: [
          { kind: "cumulative", observedAt: { lt: w.endUtc } },
          { kind: "period", periodStart: { lt: w.endUtc }, periodEnd: { gt: w.startUtc } },
        ] },
      ],
      ...(platform ? { platform } : {}),
    },
    orderBy: { observedAt: "asc" },
  });

  const groups = new Map();
  for (const o of obs) {
    const k = `${o.subjectType}|${o.subjectId}|${o.platform}|${o.metric}|${o.source}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(o);
  }
  const series = [...groups.entries()].map(([k, list]) => {
    const [subjectType, subjectId, plat, metric, source] = k.split("|");
    const cum = list.filter((o) => o.kind === "cumulative");
    const last = cum.at(-1);
    const inWin = cum.filter((o) => o.observedAt.getTime() >= start);
    const per = list.filter((o) => o.kind === "period");
    const inside = per.filter((o) => o.periodStart.getTime() >= start && o.periodEnd.getTime() <= end);
    const partial = per.filter((o) => !inside.includes(o));
    const activity = periodActivityOf(inside, start, end);
    const decreased = cum.some((o, i) => i > 0 && o.value < cum[i - 1].value);
    const warnings = [...activity.warnings];
    if (partial.length) warnings.push(`${partial.length} reading(s) partly overlap the period and are not prorated; activity covers only readings fully inside it`);
    return {
      subjectType, subjectId, platform: plat, metric, source,
      asOfEnd: last ? { value: Number(last.value), observedAt: last.observedAt.toISOString() } : null,
      snapshotChange: inWin.length >= 2
        ? { from: { value: Number(inWin[0].value), observedAt: inWin[0].observedAt.toISOString() }, to: { value: Number(inWin.at(-1).value), observedAt: inWin.at(-1).observedAt.toISOString() }, change: Number(inWin.at(-1).value - inWin[0].value) }
        : null,
      periodActivity: activity.result,
      warnings,
      excludedPartialReadings: partial.length,
      ...(decreased ? { anomaly: "a cumulative counter went down between readings" } : {}),
      ...(source === "fixture" ? { fixture: true } : {}),
      lastRecordedAt: list.reduce((m, o) => (o.recordedAt > m ? o.recordedAt : m), list[0].recordedAt).toISOString(),
    };
  });

  // Totals per source and metric (never across sources).
  const totals = {};
  for (const s of series.filter((x) => x.subjectType === "post")) {
    const t = (totals[s.source] ||= {})[s.metric] ||= { periodActivity: 0, postsWithPeriodReadings: 0, conflicts: 0, latestSnapshotsSum: 0, postsWithSnapshots: 0 };
    if (s.periodActivity?.conflict) { t.conflicts++; t.periodActivity = null; }
    else if (s.periodActivity) { if (t.periodActivity !== null) t.periodActivity += s.periodActivity.value; t.postsWithPeriodReadings++; }
    if (s.asOfEnd) { t.latestSnapshotsSum += s.asOfEnd.value; t.postsWithSnapshots++; }
  }
  const measured = new Set(series.filter((s) => s.subjectType === "post" && s.source !== "fixture").map((s) => s.subjectId));
  const refreshedAt = {};
  for (const s of series) if (!refreshedAt[s.source] || s.lastRecordedAt > refreshedAt[s.source]) refreshedAt[s.source] = s.lastRecordedAt;

  return {
    period: { from: w.from, to: w.to, timezone: w.timezone, startUtc: w.startUtc.toISOString(), endUtc: w.endUtc.toISOString(), complete: w.endUtc <= now },
    generatedAt: now.toISOString(),
    refreshedAt,
    sourcesIncluded: sources,
    posts: posts.map((p) => ({
      id: p.id, platform: p.platform, remotePostId: p.remotePostId, permalink: p.permalink, confirmedAt: p.confirmedAt?.toISOString() || null,
      originalId: p.job.contentId, title: contentById.get(p.job.contentId)?.title || null,
    })),
    counts: { originals: new Set(posts.map((p) => p.job.contentId)).size, posts: posts.length },
    series,
    totals,
    missingCoverage: {
      postsWithoutReadings: posts.filter((p) => !measured.has(p.id)).map((p) => ({ id: p.id, platform: p.platform, remotePostId: p.remotePostId })),
      ...(w.endUtc > now ? { note: "The period has not ended; activity so far only" } : {}),
    },
    notes: [
      "Numbers from different sources are never added together.",
      "Cumulative counters are shown as of their reading time; period activity counts only readings whose activity interval lies fully inside the period, whenever they were read.",
      "Overlapping readings of one series are never added; such activity, and any total it belongs to, is shown as a conflict.",
      "Revenue is not attributed to posts or metrics; campaign money is tracked separately (planned, invoiced, received).",
    ],
  };
}
