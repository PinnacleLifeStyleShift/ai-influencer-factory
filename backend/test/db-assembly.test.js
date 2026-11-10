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
import { assemblyCapability, assemble } from "../src/services/mediaAssembly.js";

/**
 * Package 4 (owner's project prompt): AssetVersion and deterministic local
 * synthetic assembly. Real ffmpeg on synthetic clips; disposable Postgres;
 * no network. Skipped (with the reason) where ffmpeg is not installed.
 */
const cap = assemblyCapability({ MEDIA_ASSEMBLY: "ffmpeg" });
const opts = { skip: skipReason || (!cap.available && `assembly unavailable: ${cap.reason}`), timeout: 180_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let prisma; let net; let outDir;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); outDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-out-")); });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
async function withApp(fn, { env = { MEDIA_ASSEMBLY: "ffmpeg" }, store, assembly } = {}) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, ...env }, prisma, mediaStore: store ?? createFixtureMediaStore(FIXTURES, { outputDir: outDir }), assembly });
  try { return await fn(app, (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json)); }
  finally { await app.close(); }
}

/** A scripted item whose every shot has a measured 10 s synthetic clip. */
async function packagedItem(call, { missing = false, clip = "clip-10s.mp4" } = {}) {
  const c = await makeCharacter(prisma);
  const r = await call("/api/pipeline/generate-script", "POST", { characterId: c.id, duration: "30s" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const item = r.body.pipelineItem;
  const pkg = (await call(`/api/pipeline/${item.id}/package`)).body;
  const shots = pkg.storyboard.slice(0, missing ? -1 : undefined);
  await prisma.pipelineItem.update({ where: { id: item.id }, data: {
    stage: "review", platform: "Instagram", disclosure: "This is a fictional, AI-generated character.",
    exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
    shotMedia: shots.map((s) => ({ shotIndex: s.index, shotKey: s.shotKey, kind: "video", url: `https://example.test/${clip}`, durationSec: 10, durationSource: "measured", reservationId: null })),
  } });
  return { item, plannedSec: pkg.storyboard.reduce((t, s) => t + Math.min(s.durationSec, 10), 0) };
}

test("assembly is unavailable unless enabled, and needs writable storage", opts, async () => {
  await withApp(async (_app, call) => {
    const { item } = await packagedItem(call);
    assert.equal((await call(`/api/pipeline/${item.id}/assemble`, "POST")).body.code, "ASSEMBLY_UNAVAILABLE");
  }, { env: {} });
  await withApp(async (_app, call) => {
    const { item } = await packagedItem(call);
    assert.equal((await call(`/api/pipeline/${item.id}/assemble`, "POST")).body.code, "MEDIA_STORE_NOT_CONFIGURED");
  }, { store: createFixtureMediaStore(FIXTURES) });
  assert.equal(await prisma.assetVersion.count(), 0);
});

test("an incomplete package cannot be assembled", opts, () => withApp(async (_app, call) => {
  const { item } = await packagedItem(call, { missing: true });
  assert.equal((await call(`/api/pipeline/${item.id}/assemble`, "POST")).body.code, "PACKAGE_INCOMPLETE");
}));

test("assembly is measured, deterministic, clears approval and is what export distributes", opts, () => withApp(async (_app, call) => {
  const { item, plannedSec } = await packagedItem(call);
  const a = await call(`/api/pipeline/${item.id}/assemble`, "POST");
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const asset = a.body.asset;
  assert.equal(asset.mime, "video/mp4");
  assert.deepEqual([asset.width, asset.height], [1080, 1920]);
  assert.ok(Math.abs(asset.durationSec - plannedSec) <= 0.5, `measured ${asset.durationSec}s vs planned ${plannedSec}s`);
  assert.equal(asset.provenance.decodeCheck, "full decode passed");
  assert.equal(asset.provenance.shots.length, (await call(`/api/pipeline/${item.id}/package`)).body.storyboard.length);
  const stored = fs.readFileSync(path.join(outDir, path.basename(asset.storageRef)));
  assert.equal(sha(stored), asset.contentHash, "the stored bytes are the recorded hash");
  assert.equal(a.body.pipelineItem.videoUrl, asset.storageRef);

  // Same inputs -> same bytes; nothing changes the second time.
  const again = await call(`/api/pipeline/${item.id}/assemble`, "POST");
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.asset.contentHash, asset.contentHash);
  assert.equal(await prisma.assetVersion.count(), 1);

  // Approve the rendered package and export it: one file, its hash, and where it came from.
  const it = (await call(`/api/pipeline/${item.id}`)).body;
  assert.equal((await call(`/api/pipeline/${item.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash })).status, 200);
  const exp = await call(`/api/pipeline/${item.id}/exports`, "POST");
  assert.equal(exp.status, 201, JSON.stringify(exp.body));
  const files = exp.body.export.manifest.media;
  assert.equal(files.length, 1);
  assert.equal(files[0].sha256, asset.contentHash);
  assert.equal(files[0].assembledFrom.length, asset.provenance.shots.length);
  assert.equal(files[0].assembly.decodeCheck, "full decode passed");
  const exp2 = await call(`/api/pipeline/${item.id}/exports`, "POST");
  assert.equal(exp2.body.export.manifestHash, exp.body.export.manifestHash, "repeat export: identical content hashes");

  // Re-assembling different inputs is a change: new hash, approval cleared.
  await prisma.pipelineItem.update({ where: { id: item.id }, data: { stage: "review", approvedHash: null, approvedRevision: null,
    shotMedia: (it.shotMedia || []).map((m, i) => (i === 0 ? { ...m, url: "https://example.test/clip-10s-b.mp4" } : m)) } });
  const changed = await call(`/api/pipeline/${item.id}/assemble`, "POST");
  assert.equal(changed.status, 201, JSON.stringify(changed.body));
  assert.notEqual(changed.body.asset.contentHash, asset.contentHash, "different inputs, different file");
  assert.equal(changed.body.pipelineItem.stage, "review");
  assert.equal(changed.body.pipelineItem.approvedHash, null, "approval must be given for the new rendered file");
  assert.equal(await prisma.assetVersion.count(), 2, "earlier renders are kept");
}));

test("broken, oversized and traversal inputs are refused; nothing is stored", opts, async () => {
  await withApp(async (_app, call) => {
    const { item } = await packagedItem(call, { clip: "truncated.mp4" });
    const r = await call(`/api/pipeline/${item.id}/assemble`, "POST");
    assert.equal(r.body.code, "ASSEMBLY_INPUT_INVALID");
    assert.match(r.body.details.failures[0].problems.join(" "), /truncated/);
  });
  await withApp(async (_app, call) => {
    const { item } = await packagedItem(call);
    const r = await call(`/api/pipeline/${item.id}/assemble`, "POST");
    assert.match(r.body.details.failures[0].problems.join(" "), /larger than/);
  }, { store: createFixtureMediaStore(FIXTURES, { outputDir: outDir, maxBytes: 1000 }) });
  assert.equal(await prisma.assetVersion.count(), 0);
  assert.equal(fs.readdirSync(outDir).length, 0);
  const store = createFixtureMediaStore(FIXTURES, { outputDir: outDir });
  for (const url of ["https://example.test/..%2F..%2Fetc%2Fpasswd", "https://example.test/%2E%2E", "https://example.test/x%E0%A4%A"]) {
    assert.equal((await store.read(url)).ok, false, url);
  }
  assert.equal((await store.write("../escape.mp4", Buffer.from("x"))).ok, false);
});

test("a timeout is reported as such and nothing is stored", opts, () => withApp(async (_app, call) => {
  const { item } = await packagedItem(call);
  const r = await call(`/api/pipeline/${item.id}/assemble`, "POST");
  assert.equal(r.status, 504);
  assert.equal(r.body.code, "ASSEMBLY_TIMEOUT");
  assert.equal(await prisma.assetVersion.count(), 0);
}, { assembly: { capability: () => ({ available: true, tool: "ffmpeg test" }), assemble: (clips, o) => assemble(clips, { ...o, timeoutMs: 1 }) } }));
