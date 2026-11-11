import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem, makeCharacter } from "./db-helpers.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";
import { retentionPolicy } from "../src/services/retention.js";
import { configFindings } from "../src/services/opsChecks.js";

/**
 * Request contracts (owner's project prompt): unknown security-sensitive
 * fields are refused; export takes the reviewed revision and snapshot and
 * reports its state; an export whose files were deleted or replaced verifies
 * as incomplete; retention stays an owner decision (nothing deleted).
 */
const opts = { skip: skipReason, timeout: 60_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
let prisma; let net; let mediaDir;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); });
beforeEach(async () => {
  if (!skipReason) await resetDb(prisma);
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-media-"));
  fs.copyFileSync(path.join(FIXTURES, "clip-5s.mp4"), path.join(mediaDir, "clip-5s.mp4"));
});
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
async function withApp(fn) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma, mediaStore: createFixtureMediaStore(mediaDir) });
  const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  try { return await fn(call); } finally { await app.close(); }
}
const videoItem = () => makeReviewItem(prisma, { videoUrl: "https://example.test/clip-5s.mp4", exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false } });

test("unknown fields on sensitive routes are refused and change nothing", opts, () => withApp(async (call) => {
  const raw = await videoItem();
  const it = (await call(`/api/pipeline/${raw.id}`)).body;
  const smuggled = await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash, approvedBy: "someone-else", stage: "scheduled" });
  assert.equal(smuggled.status, 400);
  assert.equal(smuggled.body.code, "UNKNOWN_FIELDS");
  assert.deepEqual(smuggled.body.details.unknown.sort(), ["approvedBy", "stage"]);
  assert.equal((await prisma.pipelineItem.findUnique({ where: { id: raw.id } })).stage, "review", "nothing changed");

  const c = await makeCharacter(prisma);
  const img = await prisma.characterImage.create({ data: { characterId: c.id, imageUrl: "https://example.test/r.png", status: "candidate", source: "manual" } });
  const rights = await call(`/api/character-images/${img.id}/rights`, "POST", { basis: "owned_original", holder: "Synthetic", permittedUses: ["provider_input"], approvedAt: "2026-01-01" });
  assert.equal(rights.body.code, "UNKNOWN_FIELDS", "a rights record cannot arrive pre-approved");
  const camp = await prisma.campaign.create({ data: { name: "S" } });
  const inv = await call(`/api/campaigns/${camp.id}/invoices`, "POST", { number: "I-1", amount: "10", currency: "USD", issuedAt: "2026-11-01", voidedAt: null });
  assert.equal(inv.body.code, "UNKNOWN_FIELDS");
  assert.equal((await call("/api/system/generation-switch", "POST", { paused: true, reason: "test", until: "never" })).body.code, "UNKNOWN_FIELDS");
  assert.equal((await call(`/api/pipeline/${raw.id}/approve`, "POST", ["not", "an", "object"])).status, 400);
  assert.equal(await prisma.rightsRecord.count() + await prisma.campaignInvoice.count() + await prisma.systemControl.count(), 0);

  // Allowed fields still work.
  assert.equal((await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash })).status, 200);
}));

test("export takes the reviewed revision and snapshot, and reports its id and state", opts, () => withApp(async (call) => {
  const raw = await videoItem();
  const it = (await call(`/api/pipeline/${raw.id}`)).body;
  await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash });
  const approved = (await call(`/api/pipeline/${raw.id}`)).body;
  assert.equal((await call(`/api/pipeline/${raw.id}/exports`, "POST", { expectedRevision: approved.revision - 1 })).body.code, "APPROVAL_STALE");
  assert.equal((await call(`/api/pipeline/${raw.id}/exports`, "POST", { expectedRevision: approved.revision, approvedHash: "0".repeat(64) })).body.code, "APPROVAL_STALE");
  const ok = await call(`/api/pipeline/${raw.id}/exports`, "POST", { expectedRevision: approved.revision, approvedHash: approved.approvedHash });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.state, "ready");
  assert.equal(ok.body.exportId, ok.body.export.id);
}));

test("an export whose files were deleted or replaced verifies as incomplete", opts, () => withApp(async (call) => {
  const raw = await videoItem();
  const it = (await call(`/api/pipeline/${raw.id}`)).body;
  await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash });
  const exp = (await call(`/api/pipeline/${raw.id}/exports`, "POST")).body.export;
  const v1 = (await call(`/api/pipeline/${raw.id}/exports/${exp.id}/verify`)).body;
  assert.deepEqual([v1.intact, v1.state], [true, "complete"]);

  fs.copyFileSync(path.join(FIXTURES, "clip-10s.mp4"), path.join(mediaDir, "clip-5s.mp4")); // replaced
  const v2 = (await call(`/api/pipeline/${raw.id}/exports/${exp.id}/verify`)).body;
  assert.deepEqual([v2.state, v2.changed.length], ["incomplete", 1]);
  fs.rmSync(path.join(mediaDir, "clip-5s.mp4")); // deleted
  const v3 = (await call(`/api/pipeline/${raw.id}/exports/${exp.id}/verify`)).body;
  assert.deepEqual([v3.state, v3.missing.length], ["incomplete", 1]);
  assert.match(v3.missing[0].problem, /broken link/);
}));

test("retention is an owner decision: unset or invalid means nothing is deleted", () => {
  const unset = retentionPolicy({});
  assert.ok(Object.values(unset).every((r) => r.retainDays === null && /nothing is deleted/.test(r.state)));
  const set = retentionPolicy({ RETENTION_POLICY: JSON.stringify({ renderedExports: 730, auditTrail: 5 }) });
  assert.equal(set.renderedExports.retainDays, 730);
  assert.equal(set.auditTrail.retainDays, null, "below the 30-day floor: not applied");
  const bad = retentionPolicy({ RETENTION_POLICY: "{oops" });
  assert.ok(Object.values(bad).every((r) => r.retainDays === null));
  assert.ok(configFindings({ RETENTION_POLICY: "{oops" }).some((f) => f.setting.startsWith("RETENTION_POLICY") && f.level === "warning"));
});

// Review IF-CR03: assembly makes silent video without burned-in captions, so
// the private export carries the approved caption, hashtags and disclosure as
// their own file, taken from the immutable manifest (not the live item).
test("the caption and disclosure file comes from the approved snapshot, even after later edits", opts, () => withApp(async (call) => {
  const raw = await videoItem();
  const it = (await call(`/api/pipeline/${raw.id}`)).body;
  await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash });
  const exp = (await call(`/api/pipeline/${raw.id}/exports`, "POST")).body.export;
  await prisma.pipelineItem.update({ where: { id: raw.id }, data: { caption: "Edited after export", stage: "review", approvedHash: null, approvedRevision: null } });

  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma, mediaStore: createFixtureMediaStore(mediaDir) });
  try {
    const r = await app.call(`/api/pipeline/${raw.id}/exports/${exp.id}/download?format=captions`, { token: TOKEN });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition"), /captions\.txt"/);
    assert.equal(r.headers.get("x-export-current"), "false", "says the item has changed since");
    const text = await r.text();
    assert.ok(text.includes(exp.manifest.caption) && !text.includes("Edited after export"), "the approved caption, not the edit");
    assert.ok(text.includes(exp.manifest.disclosure));
    assert.ok(text.includes(exp.manifest.hashtags));
    assert.match(text, /not burned into the video/);
    const sha = (await import("node:crypto")).createHash("sha256").update(text).digest("hex");
    assert.equal(r.headers.get("x-content-sha256"), sha, "checksum of exactly what was sent");
    const again = await (await app.call(`/api/pipeline/${raw.id}/exports/${exp.id}/download?format=captions`, { token: TOKEN })).text();
    assert.equal(again, text, "repeatable");
  } finally { await app.close(); }
}));
