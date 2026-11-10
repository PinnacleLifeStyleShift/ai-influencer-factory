#!/usr/bin/env node
/**
 * Backup: DATABASE_URL (env) -> <outDir>/aif-backup-<UTC time>.dump (+ .json).
 *
 * The .json beside the dump records what a correct restore must reproduce:
 * table row counts, applied migrations, server version, the database
 * fingerprint and the dump's sha256. Read-only against the source; nothing
 * is printed that could locate or unlock the database.
 *
 * Usage: DATABASE_URL=... node scripts/db-backup.mjs [outDir]
 * Needs pg_dump at least as new as the server (set PG_BIN to its directory).
 */
import fs from "node:fs";
import path from "node:path";
import { parseDbUrl, runPgTool, describeDb, sha256File } from "./db-tools.mjs";

try {
  const db = parseDbUrl(process.env.DATABASE_URL);
  const outDir = path.resolve(process.argv[2] || "backups");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `aif-backup-${stamp}.dump`);

  const before = await describeDb(db);
  runPgTool("pg_dump", ["--format=custom", "--no-owner", "--no-acl", `--schema=${db.schema}`, `--file=${file}`], db);
  const manifest = {
    createdAt: new Date().toISOString(), databaseFingerprint: db.fingerprint, schema: db.schema,
    serverVersion: before.version, migrations: before.migrations, counts: before.counts,
    dumpFile: path.basename(file), dumpBytes: fs.statSync(file).size, dumpSha256: sha256File(file),
    note: "Row counts were read just before the dump; writes during the dump can make them differ slightly.",
  };
  fs.writeFileSync(`${file.replace(/\.dump$/, "")}.json`, JSON.stringify(manifest, null, 2));
  console.log(`Backup written: ${path.basename(file)} (${manifest.dumpBytes} bytes, sha256 ${manifest.dumpSha256.slice(0, 16)}…)`);
  console.log(`Database ${db.fingerprint}, PostgreSQL ${before.version}, ${before.tables.length} tables, ${before.migrations?.length ?? 0} migrations applied`);
  console.log("Next: verify it with scripts/db-restore-verify.mjs into an EMPTY scratch database.");
} catch (e) {
  console.error(`Backup failed: ${e.message}`);
  process.exit(1);
}
