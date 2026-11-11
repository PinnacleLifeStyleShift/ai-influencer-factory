import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter } from "./db-helpers.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";
import { assemblyCapability } from "../src/services/mediaAssembly.js";

/**
 * Storage failures keep an accurate state (spec of 11 November 2026, IF13-02
 * and operational controls): a full or failing store during assembly is
 * reported as such (not "not configured"), records nothing and leaves the
 * item unchanged; a storage outage during export records no export.
 * Synthetic clips; disposable Postgres; no network.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const cap = assemblyCapability({ MEDIA_ASSEMBLY: "ffmpeg" });
const opts = { skip: skipReason || (!cap.available && `assembly unavailable: ${cap.reason}`), timeout: 180_000 };
const dbOpts = { skip: skipReason, timeout: 60_000 };
let prisma; let net; let outDir;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); outDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-out-")); });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const base = () => createFixtureMediaStore(FIXTURES, { outputDir: outDir });
async function withApp(store, fn) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, MEDIA_ASSEMBLY: "ffmpeg" }, prisma, mediaStore: store });
  const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  try { return await fn(call); } finally { await app.close(); }
}
async function packaged(call) {
  const c = await makeCharacter(prisma);
  const item = (await call("/api/pipeline/generate-script", "POST", { characterId: c.id, duration: "30s" })).body.pipelineItem;
  const storyboard = (await call(`/api/pipeline/${item.id}/package`)).body.storyboard;
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    stage: "review", platform: "Instagram", disclosure: "This is a fictional, AI-generated character.",
    exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
    shotMedia: storyboard.map((s) => ({ shotIndex: s.index, shotKey: s.shotKey, kind: "video", url: "https://example.test/clip-10s.mp4", durationSec: 10, durationSource: "measured", reservationId: null })),
  } });
  return prisma.pipelineItem.findUnique({ where: { id: item.id } });
}

test("a full store during assembly is reported as full, records nothing, and a retry after space is freed succeeds", opts, async () => {
  const full = { ...base(), async write() { throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); } };
  let item;
  await withApp(full, async (call) => {
    item = await packaged(call);
    const r = await call(`/api/pipeline/${item.id}/assemble`, "POST");
    assert.equal(r.status, 507, JSON.stringify(r.body));
    assert.equal(r.body.code, "MEDIA_STORE_FULL");
    assert.ok(r.body.requestId, "stable error with a request id");
    assert.ok(!JSON.stringify(r.body).includes(outDir), "no server paths in the error");
  });
  assert.equal(await prisma.assetVersion.count(), 0, "no asset without a stored file");
  assert.equal(await prisma.assetLineageInput.count(), 0);
  const after = await prisma.pipelineItem.findUnique({ where: { id: item.id } });
  assert.deepEqual([after.revision, after.videoUrl, after.renderedAssetId], [item.revision, item.videoUrl, item.renderedAssetId], "item unchanged");

  await withApp(base(), async (call) => {
    assert.equal((await call(`/api/pipeline/${item.id}/assemble`, "POST")).status, 201, "recovers once storage has space");
  });
});

test("a store that refuses the write is reported as a write failure, not as unconfigured", opts, async () => {
  const refusing = { ...base(), async write() { return { ok: false, problem: "storage service unavailable" }; } };
  await withApp(refusing, async (call) => {
    const item = await packaged(call);
    const r = await call(`/api/pipeline/${item.id}/assemble`, "POST");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, "MEDIA_STORE_WRITE_FAILED");
    assert.equal(await prisma.assetVersion.count(), 0);
  });
});

test("a storage outage during export records no export and keeps the approval", dbOpts, async () => {
  let item;
  await withApp(base(), async (call) => {
    const c = await makeCharacter(prisma);
    item = await prisma.pipelineItem.create({ data: {
      stage: "review", characterId: c.id, disclosure: "This is a fictional, AI-generated character.", platform: "Instagram",
      caption: "Synthetic", videoUrl: "https://example.test/clip-5s.mp4", exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
    } });
    const it = (await call(`/api/pipeline/${item.id}`)).body;
    assert.equal((await call(`/api/pipeline/${item.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash })).status, 200);
  });
  const down = { ...base(), async read() { return { ok: false, problem: "storage service unavailable" }; } };
  await withApp(down, async (call) => {
    const r = await call(`/api/pipeline/${item.id}/exports`, "POST");
    assert.equal(r.status, 422, JSON.stringify(r.body));
    assert.equal(r.body.code, "EXPORT_MEDIA_INVALID");
    assert.match(JSON.stringify(r.body.details), /storage service unavailable/);
  });
  assert.equal(await prisma.exportManifest.count(), 0, "nothing claimed as exported");
  assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).stage, "approved", "approval kept for a retry");
});
