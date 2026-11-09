import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrismaClient } from "../src/lib/prisma.js";
import { skipReason, TEST_DB_URL } from "./db-helpers.js";

/**
 * Migration path checks on the disposable local Postgres, each in its own
 * schema: fresh database, legacy (db push at 277d2d3) database with data, a
 * legacy database that drifted, and re-runs.
 */
const opts = { skip: skipReason };

function urlFor(schema) {
  const u = new URL(TEST_DB_URL);
  u.searchParams.set("schema", schema);
  return u.toString();
}
function run(cmd, args, schema) {
  return spawnSync(cmd, args, { env: { ...process.env, DATABASE_URL: urlFor(schema) }, encoding: "utf8" });
}
const migrateDeploy = (schema) => run("node", ["scripts/migrate-deploy.mjs"], schema);
const legacyPush = (schema) => {
  const r = run("npx", ["prisma", "db", "push", "--schema", "prisma/baseline/277d2d3.schema.prisma"], schema);
  assert.equal(r.status, 0, r.stderr);
};
async function withClient(schema, fn) {
  const c = createPrismaClient(urlFor(schema));
  try { return await fn(c); } finally { await c.$disconnect(); }
}
const columns = (c, table) => c.$queryRawUnsafe(
  `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, table
).then((rows) => rows.map((r) => r.column_name));
const appliedMigrations = (c) => c.$queryRawUnsafe(
  `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`
).then((rows) => rows.map((r) => r.migration_name));
const schemaMatches = (schema) =>
  run("npx", ["prisma", "migrate", "diff", "--from-config-datasource", "--to-schema", "prisma/schema.prisma", "--exit-code"], schema).status === 0;

test("fresh database: both migrations apply and match schema.prisma", opts, async () => {
  const r = migrateDeploy("mig_fresh");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(schemaMatches("mig_fresh"));
  await withClient("mig_fresh", async (c) => {
    assert.deepEqual(await appliedMigrations(c), ["20260321000000_init", "20261108000000_phase1_safety", "20261109000000_generation_fencing", "20261110000000_sessions", "20261110010000_audit_events"]);
  });
  const again = migrateDeploy("mig_fresh");
  assert.equal(again.status, 0, "re-running is a no-op");
});

test("legacy db-push database: verified baseline, data preserved, new columns added", opts, async () => {
  legacyPush("mig_legacy");
  await withClient("mig_legacy", async (c) => {
    await c.$executeRawUnsafe(`INSERT INTO characters (id, character_id, name, updated_at) VALUES ('ch1', 'INFL-001', 'Synthetic Legacy', now())`);
    await c.$executeRawUnsafe(`INSERT INTO content (id, title, status, character_id, updated_at) VALUES ('ct1', 'Legacy row', 'scheduled', 'ch1', now())`);
    await c.$executeRawUnsafe(`INSERT INTO pipeline_items (id, stage, character_id, updated_at) VALUES ('p1', 'approved', 'ch1', now())`);
  });

  const r = migrateDeploy("mig_legacy");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /schema verified identical/);
  assert.ok(schemaMatches("mig_legacy"));

  await withClient("mig_legacy", async (c) => {
    assert.deepEqual(await appliedMigrations(c), ["20260321000000_init", "20261108000000_phase1_safety", "20261109000000_generation_fencing", "20261110000000_sessions", "20261110010000_audit_events"]);
    const [ch] = await c.$queryRawUnsafe(`SELECT name, image_generations FROM characters WHERE id = 'ch1'`);
    assert.equal(ch.name, "Synthetic Legacy");
    assert.equal(ch.image_generations, 0);
    const [ct] = await c.$queryRawUnsafe(`SELECT title, status, schedule_key FROM content WHERE id = 'ct1'`);
    assert.deepEqual({ ...ct }, { title: "Legacy row", status: "scheduled", schedule_key: null });
    const [p] = await c.$queryRawUnsafe(`SELECT stage, revision, approved_hash FROM pipeline_items WHERE id = 'p1'`);
    assert.equal(p.stage, "approved");
    assert.equal(p.revision, 1);
    assert.equal(p.approved_hash, null, "legacy approvals carry no hash, so they cannot be scheduled without re-approval");
  });
  assert.equal(migrateDeploy("mig_legacy").status, 0, "re-running is a no-op");
});

test("legacy database that drifted from the baseline is refused and left untouched", opts, async () => {
  legacyPush("mig_drift");
  await withClient("mig_drift", async (c) => {
    await c.$executeRawUnsafe(`ALTER TABLE characters ADD COLUMN manual_extra TEXT`);
  });
  const r = migrateDeploy("mig_drift");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED/);
  await withClient("mig_drift", async (c) => {
    const [row] = await c.$queryRawUnsafe(`SELECT to_regclass('_prisma_migrations') IS NOT NULL AS has_history`);
    assert.equal(row.has_history, false, "no migration history written");
    const cols = await columns(c, "characters");
    assert.ok(cols.includes("manual_extra"));
    assert.ok(!cols.includes("image_generations"), "no migration applied");
  });
});

test("no deploy path still uses prisma db push", opts, async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const [name, cmd] of Object.entries(pkg.scripts)) assert.ok(!/db push/.test(cmd), `script ${name}`);
  assert.ok(!/db push/.test(readFileSync("Dockerfile", "utf8")));
});
