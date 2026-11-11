import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, futureSchedule } from "./db-helpers.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";

/**
 * IF-F2 (completion spec, 11 November 2026): the creative journey across three
 * roles, each with only its own permissions. Owner records and approves rights
 * and pays for mock generation; the editor sources the idea, writes the script
 * and plan, schedules and exports but cannot spend or approve; the reviewer
 * approves but cannot edit. Every refusal changes nothing and buys nothing.
 * Synthetic data; mock providers; disposable Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 120_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const GATE_ENV = {
  IMAGE_PROVIDER: "mock:image", VIDEO_PROVIDER: "mock:video", APPROVED_PROVIDER_MODELS: "mock:image,mock:video", LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "mock:image": "0.10", "mock:video": "0.50" }),
  SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "100", SPEND_CAP_MONTHLY_USD: "100", PRICE_CURRENCY: "USD", PRICE_VERSION: "test-fixture-v1", SPEND_CAP_TIMEZONE: "UTC",
};
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

test("owner, editor and reviewer complete the journey to a verified private export within their permissions", opts, async () => {
  // Mock providers: every clip is the real 10 s synthetic fixture, reported as 10 s.
  const calls = { image: 0, video: 0 };
  const gate = createGenerationGate({ env: GATE_ENV, ledger: createPrismaLedger(prisma), log: { error() {} }, adapters: {
    image: { "mock:image": { generate: async () => { calls.image++; return { imageUrl: "https://example.test/still.png" }; } } },
    video: { "mock:video": { capabilities: { sourceImage: true }, generate: async () => { calls.video++; return { videoUrl: "https://example.test/clip-10s.mp4", durationSec: 10 }; } } },
  } });
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, ROLE_INVITES: "enabled", ...GATE_ENV }, prisma, gate, mediaStore: createFixtureMediaStore(FIXTURES) });
  const owner = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  const as = (token) => (p, method = "GET", body) => app.raw(p, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
  const join = async (role) => {
    const { code } = (await owner("/api/auth/invites", "POST", { role, label: `Synthetic ${role}` })).body;
    return as((await json(await app.raw("/api/auth/session", { method: "POST", token: code }))).body.sessionToken);
  };
  const counts = async () => ({ reservations: await prisma.generationReservation.count(), calls: calls.image + calls.video });
  const denied = async (r, missing) => { assert.equal(r.status, 403, JSON.stringify(r.body)); assert.deepEqual(r.body.details.missing, missing); };
  try {
    const editor = await join("editor");
    const reviewer = await join("reviewer");

    // Owner: a fictional character and a reference with publication rights.
    const character = (await owner("/api/characters", "POST", { name: "Synthetic Journey Character", persona: "Fictional adult coach. Calm." })).body;
    const image = await prisma.characterImage.create({ data: { characterId: character.id, imageUrl: "https://example.test/ref.png", status: "candidate", source: "manual", fingerprint: "c".repeat(64) } });
    const rights = await editor(`/api/character-images/${image.id}/rights`, "POST", { basis: "owned_original", holder: "Synthetic Studio", permittedUses: ["provider_input", "publication"] });
    assert.equal(rights.status, 201, "the editor may record rights evidence (references)");
    await denied(await editor(`/api/character-images/${image.id}/rights/approve`, "POST", { recordId: rights.body.id }), ["admin"]);
    assert.equal(await prisma.rightsRecord.count({ where: { approvedAt: { not: null } } }), 0);
    assert.equal((await owner(`/api/character-images/${image.id}/rights/approve`, "POST", { recordId: rights.body.id })).status, 200);

    // Editor: a sourced idea, a script, a stale save that conflicts without losing the text.
    const idea = await editor("/api/pipeline/observations", "POST", { topic: "Calm mornings", platform: "Instagram", sourceUrl: "https://example.test/post/1",
      observedAt: "2026-11-01T10:00:00Z", observation: "Synthetic observation: a post about three calm morning habits." });
    assert.equal(idea.status, 201);
    assert.equal(idea.body.score ?? null, null, "no invented trend score");
    const created = await editor("/api/pipeline/generate-script", "POST", { characterId: character.id, duration: "30s" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const item = created.body.pipelineItem;
    let pkg = (await editor(`/api/pipeline/${item.id}/package`)).body;
    const text = { hook: "Three small habits for a calmer morning.", body: "Open the curtains as soon as you wake. Drink a glass of water before coffee. Stretch for two minutes beside the bed.", callToAction: "Follow for more calm routines." };
    assert.equal((await editor(`/api/pipeline/scripts/${pkg.script.id}`, "PUT", { expectedVersion: pkg.script.version, ...text })).status, 201, "a new script version");
    const stale = await editor(`/api/pipeline/scripts/${pkg.script.id}`, "PUT", { expectedVersion: pkg.script.version, ...text, hook: "A different hook" });
    assert.equal(stale.status, 409, "a stale save conflicts");
    pkg = (await editor(`/api/pipeline/${item.id}/package`)).body;
    assert.equal(pkg.script.hook, text.hook, "the committed text is intact");

    // The editor cannot spend; nothing is reserved or bought.
    const before = await counts();
    await denied(await editor("/api/pipeline/generate-content", "POST", { pipelineItemId: item.id, type: "video", shotIndex: 0 }), ["spend"]);
    assert.deepEqual(await counts(), before);
    // The owner generates every shot with the mock provider.
    for (const s of pkg.storyboard) {
      const g = await owner("/api/pipeline/generate-content", "POST", { pipelineItemId: item.id, type: "video", shotIndex: s.index });
      assert.equal(g.status, 200, JSON.stringify(g.body));
    }
    assert.equal(calls.video, pkg.storyboard.length, "one mock purchase per shot, none repeated");

    // Editor prepares the package for review, with a planned time.
    await editor("/api/pipeline/generate-caption", "POST", { pipelineItemId: item.id });
    const plan = futureSchedule();
    assert.equal((await editor(`/api/pipeline/${item.id}`, "PATCH", { platform: "Instagram", schedule: { local: plan.scheduleLocal, timezone: plan.scheduleTimezone } })).status, 200);

    // Approval: editor refused, reviewer approves; an edit afterwards clears it.
    let cur = (await reviewer(`/api/pipeline/${item.id}`)).body;
    await denied(await editor(`/api/pipeline/${item.id}/approve`, "POST", { revision: cur.revision, snapshotHash: cur.snapshotHash }), ["approve"]);
    assert.equal((await reviewer(`/api/pipeline/${item.id}/approve`, "POST", { revision: cur.revision, snapshotHash: cur.snapshotHash })).status, 200);
    await denied(await reviewer(`/api/pipeline/${item.id}`, "PATCH", { caption: "Reviewer edit" }), ["edit"]);
    const edited = await editor(`/api/pipeline/${item.id}`, "PATCH", { caption: "A calmer morning, in three habits. #fictional" });
    assert.equal(edited.body.pipelineItem.approvalCurrent, false, "an edit after approval clears it");
    cur = (await reviewer(`/api/pipeline/${item.id}`)).body;
    assert.equal((await reviewer(`/api/pipeline/${item.id}/approve`, "POST", { revision: cur.revision, snapshotHash: cur.snapshotHash })).status, 200);

    // Editor schedules (a plan) and exports; the reviewer cannot export.
    assert.equal((await editor(`/api/pipeline/${item.id}/schedule`, "POST", { scheduledDate: plan.scheduledDate })).status, 200);
    await denied(await reviewer(`/api/pipeline/${item.id}/exports`, "POST"), ["export"]);
    const exp = await editor(`/api/pipeline/${item.id}/exports`, "POST");
    assert.equal(exp.status, 201, JSON.stringify(exp.body));
    const m = exp.body.export.manifest;
    assert.equal(m.media.length, pkg.storyboard.length);
    assert.equal(m.cost.paidGenerations, pkg.storyboard.length + 1, "each shot and the shared still counted once");
    assert.equal(m.caption, "A calmer morning, in three habits. #fictional");
    const verify = await editor(`/api/pipeline/${item.id}/exports/${exp.body.export.id}/verify`);
    assert.deepEqual([verify.body.intact, verify.body.state], [true, "complete"]);
    const again = await editor(`/api/pipeline/${item.id}/exports`, "POST");
    assert.equal(again.body.export.manifestHash, exp.body.export.manifestHash, "repeat export: same hashes");
    const packaged = JSON.stringify(m);
    assert.ok(!/ses_|sk_|Bearer/.test(packaged), "no session tokens or keys in the package");
    for (const r of await prisma.generationReservation.findMany({ select: { id: true } })) assert.ok(!packaged.includes(r.id), "no reservation ids in the package");
  } finally { await app.close(); }
});
