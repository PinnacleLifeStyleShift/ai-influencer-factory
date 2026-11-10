import crypto from "crypto";
import { stableStringify } from "../services/spendLedger.js";

/**
 * Exact-version approval helpers (spec F4 / WP7).
 *
 * The snapshot is every field that decides what would be posted and where.
 * Approval is bound to (revision, snapshotHash). Any change to these fields
 * bumps the revision and clears approval, so a changed asset, caption,
 * hashtags or destination can never inherit an earlier approval.
 */
export const DESTINATIONS = Object.freeze(["TikTok", "Instagram", "YouTube"]);

// characterVersionId: approval is for content made from a specific version.
export const PUBLISH_FIELDS = Object.freeze([
  "imageUrl", "videoUrl", "caption", "hashtags", "platform", "scriptId", "characterVersionId",
  // Content package: script version, per-shot media, disclosure, export settings.
  "scriptVersionId", "shotMedia", "disclosure", "exportSettings",
]);

// The destination schedule is publish-relevant too (Package E): approval is
// for "this content, there, at this instant in this zone". WHY version-bound:
// changing the time is a change to what was approved, so it needs a new
// approval; there is no separate, weaker "reschedule" permission.
// Added only when set, so items without a schedule keep their earlier hash.
export const SCHEDULE_FIELDS = Object.freeze(["scheduledAt", "scheduleTimezone"]);

export function snapshotOf(item) {
  const snap = { pipelineItemId: item.id, revision: item.revision };
  for (const f of PUBLISH_FIELDS) snap[f] = item[f] ?? null;
  for (const f of SCHEDULE_FIELDS) {
    const v = item[f];
    if (v !== null && v !== undefined) snap[f] = v instanceof Date ? v.toISOString() : v;
  }
  // Cross-post destinations (publishing): approval names every place the
  // original may go. Added only when non-empty, like the schedule.
  if (Array.isArray(item.crossPostDestinations) && item.crossPostDestinations.length) {
    snap.crossPostDestinations = [...item.crossPostDestinations].sort();
  }
  return snap;
}

export function snapshotHash(item) {
  return crypto.createHash("sha256").update(stableStringify(snapshotOf(item))).digest("hex");
}

/** Media type is decided by what will actually be posted: video wins over its source still. */
/** Every destination this approved item may be delivered to, primary first. */
export function destinationsOf(item) {
  return [item.platform, ...(item.crossPostDestinations || [])].filter((d, i, a) => d && a.indexOf(d) === i);
}

export function mediaTypeOf(item) {
  if (item.videoUrl) return "video";
  if (item.imageUrl) return "image";
  return null;
}

/** Adds derived approval fields to an API response for a pipeline item. */
export function serializeItem(item) {
  if (!item) return item;
  const hash = snapshotHash(item);
  const approvalCurrent =
    item.stage === "approved" || item.stage === "scheduled"
      ? item.approvedRevision === item.revision && item.approvedHash === hash
      : false;
  // The claim token is a fencing secret for the server; clients only need to
  // know whether a generation is running.
  const { generationClaim, ...rest } = item;
  return {
    ...rest,
    snapshotHash: hash,
    mediaType: mediaTypeOf(item),
    approvalCurrent,
    generationInProgress: Boolean(generationClaim),
  };
}

/** Prisma update payload that records a publish-relevant change. */
export function invalidatingChange(data, nextStage) {
  return {
    ...data,
    revision: { increment: 1 },
    approvedRevision: null,
    approvedHash: null,
    approvedBy: null,
    approvedAt: null,
    ...(nextStage ? { stage: nextStage } : {}),
  };
}
