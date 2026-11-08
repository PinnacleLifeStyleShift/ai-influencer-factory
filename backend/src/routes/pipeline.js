import { Router } from "express";
import { ApiError, sendError } from "../lib/errors.js";
import {
  DESTINATIONS, serializeItem, snapshotHash, mediaTypeOf, invalidatingChange,
} from "../lib/revision.js";
import { readIdempotencyKey, isUniqueViolation } from "../lib/requests.js";
import {
  discoverTrends, analyzeTrendRelevance, SUPPORTED_PLATFORMS, SUPPORTED_NICHES, MAX_TREND_COUNT,
} from "../services/trendDiscovery.js";
import { generateScript } from "../services/scriptGeneration.js";
import { generateCaption } from "../services/captionGeneration.js";
import { buildPromptFromCharacter } from "../services/imageGeneration.js";
import { requestHash } from "../services/spendLedger.js";

const router = Router();

/** Wraps a handler so ApiErrors become typed responses and others a generic 500. */
const handle = (label, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof ApiError) return sendError(res, err);
    console.error(`${label} error:`, err?.message || err);
    return res.status(500).json({ error: `Failed: ${label}`, code: "INTERNAL_ERROR" });
  }
};

const notFound = () => new ApiError("NOT_FOUND", 404, "Pipeline item not found");
const invalid = (msg) => new ApiError("VALIDATION_FAILED", 400, msg);

function optionalString(body, key, max = 5000) {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v !== null && (typeof v !== "string" || v.length > max)) throw invalid(`${key} must be a string of at most ${max} characters`);
  return v;
}

function assertNotScheduled(item) {
  if (item.stage === "scheduled") {
    throw new ApiError("ALREADY_SCHEDULED", 409, "Scheduled items cannot be changed; their approved revision is locked");
  }
}

/** Applies a publish-relevant change only if nobody changed the item meanwhile. */
async function applyChange(prisma, item, data) {
  const { count } = await prisma.pipelineItem.updateMany({
    where: { id: item.id, revision: item.revision, stage: item.stage },
    data,
  });
  if (count !== 1) throw new ApiError("REVISION_CONFLICT", 409, "The item changed while this request was processed; reload and retry");
}

const ITEM_INCLUDE = {
  script: { include: { trend: true } },
  character: { select: { id: true, name: true, characterId: true, niche: true } },
  content: { select: { id: true, title: true, status: true, scheduleKey: true } },
};

// ─── PIPELINE ITEMS ──────────────────────────────────────────

router.get("/", handle("GET /pipeline", async (req, res) => {
  const where = {};
  if (typeof req.query.stage === "string") where.stage = req.query.stage;
  if (typeof req.query.character_id === "string") where.characterId = req.query.character_id;
  const items = await req.prisma.pipelineItem.findMany({ where, orderBy: { createdAt: "desc" }, include: ITEM_INCLUDE });
  res.json(items.map(serializeItem));
}));

// ─── TRENDS (before /:id) ────────────────────────────────────

router.get("/trends", handle("GET /pipeline/trends", async (req, res) => {
  const where = {};
  if (typeof req.query.platform === "string") where.platform = req.query.platform;
  if (typeof req.query.status === "string") where.status = req.query.status;
  const trends = await req.prisma.trend.findMany({
    where,
    orderBy: { trendScore: "desc" },
    include: { scripts: { select: { id: true, title: true, status: true } } },
  });
  res.json(trends);
}));

router.get("/scripts", handle("GET /pipeline/scripts", async (req, res) => {
  const where = {};
  if (typeof req.query.status === "string") where.status = req.query.status;
  if (typeof req.query.character_id === "string") where.characterId = req.query.character_id;
  const scripts = await req.prisma.script.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      trend: { select: { id: true, topic: true, trendScore: true, provenance: true } },
      character: { select: { id: true, name: true, niche: true } },
      pipelineItems: { select: { id: true, stage: true } },
    },
  });
  res.json(scripts);
}));

// POST /api/pipeline/discover-trends — SIMULATED fixture ideas (see trendDiscovery.js)
router.post("/discover-trends", handle("POST /pipeline/discover-trends", async (req, res) => {
  const body = req.body || {};
  const platform = body.platform ?? "TikTok";
  const niche = body.niche ?? "Lifestyle";
  const count = body.count ?? 5;
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw invalid(`platform must be one of ${SUPPORTED_PLATFORMS.join(", ")}`);
  if (!SUPPORTED_NICHES.includes(niche)) throw invalid(`niche must be one of ${SUPPORTED_NICHES.join(", ")}`);
  if (!Number.isInteger(count) || count < 1 || count > MAX_TREND_COUNT) {
    throw invalid(`count must be an integer from 1 to ${MAX_TREND_COUNT}`);
  }
  if (body.characterId !== undefined && typeof body.characterId !== "string") throw invalid("characterId must be a string");

  const trends = discoverTrends(platform, niche, count);
  const character = body.characterId
    ? await req.prisma.character.findUnique({ where: { id: body.characterId } })
    : null;

  const savedTrends = [];
  for (const trend of trends) {
    const saved = await req.prisma.trend.create({
      data: {
        platform: trend.platform,
        topic: trend.topic,
        description: trend.description,
        hashtags: trend.hashtags,
        trendScore: trend.trendScore,
        source: trend.source,
        provenance: trend.provenance,
        status: "new",
      },
    });
    savedTrends.push({ ...saved, relevance: character ? analyzeTrendRelevance(trend, character) : null });
  }

  res.status(201).json({
    count: savedTrends.length,
    platform,
    niche,
    dataSource: "simulated_fixture",
    notice: "Simulated ideas from a curated fixture list with random scores. Not observed platform trends.",
    trends: savedTrends,
  });
}));

// ─── SCRIPTS ─────────────────────────────────────────────────

router.post("/generate-script", handle("POST /pipeline/generate-script", async (req, res) => {
  const { trendId, characterId, platform, duration, tone, contentType } = req.body || {};
  if (!characterId || typeof characterId !== "string") throw invalid("characterId is required");

  const trend = trendId ? await req.prisma.trend.findUnique({ where: { id: trendId } }) : null;
  const character = await req.prisma.character.findUnique({ where: { id: characterId } });
  if (!character) throw new ApiError("NOT_FOUND", 404, "Character not found");

  const scriptData = generateScript(
    trend || { topic: "Trending content", platform: platform || "TikTok" },
    character,
    { platform, duration, tone, contentType }
  );

  const script = await req.prisma.script.create({
    data: {
      title: scriptData.title,
      hook: scriptData.hook,
      body: scriptData.body,
      callToAction: scriptData.callToAction,
      platform: scriptData.platform,
      duration: scriptData.duration,
      tone: scriptData.tone,
      status: "draft",
      trendId: trendId || null,
      characterId,
    },
    include: { trend: true, character: { select: { name: true, niche: true } } },
  });

  // The script's format platform is NOT the posting destination. The
  // destination stays unset until the operator chooses it explicitly.
  const pipelineItem = await req.prisma.pipelineItem.create({
    data: { stage: "draft", scriptId: script.id, characterId, platform: null },
  });

  if (trendId) await req.prisma.trend.update({ where: { id: trendId }, data: { status: "scripted" } });

  res.status(201).json({
    script,
    pipelineItem: serializeItem(pipelineItem),
    durationGuidance: scriptData.durationGuidance,
    characterNotes: scriptData.characterNotes,
  });
}));

// ─── CONTENT GENERATION ──────────────────────────────────────

/**
 * POST /api/pipeline/generate-content { pipelineItemId, type: "image"|"video" }
 * Optional header Idempotency-Key. Without it, a server stage key is derived
 * from the item and its revision, and an unfinished workflow is resumed.
 *
 * The whole workflow (image + video when no image exists) is preflighted and
 * its total cost reserved before the first provider call. Each successful
 * stage is persisted immediately, so a retry never re-buys finished stages.
 */
router.post("/generate-content", handle("POST /pipeline/generate-content", async (req, res) => {
  const { pipelineItemId, type = "image" } = req.body || {};
  if (!pipelineItemId || typeof pipelineItemId !== "string") throw invalid("pipelineItemId is required");
  if (!["image", "video"].includes(type)) throw invalid(`Unsupported content type: ${String(type).slice(0, 20)}`);
  const clientKey = readIdempotencyKey(req);
  const gate = req.generationGate;
  const prisma = req.prisma;

  const item = await prisma.pipelineItem.findUnique({
    where: { id: pipelineItemId },
    include: { character: true, script: true },
  });
  if (!item) throw notFound();
  assertNotScheduled(item);

  const needsImage = type === "image" || !item.imageUrl;
  const kinds = type === "image" ? ["image"] : needsImage ? ["image", "video"] : ["video"];
  // Blocks before ANY write, reservation or provider call if any stage is not permitted.
  gate.preflightAll(kinds);

  const hash = requestHash({ op: "pipeline.generate-content", pipelineItemId, type });
  const resumable = item.activeWorkflowKey?.startsWith(`${type}|`) ? item.activeWorkflowKey : null;
  const workflowKey = clientKey
    ? `${type}|client:${clientKey}`
    : resumable || `${type}|pipe:${item.id}:r${item.revision}`;
  if (item.activeWorkflowKey !== workflowKey) {
    await prisma.pipelineItem.update({ where: { id: item.id }, data: { activeWorkflowKey: workflowKey } });
  }

  const prompt = buildPromptFromCharacter(item.character);
  const motionPrompt = item.script
    ? `${item.script.hook || ""} ${item.script.body || ""}`.trim().slice(0, 500)
    : "Subtle natural movement, gentle head turn, cinematic lighting";

  const steps = [];
  if (needsImage) {
    steps.push({
      kind: "image",
      idempotencyKey: `${workflowKey}:image`,
      requestHash: hash,
      input: { prompt, options: { aspectRatio: item.character.aspectRatio || "9:16" } },
      // A new still invalidates any video made from the old one, and any approval.
      onResult: (r) => prisma.pipelineItem.update({
        where: { id: item.id },
        data: invalidatingChange({ imageUrl: r.imageUrl, videoUrl: null }, "content_generated"),
      }),
    });
  }
  if (type === "video") {
    steps.push({
      kind: "video",
      idempotencyKey: `${workflowKey}:video`,
      requestHash: hash,
      input: (prev) => ({
        imageUrl: prev.find((p) => p.imageUrl)?.imageUrl || item.imageUrl,
        prompt: motionPrompt,
        options: { duration: "5", mode: "std" },
      }),
      onResult: (r) => prisma.pipelineItem.update({
        where: { id: item.id },
        data: invalidatingChange({ videoUrl: r.videoUrl }, "content_generated"),
      }),
    });
  }

  const results = await gate.runWorkflow(steps);
  await prisma.pipelineItem.update({ where: { id: item.id }, data: { activeWorkflowKey: null } });

  const updated = await prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  res.json({
    success: true,
    type,
    pipelineItem: serializeItem(updated),
    imageUrl: updated.imageUrl,
    videoUrl: updated.videoUrl,
    replayed: results.every((r) => r.replayed === true),
  });
}));

// ─── CAPTION / MANUAL EDITS ──────────────────────────────────

router.post("/generate-caption", handle("POST /pipeline/generate-caption", async (req, res) => {
  const { pipelineItemId, platform } = req.body || {};
  if (!pipelineItemId || typeof pipelineItemId !== "string") throw invalid("pipelineItemId is required");
  if (platform !== undefined && !DESTINATIONS.includes(platform)) throw invalid(`platform must be one of ${DESTINATIONS.join(", ")}`);

  const item = await req.prisma.pipelineItem.findUnique({
    where: { id: pipelineItemId },
    include: { character: true, script: true },
  });
  if (!item) throw notFound();
  assertNotScheduled(item);

  // `platform` only styles the caption; it never sets the posting destination.
  const captionResult = generateCaption(item.script, item.character, platform || item.platform || "TikTok");
  const nextStage = ["content_generated", "approved"].includes(item.stage) ? "review" : undefined;
  await applyChange(req.prisma, item,
    invalidatingChange({ caption: captionResult.caption, hashtags: captionResult.hashtagString }, nextStage));

  const updated = await req.prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  res.json({ success: true, pipelineItem: serializeItem(updated), captionDetails: captionResult });
}));

// PATCH /api/pipeline/:id { caption?, hashtags?, platform?, revision? }
// Any change bumps the revision and invalidates an existing approval.
router.patch("/:id", handle("PATCH /pipeline/:id", async (req, res) => {
  const body = req.body || {};
  const changes = {};
  const caption = optionalString(body, "caption");
  const hashtags = optionalString(body, "hashtags", 2000);
  if (caption !== undefined) changes.caption = caption;
  if (hashtags !== undefined) changes.hashtags = hashtags;
  if (body.platform !== undefined) {
    if (body.platform !== null && !DESTINATIONS.includes(body.platform)) {
      throw invalid(`platform must be one of ${DESTINATIONS.join(", ")} or null`);
    }
    changes.platform = body.platform;
  }
  if (body.revision !== undefined && !Number.isInteger(body.revision)) throw invalid("revision must be an integer");

  const item = await req.prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (body.revision !== undefined && body.revision !== item.revision) {
    throw new ApiError("REVISION_CONFLICT", 409, `Item is at revision ${item.revision}, not ${body.revision}`);
  }
  assertNotScheduled(item);

  const changed = Object.fromEntries(Object.entries(changes).filter(([k, v]) => (item[k] ?? null) !== v));
  if (Object.keys(changed).length > 0) {
    await applyChange(req.prisma, item, invalidatingChange(changed, item.stage === "approved" ? "review" : undefined));
  }
  const updated = await req.prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  res.json({ success: true, changed: Object.keys(changed), pipelineItem: serializeItem(updated) });
}));

// ─── WILDCARD READ / DELETE ──────────────────────────────────

router.get("/:id", handle("GET /pipeline/:id", async (req, res) => {
  const item = await req.prisma.pipelineItem.findUnique({
    where: { id: req.params.id },
    include: { script: { include: { trend: true } }, character: true, content: true },
  });
  if (!item) throw notFound();
  res.json(serializeItem(item));
}));

router.delete("/:id", handle("DELETE /pipeline/:id", async (req, res) => {
  await req.prisma.pipelineItem.delete({ where: { id: req.params.id } });
  res.json({ success: true });
}));

// ─── APPROVAL WORKFLOW ───────────────────────────────────────

// POST /api/pipeline/:id/approve { revision, snapshotHash, notes? }
// Approves exactly the snapshot the reviewer saw.
router.post("/:id/approve", handle("POST /pipeline/:id/approve", async (req, res) => {
  const { revision, snapshotHash: clientHash, notes } = req.body || {};
  if (!Number.isInteger(revision) || typeof clientHash !== "string") {
    throw invalid("revision (integer) and snapshotHash (string) of the reviewed version are required");
  }
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) throw invalid("notes must be a string");

  const item = await req.prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (item.stage !== "review") {
    throw new ApiError("INVALID_TRANSITION", 409, `Only items in review can be approved (current stage: ${item.stage})`);
  }
  const currentHash = snapshotHash(item);
  if (revision !== item.revision || clientHash !== currentHash) {
    throw new ApiError("APPROVAL_STALE", 409, "The item changed since it was reviewed; review the current version",
      { currentRevision: item.revision, currentSnapshotHash: currentHash });
  }
  if (!item.platform) throw new ApiError("DESTINATION_REQUIRED", 409, "Choose the destination platform before approval");
  if (!mediaTypeOf(item)) throw new ApiError("MEDIA_REQUIRED", 409, "Generate media before approval");

  const { count } = await req.prisma.pipelineItem.updateMany({
    where: { id: item.id, revision: item.revision, stage: "review" },
    data: {
      stage: "approved",
      approvedRevision: item.revision,
      approvedHash: currentHash,
      approvedBy: req.principal?.role || "unknown",
      approvedAt: new Date(),
      reviewNotes: notes || null,
    },
  });
  if (count !== 1) throw new ApiError("APPROVAL_STALE", 409, "The item changed during approval; review it again");

  const updated = await req.prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  res.json({ success: true, pipelineItem: serializeItem(updated) });
}));

router.post("/:id/reject", handle("POST /pipeline/:id/reject", async (req, res) => {
  const notes = req.body?.notes;
  if (notes !== undefined && (typeof notes !== "string" || notes.length > 2000)) throw invalid("notes must be a string");
  const item = await req.prisma.pipelineItem.findUnique({ where: { id: req.params.id } });
  if (!item) throw notFound();
  if (!["content_generated", "review", "approved"].includes(item.stage)) {
    throw new ApiError("INVALID_TRANSITION", 409, `Items in stage ${item.stage} cannot be rejected`);
  }
  await applyChange(req.prisma, item, {
    stage: "draft",
    approvedRevision: null,
    approvedHash: null,
    approvedBy: null,
    approvedAt: null,
    rejectedAt: new Date(),
    reviewNotes: notes || "Rejected — needs revision",
  });
  const updated = await req.prisma.pipelineItem.findUnique({ where: { id: item.id }, include: ITEM_INCLUDE });
  res.json({ success: true, pipelineItem: serializeItem(updated) });
}));

// POST /api/pipeline/:id/schedule { scheduledDate?: "YYYY-MM-DD", platform? }
// Calendar planning only (nothing is published). Atomic and idempotent per
// approved snapshot: the content row carries a unique scheduleKey.
router.post("/:id/schedule", handle("POST /pipeline/:id/schedule", async (req, res) => {
  const { scheduledDate, platform } = req.body || {};
  if (scheduledDate !== undefined && (typeof scheduledDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(scheduledDate))) {
    throw invalid("scheduledDate must be YYYY-MM-DD");
  }
  const date = scheduledDate || new Date().toISOString().slice(0, 10);
  const prisma = req.prisma;

  const replayExisting = async () => {
    const item = await prisma.pipelineItem.findUnique({ where: { id: req.params.id }, include: ITEM_INCLUDE });
    if (!item) throw notFound();
    const key = item.approvedHash ? `${item.id}:${item.approvedHash}` : null;
    const content = key ? await prisma.content.findUnique({ where: { scheduleKey: key } }) : null;
    if (item.stage === "scheduled" && content) {
      return res.json({ success: true, replayed: true, pipelineItem: serializeItem(item), content });
    }
    return null;
  };

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      const item = await tx.pipelineItem.findUnique({ where: { id: req.params.id }, include: { script: true } });
      if (!item) throw notFound();
      if (item.stage === "scheduled") return { replay: true };
      if (item.stage !== "approved") {
        throw new ApiError("INVALID_TRANSITION", 409, "Item must be approved before scheduling");
      }
      const hash = snapshotHash(item);
      if (item.approvedRevision !== item.revision || item.approvedHash !== hash) {
        throw new ApiError("APPROVAL_STALE", 409, "Approved snapshot no longer matches the item; re-approval required");
      }
      if (platform !== undefined && platform !== item.platform) {
        throw new ApiError("DESTINATION_MISMATCH", 409,
          `Approved destination is ${item.platform}; scheduling elsewhere requires a new approval`);
      }

      // Claim: only one concurrent request can move approved -> scheduled.
      const claim = await tx.pipelineItem.updateMany({
        where: { id: item.id, stage: "approved", revision: item.revision, approvedHash: hash },
        data: { stage: "scheduled", scheduledDate: date },
      });
      if (claim.count !== 1) return { replay: true };

      const mediaType = mediaTypeOf(item);
      const content = await tx.content.create({
        data: {
          title: item.script?.title || "Pipeline Content",
          contentType: mediaType === "video" ? "Video" : "Static Image",
          mediaType,
          imageUrl: item.imageUrl,
          videoUrl: item.videoUrl,
          platform: item.platform,
          scheduledDate: date,
          status: "scheduled",
          caption: item.caption,
          hashtags: item.hashtags,
          characterId: item.characterId,
          scheduleKey: `${item.id}:${hash}`,
          approvedHash: hash,
        },
      });
      await tx.pipelineItem.update({ where: { id: item.id }, data: { contentId: content.id } });
      return { content };
    });
  } catch (err) {
    if (isUniqueViolation(err)) outcome = { replay: true };
    else throw err;
  }

  if (outcome.replay) {
    if (await replayExisting()) return;
    throw new ApiError("SCHEDULE_CONFLICT", 409, "The item changed while scheduling; reload and retry");
  }
  const updated = await prisma.pipelineItem.findUnique({ where: { id: req.params.id }, include: ITEM_INCLUDE });
  res.json({ success: true, replayed: false, pipelineItem: serializeItem(updated), content: outcome.content });
}));

export default router;
