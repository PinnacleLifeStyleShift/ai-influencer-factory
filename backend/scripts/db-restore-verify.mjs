#!/usr/bin/env node
/**
 * Restore drill: restores a backup into an EMPTY scratch database and checks
 * that it reproduces the backup's row counts and migrations.
 *
 * WHY a drill, not a restore: an untested backup is not a backup. This never
 * touches DATABASE_URL: the target comes from RESTORE_DATABASE_URL, must be a
 * different database, and must be empty. Restoring over production is a
 * separate, manual decision (see the runbook).
 *
 * Usage: RESTORE_DATABASE_URL=... node scripts/db-restore-verify.mjs <backup.dump>
 */
import fs from "node:fs";
import { parseDbUrl, runPgTool, describeDb, sha256File } from "./db-tools.mjs";

try {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) throw new Error("give the path of a .dump file");
  const manifestPath = file.replace(/\.dump$/, ".json");
  if (!fs.existsSync(manifestPath)) throw new Error("the .json written beside the dump is missing");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (sha256File(file) !== manifest.dumpSha256) throw new Error("the dump's checksum does not match its manifest (corrupt or replaced)");

  const target = parseDbUrl(process.env.RESTORE_DATABASE_URL, "RESTORE_DATABASE_URL");
  if (process.env.DATABASE_URL) {
    const source = parseDbUrl(process.env.DATABASE_URL);
    if (source.fingerprint === target.fingerprint || (source.pgEnv.PGHOST === target.pgEnv.PGHOST && source.pgEnv.PGPORT === target.pgEnv.PGPORT && source.database === target.database)) {
      throw new Error("RESTORE_DATABASE_URL points at the DATABASE_URL database; the drill only restores into a separate scratch database");
    }
  }
  if (target.schema !== manifest.schema) throw new Error(`the target schema must be "${manifest.schema}" (as in the backup)`);
  const pre = await describeDb(target);
  if (pre.tables.length) throw new Error(`the target is not empty (${pre.tables.length} tables in schema "${target.schema}")`);

  runPgTool("pg_restore", ["--no-owner", "--no-acl", "--exit-on-error", `--dbname=${target.database}`, file], target);
  const after = await describeDb(target);

  const problems = [];
  for (const [t, n] of Object.entries(manifest.counts)) {
    if (after.counts[t] !== n) problems.push(`${t}: backup had ${n} rows, restore has ${after.counts[t] ?? "no table"}`);
  }
  if (JSON.stringify(after.migrations) !== JSON.stringify(manifest.migrations)) problems.push("applied migrations differ from the backup");
  console.log(`Restored ${manifest.dumpFile} into scratch database ${target.fingerprint}: ${after.tables.length} tables, ${after.migrations?.length ?? 0} migrations`);
  if (problems.length) {
    console.error(`RESTORE DRILL FAILED:\n- ${problems.join("\n- ")}`);
    process.exit(2);
  }
  console.log(`RESTORE DRILL PASSED: ${Object.keys(manifest.counts).length} tables with matching row counts; migrations match.`);
} catch (e) {
  console.error(`Restore drill failed: ${e.message}`);
  process.exit(1);
}
