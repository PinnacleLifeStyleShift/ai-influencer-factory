#!/usr/bin/env node
/**
 * Applies committed Prisma migrations. Replaces `prisma db push`.
 *
 * Databases created before migrations existed (by `prisma db push` from the
 * schema at commit 277d2d3) have tables but no applied migration: either no
 * _prisma_migrations table, an empty one, or only a failed attempt to apply
 * the baseline on top of the existing tables.
 * For those, this script first VERIFIES that the live schema is identical to
 * prisma/baseline/277d2d3.schema.prisma, and only then records the baseline
 * migration as already applied. If the schema differs in any way it stops
 * without changing anything, so a deploy can never guess.
 *
 * Then it runs `prisma migrate deploy`, which applies only pending, committed
 * migrations and never drops data on its own.
 *
 * Exit codes: 0 ok, 1 refused or failed.
 */
import { spawnSync } from "node:child_process";
import { createPrismaClient } from "../src/lib/prisma.js";

const BASELINE_MIGRATION = "20260321000000_init";
const BASELINE_SCHEMA = "prisma/baseline/277d2d3.schema.prisma";

function prisma(args, { allowExit = [0] } = {}) {
  const r = spawnSync("npx", ["prisma", ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (!allowExit.includes(r.status)) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error(`prisma ${args[0]} ${args[1] || ""} failed (exit ${r.status})`);
  }
  return r;
}

async function inspect() {
  const client = createPrismaClient();
  try {
    const [row] = await client.$queryRaw`
      SELECT to_regclass('_prisma_migrations') IS NOT NULL AS has_history,
             to_regclass('characters') IS NOT NULL AS has_tables`;
    let applied = 0;
    let failed = [];
    if (row.has_history) {
      const rows = await client.$queryRawUnsafe(
        `SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations`);
      applied = rows.filter((r) => r.finished_at && !r.rolled_back_at).length;
      failed = [...new Set(rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name))];
    }
    return { hasTables: row.has_tables, applied, failed };
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const { hasTables, applied, failed } = await inspect();

  // A legacy (db push) database has tables but no successfully applied
  // migration. Its _prisma_migrations table may be missing, empty (created by
  // running `prisma migrate deploy` before any migration existed), or hold a
  // failed attempt to apply the baseline itself on top of the existing tables.
  if (hasTables && applied === 0) {
    const other = failed.filter((m) => m !== BASELINE_MIGRATION);
    if (other.length) {
      console.error(`[migrate] REFUSED: failed migrations other than the baseline are recorded (${other.join(", ")}). Nothing was changed.`);
      process.exit(1);
    }
    console.log("[migrate] Existing database without applied migrations; verifying it matches the baseline schema...");
    // --exit-code: 0 = no difference, 2 = differences, 1 = error.
    const diff = prisma(
      ["migrate", "diff", "--from-config-datasource", "--to-schema", BASELINE_SCHEMA, "--exit-code"],
      { allowExit: [0, 2] }
    );
    if (diff.status !== 0) {
      console.error("[migrate] REFUSED: the database schema differs from the 277d2d3 baseline. Nothing was changed.");
      console.error("[migrate] Differences (database -> baseline):\n" + diff.stdout);
      process.exit(1);
    }
    if (failed.includes(BASELINE_MIGRATION)) {
      // The failed attempt changed nothing (the schema still equals the
      // baseline, verified above), so it is marked rolled back first.
      prisma(["migrate", "resolve", "--rolled-back", BASELINE_MIGRATION]);
      console.log(`[migrate] Earlier failed attempt at ${BASELINE_MIGRATION} marked rolled back (schema verified unchanged).`);
    }
    prisma(["migrate", "resolve", "--applied", BASELINE_MIGRATION]);
    console.log(`[migrate] Baseline ${BASELINE_MIGRATION} recorded as applied (schema verified identical).`);
  }

  const deploy = prisma(["migrate", "deploy"]);
  process.stdout.write(deploy.stdout);
  console.log("[migrate] Done.");
}

main().catch((err) => {
  console.error(`[migrate] ${err.message}`);
  process.exit(1);
});
