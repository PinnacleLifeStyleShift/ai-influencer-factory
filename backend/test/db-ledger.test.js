import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPrismaLedger } from "../src/services/spendLedger.js";
import { createGenerationGate, selectLedger } from "../src/services/generationGate.js";
import { skipReason, newClient, resetDb } from "./db-helpers.js";

const opts = { skip: skipReason };
const PRICE = 1_000_000;
const CAPS = { perJobMicros: 2 * PRICE, dailyMicros: 5 * PRICE, monthlyMicros: 100 * PRICE };
const entry = (extra = {}) => ({ amountMicros: PRICE, provider: "higgsfield", model: "soul", ...extra });

let a; let b;
before(async () => { if (skipReason) return; a = newClient(); b = newClient(); });
after(async () => { await a?.$disconnect(); await b?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(a); });

test("caps hold across two independent clients (separate connection pools)", opts, async () => {
  const la = createPrismaLedger(a);
  const lb = createPrismaLedger(b);
  const attempts = Array.from({ length: 20 }, (_, i) => (i % 2 ? la : lb).reserveGroup([entry()], CAPS));
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "BUDGET_EXCEEDED"));
  assert.equal(await a.generationReservation.count(), 5);
  assert.equal((await la.totals()).dayMicros, 5 * PRICE);
});

test("group reservation is all-or-nothing", opts, async () => {
  const l = createPrismaLedger(a);
  await l.reserveGroup([entry(), entry(), entry()], CAPS); // 3 of 5
  await assert.rejects(l.reserveGroup([entry(), entry(), entry()], CAPS), { code: "BUDGET_EXCEEDED" });
  assert.equal(await a.generationReservation.count(), 3, "no partial reservation");
});

test("concurrent identical keys create exactly one reservation", opts, async () => {
  const la = createPrismaLedger(a);
  const lb = createPrismaLedger(b);
  const e = entry({ idempotencyKey: "same-key", requestHash: "h" });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => (i % 2 ? la : lb).reserveGroup([e], CAPS)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.ok(results.filter((r) => r.status === "rejected").every((r) => r.reason.code === "DUPLICATE_IN_PROGRESS"));
  assert.equal(await a.generationReservation.count(), 1);
});

test("settled result survives a restart and is replayed, not re-bought", opts, async () => {
  const first = createPrismaLedger(a);
  const [{ reservationId }] = await first.reserveGroup([entry({ idempotencyKey: "k", requestHash: "h" })], CAPS);
  await first.settle(reservationId, null, { imageUrl: "https://example.test/stored.png" });

  const restarted = createPrismaLedger(b); // new client = new process view
  const [r] = await restarted.reserveGroup([entry({ idempotencyKey: "k", requestHash: "h" })], CAPS);
  assert.deepEqual(r.replay, { imageUrl: "https://example.test/stored.png" });
  assert.equal(await a.generationReservation.count(), 1);
  assert.equal((await restarted.totals()).dayMicros, PRICE);
});

test("unknown outcome blocks retries and still counts; reuse with a different request is rejected", opts, async () => {
  const l = createPrismaLedger(a);
  const [{ reservationId }] = await l.reserveGroup([entry({ idempotencyKey: "k", requestHash: "h" })], CAPS);
  await l.markUnknown(reservationId);
  await assert.rejects(l.reserveGroup([entry({ idempotencyKey: "k", requestHash: "h" })], CAPS), { code: "DUPLICATE_IN_PROGRESS" });
  await assert.rejects(l.reserveGroup([entry({ idempotencyKey: "k", requestHash: "other" })], CAPS), { code: "IDEMPOTENCY_KEY_REUSED" });
  assert.equal((await l.totals()).dayMicros, PRICE);
});

test("released reservation can be reserved again under the same key", opts, async () => {
  const l = createPrismaLedger(a);
  const [{ reservationId }] = await l.reserveGroup([entry({ idempotencyKey: "k", requestHash: "h" })], CAPS);
  await l.release(reservationId);
  assert.equal((await l.totals()).dayMicros, 0);
  const [again] = await l.reserveGroup([entry({ idempotencyKey: "k", requestHash: "h" })], CAPS);
  assert.equal(again.reservationId, reservationId);
  assert.equal((await l.get(reservationId)).state, "reserved");
});

test("durable ledger is only selected explicitly, and the other gates still block", opts, async () => {
  assert.equal(selectLedger({}, a).durable, false);
  const ledger = selectLedger({ SPEND_LEDGER: "postgres" }, a);
  assert.equal(ledger.durable, true);
  const gate = createGenerationGate({ env: { SPEND_LEDGER: "postgres" }, ledger, adapters: { image: { "higgsfield:soul": { generate: async () => assert.fail("must not be called") } }, video: {} } });
  await assert.rejects(gate.run("image", {}), { code: "PROVIDER_NOT_APPROVED" });
  assert.equal(await a.generationReservation.count(), 0);
});
