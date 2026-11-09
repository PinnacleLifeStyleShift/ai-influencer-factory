import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb } from "./db-helpers.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { fingerprintUrl } from "../src/services/characterVersions.js";

/**
 * Package B: versioned characters, reference history, rights, recorded inputs,
 * adapter capabilities. Mocked providers, disposable local Postgres.
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
  PROVIDER_PRICES_USD: JSON.stringify({ "mock:image": "1.00", "mock:video": "1.00" }),
  SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "100", SPEND_CAP_MONTHLY_USD: "100",
};
function mockGate({ conditioning = false, sourceImage = true } = {}) {
  const inputs = { image: [], video: [] };
  const adapters = {
    image: { "mock:image": {
      capabilities: { referenceConditioning: conditioning, sourceImage: false },
      generate: async (input) => { inputs.image.push(input); return { imageUrl: `https://example.test/gen-${inputs.image.length}.png` }; },
    } },
    video: { "mock:video": {
      capabilities: { referenceConditioning: false, sourceImage },
      generate: async (input) => { inputs.video.push(input); return { videoUrl: `https://example.test/v-${inputs.video.length}.mp4` }; },
    } },
  };
  return { gate: createGenerationGate({ env: GATE_ENV, ledger: createPrismaLedger(prisma), adapters, log: { error() {} } }), inputs };
}

async function withApp(fn, { gate } = {}) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma, gate });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const call = (app, path, { method = "GET", body, token = TOKEN } = {}) =>
  app.call(path, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
const createCharacter = (app, body = {}) =>
  call(app, "/api/characters", { method: "POST", body: { name: "Synthetic Test Character", persona: "Alpha calm. Speaks softly.", ...body } }).then((r) => r.body);
async function clearImage(app, imageId) {
  const rec = await call(app, `/api/character-images/${imageId}/rights`, { method: "POST", body: {
    basis: "owned_original", holder: "Synthetic Studio", permittedUses: ["provider_input", "publication"],
  } });
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  const ok = await call(app, `/api/character-images/${imageId}/rights/approve`, { method: "POST", body: { recordId: rec.body.id } });
  assert.equal(ok.status, 200);
}

// ─── Versions ────────────────────────────────────────────────

test("publish freezes the draft; edits never change a published version; restore brings it back", opts, () => withApp(async (app) => {
  const c = await createCharacter(app);
  const v1 = await call(app, `/api/characters/${c.id}/versions`, { method: "POST", body: { note: "first" } });
  assert.equal(v1.status, 201);
  assert.equal(v1.body.version.version, 1);
  assert.equal(v1.body.version.identity.persona, "Alpha calm. Speaks softly.");
  assert.ok(!("bopaBackground" in v1.body.version.identity) && "bopaBackground" in v1.body.version.styling, "identity vs styling split");

  const again = await call(app, `/api/characters/${c.id}/versions`, { method: "POST" });
  assert.equal(again.status, 200);
  assert.equal(again.body.unchanged, true, "no new version without a change");

  await call(app, `/api/characters/${c.id}`, { method: "PUT", body: { persona: "Beta loud. Shouts." } });
  const list = await call(app, `/api/characters/${c.id}/versions`);
  assert.equal(list.body.draftChanged, true);
  const v2 = await call(app, `/api/characters/${c.id}/versions`, { method: "POST" });
  assert.equal(v2.body.version.version, 2);

  // Recovered after "reload": a fresh client reads the same history.
  const fresh = newClient();
  try {
    const old = await fresh.characterVersion.findUnique({ where: { characterId_version: { characterId: c.id, version: 1 } } });
    assert.equal(old.identity.persona, "Alpha calm. Speaks softly.", "v1 is immutable");
  } finally { await fresh.$disconnect(); }

  const restored = await call(app, `/api/characters/${c.id}/versions/1/restore`, { method: "POST" });
  assert.equal(restored.body.character.persona, "Alpha calm. Speaks softly.");
  assert.equal((await call(app, `/api/characters/${c.id}/versions/9`)).status, 404);
}));

test("concurrent publishes create one version", opts, () => withApp(async (app) => {
  const c = await createCharacter(app);
  const results = await Promise.all(Array.from({ length: 6 }, () => call(app, `/api/characters/${c.id}/versions`, { method: "POST" })));
  assert.ok(results.every((r) => r.status === 201 || r.status === 200), JSON.stringify(results.map((r) => r.status)));
  assert.equal(await prisma.characterVersion.count({ where: { characterId: c.id } }), 1);
}));

// ─── References and rights ───────────────────────────────────

test("the reference changes only through the reference workflow, and old versions keep their pins", opts, () => withApp(async (app) => {
  const c = await createCharacter(app, { reference_image_url: "https://example.test/ref-a.png" });
  const v1 = (await call(app, `/api/characters/${c.id}/versions`, { method: "POST" })).body.version;
  assert.deepEqual(v1.references.map((r) => r.fingerprint), [fingerprintUrl("https://example.test/ref-a.png")]);

  const sneaky = await call(app, `/api/characters/${c.id}`, { method: "PUT", body: { reference_image_url: "https://example.test/ref-b.png" } });
  assert.equal(sneaky.body.code, "USE_REFERENCE_WORKFLOW");
  const same = await call(app, `/api/characters/${c.id}`, { method: "PUT", body: { reference_image_url: "https://example.test/ref-a.png", notes: "n" } });
  assert.equal(same.status, 200, "re-sending the unchanged URL is fine");

  assert.equal((await call(app, `/api/characters/${c.id}/images`, { method: "POST", body: { imageUrl: "http://10.0.0.1/x.png" } })).status, 400);
  const b = await call(app, `/api/characters/${c.id}/images`, { method: "POST", body: { imageUrl: "https://example.test/ref-b.png" } });
  assert.equal(b.status, 201);
  assert.equal(b.body.fingerprint, fingerprintUrl("https://example.test/ref-b.png"));
  const promote = await call(app, `/api/characters/${c.id}/reference-image`, { method: "POST", body: { imageId: b.body.id, replaceReference: true } });
  assert.equal(promote.status, 200);

  const v1Again = await prisma.characterVersion.findUnique({ where: { id: v1.id } });
  assert.deepEqual(v1Again.references, v1.references, "v1 still pins ref-a");
  const images = (await call(app, `/api/characters/${c.id}/images`)).body.images;
  assert.ok(images.some((i) => i.imageUrl.endsWith("ref-a.png") && i.status === "replaced_reference"), "history intact");
}));

test("rights records: complete fields, owner approval of the reviewed record, expiry", opts, () => withApp(async (app) => {
  const c = await createCharacter(app, { reference_image_url: "https://example.test/face.png" });
  const img = (await call(app, `/api/characters/${c.id}/images`)).body.images[0];
  assert.deepEqual(img.providerInput.missing, ["rights record"]);

  const bad = await call(app, `/api/character-images/${img.id}/rights`, { method: "POST", body: {
    basis: "owned_original", holder: "x", permittedUses: ["provider_input"], likenessOfRealPerson: true,
  } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.details.fields.consentReference && bad.body.details.fields.basis, JSON.stringify(bad.body.details));

  const rec = await call(app, `/api/character-images/${img.id}/rights`, { method: "POST", body: {
    basis: "consented_likeness", holder: "Synthetic Model", permittedUses: ["provider_input"],
    likenessOfRealPerson: true, consentReference: "consent-file-001 (synthetic)",
  } });
  assert.equal(rec.status, 201);
  let rights = (await call(app, `/api/character-images/${img.id}/rights`)).body;
  assert.deepEqual(rights.clearance.provider_input.missing, ["owner approval of the rights record"]);
  assert.deepEqual(rights.clearance.publication.missing, ["permitted use: publication", "owner approval of the rights record"]);

  const editor = (await createSessionStore(prisma).create({ id: "synthetic-editor", role: "editor" }, { provider: "test", ttlMs: 3600_000 })).token;
  assert.equal((await call(app, `/api/character-images/${img.id}/rights/approve`, { method: "POST", body: { recordId: rec.body.id }, token: editor })).status, 403);

  // A newer record arrives before the owner approves the one they read.
  const newer = await call(app, `/api/character-images/${img.id}/rights`, { method: "POST", body: {
    basis: "consented_likeness", holder: "Synthetic Model", permittedUses: ["provider_input"], likenessOfRealPerson: true,
    consentReference: "consent-file-002 (synthetic)", expiresAt: new Date(Date.now() - 1000).toISOString(),
  } });
  const stale = await call(app, `/api/character-images/${img.id}/rights/approve`, { method: "POST", body: { recordId: rec.body.id } });
  assert.equal(stale.body.code, "RIGHTS_STALE");
  await call(app, `/api/character-images/${img.id}/rights/approve`, { method: "POST", body: { recordId: newer.body.id } });
  rights = (await call(app, `/api/character-images/${img.id}/rights`)).body;
  assert.deepEqual(rights.clearance.provider_input.missing, ["unexpired rights"], "approved but expired");
  assert.equal(rights.records.length, 2, "records are append-only");
}));

// ─── Generation inputs and capabilities ──────────────────────

test("a generated candidate records its actual inputs and starts with no rights", opts, async () => {
  const m = mockGate();
  await withApp(async (app) => {
    const c = await createCharacter(app);
    const r = await call(app, `/api/characters/${c.id}/generate-image`, { method: "POST" });
    assert.equal(r.status, 201);
    const cand = r.body.candidate;
    assert.equal(cand.fingerprint, fingerprintUrl("https://example.test/gen-1.png"));
    assert.equal(cand.generationInputs.basedOn, "draft");
    assert.deepEqual(cand.generationInputs.referencesSent, []);
    assert.equal(cand.generationInputs.conditioning, "none");
    assert.match(cand.generationInputs.promptHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(cand).includes("Alpha calm"), "the prompt itself is not stored");
    assert.equal(m.inputs.image[0].references, undefined, "nothing was sent as a reference");
    const listed = (await call(app, `/api/characters/${c.id}/images`)).body.images.find((i) => i.id === cand.id);
    assert.deepEqual(listed.providerInput.missing, ["rights record"]);
  }, { gate: m.gate });
});

test("a reference is sent to a video provider only if supported and cleared", opts, async () => {
  const unsupported = mockGate({ sourceImage: false });
  await withApp(async (app) => {
    const c = await createCharacter(app, { reference_image_url: "https://example.test/face.png" });
    const r = await call(app, `/api/characters/${c.id}/generate-video`, { method: "POST", body: { source: "reference" } });
    assert.equal(r.body.code, "REFERENCE_CONDITIONING_UNSUPPORTED");
    assert.equal(unsupported.inputs.video.length, 0);
  }, { gate: unsupported.gate });

  const m = mockGate({ sourceImage: true });
  await withApp(async (app) => {
    const c = await createCharacter(app, { reference_image_url: "https://example.test/face2.png" });
    const blocked = await call(app, `/api/characters/${c.id}/generate-video`, { method: "POST", body: { source: "reference" } });
    assert.equal(blocked.body.code, "REFERENCE_NOT_CLEARED");
    assert.deepEqual(blocked.body.details.missing, ["rights record"]);
    assert.equal(m.inputs.video.length, 0, "refused before any provider action");
    assert.equal(await prisma.generationReservation.count(), 0, "and before any reservation");

    const text = await call(app, `/api/characters/${c.id}/generate-video`, { method: "POST", body: {} });
    assert.equal(text.status, 200);
    assert.equal(m.inputs.video[0].imageUrl, null, "default is text-to-video: the reference is not sent");

    const img = (await call(app, `/api/characters/${c.id}/images`)).body.images[0];
    await clearImage(app, img.id);
    const ok = await call(app, `/api/characters/${c.id}/generate-video`, { method: "POST", body: { source: "reference" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(m.inputs.video[1].imageUrl, "https://example.test/face2.png");
  }, { gate: m.gate });
});

async function scriptItem(app, characterId) {
  const r = await call(app, "/api/pipeline/generate-script", { method: "POST", body: { characterId } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.pipelineItem;
}

test("reference-conditioned pipeline generation: unsupported, not cleared, then sent and recorded", opts, async () => {
  const plain = mockGate({ conditioning: false });
  await withApp(async (app) => {
    const c = await createCharacter(app, { reference_image_url: "https://example.test/ref.png" });
    const item = await scriptItem(app, c.id);
    const r = await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, referenceMode: "required" } });
    assert.equal(r.body.code, "REFERENCE_CONDITIONING_UNSUPPORTED");
    assert.equal(plain.inputs.image.length, 0);
  }, { gate: plain.gate });

  const m = mockGate({ conditioning: true });
  await withApp(async (app) => {
    const c = await createCharacter(app, { reference_image_url: "https://example.test/ref2.png" });
    const item = await scriptItem(app, c.id);
    const blocked = await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, referenceMode: "required" } });
    assert.equal(blocked.body.code, "REFERENCE_NOT_CLEARED");
    assert.deepEqual(blocked.body.details.blocked[0].missing, ["rights record"]);
    assert.equal(m.inputs.image.length, 0);
    assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).generationClaim, null, "no claim taken");

    const img = (await call(app, `/api/characters/${c.id}/images`)).body.images[0];
    await clearImage(app, img.id);
    const ok = await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id, referenceMode: "required" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(m.inputs.image[0].references, [{ url: "https://example.test/ref2.png", fingerprint: fingerprintUrl("https://example.test/ref2.png") }]);
    const app1 = await prisma.generationApplication.findFirst();
    assert.deepEqual(app1.referencesSent, [fingerprintUrl("https://example.test/ref2.png")]);
    assert.equal(app1.conditioning, "references_sent");
    assert.equal(app1.characterVersionId, item.characterVersionId);
  }, { gate: m.gate });
});

test("content generates from its pinned (older) version, and approval is bound to that version", opts, async () => {
  const m = mockGate();
  await withApp(async (app) => {
    const c = await createCharacter(app, { persona: "Alpha calm. Speaks softly." });
    const item = await scriptItem(app, c.id);
    await call(app, `/api/characters/${c.id}`, { method: "PUT", body: { persona: "Beta loud. Shouts." } });
    const v2 = (await call(app, `/api/characters/${c.id}/versions`, { method: "POST" })).body.version;
    assert.equal(v2.version, 2);

    const gen = await call(app, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id } });
    assert.equal(gen.status, 200);
    assert.match(m.inputs.image[0].prompt, /Alpha calm/);
    assert.doesNotMatch(m.inputs.image[0].prompt, /Beta loud/);
    const appRow = await prisma.generationApplication.findFirst();
    assert.equal(appRow.characterVersionId, item.characterVersionId);
    assert.equal(appRow.conditioning, "none");

    // Approve, then (bypassing the API) re-pin to v2: the approval no longer matches.
    await call(app, "/api/pipeline/generate-caption", { method: "POST", body: { pipelineItemId: item.id } });
    await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { platform: "Instagram" } });
    const cur = (await call(app, `/api/pipeline/${item.id}`)).body;
    assert.equal((await call(app, `/api/pipeline/${item.id}/approve`, { method: "POST", body: { revision: cur.revision, snapshotHash: cur.snapshotHash } })).status, 200);
    await prisma.pipelineItem.update({ where: { id: item.id }, data: { characterVersionId: v2.id } });
    const sched = await call(app, `/api/pipeline/${item.id}/schedule`, { method: "POST" });
    assert.equal(sched.body.code, "APPROVAL_STALE");
  }, { gate: m.gate });
});
