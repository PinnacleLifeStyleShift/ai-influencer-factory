import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startApp, TOKEN, interceptExternalFetch } from "./helpers.js";
import { skipReason, newClient, resetDb, makeCharacter, makeReviewItem } from "./db-helpers.js";
import { createApp } from "../src/app.js";
import { createSessionStore } from "../src/auth/sessions.js";
import { createGenerationGate } from "../src/services/generationGate.js";
import { createPrismaLedger } from "../src/services/spendLedger.js";
import { PERMISSION_DECLARATION } from "../src/auth/permissions.js";
import { secureRouter } from "../src/lib/secureRouter.js";

/**
 * Package 1 (10 Nov spec): route-bound authorization.
 *
 * Release blocker reproduced before the fix: an editor denied at
 * POST /characters/:id/generate-image reached the handler through
 * "/generate-image/" or "/GENERATE-IMAGE" (rights approval, reconciliation
 * and campaign money had the same gap). Every variant below must now either
 * reach the same authorized operation or be rejected, and a rejected request
 * must change nothing: no row, no reservation, no provider call, no approval.
 */
const opts = { skip: skipReason, timeout: 120_000 };
let prisma; let net;
before(() => { net = interceptExternalFetch(); if (!skipReason) prisma = newClient(); });
after(async () => { net.restore(); assert.equal(net.calls.length, 0, "no outbound calls"); await prisma?.$disconnect(); });
beforeEach(async () => { if (!skipReason) await resetDb(prisma); });

// ─── Every registered route carries a declaration ──────────────

function routes(stack, prefix = "") {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        out.push({ method: method.toUpperCase(), path: prefix + layer.route.path, first: layer.route.stack[0]?.handle });
      }
    } else if (layer.handle?.stack) {
      const mount = layer.regexp?.source.replace(/^\^\\?/, "").replace(/\\\/\?\(\?=\\\/\|\$\)$/i, "").replace(/\\\//g, "/").replace(/\(\?=.*$/, "").replace(/\/\?$/, "") || "";
      out.push(...routes(layer.handle.stack, prefix + (mount.startsWith("/") ? mount : `/${mount}`).replace(/\/$/, "")));
    }
  }
  return out;
}
const PUBLIC = new Set(["GET /", "GET /health", "GET /ready", "POST /api/auth/session"]);

test("every route has a permission declaration; mutations never default to read", () => {
  const app = createApp({ prisma: {}, env: {}, logRequests: false });
  const all = routes(app._router.stack);
  assert.ok(all.length > 60, `found ${all.length} routes`);
  const undeclared = all.filter((r) => !PUBLIC.has(`${r.method} ${r.path}`) && !r.first?.[PERMISSION_DECLARATION]);
  assert.deepEqual(undeclared.map((r) => `${r.method} ${r.path}`), [], "routes without a declaration");
  const readOnlyMutations = all.filter((r) => r.method !== "GET" && JSON.stringify(r.first?.[PERMISSION_DECLARATION]) === '["read"]');
  assert.deepEqual(readOnlyMutations, []);
  const decl = (m, p) => all.find((r) => r.method === m && r.path === p)?.first?.[PERMISSION_DECLARATION];
  assert.deepEqual(decl("POST", "/api/characters/:id/generate-image"), ["generate", "spend"]);
  assert.deepEqual(decl("POST", "/api/character-images/:imageId/rights/approve"), ["admin"]);
  assert.deepEqual(decl("POST", "/api/auth/sessions/revoke-all"), ["admin"]);
  assert.deepEqual(decl("POST", "/api/generation-jobs/steps/:stepId/resolve"), ["admin"]);
});

test("a mutation without a declaration cannot be registered", () => {
  const r = secureRouter();
  assert.throws(() => r.post("/x", () => {}), /no permission declaration/);
  assert.throws(() => r.delete("/x", () => {}), /no permission declaration/);
  assert.throws(() => r.post("/x", ["superuser"], () => {}), /Unknown permission/);
  assert.doesNotThrow(() => r.get("/x", () => {}));
});

// ─── Variant matrix against the mounted application ────────────

const GATE_ENV = {
  IMAGE_PROVIDER: "mock:image", APPROVED_PROVIDER_MODELS: "mock:image", LIVE_PROVIDER_CALLS: "enabled",
  PROVIDER_PRICES_USD: JSON.stringify({ "mock:image": "1.00" }), SPEND_CAP_PER_JOB_USD: "5", SPEND_CAP_DAILY_USD: "100",
  SPEND_CAP_MONTHLY_USD: "100", PRICE_CURRENCY: "USD", PRICE_VERSION: "test-fixture-v1", SPEND_CAP_TIMEZONE: "UTC",
};
const TABLES = ["characters", "character_images", "rights_records", "generation_reservations", "generation_jobs", "pipeline_items", "sessions", "campaign_invoices", "role_invites"];

async function snapshot() {
  const rows = {};
  for (const t of TABLES) rows[t] = Number((await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${t}"`))[0].n);
  rows.revokedSessions = await prisma.session.count({ where: { revokedAt: { not: null } } });
  rows.approvedRights = await prisma.rightsRecord.count({ where: { approvedAt: { not: null } } });
  rows.approvedItems = await prisma.pipelineItem.count({ where: { stage: "approved" } });
  rows.charactersUpdated = (await prisma.character.findMany({ select: { updatedAt: true } })).map((c) => c.updatedAt.getTime()).sort().join(",");
  return rows;
}

/** Variants of one operation (path is canonical, without /api). */
function variants(method, path) {
  const last = path.split("/").pop();
  const upper = path.replace(last, last.toUpperCase());
  const mixed = path.replace(last, last[0].toUpperCase() + last.slice(1));
  const encoded = path.replace(last, last.replace(/-/g, "%2D").replace(/^(.)/, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`));
  return [
    ["canonical", method, `/api${path}`],
    ["trailing slash", method, `/api${path}/`],
    ["upper case", method, `/api${upper}`],
    ["mixed case", method, `/api${mixed}`],
    ["mixed-case mount", method, `/API${path}`],
    ["encoded segment", method, `/api${encoded}`],
    ["repeated separator", method, `/api/${path.replace(/^\//, "/")}`],
    ["double inner separator", method, `/api${path.replace(/\/([^/]+)$/, "//$1")}`],
    ["malformed escape", method, `/api${path.replace(last, `${last}%E0%A4%A`)}`],
    ["HEAD", "HEAD", `/api${path}`],
    ["OPTIONS", "OPTIONS", `/api${path}`],
    ["wrong method", method === "GET" ? "DELETE" : "GET", `/api${path}`],
  ];
}

test("denied roles and sessions never reach a protected operation through any URL variant", opts, async () => {
  let providerCalls = 0;
  const gate = createGenerationGate({
    env: GATE_ENV, ledger: createPrismaLedger(prisma), log: { error() {}, info() {} },
    adapters: { image: { "mock:image": { capabilities: {}, generate: async () => { providerCalls++; return { imageUrl: "https://example.test/x.png" }; } } }, video: {} },
  });
  // ROLE_INVITES on, so invite denials are proven by role, not by the switch.
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, API_RATE_LIMIT_PER_MIN: "100000", GENERATION_RATE_LIMIT_PER_MIN: "100000", ROLE_INVITES: "enabled", ...GATE_ENV }, prisma, gate });
  try {
    const character = await makeCharacter(prisma);
    const image = await prisma.characterImage.create({ data: { characterId: character.id, imageUrl: "https://example.test/ref.png", status: "candidate", source: "manual", fingerprint: "a".repeat(64) } });
    await prisma.rightsRecord.create({ data: { imageId: image.id, basis: "owned_original", holder: "Synthetic", permittedUses: ["provider_input"], recordedBy: "owner" } });
    const item = await makeReviewItem(prisma);
    const camp = await prisma.campaign.create({ data: { name: "Synthetic" } });

    const store = createSessionStore(prisma);
    const session = async (role, mutate) => {
      const { token, session: s } = await store.create({ id: `synthetic-${role}`, role, workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 });
      if (mutate) await prisma.session.update({ where: { id: s.id }, data: mutate });
      return token;
    };
    const tokens = {
      editor: await session("editor"),
      reviewer: await session("reviewer"),
      expired: await session("owner", { expiresAt: new Date(Date.now() - 1000) }),
      revoked: await session("owner", { revokedAt: new Date() }),
      absent: null,
    };
    // [operation, method, path, body, roles that must be denied]
    const ops = [
      ["generate image", "POST", `/characters/${character.id}/generate-image`, {}, ["editor", "reviewer"]],
      ["generate content", "POST", "/pipeline/generate-content", { pipelineItemId: item.id }, ["editor", "reviewer"]],
      ["approve rights", "POST", `/character-images/${image.id}/rights/approve`, {}, ["editor", "reviewer"]],
      ["revoke all sessions", "POST", "/auth/sessions/revoke-all", {}, ["editor", "reviewer"]],
      ["issue invite", "POST", "/auth/invites", { role: "editor", label: "Synthetic" }, ["editor", "reviewer"]],
      ["revoke invite", "POST", "/auth/invites/missing/revoke", {}, ["editor", "reviewer"]],
      ["resolve job step", "POST", "/generation-jobs/steps/missing/resolve", { resolution: "not_charged", evidence: "x".repeat(12) }, ["editor", "reviewer"]],
      ["record invoice", "POST", `/campaigns/${camp.id}/invoices`, { number: "I-1", amount: "1", currency: "USD", issuedAt: "2026-11-01" }, ["editor", "reviewer"]],
      ["approve content", "POST", `/pipeline/${item.id}/approve`, { revision: item.revision, snapshotHash: "x" }, ["editor"]],
      ["edit character", "PUT", `/characters/${character.id}`, { notes: "changed" }, ["reviewer"]],
    ];
    const before = await snapshot();
    const leaks = [];
    for (const [name, method, path, body, deniedRoles] of ops) {
      for (const who of [...deniedRoles, "expired", "revoked", "absent"]) {
        for (const [variant, m, url] of variants(method, path)) {
          const r = await app.raw(url, { method: m, token: tokens[who], body: ["GET", "HEAD", "OPTIONS"].includes(m) ? undefined : body });
          const text = m === "HEAD" ? "" : await r.text();
          // Allowed outcomes for a denied caller: 401/403 (refused), 404/405 (no such
          // route), 400 (malformed URL), or the automatic OPTIONS answer (no handler runs).
          // A GET/HEAD on the same URL is a different, read-only operation that
          // read-capable roles may use (the snapshot below proves nothing changed).
          const readRoute = ["GET", "HEAD"].includes(m) && ["editor", "reviewer"].includes(who) && r.status === 200;
          const ok = readRoute || [400, 401, 403, 404, 405].includes(r.status) || (m === "OPTIONS" && r.status === 200 && !/"success"/.test(text));
          if (!ok) leaks.push(`${who} ${name} [${variant}] ${m} ${url} -> ${r.status} ${text.slice(0, 80)}`);
        }
      }
    }
    assert.deepEqual(leaks, [], "a denied caller reached an operation");
    assert.deepEqual(await snapshot(), before, "denied requests changed nothing");
    assert.equal(providerCalls, 0, "no provider call");
  } finally { await app.close(); }
});

test("the owner reaches each operation only at its canonical URL; variants are rejected", opts, async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, API_RATE_LIMIT_PER_MIN: "100000" }, prisma });
  try {
    const character = await makeCharacter(prisma);
    const image = await prisma.characterImage.create({ data: { characterId: character.id, imageUrl: "https://example.test/ref.png", status: "candidate", source: "manual", fingerprint: "b".repeat(64) } });
    const rec = await prisma.rightsRecord.create({ data: { imageId: image.id, basis: "owned_original", holder: "Synthetic", permittedUses: ["provider_input"], recordedBy: "owner" } });
    const call = (method, url, body) => app.call(url, { method, token: TOKEN, body });
    for (const [variant, m, url] of variants("POST", `/character-images/${image.id}/rights/approve`)) {
      const r = await call(m, url, ["GET", "HEAD", "OPTIONS"].includes(m) ? undefined : { recordId: rec.id });
      if (variant === "canonical") assert.equal(r.status, 200, `canonical: ${await r.text()}`);
      else assert.ok([400, 404, 405].includes(r.status) || (m === "OPTIONS" && r.status === 200), `${variant} ${m} ${url} -> ${r.status} ${await r.text()}`);
    }
    assert.equal(await prisma.rightsRecord.count({ where: { approvedAt: { not: null } } }), 1, "approved exactly once, by the canonical request");
    // Reads stay readable (GET implies HEAD) for any signed-in role.
    const reviewer = (await createSessionStore(prisma).create({ id: "r", role: "reviewer", workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;
    assert.equal((await app.raw("/api/characters", { token: reviewer })).status, 200);
    assert.equal((await app.raw("/api/characters", { method: "HEAD", token: reviewer })).status, 200);
    assert.equal((await app.raw("/api/audit-events", { token: reviewer })).status, 403, "admin reads stay admin-only");
  } finally { await app.close(); }
});

test("rate limiting is independent of role enforcement", opts, async () => {
  const app = await startApp({ env: { OWNER_API_TOKEN: TOKEN, GENERATION_RATE_LIMIT_PER_MIN: "2" }, prisma });
  try {
    const character = await makeCharacter(prisma);
    const editor = (await createSessionStore(prisma).create({ id: "e", role: "editor", workspaceId: "default" }, { provider: "test", ttlMs: 3600_000 })).token;
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await app.raw(`/api/characters/${character.id}/generate-image`, { method: "POST", token: editor, body: {} })).status);
    // The limiter counts before authorization: an editor is refused (403) and then limited (429).
    assert.deepEqual(statuses, [403, 403, 429, 429]);
  } finally { await app.close(); }
});
