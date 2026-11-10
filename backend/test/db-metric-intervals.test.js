import crypto from "node:crypto";
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter } from "./db-helpers.js";

/**
 * Remediation AIF 2 and AIF 3 (review of 10 November 2026):
 *  - period readings are selected by the activity interval they describe,
 *    not by when they were observed or recorded (AIF 2);
 *  - one interval of one series has one effective value: repeats are
 *    idempotent, corrections supersede with history, and overlapping
 *    windows are never summed (AIF 3).
 * Synthetic posts and numbers; disposable local Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
async function withApp(fn) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma });
  const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  try { return await fn(call); } finally { await app.close(); }
}

async function seedPost(platforms = ["Instagram"]) {
  const character = await makeCharacter(prisma);
  const content = await prisma.content.create({ data: { title: "Synthetic", characterId: character.id, status: "published", scheduleKey: `k-${crypto.randomUUID()}` } });
  const job = await prisma.publishJob.create({ data: {
    contentId: content.id, pipelineItemId: "synthetic-item", snapshotHash: "h", manifestHash: "m", state: "published",
    deliveries: { create: platforms.map((platform, i) => ({ platform, state: "published", remotePostId: `p-${i}`, confirmedAt: new Date("2026-10-20T12:00:00Z") })) },
  }, include: { deliveries: true } });
  return { character, posts: job.deliveries };
}
const manual = { source: "manual", sourceDetail: "Synthetic insights screen, read by owner" };
const period = (post, periodStart, periodEnd, value, extra = {}) => ({ subjectType: "post", subjectId: post.id, metric: "views", kind: "period", value, periodStart, periodEnd, ...manual, ...extra });
const report = (call, from, to, timezone = "UTC") => call(`/api/metrics/report?from=${from}&to=${to}&timezone=${encodeURIComponent(timezone)}`).then((r) => r.body);
const viewsOf = (rep, post) => rep.series.find((s) => s.subjectId === post.id && s.metric === "views" && s.source === "manual");

// ─── AIF 2: selection by activity interval ──────────────────────────────

test("a full-day reading ending exactly at the report end is in that day's report, also when recorded later", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  assert.equal((await call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", 100))).status, 201);
  const day = viewsOf(await report(call, "2026-11-01", "2026-11-01"), post);
  assert.ok(day, "the 1 November report has a series for the day's reading");
  assert.equal(day.periodActivity.value, 100);
  assert.equal(day.periodActivity.coveredFraction, 1);

  // The same kind of reading for 2 November, read off the platform days later.
  await call("/api/metrics/observations", "POST", period(post, "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z", 40, { observedAt: "2026-11-06T09:00:00Z" }));
  assert.equal(viewsOf(await report(call, "2026-11-02", "2026-11-02"), post).periodActivity.value, 40, "late-recorded activity counts for its own day");
  assert.equal(viewsOf(await report(call, "2026-11-01", "2026-11-01"), post).periodActivity.value, 100, "adjacent day does not leak in");
  const week = viewsOf(await report(call, "2026-10-28", "2026-11-03"), post);
  assert.equal(week.periodActivity.value, 140, "a weekly window contains both days");
  assert.equal(week.periodActivity.readings, 2);
}));

test("report days follow the report time zone across the DST change", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  // 1 November 2026 in Los Angeles is 25 hours long (PDT -> PST).
  await call("/api/metrics/observations", "POST", period(post, "2026-11-01T07:00:00Z", "2026-11-02T08:00:00Z", 250));
  const la = viewsOf(await report(call, "2026-11-01", "2026-11-01", "America/Los_Angeles"), post);
  assert.equal(la.periodActivity.value, 250);
  assert.equal(la.periodActivity.coveredFraction, 1);
  const utc = viewsOf(await report(call, "2026-11-01", "2026-11-01", "UTC"), post);
  assert.equal(utc.periodActivity, null, "in UTC the same reading only partly overlaps 1 November");
  assert.equal(utc.excludedPartialReadings, 1);
  assert.match(utc.warnings.join(" "), /partly overlap/);
}));

test("partial overlaps are excluded with a warning; missing or future endpoints are refused", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  await call("/api/metrics/observations", "POST", period(post, "2026-11-01T12:00:00Z", "2026-11-02T12:00:00Z", 90));
  const r = viewsOf(await report(call, "2026-11-01", "2026-11-01"), post);
  assert.equal(r.periodActivity, null, "not prorated");
  assert.equal(r.excludedPartialReadings, 1);
  assert.match(r.warnings.join(" "), /not prorated/);

  const noEnd = await call("/api/metrics/observations", "POST", { ...period(post, "2026-11-01T00:00:00Z", undefined, 5) });
  assert.equal(noEnd.status, 400);
  const future = await call("/api/metrics/observations", "POST", period(post, "2030-01-01T00:00:00Z", "2030-01-02T00:00:00Z", 5));
  assert.equal(future.status, 400);
}));

test("cumulative snapshots keep snapshot-time selection and are never summed as activity", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  const snap = (value, observedAt) => call("/api/metrics/observations", "POST", { subjectType: "post", subjectId: post.id, metric: "views", kind: "cumulative", value, observedAt, ...manual });
  await snap(500, "2026-10-31T20:00:00Z"); // baseline before the window
  await snap(560, "2026-11-01T06:00:00Z");
  await snap(640, "2026-11-01T22:00:00Z");
  await snap(900, "2026-11-02T00:00:00Z"); // exactly at the exclusive end: not "as of" the window
  const r = viewsOf(await report(call, "2026-11-01", "2026-11-01"), post);
  assert.deepEqual([r.asOfEnd.value, r.snapshotChange.change, r.periodActivity], [640, 80, null]);
}));

// ─── AIF 3: one effective value per interval; no double counting ─────────

test("repeating a reading of the same window counts once and coverage matches the counted set", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  const a = await call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-01T18:00:00Z", 100, { observedAt: "2026-11-01T18:05:00Z" }));
  const b = await call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-01T18:00:00Z", 100, { observedAt: "2026-11-01T21:00:00Z" }));
  assert.equal(a.status, 201);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  assert.equal(b.body.replayed, true);
  const r = viewsOf(await report(call, "2026-11-01", "2026-11-01"), post);
  assert.equal(r.periodActivity.value, 100, "not 200");
  assert.equal(r.periodActivity.readings, 1);
  assert.equal(r.periodActivity.coveredFraction, 0.75);
}));

test("a corrected reading supersedes the earlier one with an auditable revision", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  const first = (await call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", 100))).body.observation;
  const fix = await call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", 120, { observedAt: "2026-11-03T08:00:00Z" }));
  assert.equal(fix.status, 201, JSON.stringify(fix.body));
  assert.equal(fix.body.supersedes, first.id);
  const old = await prisma.metricObservation.findUnique({ where: { id: first.id } });
  assert.ok(old.supersededAt, "history kept, marked superseded");
  assert.equal(old.supersededById, fix.body.observation.id);
  assert.equal(Number(old.value), 100);
  assert.equal(viewsOf(await report(call, "2026-11-01", "2026-11-01"), post).periodActivity.value, 120);
  // Equivalent times in another offset are the same window.
  const same = await call("/api/metrics/observations", "POST", period(post, "2026-10-31T17:00:00-07:00", "2026-11-01T17:00:00-07:00", 120));
  assert.equal(same.body.replayed, true);
}));

test("concurrent corrections of one window leave exactly one effective reading", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  const results = await Promise.all([101, 102, 103, 104].map((v) => call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", v))));
  assert.ok(results.every((r) => [200, 201].includes(r.status)), JSON.stringify(results.map((r) => r.body)));
  const rows = await prisma.metricObservation.findMany({ where: { subjectId: post.id } });
  assert.equal(rows.filter((o) => !o.supersededAt && !o.retractedAt).length, 1);
  assert.equal(rows.length, 4, "every value is kept as history");
  const effective = rows.find((o) => !o.supersededAt);
  assert.equal(viewsOf(await report(call, "2026-11-01", "2026-11-01"), post).periodActivity.value, Number(effective.value));
}));

test("overlapping windows of one series are never summed: daily plus weekly, and partial overlaps", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  await call("/api/metrics/observations", "POST", period(post, "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z", 100));
  await call("/api/metrics/observations", "POST", period(post, "2026-11-01T00:00:00Z", "2026-11-08T00:00:00Z", 600));
  const week = await report(call, "2026-11-01", "2026-11-07");
  const s = viewsOf(week, post);
  assert.equal(s.periodActivity.value, null, "no naive 700");
  assert.equal(s.periodActivity.conflict, "overlapping_readings");
  assert.equal(s.periodActivity.overlaps.length, 1);
  assert.equal(week.totals.manual.views.periodActivity, null, "the total is unavailable too");
  assert.equal(week.totals.manual.views.conflicts, 1);

  const { posts: [other] } = await seedPost();
  await call("/api/metrics/observations", "POST", period(other, "2026-11-01T00:00:00Z", "2026-11-01T12:00:00Z", 10));
  await call("/api/metrics/observations", "POST", period(other, "2026-11-01T06:00:00Z", "2026-11-01T18:00:00Z", 10));
  assert.equal(viewsOf(await report(call, "2026-11-01", "2026-11-01"), other).periodActivity.conflict, "overlapping_readings");
}));

test("distinct platforms and adjacent windows are separate series or disjoint, and still add up", opts, () => withApp(async (call) => {
  const { posts: [ig, tt] } = await seedPost(["Instagram", "TikTok"]);
  for (const p of [ig, tt]) {
    await call("/api/metrics/observations", "POST", period(p, "2026-11-01T00:00:00Z", "2026-11-01T12:00:00Z", 30));
    await call("/api/metrics/observations", "POST", period(p, "2026-11-01T12:00:00Z", "2026-11-02T00:00:00Z", 20));
  }
  const r = await report(call, "2026-11-01", "2026-11-01");
  assert.equal(viewsOf(r, ig).periodActivity.value, 50);
  assert.equal(viewsOf(r, tt).periodActivity.value, 50);
  assert.equal(r.totals.manual.views.periodActivity, 100);
  assert.equal(r.totals.manual.views.conflicts, 0);
}));

test("legacy duplicates: equal values count once, differing values are a conflict, and the dry run deletes nothing", opts, () => withApp(async (call) => {
  const { posts: [post] } = await seedPost();
  // Rows as the previous identity (which included observedAt) stored them.
  const legacy = (value, observedAt, n) => prisma.metricObservation.create({ data: {
    subjectType: "post", subjectId: post.id, platform: post.platform, metric: "views", kind: "period", value: BigInt(value),
    observedAt: new Date(observedAt), periodStart: new Date("2026-11-01T00:00:00Z"), periodEnd: new Date("2026-11-02T00:00:00Z"),
    source: "manual", sourceDetail: "legacy synthetic", dedupeKey: `legacy-${n}`, recordedBy: "owner",
  } });
  await legacy(100, "2026-11-02T00:00:00Z", 1);
  await legacy(100, "2026-11-02T03:00:00Z", 2);
  let s = viewsOf(await report(call, "2026-11-01", "2026-11-01"), post);
  assert.equal(s.periodActivity.value, 100, "identical legacy repeats are not added");
  assert.match(s.warnings.join(" "), /repeated reading/);

  await legacy(130, "2026-11-02T05:00:00Z", 3);
  s = viewsOf(await report(call, "2026-11-01", "2026-11-01"), post);
  assert.equal(s.periodActivity.value, null);
  assert.equal(s.periodActivity.conflict, "conflicting_values_for_one_window");

  const { classifyLegacyPeriodReadings } = await import("../src/services/metrics.js");
  const dry = await classifyLegacyPeriodReadings(prisma);
  assert.equal(dry.groups.length, 1);
  assert.deepEqual([dry.groups[0].readings, dry.groups[0].distinctValues, dry.groups[0].classification], [3, 2, "conflicting_values"]);
  assert.equal(await prisma.metricObservation.count(), 3, "dry run: nothing deleted or changed");
  assert.equal(await prisma.metricObservation.count({ where: { supersededAt: { not: null } } }), 0);
}));
