import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeReviewItem } from "./db-helpers.js";

/**
 * Two-role sign-in (spec of 11 November 2026, IF01 and workspace step 2).
 * The owner issues a single-use, expiring invite for an editor or reviewer;
 * it is exchanged at the same POST /api/auth/session for a session with that
 * role. Off unless ROLE_INVITES=enabled (issuing credentials is an owner
 * decision). Synthetic labels; disposable Postgres; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

const json = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
async function withApp(fn, env = { ROLE_INVITES: "enabled" }) {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, ...env }, prisma });
  const owner = (p, method = "GET", body) => app.call(p, { method, token: TOKEN, body: method === "GET" ? undefined : body ?? {} }).then(json);
  const as = (token, p, method = "GET", body) => app.raw(p, { method, token, body: method === "GET" ? undefined : body ?? {} }).then(json);
  const exchange = (code) => app.raw("/api/auth/session", { method: "POST", token: code }).then(json);
  try { return await fn({ app, owner, as, exchange }); } finally { await app.close(); }
}

test("invites are off by default and say so", opts, () => withApp(async ({ owner }) => {
  const r = await owner("/api/auth/invites", "POST", { role: "editor", label: "Synthetic editor" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "ROLE_INVITES_DISABLED");
  assert.equal(await prisma.roleInvite.count(), 0);
}, {}));

test("an editor invite signs in once as editor; the code is never stored or listed", opts, () => withApp(async ({ owner, as, exchange }) => {
  const created = await owner("/api/auth/invites", "POST", { role: "editor", label: "Synthetic editor", ttlHours: 2 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { code, invite } = created.body;
  assert.ok(typeof code === "string" && code.length >= 32);
  assert.equal(invite.role, "editor");
  assert.ok(!JSON.stringify(await prisma.roleInvite.findMany()).includes(code), "only a hash is stored");
  assert.ok(!JSON.stringify((await owner("/api/auth/invites")).body).includes(code), "the listing never shows the code");

  const s = await exchange(code);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual([s.body.principal.role, s.body.principal.id], ["editor", `invite:${invite.id}`]);
  assert.equal((await as(s.body.sessionToken, "/api/auth/me")).body.principal.role, "editor");
  assert.equal((await exchange(code)).status, 401, "single use");
  assert.ok(!JSON.stringify(await prisma.auditEvent.findMany()).includes(code), "the code is not in the audit trail");

  // An editor cannot issue invites (admin) or approve (approve).
  assert.equal((await as(s.body.sessionToken, "/api/auth/invites", "POST", { role: "editor", label: "x" })).status, 403);
  const item = await makeReviewItem(prisma);
  const it = (await owner(`/api/pipeline/${item.id}`)).body;
  const denied = await as(s.body.sessionToken, `/api/pipeline/${item.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash });
  assert.equal(denied.status, 403);
  assert.equal((await prisma.pipelineItem.findUnique({ where: { id: item.id } })).stage, "review", "denied: nothing changed");
}));

test("a reviewer can approve but not edit; revoking the invite ends its session", opts, () => withApp(async ({ owner, as, exchange }) => {
  const { code, invite } = (await owner("/api/auth/invites", "POST", { role: "reviewer", label: "Synthetic reviewer" })).body;
  const token = (await exchange(code)).body.sessionToken;
  const item = await makeReviewItem(prisma);
  const it = (await owner(`/api/pipeline/${item.id}`)).body;
  assert.equal((await as(token, `/api/pipeline/${item.id}/approve`, "POST", { revision: it.revision, snapshotHash: it.snapshotHash })).status, 200);
  assert.equal((await as(token, "/api/pipeline/generate-script", "POST", { characterId: item.characterId })).status, 403, "reviewer cannot edit");

  const revoked = await owner(`/api/auth/invites/${invite.id}/revoke`, "POST", {});
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  assert.equal(revoked.body.sessionsRevoked, 1);
  assert.equal((await as(token, "/api/auth/me")).status, 401, "the session it created no longer works");
}));

test("invites cannot create owners, outlive 72 hours, or be used after expiry or revocation", opts, () => withApp(async ({ owner, exchange }) => {
  assert.equal((await owner("/api/auth/invites", "POST", { role: "owner", label: "Escalation" })).body.code, "VALIDATION_FAILED");
  assert.equal((await owner("/api/auth/invites", "POST", { role: "editor", label: "Long", ttlHours: 73 })).body.code, "VALIDATION_FAILED");
  assert.equal((await owner("/api/auth/invites", "POST", { role: "editor", label: "x", extra: true })).body.code, "UNKNOWN_FIELDS");

  const expiring = (await owner("/api/auth/invites", "POST", { role: "editor", label: "Expiring" })).body;
  await prisma.roleInvite.update({ where: { id: expiring.invite.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await exchange(expiring.code)).status, 401);

  const unused = (await owner("/api/auth/invites", "POST", { role: "reviewer", label: "Unused" })).body;
  await owner(`/api/auth/invites/${unused.invite.id}/revoke`, "POST", {});
  assert.equal((await exchange(unused.code)).status, 401);
  assert.equal(await prisma.session.count({ where: { principalId: { startsWith: "invite:" } } }), 0);
}));

test("two simultaneous exchanges of one code create exactly one session", opts, () => withApp(async ({ owner, exchange }) => {
  const { code } = (await owner("/api/auth/invites", "POST", { role: "editor", label: "Race" })).body;
  const results = await Promise.all([exchange(code), exchange(code), exchange(code)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 401, 401]);
  assert.equal(await prisma.session.count({ where: { principalId: { startsWith: "invite:" } } }), 1);
}));
