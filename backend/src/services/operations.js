import { ApiError } from "../lib/errors.js";

/**
 * Operations: a runtime generation switch and an obligations view.
 *
 * WHY a runtime switch: LIVE_PROVIDER_CALLS needs a redeploy. When something
 * looks wrong the owner must be able to stop NEW provider submissions at
 * once, including the next step of a workflow already running, while work a
 * provider already accepted can still be checked, resolved and applied.
 * Pausing never erases jobs and never releases uncertain money.
 */
export const GENERATION_PAUSED = "generation_paused";

export async function generationPause(prisma) {
  const row = await prisma.systemControl.findUnique({ where: { key: GENERATION_PAUSED } });
  return row?.value?.paused ? { paused: true, reason: row.reason, by: row.updatedBy, at: row.updatedAt } : { paused: false };
}

export async function assertGenerationOpen(prisma) {
  const p = await generationPause(prisma);
  if (p.paused) {
    const e = new ApiError("GENERATION_PAUSED", 503, "New generation is paused by the owner; reconciliation of earlier work continues", { reason: p.reason });
    e.preSubmitRefusal = true;
    throw e;
  }
}

export async function setGenerationPause(prisma, { paused, reason, by }) {
  if (typeof paused !== "boolean") throw new ApiError("VALIDATION_FAILED", 400, "paused must be true or false", { fields: { paused: "is required" } });
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) {
    throw new ApiError("VALIDATION_FAILED", 400, "A reason is required (3-500 characters)", { fields: { reason: "is required" } });
  }
  await prisma.systemControl.upsert({
    where: { key: GENERATION_PAUSED },
    create: { key: GENERATION_PAUSED, value: { paused }, reason: reason.trim(), updatedBy: by },
    update: { value: { paused }, reason: reason.trim(), updatedBy: by },
  });
  return generationPause(prisma);
}

const ageSec = (d, now) => Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
const STEP_ACTIONS = {
  outcome_unknown: ["Outcome unknown: the provider may have charged", "Check with the provider (if supported) or resolve with evidence (owner)"],
  submitting: ["Sent or about to be sent when the process stopped", "Run recovery, then check or resolve (owner)"],
  accepted: ["Accepted by the provider; result not recorded", "Run recovery, then check or resolve (owner)"],
  settlement_failed: ["Charged; the charge was not recorded", "Resolve with the provider's charge as evidence (owner)"],
  succeeded: ["Paid result stored but not applied", "Retry the same request to apply it (no new purchase)"],
  application_failed: ["Paid result stored but not applied", "Retry the same request to apply it (no new purchase)"],
  resolved_charged_with_result: ["Resolved with a result not yet applied", "Retry the same request to apply it (no new purchase)"],
};
const DELIVERY_ACTIONS = {
  outcome_unknown: ["Outcome unknown: may have been posted", "Check with the platform or record what the account shows (owner)"],
  submitting: ["Being sent when the process stopped", "Run publish recovery, then check or resolve (owner)"],
  processing: ["Platform still processing", "Check with the platform"],
  conflicting_evidence: ["Platform evidence contradicts a recorded decision", "Review the evidence and decide again (owner)"],
};

/**
 * Open obligations, newest risk first. Rows carry no tokens, request bodies or
 * raw provider payloads: only ids, states, amounts and the next permitted action.
 */
export async function operationsView(prisma, { now = Date.now() } = {}) {
  const steps = await prisma.generationStep.findMany({ where: { state: { in: Object.keys(STEP_ACTIONS) } }, include: { job: true } });
  const reservationIds = steps.map((s) => s.reservationId).filter(Boolean);
  const reservations = reservationIds.length ? await prisma.generationReservation.findMany({ where: { id: { in: reservationIds } } }) : [];
  const byRes = new Map(reservations.map((r) => [r.id, r]));
  const retained = await prisma.generationReservation.findMany({ where: { state: { in: ["reserved", "outcome_unknown"] } } });
  const deliveries = await prisma.publishDelivery.findMany({ where: { state: { in: Object.keys(DELIVERY_ACTIONS) } }, include: { job: true } });
  const holds = await prisma.pipelineItem.findMany({ where: { rightsHoldAt: { not: null } }, select: { id: true, rightsHoldAt: true, rightsHoldReason: true, stage: true } });

  const rows = [
    ...steps.map((s) => {
      const r = byRes.get(s.reservationId);
      const [lastSafeState, nextAction] = STEP_ACTIONS[s.state];
      return {
        type: "generation_step", id: s.id, revision: s.revision, state: s.state, package: { type: s.job.targetType, id: s.job.targetId },
        ageSec: ageSec(s.updatedAt, now), lastSafeState, nextAction, evidenceOwner: "owner",
        money: r ? { state: r.state, reservedMicros: Number(r.amountMicros), currency: r.currency } : null,
        provider: `${s.provider}:${s.model}`, providerRequestId: s.providerRequestId || null,
      };
    }),
    ...deliveries.map((d) => {
      const [lastSafeState, nextAction] = DELIVERY_ACTIONS[d.state];
      return {
        type: "publish_delivery", id: d.id, revision: d.revision, state: d.state, package: { type: "pipeline_item", id: d.job.pipelineItemId },
        ageSec: ageSec(d.updatedAt, now), lastSafeState, nextAction, evidenceOwner: "owner", platform: d.platform, simulated: d.simulated,
      };
    }),
    ...holds.map((h) => ({
      type: "rights_hold", id: h.id, state: "rights_hold", package: { type: "pipeline_item", id: h.id }, ageSec: ageSec(h.rightsHoldAt, now),
      lastSafeState: `Held (${h.stage})`, nextAction: "Review the item, then clear the hold with a note (owner)", evidenceOwner: "owner", reason: h.rightsHoldReason,
    })),
  ].sort((a, b) => b.ageSec - a.ageSec);

  const retainedByCurrency = {};
  for (const r of retained) {
    const c = (retainedByCurrency[r.currency] ||= { reservedMicros: 0, outcomeUnknownMicros: 0, count: 0 });
    c.count++;
    if (r.state === "outcome_unknown") c.outcomeUnknownMicros += Number(r.amountMicros); else c.reservedMicros += Number(r.amountMicros);
  }
  return {
    generation: await generationPause(prisma),
    summary: {
      openObligations: rows.length,
      oldestAgeSec: rows[0]?.ageSec ?? 0,
      unknownOutcomes: rows.filter((r) => ["outcome_unknown", "submitting", "accepted"].includes(r.state)).length,
      failedSettlements: rows.filter((r) => r.state === "settlement_failed").length,
      unappliedResults: rows.filter((r) => ["succeeded", "application_failed", "resolved_charged_with_result"].includes(r.state)).length,
      retainedReservations: retainedByCurrency,
    },
    rows,
  };
}
