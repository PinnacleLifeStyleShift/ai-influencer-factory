import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, fakePrisma, interceptExternalFetch } from "./helpers.js";

let net;
before(() => { net = interceptExternalFetch(); });
after(() => { net.restore(); assert.equal(net.calls.length, 0, "no external network calls"); });

const ENV = { OWNER_API_TOKEN: TOKEN };
const seed = () => fakePrisma({
  characters: [{ id: "c1", name: "Synthetic Test Character", aspectRatio: "9:16", referenceImageUrl: "https://example.test/ref.png" }],
  content: [{ id: "k1", title: "Synthetic", status: "scheduled" }],
  pipelineItems: [
    { id: "p-draft", stage: "draft", characterId: "c1" },
    { id: "p-review", stage: "review", characterId: "c1" },
  ],
});

test("generation is blocked by default with no provider call and no DB write", async () => {
  const prisma = seed();
  const app = await startApp({ env: ENV, prisma });
  try {
    const img = await app.call("/api/characters/c1/generate-image", { method: "POST", body: {}, token: TOKEN });
    assert.equal(img.status, 403);
    assert.equal((await img.json()).code, "PROVIDER_NOT_APPROVED");

    const vid = await app.call("/api/characters/c1/generate-video", { method: "POST", body: {}, token: TOKEN });
    assert.equal(vid.status, 503);
    assert.equal((await vid.json()).code, "PROVIDER_NOT_SELECTED");

    const pipe = await app.call("/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: "p-draft", type: "image" }, token: TOKEN });
    assert.equal(pipe.status, 403);

    assert.ok(!prisma.calls.some((c) => c.endsWith(".update")), "reference image not overwritten");
    assert.equal(prisma.db.character.get("c1").referenceImageUrl, "https://example.test/ref.png");
  } finally { await app.close(); }
});

test("generation policy endpoint reports the gate without secrets", async () => {
  const app = await startApp({ env: { ...ENV, HIGGSFIELD_API_KEY: "synthetic-should-not-appear" } });
  try {
    const res = await app.call("/api/system/generation-policy", { token: TOKEN });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes("synthetic-should-not-appear"));
    const body = JSON.parse(text);
    assert.equal(body.liveCallsEnabled, false);
    assert.equal(body.automaticFallback, false);
    assert.equal(body.selection.image, "higgsfield:soul");
  } finally { await app.close(); }
});

test("content cannot be marked published without a publisher", async () => {
  const prisma = seed();
  const app = await startApp({ env: ENV, prisma });
  try {
    const put = await app.call("/api/content/k1", { method: "PUT", body: { status: "published" }, token: TOKEN });
    assert.equal(put.status, 409);
    assert.equal((await put.json()).code, "PUBLISHING_NOT_ENABLED");
    assert.equal(prisma.db.content.get("k1").status, "scheduled");

    const post = await app.call("/api/content", { method: "POST", body: { title: "t", status: "published" }, token: TOKEN });
    assert.equal(post.status, 409);

    const weird = await app.call("/api/content/k1", { method: "PUT", body: { status: "viral" }, token: TOKEN });
    assert.equal(weird.status, 400);

    const ok = await app.call("/api/content/k1", { method: "PUT", body: { status: "draft" }, token: TOKEN });
    assert.equal(ok.status, 200);
  } finally { await app.close(); }
});

test("approval requires review stage; reject requires reviewable stage", async () => {
  const prisma = seed();
  const app = await startApp({ env: ENV, prisma });
  try {
    const bad = await app.call("/api/pipeline/p-draft/approve", { method: "POST", body: {}, token: TOKEN });
    assert.equal(bad.status, 409);
    assert.equal((await bad.json()).code, "INVALID_TRANSITION");
    assert.equal(prisma.db.pipelineItem.get("p-draft").stage, "draft");

    const rejectDraft = await app.call("/api/pipeline/p-draft/reject", { method: "POST", body: {}, token: TOKEN });
    assert.equal(rejectDraft.status, 409);

    const good = await app.call("/api/pipeline/p-review/approve", { method: "POST", body: {}, token: TOKEN });
    assert.equal(good.status, 200);
    assert.equal(prisma.db.pipelineItem.get("p-review").stage, "approved");

    const missing = await app.call("/api/pipeline/nope/approve", { method: "POST", body: {}, token: TOKEN });
    assert.equal(missing.status, 404);
  } finally { await app.close(); }
});

test("oversized and malformed bodies are rejected", async () => {
  const app = await startApp({ env: ENV });
  try {
    const big = await app.call("/api/content", { method: "POST", body: { notes: "x".repeat(200_000) }, token: TOKEN });
    assert.equal(big.status, 413);
    const bad = await app.call("/api/content", { method: "POST", body: "{not json", token: TOKEN });
    assert.equal(bad.status, 400);
  } finally { await app.close(); }
});

test("generation routes are rate limited", async () => {
  const app = await startApp({ env: { ...ENV, GENERATION_RATE_LIMIT_PER_MIN: "3" }, prisma: seed() });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const r = await app.call("/api/characters/c1/generate-image", { method: "POST", body: {}, token: TOKEN });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [403, 403, 403, 429, 429]);
  } finally { await app.close(); }
});
