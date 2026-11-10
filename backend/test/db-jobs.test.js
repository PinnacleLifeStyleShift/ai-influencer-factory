import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";
import { createGenerationGate, SimulatedProcessDeath } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";
import { createSessionStore } from "../src/auth/sessions.js";

/**
 * Package D: durable jobs, crash recovery at every point of a paid call,
 * reconciliation, concurrency across two connections, pricing config.
 * Mocked providers, disposable local Postgres, no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
let prisma; let prisma2; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) { prisma = newClient(); prisma2 = newClient(); } });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); await prisma2?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

// Synthetic configuration. Test fixtures only.
const GATE_ENV = {
  IMAGE_PROVIDER: "mock:image", APPROVED_PROVIDER_MODELS: "mock:image", LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "mock:image": "1.00" }),
  SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "100", SPEND_CAP_MONTHLY_USD: "100",
  PRICE_CURRENCY: "USD", PRICE_VERSION: "test-fixture-v1", SPEND_CAP_TIMEZONE: "UTC",
};

/**
 * A provider that remembers every request it accepted (as a real one would),
 * so reconciliation can ask about it later. `lookups: false` = an adapter
 * that cannot look requests up.
 */
function mockProvider({ lookups = true } = {}) {
  const state = { calls: 0, vendorKeys: [], requests: new Map() };
  const adapter = {
    capabilities: { vendorIdempotency: true },
    generate: async (_input, ctx) => {
      state.calls++;
      state.vendorKeys.push(ctx.vendorIdempotencyKey);
      const requestId = `req-${state.calls}`;
      const url = `https://example.test/gen-${state.calls}.png`;
      state.requests.set(requestId, url);
      await ctx.onAccepted(requestId);
      return { imageUrl: url };
    },
    ...(lookups ? { checkStatus: async (id) => (state.requests.has(id) ? { status: "succeeded", url: state.requests.get(id) } : { status: "unknown" }) } : {}),
  };
  return { state, adapter };
}
function gateWith(client, provider, { crashAt, env = GATE_ENV } = {}) {
  return createGenerationGate({
    env, ledger: createPrismaLedger(client), adapters: { image: { "mock:image": provider.adapter }, video: {} }, log: { error() {}, info() {} },
    faults: crashAt ? async (point) => { if (point === crashAt) throw new SimulatedProcessDeath(point); } : null,
  });
}
async function withApp(client, gate, fn) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma: client, gate });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const call = (app, path, { method = "GET", body, token = TOKEN, key } = {}) =>
  app.call(path, { method, token, body: method === "GET" ? undefined : body ?? {}, headers: key ? { "Idempotency-Key": key } : {} }).then(json);
const generate = (app, id, key) => call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: id }, key });

/** What a restart sees: the dead worker's lease and item claim have expired. */
async function expireLeases() {
  const past = new Date(Date.now() - 3600_000);
  await prisma.generationJob.updateMany({ data: { leaseExpiresAt: past } });
  await prisma.pipelineItem.updateMany({ where: { generationClaim: { not: null } }, data: { generationClaimedAt: past } });
}
const stepStates = async () => (await prisma.generationStep.findMany({ orderBy: { createdAt: "asc" } })).map((s) => s.state);
const reservationStates = async () => (await prisma.generationReservation.findMany({ orderBy: { createdAt: "asc" } })).map((r) => r.state);

// ─── Process death at every point ───────────────────────────

const NOT_SENT = ["afterReserve", "beforeSubmit"];
const MAYBE_SENT = ["afterAccept", "afterResult", "beforeSettle"];

for (const point of NOT_SENT) {
  test(`death ${point}: recovery proves nothing was sent, releases the money, retry buys once`, opts, async () => {
    const p = mockProvider();
    const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    await withApp(prisma, gateWith(prisma, p, { crashAt: point }), async (app) => {
      assert.equal((await generate(app, item.id, "ui-crash-key-0001")).status, 500, "the process 'died'");
    });
    assert.equal(p.state.calls, 0);
    assert.deepEqual(await reservationStates(), ["reserved"], "a dead process leaves its reservation behind");

    // Restart: a new instance with its own connection.
    await expireLeases();
    await withApp(prisma2, gateWith(prisma2, p), async (app) => {
      const rec = await call(app, "/api/generation-jobs/recover", { method: "POST" });
      assert.equal(rec.body.recovered[0].released, 1);
      assert.deepEqual(await stepStates(), ["not_submitted"]);
      assert.deepEqual(await reservationStates(), ["released"]);
      const retry = await generate(app, item.id, "ui-crash-key-0001");
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
    });
    assert.equal(p.state.calls, 1, "bought exactly once");
  });
}

for (const point of MAYBE_SENT) {
  test(`death ${point}: outcome unknown, nothing re-bought, provider check recovers the result`, opts, async () => {
    const p = mockProvider();
    const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    await withApp(prisma, gateWith(prisma, p, { crashAt: point }), async (app) => {
      assert.equal((await generate(app, item.id, "ui-crash-key-0002")).status, 500);
    });
    assert.equal(p.state.calls, 1, "the provider was reached once");

    await expireLeases();
    await withApp(prisma2, gateWith(prisma2, p), async (app) => {
      const rec = await call(app, "/api/generation-jobs/recover", { method: "POST" });
      assert.equal(rec.body.recovered[0].unknown, 1);
      assert.deepEqual(await stepStates(), ["outcome_unknown"]);
      assert.deepEqual(await reservationStates(), ["outcome_unknown"], "spend stays counted");

      const blocked = await generate(app, item.id, "ui-crash-key-0002");
      assert.equal(blocked.body.code, "DUPLICATE_IN_PROGRESS", "no re-purchase while uncertain");

      const jobs = (await call(app, "/api/generation-jobs?state=awaiting_reconciliation")).body;
      assert.equal(jobs.length, 1);
      const step = jobs[0].steps[0];
      assert.equal(step.providerRequestId, "req-1");
      const checked = await call(app, `/api/generation-jobs/steps/${step.id}/check`, { method: "POST" });
      assert.equal(checked.body.state, "succeeded");
      assert.equal(checked.body.reconciliations[0].method, "provider_check");

      const retry = await generate(app, item.id, "ui-crash-key-0002");
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.results[0].recovered, true);
      assert.equal(retry.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
    });
    assert.equal(p.state.calls, 1, "still bought exactly once");
  });
}

test("recovery settles money in Postgres even when the app restarts with the default (non-durable) gate", opts, async () => {
  const p = mockProvider();
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p, { crashAt: "afterAccept" }), async (app) => {
    assert.equal((await generate(app, item.id, "ui-crash-key-0009")).status, 500);
  });
  await expireLeases();
  // No injected gate and no SPEND_LEDGER: the app builds its default gate.
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma: prisma2 });
  try {
    const rec = await call(app, "/api/generation-jobs/recover", { method: "POST" });
    assert.equal(rec.body.recovered[0].unknown, 1);
    assert.deepEqual(await reservationStates(), ["outcome_unknown"], "the durable reservation is marked, not left 'reserved'");
  } finally { await app.close(); }
  assert.equal(p.state.calls, 1);
});

test("death beforeApply: paid result is stored; retry applies it without buying", opts, async () => {
  const p = mockProvider();
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p, { crashAt: "beforeApply" }), async (app) => {
    assert.equal((await generate(app, item.id, "ui-crash-key-0003")).status, 500);
  });
  await expireLeases();
  await withApp(prisma2, gateWith(prisma2, p), async (app) => {
    await call(app, "/api/generation-jobs/recover", { method: "POST" });
    assert.deepEqual(await stepStates(), ["succeeded"]);
    assert.equal((await prisma.generationJob.findFirst()).state, "awaiting_application");
    const retry = await generate(app, item.id, "ui-crash-key-0003");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
  });
  assert.equal(p.state.calls, 1);
});

// ─── Operator resolution ─────────────────────────────────────

test("manual resolution: owner-only, evidence required, recorded; 'not charged' allows a new purchase", opts, async () => {
  const p = mockProvider({ lookups: false });
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p, { crashAt: "afterAccept" }), async (app) => { await generate(app, item.id, "ui-manual-0001"); });
  await expireLeases();
  await withApp(prisma2, gateWith(prisma2, p), async (app) => {
    await call(app, "/api/generation-jobs/recover", { method: "POST" });
    const step = (await call(app, "/api/generation-jobs")).body[0].steps[0];
    assert.equal(step.reservation.state, "outcome_unknown");
    assert.equal(step.reservation.priceVersion, "test-fixture-v1");

    assert.equal((await call(app, `/api/generation-jobs/steps/${step.id}/check`, { method: "POST" })).body.code, "CHECK_UNSUPPORTED");
    const noEvidence = await call(app, `/api/generation-jobs/steps/${step.id}/resolve`, { method: "POST", body: { resolution: "not_charged" } });
    assert.equal(noEvidence.status, 400);
    const editor = (await createSessionStore(prisma2).create({ id: "synthetic-editor", role: "editor" }, { provider: "test", ttlMs: 3600_000 })).token;
    assert.equal((await call(app, "/api/generation-jobs", { token: editor })).status, 200, "the screen is readable");
    assert.equal((await call(app, `/api/generation-jobs/steps/${step.id}/resolve`, { method: "POST", token: editor,
      body: { resolution: "not_charged", evidence: "Provider dashboard shows no request" } })).status, 403, "resolution is owner-only");

    const ok = await call(app, `/api/generation-jobs/steps/${step.id}/resolve`, { method: "POST",
      body: { resolution: "not_charged", evidence: "Synthetic: provider dashboard shows no charge for req-1", expectedRevision: step.revision } });
    assert.equal(ok.body.state, "resolved_not_charged");
    assert.equal(ok.body.reconciliations[0].resolvedBy, "owner");
    assert.deepEqual(await reservationStates(), ["released"]);
    assert.equal((await call(app, `/api/generation-jobs/steps/${step.id}/resolve`, { method: "POST",
      body: { resolution: "charged_no_result", evidence: "changing my mind afterwards", expectedRevision: step.revision } })).body.code, "RECONCILIATION_CONFLICT", "decided once");

    assert.equal((await generate(app, item.id, "ui-manual-0001")).status, 200);
  });
  assert.equal(p.state.calls, 2, "proven not charged, so buying again is correct");
});

test("manual 'charged with result' applies the result without buying again", opts, async () => {
  const p = mockProvider({ lookups: false });
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p, { crashAt: "afterResult" }), async (app) => { await generate(app, item.id, "ui-manual-0002"); });
  await expireLeases();
  await withApp(prisma2, gateWith(prisma2, p), async (app) => {
    await call(app, "/api/generation-jobs/recover", { method: "POST" });
    const step = (await call(app, "/api/generation-jobs")).body[0].steps[0];
    const bad = await call(app, `/api/generation-jobs/steps/${step.id}/resolve`, { method: "POST",
      body: { resolution: "charged_with_result", evidence: "Found it in the provider dashboard", resultUrl: "http://10.0.0.1/x.png", actualCost: "-1", expectedRevision: step.revision } });
    assert.deepEqual(Object.keys(bad.body.details.fields).sort(), ["actualCost", "resultUrl"]);
    const ok = await call(app, `/api/generation-jobs/steps/${step.id}/resolve`, { method: "POST",
      body: { resolution: "charged_with_result", evidence: "Synthetic: dashboard entry req-1, billed 0.80", resultUrl: "https://example.test/gen-1.png", actualCost: "0.80", expectedRevision: step.revision } });
    assert.equal(ok.body.state, "resolved_charged_with_result");
    const r = (await prisma.generationReservation.findFirst());
    assert.equal(r.state, "settled");
    assert.equal(Number(r.actualMicros), 800_000, "actual cost recorded");
    const retry = await generate(app, item.id, "ui-manual-0002");
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
  });
  assert.equal(p.state.calls, 1);
});

// ─── Concurrency across two connections ──────────────────────

test("two instances, same key and different keys: one purchase per item", opts, async () => {
  const p = mockProvider();
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p), async (a) => withApp(prisma2, gateWith(prisma2, p), async (b) => {
    const results = await Promise.all([
      generate(a, item.id, "ui-same-key-0001"), generate(b, item.id, "ui-same-key-0001"),
      generate(a, item.id, "ui-other-key-0002"), generate(b, item.id, "ui-other-key-0003"),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.body.code)));
  }));
  assert.equal(p.state.calls, 1);
});

test("caps hold across two instances", opts, async () => {
  const p = mockProvider();
  const env = { ...GATE_ENV, SPEND_CAP_DAILY_USD: "2" };
  const items = await Promise.all(Array.from({ length: 6 }, () => makeReviewItem(prisma, { stage: "draft", imageUrl: null })));
  await withApp(prisma, gateWith(prisma, p, { env }), async (a) => withApp(prisma2, gateWith(prisma2, p, { env }), async (b) => {
    const results = await Promise.all(items.map((it, i) => generate(i % 2 ? a : b, it.id)));
    assert.equal(results.filter((r) => r.status === 200).length, 2);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === "BUDGET_EXCEEDED"));
  }));
  assert.equal(p.state.calls, 2);
});

// ─── Pricing configuration and settlement ────────────────────

test("pricing needs currency, price version and a valid cap timezone", opts, async () => {
  const p = mockProvider();
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  const env = { ...GATE_ENV, PRICE_CURRENCY: "dollars", PRICE_VERSION: "", SPEND_CAP_TIMEZONE: "Mars/Olympus" };
  await withApp(prisma, gateWith(prisma, p, { env }), async (app) => {
    const r = await generate(app, item.id);
    assert.equal(r.body.code, "PRICE_CONFIG_INCOMPLETE");
    assert.equal(r.body.details.missing.length, 3);
  });
  assert.equal(p.state.calls, 0);
});

test("vendor idempotency keys are stable for the same step and differ between steps", opts, async () => {
  const p = mockProvider();
  const one = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p), async (app) => { await generate(app, one.id, "ui-vendor-key-01"); });
  const two = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  await withApp(prisma, gateWith(prisma, p), async (app) => { await generate(app, two.id, "ui-vendor-key-02"); });
  assert.equal(p.state.vendorKeys.length, 2);
  assert.match(p.state.vendorKeys[0], /^[0-9a-f]{40}$/);
  assert.notEqual(p.state.vendorKeys[0], p.state.vendorKeys[1]);
  const step = await prisma.generationStep.findFirst({ orderBy: { createdAt: "asc" } });
  assert.equal(step.state, "applied");
  assert.equal(step.providerRequestId, "req-1");
});

test("a settlement is final and never negative", opts, async () => {
  const ledger = createPrismaLedger(prisma);
  const caps = { perJobMicros: 5_000_000, dailyMicros: 50_000_000, monthlyMicros: 50_000_000, timezone: "UTC" };
  const [{ reservationId }] = await ledger.reserveGroup([{ amountMicros: 1_000_000, provider: "mock", model: "image" }], caps);
  await assert.rejects(ledger.settle(reservationId, -5), { code: "VALIDATION_FAILED" });
  await ledger.settle(reservationId, 900_000);
  await ledger.settle(reservationId, 0);
  assert.equal((await ledger.get(reservationId)).actualMicros, 900_000, "a second settlement cannot erase spend");
  await assert.rejects(ledger.resolve(reservationId, { charged: false }), { code: "NOT_RESOLVABLE" });
});
