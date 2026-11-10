import { secureRouter } from "../lib/secureRouter.js";
import { ApiError, routeError } from "../lib/errors.js";
import { snapshotHash } from "../lib/revision.js";
import { isUniqueViolation } from "../lib/requests.js";
import { buildExport, approvalIsCurrent, readableManifest } from "../services/exportManifest.js";
import { inspectMedia } from "../services/mediaInspect.js";
import { claimIsLive } from "./pipeline.js";
import { invalidatingChange } from "../lib/revision.js";
import { rightsHoldError } from "../services/rights.js";
import { measurePackage } from "../services/shotPlan.js";

/**
 * Export of approved content, and measuring stored media.
 * Export only packages files for download; it never posts or contacts anyone.
 */
const router = secureRouter();
const handle = (label, fn) => async (req, res) => {
  try { await fn(req, res); } catch (err) { return routeError(res, err, `Failed: ${label}`, label); }
};
const notFound = () => new ApiError("NOT_FOUND", 404, "Pipeline item not found");

// POST /api/pipeline/:id/exports  -> { export, replayed }
router.post("/:id/exports", ["export"], handle("POST /pipeline/:id/exports", async (req, res) => {
  const prisma = req.prisma;
  const item = await prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  // WHY on the server: a stale or missing approval must not export as current,
  // whatever the UI shows.
  if (!["approved", "scheduled"].includes(item.stage)) {
    throw new ApiError("EXPORT_NOT_APPROVED", 409, `Only approved content can be exported (current stage: ${item.stage})`);
  }
  if (item.rightsHoldAt) throw rightsHoldError(item);
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
router.post("/:id/measure-media", ["edit"], handle("POST /pipeline/:id/measure-media", async (req, res) => {
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

// POST /api/pipeline/:id/assemble -> { asset, pipelineItem, replayed }
// Renders the measured shot clips into one video (deterministic), stores it as
// an AssetVersion and points the item's videoUrl at it. That is a change to
// the package, so approval is cleared and must be given for the rendered file.
router.post("/:id/assemble", ["edit"], handle("POST /pipeline/:id/assemble", async (req, res) => {
  const prisma = req.prisma;
  const item = await prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (["scheduled", "published"].includes(item.stage)) throw new ApiError("ALREADY_SCHEDULED", 409, "Scheduled or published items cannot be changed");
  if (claimIsLive(item)) throw new ApiError("GENERATION_IN_PROGRESS", 409, "A generation for this item is in progress; wait for it to finish");
  const sv = item.scriptVersionId ? await prisma.scriptVersion.findUnique({ where: { id: item.scriptVersionId } }) : null;
  const plan = sv?.shotPlan || [];
  if (!plan.length) throw new ApiError("PACKAGE_INCOMPLETE", 409, "There is no shot plan to assemble");
  const m = measurePackage(plan, item.shotMedia, sv.targetDurationSec);
  if (!m.complete || !m.verified || !m.check.withinTolerance) {
    throw new ApiError("PACKAGE_INCOMPLETE", 409, "Every shot needs a clip with a measured length, within tolerance, before assembly",
      { complete: m.complete, verified: m.verified, check: m.check });
  }
  const cap = req.assembly.capability();
  if (!cap.available) throw new ApiError("ASSEMBLY_UNAVAILABLE", 503, `Assembly is not available: ${cap.reason}`);
  if (!req.mediaStore?.configured || !req.mediaStore.writable) throw new ApiError("MEDIA_STORE_NOT_CONFIGURED", 409, "Assembly needs writable media storage, which is not configured");

  const clips = [];
  const failures = [];
  for (const shot of [...plan].sort((a, b) => a.index - b.index)) {
    const media = (item.shotMedia || []).find((x) => x.shotIndex === shot.index && x.shotKey === shot.shotKey);
    const read = await req.mediaStore.read(media.url);
    const info = read.ok ? inspectMedia(read.bytes, { expectedKind: "video" }) : null;
    if (!info?.ok) { failures.push({ shotIndex: shot.index, problems: info ? info.problems : [read.problem] }); continue; }
    clips.push({ bytes: read.bytes, trimSec: Math.min(shot.durationSec, info.durationSec), shotIndex: shot.index, shotKey: shot.shotKey, sha256: info.sha256 });
  }
  if (failures.length) throw new ApiError("ASSEMBLY_INPUT_INVALID", 422, "Some clips failed verification; nothing was assembled", { failures });

  let out;
  try {
    out = await req.assembly.assemble(clips.map((c) => ({ bytes: c.bytes, trimSec: c.trimSec })), { aspectRatio: item.exportSettings?.aspectRatio || "9:16", tool: cap.tool });
  } catch (err) {
    throw new ApiError(err.code || "ASSEMBLY_FAILED", err.code === "ASSEMBLY_TIMEOUT" ? 504 : 422, err.message);
  }
  const info = inspectMedia(out.bytes, { expectedKind: "video" });
  const plannedSec = Math.round(clips.reduce((t, c) => t + c.trimSec, 0) * 1000) / 1000;
  if (!info.ok || Math.abs(info.durationSec - plannedSec) > 0.5) {
    throw new ApiError("ASSEMBLY_FAILED", 422, "The assembled file does not match the plan", { problems: info.problems, measuredSec: info.durationSec, plannedSec });
  }
  const name = `rendered-${info.sha256.slice(0, 24)}.mp4`;
  const stored = await req.mediaStore.write(name, out.bytes);
  if (!stored.ok) throw new ApiError("MEDIA_STORE_NOT_CONFIGURED", 409, `Could not store the rendered file: ${stored.problem}`);
  const provenance = {
    shots: clips.map((c) => ({ shotIndex: c.shotIndex, shotKey: c.shotKey, clipSha256: c.sha256, trimSec: c.trimSec })),
    tool: out.tool, settings: { aspectRatio: item.exportSettings?.aspectRatio || "9:16", fps: 30, codec: "h264", audio: "none", captions: "not burned in" },
    decodeCheck: "full decode passed", plannedSec,
  };
  let asset = await prisma.assetVersion.findUnique({ where: { pipelineItemId_contentHash: { pipelineItemId: item.id, contentHash: info.sha256 } } });
  if (!asset) {
    asset = await prisma.assetVersion.create({ data: {
      pipelineItemId: item.id, kind: "rendered", contentHash: info.sha256, mime: info.mime, bytes: info.bytes, width: info.width, height: info.height,
      codec: "h264", durationSec: info.durationSec, storageRef: stored.url, provenance, createdBy: req.principal?.role || null,
    } });
  }
  const replayed = item.videoUrl === stored.url && item.renderedAssetId === asset.id;
  if (!replayed) {
    const { count } = await prisma.pipelineItem.updateMany({
      where: { id: item.id, revision: item.revision, stage: item.stage, generationClaim: null },
      data: invalidatingChange({ videoUrl: stored.url, renderedAssetId: asset.id }, item.stage === "approved" ? "review" : undefined),
    });
    if (count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "The item changed meanwhile; reload and retry");
  }
  res.status(replayed ? 200 : 201).json({ success: true, replayed, asset, pipelineItem: await prisma.pipelineItem.findUnique({ where: { id: item.id } }) });
}));

export default router;
