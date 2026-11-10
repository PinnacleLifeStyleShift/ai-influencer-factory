import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter } from "./db-helpers.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";
import { assemblyCapability } from "../src/services/mediaAssembly.js";

/**
 * Remediation AIF 1 (review of 10 November 2026): rights and cost lineage
 * survive assembly. A rendered file is distributed in place of its shot
 * clips, so export must follow the recorded lineage back to the generation
 * results, re-check today's publication rights of every reference actually
 * sent, and count each paid generation exactly once.
 * Synthetic clips and records; real ffmpeg where installed; disposable
 * Postgres; no provider is called.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const cap = assemblyCapability({ MEDIA_ASSEMBLY: "ffmpeg" });
const dbOpts = { skip: skipReason, timeout: 180_000 };
const opts = { skip: skipReason || (!cap.available && `assembly unavailable: ${cap.reason}`), timeout: 180_000 };
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let prisma; let net; let outDir;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); outDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-out-")); });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
async function withApp(fn) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, MEDIA_ASSEMBLY: "ffmpeg" }, prisma, mediaStore: createFixtureMediaStore(FIXTURES, { outputDir: outDir }) });
  const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  try { return await fn(call); } finally { await app.close(); }
}

let seq = 0;
async function reservation({ micros = 1_500_000, currency = "USD", state = "settled" } = {}) {
  return prisma.generationReservation.create({ data: {
    provider: "mock-video", model: "synthetic-1", amountMicros: BigInt(micros), actualMicros: state === "settled" ? BigInt(micros) : null,
    state, day: "2026-11-01", month: "2026-11", currency, priceVersion: "synthetic-v1", idempotencyKey: `lineage-${++seq}`,
  } });
}
async function reference(characterId, { uses = ["provider_input"] } = {}) {
  const fingerprint = sha(`ref-${++seq}`);
  const image = await prisma.characterImage.create({ data: { characterId, imageUrl: `https://example.test/ref-${seq}.png`, status: "reference", source: "manual", fingerprint, checksum: fingerprint } });
  await prisma.rightsRecord.create({ data: { imageId: image.id, basis: "owned_original", holder: "Synthetic Studio", permittedUses: uses, recordedBy: "owner", approvedBy: "owner", approvedAt: new Date("2026-10-01T00:00:00Z") } });
  return image;
}
const clearForPublication = (image) => prisma.rightsRecord.create({ data: {
  imageId: image.id, basis: "owned_original", holder: "Synthetic Studio", permittedUses: ["provider_input", "publication"], recordedBy: "owner", approvedBy: "owner", approvedAt: new Date(),
} });

/**
 * A scripted item whose shots have measured synthetic clips. `shots` maps a
 * shot position to { reservation, references, url }; shots without an entry
 * are manual clips (no generation).
 */
async function packagedItem(call, shots = {}, { character } = {}) {
  const c = character || await makeCharacter(prisma);
  const r = await call("/api/pipeline/generate-script", "POST", { characterId: c.id, duration: "30s" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const item = r.body.pipelineItem;
  const storyboard = (await call(`/api/pipeline/${item.id}/package`)).body.storyboard;
  const shotMedia = storyboard.map((s, i) => ({
    shotIndex: s.index, shotKey: s.shotKey, kind: "video", url: shots[i]?.url || "https://example.test/clip-10s.mp4",
    durationSec: 10, durationSource: "measured", reservationId: shots[i]?.reservation?.id || null,
  }));
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    stage: "review", platform: "Instagram", disclosure: "This is a fictional, AI-generated character.",
    exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false }, shotMedia,
  } });
  for (const [i, s] of Object.entries(shots)) {
    if (!s.reservation || s.skipApplication) continue;
    const exists = await prisma.generationApplication.findUnique({ where: { reservationId: s.reservation.id } });
    if (exists) continue;
    await prisma.generationApplication.create({ data: {
      reservationId: s.reservation.id, pipelineItemId: item.id, kind: "video", mediaUrl: shotMedia[i].url, revision: 1,
      characterVersionId: item.characterVersionId, promptHash: "p".repeat(64), referencesSent: (s.references || []).map((x) => x.fingerprint),
      conditioning: s.references?.length ? "references_sent" : "none",
    } });
  }
  return { item, character: c, storyboard };
}
async function approve(call, id) {
  const it = (await call(`/api/pipeline/${id}`)).body;
  const a = await call(`/api/pipeline/${id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash });
  assert.equal(a.status, 200, JSON.stringify(a.body));
}
async function assembleAndApprove(call, id) {
  const a = await call(`/api/pipeline/${id}/assemble`, "POST");
  assert.ok([200, 201].includes(a.status), JSON.stringify(a.body));
  await approve(call, id);
  return a.body.asset;
}
const exportOf = (call, id) => call(`/api/pipeline/${id}/exports`, "POST");

test("the paid shot from the review: blocked raw and rendered; once cleared, USD 1.50 exactly once in both forms", opts, () => withApp(async (call) => {
  const c = await makeCharacter(prisma);
  const ref = await reference(c.id); // provider input only
  const paid = await reservation({ micros: 1_500_000 });
  const { item } = await packagedItem(call, { 0: { reservation: paid, references: [ref], url: "https://example.test/clip-10s-b.mp4" } }, { character: c });

  await approve(call, item.id);
  assert.equal((await exportOf(call, item.id)).body.code, "RIGHTS_INCOMPLETE", "raw clips");

  await prisma.pipelineItem.update({ where: { id: item.id }, data: { stage: "review", approvedHash: null, approvedRevision: null } });
  await assembleAndApprove(call, item.id);
  const rendered = await exportOf(call, item.id);
  assert.equal(rendered.status, 409, JSON.stringify(rendered.body));
  assert.equal(rendered.body.code, "RIGHTS_INCOMPLETE", "rendered: the reference is still not cleared for publication");
  assert.deepEqual(rendered.body.details.references, [ref.fingerprint]);

  await clearForPublication(ref);
  const ok = await exportOf(call, item.id);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const m = ok.body.export.manifest;
  assert.equal(m.schema, "ai-influencer-factory/export-manifest@2");
  assert.deepEqual(m.rights.map((r) => r.referenceFingerprint), [ref.fingerprint]);
  assert.deepEqual(m.cost, { currency: "USD", actualKnownMicros: 1_500_000, byCurrency: { USD: 1_500_000 }, paidGenerations: 1, unknownActual: 0 });
  assert.equal(m.media.length, 1);
  assert.equal(m.media[0].assembledFrom.filter((x) => x.source === "generation").length, 1);
  assert.ok(!JSON.stringify(m).includes(paid.id), "reservation ids stay out of the manifest");

  // The same shot exported raw again reports the same cost once.
  await prisma.pipelineItem.update({ where: { id: item.id }, data: { stage: "review", renderedAssetId: null, videoUrl: null, approvedHash: null, approvedRevision: null } });
  await approve(call, item.id);
  const raw = await exportOf(call, item.id);
  assert.equal(raw.status, 201, JSON.stringify(raw.body));
  assert.deepEqual(raw.body.export.manifest.cost, m.cost);
}));

test("rights that expire or are revoked after the render block the rendered export", opts, () => withApp(async (call) => {
  for (const change of ["expired", "revoked"]) {
    const c = await makeCharacter(prisma);
    const ref = await reference(c.id, { uses: ["provider_input", "publication"] });
    const { item } = await packagedItem(call, { 1: { reservation: await reservation(), references: [ref] } }, { character: c });
    await assembleAndApprove(call, item.id);
    assert.equal((await exportOf(call, item.id)).status, 201, "cleared at render time");
    await prisma.rightsRecord.create({ data: {
      imageId: ref.id, basis: "owned_original", holder: "Synthetic Studio", permittedUses: ["provider_input", "publication"], recordedBy: "owner", approvedBy: "owner", approvedAt: new Date(),
      ...(change === "expired" ? { expiresAt: new Date(Date.now() - 60_000) } : { revokedAt: new Date(), revokeReason: "synthetic revocation" }),
    } });
    const r = await exportOf(call, item.id);
    assert.equal(r.body.code, "RIGHTS_INCOMPLETE", `${change}: ${JSON.stringify(r.body)}`);
  }
}));

test("shots sharing a reference and one paid result used twice: rights once, cost once", opts, () => withApp(async (call) => {
  const c = await makeCharacter(prisma);
  const ref = await reference(c.id, { uses: ["provider_input", "publication"] });
  const a = await reservation({ micros: 1_500_000 });
  const b = await reservation({ micros: 500_000 });
  const url = "https://example.test/clip-10s-b.mp4";
  const { item } = await packagedItem(call, {
    0: { reservation: a, references: [ref], url }, 1: { reservation: a, references: [ref], url }, 2: { reservation: b, references: [ref] },
  }, { character: c });
  await approve(call, item.id);
  const raw = await exportOf(call, item.id);
  assert.equal(raw.status, 201, JSON.stringify(raw.body));
  assert.equal(raw.body.export.manifest.cost.actualKnownMicros, 2_000_000);
  assert.equal(raw.body.export.manifest.rights.length, 1);

  await prisma.pipelineItem.update({ where: { id: item.id }, data: { stage: "review", approvedHash: null, approvedRevision: null } });
  await assembleAndApprove(call, item.id);
  const rendered = await exportOf(call, item.id);
  assert.equal(rendered.status, 201, JSON.stringify(rendered.body));
  assert.equal(rendered.body.export.manifest.cost.actualKnownMicros, 2_000_000, "not 3.50: the reused result is one charge");
  assert.equal(rendered.body.export.manifest.cost.paidGenerations, 2);
  assert.equal(rendered.body.export.manifest.rights.length, 1);
}));

test("unknown costs stay unknown and currencies are never added together", opts, () => withApp(async (call) => {
  const c = await makeCharacter(prisma);
  const { item } = await packagedItem(call, {
    0: { reservation: await reservation({ micros: 1_500_000, currency: "USD" }), url: "https://example.test/clip-10s-b.mp4" },
    1: { reservation: await reservation({ micros: 700_000, currency: "EUR" }) },
    2: { reservation: await reservation({ micros: 900_000, state: "outcome_unknown" }), url: "https://example.test/clip-10s-b.mp4" },
  }, { character: c });
  await assembleAndApprove(call, item.id);
  const r = await exportOf(call, item.id);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.export.manifest.cost, { currency: null, actualKnownMicros: null, byCurrency: { USD: 1_500_000, EUR: 700_000 }, paidGenerations: 3, unknownActual: 1 });
}));

test("a rendered asset without recorded lineage, or with a deleted generation record, is blocked, never rights-free", dbOpts, () => withApp(async (call) => {
  // The review's direct reproduction: a valid rendered AssetVersion set on an
  // item whose paid shot is not cleared for publication.
  const c = await makeCharacter(prisma);
  const ref = await reference(c.id);
  const { item } = await packagedItem(call, { 0: { reservation: await reservation(), references: [ref], url: "https://example.test/clip-10s-b.mp4" } }, { character: c });
  const bytes = fs.readFileSync(path.join(FIXTURES, "clip-10s.mp4"));
  const asset = await prisma.assetVersion.create({ data: {
    pipelineItemId: item.id, kind: "rendered", contentHash: sha(bytes), mime: "video/mp4", bytes: bytes.length, width: 1080, height: 1920,
    codec: "h264", durationSec: 10, storageRef: "https://example.test/clip-10s.mp4", provenance: { shots: [], tool: "synthetic", settings: {}, decodeCheck: "full decode passed" },
  } });
  await prisma.pipelineItem.update({ where: { id: item.id }, data: { renderedAssetId: asset.id, videoUrl: asset.storageRef } });
  await approve(call, item.id);
  const r = await exportOf(call, item.id);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "LINEAGE_UNVERIFIED");
  assert.equal(await prisma.exportManifest.count(), 0);
}));

test("a deleted generation record or a changed rendered file blocks the export", opts, () => withApp(async (call) => {
  const c = await makeCharacter(prisma);
  const paid = await reservation();
  const { item } = await packagedItem(call, { 0: { reservation: paid, url: "https://example.test/clip-10s-b.mp4" } }, { character: c });
  const asset = await assembleAndApprove(call, item.id);
  assert.equal((await exportOf(call, item.id)).status, 201);
  await prisma.generationApplication.delete({ where: { reservationId: paid.id } });
  const r = await exportOf(call, item.id);
  assert.equal(r.body.code, "LINEAGE_UNVERIFIED", JSON.stringify(r.body));
  assert.match(JSON.stringify(r.body.details), /generation record/);

  // Replaced bytes under the rendered file's name no longer match its hash.
  fs.copyFileSync(path.join(FIXTURES, "clip-5s.mp4"), path.join(outDir, path.basename(asset.storageRef)));
  const changed = await exportOf(call, item.id);
  assert.ok(["EXPORT_MEDIA_INVALID", "LINEAGE_UNVERIFIED"].includes(changed.body.code), JSON.stringify(changed.body));
}));

test("nested assemblies are followed; another character's render and lineage cycles are refused", opts, () => withApp(async (call) => {
  const c = await makeCharacter(prisma);
  const ref = await reference(c.id);
  const inner = await packagedItem(call, { 0: { reservation: await reservation({ micros: 1_500_000 }), references: [ref], url: "https://example.test/clip-10s-b.mp4" } }, { character: c });
  const innerAsset = (await call(`/api/pipeline/${inner.item.id}/assemble`, "POST")).body.asset;

  // An outer package uses the inner render as one of its clips.
  const outer = await packagedItem(call, { 0: { url: innerAsset.storageRef } }, { character: c });
  const outerAsset = await assembleAndApprove(call, outer.item.id);
  const blocked = await exportOf(call, outer.item.id);
  assert.equal(blocked.body.code, "RIGHTS_INCOMPLETE", "the inner paid shot's reference is reached through the nesting");
  await clearForPublication(ref);
  const ok = await exportOf(call, outer.item.id);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.export.manifest.cost.actualKnownMicros, 1_500_000);
  assert.ok(ok.body.export.manifest.media[0].assembledFrom.some((x) => x.source === "assembly"));

  // A cycle in recorded lineage (only possible by tampering) is refused.
  await prisma.assetLineageInput.create({ data: { assetVersionId: innerAsset.id, position: 99, inputKind: "asset_version", inputAssetVersionId: outerAsset.id, clipSha256: outerAsset.contentHash } });
  const cyc = await exportOf(call, outer.item.id);
  assert.equal(cyc.body.code, "LINEAGE_UNVERIFIED");
  assert.match(JSON.stringify(cyc.body.details), /cycle/, "named as a cycle, not only stopped by the depth limit");
  await prisma.assetLineageInput.deleteMany({ where: { position: 99 } });

  // Another character's render cannot be used as an input.
  const stranger = await packagedItem(call, {});
  const strangerAsset = (await call(`/api/pipeline/${stranger.item.id}/assemble`, "POST")).body.asset;
  const mixed = await packagedItem(call, { 0: { url: strangerAsset.storageRef } }, { character: c });
  const a = await call(`/api/pipeline/${mixed.item.id}/assemble`, "POST");
  assert.equal(a.body.code, "LINEAGE_UNVERIFIED", JSON.stringify(a.body));
}));
