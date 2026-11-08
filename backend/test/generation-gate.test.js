import { test } from "node:test";
import assert from "node:assert/strict";
import { createGenerationGate, ProviderError } from "../src/services/generationGate.js";
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
  assert.equal(ledger.get(result.reservationId).state, "settled");
  assert.equal(ledger.totals().dayMicros, 1_000_000);
  assert.deepEqual(calls, { higgs: 1, leonardo: 0 });
});

test("provider failure never falls back and keeps money reserved when outcome is unknown", async () => {
  const { adapters, calls } = mockAdapters({ higgs: { generate: async () => { throw new Error("socket hang up"); } } });
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: { ...FULL_ENV, APPROVED_PROVIDER_MODELS: "higgsfield:soul,leonardo:phoenix" }, ledger, adapters, log: quietLog });
  await assert.rejects(gate.run("image", { prompt: "p" }), (err) => {
    assert.equal(err.code, "OUTCOME_UNKNOWN");
    assert.equal(ledger.get(err.details.reservationId).state, "outcome_unknown");
    return true;
  });
  assert.equal(calls.leonardo, 0, "no automatic fallback");
  assert.equal(ledger.totals().dayMicros, 1_000_000, "unknown outcome still counts against the cap");
});

test("a request that never left the server releases its reservation", async () => {
  const { adapters } = mockAdapters({ higgs: { generate: async () => { throw new ProviderError("missing key", { submitted: false }); } } });
  const ledger = createMemoryLedger({ durable: true });
  const gate = createGenerationGate({ env: FULL_ENV, ledger, adapters });
  await expectCode(gate.run("image", { prompt: "p" }), "PROVIDER_UNAVAILABLE");
  assert.equal(ledger.totals().dayMicros, 0);
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

test("duplicate idempotency key does not create a second paid job", async () => {
  const { adapters, calls } = mockAdapters();
  const gate = createGenerationGate({ env: FULL_ENV, ledger: createMemoryLedger({ durable: true }), adapters });
  await gate.run("image", { prompt: "p", idempotencyKey: "k1" });
  await expectCode(gate.run("image", { prompt: "p", idempotencyKey: "k1" }), "DUPLICATE_REQUEST");
  assert.equal(calls.higgs, 1);
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
