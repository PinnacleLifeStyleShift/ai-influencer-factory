#!/usr/bin/env node
/**
 * Production preflight (READ-ONLY): what will happen if this code is deployed
 * against DATABASE_URL, and is the configuration ready?
 *
 * Reports, without printing any secret or host:
 *  - the database fingerprint (compare it with the backup's) and server version
 *  - whether migrations are applied, pending, or the database predates
 *    migrations (then migrate-deploy verifies the baseline before recording it)
 *  - row counts of the main tables
 *  - the configuration audit by setting name (from the current environment)
 * Exit code 0 = no blocking findings; 2 = something must be fixed first.
 *
 * Usage: DATABASE_URL=... [other vars] node scripts/preflight.mjs
 */
import { parseDbUrl, describeDb, repoMigrations } from "./db-tools.mjs";
import { configFindings } from "../src/services/opsChecks.js";

try {
  const db = parseDbUrl(process.env.DATABASE_URL);
  const facts = await describeDb(db);
  const repo = repoMigrations();
  const blocking = [];
  console.log(`Database ${db.fingerprint} (schema ${db.schema}), PostgreSQL ${facts.version}, ${facts.tables.length} tables`);

  if (facts.migrations === null) {
    if (facts.tables.includes("characters")) {
      console.log("Migrations: none recorded. This is a pre-migration (db push) database: on start, migrate-deploy checks it is identical to the baseline before recording it, then applies the rest. A database that differs is refused.");
    } else if (!facts.tables.length) {
      console.log("Migrations: empty database; all migrations will be applied on start.");
    } else {
      blocking.push("the schema has tables but no migration history and no characters table; do not deploy against it");
    }
  } else {
    const unknown = facts.migrations.filter((m) => !repo.includes(m));
    const pending = repo.filter((m) => !facts.migrations.includes(m));
    if (unknown.length) blocking.push(`the database has migrations this code does not know: ${unknown.join(", ")} (is this an older checkout?)`);
    console.log(pending.length ? `Migrations: ${pending.length} pending, applied on start: ${pending.join(", ")}` : "Migrations: all applied");
  }
  const main = ["characters", "pipeline_items", "content", "campaigns", "sessions", "generation_reservations", "publish_jobs", "metric_observations"];
  console.log(`Rows: ${main.filter((t) => t in facts.counts).map((t) => `${t}=${facts.counts[t]}`).join(", ") || "none of the main tables exist yet"}`);

  for (const f of configFindings(process.env)) {
    console.log(`Config ${f.level.toUpperCase()}: ${f.setting} ${f.message}`);
    if (f.level === "error" && f.setting !== "DATABASE_URL") blocking.push(`${f.setting} ${f.message}`);
  }
  if (blocking.length) {
    console.error(`PREFLIGHT: NOT READY\n- ${blocking.join("\n- ")}`);
    process.exit(2);
  }
  console.log("PREFLIGHT: no blocking findings. Take and verify a backup before deploying.");
} catch (e) {
  console.error(`Preflight failed: ${e.message}`);
  process.exit(1);
}
