#!/usr/bin/env node
/**
 * Applies committed Prisma migrations. Replaces `prisma db push`.
 *
 * Databases created before migrations existed (by `prisma db push` from the
 * schema at commit 277d2d3) have tables but no _prisma_migrations history.
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
import { PrismaClient } from "@prisma/client";

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
  const client = new PrismaClient();
  try {
    const [row] = await client.$queryRaw`
      SELECT to_regclass('_prisma_migrations') IS NOT NULL AS has_history,
             to_regclass('characters') IS NOT NULL AS has_tables`;
    return { hasHistory: row.has_history, hasTables: row.has_tables };
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const { hasHistory, hasTables } = await inspect();

  if (!hasHistory && hasTables) {
    console.log("[migrate] Existing database without migration history; verifying it matches the baseline schema...");
    // --exit-code: 0 = no difference, 2 = differences, 1 = error.
    const diff = prisma(
      ["migrate", "diff", "--from-url", process.env.DATABASE_URL, "--to-schema-datamodel", BASELINE_SCHEMA, "--exit-code"],
      { allowExit: [0, 2] }
    );
    if (diff.status !== 0) {
      console.error("[migrate] REFUSED: the database schema differs from the 277d2d3 baseline. Nothing was changed.");
      console.error("[migrate] Differences (database -> baseline):\n" + diff.stdout);
      process.exit(1);
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
