import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";
import { recoverAbandoned } from "../src/services/generationJobs.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";

/**
 * Code review of 12 November 2026 (AI Influencer Factory, at 30f05a4):
 * the PostgreSQL side of IF-R1 / IF-R2, recovery fencing (IF-R4) on two real
 * connections, and rights at the delivery boundary (IF-R5). Synthetic data;
 * mock publishers; disposable Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
let a; let b; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) { a = newClient(); b = newClient(); } });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await a?.$disconnect(); await b?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(a); });

const CAPS = { perJobMicros: 1_000_000, dailyMicros: 100_000_000, monthlyMicros: 100_000_000, timezone: "UTC" };
const entry = (amountMicros, key) => ({ provider: "mock", model: "m", amountMicros, idempotencyKey: key, requestHash: "h", currency: "USD", priceVersion: "v1" });

test("IF-R1 (PostgreSQL ledger): the per-job cap bounds the whole workflow", opts, async () => {
  const ledger = createPrismaLedger(a);
  await assert.rejects(ledger.reserveGroup([entry(750_000, "p1"), entry(750_000, "p2")], CAPS), (e) => e.code === "BUDGET_EXCEEDED");
  assert.equal(await a.generationReservation.count(), 0, "nothing reserved");
  assert.equal((await ledger.reserveGroup([entry(500_000, "q1"), entry(500_000, "q2")], CAPS)).length, 2);
});

test("IF-R2 (PostgreSQL ledger and export label): an estimate is never recorded or exported as an actual", opts, async () => {
  const ledger = createPrismaLedger(a);
  const [r] = await ledger.reserveGroup([entry(500_000, "e1")], CAPS);
  await ledger.settle(r.reservationId, null, { imageUrl: "x" });
  const row = await a.generationReservation.findUnique({ where: { id: r.reservationId } });
  assert.equal(row.state, "settled");
  assert.equal(row.actualMicros, null);
  assert.equal((await ledger.totals("UTC")).dayMicros, 500_000, "the estimate still consumes budget");

  // The export labels it "settled at estimate", not "actual".
  const item = await makeReviewItem(a, { videoUrl: "https://example.test/clip-5s.mp4", imageUrl: null, exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false } });
  await a.generationApplication.create({ data: { reservationId: r.reservationId, pipelineItemId: item.id, kind: "video", mediaUrl: item.videoUrl, revision: 1 } });
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma: a, mediaStore: createFixtureMediaStore(FIXTURES) });
  try {
    const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(async (x) => ({ status: x.status, body: await x.json() }));
    const it = (await call(`/api/pipeline/${item.id}`)).body;
    await call(`/api/pipeline/${item.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash });
    const exp = await call(`/api/pipeline/${item.id}/exports`, "POST");
    assert.equal(exp.status, 201, JSON.stringify(exp.body));
    const m = exp.body.export.manifest;
    assert.equal(m.media[0].cost.status, "settled_at_estimate");
    assert.equal(m.media[0].cost.actualMicros, null);
    assert.deepEqual([m.cost.actualKnownMicros, m.cost.unknownActual], [0, 1]);
  } finally { await app.close(); }
});

// ─── IF-R4: recovery holds a fresh, fenced lease ───────────────────────

async function abandonedJob(prisma) {
  const ledger = createPrismaLedger(prisma);
  const [r] = await ledger.reserveGroup([entry(500_000, `job-${Date.now()}`)], CAPS);
  return prisma.generationJob.create({ data: {
    kind: "pipeline.generate-content", targetType: "pipeline_item", targetId: "synthetic", workflowKey: `wf-${Date.now()}`,
    state: "running", leaseOwner: "dead-worker", leaseExpiresAt: new Date(Date.now() - 60_000),
    steps: { create: [{ index: 0, kind: "image", provider: "mock", model: "m", idempotencyKey: `step-${Date.now()}`, reservationId: r.reservationId, state: "submitting" }] },
  }, include: { steps: true } });
}
/** A ledger whose reads pause until released, to interleave two recoverers. */
function pausingLedger(prisma) {
  const base = createPrismaLedger(prisma);
  let release; const paused = new Promise((r) => { release = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  return { ledger: { ...base, get: async (id) => { reached(); await paused; return base.get(id); } }, release, reached: reachedP };
}

test("IF-R4: a second recoverer arriving after the first took over does not process the same job", opts, async () => {
  const job = await abandonedJob(a);
  const first = pausingLedger(a);
  const running = recoverAbandoned(a, first.ledger, { log: { info() {} } });
  await first.reached; // the first recoverer owns the job and is mid-way
  const second = await recoverAbandoned(b, createPrismaLedger(b), { log: { info() {} } });
  assert.deepEqual(second, [], "the job is leased to the first recoverer, not still 'expired'");
  first.release();
  const done = await running;
  assert.equal(done.length, 1);
  const step = await a.generationStep.findFirst({ where: { jobId: job.id } });
  assert.equal(step.state, "outcome_unknown");
  assert.equal(step.revision, 1, "processed exactly once");
});

test("IF-R4: a recoverer that lost its lease writes nothing", opts, async () => {
  const job = await abandonedJob(a);
  const first = pausingLedger(a);
  const running = recoverAbandoned(a, first.ledger, { log: { info() {} } });
  await first.reached;
  // Someone else (e.g. a manual reconciliation path or another recoverer
  // after expiry) now holds the job.
  await b.generationJob.update({ where: { id: job.id }, data: { leaseOwner: "someone-else", leaseExpiresAt: new Date(Date.now() + 600_000) } });
  first.release();
  await running;
  const step = await a.generationStep.findFirst({ where: { jobId: job.id } });
  assert.equal(step.state, "submitting", "fenced out: the step was not changed");
  assert.equal(step.revision, 0);
  const j = await a.generationJob.findUnique({ where: { id: job.id } });
  assert.equal(j.leaseOwner, "someone-else", "the job was not taken back or closed");
  const reservation = await a.generationReservation.findUnique({ where: { id: job.steps[0].reservationId } });
  assert.equal(reservation.state, "reserved", "money untouched by the fenced-out recoverer");
});

// ─── IF-R5: rights are rechecked at each destination ──────────────────

const LIVE_ENV = {
  OWNER_API_TOKEN: TOKEN, LIVE_PUBLISHING: "enabled", APPROVED_PUBLISH_DESTINATIONS: "Instagram,TikTok",
  PUBLISH_ACCOUNTS: JSON.stringify({
    Instagram: { accountRef: "ig-synthetic", scopes: ["content_publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-1" },
    TikTok: { accountRef: "tt-synthetic", scopes: ["video.publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-2" },
  }),
};
function mockPlatform(platform, onPublish = () => {}) {
  const calls = [];
  return { calls, adapter: { platform, implemented: true, simulated: false, capabilities: { idempotencyKey: true, statusLookup: false },
    async publish(payload, ctx) { calls.push(payload); await onPublish(calls.length); await ctx.onAccepted(`${platform}-req`); return { status: "published", remotePostId: `${platform}-1`, permalink: `https://example.test/${platform}/1` }; } } };
}
async function licensedScheduledItem(call, expiresAt) {
  const raw = await makeReviewItem(a, { videoUrl: "https://example.test/clip-5s.mp4", exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false }, crossPostDestinations: ["TikTok"] });
  const ledger = createPrismaLedger(a);
  const [r] = await ledger.reserveGroup([entry(500_000, `lic-${Date.now()}`)], CAPS);
  await ledger.settle(r.reservationId, 500_000, null);
  const image = await a.characterImage.create({ data: { characterId: raw.characterId, imageUrl: "https://example.test/ref.png", status: "reference", source: "manual", fingerprint: "e".repeat(64) } });
  await a.generationApplication.create({ data: { reservationId: r.reservationId, pipelineItemId: raw.id, kind: "video", mediaUrl: raw.videoUrl, revision: 1, referencesSent: [image.fingerprint], conditioning: "references_sent" } });
  await a.rightsRecord.create({ data: { imageId: image.id, basis: "licensed", holder: "Synthetic Licensor", permittedUses: ["provider_input", "publication"], recordedBy: "owner", approvedBy: "owner", approvedAt: new Date(), expiresAt } });
  const it = (await call(`/api/pipeline/${raw.id}`)).body;
  assert.equal((await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash })).status, 200);
  const exp = await call(`/api/pipeline/${raw.id}/exports`, "POST");
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  assert.equal(exp.body.export.manifest.rights.length, 1, "the licensed reference is in the export");
  const s = await call(`/api/pipeline/${raw.id}/schedule`, "POST");
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body.content.id;
}
async function withPublishing(publishers, clock, fn) {
  const app = await startApp({ env: LIVE_ENV, prisma: a, mediaStore: createFixtureMediaStore(FIXTURES), publishers, publishClock: clock });
  const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  try { return await fn(call); } finally { await app.close(); }
}

test("IF-R5: a licence that expired after export blocks publishing with zero publisher calls", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  const licensedUntil = new Date(Date.now() + 30 * 86400_000);
  let now = new Date(Date.now() + 60 * 86400_000); // due, and past the licence
  await withPublishing({ Instagram: ig.adapter, TikTok: tt.adapter }, () => now, async (call) => {
    const contentId = await licensedScheduledItem(call, licensedUntil);
    const r = await call(`/api/publishing/content/${contentId}/publish`, "POST");
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "RIGHTS_INCOMPLETE");
    assert.equal(ig.calls.length + tt.calls.length, 0, "no publisher was called");
  });
});

test("IF-R5: a licence that expires between two destinations stops the second", opts, async () => {
  const licensedUntil = new Date(Date.now() + 61 * 86400_000);
  let now = new Date(Date.now() + 60 * 86400_000); // due, still licensed
  const ig = mockPlatform("Instagram", () => { now = new Date(Date.now() + 62 * 86400_000); }); // time passes during the first post
  const tt = mockPlatform("TikTok");
  await withPublishing({ Instagram: ig.adapter, TikTok: tt.adapter }, () => now, async (call) => {
    const contentId = await licensedScheduledItem(call, licensedUntil);
    await call(`/api/publishing/content/${contentId}/publish`, "POST");
    assert.equal(ig.calls.length, 1, "the first destination went out while licensed");
    assert.equal(tt.calls.length, 0, "the second was refused after expiry");
    const d = Object.fromEntries((await a.publishDelivery.findMany()).map((x) => [x.platform, x]));
    assert.equal(d.Instagram.state, "published");
    assert.equal(d.TikTok.state, "failed");
    assert.equal(d.TikTok.errorCode, "RIGHTS_INCOMPLETE");
  });
});
