import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { createFixtureMediaStore } from "../src/services/mediaStore.js";
import { PublishRejected } from "../src/services/publishers.js";
import { SimulatedProcessDeath } from "../src/services/generationGate.js";

/**
 * Publishing interfaces (brief section 10) with mock publishers only:
 * fail-closed gate, approved destinations, per-destination delivery with
 * remote ids and permalinks, partial success without re-posting, uncertain
 * outcomes and reconciliation, process death, two instances, cancellation.
 * Disposable local Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/media");
let prisma; let prisma2; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) { prisma = newClient(); prisma2 = newClient(); } });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); await prisma2?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

// Synthetic configuration (no secrets; identifiers are fake).
const LIVE_ENV = {
  OWNER_API_TOKEN: TOKEN, LIVE_PUBLISHING: "enabled", APPROVED_PUBLISH_DESTINATIONS: "Instagram,TikTok",
  PUBLISH_ACCOUNTS: JSON.stringify({
    Instagram: { accountRef: "ig-synthetic", scopes: ["content_publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-1" },
    TikTok: { accountRef: "tt-synthetic", scopes: ["video.publish"], eligibilityVerifiedAt: "2026-11-01", approvalReference: "fixture-approval-2" },
  }),
};

/**
 * A mock platform. `behave(n)` can return { reject }, { lostResponse } (post
 * made, answer lost), { timeout } (not posted, answer lost), { processing },
 * or run a hook first.
 */
function mockPlatform(platform, { lookups = true, behave = () => ({}) } = {}) {
  const state = { calls: [], posts: new Map() };
  const adapter = {
    platform, implemented: true, simulated: false,
    capabilities: { idempotencyKey: true, statusLookup: lookups },
    async publish(payload, ctx) {
      state.calls.push({ payload, clientRef: ctx.clientRef });
      const b = await behave(state.calls.length, payload);
      if (b.reject) throw new PublishRejected("Caption too long", "CAPTION_TOO_LONG");
      const id = `${platform.toLowerCase()}-post-${state.calls.length}`;
      const post = { status: "published", remotePostId: id, permalink: `https://example.test/${platform.toLowerCase()}/p/${id}` };
      // Accepted means the platform has it: it will appear even if we die now.
      if (!b.timeout && !b.processing) state.posts.set(ctx.clientRef, post);
      await ctx.onAccepted(`${platform.toLowerCase()}-req-${state.calls.length}`);
      if (b.processing) return { status: "processing", remoteRequestId: `${platform.toLowerCase()}-req-${state.calls.length}` };
      if (b.timeout) throw new Error("socket hang up");
      if (b.lostResponse) throw new Error("socket hang up");
      return post;
    },
    ...(lookups ? { async lookup({ clientRef }) { return state.posts.get(clientRef) || { status: "not_found" }; } } : {}),
  };
  return { state, adapter };
}
const registry = (...mocks) => Object.fromEntries(mocks.map((m) => [m.adapter.platform, m.adapter]));

const DUE = () => new Date(Date.now() + 60 * 86400_000); // after the approved time
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const call = (app, p, { method = "GET", body } = {}) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
const as = (app, token, p, { method = "GET", body } = {}) => app.raw(p, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
const roleToken = async (role) => (await createSessionStore(prisma).create({ id: `synthetic-${role}`, role, workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;

async function withApp(fn, { env = LIVE_ENV, publishers, faults, clock = DUE, client = prisma } = {}) {
  const app = await startApp({ env, prisma: client, mediaStore: createFixtureMediaStore(FIXTURES), publishers, publishFaults: faults, publishClock: clock });
  try { return await fn(app); } finally { await app.close(); }
}

/** Approved, exported and scheduled item; returns { item, contentId }. */
async function scheduledItem(app, overrides = {}) {
  const raw = await makeReviewItem(prisma, {
    videoUrl: "https://example.test/clip-5s.mp4", exportSettings: { format: "mp4", aspectRatio: "9:16", burnInCaptions: false },
    crossPostDestinations: ["TikTok"], ...overrides,
  });
  const item = (await call(app, `/api/pipeline/${raw.id}`)).body;
  assert.equal((await call(app, `/api/pipeline/${raw.id}/approve`, { method: "POST", body: { revision: item.revision, snapshotHash: item.snapshotHash } })).status, 200);
  assert.equal((await call(app, `/api/pipeline/${raw.id}/exports`, { method: "POST" })).status, 201);
  const s = await call(app, `/api/pipeline/${raw.id}/schedule`, { method: "POST" });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  return { item: raw, contentId: s.body.content.id };
}
const publish = (app, contentId) => call(app, `/api/publishing/content/${contentId}/publish`, { method: "POST" });
const deliveries = async () => Object.fromEntries((await prisma.publishDelivery.findMany()).map((d) => [d.platform, d]));
const expireLeases = () => prisma.publishJob.updateMany({ data: { leaseExpiresAt: new Date(Date.now() - 1000) } });

// ─── The gate fails closed ─────────────────────────────────────

test("default configuration: every platform is not implemented and nothing is written", opts, async () => {
  await withApp(async (app) => {
    const { contentId } = await scheduledItem(app);
    const r = await publish(app, contentId);
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "PUBLISHER_NOT_IMPLEMENTED");
    assert.equal(await prisma.publishJob.count(), 0);
    const policy = (await call(app, "/api/publishing/policy")).body;
    assert.ok(policy.every((p) => !p.ready && !p.implemented));
  }, { env: { OWNER_API_TOKEN: TOKEN } });
});

test("an implemented adapter still needs live flag, destination approval and a verified account", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  const cases = [
    [{ ...LIVE_ENV, LIVE_PUBLISHING: "disabled" }, "LIVE_PUBLISHING=enabled"],
    [{ ...LIVE_ENV, APPROVED_PUBLISH_DESTINATIONS: "Instagram" }, "TikTok in APPROVED_PUBLISH_DESTINATIONS"],
    [{ ...LIVE_ENV, PUBLISH_ACCOUNTS: JSON.stringify({ Instagram: JSON.parse(LIVE_ENV.PUBLISH_ACCOUNTS).Instagram, TikTok: { accountRef: "tt", scopes: [], eligibilityVerifiedAt: "2099-01-01" } }) }, "PUBLISH_ACCOUNTS.TikTok.scopes (verified)"],
    [{ ...LIVE_ENV, PUBLISH_ACCOUNTS: "{not json" }, "PUBLISH_ACCOUNTS must be valid JSON"],
  ];
  for (const [env, missing] of cases) {
    await resetDb(prisma);
    await withApp(async (app) => {
      const { contentId } = await scheduledItem(app);
      const r = await publish(app, contentId);
      assert.equal(r.body.code, "PUBLISHING_DISABLED", missing);
      assert.ok(r.body.details.missing.includes(missing), `${missing} in ${JSON.stringify(r.body.details.missing)}`);
    }, { env, publishers: registry(ig, tt) });
  }
  assert.equal(ig.state.calls.length + tt.state.calls.length, 0, "nothing was sent");
  assert.equal(await prisma.publishJob.count(), 0);
});

test("only the owner can publish; editors and reviewers cannot", opts, () => withApp(async (app) => {
  const { contentId } = await scheduledItem(app);
  for (const role of ["editor", "reviewer"]) {
    assert.equal((await as(app, await roleToken(role), `/api/publishing/content/${contentId}/publish`, { method: "POST" })).status, 403, role);
  }
}, { publishers: registry(mockPlatform("Instagram"), mockPlatform("TikTok")) }));

test("preconditions: the approved time, a verified export and a live calendar entry", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  await withApp(async (app) => {
    const { contentId } = await scheduledItem(app);
    assert.equal((await publish(app, contentId)).body.code, "NOT_YET_DUE");
  }, { publishers: registry(ig, tt), clock: () => new Date() });
  await withApp(async (app) => {
    const { item, contentId } = await scheduledItem(app);
    await prisma.exportManifest.deleteMany({});
    assert.equal((await publish(app, contentId)).body.code, "EXPORT_REQUIRED");
    await call(app, `/api/pipeline/${item.id}/cancel-schedule`, { method: "POST", body: { reason: "No longer needed" } });
    assert.equal((await publish(app, contentId)).body.code, "SCHEDULE_CANCELLED");
  }, { publishers: registry(ig, tt) });
  assert.equal(ig.state.calls.length + tt.state.calls.length, 0);
});

// ─── Delivery ──────────────────────────────────────────────────

test("cross-posting one original: one job, a delivery per approved destination, confirmed ids", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  await withApp(async (app) => {
    const { item, contentId } = await scheduledItem(app);
    const r = await publish(app, contentId);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.job.state, "published");
    const d = await deliveries();
    assert.deepEqual([d.Instagram.state, d.TikTok.state], ["published", "published"]);
    assert.equal(d.Instagram.remotePostId, "instagram-post-1");
    assert.equal(d.TikTok.permalink, "https://example.test/tiktok/p/tiktok-post-1");
    assert.equal(d.Instagram.accountRef, "ig-synthetic");

    // What was sent: the approved media (checksummed) with the disclosure in the text.
    const sent = ig.state.calls[0].payload;
    assert.match(sent.text, /fictional, AI-generated character/);
    assert.equal(sent.aiGenerated, true);
    assert.equal(sent.mediaUrl, "https://example.test/clip-5s.mp4");
    assert.match(sent.mediaSha256, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(sent).includes("prompt"));

    // One original, not two: one job, one calendar entry, both destinations.
    assert.equal(await prisma.publishJob.count(), 1);
    assert.equal(await prisma.content.count(), 1);
    assert.equal((await prisma.content.findUnique({ where: { id: contentId } })).status, "published");
    assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).stage, "published");

    // Published is final: no re-post, no edits, no cancellation, no deletion.
    assert.equal((await publish(app, contentId)).body.code, "NOT_SCHEDULED");
    assert.equal((await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { caption: "late" } })).body.code, "ALREADY_PUBLISHED");
    assert.equal((await call(app, `/api/pipeline/${item.id}/cancel-schedule`, { method: "POST", body: { reason: "too late" } })).body.code, "INVALID_TRANSITION");
    assert.equal((await call(app, `/api/pipeline/${item.id}`, { method: "DELETE" })).body.code, "ALREADY_PUBLISHED");
    assert.equal((await call(app, `/api/content/${contentId}`, { method: "DELETE" })).body.code, "USE_CANCEL_SCHEDULE");
  }, { publishers: registry(ig, tt) });
  assert.equal(ig.state.calls.length, 1);
  assert.equal(tt.state.calls.length, 1);
});

test("cross-post destinations are part of the approval", opts, () => withApp(async (app) => {
  const { item } = await scheduledItem(app, { crossPostDestinations: [] });
  const cancel = await call(app, `/api/pipeline/${item.id}/cancel-schedule`, { method: "POST", body: { reason: "Add TikTok" } });
  const before = cancel.body.pipelineItem.snapshotHash;
  const r = await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { crossPostDestinations: ["TikTok"] } });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.pipelineItem.snapshotHash, before);
  assert.equal((await call(app, `/api/pipeline/${item.id}`, { method: "PATCH", body: { crossPostDestinations: ["Myspace"] } })).status, 400);
}, { publishers: registry(mockPlatform("Instagram"), mockPlatform("TikTok")) }));

test("a destination added behind the approval's back is refused, and nothing is sent", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  await withApp(async (app) => {
    const { item, contentId } = await scheduledItem(app, { crossPostDestinations: [] });
    // Same revision, extra destination: only the snapshot hash can notice.
    await prisma.pipelineItem.update({ where: { id: item.id }, data: { crossPostDestinations: ["TikTok"] } });
    assert.equal((await publish(app, contentId)).body.code, "APPROVAL_STALE");
  }, { publishers: registry(ig, tt) });
  assert.equal(ig.state.calls.length + tt.state.calls.length, 0);
});

test("partial success: a provably rejected destination is retried later, the successful one never again", opts, async () => {
  let rejectTikTok = true;
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok", { behave: () => (rejectTikTok ? { reject: true } : {}) });
  await withApp(async (app) => {
    const { contentId } = await scheduledItem(app);
    const r = await publish(app, contentId);
    assert.equal(r.body.job.state, "partially_published");
    assert.equal((await deliveries()).TikTok.errorCode, "CAPTION_TOO_LONG");
    assert.equal((await prisma.content.findUnique({ where: { id: contentId } })).status, "partially_published");

    rejectTikTok = false;
    const again = await publish(app, contentId);
    assert.equal(again.body.job.state, "published");
    const d = await deliveries();
    assert.equal(d.TikTok.attempt, 2);
    assert.notEqual(tt.state.calls[0].clientRef, tt.state.calls[1].clientRef, "a new attempt after a proven rejection");
  }, { publishers: registry(ig, tt) });
  assert.equal(ig.state.calls.length, 1, "Instagram was posted exactly once");
  assert.equal(tt.state.calls.length, 2);
});

test("unknown outcome: no re-post until reconciled; a platform check finds the post", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok", { behave: (n) => (n === 1 ? { lostResponse: true } : {}) });
  await withApp(async (app) => {
    const { contentId } = await scheduledItem(app);
    const r = await publish(app, contentId);
    assert.equal(r.body.job.state, "awaiting_reconciliation");
    const tiktok = (await deliveries()).TikTok;
    assert.equal(tiktok.state, "outcome_unknown");
    assert.equal(tiktok.remoteRequestId, "tiktok-req-1", "the accepted request id was recorded before the answer was lost");

    assert.equal((await publish(app, contentId)).body.code, "RECONCILIATION_REQUIRED");
    const checked = await call(app, `/api/publishing/deliveries/${tiktok.id}/check`, { method: "POST" });
    assert.equal(checked.body.state, "published");
    assert.equal(checked.body.remotePostId, "tiktok-post-1");
    assert.equal(checked.body.reconciliations[0].method, "platform_check");
    assert.equal((await prisma.publishJob.findFirst()).state, "published");
    assert.equal((await prisma.content.findUnique({ where: { id: contentId } })).status, "published");
  }, { publishers: registry(ig, tt) });
  assert.equal(tt.state.calls.length, 1, "TikTok was never posted twice");
});

test("unknown outcome resolved by the owner: evidence required; 'not published' allows one new attempt", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok", { lookups: false, behave: (n) => (n === 1 ? { timeout: true } : {}) });
  await withApp(async (app) => {
    const { contentId } = await scheduledItem(app);
    await publish(app, contentId);
    const tiktok = (await deliveries()).TikTok;
    assert.equal((await call(app, `/api/publishing/deliveries/${tiktok.id}/check`, { method: "POST" })).body.code, "LOOKUP_UNSUPPORTED");
    assert.equal((await as(app, await roleToken("editor"), `/api/publishing/deliveries/${tiktok.id}/resolve`, { method: "POST", body: { resolution: "not_published", evidence: "Checked the TikTok account" } })).status, 403);
    const noEvidence = await call(app, `/api/publishing/deliveries/${tiktok.id}/resolve`, { method: "POST", body: { resolution: "published", expectedRevision: tiktok.revision } });
    assert.deepEqual(Object.keys(noEvidence.body.details.fields).sort(), ["evidence", "permalink", "remotePostId"]);
    const r = await call(app, `/api/publishing/deliveries/${tiktok.id}/resolve`, { method: "POST", body: { resolution: "not_published", evidence: "No post in the TikTok account at 10:05 UTC", expectedRevision: tiktok.revision } });
    assert.equal(r.body.state, "resolved_not_published");
    assert.equal((await call(app, `/api/publishing/deliveries/${tiktok.id}/resolve`, { method: "POST", body: { resolution: "not_published", evidence: "again, same thing", expectedRevision: tiktok.revision } })).body.code, "RECONCILIATION_CONFLICT");
    const again = await publish(app, contentId);
    assert.equal(again.body.job.state, "published");
  }, { publishers: registry(ig, tt) });
  assert.equal(ig.state.calls.length, 1);
  assert.equal(tt.state.calls.length, 2);
});

test("a platform still processing is shown as awaiting confirmation, not published", opts, async () => {
  const ig = mockPlatform("Instagram", { behave: () => ({ processing: true }) }); const tt = mockPlatform("TikTok");
  await withApp(async (app) => {
    const { contentId } = await scheduledItem(app);
    const r = await publish(app, contentId);
    assert.equal(r.body.job.state, "awaiting_confirmation");
    assert.equal((await prisma.content.findUnique({ where: { id: contentId } })).status, "partially_published");
  }, { publishers: registry(ig, tt) });
});

// ─── Process death ─────────────────────────────────────────────

for (const point of ["afterSubmitMark", "afterAccept", "afterResult"]) {
  test(`process death ${point}: after restart the delivery is unknown and is not re-posted`, opts, async () => {
    const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
    let contentId;
    await withApp(async (app) => {
      ({ contentId } = await scheduledItem(app, { crossPostDestinations: [] }));
      assert.equal((await publish(app, contentId)).status, 500);
    }, { publishers: registry(ig, tt), faults: async (p) => { if (p === point) throw new SimulatedProcessDeath(p); } });
    assert.equal((await deliveries()).Instagram.state, "submitting");

    await expireLeases();
    await withApp(async (app) => {
      const rec = await call(app, "/api/publishing/recover", { method: "POST" });
      assert.equal(rec.body.recovered[0].unknown, 1);
      assert.equal((await deliveries()).Instagram.state, "outcome_unknown");
      assert.equal((await publish(app, contentId)).body.code, "RECONCILIATION_REQUIRED");
      const d = (await deliveries()).Instagram;
      const checked = await call(app, `/api/publishing/deliveries/${d.id}/check`, { method: "POST" });
      // Posted (afterAccept/afterResult) -> found; never sent (afterSubmitMark) -> still pending.
      assert.equal(checked.body.state, point === "afterSubmitMark" ? "outcome_unknown" : "published");
    }, { publishers: registry(ig, tt) });
    assert.equal(ig.state.calls.length, point === "afterSubmitMark" ? 0 : 1, "never posted twice");
  });
}

test("process death before marking a delivery: provably not sent, the retry posts once", opts, async () => {
  const ig = mockPlatform("Instagram"); const tt = mockPlatform("TikTok");
  let contentId;
  await withApp(async (app) => {
    ({ contentId } = await scheduledItem(app, { crossPostDestinations: [] }));
    assert.equal((await publish(app, contentId)).status, 500);
  }, { publishers: registry(ig, tt), faults: async (p) => { if (p === "beforeSubmitMark") throw new SimulatedProcessDeath(p); } });
  await expireLeases();
  await withApp(async (app) => {
    await call(app, "/api/publishing/recover", { method: "POST" });
    assert.equal((await deliveries()).Instagram.state, "pending");
    assert.equal((await publish(app, contentId)).body.job.state, "published");
  }, { publishers: registry(ig, tt) });
  assert.equal(ig.state.calls.length, 1);
});

// ─── Concurrency and cancellation ──────────────────────────────

test("two instances publishing the same entry at once post each destination exactly once", opts, async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const ig = mockPlatform("Instagram", { behave: async () => { await gate; return {}; } }); const tt = mockPlatform("TikTok");
  const pubs = registry(ig, tt);
  const a = await startApp({ env: LIVE_ENV, prisma, mediaStore: createFixtureMediaStore(FIXTURES), publishers: pubs, publishClock: DUE });
  const b = await startApp({ env: LIVE_ENV, prisma: prisma2, mediaStore: createFixtureMediaStore(FIXTURES), publishers: pubs, publishClock: DUE });
  try {
    const { contentId } = await scheduledItem(a);
    const first = publish(a, contentId);
    while (ig.state.calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    const second = await publish(b, contentId);
    assert.equal(second.body.code, "PUBLISH_IN_PROGRESS");
    release();
    assert.equal((await first).body.job.state, "published");
    assert.equal((await publish(b, contentId)).body.code, "NOT_SCHEDULED");
  } finally { release(); await a.close(); await b.close(); }
  assert.equal(ig.state.calls.length, 1);
  assert.equal(tt.state.calls.length, 1);
});

test("cancelling while publishing stops the destinations not yet sent", opts, async () => {
  let app; let itemId; let cancel;
  const ig = mockPlatform("Instagram", {
    // The owner cancels while the first destination is being posted.
    behave: async () => { cancel = await call(app, `/api/pipeline/${itemId}/cancel-schedule`, { method: "POST", body: { reason: "Stop the rest" } }); return {}; },
  });
  const tt = mockPlatform("TikTok");
  await withApp(async (a) => {
    app = a;
    const { item, contentId } = await scheduledItem(a);
    itemId = item.id;
    const r = await publish(a, contentId);
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
    assert.equal(r.body.job.state, "partially_published");
    const d = await deliveries();
    assert.equal(d.Instagram.state, "published", "what was already sent is recorded");
    assert.equal(d.TikTok.state, "cancelled");
    const entry = await prisma.content.findUnique({ where: { id: contentId } });
    assert.equal(entry.status, "partially_published", "a post that is out is never shown as cancelled");
    assert.equal(entry.cancelReason, "Stop the rest");
    assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).stage, "review");
    assert.equal((await publish(a, contentId)).body.code, "SCHEDULE_CANCELLED");
  }, { publishers: registry(ig, tt) });
  assert.equal(tt.state.calls.length, 0, "the cancelled destination was never sent");
});

// ─── Simulation ───────────────────────────────────────────────

test("simulation mode: labelled simulated everywhere and never marks content published", opts, () => withApp(async (app) => {
  const { item, contentId } = await scheduledItem(app);
  const r = await publish(app, contentId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.job.state, "simulated");
  const d = await deliveries();
  assert.deepEqual([d.Instagram.state, d.Instagram.simulated], ["simulated", true]);
  assert.match(d.Instagram.permalink, /^https:\/\/example\.test\/simulated\//);
  assert.equal((await prisma.content.findUnique({ where: { id: contentId } })).status, "scheduled");
  assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).stage, "scheduled");
  const policy = (await call(app, "/api/publishing/policy")).body;
  assert.ok(policy.every((p) => p.simulated && p.ready));
}, { env: { OWNER_API_TOKEN: TOKEN, PUBLISHING_SIMULATION: "enabled" } }));
