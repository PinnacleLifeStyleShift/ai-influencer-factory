import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";

/**
 * Generation lifecycle races (mocked providers, disposable local Postgres).
 * WHY these exist: a generation spends money and takes minutes; these tests
 * pin down what may and may not happen while it runs and when it is retried.
 */
// A failed assertion must not leave a held provider call hanging the run.
const opts = { skip: skipReason, timeout: 30_000 };
const ENV = { OWNER_API_TOKEN: TOKEN };
// Synthetic gate configuration for mocked adapters. Test fixtures only.
const GATE_ENV = {
  IMAGE_PROVIDER: "higgsfield:soul",
  VIDEO_PROVIDER: "fal:kling-v2.1-i2v",
  APPROVED_PROVIDER_MODELS: "higgsfield:soul,fal:kling-v2.1-i2v",
  LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "higgsfield:soul": "1.00", "fal:kling-v2.1-i2v": "1.00" }),
  SPEND_CAP_PER_JOB_USD: "5",
  SPEND_CAP_DAILY_USD: "50",
  SPEND_CAP_MONTHLY_USD: "100",
};

let prisma;
let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => {
  net.restore();
  assert.equal(net.calls.length, 0, "no external network calls");
  await prisma?.$disconnect();
});
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

/** A gate whose providers can be held open (to create a race window). */
function mockGate({ ledger, holdImage = false } = {}) {
  const calls = { image: 0, video: 0 };
  let release = () => {};
  // Self-releases after 5 s so a broken race can only fail, never hang the run.
  const held = new Promise((r) => { release = r; setTimeout(r, 5000).unref(); });
  let started;
  const startedP = new Promise((r) => { started = r; });
  const adapters = {
    image: {
      "higgsfield:soul": {
        generate: async () => {
          calls.image++;
          const n = calls.image;
          started();
          if (holdImage) await held;
          return { imageUrl: `https://example.test/gen-${n}.png` };
        },
      },
    },
    video: {
      "fal:kling-v2.1-i2v": {
        generate: async () => { calls.video++; return { videoUrl: `https://example.test/gen-${calls.video}.mp4` }; },
      },
    },
  };
  const gate = createGenerationGate({
    env: GATE_ENV, ledger: ledger || createPrismaLedger(prisma), adapters, log: { error() {} },
  });
  return { gate, calls, release, started: startedP };
}

/** Prisma proxy whose next $transaction calls fail (simulated database error). */
function failingTransactions(client) {
  const state = { failNext: 0 };
  const proxy = new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction" && state.failNext > 0) {
        return async () => { state.failNext--; throw new Error("simulated database failure"); };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { proxy, state };
}

async function withApp(fn, { gate, db = prisma } = {}) {
  const app = await startApp({ env: ENV, prisma: db, gate });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json() });
const call = (app, path, { method = "POST", body = {}, key } = {}) =>
  app.call(path, { method, token: TOKEN, body: method === "GET" ? undefined : body, headers: key ? { "Idempotency-Key": key } : {} }).then(json);
const generate = (app, id, { type = "image", key } = {}) =>
  call(app, "/api/pipeline/generate-content", { body: { pipelineItemId: id, type }, key });
const getItem = (app, id) => call(app, `/api/pipeline/${id}`, { method: "GET" }).then((r) => r.body);
async function reviewAndApprove(app, id) {
  await call(app, "/api/pipeline/generate-caption", { body: { pipelineItemId: id } });
  const item = await getItem(app, id);
  const r = await call(app, `/api/pipeline/${id}/approve`, { body: { revision: item.revision, snapshotHash: item.snapshotHash } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.pipelineItem;
}
const reservationStates = async () =>
  (await prisma.generationReservation.findMany({ orderBy: { createdAt: "asc" } })).map((r) => r.state);

// ─── Delayed generation versus scheduling ────────────────────

test("scheduling, approval and edits are refused while a generation is running", opts, async () => {
  const m = mockGate({ holdImage: true });
  try { await withApp(async (app) => {
    const raw = await makeReviewItem(prisma);
    const before = await getItem(app, raw.id);
    await call(app, `/api/pipeline/${raw.id}/approve`, { body: { revision: before.revision, snapshotHash: before.snapshotHash } });

    const running = generate(app, raw.id);
    await m.started;

    const sched = await call(app, `/api/pipeline/${raw.id}/schedule`);
    assert.equal(sched.body.code, "GENERATION_IN_PROGRESS");
    const edit = await call(app, `/api/pipeline/${raw.id}`, { method: "PATCH", body: { caption: "mid-flight edit" } });
    assert.equal(edit.body.code, "GENERATION_IN_PROGRESS");
    assert.equal((await getItem(app, raw.id)).generationInProgress, true);
    assert.equal(await prisma.content.count(), 0);

    m.release();
    const done = await running;
    assert.equal(done.status, 200);
    assert.equal(done.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
    assert.equal(done.body.pipelineItem.stage, "content_generated");
    assert.equal(done.body.pipelineItem.approvedHash, null, "new media cleared the approval");
    assert.equal(done.body.pipelineItem.generationInProgress, false);

    const after = await call(app, `/api/pipeline/${raw.id}/schedule`);
    assert.equal(after.body.code, "INVALID_TRANSITION", "old approval cannot schedule new media");
    assert.equal(await prisma.content.count(), 0);
  }, { gate: m.gate }); } finally { m.release(); }
});

test("an abandoned claim can be cleared by scheduling, and its late result is fenced out", opts, async () => {
  const m = mockGate({ holdImage: true });
  try { await withApp(async (app) => {
    const raw = await makeReviewItem(prisma);
    const item = await getItem(app, raw.id);
    await call(app, `/api/pipeline/${raw.id}/approve`, { body: { revision: item.revision, snapshotHash: item.snapshotHash } });

    const running = generate(app, raw.id);
    await m.started;
    // Simulate a claim that outlived its time limit (e.g. a crashed process).
    await prisma.pipelineItem.update({ where: { id: raw.id }, data: { generationClaimedAt: new Date(Date.now() - 3600_000) } });

    const sched = await call(app, `/api/pipeline/${raw.id}/schedule`);
    assert.equal(sched.status, 200, JSON.stringify(sched.body));

    m.release();
    const late = await running;
    assert.equal(late.body.code, "GENERATION_SUPERSEDED");
    assert.equal(late.body.details.result.imageUrl, "https://example.test/gen-1.png", "result reported, not lost");

    const stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
    assert.equal(stored.stage, "scheduled");
    assert.equal(stored.imageUrl, "https://example.test/still.png", "scheduled media untouched");
    const content = await prisma.content.findFirst();
    assert.equal(content.imageUrl, "https://example.test/still.png");
    assert.deepEqual(await reservationStates(), ["settled"], "the spend stays counted");
    assert.equal(await prisma.generationApplication.count(), 0);
  }, { gate: m.gate }); } finally { m.release(); }
});

// ─── Competing keys ──────────────────────────────────────────

test("competing requests with different keys: one claim, one purchase", opts, async () => {
  const m = mockGate({ holdImage: true });
  try { await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const first = generate(app, raw.id, { key: "ui-compete-key-A" });
    await m.started;
    const second = await generate(app, raw.id, { key: "ui-compete-key-B" });
    assert.equal(second.body.code, "GENERATION_IN_PROGRESS");
    m.release();
    assert.equal((await first).status, 200);
    assert.equal(m.calls.image, 1);
    assert.equal(await prisma.generationReservation.count(), 1, "the loser never reserved");
  }, { gate: m.gate }); } finally { m.release(); }
});

// ─── Old-key replay after newer approved media ───────────────

test("replaying an old key after newer approved media changes nothing", opts, async () => {
  const m = mockGate();
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    assert.equal((await generate(app, raw.id, { key: "ui-old-key-0001" })).status, 200); // gen-1
    assert.equal((await generate(app, raw.id, { key: "ui-new-key-0002" })).status, 200); // gen-2
    const approved = await reviewAndApprove(app, raw.id);
    assert.equal(approved.imageUrl, "https://example.test/gen-2.png");

    const replay = await generate(app, raw.id, { key: "ui-old-key-0001" });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.results[0].alreadyApplied, true);
    assert.equal(replay.body.results[0].mediaUrl, "https://example.test/gen-1.png", "recorded result returned");
    const item = replay.body.pipelineItem;
    assert.equal(item.imageUrl, "https://example.test/gen-2.png", "old media not re-applied");
    assert.equal(item.stage, "approved");
    assert.equal(item.approvalCurrent, true, "later approval kept");
    assert.equal(item.revision, approved.revision);
    assert.equal(m.calls.image, 2, "no new purchase");
  }, { gate: m.gate });
});

// ─── Settlement / application database failures ──────────────

test("application failure: result recovered on retry without a new purchase, then replays as applied", opts, async () => {
  const m = mockGate();
  const { proxy, state } = failingTransactions(prisma);
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    state.failNext = 1;
    const failed = await generate(app, raw.id, { key: "ui-apply-fail-0001" });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.code, "RESULT_NOT_APPLIED");
    let stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
    assert.equal(stored.imageUrl, null);
    assert.equal(stored.generationClaim, null, "claim released");
    assert.deepEqual(await reservationStates(), ["settled"]);

    const recovered = await generate(app, raw.id, { key: "ui-apply-fail-0001" });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.results[0].recovered, true);
    assert.equal(recovered.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
    assert.equal(m.calls.image, 1, "recovery did not re-buy");

    const again = await generate(app, raw.id, { key: "ui-apply-fail-0001" });
    assert.equal(again.body.results[0].alreadyApplied, true);
    stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
    assert.equal(stored.revision, recovered.body.pipelineItem.revision, "replay changed nothing");
    assert.equal(await prisma.generationApplication.count(), 1);
  }, { gate: m.gate, db: proxy });
});

test("an unapplied result is not recovered once a newer workflow has run", opts, async () => {
  const m = mockGate();
  const { proxy, state } = failingTransactions(prisma);
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    state.failNext = 1;
    assert.equal((await generate(app, raw.id, { key: "ui-stale-key-0001" })).body.code, "RESULT_NOT_APPLIED");
    assert.equal((await generate(app, raw.id, { key: "ui-fresh-key-0002" })).status, 200); // gen-2 applied

    for (let i = 0; i < 2; i++) {
      const stale = await generate(app, raw.id, { key: "ui-stale-key-0001" });
      assert.equal(stale.body.code, "GENERATION_SUPERSEDED", `attempt ${i + 1}`);
      assert.equal(stale.body.details.result.imageUrl, "https://example.test/gen-1.png");
    }
    const stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
    assert.equal(stored.imageUrl, "https://example.test/gen-2.png");
    assert.equal(m.calls.image, 2);
  }, { gate: m.gate, db: proxy });
});

test("application failure in a video workflow releases the unstarted video step", opts, async () => {
  const m = mockGate();
  const { proxy, state } = failingTransactions(prisma);
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    state.failNext = 1;
    const failed = await generate(app, raw.id, { type: "video" });
    assert.equal(failed.body.code, "RESULT_NOT_APPLIED");
    assert.deepEqual(await reservationStates(), ["settled", "released"], "image spend kept, video freed");
    assert.equal(m.calls.video, 0);

    const retry = await generate(app, raw.id, { type: "video" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
    assert.equal(retry.body.pipelineItem.videoUrl, "https://example.test/gen-1.mp4");
    assert.deepEqual(m.calls, { image: 1, video: 1 });
  }, { gate: m.gate, db: proxy });
});

test("settlement failure: spend kept, unstarted step released, result reported, retry buys nothing", opts, async () => {
  const real = createPrismaLedger(prisma);
  const ledger = { ...real, settle: async () => { throw new Error("simulated database failure"); } };
  const m = mockGate({ ledger });
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const failed = await generate(app, raw.id, { type: "video" });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, "SETTLEMENT_FAILED");
    assert.equal(failed.body.details.result.imageUrl, "https://example.test/gen-1.png");
    assert.deepEqual(await reservationStates(), ["reserved", "released"], "uncertain spend kept, video freed");
    const stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
    assert.equal(stored.imageUrl, null, "not applied without a settled record");
    assert.equal(stored.generationClaim, null);

    const retry = await generate(app, raw.id, { type: "video" });
    assert.equal(retry.body.code, "DUPLICATE_IN_PROGRESS");
    assert.deepEqual(m.calls, { image: 1, video: 0 }, "nothing re-bought");
  }, { gate: m.gate });
});
