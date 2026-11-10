import { secureRouter } from "../lib/secureRouter.js";
import { ApiError, routeError } from "../lib/errors.js";
import { listLimit } from "../lib/validate.js";
import { recoverAbandoned, checkStep, resolveStep } from "../services/generationJobs.js";

/**
 * Generation jobs and reconciliation.
 * Reading is open to anyone who can read; every action that changes money
 * or recovery state is owner-only (see auth/permissions.js).
 */
const STATES = ["queued", "running", "awaiting_reconciliation", "awaiting_application", "succeeded", "failed", "cancelled"];
const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v);
const serializeStep = (s) => ({
  ...s,
  reconciliations: (s.reconciliations || []).map((r) => ({ ...r, actualMicros: toNumber(r.actualMicros) })),
});

export function generationJobRoutes({ gate, ledger }) {
  const router = secureRouter();
  const wrap = (label, fn) => async (req, res) => { try { await fn(req, res); } catch (err) { routeError(res, err, `Failed: ${label}`, label); } };

  router.get("/", wrap("GET /generation-jobs", async (req, res) => {
    const where = {};
    if (typeof req.query.state === "string") {
      if (!STATES.includes(req.query.state)) throw new ApiError("VALIDATION_FAILED", 400, `state must be one of ${STATES.join(", ")}`);
      where.state = req.query.state;
    }
    if (typeof req.query.targetId === "string") where.targetId = req.query.targetId;
    const jobs = await req.prisma.generationJob.findMany({
      where, orderBy: { createdAt: "desc" }, take: listLimit(req),
      include: { steps: { orderBy: { index: "asc" }, include: { reconciliations: { orderBy: { resolvedAt: "asc" } } } } },
    });
    // Reservation money per step, so the screen shows what is counted.
    const withMoney = await Promise.all(jobs.map(async (j) => ({
      ...j,
      steps: await Promise.all(j.steps.map(async (s) => {
        const r = s.reservationId ? await ledger.get(s.reservationId) : await ledger.findByKey(s.idempotencyKey);
        return { ...serializeStep(s), reservation: r && { id: r.id, state: r.state, amountMicros: r.amountMicros, actualMicros: r.actualMicros, currency: r.currency, priceVersion: r.priceVersion } };
      })),
    })));
    res.json(withMoney);
  }));

  router.post("/recover", ["admin"], wrap("POST /generation-jobs/recover", async (req, res) => {
    res.json({ recovered: await recoverAbandoned(req.prisma, ledger) });
  }));

  router.post("/steps/:stepId/check", ["admin"], wrap("POST /generation-jobs/steps/:stepId/check", async (req, res) => {
    res.json(serializeStep(await checkStep(req.prisma, gate, ledger, req.params.stepId, { by: req.principal.id })));
  }));

  router.post("/steps/:stepId/resolve", ["admin"], wrap("POST /generation-jobs/steps/:stepId/resolve", async (req, res) => {
    const b = req.body || {};
    res.json(serializeStep(await resolveStep(req.prisma, ledger, req.params.stepId, {
      resolution: b.resolution, evidence: b.evidence, actualCost: b.actualCost, resultUrl: b.resultUrl, by: req.principal.id,
    })));
  }));

  return router;
}
