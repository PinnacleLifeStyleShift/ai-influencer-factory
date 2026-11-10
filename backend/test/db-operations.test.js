import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem, TEST_DB_URL } from "./db-helpers.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { createGenerationGate, SimulatedProcessDeath } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";

/**
 * Operations (owner's project prompt, IF12/IF13): the runtime generation
 * switch, the obligations view, and redaction checked with synthetic secret
 * markers. Mock providers; disposable Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 120_000 };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

const GATE_ENV = {
  IMAGE_PROVIDER: "mock:image", APPROVED_PROVIDER_MODELS: "mock:image", LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "mock:image": "1.00" }), SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "100",
  SPEND_CAP_MONTHLY_USD: "100", PRICE_CURRENCY: "USD", PRICE_VERSION: "test-fixture-v1", SPEND_CAP_TIMEZONE: "UTC",
};
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
function provider() {
  const state = { calls: 0 };
  return { state, adapter: { capabilities: {}, generate: async () => { state.calls++; return { imageUrl: `https://example.test/g-${state.calls}.png` }; } } };
}
async function withApp(fn, { faults, p = provider() } = {}) {
  const gate = createGenerationGate({ env: GATE_ENV, ledger: createPrismaLedger(prisma), adapters: { image: { "mock:image": p.adapter }, video: {} }, log: { error() {}, info() {} }, faults });
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, ...GATE_ENV }, prisma, gate });
  const call = (url, method = "GET", body) => app.call(url, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  try { return await fn(app, call, p); } finally { await app.close(); }
}
const generate = (call, id, key) => call("/api/pipeline/generate-content", "POST", { pipelineItemId: id }).then((r) => r);

test("the generation switch: owner-only, with a reason; it blocks new generation but not reconciliation", opts, () => withApp(async (app, call, p) => {
  const editor = (await createSessionStore(prisma).create({ id: "e", role: "editor", workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;
  assert.equal((await app.raw("/api/system/generation-switch", { method: "POST", token: editor, body: { paused: true, reason: "x" } })).status, 403);
  assert.equal((await call("/api/system/generation-switch", "POST", { paused: true })).status, 400, "reason required");

  // An uncertain step from earlier work, to show reconciliation continues while paused.
  const r = await prisma.generationReservation.create({ data: { provider: "mock", model: "image", amountMicros: 1_000_000n, state: "outcome_unknown", day: "2026-11-10", month: "2026-11", idempotencyKey: "k-old", currency: "USD", priceVersion: "f", capTimezone: "UTC" } });
  const job = await prisma.generationJob.create({ data: { kind: "content", targetType: "pipeline_item", targetId: "x", workflowKey: "w-old", state: "awaiting_reconciliation",
    steps: { create: [{ index: 0, kind: "image", provider: "mock", model: "image", idempotencyKey: "k-old", reservationId: r.id, state: "outcome_unknown" }] } }, include: { steps: true } });

  const paused = await call("/api/system/generation-switch", "POST", { paused: true, reason: "Unexpected charges under review" });
  assert.equal(paused.body.paused, true);
  const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  const before = { reservations: await prisma.generationReservation.count(), jobs: await prisma.generationJob.count() };
  const blocked = await generate(call, item.id);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.code, "GENERATION_PAUSED");
  assert.equal(p.state.calls, 0);
  assert.deepEqual({ reservations: await prisma.generationReservation.count(), jobs: await prisma.generationJob.count() }, before, "nothing reserved or journaled");
  assert.equal((await prisma.generationReservation.findUnique({ where: { id: r.id } })).state, "outcome_unknown", "uncertain money stays counted");

  const resolved = await call(`/api/generation-jobs/steps/${job.steps[0].id}/resolve`, "POST", { resolution: "charged_no_result", evidence: "Dashboard shows the charge", expectedRevision: job.steps[0].revision });
  assert.equal(resolved.status, 200, "reconciliation still works while paused");

  await call("/api/system/generation-switch", "POST", { paused: false, reason: "Reviewed; resuming" });
  assert.equal((await generate(call, item.id)).status, 200);
  assert.equal(p.state.calls, 1);
}));

test("pausing mid-workflow stops the next submission and releases its money", opts, async () => {
  let pause = false;
  await withApp(async (_app, call, p) => {
    const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    pause = true;
    const r = await generate(call, item.id);
    assert.equal(r.body.code, "GENERATION_PAUSED", JSON.stringify(r.body));
    assert.equal(p.state.calls, 0);
    const res = await prisma.generationReservation.findMany();
    assert.ok(res.length && res.every((x) => x.state === "released"), "reserved money released");
  }, { faults: async (point) => { if (point === "afterReserve" && pause) await prisma.systemControl.upsert({ where: { key: "generation_paused" }, create: { key: "generation_paused", value: { paused: true }, reason: "pause mid-flight", updatedBy: "owner" }, update: { value: { paused: true } } }); } });
});

test("the operations view lists open obligations with the next permitted action", opts, () => withApp(async (app, call) => {
  const mk = async (state, key, resState) => {
    const r = await prisma.generationReservation.create({ data: { provider: "mock", model: "image", amountMicros: 2_000_000n, state: resState, day: "2026-11-10", month: "2026-11", idempotencyKey: key, currency: "USD", priceVersion: "f", capTimezone: "UTC" } });
    await prisma.generationJob.create({ data: { kind: "content", targetType: "pipeline_item", targetId: `item-${key}`, workflowKey: `w-${key}`, state: "awaiting_reconciliation",
      steps: { create: [{ index: 0, kind: "image", provider: "mock", model: "image", idempotencyKey: key, reservationId: r.id, state, providerRequestId: "req-1" }] } } });
  };
  await mk("outcome_unknown", "k1", "outcome_unknown");
  await mk("settlement_failed", "k2", "reserved");
  await mk("application_failed", "k3", "settled");
  await makeReviewItem(prisma, { rightsHoldAt: new Date(), rightsHoldReason: "Rights revoked" });
  const v = await call("/api/system/operations");
  assert.equal(v.status, 200);
  assert.deepEqual([v.body.summary.unknownOutcomes, v.body.summary.failedSettlements, v.body.summary.unappliedResults], [1, 1, 1]);
  assert.equal(v.body.summary.openObligations, 4);
  assert.deepEqual(v.body.summary.retainedReservations.USD, { reservedMicros: 2_000_000, outcomeUnknownMicros: 2_000_000, count: 2 });
  for (const row of v.body.rows) {
    assert.ok(row.package?.id && row.lastSafeState && row.nextAction && row.evidenceOwner, JSON.stringify(row));
  }
  assert.match(v.body.rows.find((r) => r.state === "application_failed").nextAction, /no new purchase/);
  assert.equal((await app.raw("/api/system/operations", { token: (await createSessionStore(prisma).create({ id: "r", role: "reviewer", workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token })).status, 403);
}));

test("secrets never appear in logs, audit, operations or config output (synthetic markers)", opts, async () => {
  const MARK = "SYNTHETIC-SECRET-MARKER";
  const token = `${MARK}-owner-0123456789abcdefghij`;
  const env = {
    ...process.env, PORT: String(5100 + Math.floor(Math.random() * 80)), DATABASE_URL: TEST_DB_URL, OWNER_API_TOKEN: token,
    FRONTEND_URL: "https://app.example.test", HIGGSFIELD_API_KEY: `${MARK}-higgs`, HIGGSFIELD_SECRET: `${MARK}-higgs-secret`,
    FAL_KEY: `${MARK}-fal`, LEONARDO_API_KEY: `${MARK}-leo`, KLING_SECRET_KEY: `${MARK}-kling`,
  };
  const p = spawn("node", ["src/server.js"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${env.PORT}`;
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    const bodies = [];
    const req = async (url, init = {}) => { const r = await fetch(`${base}${url}`, init); bodies.push(await r.text()); return r; };
    await req("/api/auth/session", { method: "POST", headers: { Authorization: `Bearer ${MARK}-wrong-token` } });
    const s = await req("/api/auth/session", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const session = JSON.parse(bodies.at(-1)).sessionToken;
    assert.equal(s.status, 201);
    const auth = { Authorization: `Bearer ${session}`, "Content-Type": "application/json" };
    await req("/api/system/config-check", { headers: auth });
    await req("/api/system/operations", { headers: auth });
    await req("/api/system/generation-policy", { headers: auth });
    await req("/api/pipeline/generate-content", { method: "POST", headers: auth, body: JSON.stringify({ pipelineItemId: "missing" }) });
    await req(`/api/characters?token=${MARK}-in-url`, { headers: auth });
    const audit = JSON.stringify(await prisma.auditEvent.findMany());
    for (const [where, text] of [["logs", out], ["responses", bodies.join("\n")], ["audit", audit]]) {
      assert.ok(!text.includes(MARK), `a secret marker appeared in ${where}: ${text.split("\n").filter((l) => l.includes(MARK)).slice(0, 3).join(" | ")}`);
    }
  } finally {
    await new Promise((resolve) => { p.on("exit", resolve); p.kill("SIGTERM"); });
  }
});
