import { Router } from "express";
import { ApiError, routeError } from "../lib/errors.js";
import { snapshotHash } from "../lib/revision.js";
import { isUniqueViolation } from "../lib/requests.js";
import { buildExport, approvalIsCurrent, readableManifest } from "../services/exportManifest.js";
import { inspectMedia } from "../services/mediaInspect.js";
import { claimIsLive } from "./pipeline.js";
import { invalidatingChange } from "../lib/revision.js";

/**
 * Export of approved content, and measuring stored media.
 * Export only packages files for download; it never posts or contacts anyone.
 */
const router = Router();
const handle = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { return routeError(res, err, `Failed: ${label}`, label); }
};
const notFound = () => new ApiError("NOT_FOUND", 404, "Pipeline item not found");

// POST /api/pipeline/:id/exports  -> { export, replayed }
router.post("/:id/exports", handle("POST /pipeline/:id/exports", async (req, res) => {
  const prisma = req.prisma;
  const item = await prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  // WHY on the server: a stale or missing approval must not export as current,
  // whatever the UI shows.
  if (!["approved", "scheduled"].includes(item.stage)) {
    throw new ApiError("EXPORT_NOT_APPROVED", 409, `Only approved content can be exported (current stage: ${item.stage})`);
  }
  if (!approvalIsCurrent(item)) throw new ApiError("APPROVAL_STALE", 409, "The approved snapshot no longer matches the item; review and approve the current version");
  if (claimIsLive(item)) throw new ApiError("GENERATION_IN_PROGRESS", 409, "A generation for this item is in progress; wait for it to finish");

  const built = await buildExport(prisma, req.mediaStore, item);

  // The item must still be exactly what was approved after the (slow) checks.
  const again = await prisma.pipelineItem.findUnique({ where: { id: item.id } });
  if (!again || again.revision !== item.revision || snapshotHash(again) !== item.approvedHash || !approvalIsCurrent(again)) {
    throw new ApiError("APPROVAL_STALE", 409, "The item changed during export; nothing was exported");
  }
  let record = await prisma.exportManifest.findUnique({ where: { pipelineItemId_manifestHash: { pipelineItemId: item.id, manifestHash: built.manifestHash } } });
  let replayed = Boolean(record);
  if (!record) {
    try {
      record = await prisma.exportManifest.create({
        data: { pipelineItemId: item.id, revision: item.revision, snapshotHash: item.approvedHash, manifestHash: built.manifestHash, manifest: built.manifest, createdBy: req.principal?.role || null },
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      record = await prisma.exportManifest.findUnique({ where: { pipelineItemId_manifestHash: { pipelineItemId: item.id, manifestHash: built.manifestHash } } });
      replayed = true;
    }
  }
  res.status(replayed ? 200 : 201).json({ success: true, replayed, export: { ...record, current: true } });
}));

async function currentHashOf(prisma, id) {
  const item = await prisma.pipelineItem.findUnique({ where: { id } });
  if (!item) throw notFound();
  return approvalIsCurrent(item) ? item.approvedHash : null;
}

// GET /api/pipeline/:id/exports -> newest first, each marked current or superseded
router.get("/:id/exports", handle("GET /pipeline/:id/exports", async (req, res) => {
  const current = await currentHashOf(req.prisma, req.params.id);
  const rows = await req.prisma.exportManifest.findMany({ where: { pipelineItemId: req.params.id }, orderBy: { createdAt: "desc" }, take: 50 });
  res.json(rows.map((r) => ({ ...r, current: r.snapshotHash === current })));
}));

// GET /api/pipeline/:id/exports/:exportId/download?format=json|text
router.get("/:id/exports/:exportId/download", handle("GET /pipeline/:id/exports/:exportId/download", async (req, res) => {
  const record = await req.prisma.exportManifest.findFirst({ where: { id: req.params.exportId, pipelineItemId: req.params.id } });
  if (!record) throw new ApiError("NOT_FOUND", 404, "Export not found");
  const current = record.snapshotHash === (await currentHashOf(req.prisma, req.params.id));
  const format = req.query.format === "text" ? "text" : "json";
  res.set("X-Export-Current", String(current));
  res.set("Cache-Control", "no-store");
  const base = `export-${record.pipelineItemId}-r${record.revision}-${record.manifestHash.slice(0, 12)}`;
  if (format === "text") {
    res.set("Content-Disposition", `attachment; filename="${base}.txt"`);
    return res.type("text/plain").send(readableManifest(record.manifest, { current }));
  }
  res.set("Content-Disposition", `attachment; filename="${base}.json"`);
  res.type("application/json").send(JSON.stringify(record.manifest, null, 2));
}));

// POST /api/pipeline/:id/measure-media
// Replaces each shot clip's recorded length with the length measured from the
// file itself (durationSource "measured"). This is a change to the package,
// so it clears approval like any other.
router.post("/:id/measure-media", handle("POST /pipeline/:id/measure-media", async (req, res) => {
  const prisma = req.prisma;
  const item = await prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (item.stage === "scheduled") throw new ApiError("ALREADY_SCHEDULED", 409, "Scheduled items cannot be changed; cancel the schedule first");
  if (claimIsLive(item)) throw new ApiError("GENERATION_IN_PROGRESS", 409, "A generation for this item is in progress; wait for it to finish");
  if (!req.mediaStore?.configured) throw new ApiError("MEDIA_STORE_NOT_CONFIGURED", 409, "Measuring needs media storage, which is not configured");
  const shots = Array.isArray(item.shotMedia) ? item.shotMedia : [];
  if (!shots.length) throw new ApiError("MEDIA_REQUIRED", 409, "There are no shot clips to measure");
  const results = [];
  const next = [];
  for (const m of shots) {
    const read = await req.mediaStore.read(m.url);
    const info = read.ok ? inspectMedia(read.bytes, { expectedKind: "video" }) : null;
    if (!info?.ok || !info.durationSec) {
      results.push({ shotIndex: m.shotIndex, ok: false, problems: info ? info.problems : [read.problem] });
      next.push(m);
      continue;
    }
    results.push({ shotIndex: m.shotIndex, ok: true, durationSec: info.durationSec, sha256: info.sha256 });
    next.push({ ...m, durationSec: info.durationSec, durationSource: "measured", sha256: info.sha256 });
  }
  const changed = JSON.stringify(next) !== JSON.stringify(shots);
  if (changed) {
    const { count } = await prisma.pipelineItem.updateMany({
      where: { id: item.id, revision: item.revision, stage: item.stage, generationClaim: null },
      data: invalidatingChange({ shotMedia: next }, item.stage === "approved" ? "review" : undefined),
    });
    if (count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "The item changed meanwhile; reload and retry");
  }
  res.json({ success: results.every((r) => r.ok), changed, results });
}));

export default router;
