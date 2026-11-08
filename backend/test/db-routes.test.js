import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem, makeCharacter } from "./db-helpers.js";
import { createGenerationGate, ProviderError } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";

const opts = { skip: skipReason };
const ENV = { OWNER_API_TOKEN: TOKEN };

// Synthetic gate configuration for mocked adapters. Test fixtures only.
const GATE_ENV = {
  IMAGE_PROVIDER: "higgsfield:soul",
  VIDEO_PROVIDER: "fal:kling-v2.1-i2v",
  APPROVED_PROVIDER_MODELS: "higgsfield:soul,fal:kling-v2.1-i2v",
  LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "higgsfield:soul": "1.00", "fal:kling-v2.1-i2v": "1.00" }),
  SPEND_CAP_PER_JOB_USD: "5",
  SPEND_CAP_DAILY_USD: "50",
  SPEND_CAP_MONTHLY_USD: "100",
};

let prisma;
let net;
before(async () => {
  net = interceptExternalFetch();
  if (!skipReason) prisma = newClient();
});
after(async () => {
  net.restore();
  assert.equal(net.calls.length, 0, "no external network calls in DB tests");
  await prisma?.$disconnect();
});
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

/** Mock adapters with call counters and pluggable behaviour. */
function mockGate(prismaClient, { env = GATE_ENV, image, video } = {}) {
  const calls = { image: 0, video: 0 };
  const adapters = {
    image: {
      "higgsfield:soul": {
        generate: async (input) => {
          calls.image++;
          if (image) return image(input, calls.image);
          return { imageUrl: `https://example.test/gen-${calls.image}.png` };
        },
      },
    },
    video: {
      "fal:kling-v2.1-i2v": {
        generate: async (input) => {
          calls.video++;
          if (video) return video(input, calls.video);
          return { videoUrl: `https://example.test/gen-${calls.video}.mp4` };
        },
      },
    },
  };
  const gate = createGenerationGate({ env, ledger: createPrismaLedger(prismaClient), adapters, log: { error() {} } });
  return { gate, calls };
}

async function withApp(fn, { gate } = {}) {
  const app = await startApp({ env: ENV, prisma, gate });
  try { return await fn(app); } finally { await app.close(); }
}

const json = async (r) => ({ status: r.status, body: await r.json() });
const getItem = (app, id) => app.call(`/api/pipeline/${id}`, { token: TOKEN }).then((r) => r.json());
const approve = (app, item, extra = {}) => app.call(`/api/pipeline/${item.id}/approve`, {
  method: "POST", token: TOKEN, body: { revision: item.revision, snapshotHash: item.snapshotHash, ...extra },
}).then(json);

// ─── Finding 1: exact-revision approval ──────────────────────

test("approval requires the reviewed revision and snapshot hash", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma);
  const item = await getItem(app, raw.id);

  const missing = await app.call(`/api/pipeline/${item.id}/approve`, { method: "POST", token: TOKEN, body: {} }).then(json);
  assert.equal(missing.status, 400);

  const stale = await approve(app, { ...item, snapshotHash: "0".repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "APPROVAL_STALE");

  const ok = await approve(app, item);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.pipelineItem.stage, "approved");
  assert.equal(ok.body.pipelineItem.approvedHash, item.snapshotHash);
  assert.equal(ok.body.pipelineItem.approvedBy, "owner");
  assert.equal(ok.body.pipelineItem.approvalCurrent, true);
}));

test("destination must be chosen explicitly before approval", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma, { platform: null });
  let item = await getItem(app, raw.id);
  const blocked = await approve(app, item);
  assert.equal(blocked.body.code, "DESTINATION_REQUIRED");

  const patched = await app.call(`/api/pipeline/${item.id}`, { method: "PATCH", token: TOKEN, body: { platform: "YouTube", revision: item.revision } }).then(json);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.pipelineItem.revision, item.revision + 1);
  item = patched.body.pipelineItem;
  assert.equal((await approve(app, item)).status, 200);
}));

test("editing caption or destination after approval invalidates it and blocks scheduling", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma);
  const item = await getItem(app, raw.id);
  await approve(app, item);

  const edit = await app.call(`/api/pipeline/${item.id}`, { method: "PATCH", token: TOKEN, body: { caption: "Changed after approval" } }).then(json);
  assert.equal(edit.status, 200);
  const after = edit.body.pipelineItem;
  assert.equal(after.stage, "review");
  assert.equal(after.approvedHash, null);
  assert.equal(after.approvalCurrent, false);
  assert.equal(after.revision, item.revision + 1);

  const sched = await app.call(`/api/pipeline/${item.id}/schedule`, { method: "POST", token: TOKEN, body: {} }).then(json);
  assert.equal(sched.status, 409);
  assert.equal(await prisma.content.count(), 0);

  // The old approval cannot be replayed against the new revision.
  const replay = await approve(app, item);
  assert.equal(replay.body.code, "APPROVAL_STALE");
  assert.equal((await approve(app, after)).status, 200);
}));

test("regenerating a caption on an approved item invalidates approval", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma);
  const item = await getItem(app, raw.id);
  await approve(app, item);
  const r = await app.call("/api/pipeline/generate-caption", { method: "POST", token: TOKEN, body: { pipelineItemId: item.id } }).then(json);
  assert.equal(r.status, 200);
  assert.equal(r.body.pipelineItem.stage, "review");
  assert.equal(r.body.pipelineItem.approvedHash, null);
}));

test("a change that bypasses the API is caught by the snapshot hash at scheduling", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma);
  await approve(app, await getItem(app, raw.id));
  await prisma.pipelineItem.update({ where: { id: raw.id }, data: { caption: "tampered" } });
  const r = await app.call(`/api/pipeline/${raw.id}/schedule`, { method: "POST", token: TOKEN, body: {} }).then(json);
  assert.equal(r.body.code, "APPROVAL_STALE");
  assert.equal(await prisma.content.count(), 0);
}));

test("stale revision on edit is rejected; scheduled items are locked", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma);
  const item = await getItem(app, raw.id);
  const stale = await app.call(`/api/pipeline/${item.id}`, { method: "PATCH", token: TOKEN, body: { caption: "x", revision: item.revision + 5 } }).then(json);
  assert.equal(stale.body.code, "REVISION_CONFLICT");

  await approve(app, item);
  await app.call(`/api/pipeline/${item.id}/schedule`, { method: "POST", token: TOKEN, body: {} });
  for (const [path, body, method] of [
    [`/api/pipeline/${item.id}`, { caption: "late edit" }, "PATCH"],
    ["/api/pipeline/generate-caption", { pipelineItemId: item.id }, "POST"],
  ]) {
    const r = await app.call(path, { method, token: TOKEN, body }).then(json);
    assert.equal(r.body.code, "ALREADY_SCHEDULED", path);
  }
}));

// ─── Finding 1: generic content routes ───────────────────────

test("generic content routes cannot schedule, publish or alter approved content", opts, () => withApp(async (app) => {
  const character = await makeCharacter(prisma);
  const sched = await app.call("/api/content", { method: "POST", token: TOKEN, body: { title: "t", characterId: character.id, status: "scheduled" } }).then(json);
  assert.equal(sched.body.code, "APPROVAL_REQUIRED");
  const draft = await app.call("/api/content", { method: "POST", token: TOKEN, body: { title: "t", characterId: character.id } }).then(json);
  assert.equal(draft.status, 201);
  assert.equal(draft.body.status, "draft");
  const promote = await app.call(`/api/content/${draft.body.id}`, { method: "PUT", token: TOKEN, body: { status: "scheduled" } }).then(json);
  assert.equal(promote.body.code, "APPROVAL_REQUIRED");
  const pub = await app.call(`/api/content/${draft.body.id}`, { method: "PUT", token: TOKEN, body: { status: "published" } }).then(json);
  assert.equal(pub.body.code, "PUBLISHING_NOT_ENABLED");

  // Content created from an approved revision.
  const raw = await makeReviewItem(prisma);
  await approve(app, await getItem(app, raw.id));
  const { body: s } = await app.call(`/api/pipeline/${raw.id}/schedule`, { method: "POST", token: TOKEN, body: { scheduledDate: "2026-12-01" } }).then(json);
  const cid = s.content.id;

  for (const body of [{ caption: "edited" }, { platform: "TikTok" }, { hashtags: "#new" }, { title: "new title" }, { status: "draft" }]) {
    const r = await app.call(`/api/content/${cid}`, { method: "PUT", token: TOKEN, body }).then(json);
    assert.equal(r.body.code, "APPROVAL_LOCKED", JSON.stringify(body));
  }
  // Re-sending unchanged values (as the calendar form does) plus a date change is allowed.
  const ok = await app.call(`/api/content/${cid}`, { method: "PUT", token: TOKEN, body: { caption: s.content.caption, status: "scheduled", scheduledDate: "2026-12-02" } }).then(json);
  assert.equal(ok.status, 200);
  const stored = await prisma.content.findUnique({ where: { id: cid } });
  assert.equal(stored.caption, "Synthetic caption");
  assert.equal(stored.status, "scheduled");
}));

test("legacy manually-scheduled rows stay editable without re-asserting status", opts, () => withApp(async (app) => {
  const character = await makeCharacter(prisma);
  const legacy = await prisma.content.create({ data: { title: "legacy", status: "scheduled", characterId: character.id } });
  const r = await app.call(`/api/content/${legacy.id}`, { method: "PUT", token: TOKEN, body: { status: "scheduled", notes: "n" } }).then(json);
  assert.equal(r.status, 200);
}));

// ─── Findings 2 and 5: atomic, idempotent, correct scheduling ──

test("concurrent schedule requests create exactly one calendar entry", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma);
  await approve(app, await getItem(app, raw.id));
  const responses = await Promise.all(Array.from({ length: 12 }, () =>
    app.call(`/api/pipeline/${raw.id}/schedule`, { method: "POST", token: TOKEN, body: { scheduledDate: "2026-12-01" } }).then(json)));
  assert.ok(responses.every((r) => r.status === 200), JSON.stringify(responses.map((r) => r.status)));
  assert.equal(await prisma.content.count(), 1);
  assert.equal(new Set(responses.map((r) => r.body.content.id)).size, 1);
  assert.equal(responses.filter((r) => r.body.replayed === false).length, 1);
}));

test("schedule key is unique at the database level", opts, async () => {
  const character = await makeCharacter(prisma);
  await prisma.content.create({ data: { title: "a", characterId: character.id, scheduleKey: "k1" } });
  await assert.rejects(prisma.content.create({ data: { title: "b", characterId: character.id, scheduleKey: "k1" } }), { code: "P2002" });
});

test("scheduling uses the approved destination and the real media type", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma, {
    platform: "Instagram", imageUrl: "https://example.test/source.png", videoUrl: "https://example.test/clip.mp4",
  });
  await approve(app, await getItem(app, raw.id));

  const mismatch = await app.call(`/api/pipeline/${raw.id}/schedule`, { method: "POST", token: TOKEN, body: { platform: "TikTok" } }).then(json);
  assert.equal(mismatch.body.code, "DESTINATION_MISMATCH");

  const ok = await app.call(`/api/pipeline/${raw.id}/schedule`, { method: "POST", token: TOKEN, body: {} }).then(json);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.content.platform, "Instagram");
  assert.equal(ok.body.content.mediaType, "video");
  assert.equal(ok.body.content.contentType, "Video");
  assert.equal(ok.body.content.videoUrl, "https://example.test/clip.mp4");
  assert.equal(ok.body.content.imageUrl, "https://example.test/source.png");
}));

test("script platform is not used as the posting destination", opts, () => withApp(async (app) => {
  const character = await makeCharacter(prisma);
  const r = await app.call("/api/pipeline/generate-script", { method: "POST", token: TOKEN, body: { characterId: character.id, platform: "TikTok" } }).then(json);
  assert.equal(r.status, 201);
  assert.equal(r.body.pipelineItem.platform, null);
}));

// ─── Findings 3 and 4: workflow preflight, persistence, idempotency ──

test("video workflow is blocked before the paid image call when video is not permitted", opts, async () => {
  const { gate, calls } = mockGate(prisma, { env: { ...GATE_ENV, VIDEO_PROVIDER: "" } });
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const r = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body: { pipelineItemId: raw.id, type: "video" } }).then(json);
    assert.equal(r.body.code, "PROVIDER_NOT_SELECTED");
    assert.deepEqual(calls, { image: 0, video: 0 });
    assert.equal(await prisma.generationReservation.count(), 0);
    assert.equal((await prisma.pipelineItem.findUnique({ where: { id: raw.id } })).activeWorkflowKey, null);
  }, { gate });
});

test("unknown video outcome: image stage is kept, retry buys nothing", opts, async () => {
  const { gate, calls } = mockGate(prisma, { video: () => { throw new Error("socket timeout"); } });
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const body = { pipelineItemId: raw.id, type: "video" };
    const first = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body }).then(json);
    assert.equal(first.body.code, "OUTCOME_UNKNOWN");
    const stored = await prisma.pipelineItem.findUnique({ where: { id: raw.id } });
    assert.equal(stored.imageUrl, "https://example.test/gen-1.png", "image stage persisted");
    assert.ok(stored.activeWorkflowKey, "unfinished workflow recorded");

    const retry = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body }).then(json);
    assert.equal(retry.body.code, "DUPLICATE_IN_PROGRESS");
    assert.deepEqual(calls, { image: 1, video: 1 });
    const states = (await prisma.generationReservation.findMany()).map((r) => r.state).sort();
    assert.deepEqual(states, ["outcome_unknown", "settled"]);
  }, { gate });
});

test("video not sent: retry resumes without regenerating the image", opts, async () => {
  let failVideo = true;
  const { gate, calls } = mockGate(prisma, {
    video: (_i, n) => { if (failVideo) throw new ProviderError("missing key", { submitted: false }); return { videoUrl: `https://example.test/v${n}.mp4` }; },
  });
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const body = { pipelineItemId: raw.id, type: "video" };
    assert.equal((await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body }).then(json)).body.code, "PROVIDER_UNAVAILABLE");
    failVideo = false;
    const ok = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body }).then(json);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.pipelineItem.videoUrl, "https://example.test/v2.mp4");
    assert.equal(ok.body.pipelineItem.imageUrl, "https://example.test/gen-1.png");
    assert.equal(ok.body.pipelineItem.activeWorkflowKey, null);
    assert.deepEqual(calls, { image: 1, video: 2 });
  }, { gate });
});

test("concurrent identical generation requests buy at most one image", opts, async () => {
  const { gate, calls } = mockGate(prisma, {
    image: async (_i, n) => { await new Promise((r) => setTimeout(r, 150)); return { imageUrl: `https://example.test/slow-${n}.png` }; },
  });
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body: { pipelineItemId: raw.id, type: "image" } }).then(json)));
    assert.equal(calls.image, 1);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.body.code === "DUPLICATE_IN_PROGRESS"));
  }, { gate });
});

test("client Idempotency-Key: retry replays, reuse elsewhere is rejected", opts, async () => {
  const { gate, calls } = mockGate(prisma);
  await withApp(async (app) => {
    const one = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const two = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const headers = { "Idempotency-Key": "ui-action-000001" };
    const first = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, headers, body: { pipelineItemId: one.id } }).then(json);
    const again = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, headers, body: { pipelineItemId: one.id } }).then(json);
    assert.equal(first.status, 200);
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(calls.image, 1);
    const reuse = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, headers, body: { pipelineItemId: two.id } }).then(json);
    assert.equal(reuse.status, 422);
    assert.equal(reuse.body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(calls.image, 1);
  }, { gate });
});

test("new media on an approved item invalidates the approval", opts, async () => {
  const { gate } = mockGate(prisma);
  await withApp(async (app) => {
    const raw = await makeReviewItem(prisma);
    await approve(app, await getItem(app, raw.id));
    const r = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body: { pipelineItemId: raw.id } }).then(json);
    assert.equal(r.status, 200);
    assert.equal(r.body.pipelineItem.stage, "content_generated");
    assert.equal(r.body.pipelineItem.approvedHash, null);
  }, { gate });
});

test("default app configuration blocks generation and records nothing", opts, () => withApp(async (app) => {
  const raw = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
  for (const type of ["image", "video"]) {
    const r = await app.call("/api/pipeline/generate-content", { method: "POST", token: TOKEN, body: { pipelineItemId: raw.id, type } }).then(json);
    assert.equal(r.body.code, "PROVIDER_NOT_APPROVED", type);
  }
  const policy = await app.call("/api/system/generation-policy", { token: TOKEN }).then((r) => r.json());
  assert.equal(policy.ledger, "memory");
  assert.equal(policy.ledgerDurable, false);
  assert.equal(await prisma.generationReservation.count(), 0);
}));

// ─── Finding 6: character IDs ────────────────────────────────

test("character IDs are unique under concurrency and after deletion", opts, () => withApp(async (app) => {
  const created = await Promise.all(Array.from({ length: 15 }, (_, i) =>
    app.call("/api/characters", { method: "POST", token: TOKEN, body: { name: `Synthetic ${i}` } }).then(json)));
  assert.ok(created.every((r) => r.status === 201), JSON.stringify(created.map((r) => r.status)));
  const ids = created.map((r) => r.body.characterId);
  assert.equal(new Set(ids).size, 15);

  // Count-based allocation would now produce INFL-015 again.
  const first = created.find((r) => r.body.characterId === "INFL-001");
  await app.call(`/api/characters/${first.body.id}`, { method: "DELETE", token: TOKEN });
  const next = await app.call("/api/characters", { method: "POST", token: TOKEN, body: { name: "After delete" } }).then(json);
  assert.equal(next.status, 201);
  assert.equal(next.body.characterId, "INFL-016");
}));

// ─── Finding 8: simulated trend discovery ────────────────────

test("trend discovery validates input and labels fixture provenance", opts, () => withApp(async (app) => {
  for (const body of [{ count: 1000 }, { count: 0 }, { count: "5" }, { count: 2.5 }, { platform: "Myspace" }, { niche: "Unknown" }]) {
    const r = await app.call("/api/pipeline/discover-trends", { method: "POST", token: TOKEN, body }).then(json);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(await prisma.trend.count(), 0);

  const ok = await app.call("/api/pipeline/discover-trends", { method: "POST", token: TOKEN, body: { platform: "Instagram", niche: "Food", count: 3 } }).then(json);
  assert.equal(ok.status, 201);
  assert.equal(ok.body.dataSource, "simulated_fixture");
  assert.equal(ok.body.trends.length, 3);
  for (const t of ok.body.trends) {
    assert.equal(t.provenance, "simulated_fixture");
    assert.match(t.source, /^fixture:/);
    assert.match(t.description, /^\[Simulated idea\]/);
  }
}));
