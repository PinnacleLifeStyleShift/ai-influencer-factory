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
    assert.deepEqual(await appliedMigrations(c), ["20260321000000_init", "20261108000000_phase1_safety", "20261109000000_generation_fencing", "20261110000000_sessions", "20261110010000_audit_events", "20261110020000_character_versions_rights", "20261110030000_content_packages", "20261110040000_generation_jobs", "20261110050000_review_calendar_export", "20261110060000_publishing", "20261110070000_measurement", "20261110080000_sponsor_authorization", "20261110090000_reconciliation_revisions", "20261110100000_rights_revocation", "20261110110000_asset_versions", "20261110120000_system_controls", "20261111000000_metric_revisions", "20261111010000_asset_lineage"]);
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
    assert.deepEqual(await appliedMigrations(c), ["20260321000000_init", "20261108000000_phase1_safety", "20261109000000_generation_fencing", "20261110000000_sessions", "20261110010000_audit_events", "20261110020000_character_versions_rights", "20261110030000_content_packages", "20261110040000_generation_jobs", "20261110050000_review_calendar_export", "20261110060000_publishing", "20261110070000_measurement", "20261110080000_sponsor_authorization", "20261110090000_reconciliation_revisions", "20261110100000_rights_revocation", "20261110110000_asset_versions", "20261110120000_system_controls", "20261111000000_metric_revisions", "20261111010000_asset_lineage"]);
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

// Production's first deploy: the db-push database already had an empty
// _prisma_migrations table, so the baseline check was skipped and
// `prisma migrate deploy` tried the baseline on top of the existing tables
// (42P07 "relation already exists"), recording a failed attempt.
async function legacyWithFailedBaseline(schema, { emptyHistory = false } = {}) {
  legacyPush(schema);
  await withClient(schema, (c) => c.$executeRawUnsafe(
    `INSERT INTO characters (id, character_id, name, updated_at) VALUES ('ch1', 'INFL-001', 'Synthetic Legacy', now())`));
  // The empty history table, as `prisma migrate deploy` creates it when run
  // with no migrations (the old revision had a db:migrate script).
  await withClient(schema, (c) => c.$executeRawUnsafe(`CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL, "checksum" VARCHAR(64) NOT NULL, "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL, "logs" TEXT, "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "applied_steps_count" INTEGER NOT NULL DEFAULT 0)`));
  const raw = run("npx", ["prisma", "migrate", "deploy"], schema);
  assert.notEqual(raw.status, 0);
  assert.match(raw.stdout + raw.stderr, /already exists/);
  if (emptyHistory) await withClient(schema, (c) => c.$executeRawUnsafe(`DELETE FROM _prisma_migrations`));
}

for (const emptyHistory of [false, true]) {
  test(`legacy database with ${emptyHistory ? "an empty migration history" : "a failed baseline attempt"} is verified, then recovered`, opts, async () => {
    const schema = emptyHistory ? "mig_empty_history" : "mig_failed_init";
    await legacyWithFailedBaseline(schema, { emptyHistory });
    const r = migrateDeploy(schema);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /schema verified identical/);
    if (!emptyHistory) assert.match(r.stdout, /marked rolled back/);
    assert.ok(schemaMatches(schema));
    await withClient(schema, async (c) => {
      assert.equal((await appliedMigrations(c)).length, 18);
      const [ch] = await c.$queryRawUnsafe(`SELECT name FROM characters WHERE id = 'ch1'`);
      assert.equal(ch.name, "Synthetic Legacy");
    });
    assert.equal(migrateDeploy(schema).status, 0, "re-running is a no-op");
  });
}

test("a drifted legacy database with an empty or failed history is still refused and left untouched", opts, async () => {
  await legacyWithFailedBaseline("mig_failed_drift");
  await withClient("mig_failed_drift", (c) => c.$executeRawUnsafe(`ALTER TABLE characters ADD COLUMN manual_extra TEXT`));
  const r = migrateDeploy("mig_failed_drift");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED/);
  await withClient("mig_failed_drift", async (c) => {
    assert.deepEqual(await appliedMigrations(c), []);
    assert.ok(!(await columns(c, "characters")).includes("image_generations"), "no migration applied");
  });
});

test("no deploy path still uses prisma db push", opts, async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  for (const [name, cmd] of Object.entries(pkg.scripts)) assert.ok(!/db push/.test(cmd), `script ${name}`);
  assert.ok(!/db push/.test(readFileSync("Dockerfile", "utf8")));
});

// ─── Release gates (owner's project prompt: migration, deployment, rollback) ──

test("a partially applied (failed) migration blocks the deploy; the documented recovery restores the exact schema", opts, async () => {
  const schema = "mig_partial";
  assert.equal(migrateDeploy(schema).status, 0);
  // Simulate the last migration failing halfway: one of its two ALTERs ran,
  // and Prisma's history shows it failed (no finish time).
  await withClient(schema, async (c) => {
    await c.$executeRawUnsafe(`ALTER TABLE "rights_records" DROP COLUMN "revoke_reason", DROP COLUMN "revoked_at"`);
    await c.$executeRawUnsafe(`UPDATE _prisma_migrations SET finished_at = NULL, logs = 'synthetic failure' WHERE migration_name = '20261110100000_rights_revocation'`);
  });
  const blocked = migrateDeploy(schema);
  assert.notEqual(blocked.status, 0, "a failed migration must stop the deploy (the server never starts on it)");
  assert.match(blocked.stdout + blocked.stderr, /P3009|failed migrations/i);

  // Recovery (runbook): undo the partial change, mark it rolled back, deploy again.
  const naive = run("npx", ["prisma", "migrate", "resolve", "--rolled-back", "20261110100000_rights_revocation"], schema);
  assert.equal(naive.status, 0, naive.stderr);
  const halfDone = migrateDeploy(schema);
  assert.notEqual(halfDone.status, 0, "re-running over the half-applied change is refused, not silently merged");
  await withClient(schema, async (c) => {
    await c.$executeRawUnsafe(`ALTER TABLE "pipeline_items" DROP COLUMN "rights_hold_at", DROP COLUMN "rights_hold_reason"`);
    await c.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE migration_name = '20261110100000_rights_revocation' AND finished_at IS NULL`);
  });
  const recovered = migrateDeploy(schema);
  assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
  assert.ok(schemaMatches(schema), "the recovered schema is exactly schema.prisma");
});

test("rollback compatibility: an older secure revision starts against the newest schema", opts, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const schema = "mig_rollback";
  assert.equal(migrateDeploy(schema).status, 0);
  // The migration set of the Package D revision (PR #5), run against the newest database.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aif-old-"));
  fs.cpSync("prisma", path.join(dir, "prisma"), { recursive: true });
  fs.copyFileSync("prisma.config.mjs", path.join(dir, "prisma.config.mjs"));
  fs.symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"));
  for (const m of fs.readdirSync(path.join(dir, "prisma/migrations"))) if (m > "20261110040000_generation_jobs" && !m.endsWith(".toml")) fs.rmSync(path.join(dir, "prisma/migrations", m), { recursive: true });
  const r = spawnSync(path.join(dir, "node_modules/.bin/prisma"), ["migrate", "deploy"], { cwd: dir, env: { ...process.env, DATABASE_URL: urlFor(schema) }, encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No pending migrations/);
});

test("every migration after the baseline is additive (no drops, renames or NOT NULL columns without defaults)", async () => {
  const fs = await import("node:fs");
  const dirs = fs.readdirSync("prisma/migrations").filter((d) => d > "20260321000000_init" && !d.endsWith(".toml"));
  // The single known data change: clearing simulated fixture scores (documented in MIGRATIONS.md).
  const KNOWN = { "20261110030000_content_packages": [/ALTER COLUMN "trend_score" DROP NOT NULL/, /UPDATE "trends"/] };
  const problems = [];
  for (const d of dirs) {
    const sql = fs.readFileSync(`prisma/migrations/${d}/migration.sql`, "utf8");
    const allowed = KNOWN[d] || [];
    for (const line of sql.split("\n")) {
      if (allowed.some((re) => re.test(line))) continue;
      if (/\bDROP\s+(TABLE|COLUMN)\b|\bRENAME\b|ALTER COLUMN .* TYPE\b/i.test(line)) problems.push(`${d}: ${line.trim()}`);
      if (/ADD COLUMN .* NOT NULL/i.test(line) && !/DEFAULT/i.test(line)) problems.push(`${d}: NOT NULL without default: ${line.trim()}`);
    }
  }
  assert.deepEqual(problems, []);
});
