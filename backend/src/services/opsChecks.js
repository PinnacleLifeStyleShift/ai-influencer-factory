import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { MIN_TOKEN_LENGTH } from "../middleware/auth.js";

/**
 * Operational checks.
 *
 * WHY names only: these results are logged at startup and shown to the owner;
 * they must never contain a secret or a connection string. Each finding names
 * the setting and what is wrong with it.
 *
 * Levels: "error" (the service cannot do its job safely), "warning" (a risky
 * or unusual setting that needs a deliberate decision), "info" (a disabled
 * feature, which is the safe default).
 */
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../prisma/migrations");

export function repoMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

export function configFindings(env = process.env, { nodeVersion = process.versions.node } = {}) {
  const f = [];
  const add = (level, setting, message) => f.push({ level, setting, message });
  const [maj, min] = nodeVersion.split(".").map(Number);
  if (!((maj === 22 && min >= 18) || maj >= 24)) add("error", "node", `Node ${nodeVersion} is not supported (needs ^22.18 or >=24)`);
  if (!env.DATABASE_URL) add("error", "DATABASE_URL", "is not set");
  if (!env.OWNER_API_TOKEN) add("error", "OWNER_API_TOKEN", "is not set: every /api route refuses requests");
  else if (env.OWNER_API_TOKEN.length < MIN_TOKEN_LENGTH) add("error", "OWNER_API_TOKEN", `is shorter than ${MIN_TOKEN_LENGTH} characters: every /api route refuses requests`);
  if (!env.FRONTEND_URL) add("error", "FRONTEND_URL", "is not set: no browser origin can call the API");
  else {
    for (const origin of env.FRONTEND_URL.split(",").map((s) => s.trim())) {
      let u = null; try { u = new URL(origin); } catch { /* invalid */ }
      if (!u) add("error", "FRONTEND_URL", "contains an entry that is not a URL");
      else if (u.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(u.hostname)) add("warning", "FRONTEND_URL", "contains a non-https origin");
      else if (u.pathname !== "/" || u.search) add("warning", "FRONTEND_URL", "entries should be bare origins (no path)");
    }
  }
  if (env.NODE_ENV === "production" && !env.TRUST_PROXY) add("warning", "TRUST_PROXY", "is not set behind a proxy: rate limits see the proxy's address, not the client's");

  // Spending and outbound actions: disabled is the safe default.
  if (env.LIVE_PROVIDER_CALLS === "enabled") add("warning", "LIVE_PROVIDER_CALLS", "is enabled: paid generation is possible once a provider, prices, caps and a durable ledger are set");
  else add("info", "LIVE_PROVIDER_CALLS", "disabled: no paid generation");
  if (env.LIVE_PROVIDER_CALLS === "enabled" && env.SPEND_LEDGER !== "postgres") add("warning", "SPEND_LEDGER", "is not postgres: paid generation stays refused");
  if (env.LIVE_PUBLISHING === "enabled") add("warning", "LIVE_PUBLISHING", "is enabled; no real publisher is implemented, so nothing can be posted");
  else add("info", "LIVE_PUBLISHING", "disabled: nothing is posted");
  if (env.PUBLISHING_SIMULATION === "enabled") add("warning", "PUBLISHING_SIMULATION", "is enabled: publish runs are simulated (clearly labelled, never counted as published)");
  if (env.MEDIA_STORE === "synthetic-fixture") add(env.NODE_ENV === "production" ? "warning" : "info", "MEDIA_STORE", "is the synthetic fixture store (test files only); real exports cannot verify media");
  else if (!env.MEDIA_STORE) add("info", "MEDIA_STORE", "not configured: export reports MEDIA_STORE_NOT_CONFIGURED");
  if (env.METRICS_API === "enabled") add("warning", "METRICS_API", "is enabled but no analytics provider is implemented");
  return f;
}

/** Readiness: the database answers and every committed migration is applied. */
export async function readiness(prisma, { expected = repoMigrations() } = {}) {
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`);
    const applied = new Set(rows.map((r) => r.migration_name));
    const missing = expected.filter((m) => !applied.has(m));
    return missing.length ? { ready: false, reason: "migrations_pending", missing: missing.length } : { ready: true };
  } catch {
    return { ready: false, reason: "database_unavailable" };
  }
}

/** Housekeeping: drop sessions that expired or were revoked long ago. */
export async function pruneSessions(prisma, { olderThanDays = 30, now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanDays * 86400_000);
  const { count } = await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] } });
  return count;
}
