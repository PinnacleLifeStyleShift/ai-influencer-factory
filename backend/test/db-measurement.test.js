import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter } from "./db-helpers.js";
import { createSessionStore } from "../src/auth/sessions.js";

/**
 * Measurement (brief section 10, second half): readings with provenance,
 * period reports with time zone, refresh time and missing coverage, sources
 * never mixed, no revenue attribution; campaign money as planned / invoiced /
 * received. Synthetic data; disposable local Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

async function withApp(fn, { env = {}, metricsProviders } = {}) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, ...env }, prisma, metricsProviders });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const call = (app, p, { method = "GET", body } = {}) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
const as = (app, token, p, { method = "GET", body } = {}) => app.raw(p, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
const roleToken = async (role) => (await createSessionStore(prisma).create({ id: `synthetic-${role}`, role, workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;

/** One original cross-posted to Instagram + TikTok (confirmed), plus a simulated post. */
async function seedPosts() {
  const character = await makeCharacter(prisma);
  const content = await prisma.content.create({ data: { title: "Calm mornings", characterId: character.id, status: "published", scheduleKey: "k-1" } });
  const job = await prisma.publishJob.create({ data: {
    contentId: content.id, pipelineItemId: "synthetic-item", snapshotHash: "h", manifestHash: "m", state: "published",
    deliveries: { create: [
      { platform: "Instagram", state: "published", remotePostId: "ig-1", permalink: "https://example.test/ig/1", confirmedAt: new Date("2026-10-30T12:00:00Z") },
      { platform: "TikTok", state: "published", remotePostId: "tt-1", permalink: "https://example.test/tt/1", confirmedAt: new Date("2026-10-30T12:00:00Z") },
    ] },
  }, include: { deliveries: true } });
  const other = await prisma.content.create({ data: { title: "Sim", characterId: character.id, status: "scheduled", scheduleKey: "k-2" } });
  const sim = await prisma.publishJob.create({ data: {
    contentId: other.id, pipelineItemId: "synthetic-item-2", snapshotHash: "h2", manifestHash: "m2", state: "simulated",
    deliveries: { create: [{ platform: "Instagram", state: "simulated", simulated: true, remotePostId: "sim-1", confirmedAt: new Date("2026-10-30T12:00:00Z") }] },
  }, include: { deliveries: true } });
  const by = Object.fromEntries(job.deliveries.map((d) => [d.platform, d]));
  return { character, ig: by.Instagram, tt: by.TikTok, simulated: sim.deliveries[0] };
}
const reading = (app, body) => call(app, "/api/metrics/observations", { method: "POST", body });
const manual = { source: "manual", sourceDetail: "Instagram Insights screen, read by owner" };

test("readings need provenance, a real confirmed post and sensible times and values", opts, () => withApp(async (app) => {
  const { ig, simulated, character } = await seedPosts();
  const base = { subjectType: "post", subjectId: ig.id, metric: "views", kind: "cumulative", value: 100, observedAt: "2026-11-01T10:00:00Z" };
  const field = async (body, f) => {
    const r = await reading(app, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.details.fields[f], `${f} in ${JSON.stringify(r.body.details.fields)}`);
  };
  await field({ ...base, source: "manual" }, "sourceDetail");
  await field({ ...base, source: "api", sourceDetail: "x" }, "source");
  await field({ ...base, ...manual, value: -1 }, "value");
  await field({ ...base, ...manual, value: 1.5 }, "value");
  await field({ ...base, ...manual, observedAt: "2099-01-01T00:00:00Z" }, "observedAt");
  await field({ ...base, ...manual, observedAt: "2026-10-01T00:00:00Z" }, "observedAt"); // before the post existed
  await field({ ...base, ...manual, kind: "period" }, "period");
  await field({ ...base, ...manual, kind: "period", periodStart: "2026-11-01T00:00:00Z", periodEnd: "2099-01-01T00:00:00Z" }, "period");
  await field({ subjectType: "account", subjectId: character.id, platform: "Instagram", metric: "followers", kind: "period", value: 5, periodStart: "2026-11-01T00:00:00Z", periodEnd: "2026-11-02T00:00:00Z", ...manual }, "kind");
  await field({ subjectType: "account", subjectId: character.id, platform: "Myspace", metric: "followers", kind: "cumulative", value: 5, observedAt: "2026-11-01T00:00:00Z", ...manual }, "platform");
  const sim = await reading(app, { ...base, ...manual, subjectId: simulated.id });
  assert.equal(sim.body.code, "NOT_A_POST", "simulated posts cannot be measured");
  assert.equal((await reading(app, { ...base, ...manual })).status, 201);
}));

test("readings are idempotent, conflicting values are refused, and retraction allows a correction", opts, () => withApp(async (app) => {
  const { ig } = await seedPosts();
  const r = { subjectType: "post", subjectId: ig.id, metric: "views", kind: "cumulative", value: 100, observedAt: "2026-11-01T10:00:00Z", ...manual };
  assert.equal((await reading(app, r)).status, 201);
  const again = await reading(app, r);
  assert.equal(again.body.replayed, true);
  const conflict = await reading(app, { ...r, value: 1000 });
  assert.equal(conflict.body.code, "OBSERVATION_CONFLICT");
  const id = conflict.body.details.existingId;
  assert.equal((await call(app, `/api/metrics/observations/${id}/retract`, { method: "POST", body: {} })).status, 400, "reason required");
  assert.equal((await call(app, `/api/metrics/observations/${id}/retract`, { method: "POST", body: { reason: "Typo: missed a zero" } })).status, 200);
  assert.equal((await call(app, `/api/metrics/observations/${id}/retract`, { method: "POST", body: { reason: "again" } })).body.code, "ALREADY_RETRACTED");
  assert.equal((await reading(app, { ...r, value: 1000 })).status, 201, "the corrected value can now be recorded");
  assert.equal(await prisma.metricObservation.count(), 2, "the wrong reading is kept, marked retracted");
}));

test("report: DST-length day, period vs cumulative, sources never mixed, coverage and gaps", opts, () => withApp(async (app) => {
  const { ig, tt } = await seedPosts();
  const post = { subjectType: "post", subjectId: ig.id, metric: "views" };
  // Cumulative snapshots: two inside the day, one after it.
  for (const [observedAt, value] of [["2026-11-01T10:00:00Z", 500], ["2026-11-01T20:00:00Z", 800], ["2026-11-03T00:00:00Z", 2000]]) {
    assert.equal((await reading(app, { ...post, ...manual, kind: "cumulative", value, observedAt })).status, 201);
  }
  // Period readings: one inside the day, one straddling its start.
  await reading(app, { ...post, ...manual, kind: "period", value: 100, periodStart: "2026-11-01T08:00:00Z", periodEnd: "2026-11-01T12:00:00Z" });
  await reading(app, { ...post, ...manual, kind: "period", value: 999, periodStart: "2026-11-01T06:00:00Z", periodEnd: "2026-11-01T09:00:00Z" });
  // The same post from another source, and a fixture.
  await prisma.metricObservation.create({ data: { subjectType: "post", subjectId: ig.id, platform: "Instagram", metric: "views", kind: "cumulative", value: 790n, observedAt: new Date("2026-11-01T21:00:00Z"), source: "api", sourceDetail: "mock-insights", dedupeKey: "api-1", recordedBy: "system" } });
  await reading(app, { ...post, source: "fixture", kind: "cumulative", value: 123456, observedAt: "2026-11-01T11:00:00Z" });

  const r = await call(app, "/api/metrics/report?from=2026-11-01&to=2026-11-01&timezone=America/Los_Angeles");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rep = r.body;
  // 1 Nov 2026 in Los Angeles is 25 hours long (clocks go back).
  assert.equal(rep.period.startUtc, "2026-11-01T07:00:00.000Z");
  assert.equal(rep.period.endUtc, "2026-11-02T08:00:00.000Z");
  assert.deepEqual(rep.sourcesIncluded, ["manual", "api"], "fixtures excluded by default");

  const m = rep.series.find((s) => s.subjectId === ig.id && s.metric === "views" && s.source === "manual");
  assert.deepEqual(m.asOfEnd, { value: 800, observedAt: "2026-11-01T20:00:00.000Z" }, "the reading after the period is not used");
  assert.equal(m.snapshotChange.change, 300);
  assert.equal(m.periodActivity.value, 100, "only the reading fully inside counts");
  assert.equal(m.excludedPartialReadings, 1);
  assert.equal(m.periodActivity.coveredFraction, 0.16); // 4 h of 25 h
  assert.equal(m.periodActivity.gaps.length, 2);
  const api = rep.series.find((s) => s.subjectId === ig.id && s.source === "api");
  assert.equal(api.asOfEnd.value, 790);
  assert.equal(rep.totals.manual.views.latestSnapshotsSum, 800);
  assert.equal(rep.totals.api.views.latestSnapshotsSum, 790, "sources are reported side by side, never added");
  assert.ok(!rep.series.some((s) => s.source === "fixture"));
  assert.ok(rep.refreshedAt.manual && rep.refreshedAt.api);

  // One original, two posts; the TikTok post has no readings; the simulated post is not a post.
  assert.deepEqual(rep.counts, { originals: 1, posts: 2 });
  assert.deepEqual(rep.missingCoverage.postsWithoutReadings.map((p) => p.id), [tt.id]);
  // No revenue anywhere in a metrics report.
  assert.ok(!/revenue"|earn|payout|income/i.test(JSON.stringify({ ...rep, notes: [] })));

  const withFixtures = (await call(app, "/api/metrics/report?from=2026-11-01&to=2026-11-01&timezone=America/Los_Angeles&includeFixtures=true")).body;
  const fx = withFixtures.series.find((s) => s.source === "fixture");
  assert.equal(fx.fixture, true);

  for (const q of ["from=2026-11-02&to=2026-11-01&timezone=UTC", "from=2026-11-01&to=2026-11-01&timezone=PST", "from=2025-01-01&to=2026-11-01&timezone=UTC"]) {
    assert.equal((await call(app, `/api/metrics/report?${q}`)).status, 400, q);
  }
}));

test("a counter that goes down is flagged, not hidden", opts, () => withApp(async (app) => {
  const { ig } = await seedPosts();
  for (const [observedAt, value] of [["2026-11-01T10:00:00Z", 500], ["2026-11-01T12:00:00Z", 450]]) {
    await reading(app, { subjectType: "post", subjectId: ig.id, metric: "views", kind: "cumulative", value, observedAt, ...manual });
  }
  const rep = (await call(app, "/api/metrics/report?from=2026-11-01&to=2026-11-01&timezone=UTC")).body;
  assert.match(rep.series[0].anomaly, /went down/);
}));

test("a period count is never shown as a running total", opts, () => withApp(async (app) => {
  const { ig } = await seedPosts();
  const post = { subjectType: "post", subjectId: ig.id, metric: "views", ...manual };
  await reading(app, { ...post, kind: "cumulative", value: 5000, observedAt: "2026-11-01T10:00:00Z" });
  // A later, small period count must not replace the running total.
  await reading(app, { ...post, kind: "period", value: 40, periodStart: "2026-11-01T11:00:00Z", periodEnd: "2026-11-01T12:00:00Z" });
  const s = (await call(app, "/api/metrics/report?from=2026-11-01&to=2026-11-01&timezone=UTC")).body.series[0];
  assert.deepEqual(s.asOfEnd, { value: 5000, observedAt: "2026-11-01T10:00:00.000Z" });
  assert.equal(s.periodActivity.value, 40);
}));

test("platform analytics refresh is disabled by default; an approved provider records api readings", opts, async () => {
  await withApp(async (app) => {
    const r = await call(app, "/api/metrics/refresh", { method: "POST" });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "METRICS_API_DISABLED");
    assert.equal((await as(app, await roleToken("editor"), "/api/metrics/refresh", { method: "POST" })).status, 403);
  });
  let posts;
  const provider = {
    name: "mock-insights", platform: "Instagram", implemented: true,
    async fetch(list) {
      posts = list;
      return [
        ...list.map((p) => ({ subjectType: "post", subjectId: p.id, metric: "views", kind: "cumulative", value: 1200, observedAt: "2026-11-05T00:00:00Z" })),
        { subjectType: "post", subjectId: "missing-post", metric: "views", kind: "cumulative", value: 1, observedAt: "2026-11-05T00:00:00Z" },
      ];
    },
  };
  await withApp(async (app) => {
    await seedPosts();
    const r = await call(app, "/api/metrics/refresh", { method: "POST" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(posts.length, 1, "only the confirmed Instagram post, never the simulated one");
    assert.deepEqual([r.body.refreshed[0].recorded, r.body.refreshed[0].rejected.length], [1, 1]);
    const again = await call(app, "/api/metrics/refresh", { method: "POST" });
    assert.equal(again.body.refreshed[0].replayed, 1);
    const obs = (await call(app, "/api/metrics/observations?source=api")).body;
    assert.deepEqual([obs.length, obs[0].sourceDetail, obs[0].value], [1, "mock-insights", 1200]);
  }, { env: { METRICS_API: "enabled" }, metricsProviders: [provider] });
});

test("campaign money: planned, invoiced and received are separate; corrections void or reverse", opts, () => withApp(async (app) => {
  const camp = await prisma.campaign.create({ data: { name: "Synthetic Sponsor", payoutAmount: "500", currency: "USD" } });
  const inv = (body) => call(app, `/api/campaigns/${camp.id}/invoices`, { method: "POST", body });
  const rec = (body) => call(app, `/api/campaigns/${camp.id}/receipts`, { method: "POST", body });

  // Planned only: nothing invoiced or received.
  let money = (await call(app, `/api/campaigns/${camp.id}/money`)).body;
  assert.deepEqual(money.summary.USD, { plannedMicros: 500e6, invoicedMicros: 0, receivedMicros: 0, outstandingMicros: 0, overpaidMicros: 0 });

  assert.equal((await as(app, await roleToken("editor"), `/api/campaigns/${camp.id}/invoices`, { method: "POST", body: {} })).status, 403);
  const bad = await inv({ number: "", amount: "-5", currency: "usd", issuedAt: "2099-01-01" });
  assert.deepEqual(Object.keys(bad.body.details.fields).sort(), ["amount", "currency", "issuedAt", "number"]);
  const i1 = await inv({ number: "INV-001", amount: "300.00", currency: "USD", issuedAt: "2026-11-02" });
  assert.equal(i1.status, 201);
  assert.equal((await inv({ number: "INV-001", amount: "1", currency: "USD", issuedAt: "2026-11-02" })).body.code, "DUPLICATE_INVOICE");

  assert.equal((await rec({ invoiceId: i1.body.id, amount: "100", currency: "EUR", receivedAt: "2026-11-05", reference: "BANK-1", evidence: "Bank statement line 2026-11-05" })).status, 400, "currency must match the invoice");
  const noEvidence = await rec({ amount: "100", currency: "USD", receivedAt: "2026-11-05", reference: "BANK-1" });
  assert.ok(noEvidence.body.details.fields.evidence);
  const r1 = await rec({ invoiceId: i1.body.id, amount: "100", currency: "USD", receivedAt: "2026-11-05", reference: "BANK-1", evidence: "Bank statement line 2026-11-05" });
  assert.equal(r1.status, 201);

  money = (await call(app, `/api/campaigns/${camp.id}/money`)).body;
  assert.deepEqual(money.summary.USD, { plannedMicros: 500e6, invoicedMicros: 300e6, receivedMicros: 100e6, outstandingMicros: 200e6, overpaidMicros: 0 });
  assert.match(money.planned.note, /not income/);

  // Corrections: an invoice with live receipts cannot be voided; reverse first.
  assert.equal((await call(app, `/api/campaigns/${camp.id}/invoices/${i1.body.id}/void`, { method: "POST", body: { reason: "Wrong amount" } })).body.code, "INVOICE_HAS_RECEIPTS");
  assert.equal((await call(app, `/api/campaigns/${camp.id}/receipts/${r1.body.id}/reverse`, { method: "POST", body: { reason: "Bounced" } })).status, 200);
  assert.equal((await call(app, `/api/campaigns/${camp.id}/receipts/${r1.body.id}/reverse`, { method: "POST", body: { reason: "Bounced" } })).body.code, "ALREADY_REVERSED");
  assert.equal((await call(app, `/api/campaigns/${camp.id}/invoices/${i1.body.id}/void`, { method: "POST", body: { reason: "Wrong amount" } })).status, 200);
  money = (await call(app, `/api/campaigns/${camp.id}/money`)).body;
  assert.equal(money.summary.USD.invoicedMicros, 0);
  assert.equal(money.summary.USD.receivedMicros, 0);
  assert.equal(money.invoices.length, 1, "kept, marked void");

  // Financial records keep their campaign.
  assert.equal((await call(app, `/api/campaigns/${camp.id}`, { method: "DELETE" })).body.code, "CAMPAIGN_HAS_MONEY_RECORDS");
}));

test("dashboard: confirmed posts only, money by state, no 'earned' total, self-reported counters flagged", opts, () => withApp(async (app) => {
  await seedPosts();
  const camp = await prisma.campaign.create({ data: { name: "S", payoutAmount: "250" } });
  await prisma.campaignSubmission.create({ data: { campaignId: camp.id, characterId: (await makeCharacter(prisma)).id, payout: 9999 } });
  const d = (await call(app, "/api/dashboard")).body;
  assert.equal(d.content.published, 1);
  assert.equal(d.content.scheduled, 1, "the simulated one is still only scheduled");
  assert.equal(d.campaigns.money.USD.plannedMicros, 250e6);
  assert.equal(d.campaigns.money.USD.receivedMicros, 0, "a submission's payout field is not money received");
  assert.ok(!("totalEarned" in d.campaigns));
  assert.equal(d.characters.countersAreSelfReported, true);
  assert.deepEqual([d.measurement.confirmedPosts, d.measurement.postsWithoutReadings], [2, 2]);
}));

test("calendar content no longer takes bare view/like counters", opts, () => withApp(async (app) => {
  const character = await makeCharacter(prisma);
  const c = await prisma.content.create({ data: { title: "t", characterId: character.id } });
  assert.equal((await call(app, `/api/content/${c.id}`, { method: "PUT", body: { views: 1000 } })).body.code, "METRICS_USE_READINGS");
}));

// Spec 11 Nov: "Disable duplicate submission with server enforcement, not only
// a spinner." A double click must not record the same payment twice (income
// would be overstated); a reversed receipt can be recorded again as a correction.
test("the same payment cannot be recorded twice, even by simultaneous requests", opts, () => withApp(async (app) => {
  const camp = await prisma.campaign.create({ data: { name: "Synthetic Sponsor", payoutAmount: "500", currency: "USD" } });
  const body = { amount: "100", currency: "USD", receivedAt: "2026-11-05", reference: "BANK-77", evidence: "Bank statement line 2026-11-05" };
  const rec = () => call(app, `/api/campaigns/${camp.id}/receipts`, { method: "POST", body });
  const results = await Promise.all([rec(), rec(), rec()]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409], JSON.stringify(results.map((r) => r.body)));
  assert.ok(results.filter((r) => r.status === 409).every((r) => r.body.code === "DUPLICATE_RECEIPT"));
  assert.equal(await prisma.campaignReceipt.count({ where: { campaignId: camp.id } }), 1);
  const money = (await call(app, `/api/campaigns/${camp.id}/money`)).body;
  assert.equal(money.summary.USD.receivedMicros, 100e6, "received once");

  const first = results.find((r) => r.status === 201).body;
  await call(app, `/api/campaigns/${camp.id}/receipts/${first.id}/reverse`, { method: "POST", body: { reason: "Recorded with the wrong date" } });
  assert.equal((await rec()).status, 201, "after a reversal the payment can be recorded again");
}));
