/**
 * Periodic recovery (review, operations): recovery used to run only once at
 * startup, so after a quick restart (leases still live) it found nothing and
 * interrupted work waited for a manual call. The sweep runs at startup and
 * then every RECOVERY_SWEEP_MS (default 2 minutes). It only takes over leases
 * that have EXPIRED, and recovery itself is fenced (IF-R4), so it can never
 * race a live worker or re-buy an uncertain operation; uncertain steps become
 * outcome_unknown for evidence-based reconciliation. Runs never overlap.
 * Each pass also reports obligations left unresolved too long (overdue).
 * Tests: recovery-sweep.test.js, db-review-1112 (IF-R4).
 */
export const DEFAULT_SWEEP_MS = 120_000;
export const OVERDUE_MS = 3600_000;

export function startRecoverySweep({ run, intervalMs = DEFAULT_SWEEP_MS, log = console, setTimer = setInterval, clearTimer = clearInterval }) {
  let running = null;
  const tick = () => {
    if (running) return running; // never overlap a slow pass
    running = Promise.resolve().then(run)
      .catch((e) => log.error?.(`[recovery] sweep failed: ${e?.message}`))
      .finally(() => { running = null; });
    return running;
  };
  const first = tick();
  const timer = setTimer(tick, intervalMs);
  timer?.unref?.();
  return { first, tick, stop: () => clearTimer(timer) };
}

/** Counts (no payloads) of obligations unresolved for longer than OVERDUE_MS. */
export async function overdueObligations(prisma, { now = new Date() } = {}) {
  const before = new Date(now.getTime() - OVERDUE_MS);
  const [steps, deliveries, reservations] = await Promise.all([
    prisma.generationStep.count({ where: { state: { in: ["outcome_unknown", "settlement_failed", "application_failed"] }, updatedAt: { lt: before } } }),
    prisma.publishDelivery.count({ where: { state: { in: ["outcome_unknown", "conflicting_evidence", "processing"] }, updatedAt: { lt: before } } }),
    prisma.generationReservation.count({ where: { state: "outcome_unknown", updatedAt: { lt: before } } }),
  ]);
  return { steps, deliveries, reservations, total: steps + deliveries + reservations };
}

/** One pass: recover expired generation and publish leases, then report overdue work. */
export async function recoveryPass(prisma, ledger, { log = console } = {}) {
  const { recoverAbandoned } = await import("./generationJobs.js");
  const { recoverPublishJobs } = await import("./publishing.js");
  await recoverAbandoned(prisma, ledger, { log });
  await recoverPublishJobs(prisma);
  const overdue = await overdueObligations(prisma);
  if (overdue.total) log.warn?.(`[alert] ${overdue.total} unresolved obligation(s) older than 1 hour (steps ${overdue.steps}, deliveries ${overdue.deliveries}, reservations ${overdue.reservations}); see Operations`);
  return overdue;
}
