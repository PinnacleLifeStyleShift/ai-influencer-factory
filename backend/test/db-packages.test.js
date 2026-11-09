import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb } from "./db-helpers.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";

/**
 * Package C: ideas with provenance, versioned scripts with shot plans, the
 * content package, duration checks and the claims check. Mocked providers,
 * disposable local Postgres.
 */
const opts = { skip: skipReason };
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

// Synthetic gate configuration for mocked adapters. Test fixtures only.
const GATE_ENV = {
  IMAGE_PROVIDER: "mock:image", VIDEO_PROVIDER: "mock:video",
  APPROVED_PROVIDER_MODELS: "mock:image,mock:video", LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "mock:image": "0.10", "mock:video": "0.50" }),
  SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "100", SPEND_CAP_MONTHLY_USD: "100", PRICE_CURRENCY: "USD", PRICE_VERSION: "test-fixture-v1", SPEND_CAP_TIMEZONE: "UTC",
};
/** reportDuration: the mock provider reports the clip length it produced (as real metadata would). */
function mockGate({ reportDuration = true } = {}) {
  const calls = { image: 0, video: [] };
  const adapters = {
    image: { "mock:image": { generate: async () => { calls.image++; return { imageUrl: `https://example.test/still-${calls.image}.png` }; } } },
    video: { "mock:video": {
      capabilities: { sourceImage: true },
      generate: async (input) => {
        calls.video.push(input);
        const d = Number(input.options.duration);
        return { videoUrl: `https://example.test/clip-${calls.video.length}.mp4`, ...(reportDuration ? { durationSec: d } : {}) };
      },
    } },
  };
  return { gate: createGenerationGate({ env: GATE_ENV, ledger: createPrismaLedger(prisma), adapters, log: { error() {} } }), calls };
}

async function withApp(fn, { gate } = {}) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma, gate });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const call = (app, path, { method = "GET", body } = {}) =>
  app.call(path, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);

async function newPackage(app) {
  const c = (await call(app, "/api/characters", { method: "POST", body: { name: "Synthetic Test Character", persona: "Fictional adult coach. Calm." } })).body;
  const s = await call(app, "/api/pipeline/generate-script", { method: "POST", body: { characterId: c.id, duration: "30s" } });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  return s.body.pipelineItem;
}
const pkg = (app, id) => call(app, `/api/pipeline/${id}/package`).then((r) => r.body);
async function editScript(app, itemId, changes) {
  const p = await pkg(app, itemId);
  return call(app, `/api/pipeline/scripts/${p.script.id}`, { method: "PUT", body: { expectedVersion: p.script.version, ...changes } });
}
const CLEAN = {
  hook: "Three small habits for a calmer morning.",
  body: "Open the curtains as soon as you wake. Drink a glass of water before coffee. Stretch for two minutes beside the bed. Write down one thing to finish today.",
  callToAction: "Follow for more calm routines.",
};
async function approve(app, id) {
  const cur = (await call(app, `/api/pipeline/${id}`)).body;
  return call(app, `/api/pipeline/${id}/approve`, { method: "POST", body: { revision: cur.revision, snapshotHash: cur.snapshotHash } });
}
async function readyForReview(app, id) {
  await call(app, "/api/pipeline/generate-caption", { method: "POST", body: { pipelineItemId: id } });
  await call(app, `/api/pipeline/${id}`, { method: "PATCH", body: { platform: "Instagram" } });
}

// ─── Ideas ───────────────────────────────────────────────────

test("ideas are manual or sourced observations; fixtures are labelled and carry no score", opts, () => withApp(async (app) => {
  const idea = await call(app, "/api/pipeline/ideas", { method: "POST", body: { topic: "Morning routines", platform: "TikTok" } });
  assert.equal(idea.status, 201);
  assert.equal(idea.body.kind, "manual_idea");
  assert.equal(idea.body.trendScore, null);

  const missing = await call(app, "/api/pipeline/observations", { method: "POST", body: { topic: "Desk stretches" } });
  assert.equal(missing.status, 400);
  assert.deepEqual(Object.keys(missing.body.details.fields).sort(), ["observation", "observedAt", "platform", "sourceUrl"]);
  const unsafe = await call(app, "/api/pipeline/observations", { method: "POST", body: {
    topic: "Desk stretches", platform: "TikTok", sourceUrl: "http://127.0.0.1/x", observedAt: new Date().toISOString(), observation: "x".repeat(10) } });
  assert.ok(unsafe.body.details.fields.sourceUrl);
  const future = await call(app, "/api/pipeline/observations", { method: "POST", body: {
    topic: "Desk stretches", platform: "TikTok", sourceUrl: "https://example.test/post/1",
    observedAt: new Date(Date.now() + 86400_000).toISOString(), observation: "A post showing desk stretches." } });
  assert.ok(future.body.details.fields.observedAt);
  const obs = await call(app, "/api/pipeline/observations", { method: "POST", body: {
    topic: "Desk stretches", platform: "TikTok", sourceUrl: "https://example.test/post/1",
    observedAt: "2026-11-01T10:00:00Z", observation: "Synthetic test observation: a post showing three desk stretches." } });
  assert.equal(obs.status, 201);
  assert.equal(obs.body.kind, "observation");
  assert.equal(new Date(obs.body.observedAt).toISOString(), "2026-11-01T10:00:00.000Z");

  await call(app, "/api/pipeline/discover-trends", { method: "POST", body: { count: 2 } });
  const all = (await call(app, "/api/pipeline/trends")).body;
  assert.equal(all.length, 4);
  assert.ok(all.every((t) => t.trendScore === null), "no invented scores");
  assert.deepEqual([...new Set(all.map((t) => t.kind))].sort(), ["manual_idea", "observation", "simulated_fixture"]);
}));

// ─── Scripts, versions, shot plan ────────────────────────────

test("a generated script becomes version 1 with a shot plan that fits the target", opts, () => withApp(async (app) => {
  const item = await newPackage(app);
  assert.ok(item.scriptVersionId);
  assert.equal(item.disclosure, "This is a fictional, AI-generated character.");
  const p = await pkg(app, item.id);
  assert.equal(p.script.version, 1);
  assert.equal(p.script.targetDurationSec, 30);
  assert.ok(p.storyboard.length >= 3);
  for (const s of p.storyboard) {
    for (const k of ["scene", "visualAction", "dialogue", "caption", "transition", "durationSec", "characterVersionId", "audio"]) assert.ok(k in s, k);
  }
  assert.equal(p.duration.planned.withinTolerance, true, JSON.stringify(p.duration.planned));
}));

test("script edits create versions, re-pin items and clear approval; conflicts and long scripts are flagged", opts, () => withApp(async (app) => {
  const item = await newPackage(app);
  const stale = await call(app, `/api/pipeline/scripts/${(await pkg(app, item.id)).script.id}`, { method: "PUT", body: { expectedVersion: 7, ...CLEAN } });
  assert.equal(stale.body.code, "SCRIPT_VERSION_CONFLICT");
  const badEvidence = await editScript(app, item.id, { evidence: [{ claim: "Water helps", basis: "source" }] });
  assert.equal(badEvidence.status, 400);

  const before = (await call(app, `/api/pipeline/${item.id}`)).body;
  const v2 = await editScript(app, item.id, CLEAN);
  assert.equal(v2.status, 201);
  assert.equal(v2.body.version.version, 2);
  assert.equal(v2.body.itemsMoved, 1);
  const after = (await call(app, `/api/pipeline/${item.id}`)).body;
  assert.equal(after.scriptVersionId, v2.body.version.id);
  assert.equal(after.revision, before.revision + 1);

  const history = (await call(app, `/api/pipeline/scripts/${v2.body.version.scriptId}/versions`)).body;
  assert.deepEqual(history.versions.map((v) => v.version), [2, 1]);
  assert.notEqual(history.versions[1].body, CLEAN.body, "v1 kept as it was");

  const long = await editScript(app, item.id, { ...CLEAN, targetDurationSec: 10, body: `${CLEAN.body} ${CLEAN.body} ${CLEAN.body}` });
  assert.equal(long.status, 201);
  const p = await pkg(app, item.id);
  assert.equal(p.duration.planned.withinTolerance, false, "a script that cannot fit is flagged, not relabelled");
  assert.ok(p.duration.planned.actualSec > 10);
}));

// ─── Claims and disclosure ───────────────────────────────────

test("factual claims need a source; experience lines need fiction framing", opts, async () => {
  const m = mockGate();
  await withApp(async (app) => {
    const item = await newPackage(app);
    await editScript(app, item.id, { ...CLEAN, body: "Studies show 90% of people skip breakfast. I tried this routine for a month." });
    await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id } });
    await readyForReview(app, item.id);

    let r = await approve(app, item.id);
    assert.equal(r.body.code, "CLAIMS_UNSUPPORTED");
    assert.deepEqual(r.body.details.unsupported.map((u) => u.kind), ["factual"], "experience is covered by the default fictional disclosure");

    await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { disclosure: "Sponsored post" } });
    r = await approve(app, item.id);
    assert.deepEqual(r.body.details.unsupported.map((u) => u.kind).sort(), ["experience", "factual"]);

    await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { disclosure: "" } });
    assert.equal((await approve(app, item.id)).body.code, "DISCLOSURE_REQUIRED");

    await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { disclosure: "This is a fictional, AI-generated character." } });
    await editScript(app, item.id, { evidence: [{ claim: "Studies show 90% of people skip breakfast", basis: "source", sourceUrl: "https://example.test/study" }] });
    await call(app, "/api/pipeline/generate-caption", { method: "POST", body: { pipelineItemId: item.id } });
    r = await approve(app, item.id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }, { gate: m.gate });
});

// ─── The mocked thirty-second package ────────────────────────

test("a mocked 30-second package is composed shot by shot and measured within tolerance", opts, async () => {
  const m = mockGate({ reportDuration: true });
  await withApp(async (app) => {
    const item = await newPackage(app);
    await editScript(app, item.id, CLEAN);
    let p = await pkg(app, item.id);
    assert.equal(p.duration.measured.complete, false);

    for (const s of p.storyboard) {
      const g = await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, type: "video", shotIndex: s.index } });
      assert.equal(g.status, 200, JSON.stringify(g.body));
    }
    assert.equal(m.calls.image, 1, "one still, shared by all shots");
    assert.equal(m.calls.video.length, p.storyboard.length);
    // Each clip was asked to cover its shot.
    p.storyboard.forEach((s, i) => assert.ok(Number(m.calls.video[i].options.duration) >= s.durationSec, `shot ${i}`));
    assert.match(m.calls.video[0].prompt, /Says: "Three small habits/);

    p = await pkg(app, item.id);
    assert.equal(p.duration.measured.complete, true);
    assert.equal(p.duration.measured.verified, true);
    assert.equal(p.duration.measured.targetSec, 30);
    assert.ok(Math.abs(p.duration.measured.actualSec - 30) <= p.duration.measured.toleranceSec, JSON.stringify(p.duration.measured));

    await readyForReview(app, item.id);
    const ok = await approve(app, item.id);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // A background regeneration of one shot clears the approval.
    const blocked = await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, type: "video", shotIndex: 1 } });
    assert.equal(blocked.body.code, "APPROVED_CONTENT");
    await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, type: "video", shotIndex: 1, confirmReplaceApproved: true } });
    const afterRegen = (await call(app, `/api/pipeline/${item.id}`)).body;
    assert.equal(afterRegen.approvedHash, null);
    assert.equal(afterRegen.stage, "content_generated");
  }, { gate: m.gate });
});

test("requested-but-unreported clip lengths cannot pass as a measured package", opts, async () => {
  const m = mockGate({ reportDuration: false });
  await withApp(async (app) => {
    const item = await newPackage(app);
    await editScript(app, item.id, CLEAN);
    for (const s of (await pkg(app, item.id)).storyboard) {
      await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, type: "video", shotIndex: s.index } });
    }
    const p = await pkg(app, item.id);
    assert.equal(p.duration.measured.verified, false);
    await readyForReview(app, item.id);
    const r = await approve(app, item.id);
    assert.equal(r.body.code, "PACKAGE_INCOMPLETE");
    assert.equal(r.body.details.verified, false);
  }, { gate: m.gate });
});

test("editing one line keeps the clips of unchanged shots", opts, async () => {
  const m = mockGate();
  await withApp(async (app) => {
    const item = await newPackage(app);
    await editScript(app, item.id, CLEAN);
    const shots = (await pkg(app, item.id)).storyboard;
    for (const s of shots) await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, type: "video", shotIndex: s.index } });

    await editScript(app, item.id, { callToAction: "Save this for tomorrow morning." });
    const p = await pkg(app, item.id);
    const last = p.storyboard.at(-1);
    assert.equal(last.media, null, "the changed CTA shot lost its clip");
    assert.ok(p.storyboard.slice(0, -1).every((s) => s.media), "unchanged shots kept theirs");
    assert.equal(p.duration.measured.complete, false);
  }, { gate: m.gate });
});
