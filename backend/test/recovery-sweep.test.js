import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb } from "./db-helpers.js";
import { startRecoverySweep, overdueObligations, recoveryPass } from "../src/services/recoverySweep.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";

/**
 * Periodic recovery sweep (code review of 12 November 2026, operations):
 * recovery no longer depends on a lucky restart. No overlap, stoppable,
 * failures contained, and unresolved obligations reported. Synthetic only.
 */
let net; let prisma;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

test("the sweep runs at start and on every tick, never overlapping a slow pass, and stops", async () => {
  let ticks; let stopped = false; let runs = 0; let release;
  const fake = { setTimer: (fn) => { ticks = fn; return { unref() {} }; }, clearTimer: () => { stopped = true; } };
  const sweep = startRecoverySweep({ run: () => { runs++; return new Promise((r) => { release = r; }); }, intervalMs: 10, log: { error() {} }, ...fake });
  assert.equal(runs, 0, "starts on the next microtask");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(runs, 1);
  ticks(); ticks();
  assert.equal(runs, 1, "a slow pass is not overlapped");
  release(); await sweep.first;
  const second = ticks();
  assert.equal(runs, 1, "scheduled on the next microtask");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(runs, 2, "the next tick runs once the previous pass finished");
  release(); await second;
  sweep.stop();
  assert.equal(stopped, true);
});

test("a failing pass is logged and the sweep keeps going", async () => {
  const errors = []; let ticks; let runs = 0;
  const sweep = startRecoverySweep({ run: async () => { runs++; throw new Error("database unavailable"); }, log: { error: (m) => errors.push(m) }, setTimer: (fn) => { ticks = fn; return {}; }, clearTimer() {} });
  await sweep.first; await ticks();
  assert.equal(runs, 2);
  assert.match(errors[0], /database unavailable/);
});

test("a pass recovers an expired job and reports obligations unresolved for over an hour", { skip: skipReason, timeout: 60_000 }, async () => {
  const ledger = createPrismaLedger(prisma);
  const [r] = await ledger.reserveGroup([{ provider: "mock", model: "m", amountMicros: 1000, idempotencyKey: "sweep-1", requestHash: "h", currency: "USD", priceVersion: "v1" }],
    { perJobMicros: 1e9, dailyMicros: 1e9, monthlyMicros: 1e9, timezone: "UTC" });
  const job = await prisma.generationJob.create({ data: {
    kind: "pipeline.generate-content", targetType: "pipeline_item", targetId: "synthetic", workflowKey: "wf-sweep", state: "running",
    leaseOwner: "dead", leaseExpiresAt: new Date(Date.now() - 1000),
    steps: { create: [{ index: 0, kind: "image", provider: "mock", model: "m", idempotencyKey: "sweep-step", reservationId: r.reservationId, state: "submitting" }] },
  } });
  const warnings = [];
  await recoveryPass(prisma, ledger, { log: { info() {}, warn: (m) => warnings.push(m) } });
  assert.equal((await prisma.generationStep.findFirst({ where: { jobId: job.id } })).state, "outcome_unknown");
  assert.equal(warnings.length, 0, "just became unknown: not overdue yet");
  const later = await overdueObligations(prisma, { now: new Date(Date.now() + 2 * 3600_000) });
  assert.deepEqual([later.steps, later.reservations], [1, 1]);
});
