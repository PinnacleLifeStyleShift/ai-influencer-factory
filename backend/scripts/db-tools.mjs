/**
 * Shared helpers for the database operations scripts (backup, restore drill,
 * preflight).
 *
 * WHY these rules: these scripts run against the production database. They
 * never print a connection string, host or password. Credentials go to
 * pg_dump/pg_restore through PG* environment variables, not command-line
 * arguments (which other processes can read). The database's identity is
 * shown as a short fingerprint, so two runs can be compared without
 * revealing where it lives.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import pg from "pg";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parses a postgres URL into pg settings, a schema and a fingerprint. Never logs it. */
export function parseDbUrl(url, name = "DATABASE_URL") {
  if (!url) throw new Error(`${name} is not set`);
  let u;
  try { u = new URL(url); } catch { throw new Error(`${name} is not a valid URL`); }
  if (!["postgres:", "postgresql:"].includes(u.protocol)) throw new Error(`${name} is not a postgres URL`);
  const schema = u.searchParams.get("schema") || "public";
  const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres";
  const sslmode = u.searchParams.get("sslmode");
  return {
    schema, database,
    fingerprint: crypto.createHash("sha256").update(`${u.hostname}:${u.port || 5432}/${database}/${schema}`).digest("hex").slice(0, 12),
    pgEnv: {
      PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password),
      PGDATABASE: database, ...(sslmode ? { PGSSLMODE: sslmode } : {}),
    },
    client: () => new pg.Client({
      host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database, ...(sslmode && sslmode !== "disable" ? { ssl: { rejectUnauthorized: sslmode === "verify-full" } } : {}),
    }),
  };
}

/** Runs a postgres client tool with credentials in the environment only. */
export function runPgTool(tool, args, db) {
  const bin = process.env.PG_BIN ? path.join(process.env.PG_BIN, tool) : tool;
  const r = spawnSync(bin, args, { env: { ...process.env, ...db.pgEnv }, encoding: "utf8" });
  if (r.error) throw new Error(`${tool} could not be started (${r.error.code}); install the PostgreSQL client tools or set PG_BIN`);
  // Tool messages can include the host; show only the first line of stderr, scrubbed.
  if (r.status !== 0) throw new Error(`${tool} failed: ${(r.stderr || "").split("\n")[0].replaceAll(db.pgEnv.PGHOST, "<host>").replaceAll(db.pgEnv.PGPASSWORD || "\u0000", "<secret>")}`);
  return r;
}

const q = (id) => `"${id.replaceAll('"', '""')}"`;

/** Facts about a database: version, tables with row counts, applied migrations. Read-only. */
export async function describeDb(db) {
  const c = db.client();
  await c.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const version = (await c.query("SHOW server_version")).rows[0].server_version;
    const tables = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name", [db.schema])).rows.map((r) => r.table_name);
    const counts = {};
    for (const t of tables) counts[t] = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${q(db.schema)}.${q(t)}`)).rows[0].n);
    let migrations = null;
    if (tables.includes("_prisma_migrations")) {
      migrations = (await c.query(`SELECT migration_name FROM ${q(db.schema)}."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)).rows.map((r) => r.migration_name);
    }
    await c.query("ROLLBACK");
    return { version, tables, counts, migrations };
  } finally { await c.end(); }
}

export function repoMigrations() {
  const dir = path.join(ROOT, "prisma/migrations");
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export const sha256File = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
