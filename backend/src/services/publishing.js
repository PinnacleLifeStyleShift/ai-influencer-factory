import crypto from "crypto";
import { ApiError } from "../lib/errors.js";
import { checkExternalUrl } from "../lib/urlSafety.js";
import { destinationsOf, mediaTypeOf } from "../lib/revision.js";
import { assertDeliverable } from "./calendar.js";
import { isProcessDeath } from "./generationGate.js";

/**
 * Publishing one approved original to its approved destinations.
 *
 * WHY a journal per destination: posting is irreversible and platforms answer
 * slowly or not at all. Each delivery's state is written before the next
 * irreversible step, so after any failure we know, per destination:
 *  - never marked "submitting"           -> provably not sent: may be retried
 *  - "submitting" without an answer      -> outcome unknown: NOT retried until
 *                                           reconciled (a retry could post twice)
 *  - "published" with a remote post id   -> done: never retried
 * A partial success therefore never re-posts the destinations that worked.
 * Every write is fenced by the job's lease owner, and the calendar fence
 * (assertDeliverable) is re-checked before each destination, so a cancellation
 * stops the destinations not yet sent.
 */
export const PUBLISH_LEASE_MS = 10 * 60 * 1000;
const RETRYABLE = ["pending", "failed", "resolved_not_published"];
// conflicting_evidence: a platform answer contradicted a decision already made;
// re-posting stays blocked until the owner reviews it.
const UNCERTAIN = ["submitting", "processing", "outcome_unknown", "conflicting_evidence"];
const DONE = ["published", "resolved_published"];

export function deriveJobState(deliveries) {
  const st = deliveries.map((d) => d.state);
  if (st.some((s) => s === "submitting" || s === "outcome_unknown" || s === "conflicting_evidence")) return "awaiting_reconciliation";
  if (st.some((s) => s === "processing")) return "awaiting_confirmation";
  if (st.length && st.every((s) => s === "simulated")) return "simulated";
  if (st.length && st.every((s) => DONE.includes(s))) return "published";
  if (st.some((s) => DONE.includes(s))) return "partially_published";
  if (st.length && st.every((s) => s === "cancelled")) return "cancelled";
  if (st.every((s) => s === "pending" || s === "cancelled")) return "queued";
  return "failed";
}

const newOwner = () => `${process.pid}:${crypto.randomBytes(6).toString("hex")}`;
const clientRefFor = (deliveryId, attempt) => crypto.createHash("sha256").update(`${deliveryId}:${attempt}`).digest("hex").slice(0, 40);
const safePermalink = (u) => (typeof u === "string" && checkExternalUrl(u).ok ? u : null);

/** What is sent: only the approved snapshot, with the disclosure in the text. */
export function buildPayload(item, exportRecord, platform) {
  const type = mediaTypeOf(item);
  const file = exportRecord.manifest.media.find((m) => m.role === type) || exportRecord.manifest.media[0];
  const text = [item.caption, item.disclosure, item.hashtags].filter((x) => x && x.trim()).join("\n\n");
  return {
    platform, mediaType: type, mediaUrl: file.url, mediaSha256: file.sha256,
    text, disclosure: item.disclosure, aiGenerated: true,
    manifestHash: exportRecord.manifestHash,
  };
}

/** Applies a job's derived state to the job, the calendar entry and the item. */
export async function settleJob(prisma, jobId, { releaseLeaseOf } = {}) {
  const job = await prisma.publishJob.findUnique({ where: { id: jobId }, include: { deliveries: true } });
  const state = deriveJobState(job.deliveries);
  await prisma.publishJob.updateMany({
    where: { id: jobId, ...(releaseLeaseOf ? { leaseOwner: releaseLeaseOf } : {}) },
    data: { state, ...(releaseLeaseOf ? { leaseOwner: null, leaseExpiresAt: null } : {}) },
  });
  // Only platform-confirmed deliveries change what the calendar says. Once
  // any destination is confirmed out, the entry must say so, whatever else is
  // still pending, unknown or cancelled.
  const out = job.deliveries.filter((d) => DONE.includes(d.state)).length;
  if (state === "published") {
    await prisma.$transaction([
      prisma.content.updateMany({ where: { id: job.contentId, status: { in: ["scheduled", "partially_published"] } }, data: { status: "published" } }),
      prisma.pipelineItem.updateMany({ where: { id: job.pipelineItemId, stage: "scheduled", approvedHash: job.snapshotHash }, data: { stage: "published" } }),
    ]);
  } else if (out > 0) {
    // Also after a cancellation: what is out must not be shown as "cancelled".
    await prisma.content.updateMany({ where: { id: job.contentId, status: { in: ["scheduled", "cancelled"] } }, data: { status: "partially_published" } });
  }
  return state;
}

export async function publishContent(prisma, gate, contentId, { by, now = new Date(), faults = null } = {}) {
  const fault = async (point) => { if (faults) await faults(point); };
  const { item } = await assertDeliverable(prisma, contentId);
  if (item.scheduledAt && new Date(item.scheduledAt) > now) {
    throw new ApiError("NOT_YET_DUE", 409, "The approved time has not arrived; publishing early would not be what was approved", { scheduledAt: item.scheduledAt });
  }
  if ((item.shotMedia || []).length && !item.videoUrl) {
    throw new ApiError("RENDER_REQUIRED", 409, "A multi-shot package must be rendered into one file before it can be posted");
  }
  const exportRecord = await prisma.exportManifest.findFirst({ where: { pipelineItemId: item.id, snapshotHash: item.approvedHash }, orderBy: { createdAt: "desc" } });
  if (!exportRecord) throw new ApiError("EXPORT_REQUIRED", 409, "Export the approved version first; its media must be verified before posting");

  // Every approved destination must pass the gate before anything is written.
  const destinations = destinationsOf(item);
  const checks = destinations.map((p) => gate.preflight(p));

  let job = await prisma.publishJob.findUnique({ where: { contentId }, include: { deliveries: true } });
  if (!job) {
    try {
      job = await prisma.publishJob.create({
        data: {
          contentId, pipelineItemId: item.id, snapshotHash: item.approvedHash, manifestHash: exportRecord.manifestHash, createdBy: by || null,
          deliveries: { create: destinations.map((platform, i) => ({ platform, accountRef: checks[i].account.accountRef, simulated: Boolean(checks[i].simulated) })) },
        },
        include: { deliveries: true },
      });
    } catch (err) {
      if (err?.code !== "P2002") throw err;
      job = await prisma.publishJob.findUnique({ where: { contentId }, include: { deliveries: true } });
    }
  }

  const owner = newOwner();
  const { count } = await prisma.publishJob.updateMany({
    where: { id: job.id, OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }] },
    data: { leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + PUBLISH_LEASE_MS), state: "running" },
  });
  if (count !== 1) throw new ApiError("PUBLISH_IN_PROGRESS", 409, "This content is being published right now");

  const setDelivery = async (id, data) => {
    const r = await prisma.publishDelivery.updateMany({ where: { id, job: { leaseOwner: owner } }, data: { ...data, revision: { increment: 1 } } });
    if (r.count !== 1) throw new ApiError("PUBLISH_LEASE_LOST", 409, "This publish job was taken over by recovery");
  };

  let died = false;
  try {
    const deliveries = (await prisma.publishDelivery.findMany({ where: { jobId: job.id } }))
      .sort((a, b) => destinations.indexOf(a.platform) - destinations.indexOf(b.platform));
    const uncertain = deliveries.filter((d) => UNCERTAIN.includes(d.state));
    if (uncertain.length) {
      throw new ApiError("RECONCILIATION_REQUIRED", 409, "Some destinations have an unknown or unconfirmed outcome; reconcile them before posting again",
        { deliveries: uncertain.map((d) => ({ id: d.id, platform: d.platform, state: d.state })) });
    }
    for (const d of deliveries) {
      if (!RETRYABLE.includes(d.state)) continue; // published, simulated, cancelled: never again
      // Re-check the calendar fence right before each irreversible step.
      try { await assertDeliverable(prisma, contentId); } catch (fence) {
        await prisma.publishDelivery.updateMany({ where: { jobId: job.id, state: { in: RETRYABLE } }, data: { state: "cancelled", errorCode: fence.code || "FENCED", revision: { increment: 1 } } });
        break;
      }
      const check = checks[destinations.indexOf(d.platform)];
      await fault("beforeSubmitMark");
      const attempt = d.attempt + 1;
      const clientRef = clientRefFor(d.id, attempt);
      await setDelivery(d.id, { state: "submitting", attempt, clientRef, submittedAt: new Date(), errorCode: null, simulated: Boolean(check.simulated) });
      await fault("afterSubmitMark");
      try {
        const result = await check.adapter.publish(buildPayload(item, exportRecord, d.platform), {
          clientRef,
          onAccepted: async (remoteRequestId) => { await setDelivery(d.id, { remoteRequestId: String(remoteRequestId).slice(0, 200) }); await fault("afterAccept"); },
        });
        await fault("afterResult");
        if (result?.status === "published" && result.remotePostId) {
          await setDelivery(d.id, {
            state: check.simulated ? "simulated" : "published", remotePostId: String(result.remotePostId).slice(0, 200),
            permalink: safePermalink(result.permalink), confirmedAt: new Date(),
          });
        } else if (result?.status === "processing") {
          await setDelivery(d.id, { state: "processing", remoteRequestId: result.remoteRequestId ? String(result.remoteRequestId).slice(0, 200) : undefined });
        } else {
          await setDelivery(d.id, { state: "outcome_unknown", errorCode: "UNRECOGNISED_RESPONSE" });
        }
      } catch (err) {
        if (isProcessDeath(err)) throw err;
        if (err?.code === "PUBLISH_LEASE_LOST") throw err;
        // Only a provable "never sent" may be retried; anything else is unknown.
        await setDelivery(d.id, err?.notSubmitted
          ? { state: "failed", errorCode: String(err.code || "PUBLISH_REJECTED").slice(0, 60) }
          : { state: "outcome_unknown", errorCode: "PUBLISH_OUTCOME_UNKNOWN" });
      }
    }
  } catch (err) {
    if (isProcessDeath(err)) died = true;
    throw err;
  } finally {
    if (!died) await settleJob(prisma, job.id, { releaseLeaseOf: owner }).catch((e) => console.error("publish settle failed:", e?.message));
  }
  return prisma.publishJob.findUnique({ where: { id: job.id }, include: { deliveries: { include: { reconciliations: true } } } });
}

/** After a restart: a delivery left "submitting" may have been posted. */
export async function recoverPublishJobs(prisma, { now = new Date() } = {}) {
  const stale = await prisma.publishJob.findMany({ where: { state: "running", leaseExpiresAt: { lt: now } } });
  const out = [];
  for (const job of stale) {
    const recoverer = `recovery:${newOwner()}`;
    const { count } = await prisma.publishJob.updateMany({ where: { id: job.id, leaseOwner: job.leaseOwner, leaseExpiresAt: { lt: now } }, data: { leaseOwner: recoverer } });
    if (count !== 1) continue;
    const r = await prisma.publishDelivery.updateMany({ where: { jobId: job.id, state: "submitting" }, data: { state: "outcome_unknown", errorCode: "PROCESS_DIED_AFTER_SUBMIT", revision: { increment: 1 } } });
    const state = await settleJob(prisma, job.id, { releaseLeaseOf: recoverer });
    out.push({ jobId: job.id, unknown: r.count, state });
  }
  return out;
}

async function loadUncertain(prisma, deliveryId) {
  const d = await prisma.publishDelivery.findUnique({ where: { id: deliveryId }, include: { job: true } });
  if (!d) throw new ApiError("NOT_FOUND", 404, "Delivery not found");
  if (!UNCERTAIN.includes(d.state)) throw new ApiError("NOT_RESOLVABLE", 409, `Delivery is ${d.state}; nothing to reconcile`);
  if (d.job.leaseOwner && d.job.leaseExpiresAt > new Date()) throw new ApiError("PUBLISH_IN_PROGRESS", 409, "The publish job is still running");
  return d;
}

const conflict = (current, extra = {}) => new ApiError("RECONCILIATION_CONFLICT", 409,
  "This delivery changed while you were deciding; review its current state and history",
  { currentState: current?.state, currentRevision: current?.revision, ...extra });

/**
 * Asks the platform what happened (adapters with lookups only).
 *
 * WHY compare-and-swap after the lookup: the lookup is slow and someone may
 * decide meanwhile. A late answer never overwrites a decision:
 *  - the platform says "published" but the owner already recorded "not
 *    published": the delivery becomes conflicting_evidence (re-posting stays
 *    blocked; a post may exist) for the owner to review;
 *  - the platform says "failed" after a confirmed publication: nothing changes
 *    (confirmed evidence is not reopened for retry); the answer is recorded.
 */
export async function checkDelivery(prisma, gate, deliveryId, { by }) {
  const d = await loadUncertain(prisma, deliveryId);
  const { adapter, simulated } = gate.preflight(d.platform);
  if (!adapter.capabilities?.statusLookup || !adapter.lookup) throw new ApiError("LOOKUP_UNSUPPORTED", 409, "This publisher cannot look posts up; resolve it manually with evidence");
  const answer = await adapter.lookup({ clientRef: d.clientRef, remoteRequestId: d.remoteRequestId });
  const base = { deliveryId: d.id, method: "platform_check", resolvedBy: by };
  const observed = { id: d.id, state: d.state, revision: d.revision };

  const apply = async (data, rec) => prisma.$transaction(async (tx) => {
    const { count } = await tx.publishDelivery.updateMany({ where: observed, data: { ...data, revision: { increment: 1 } } });
    if (count !== 1) throw conflict(await tx.publishDelivery.findUnique({ where: { id: d.id } }));
    await tx.publishReconciliation.create({ data: { ...base, ...rec } });
  });
  try {
    if (answer?.status === "published" && answer.remotePostId) {
      const post = { remotePostId: String(answer.remotePostId), permalink: safePermalink(answer.permalink) };
      await apply({ state: simulated ? "simulated" : "published", ...post, confirmedAt: new Date() },
        { resolution: "published", evidence: `Platform reported post ${answer.remotePostId}`, ...post });
    } else if (answer?.status === "failed") {
      await apply({ state: "resolved_not_published" }, { resolution: "not_published", evidence: "Platform reported the request failed" });
    } else {
      // "not found" can be a delay; it does not prove the post never happened.
      await prisma.publishReconciliation.create({ data: { ...base, resolution: "still_pending", evidence: `Platform reported "${answer?.status || "no answer"}"` } });
    }
  } catch (err) {
    if (err?.code !== "RECONCILIATION_CONFLICT") throw err;
    const current = await prisma.publishDelivery.findUnique({ where: { id: d.id } });
    const said = answer?.status === "published" ? `published (post ${answer.remotePostId})` : answer?.status;
    if (answer?.status === "published" && current.state === "resolved_not_published") {
      // A post may exist although the owner recorded "not published": block re-posting.
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.publishDelivery.updateMany({ where: { id: d.id, state: "resolved_not_published", revision: current.revision }, data: { state: "conflicting_evidence", revision: { increment: 1 } } });
        if (count === 1) await tx.publishReconciliation.create({ data: { ...base, resolution: "conflicting_evidence", evidence: `Platform reported ${said} after the owner recorded not published`, remotePostId: String(answer.remotePostId), permalink: safePermalink(answer.permalink) } });
      });
    } else {
      await prisma.publishReconciliation.create({ data: { ...base, resolution: "conflicting_evidence", evidence: `Platform reported ${said} after the delivery was already ${current.state}; nothing changed` } });
    }
    await settleJob(prisma, d.jobId);
    throw conflict(await prisma.publishDelivery.findUnique({ where: { id: d.id } }), { platformSaid: answer?.status });
  }
  await settleJob(prisma, d.jobId);
  return prisma.publishDelivery.findUnique({ where: { id: d.id }, include: { reconciliations: true } });
}

/**
 * Owner resolution with evidence, e.g. after checking the account by hand.
 * WHY expectedRevision + one transaction: the decision applies only to the
 * delivery as the owner saw it; the state change and its audit record commit
 * together. Of two opposite decisions racing, exactly one commits.
 */
export async function resolveDelivery(prisma, deliveryId, { resolution, evidence, remotePostId, permalink, expectedRevision, by }) {
  const fields = {};
  if (!["published", "not_published"].includes(resolution)) fields.resolution = "must be published or not_published";
  if (typeof evidence !== "string" || evidence.trim().length < 10 || evidence.length > 2000) fields.evidence = "is required: what you checked (10-2000 characters)";
  if (!Number.isInteger(expectedRevision)) fields.expectedRevision = "is required: the delivery revision you reviewed";
  if (resolution === "published") {
    if (typeof remotePostId !== "string" || !remotePostId.trim() || remotePostId.length > 200) fields.remotePostId = "is required for a published post";
    const c = typeof permalink === "string" ? checkExternalUrl(permalink) : { ok: false, reason: "is required" };
    if (!c.ok) fields.permalink = c.reason;
  }
  if (Object.keys(fields).length) throw new ApiError("VALIDATION_FAILED", 400, "Resolution is incomplete", { fields });
  const d = await prisma.publishDelivery.findUnique({ where: { id: deliveryId }, include: { job: true } });
  if (!d) throw new ApiError("NOT_FOUND", 404, "Delivery not found");
  // One read, then compare-and-swap: whoever loses a race gets a conflict.
  if (d.revision !== expectedRevision || !UNCERTAIN.includes(d.state)) throw conflict(d);
  if (d.job.leaseOwner && d.job.leaseExpiresAt > new Date()) throw new ApiError("PUBLISH_IN_PROGRESS", 409, "The publish job is still running");
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.publishDelivery.updateMany({
      where: { id: d.id, revision: expectedRevision, state: { in: UNCERTAIN } },
      data: resolution === "published"
        ? { state: d.simulated ? "simulated" : "resolved_published", remotePostId: remotePostId.trim(), permalink, confirmedAt: new Date(), revision: { increment: 1 } }
        : { state: "resolved_not_published", remotePostId: null, permalink: null, revision: { increment: 1 } },
    });
    if (count !== 1) throw conflict(await tx.publishDelivery.findUnique({ where: { id: d.id } }));
    await tx.publishReconciliation.create({ data: {
      deliveryId: d.id, method: "operator", resolution, evidence: evidence.trim(),
      remotePostId: resolution === "published" ? remotePostId.trim() : null, permalink: resolution === "published" ? permalink : null, resolvedBy: by,
    } });
  });
  await settleJob(prisma, d.jobId);
  return prisma.publishDelivery.findUnique({ where: { id: d.id }, include: { reconciliations: true } });
}
