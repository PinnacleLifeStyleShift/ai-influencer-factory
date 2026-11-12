import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";

/**
 * Code review of 12 November 2026, AI Influencer acceptance item: "replace
 * media at its URL and verify no unverified content leaves the system". The
 * export's files are re-read and checksummed before publishing and before
 * each destination; publishers receive the verified bytes themselves.
 * Synthetic clips; mock publishers; disposable Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
let prisma; let net; let mediaDir;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => {
  if (!skipReason) await resetDb(prisma);
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-send-"));
  fs.copyFileSync(path.join(FIXTURES, "clip-5s.mp4"), path.join(mediaDir, "clip-5s.mp4"));
});

const LIVE_ENV = {
  OWNER_API_TOKEN: TOKEN, LIVE_PUBLISHING: "enabled", APPROVED_PUBLISH_DESTINATIONS: "Instagram,TikTok",
  PUBLISH_ACCOUNTS: JSON.stringify({
    Instagram: { accountRef: "ig-synthetic", scopes: ["content_publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-1" },
    TikTok: { accountRef: "tt-synthetic", scopes: ["video.publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-2" },
  }),
};
function mockPlatform(platform, onPublish = () => {}) {
  const calls = [];
  return { calls, adapter: { platform, implemented: true, simulated: false, capabilities: { idempotencyKey: true, statusLookup: false },
    async publish(payload, ctx) {
      calls.push(payload); await onPublish(calls.length); await ctx.onAccepted(`${platform}-req`);
      return { status: "published", remotePostId: `${platform}-1`, permalink: `https://example.test/${platform}/1` };
    } } };
}
const DUE = () => new Date(Date.now() + 60 * 86400_000);
async function withPublishing(publishers, fn) {
  const app = await startApp({ env: LIVE_ENV, prisma, mediaStore: createFixtureMediaStore(mediaDir), publishers, publishClock: DUE });
  const call = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));
  try { return await fn(call); } finally { await app.close(); }
}
async function scheduled(call) {
  const raw = await makeReviewItem(prisma, { videoUrl: "https://example.test/clip-5s.mp4", exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false }, crossPostDestinations: ["TikTok"] });
  const it = (await call(`/api/pipeline/${raw.id}`)).body;
  assert.equal((await call(`/api/pipeline/${raw.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash })).status, 200);
  assert.equal((await call(`/api/pipeline/${raw.id}/exports`, "POST")).status, 201);
  const s = await call(`/api/pipeline/${raw.id}/schedule`, "POST");
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return s.body.content.id;
}
const replaceMedia = () => fs.copyFileSync(path.join(FIXTURES, "clip-10s.mp4"), path.join(mediaDir, "clip-5s.mp4"));

test("media replaced at its URL after export: nothing is published, and the refusal says why", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  await withPublishing({ Instagram: ig.adapter, TikTok: tt.adapter }, async (call) => {
    const contentId = await scheduled(call);
    replaceMedia();
    const r = await call(`/api/publishing/content/${contentId}/publish`, "POST");
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "EXPORT_MEDIA_CHANGED");
    assert.equal(ig.calls.length + tt.calls.length, 0, "no publisher was called");
  });
});

test("media replaced between two destinations: the second is refused; publishers get the verified bytes", opts, async () => {
  const original = fs.readFileSync(path.join(mediaDir, "clip-5s.mp4"));
  const ig = mockPlatform("Instagram", () => replaceMedia()); // the file changes while the first post is made
  const tt = mockPlatform("TikTok");
  await withPublishing({ Instagram: ig.adapter, TikTok: tt.adapter }, async (call) => {
    const contentId = await scheduled(call);
    await call(`/api/publishing/content/${contentId}/publish`, "POST");
    assert.equal(ig.calls.length, 1);
    assert.equal(sha(ig.calls[0].mediaBytes), sha(original), "the first destination received exactly the verified bytes");
    assert.equal(ig.calls[0].mediaSha256, sha(original));
    assert.equal(tt.calls.length, 0, "changed bytes never leave the system");
    const d = Object.fromEntries((await prisma.publishDelivery.findMany()).map((x) => [x.platform, x]));
    assert.equal(d.Instagram.state, "published");
    assert.deepEqual([d.TikTok.state, d.TikTok.errorCode], ["failed", "EXPORT_MEDIA_CHANGED"], "a definite 'not sent'");
  });
});

test("media deleted after export: refused before any publisher call", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  await withPublishing({ Instagram: ig.adapter, TikTok: tt.adapter }, async (call) => {
    const contentId = await scheduled(call);
    fs.rmSync(path.join(mediaDir, "clip-5s.mp4"));
    const r = await call(`/api/publishing/content/${contentId}/publish`, "POST");
    assert.equal(r.body.code, "EXPORT_MEDIA_CHANGED");
    assert.match(JSON.stringify(r.body.details), /broken link|not found/);
    assert.equal(ig.calls.length + tt.calls.length, 0);
  });
});
