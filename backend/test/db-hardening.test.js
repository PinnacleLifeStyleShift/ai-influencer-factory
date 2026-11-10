import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter } from "./db-helpers.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { normalizePath } from "../src/services/audit.js";

/** Request schemas, bounded lists, safe errors and the audit trail. */
const opts = { skip: skipReason };
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

async function withApp(fn) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN }, prisma });
  try { return await fn(app); } finally { await app.close(); }
}
const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
const req = (app, path, { method = "GET", body, token = TOKEN, headers } = {}) =>
  app.call(path, { method, token, body: method === "GET" ? undefined : body ?? {}, headers }).then(json);
// Audit rows are written after the response finishes; give them a moment.
const settle = () => new Promise((r) => setTimeout(r, 150));

test("request schemas refuse bad input and list every problem", opts, () => withApp(async (app) => {
  const r = await req(app, "/api/characters", { method: "POST", body: {
    aspect_ratio: "4:3", target_platforms: ["MySpace"], follower_count: -1, engagement_rate: "lots", persona: "x".repeat(5001),
  } });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.body.details.fields).sort(),
    ["aspect_ratio", "engagement_rate", "follower_count", "name", "persona", "target_platforms"]);
  assert.match(r.body.requestId, /.+/);

  const c = await makeCharacter(prisma);
  for (const [path, body] of [
    ["/api/content", { title: "t", characterId: c.id, scheduled_date: "2026-13-45" }],
    ["/api/content", { title: "t", characterId: c.id, platform: "Friendster" }],
    ["/api/campaigns", { name: "c", payout_amount: "a lot" }],
    ["/api/campaigns", { name: "c", deadline: "next week" }],
    ["/api/characters", ["not", "an", "object"]],
  ]) {
    assert.equal((await req(app, path, { method: "POST", body })).status, 400, JSON.stringify(body));
  }
  const camp = await req(app, "/api/campaigns", { method: "POST", body: { name: "Synthetic campaign" } });
  assert.equal(camp.status, 201);
  const sub = await req(app, `/api/campaigns/${camp.body.id}/submissions`, { method: "POST",
    body: { character_id: c.id, submission_url: "https://169.254.169.254/latest" } });
  assert.equal(sub.status, 400, "unsafe submission URL refused");

  const partial = await req(app, `/api/characters/${c.id}`, { method: "PUT", body: { notes: "only notes" } });
  assert.equal(partial.status, 200, "partial update needs no required fields");
}));

test("missing records answer 404 on update and delete", opts, () => withApp(async (app) => {
  for (const [method, path, body] of [
    ["PUT", "/api/characters/missing-id", { notes: "x" }],
    ["DELETE", "/api/characters/missing-id"],
    ["PUT", "/api/content/missing-id", { notes: "x" }],
    ["DELETE", "/api/content/missing-id"],
    ["PUT", "/api/campaigns/missing-id", { brand: "x" }],
    ["DELETE", "/api/campaigns/missing-id"],
    ["DELETE", "/api/pipeline/missing-id"],
  ]) {
    const r = await req(app, path, { method, body });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.body.code, "NOT_FOUND", `${method} ${path}`);
  }
}));

test("database errors map to stable codes without leaking details", opts, () => withApp(async (app) => {
  const r = await req(app, "/api/content", { method: "POST", body: { title: "t", characterId: "no-such-character" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "VALIDATION_FAILED");
  assert.ok(!/prisma|constraint|foreign key|invocation/i.test(JSON.stringify(r.body)), JSON.stringify(r.body));
}));

test("lists are bounded", opts, () => withApp(async (app) => {
  for (let i = 0; i < 3; i++) await makeCharacter(prisma);
  assert.equal((await req(app, "/api/characters?limit=2")).body.length, 2);
  for (const bad of ["0", "501", "abc", "2.5"]) {
    assert.equal((await req(app, `/api/characters?limit=${bad}`)).status, 400, bad);
  }
}));

test("the audit trail records actor, action pattern, target and outcome, and nothing else", opts, () => withApp(async (app) => {
  const created = await req(app, "/api/characters?note=query-secret-123", { method: "POST", body: { name: "Body Secret Name 9431" } });
  assert.equal(created.status, 201);
  const reviewer = (await createSessionStore(prisma).create({ id: "synthetic-reviewer", role: "reviewer" }, { provider: "test", ttlMs: 3600_000 })).token;
  await req(app, `/api/characters/${created.body.id}`, { method: "PUT", body: { notes: "x" }, token: reviewer });
  await req(app, `/api/characters/${created.body.id}`, { method: "DELETE", token: "" });
  await app.raw("/api/auth/session", { method: "POST", token: "wrong-credential" });
  await settle();

  const rows = await prisma.auditEvent.findMany({ orderBy: { at: "asc" } });
  const dump = JSON.stringify(rows);
  for (const secret of ["Body Secret Name 9431", "query-secret-123", "wrong-credential", TOKEN]) {
    assert.ok(!dump.includes(secret), `audit must not contain ${secret}`);
  }
  const by = (action, outcome) => rows.find((r) => r.action === action && r.outcome === outcome);

  const login = by("POST /api/auth/session", "success");
  assert.equal(login.actorId, "owner");
  assert.ok(by("POST /api/auth/session", "denied"), "failed exchange recorded");

  const create = by("POST /api/characters/", "success") || by("POST /api/characters", "success");
  assert.ok(create, JSON.stringify(rows.map((r) => r.action)));
  assert.equal(create.actorRole, "owner");
  assert.equal(create.requestId, created.headers.get("x-request-id"));

  const forbidden = rows.find((r) => r.actorId === "synthetic-reviewer");
  assert.equal(forbidden.outcome, "denied");
  assert.equal(forbidden.errorCode, "FORBIDDEN");
  // Authorization is route-bound, so a denied attempt records which object it targeted.
  assert.equal(forbidden.targetId, created.body.id);
  assert.match(forbidden.action, /:id/);
  assert.ok(!forbidden.action.includes(created.body.id), "raw ids never appear in the action");

  const anon = rows.find((r) => r.action.startsWith("DELETE") && r.actorId === null);
  assert.equal(anon.status, 401);
}));

test("audit list is admin-only and newest first", opts, () => withApp(async (app) => {
  await req(app, "/api/characters", { method: "POST", body: { name: "One" } });
  await req(app, "/api/characters", { method: "POST", body: { name: "Two" } });
  await settle();
  const list = await req(app, "/api/audit-events?limit=50");
  assert.equal(list.status, 200);
  assert.ok(list.body.length >= 3);
  assert.ok(new Date(list.body[0].at) >= new Date(list.body.at(-1).at));
  const editor = (await createSessionStore(prisma).create({ id: "synthetic-editor", role: "editor" }, { provider: "test", ttlMs: 3600_000 })).token;
  assert.equal((await req(app, "/api/audit-events", { token: editor })).status, 403);
}));

test("id-like path segments are normalised", () => {
  assert.equal(normalizePath("/api/pipeline/cmw8gc5390000w07df0dao61b/approve"), "/api/pipeline/:id/approve");
  assert.equal(normalizePath("/api/characters"), "/api/characters");
});
