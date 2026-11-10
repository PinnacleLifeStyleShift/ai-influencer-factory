import { ApiError } from "../lib/errors.js";
import { snapshotHash } from "../lib/revision.js";

/**
 * The only gate any future delivery job (publisher, reminder, export push)
 * may use before acting on a calendar entry.
 *
 * WHY: a calendar row is a plan. Before anything leaves the system it must
 * still be scheduled, not cancelled, created from an approved snapshot, and
 * that snapshot must still be exactly the item's current approved content.
 * Cancellation flips the row and the item in one transaction, so a job that
 * read the row earlier fails here instead of delivering it.
 * Publishing itself is not enabled; this is the fence it will have to pass.
 */
export async function assertDeliverable(prisma, contentId) {
  const content = await prisma.content.findUnique({ where: { id: contentId }, include: { pipelineItems: true } });
  if (!content) throw new ApiError("NOT_FOUND", 404, "Calendar entry not found");
  if (content.cancelledAt || content.status === "cancelled") throw new ApiError("SCHEDULE_CANCELLED", 409, "This calendar entry was cancelled and can never be delivered");
  // partially_published: some destinations are out; the rest may still go.
  if (!["scheduled", "partially_published"].includes(content.status) || !content.scheduleKey) throw new ApiError("NOT_SCHEDULED", 409, "Only entries scheduled from an approved snapshot can be delivered");
  const item = content.pipelineItems.find((p) => p.contentId === content.id);
  if (!item || item.stage !== "scheduled" || item.approvedHash !== content.approvedHash || snapshotHash(item) !== content.approvedHash) {
    throw new ApiError("APPROVAL_STALE", 409, "The approved content behind this entry has changed");
  }
  return { content, item };
}
