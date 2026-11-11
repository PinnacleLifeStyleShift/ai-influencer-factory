import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb } from "./db-helpers.js";
import { createInviteService } from "../src/auth/invites.js";
import { createSessionStore } from "../src/auth/sessions.js";

/**
 * Review finding IF-CR01 (11 November 2026): revocation raced session
 * issuance. redeem() claimed the invite, revoke() then ended only sessions
 * that already existed, and the session created afterwards stayed active.
 * Two real PostgreSQL connections; synthetic labels; no network.
 */
const opts = { skip: skipReason, timeout: 60_000 };
const TTL = 3600_000;
let a; let b; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) { a = newClient(); b = newClient(); } });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await a?.$disconnect(); await b?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(a); });

const issue = (prisma, role = "editor") => createInviteService(prisma).create({ role, label: "Synthetic" }, { by: "owner" });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test("the reported interleaving (claim, revoke, create session) leaves no usable session", opts, async () => {
  const { code, invite } = await issue(a);
  const sessions = createSessionStore(a);
  // The pre-fix sequence, step by step, as the review reproduced it.
  const principal = await createInviteService(a).redeem(code);
  assert.ok(principal, "claimed");
  await createInviteService(b).revoke(invite.id);
  const { token } = await sessions.create(principal, { provider: "role-invite", ttlMs: TTL });
  assert.notEqual((await sessions.lookup(token)).status, "active", "a session for a revoked invite must not authenticate");
});

test("revocation while enrollment is paused after the claim: the session never authenticates", opts, async () => {
  const { code, invite } = await issue(a);
  const claimed = deferred(); const release = deferred();
  const enrolling = createInviteService(a).enroll(code, {
    sessions: createSessionStore(a), ttlMs: TTL,
    hooks: { afterClaim: async () => { claimed.resolve(); await release.promise; } },
  });
  await claimed.promise;
  const revoking = createInviteService(b).revoke(invite.id); // second connection, races the open enrollment
  await new Promise((r) => setTimeout(r, 200));
  release.resolve();
  const [enrolled, revoked] = await Promise.all([enrolling, revoking]);
  if (enrolled) {
    assert.equal(revoked.sessionsRevoked, 1, "revocation waited for the enrollment and ended its session");
    assert.notEqual((await createSessionStore(a).lookup(enrolled.token)).status, "active");
  }
  assert.equal(await a.session.count({ where: { principalId: `invite:${invite.id}`, revokedAt: null } }), 0, "no active session after revocation");
});

test("a failed session write does not consume the invite; a retry enrolls exactly once", opts, async () => {
  const { code, invite } = await issue(a);
  const failing = await createInviteService(a).enroll(code, {
    sessions: createSessionStore(a), ttlMs: TTL,
    hooks: { afterClaim: async () => { throw new Error("synthetic session write failure"); } },
  }).catch((e) => e);
  assert.match(String(failing?.message), /synthetic session write failure/);
  const row = await a.roleInvite.findUnique({ where: { id: invite.id } });
  assert.equal(row.usedAt, null, "rolled back: still usable");
  assert.equal(await a.session.count(), 0);

  const ok = await createInviteService(a).enroll(code, { sessions: createSessionStore(a), ttlMs: TTL });
  assert.equal(ok.principal.role, "editor");
  assert.equal((await createSessionStore(a).lookup(ok.token)).status, "active");
  assert.equal(await createInviteService(b).enroll(code, { sessions: createSessionStore(b), ttlMs: TTL }), null, "single use");
  assert.equal(await a.session.count(), 1);
});

test("simultaneous enrollments on two connections create at most one session", opts, async () => {
  const { code } = await issue(a);
  const results = await Promise.all([
    createInviteService(a).enroll(code, { sessions: createSessionStore(a), ttlMs: TTL }),
    createInviteService(b).enroll(code, { sessions: createSessionStore(b), ttlMs: TTL }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await a.session.count(), 1);
});

test("expiry is decided at enrollment time, inside the locked transaction", opts, async () => {
  const { code, invite } = await issue(a);
  const expiresAt = (await a.roleInvite.findUnique({ where: { id: invite.id } })).expiresAt;
  // The clock read at the authoritative check is past the expiry.
  const late = createInviteService(a, { now: () => new Date(expiresAt.getTime() + 1) });
  assert.equal(await late.enroll(code, { sessions: createSessionStore(a), ttlMs: TTL }), null);
  assert.equal(await a.session.count(), 0);
  assert.equal((await a.roleInvite.findUnique({ where: { id: invite.id } })).usedAt, null, "an expired invite is not marked used");
});
