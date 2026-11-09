import crypto from "crypto";
import { ApiError } from "../lib/errors.js";
import { checkExternalUrl } from "../lib/urlSafety.js";
import { usdToMicros } from "./spendLedger.js";

/**
 * Durable generation jobs.
 *
 * WHY: a paid call can die anywhere. The job journal records each step's
 * progress in the database *before* the next irreversible thing happens, so
 * after a restart we can tell:
 *  - never marked "submitting"  -> provably never sent: release the money
 *  - submitting / accepted       -> may have run: outcome unknown, nothing is
 *                                   re-bought until reconciled
 *  - succeeded (settled)         -> paid and stored: a retry applies it free
 * Every write is fenced by the job's lease owner, so a worker that lost its
 * lease (presumed dead) cannot overwrite what recovery decided.
 */
export const JOB_LEASE_MS = 20 * 60 * 1000; // matches the item claim TTL
const OPEN_JOB = ["queued", "running"];
const UNCERTAIN = ["outcome_unknown", "settlement_failed", "submitting", "accepted"];

export const newLeaseOwner = () => `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;

/** Derives the job state from its steps (one source of truth). */
export function deriveJobState(steps) {
  const st = steps.map((s) => s.state);
  if (st.some((s) => ["outcome_unknown", "settlement_failed", "submitting", "accepted"].includes(s))) return "awaiting_reconciliation";
  if (st.some((s) => ["succeeded", "application_failed", "resolved_charged_with_result"].includes(s))) return "awaiting_application";
  if (st.length && st.every((s) => ["applied", "replayed"].includes(s))) return "succeeded";
  if (st.some((s) => s === "superseded")) return "failed";
  return "failed";
}

export async function createJob(prisma, { kind, targetType, targetId, workflowKey, requestHash, steps, by }) {
  const leaseOwner = newLeaseOwner();
  const job = await prisma.generationJob.create({
    data: {
      kind, targetType, targetId, workflowKey, requestHash: requestHash || null, state: "running",
      leaseOwner, leaseExpiresAt: new Date(Date.now() + JOB_LEASE_MS), createdBy: by || null,
      steps: { create: steps.map((s, index) => ({ index, kind: s.kind, provider: s.provider, model: s.model, idempotencyKey: s.idempotencyKey })) },
    },
  });
  return journalFor(prisma, job.id, leaseOwner);
}

function journalFor(prisma, jobId, leaseOwner) {
  // Fenced write: only while this worker still owns the lease.
  async function setStep(index, data) {
    const { count } = await prisma.generationStep.updateMany({ where: { jobId, index, job: { leaseOwner } }, data });
    if (count !== 1) throw new ApiError("JOB_LEASE_LOST", 409, "This generation job was taken over by recovery");
  }
  return {
    jobId,
    hooks: {
      afterReserve: async (reservations) => {
        for (let i = 0; i < reservations.length; i++) {
          const r = reservations[i];
          await setStep(i, { reservationId: r.reservationId || null, state: r.replay !== undefined ? "replayed" : "reserved" });
        }
      },
      beforeSubmit: (i) => setStep(i, { state: "submitting" }),
      onAccepted: (i, providerRequestId) => setStep(i, { state: "accepted", providerRequestId }),
      afterSettle: (i, result) => setStep(i, { state: "succeeded", result }),
      onStepState: (i, state, errorCode) => setStep(i, { state, errorCode: errorCode || null }),
    },
    markApplied: (i) => setStep(i, { state: "applied" }),
    async finish(errorCode = null) {
      const steps = await prisma.generationStep.findMany({ where: { jobId } });
      await prisma.generationJob.updateMany({
        where: { id: jobId, leaseOwner },
        data: { state: deriveJobState(steps), errorCode, leaseOwner: null, leaseExpiresAt: null, finishedAt: new Date() },
      });
    },
  };
}

/**
 * Recovery after a restart: jobs still "running" whose lease expired belong
 * to a dead worker. Takes them over (fencing the dead worker out) and settles
 * each step's money by what the journal proves.
 */
export async function recoverAbandoned(prisma, ledger, { now = new Date(), log = console } = {}) {
  const stale = await prisma.generationJob.findMany({ where: { state: { in: OPEN_JOB }, leaseExpiresAt: { lt: now } }, include: { steps: true } });
  const summary = [];
  for (const job of stale) {
    const recoverer = `recovery:${newLeaseOwner()}`;
    // Take over atomically; a worker that is somehow still alive is fenced out.
    const { count } = await prisma.generationJob.updateMany({
      where: { id: job.id, leaseOwner: job.leaseOwner, leaseExpiresAt: { lt: now } },
      data: { leaseOwner: recoverer },
    });
    if (count !== 1) continue;
    const outcome = { jobId: job.id, released: 0, unknown: 0 };
    for (const step of job.steps.sort((a, b) => a.index - b.index)) {
      const reservation = step.reservationId ? await ledger.get(step.reservationId) : await ledger.findByKey(step.idempotencyKey);
      if (["pending", "reserved"].includes(step.state)) {
        // Never marked as submitting: provably never sent.
        if (reservation?.state === "reserved") await ledger.release(reservation.id);
        await prisma.generationStep.update({ where: { id: step.id }, data: { state: "not_submitted", reservationId: reservation?.id || step.reservationId, errorCode: "PROCESS_DIED_BEFORE_SUBMIT" } });
        outcome.released++;
      } else if (["submitting", "accepted"].includes(step.state)) {
        // May have reached the provider: keep the money, block re-purchase.
        if (reservation?.state === "reserved") await ledger.markUnknown(reservation.id);
        await prisma.generationStep.update({ where: { id: step.id }, data: { state: "outcome_unknown", errorCode: "PROCESS_DIED_AFTER_SUBMIT" } });
        outcome.unknown++;
      }
    }
    const steps = await prisma.generationStep.findMany({ where: { jobId: job.id } });
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { state: deriveJobState(steps), leaseOwner: null, leaseExpiresAt: null, errorCode: "PROCESS_DIED", finishedAt: new Date() },
    });
    summary.push(outcome);
  }
  if (summary.length) log.info?.(`[jobs] recovered ${summary.length} abandoned job(s)`);
  return summary;
}

async function refreshJobState(prisma, jobId) {
  const steps = await prisma.generationStep.findMany({ where: { jobId } });
  await prisma.generationJob.update({ where: { id: jobId }, data: { state: deriveJobState(steps) } });
}

const resultFor = (kind, url) => (kind === "image" ? { imageUrl: url } : { videoUrl: url });

/** Asks the provider about an uncertain step (only adapters that support lookups). */
export async function checkStep(prisma, gate, ledger, stepId, { by }) {
  const step = await prisma.generationStep.findUnique({ where: { id: stepId } });
  if (!step) throw new ApiError("NOT_FOUND", 404, "Step not found");
  if (!UNCERTAIN.includes(step.state)) throw new ApiError("NOT_RESOLVABLE", 409, `Step is ${step.state}; nothing to reconcile`);
  if (!step.providerRequestId) throw new ApiError("CHECK_UNSUPPORTED", 409, "No provider request id was recorded; resolve it manually with evidence");
  const answer = await gate.checkProvider(step.kind, `${step.provider}:${step.model}`, step.providerRequestId);
  if (!answer) throw new ApiError("CHECK_UNSUPPORTED", 409, "This provider adapter cannot look up earlier requests; resolve it manually with evidence");
  const record = { stepId, reservationId: step.reservationId, method: "provider_check", resolvedBy: by };
  if (answer.status === "succeeded" && answer.url && checkExternalUrl(answer.url).ok) {
    await ledger.resolve(step.reservationId, { charged: true, actualMicros: null, result: resultFor(step.kind, answer.url) });
    await prisma.$transaction([
      prisma.generationStep.update({ where: { id: step.id }, data: { state: "succeeded", result: resultFor(step.kind, answer.url) } }),
      prisma.reconciliationRecord.create({ data: { ...record, resolution: "charged_with_result", evidence: `Provider reported request ${step.providerRequestId} succeeded`, resultUrl: answer.url } }),
    ]);
  } else {
    // Failed or still running: the charge is still uncertain, so nothing changes.
    await prisma.reconciliationRecord.create({ data: { ...record, resolution: "still_pending", evidence: `Provider reported "${answer.status}" for request ${step.providerRequestId}` } });
  }
  await refreshJobState(prisma, step.jobId);
  return prisma.generationStep.findUnique({ where: { id: step.id }, include: { reconciliations: true } });
}

/** Operator resolution of an uncertain step, with evidence (owner only, enforced by the route table). */
export async function resolveStep(prisma, ledger, stepId, { resolution, evidence, actualCost, resultUrl, by }) {
  const fields = {};
  if (!["not_charged", "charged_no_result", "charged_with_result"].includes(resolution)) fields.resolution = "must be not_charged, charged_no_result or charged_with_result";
  if (typeof evidence !== "string" || evidence.trim().length < 10 || evidence.length > 2000) fields.evidence = "is required: what you checked (10-2000 characters), e.g. the provider dashboard entry";
  let actualMicros = null;
  if (actualCost !== undefined && actualCost !== null && actualCost !== "") {
    actualMicros = usdToMicros(actualCost);
    if (actualMicros === null) fields.actualCost = "must be a non-negative amount with up to 6 decimals";
  }
  if (resolution === "charged_with_result") {
    const c = typeof resultUrl === "string" ? checkExternalUrl(resultUrl) : { ok: false, reason: "is required" };
    if (!c.ok) fields.resultUrl = c.reason;
  }
  if (Object.keys(fields).length) throw new ApiError("VALIDATION_FAILED", 400, "Resolution is incomplete", { fields });

  const step = await prisma.generationStep.findUnique({ where: { id: stepId } });
  if (!step) throw new ApiError("NOT_FOUND", 404, "Step not found");
  if (!UNCERTAIN.includes(step.state)) throw new ApiError("NOT_RESOLVABLE", 409, `Step is ${step.state}; nothing to resolve`);
  const job = await prisma.generationJob.findUnique({ where: { id: step.jobId } });
  if (OPEN_JOB.includes(job.state) && job.leaseExpiresAt && job.leaseExpiresAt > new Date()) {
    throw new ApiError("JOB_STILL_RUNNING", 409, "The job is still running; wait for it to finish or for its lease to expire");
  }
  const reservation = step.reservationId ? await ledger.get(step.reservationId) : await ledger.findByKey(step.idempotencyKey);
  if (!reservation) throw new ApiError("NOT_RESOLVABLE", 409, "No reservation found for this step");
  const result = resolution === "charged_with_result" ? resultFor(step.kind, resultUrl) : null;
  await ledger.resolve(reservation.id, { charged: resolution !== "not_charged", actualMicros, result });
  const stepState = { not_charged: "resolved_not_charged", charged_no_result: "resolved_charged_no_result", charged_with_result: "resolved_charged_with_result" }[resolution];
  await prisma.$transaction([
    prisma.generationStep.update({ where: { id: step.id }, data: { state: stepState, reservationId: reservation.id, ...(result ? { result } : {}) } }),
    prisma.reconciliationRecord.create({
      data: {
        stepId, reservationId: reservation.id, method: "operator", resolution, evidence: evidence.trim(),
        actualMicros: actualMicros === null ? null : BigInt(actualMicros), resultUrl: resultUrl || null, resolvedBy: by,
      },
    }),
  ]);
  await refreshJobState(prisma, step.jobId);
  return prisma.generationStep.findUnique({ where: { id: step.id }, include: { reconciliations: true } });
}
