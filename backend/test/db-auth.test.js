import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";
import { createSessionStore, hashToken, sessionTtlMs, MAX_SESSION_TTL_HOURS } from "../src/auth/sessions.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createMemoryLedger } from "../src/services/spendLedger.js";

/** Sessions, revocation and server-side authorization (synthetic credentials only). */
const opts = { skip: skipReason };
const ENV = { OWNER_API_TOKEN: TOKEN };

let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

async function withApp(fn, extra = {}) {
  const app = await startApp({ env: { ...ENV, ...extra.env }, prisma, gate: extra.gate });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json(), headers: r.headers });
const as = (app, token, path, { method = "GET", body } = {}) =>
  app.raw(path, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
async function login(app) {
  const r = await as(app, TOKEN, "/api/auth/session", { method: "POST" });
  assert.equal(r.status, 201);
  return r.body.sessionToken;
}
async function sessionWithRole(role) {
  const { token } = await createSessionStore(prisma).create(
    { id: `synthetic-${role}`, role, workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 });
  return token;
}

test("the owner token is only a credential to exchange; API calls need a session", opts, () => withApp(async (app) => {
  const direct = await as(app, TOKEN, "/api/characters");
  assert.equal(direct.status, 401);
  assert.equal(direct.body.code, "SESSION_REQUIRED");

  const bad = await as(app, TOKEN + "x", "/api/auth/session", { method: "POST" });
  assert.equal(bad.status, 401);

  const token = await login(app);
  assert.match(token, /^ses_/);
  const me = await as(app, token, "/api/auth/me");
  assert.deepEqual({ id: me.body.principal.id, role: me.body.principal.role }, { id: "owner", role: "owner" });
  assert.equal((await as(app, token, "/api/characters")).status, 200);
}));

test("only a hash of the session token is stored", opts, () => withApp(async (app) => {
  const token = await login(app);
  const rows = await prisma.session.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tokenHash, hashToken(token));
  assert.ok(!JSON.stringify(rows).includes(token));
}));

test("expired and revoked sessions are refused; revoke-all signs out everywhere", opts, () => withApp(async (app) => {
  const a = await login(app);
  const b = await login(app);
  await prisma.session.updateMany({ where: { tokenHash: hashToken(a) }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await as(app, a, "/api/characters")).body.code, "SESSION_EXPIRED");

  assert.equal((await as(app, b, "/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await as(app, b, "/api/characters")).body.code, "SESSION_REVOKED");

  const c = await login(app);
  const d = await login(app);
  const r = await as(app, c, "/api/auth/sessions/revoke-all", { method: "POST" });
  assert.equal(r.body.revoked, 3, "c, d and the expired-but-unrevoked a");
  assert.equal((await as(app, d, "/api/characters")).body.code, "SESSION_REVOKED");
}));

test("session lifetime is capped", () => {
  assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: "100000" }), MAX_SESSION_TTL_HOURS * 3600_000);
  assert.equal(sessionTtlMs({ SESSION_TTL_HOURS: "-5" }), 12 * 3600_000);
});

test("roles are enforced on the server, and spending is its own permission", opts, async () => {
  let providerCalls = 0;
  const gate = createGenerationGate({
    env: {
      APPROVED_PROVIDER_MODELS: "higgsfield:soul", LIVE_PROVIDER_CALLS: "enabled",
      PROVIDER_PRICES_USD: JSON.stringify({ "higgsfield:soul": "1.00" }),
      SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "5", SPEND_CAP_MONTHLY_USD: "5",
    },
    ledger: createMemoryLedger({ durable: true }),
    adapters: { image: { "higgsfield:soul": { generate: async () => { providerCalls++; return { imageUrl: "https://example.test/x.png" }; } } }, video: {} },
  });
  await withApp(async (app) => {
    const item = await makeReviewItem(prisma, { stage: "draft", imageUrl: null });
    const reviewer = await sessionWithRole("reviewer");
    const editor = await sessionWithRole("editor");

    assert.equal((await as(app, reviewer, "/api/characters")).status, 200, "reviewer can read");
    const rEdit = await as(app, reviewer, "/api/characters", { method: "POST", body: { name: "x" } });
    assert.equal(rEdit.status, 403);
    assert.deepEqual(rEdit.body.details.missing, ["edit"]);

    for (const tok of [reviewer, editor]) {
      const g = await as(app, tok, "/api/pipeline/generate-content", { method: "POST", body: { pipelineItemId: item.id } });
      assert.equal(g.status, 403);
      assert.ok(g.body.details.missing.includes("spend"));
    }
    assert.equal(providerCalls, 0, "refused before any provider action");
    assert.equal((await as(app, editor, "/api/pipeline/x/approve", { method: "POST" })).status, 403, "editor cannot approve");
    assert.equal((await as(app, editor, "/api/system/generation-policy")).status, 403);
    assert.equal((await as(app, editor, "/api/auth/sessions/revoke-all", { method: "POST" })).status, 403);
    assert.equal((await as(app, reviewer, `/api/pipeline/${item.id}/reject`, { method: "POST" })).status, 409,
      "reviewer reaches the approval rules (item is a draft)");
  }, { gate });
});

test("unknown object IDs answer 404, not 500", opts, () => withApp(async (app) => {
  const t = await login(app);
  for (const p of ["/api/characters/does-not-exist", "/api/pipeline/does-not-exist", "/api/content/does-not-exist"]) {
    assert.equal((await as(app, t, p)).status, 404, p);
  }
}));

test("every response carries a correlation ID, echoed in error bodies", opts, () => withApp(async (app) => {
  const r = await json(await app.raw("/api/characters"));
  assert.match(r.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(r.body.requestId, r.headers.get("x-request-id"));
  const kept = await app.raw("/health", { headers: { "X-Request-Id": "proxy-trace-12345" } });
  assert.equal(kept.headers.get("x-request-id"), "proxy-trace-12345");
  const replaced = await app.raw("/health", { headers: { "X-Request-Id": "bad id with spaces" } });
  assert.notEqual(replaced.headers.get("x-request-id"), "bad id with spaces");
}));

test("health discloses nothing beyond health", opts, () => withApp(async (app) => {
  assert.deepEqual(await (await app.raw("/health")).json(), { status: "ok" });
}));

test("credential exchange is rate limited", opts, () => withApp(async (app) => {
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await app.raw("/api/auth/session", { method: "POST", token: "wrong" })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.deepEqual(statuses.slice(10), [429, 429]);
}));
