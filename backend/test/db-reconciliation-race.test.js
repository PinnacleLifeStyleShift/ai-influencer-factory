import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter } from "./db-helpers.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";

/**
 * Reconciliation under real concurrency (owner's project prompt; AC-IF12-01,
 * AC-IF14-01). Two app instances on two PostgreSQL connections make opposite
 * decisions about the same uncertain delivery or generation step: exactly one
 * commits, the other gets RECONCILIATION_CONFLICT, the audit has one decision,
 * and a late platform/provider answer never overwrites a decision.
 * Mock adapters only; no network.
 */
const opts = { skip: skipReason, timeout: 120_000 };
let prisma; let prisma2; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) { prisma = newClient(); prisma2 = newClient(); } });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); await prisma2?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

const LIVE_ENV = {
  OWNER_API_TOKEN: TOKEN, LIVE_PUBLISHING: "enabled", APPROVED_PUBLISH_DESTINATIONS: "Instagram",
  PUBLISH_ACCOUNTS: JSON.stringify({ Instagram: { accountRef: "ig-synthetic", scopes: ["content_publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-1" } }),
};
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const post = (app, p, body) => app.call(p, { method: "POST", token: TOKEN, body }).then(json);

/** A slow platform: lookups wait for release(answer). */
function slowPlatform() {
  const pending = [];
  const adapter = {
    platform: "Instagram", implemented: true, simulated: false, capabilities: { idempotencyKey: true, statusLookup: true },
    async publish() { throw new Error("not used"); },
    lookup: () => new Promise((resolve) => pending.push(resolve)),
  };
  return { adapter, pending, release: (answer) => pending.shift()(answer) };
}

async function uncertainDelivery() {
  const character = await makeCharacter(prisma);
  const content = await prisma.content.create({ data: { title: "Synthetic", characterId: character.id, status: "scheduled", scheduleKey: `k-${Math.random()}` } });
  const job = await prisma.publishJob.create({ data: {
    contentId: content.id, pipelineItemId: "synthetic", snapshotHash: "h", manifestHash: "m", state: "awaiting_reconciliation",
    deliveries: { create: [{ platform: "Instagram", state: "outcome_unknown", clientRef: "ref-1", remoteRequestId: "req-1", revision: 3 }] },
  }, include: { deliveries: true } });
  return job.deliveries[0];
}

async function twoApps(fn, extra = {}) {
  const a = await startApp({ env: LIVE_ENV, prisma, ...extra });
  const b = await startApp({ env: LIVE_ENV, prisma: prisma2, ...extra });
  try { return await fn(a, b); } finally { await a.close(); await b.close(); }
}

test("publishing: opposite owner decisions race; exactly one commits and the audit has one decision", opts, () => twoApps(async (a, b) => {
  for (let round = 0; round < 8; round++) {
    const d = await uncertainDelivery();
    const [x, y] = await Promise.all([
      post(a, `/api/publishing/deliveries/${d.id}/resolve`, { resolution: "published", remotePostId: "ig-777", permalink: "https://example.test/ig/777", evidence: "Post visible in the account", expectedRevision: d.revision }),
      post(b, `/api/publishing/deliveries/${d.id}/resolve`, { resolution: "not_published", evidence: "No post in the account", expectedRevision: d.revision }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${round}: ${x.status}/${y.status}`);
    const loser = x.status === 409 ? x : y;
    assert.equal(loser.body.code, "RECONCILIATION_CONFLICT");
    const after = await prisma.publishDelivery.findUnique({ where: { id: d.id } });
    assert.equal(await prisma.publishReconciliation.count({ where: { deliveryId: d.id, method: "operator" } }), 1, "one decision recorded");
    if (after.state === "resolved_not_published") assert.equal(after.remotePostId, null, "no remote post id kept on not-published");
    else assert.deepEqual([after.state, after.remotePostId], ["resolved_published", "ig-777"]);
    assert.equal(after.revision, d.revision + 1);
  }
}));

test("publishing: a late 'published' lookup after an owner's 'not published' blocks re-posting as conflicting evidence", opts, async () => {
  const p = slowPlatform();
  await twoApps(async (a, b) => {
    const d = await uncertainDelivery();
    const check = post(a, `/api/publishing/deliveries/${d.id}/check`, {});
    while (!p.pending.length) await new Promise((r) => setTimeout(r, 10));
    const decided = await post(b, `/api/publishing/deliveries/${d.id}/resolve`, { resolution: "not_published", evidence: "Account showed nothing at 10:00", expectedRevision: d.revision });
    assert.equal(decided.status, 200);
    p.release({ status: "published", remotePostId: "ig-late", permalink: "https://example.test/ig/late" });
    const late = await check;
    assert.equal(late.status, 409);
    assert.equal(late.body.code, "RECONCILIATION_CONFLICT");
    const now = await prisma.publishDelivery.findUnique({ where: { id: d.id }, include: { reconciliations: { orderBy: { resolvedAt: "asc" } } } });
    assert.equal(now.state, "conflicting_evidence", "a post may exist: re-posting is blocked");
    assert.deepEqual(now.reconciliations.map((r) => r.resolution), ["not_published", "conflicting_evidence"]);
    assert.equal(now.reconciliations[1].remotePostId, "ig-late", "the platform's evidence is kept");
    // The owner can review and decide again, at the new revision.
    const again = await post(a, `/api/publishing/deliveries/${d.id}/resolve`, { resolution: "published", remotePostId: "ig-late", permalink: "https://example.test/ig/late", evidence: "Found the post after all", expectedRevision: now.revision });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  }, { publishers: { Instagram: p.adapter } });
});

test("publishing: a late 'failed' lookup never reopens a confirmed publication", opts, async () => {
  const p = slowPlatform();
  await twoApps(async (a, b) => {
    const d = await uncertainDelivery();
    const check = post(a, `/api/publishing/deliveries/${d.id}/check`, {});
    while (!p.pending.length) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await post(b, `/api/publishing/deliveries/${d.id}/resolve`, { resolution: "published", remotePostId: "ig-1", permalink: "https://example.test/ig/1", evidence: "Post is live in the account", expectedRevision: d.revision })).status, 200);
    p.release({ status: "failed" });
    assert.equal((await check).status, 409);
    const now = await prisma.publishDelivery.findUnique({ where: { id: d.id } });
    assert.deepEqual([now.state, now.remotePostId], ["resolved_published", "ig-1"], "confirmed evidence stands");
    assert.equal(await prisma.publishReconciliation.count({ where: { resolution: "conflicting_evidence" } }), 1);
  }, { publishers: { Instagram: p.adapter } });
});

// ─── Generation steps ──────────────────────────────────────────

async function uncertainStep() {
  const r = await prisma.generationReservation.create({ data: {
    provider: "mock", model: "image", amountMicros: 1_000_000n, state: "outcome_unknown", day: "2026-11-10", month: "2026-11",
    idempotencyKey: `k-${Math.random()}`, currency: "USD", priceVersion: "fixture", capTimezone: "UTC",
  } });
  const job = await prisma.generationJob.create({ data: {
    kind: "content", targetType: "pipeline_item", targetId: "synthetic", workflowKey: `w-${Math.random()}`, state: "awaiting_reconciliation",
    steps: { create: [{ index: 0, kind: "image", provider: "mock", model: "image", idempotencyKey: r.idempotencyKey, reservationId: r.id, state: "outcome_unknown", providerRequestId: "req-9", revision: 2 }] },
  }, include: { steps: true } });
  return { step: job.steps[0], reservation: r };
}

test("generation: parallel resolutions produce one decision, one reservation outcome, one audit record", opts, () => twoApps(async (a, b) => {
  for (let round = 0; round < 8; round++) {
    const { step, reservation } = await uncertainStep();
    const [x, y] = await Promise.all([
      post(a, `/api/generation-jobs/steps/${step.id}/resolve`, { resolution: "not_charged", evidence: "Dashboard shows no charge", expectedRevision: step.revision }),
      post(b, `/api/generation-jobs/steps/${step.id}/resolve`, { resolution: "charged_no_result", evidence: "Dashboard shows a charge, no output", expectedRevision: step.revision }),
    ]);
    assert.deepEqual([x.status, y.status].sort(), [200, 409], `round ${round}: ${JSON.stringify([x.body?.code, y.body?.code])}`);
    const s = await prisma.generationStep.findUnique({ where: { id: step.id } });
    const res = await prisma.generationReservation.findUnique({ where: { id: reservation.id } });
    assert.equal(await prisma.reconciliationRecord.count({ where: { stepId: step.id } }), 1);
    assert.equal(res.state, s.state === "resolved_not_charged" ? "released" : "settled", "money matches the winning decision");
  }
}));

test("generation: a decision whose reservation cannot change leaves the step untouched (one transaction)", opts, () => twoApps(async (a) => {
  const { step, reservation } = await uncertainStep();
  await prisma.generationReservation.update({ where: { id: reservation.id }, data: { state: "released" } });
  const r = await post(a, `/api/generation-jobs/steps/${step.id}/resolve`, { resolution: "charged_no_result", evidence: "Dashboard shows a charge", expectedRevision: step.revision });
  assert.equal(r.body.code, "NOT_RESOLVABLE");
  const s = await prisma.generationStep.findUnique({ where: { id: step.id } });
  assert.deepEqual([s.state, s.revision], ["outcome_unknown", step.revision], "not left half-decided");
  assert.equal(await prisma.reconciliationRecord.count(), 0);
}));

test("generation: a late provider 'succeeded' after an owner's 'not charged' is recorded as conflicting evidence, not applied", opts, async () => {
  const pending = [];
  const gate = (client) => createGenerationGate({
    env: {}, ledger: createPrismaLedger(client), log: { error() {}, info() {} },
    adapters: { image: { "mock:image": { capabilities: {}, generate: async () => { throw new Error("not used"); }, checkStatus: () => new Promise((r) => pending.push(r)) } }, video: {} },
  });
  const a = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma, gate: gate(prisma) });
  const b = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma: prisma2, gate: gate(prisma2) });
  try {
    const { step, reservation } = await uncertainStep();
    const check = post(a, `/api/generation-jobs/steps/${step.id}/check`, {});
    while (!pending.length) await new Promise((r) => setTimeout(r, 10));
    assert.equal((await post(b, `/api/generation-jobs/steps/${step.id}/resolve`, { resolution: "not_charged", evidence: "Dashboard shows no charge", expectedRevision: step.revision })).status, 200);
    pending.shift()({ status: "succeeded", url: "https://example.test/late.png" });
    const late = await check;
    assert.equal(late.body.code, "RECONCILIATION_CONFLICT");
    const s = await prisma.generationStep.findUnique({ where: { id: step.id } });
    assert.equal(s.state, "resolved_not_charged", "the owner's decision stands");
    assert.equal((await prisma.generationReservation.findUnique({ where: { id: reservation.id } })).state, "released");
    assert.deepEqual((await prisma.reconciliationRecord.findMany({ orderBy: { resolvedAt: "asc" } })).map((r) => r.resolution), ["not_charged", "conflicting_evidence"]);
  } finally { await a.close(); await b.close(); }
});
