import { createPrismaClient } from "./lib/prisma.js";
import { createApp } from "./app.js";
import { configFindings, pruneSessions } from "./services/opsChecks.js";

// Configuration audit by setting name only (never values). An unsupported
// Node version cannot run the TypeScript-stripped Prisma client: stop early.
const findings = configFindings(process.env);
for (const f of findings) {
  const line = `[config] ${f.level.toUpperCase()} ${f.setting}: ${f.message}`;
  if (f.level === "error") console.error(line); else if (f.level === "warning") console.warn(line); else console.log(line);
}
if (findings.some((f) => f.setting === "node" && f.level === "error")) process.exit(1);

const prisma = createPrismaClient();
const PORT = parseInt(process.env.PORT) || 4000;
const app = createApp({ prisma });

// Recovery at startup and then periodically (expired leases only, fenced,
// never re-buying or re-posting uncertain work): see services/recoverySweep.js.
const { startRecoverySweep, recoveryPass } = await import("./services/recoverySweep.js");
const sweep = startRecoverySweep({
  run: () => recoveryPass(prisma, app.locals.jobLedger),
  intervalMs: Number(process.env.RECOVERY_SWEEP_MS) || undefined,
});

// Housekeeping: sessions expired or revoked more than 30 days ago are deleted
// once a day (the audit trail keeps the events; nothing else is pruned).
const housekeeping = setInterval(() => {
  pruneSessions(prisma).then((n) => n && console.log(`[housekeeping] pruned ${n} old session(s)`))
    .catch((e) => console.error("[housekeeping] session pruning failed:", e?.message));
}, 24 * 3600_000);
housekeeping.unref();

const server = app.listen(PORT, "0.0.0.0", () => console.log(`🚀 API running on port ${PORT}`));

/**
 * Graceful shutdown. WHY: a redeploy sends SIGTERM. Stop accepting new
 * connections, let in-flight requests finish (a paid call already under way
 * should record its result), then close the database. Anything still running
 * after the grace period is left to the durable-job recovery on next start.
 */
const GRACE_MS = Math.min(Number(process.env.SHUTDOWN_GRACE_MS) || 25_000, 120_000);
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  sweep.stop();
  console.log(`[shutdown] ${signal}: closing; waiting up to ${GRACE_MS / 1000}s for in-flight requests`);
  const force = setTimeout(() => { console.warn("[shutdown] grace period over; exiting with requests still open"); process.exit(1); }, GRACE_MS);
  force.unref();
  server.close(async () => {
    await prisma.$disconnect().catch(() => {});
    console.log("[shutdown] done");
    process.exit(0);
  });
  server.closeIdleConnections?.();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
// Log and keep serving on a stray rejection; a thrown exception leaves the
// process in an unknown state, so shut down (the platform restarts it).
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("uncaughtException", (e) => { console.error("[uncaughtException]", e?.message || e); shutdown("uncaughtException"); });
