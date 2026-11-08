import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenerationGate, ProviderError, selectLedger } from "../src/services/generationGate.js";
import { createMemoryLedger, usdToMicros } from "../src/services/spendLedger.js";
import { imageAdapters } from "../src/services/imageGeneration.js";
import { videoAdapters } from "../src/services/videoGeneration.js";
import { interceptExternalFetch } from "./helpers.js";

// Synthetic configuration. These numbers are TEST FIXTURES, not proposed prices or budgets.
const FULL_ENV = {
  APPROVED_PROVIDER_MODELS: "higgsfield:soul",
  LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "higgsfield:soul": "1.00" }),
  SPEND_CAP_PER_JOB_USD: "2",
  SPEND_CAP_DAILY_USD: "3",
  SPEND_CAP_MONTHLY_USD: "10",
};
const quietLog = { error() {} };

function mockAdapters(overrides = {}) {
  const calls = { higgs: 0, leonardo: 0 };
  return {
    calls,
    adapters: {
      image: {
        "higgsfield:soul": overrides.higgs || { generate: async () => { calls.higgs++; return { imageUrl: "https://example.test/fixture.png" }; } },
        "leonardo:phoenix": { generate: async () => { calls.leonardo++; return { imageUrl: "https://example.test/other.png" }; } },
      },
      video: {},
    },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => { assert.equal(err.code, code); return true; });
}

test("usdToMicros parses decimal strings exactly and rejects bad input", () => {
  assert.equal(usdToMicros("1.25"), 1_250_000);
  assert.equal(usdToMicros("0.000001"), 1);
  assert.equal(usdToMicros("10"), 10_000_000);
  for (const bad of [undefined, "", "-1", "abc", "1.2345678", "1e3", 0.1 + 0.2]) {
    assert.equal(usdToMicros(bad), null, `bad: ${bad}`);
  }
});

test("defaults: Higgsfield selected for images but not approved; no video provider", async () => {
  const { adapters, calls } = mockAdapters();
  const gate = createGenerationGate({ env: {}, ledger: createMemoryLedger({ durable: true }), adapters });
  const d = gate.describe();
  assert.equal(d.selection.image, "higgsfield:soul");
  assert.equal(d.selection.video, null);
  assert.equal(d.liveCallsEnabled, false);
  assert.equal(d.automaticFallback, false);
  await expectCode(gate.run("image", { prompt: "p" }), "PROVIDER_NOT_APPROVED");
  await expectCode(gate.run("video", { prompt: "p" }), "PROVIDER_NOT_SELECTED");
  assert.deepEqual(calls, { higgs: 0, leonardo: 0 });
});

test("each missing precondition blocks before any provider call", async () => {
  const steps = [
    [{ ...FULL_ENV, APPROVED_PROVIDER_MODELS: "" }, true, "PROVIDER_NOT_APPROVED"],
    [{ ...FULL_ENV, LIVE_PROVIDER_CALLS: "true" }, true, "LIVE_CALLS_DISABLED"],
    [FULL_ENV, false, "LEDGER_NOT_DURABLE"],
    [{ ...FULL_ENV, PROVIDER_PRICES_USD: "" }, true, "PRICE_UNKNOWN"],
    [{ ...FULL_ENV, PROVIDER_PRICES_USD: "{not json" }, true, "PRICE_UNKNOWN"],
    [{ ...FULL_ENV, SPEND_CAP_MONTHLY_USD: undefined }, true, "BUDGET_NOT_CONFIGURED"],
    [{ ...FULL_ENV, IMAGE_PROVIDER: "unknown:model" }, true, "PROVIDER_UNAVAILABLE"],
    [{ ...FULL_ENV, SPEND_CAP_PER_JOB_USD: "0.50" }, true, "BUDGET_EXCEEDED"],
  ];
  for (const [env, durable, code] of steps) {
    const { adapters, calls } = mockAdapters();
    const gate = createGenerationGate({ env, ledger: createMemoryLedger({ durable }), adapters, log: quietLog });
    await expectCode(gate.run("image", { prompt: "p" }), code);
    assert.deepEqual(calls, { higgs: 0, leonardo: 0 }, code);
  }
});

test("an approved alternative is still not used unless it is the selected provider", async () => {
  const { adapters, calls } = mockAdapters();
  const env = { ...FULL_ENV, APPROVED_PROVIDER_MODELS: "leonardo:phoenix" };
  const gate = createGenerationGate({ env, ledger: createMemoryLedger({ durable: true }), adapters });
  await expectCode(gate.run("image", { prompt: "p" }), "PROVIDER_NOT_APPROVED");
  assert.equal(calls.leonardo, 0);
});

test("fully configured run succeeds and settles the reservation", async () => {
  const { adapters, calls } = mockAdapters();
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: FULL_ENV, ledger, adapters });
  const result = await gate.run("image", { prompt: "p" });
  assert.equal(result.imageUrl, "https://example.test/fixture.png");
  assert.equal(result.provider, "higgsfield");
  assert.equal((await ledger.get(result.reservationId)).state, "settled");
  assert.equal((await ledger.totals()).dayMicros, 1_000_000);
  assert.deepEqual(calls, { higgs: 1, leonardo: 0 });
});

test("provider failure never falls back and keeps money reserved when outcome is unknown", async () => {
  const { adapters, calls } = mockAdapters({ higgs: { generate: async () => { throw new Error("socket hang up"); } } });
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: { ...FULL_ENV, APPROVED_PROVIDER_MODELS: "higgsfield:soul,leonardo:phoenix" }, ledger, adapters, log: quietLog });
  let reservationId;
  await assert.rejects(gate.run("image", { prompt: "p" }), (err) => {
    assert.equal(err.code, "OUTCOME_UNKNOWN");
    reservationId = err.details.reservationId;
    return true;
  });
  assert.equal((await ledger.get(reservationId)).state, "outcome_unknown");
  assert.equal(calls.leonardo, 0, "no automatic fallback");
  assert.equal((await ledger.totals()).dayMicros, 1_000_000, "unknown outcome still counts against the cap");
});

test("a request that never left the server releases its reservation", async () => {
  const { adapters } = mockAdapters({ higgs: { generate: async () => { throw new ProviderError("missing key", { submitted: false }); } } });
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: FULL_ENV, ledger, adapters });
  await expectCode(gate.run("image", { prompt: "p" }), "PROVIDER_UNAVAILABLE");
  assert.equal((await ledger.totals()).dayMicros, 0);
});

test("caps hold under concurrent requests", async () => {
  let inFlight = 0;
  const { adapters } = mockAdapters({
    higgs: { generate: async () => { inFlight++; await new Promise((r) => setTimeout(r, 20)); return { imageUrl: "x" }; } },
  });
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: FULL_ENV, ledger, adapters });
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => gate.run("image", { prompt: "p" })));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const blocked = results.filter((r) => r.status === "rejected" && r.reason.code === "BUDGET_EXCEEDED").length;
  assert.equal(ok, 3, "daily cap of 3 x $1 jobs");
  assert.equal(blocked, 7);
  assert.equal(inFlight, 3, "blocked jobs never reached the provider");
});

test("monthly cap is enforced across days", async () => {
  let now = new Date("2026-11-01T12:00:00Z");
  const ledger = createMemoryLedger({ durable: true, now: () => now });
  const { adapters } = mockAdapters();
  const gate = createGenerationGate({ env: { ...FULL_ENV, SPEND_CAP_MONTHLY_USD: "4" }, ledger, adapters });
  for (let i = 0; i < 3; i++) await gate.run("image", { prompt: "p" });
  now = new Date("2026-11-02T12:00:00Z");
  await gate.run("image", { prompt: "p" });
  await expectCode(gate.run("image", { prompt: "p" }), "BUDGET_EXCEEDED");
});

test("settled idempotency key replays the stored result without a second paid call", async () => {
  const { adapters, calls } = mockAdapters();
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: FULL_ENV, ledger, adapters });
  const first = await gate.run("image", { prompt: "p" }, { idempotencyKey: "k1", requestHash: "h1" });
  const again = await gate.run("image", { prompt: "p" }, { idempotencyKey: "k1", requestHash: "h1" });
  assert.equal(again.imageUrl, first.imageUrl);
  assert.equal(again.replayed, true);
  assert.equal(again.estimatedCostMicros, 0);
  assert.equal(calls.higgs, 1);
  assert.equal((await ledger.totals()).dayMicros, 1_000_000);
});

test("idempotency key reused for a different request is rejected", async () => {
  const { adapters, calls } = mockAdapters();
  const gate = createGenerationGate({ env: FULL_ENV, ledger: createMemoryLedger({ durable: true }), adapters });
  await gate.run("image", { prompt: "p" }, { idempotencyKey: "k1", requestHash: "h1" });
  await expectCode(gate.run("image", { prompt: "p" }, { idempotencyKey: "k1", requestHash: "h2" }), "IDEMPOTENCY_KEY_REUSED");
  assert.equal(calls.higgs, 1);
});

test("in-flight or unknown-outcome key blocks a retry", async () => {
  let release;
  let started = 0;
  const { adapters } = mockAdapters({
    higgs: { generate: () => { started++; return new Promise((r) => { release = () => r({ imageUrl: "x" }); }); } },
  });
  const gate = createGenerationGate({ env: FULL_ENV, ledger: createMemoryLedger({ durable: true }), adapters });
  const first = gate.run("image", {}, { idempotencyKey: "k1", requestHash: "h" });
  await new Promise((r) => setImmediate(r));
  await expectCode(gate.run("image", {}, { idempotencyKey: "k1", requestHash: "h" }), "DUPLICATE_IN_PROGRESS");
  release();
  await first;
  assert.equal(started, 1, "only one provider call started");
});

test("released (never sent) key may be retried", async () => {
  let fail = true;
  let attempts = 0;
  const { adapters } = mockAdapters({
    higgs: { generate: async () => { attempts++; if (fail) throw new ProviderError("missing key", { submitted: false }); return { imageUrl: "ok" }; } },
  });
  const gate = createGenerationGate({ env: FULL_ENV, ledger: createMemoryLedger({ durable: true }), adapters });
  await expectCode(gate.run("image", {}, { idempotencyKey: "k1", requestHash: "h" }), "PROVIDER_UNAVAILABLE");
  fail = false;
  const r = await gate.run("image", {}, { idempotencyKey: "k1", requestHash: "h" });
  assert.equal(r.imageUrl, "ok");
  assert.equal(attempts, 2);
});

test("workflow is preflighted as a whole: a blocked video step prevents the image call", async () => {
  const { adapters, calls } = mockAdapters();
  adapters.video = { "fal:kling-v2.1-i2v": { generate: async () => ({ videoUrl: "v" }) } };
  const gate = createGenerationGate({ env: FULL_ENV, ledger: createMemoryLedger({ durable: true }), adapters });
  await expectCode(gate.runWorkflow([{ kind: "image", input: {} }, { kind: "video", input: {} }]), "PROVIDER_NOT_SELECTED");
  const env2 = { ...FULL_ENV, VIDEO_PROVIDER: "fal:kling-v2.1-i2v" };
  const gate2 = createGenerationGate({ env: env2, ledger: createMemoryLedger({ durable: true }), adapters });
  await expectCode(gate2.runWorkflow([{ kind: "image", input: {} }, { kind: "video", input: {} }]), "PROVIDER_NOT_APPROVED");
  assert.equal(calls.higgs, 0);
});

test("workflow reserves its total cost up front", async () => {
  const { adapters, calls } = mockAdapters();
  let videoCalls = 0;
  adapters.video = { "fal:kling-v2.1-i2v": { generate: async () => { videoCalls++; return { videoUrl: "v" }; } } };
  const env = {
    ...FULL_ENV,
    VIDEO_PROVIDER: "fal:kling-v2.1-i2v",
    APPROVED_PROVIDER_MODELS: "higgsfield:soul,fal:kling-v2.1-i2v",
    PROVIDER_PRICES_USD: JSON.stringify({ "higgsfield:soul": "1.00", "fal:kling-v2.1-i2v": "2.50" }),
    SPEND_CAP_PER_JOB_USD: "3",
    SPEND_CAP_DAILY_USD: "3", // image (1.00) + video (2.50) = 3.50 > 3
  };
  const gate = createGenerationGate({ env, ledger: createMemoryLedger({ durable: true }), adapters });
  await expectCode(gate.runWorkflow([{ kind: "image", input: {} }, { kind: "video", input: {} }]), "BUDGET_EXCEEDED");
  assert.equal(calls.higgs, 0, "image not bought when the full workflow cannot be afforded");
  assert.equal(videoCalls, 0);
});

test("workflow persists each stage and frees unstarted reservations on failure", async () => {
  const { adapters } = mockAdapters();
  adapters.video = { "fal:kling-v2.1-i2v": { generate: async () => { throw new Error("timeout"); } } };
  const env = {
    ...FULL_ENV,
    VIDEO_PROVIDER: "fal:kling-v2.1-i2v",
    APPROVED_PROVIDER_MODELS: "higgsfield:soul,fal:kling-v2.1-i2v",
    PROVIDER_PRICES_USD: JSON.stringify({ "higgsfield:soul": "1.00", "fal:kling-v2.1-i2v": "1.00" }),
  };
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env, ledger, adapters, log: quietLog });
  const persisted = [];
  await expectCode(gate.runWorkflow([
    { kind: "image", input: {}, onResult: async (r) => persisted.push(r.imageUrl) },
    { kind: "video", input: (prev) => ({ imageUrl: prev[0].imageUrl }), onResult: async (r) => persisted.push(r.videoUrl) },
  ]), "OUTCOME_UNKNOWN");
  assert.deepEqual(persisted, ["https://example.test/fixture.png"], "image stage persisted before the video failure");
  assert.equal((await ledger.totals()).dayMicros, 2_000_000, "settled image + unknown video both counted");
});

test("real Higgsfield adapter against a mocked network: one request, no fallback, secrets not logged", async () => {
  const net = interceptExternalFetch(async (url) => {
    if (url.includes("platform.higgsfield.ai")) {
      return new Response(JSON.stringify({ detail: "synthetic failure" }), { status: 500 });
    }
    throw new Error(`unexpected host ${url}`);
  });
  const logged = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logged.push(a.join(" "));
  console.error = (...a) => logged.push(a.join(" "));
  const prevEnv = { ...process.env };
  process.env.HIGGSFIELD_API_KEY = "synthetic-key-AAAA";
  process.env.HIGGSFIELD_SECRET = "synthetic-secret-BBBB";
  process.env.LEONARDO_API_KEY = "synthetic-leo-CCCC";
  try {
    const gate = createGenerationGate({
      env: { ...FULL_ENV, APPROVED_PROVIDER_MODELS: "higgsfield:soul,leonardo:phoenix" },
      ledger: createMemoryLedger({ durable: true }),
      adapters: { image: imageAdapters, video: videoAdapters },
    });
    await expectCode(gate.run("image", { prompt: "private prompt text", options: { aspectRatio: "9:16" } }), "OUTCOME_UNKNOWN");
    assert.equal(net.calls.length, 1);
    assert.match(net.calls[0].url, /platform\.higgsfield\.ai/);
    const all = logged.join("\n");
    for (const secret of ["synthetic-key-AAAA", "synthetic-secret-BBBB", "private prompt text"]) {
      assert.ok(!all.includes(secret), `log must not contain ${secret}`);
    }
  } finally {
    console.log = origLog; console.error = origErr;
    process.env = prevEnv;
    net.restore();
  }
});

test("default ledger selection is the non-durable in-memory ledger", () => {
  assert.equal(selectLedger({}, null).durable, false);
  assert.equal(selectLedger({ SPEND_LEDGER: "memory" }, null).durable, false);
  assert.throws(() => selectLedger({ SPEND_LEDGER: "postgres" }, null));
});
